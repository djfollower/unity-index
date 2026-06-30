import * as path from "path";
import * as vscode from "vscode";
import { ProjectContext } from "../server/projectResolver";
import { UnityAssetIndex } from "./unityAssetIndex";
import { GraphSnapshotCache } from "./graphSnapshotCache";
import {
  BurstCoalescer,
  WATCHER_DEBOUNCE_MS,
  WATCHER_MAX_WAIT_MS,
} from "./burstCoalescer";

export type AssetIndexState = "idle" | "building" | "ready";

interface Entry {
  promise: Promise<UnityAssetIndex>;
  state: AssetIndexState;
  startedAt: number;
  readyAt?: number;
  index?: UnityAssetIndex;
  abort: AbortController;
}

export interface AssetIndexStatus {
  state: AssetIndexState;
  assetCount: number | null;
  metaCount: number | null;
  buildMs: number | null;
  lastInvalidatedAt: number | null;
}

const INVALIDATE_GLOB = "**/*.{meta,prefab,unity,asset,mat,anim,controller,playable,spriteatlas,lighting}";

/**
 * Caches one UnityAssetIndex per workspace root, debounces invalidation when
 * relevant asset files change, and exposes a status snapshot for the
 * ide_index_status tool.
 *
 * `get()` returns the same in-flight build promise to concurrent callers, so
 * a burst of tool invocations during cold start only does one scan.
 */
export class UnityAssetIndexManager {
  private readonly entries = new Map<string, Entry>();
  private readonly watchers = new Map<string, vscode.Disposable>();
  /** Per-project burst coalescer for watcher → invalidate. Day 7 — replaces
   *  the prior trailing-debounce-only `setTimeout` so sustained bursts
   *  (Reimport All) can't postpone the rebuild past {@link WATCHER_MAX_WAIT_MS}. */
  private readonly coalescers = new Map<string, BurstCoalescer>();
  private readonly lastInvalidatedAt = new Map<string, number>();
  /**
   * Day 7 — affected paths the watcher saw during the current debounce
   * window, keyed by project root. Drained when the debounce fires so the
   * graph cache learns *which* assets changed (used for affected_paths and
   * for the upcoming smart-incremental builder).
   */
  private readonly pendingPaths = new Map<string, Set<string>>();
  /**
   * Stores the project context per watcher key so the debounce handler can
   * forward {@link GraphSnapshotCache.notifyChanged} without a separate
   * lookup map. The watcher already holds this reference; we just remember
   * it across the async callback.
   */
  private readonly projectByKey = new Map<string, ProjectContext>();
  private readonly log: (msg: string) => void;
  private readonly graphCache?: GraphSnapshotCache;

  constructor(log: (msg: string) => void, graphCache?: GraphSnapshotCache) {
    this.log = log;
    this.graphCache = graphCache;
  }

  async get(project: ProjectContext): Promise<UnityAssetIndex> {
    const key = project.rootPath;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = this.startBuild(project);
      this.entries.set(key, entry);
      this.ensureWatcher(project);
    }
    return entry.promise;
  }

  status(project: ProjectContext): AssetIndexStatus {
    const key = project.rootPath;
    const entry = this.entries.get(key);
    const lastInvalidatedAt = this.lastInvalidatedAt.get(key) ?? null;
    if (!entry) {
      return {
        state: "idle",
        assetCount: null,
        metaCount: null,
        buildMs: null,
        lastInvalidatedAt,
      };
    }
    return {
      state: entry.state,
      assetCount: entry.index?.assetCount ?? null,
      metaCount: entry.index?.metaCount ?? null,
      buildMs:
        entry.readyAt !== undefined ? entry.readyAt - entry.startedAt : null,
      lastInvalidatedAt,
    };
  }

  invalidate(project: ProjectContext): void {
    this.invalidateKey(project.rootPath);
  }

  dispose(): void {
    for (const c of this.coalescers.values()) c.cancel();
    this.coalescers.clear();
    for (const w of this.watchers.values()) w.dispose();
    this.watchers.clear();
    for (const entry of this.entries.values()) entry.abort.abort();
    this.entries.clear();
    this.pendingPaths.clear();
    this.projectByKey.clear();
  }

  private startBuild(project: ProjectContext): Entry {
    const abort = new AbortController();
    const startedAt = Date.now();
    const entry: Entry = {
      promise: undefined as unknown as Promise<UnityAssetIndex>,
      state: "building",
      startedAt,
      abort,
    };
    entry.promise = UnityAssetIndex.build(project, abort.signal).then(
      (index) => {
        entry.index = index;
        entry.state = "ready";
        entry.readyAt = Date.now();
        this.log(
          `UnityAssetIndex(${project.name}) ready in ${entry.readyAt - startedAt}ms — ${index.assetCount} assets, ${index.metaCount} metas`,
        );
        return index;
      },
      (e) => {
        // Drop failed entry so the next call can retry.
        if (this.entries.get(project.rootPath) === entry) {
          this.entries.delete(project.rootPath);
        }
        throw e;
      },
    );
    return entry;
  }

  private ensureWatcher(project: ProjectContext): void {
    const key = project.rootPath;
    if (this.watchers.has(key)) return;
    this.projectByKey.set(key, project);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(project.rootUri, INVALIDATE_GLOB),
    );
    const trigger = (uri: vscode.Uri) => {
      const rel = path
        .relative(project.rootPath, uri.fsPath)
        .split(path.sep)
        .join("/");
      this.recordAffected(key, rel);
      this.coalescerFor(key).schedule();
    };
    watcher.onDidCreate(trigger);
    watcher.onDidChange(trigger);
    watcher.onDidDelete(trigger);
    this.watchers.set(key, watcher);
  }

  private coalescerFor(key: string): BurstCoalescer {
    let c = this.coalescers.get(key);
    if (!c) {
      c = new BurstCoalescer(
        () => void this.invalidateKey(key),
        WATCHER_DEBOUNCE_MS,
        WATCHER_MAX_WAIT_MS,
      );
      this.coalescers.set(key, c);
    }
    return c;
  }

  private recordAffected(key: string, relPath: string): void {
    let bucket = this.pendingPaths.get(key);
    if (!bucket) {
      bucket = new Set();
      this.pendingPaths.set(key, bucket);
    }
    bucket.add(relPath);
  }

  private async invalidateKey(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry) {
      entry.abort.abort();
      this.entries.delete(key);
    }
    this.lastInvalidatedAt.set(key, Date.now());
    const drained = this.pendingPaths.get(key);
    this.pendingPaths.delete(key);
    this.log(`UnityAssetIndex(${key}) invalidated`);

    // Day 7 — push the change through to the snapshot cache so the next
    // delta call can serve a real diff. We rebuild the asset index first
    // (via this.get) because the graph cache reads from a fresh
    // UnityAssetIndex. Errors are logged, not thrown — a single failing
    // rebuild must not poison subsequent watcher events.
    if (!this.graphCache) return;
    const project = this.projectByKey.get(key);
    if (!project) return;
    try {
      const index = await this.get(project);
      await this.graphCache.notifyChanged(
        project,
        index,
        drained ? Array.from(drained) : [],
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`GraphSnapshotCache(${project.name}) notify failed: ${msg}`);
    }
  }
}
