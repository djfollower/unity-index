import {
  diffSnapshots,
  isEmptyDelta,
  WARNING_DELTA_RESET,
  type GraphSnapshot,
  type SnapshotDelta,
  type SnapshotDeltaRequest,
  type SnapshotDeltaResponse,
  type SnapshotRequest,
  type SnapshotResponse,
  type Warning,
} from "@unity-index/graph-core";
import { ProjectContext } from "../server/projectResolver";
import { AssetIndexLike, buildAssetGraph } from "./unityAssetGraphBuilder";

interface CachedRevision {
  /** Monotonic counter — see snapshot-delta-wire.ts. */
  revision: number;
  /** Unfiltered snapshot at this revision. */
  snapshot: GraphSnapshot;
}

interface Entry {
  /** Always non-null after the first successful build. */
  current?: CachedRevision;
  /** The immediately-prior snapshot. Allows serving a delta when the client
   *  is exactly one revision behind. We deliberately don't keep more than
   *  one step until perf evidence motivates the cost. */
  previous?: CachedRevision;
  /** Tracks an in-flight unfiltered rebuild so concurrent callers share. */
  inFlight?: Promise<GraphSnapshot>;
  /** Affected paths accumulated since the last successful rebuild. The watcher
   *  pushes here; `notifyChanged()` drains. */
  pendingPaths: Set<string>;
}

/**
 * Day 7 — workspace-scoped snapshot cache. One entry per project root.
 *
 * Holds the most recent unfiltered asset graph plus one step of history so
 * `unity_graph_snapshot_delta` can return a real diff when the client is
 * exactly one revision behind. Anything older forces a reset.
 *
 * ## Threading & re-entrancy
 *
 * The cache is single-threaded (Node event loop). Concurrent `getSnapshot`
 * calls during cold start share a single `buildAssetGraph` promise via
 * `inFlight`. Concurrent `notifyChanged` events coalesce by accumulating
 * affected paths into `pendingPaths` and serialising rebuilds.
 *
 * ## Filter semantics (Phase 1)
 *
 * The cache stores unfiltered snapshots only. Filtered `getSnapshot` requests
 * go through `buildAssetGraph` directly — same code path as before, no
 * caching. Filtered `getDelta` requests return `reset: true` because we
 * don't yet project deltas through filters. The webview uses no host-side
 * filter (filters are client-side), so it benefits from real deltas; other
 * MCP clients that rely on filters fall back gracefully to full snapshots.
 */
export class GraphSnapshotCache {
  private readonly entries = new Map<string, Entry>();
  private readonly log: (msg: string) => void;

  constructor(log: (msg: string) => void) {
    this.log = log;
  }

  /**
   * Build (or reuse) the unfiltered snapshot, then echo it through the
   * builder's filter pipeline if the request carries filters. Filtered
   * requests do NOT update the cache state — only the cold-start path does.
   */
  async getSnapshot(
    project: ProjectContext,
    index: AssetIndexLike,
    request: SnapshotRequest,
    signal?: AbortSignal,
  ): Promise<SnapshotResponse> {
    const entry = this.ensureEntry(project);
    const unfiltered = await this.ensureBase(entry, project, index, signal);

    const isUnfiltered =
      !request.include_kinds?.length &&
      !request.exclude_kinds?.length &&
      !request.path_globs?.length &&
      request.include_orphans !== false &&
      !request.pagination;

    if (isUnfiltered) {
      return {
        request_id: request.request_id,
        generated_at: unfiltered.generated_at,
        snapshot: unfiltered,
        revision: entry.current!.revision,
      };
    }

    // Filtered / paginated path — delegate to the builder for now.
    // (Filter projection through the cache is future work.)
    const response = await buildAssetGraph(
      project.rootPath,
      index,
      request,
      signal,
    );
    return { ...response, revision: entry.current!.revision };
  }

  /**
   * Serve a delta (one-step) or a reset. See class-level docstring for the
   * filter rules.
   */
  async getDelta(
    project: ProjectContext,
    index: AssetIndexLike,
    request: SnapshotDeltaRequest,
    signal?: AbortSignal,
  ): Promise<SnapshotDeltaResponse> {
    const entry = this.ensureEntry(project);
    const filtered =
      !!request.include_kinds?.length ||
      !!request.exclude_kinds?.length ||
      !!request.path_globs?.length ||
      request.include_orphans === false;

    const unfiltered = await this.ensureBase(entry, project, index, signal);
    const currentRevision = entry.current!.revision;

    if (filtered) {
      return this.resetResponse(
        request,
        unfiltered,
        currentRevision,
        "filter_mismatch",
        "Filtered delta requests are not yet supported by the cache; returning full snapshot.",
      );
    }

    if (request.since_revision === currentRevision) {
      // Client is up to date — empty delta.
      const empty: SnapshotDelta = {
        base_revision: currentRevision,
        new_revision: currentRevision,
        generated_at: unfiltered.generated_at,
        source_phase: unfiltered.source_phase,
        nodes_added: [],
        nodes_removed: [],
        nodes_updated: [],
        edges_added: [],
        edges_removed: [],
        stats: unfiltered.stats,
      };
      return {
        request_id: request.request_id,
        generated_at: unfiltered.generated_at,
        reset: false,
        new_revision: currentRevision,
        delta: empty,
      };
    }

    if (
      entry.previous &&
      request.since_revision === entry.previous.revision &&
      entry.current
    ) {
      const delta = diffSnapshots(
        entry.previous.snapshot,
        entry.current.snapshot,
        {
          base_revision: entry.previous.revision,
          new_revision: entry.current.revision,
        },
      );
      return {
        request_id: request.request_id,
        generated_at: entry.current.snapshot.generated_at,
        reset: false,
        new_revision: entry.current.revision,
        delta,
      };
    }

    const reason =
      request.since_revision > currentRevision
        ? "server_restart"
        : "history_exhausted";
    return this.resetResponse(
      request,
      unfiltered,
      currentRevision,
      reason,
      reason === "server_restart"
        ? "Server has no record of this revision (probably a restart); resetting."
        : "Client is more than one revision behind; cache history exhausted.",
    );
  }

  /**
   * Called by the file-system watcher with the relative paths that changed.
   * Rebuilds the unfiltered snapshot, diffs against the cached one, and bumps
   * the revision if anything actually changed. Multiple bursts coalesce —
   * the watcher in {@link UnityAssetIndexManager} debounces upstream, but
   * the cache also tolerates many small notifyChanged calls.
   */
  async notifyChanged(
    project: ProjectContext,
    index: AssetIndexLike,
    affectedPaths: ReadonlyArray<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    const entry = this.ensureEntry(project);
    for (const p of affectedPaths) entry.pendingPaths.add(p);

    if (!entry.current) {
      // Cold cache — first read will build it; nothing to diff yet.
      return;
    }

    // De-duplicate concurrent rebuilds: each call awaits the same in-flight
    // promise. The accumulated `pendingPaths` is drained when the build
    // resolves so a notify that arrives during the build is still picked up
    // on the next call.
    if (entry.inFlight) {
      try {
        await entry.inFlight;
      } catch {
        /* swallow — the original caller surfaces it */
      }
      return;
    }

    const draining = Array.from(entry.pendingPaths);
    entry.pendingPaths.clear();
    const build = this.buildUnfiltered(project, index, signal);
    entry.inFlight = build;
    try {
      const next = await build;
      const prev = entry.current.snapshot;
      const tentative = diffSnapshots(prev, next, {
        base_revision: entry.current.revision,
        new_revision: entry.current.revision + 1,
        affected_paths: draining,
      });
      if (isEmptyDelta(tentative)) {
        // Snapshot is structurally identical to what we already had — drop
        // the rebuild on the floor without bumping the revision counter.
        return;
      }
      entry.previous = entry.current;
      entry.current = {
        revision: entry.current.revision + 1,
        snapshot: next,
      };
      this.log(
        `GraphSnapshotCache(${project.name}) bumped to revision ${entry.current.revision} (+${tentative.nodes_added.length}n -${tentative.nodes_removed.length}n ~${tentative.nodes_updated.length}n / +${tentative.edges_added.length}e -${tentative.edges_removed.length}e)`,
      );
    } catch (e) {
      // Re-queue the paths so the next notify retries them.
      for (const p of draining) entry.pendingPaths.add(p);
      throw e;
    } finally {
      entry.inFlight = undefined;
    }
  }

  /**
   * Drop all cached state for the project (e.g. workspace closed). The next
   * call rebuilds cold; clients with stale revisions get reset.
   */
  invalidate(project: ProjectContext): void {
    this.entries.delete(project.rootPath);
  }

  dispose(): void {
    this.entries.clear();
  }

  // ---- internals ----------------------------------------------------------

  private ensureEntry(project: ProjectContext): Entry {
    let entry = this.entries.get(project.rootPath);
    if (!entry) {
      entry = { pendingPaths: new Set() };
      this.entries.set(project.rootPath, entry);
    }
    return entry;
  }

  private async ensureBase(
    entry: Entry,
    project: ProjectContext,
    index: AssetIndexLike,
    signal?: AbortSignal,
  ): Promise<GraphSnapshot> {
    if (entry.current) return entry.current.snapshot;
    if (entry.inFlight) return entry.inFlight;
    const build = this.buildUnfiltered(project, index, signal);
    entry.inFlight = build;
    try {
      const snapshot = await build;
      entry.current = { revision: 0, snapshot };
      this.log(
        `GraphSnapshotCache(${project.name}) seeded at revision 0 — ${snapshot.nodes.length} nodes, ${snapshot.edges.length} edges`,
      );
      return snapshot;
    } finally {
      entry.inFlight = undefined;
    }
  }

  private async buildUnfiltered(
    project: ProjectContext,
    index: AssetIndexLike,
    signal?: AbortSignal,
  ): Promise<GraphSnapshot> {
    const response = await buildAssetGraph(
      project.rootPath,
      index,
      {} as SnapshotRequest,
      signal,
    );
    return response.snapshot;
  }

  private resetResponse(
    request: SnapshotDeltaRequest,
    snapshot: GraphSnapshot,
    revision: number,
    reason:
      | "no_base"
      | "server_restart"
      | "history_exhausted"
      | "filter_mismatch"
      | "phase_change",
    message: string,
  ): SnapshotDeltaResponse {
    const warning: Warning = {
      code: WARNING_DELTA_RESET,
      message,
      context: { reason },
    };
    return {
      request_id: request.request_id,
      generated_at: snapshot.generated_at,
      warnings: [warning],
      reset: true,
      new_revision: revision,
      snapshot,
    };
  }
}
