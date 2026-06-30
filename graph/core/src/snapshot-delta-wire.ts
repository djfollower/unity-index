// Day 7 — incremental snapshot updates.
//
// `unity_graph_snapshot` returns a full graph. For large Unity projects that's
// expensive to recompute and to ship across the bridge on every Save-All burst.
// `unity_graph_snapshot_delta` lets a client cache a snapshot, remember its
// `revision`, and pull only what changed since then.
//
// ---------------------------------------------------------------------------
// Revision model
// ---------------------------------------------------------------------------
// The host (Rider plugin / VS Code extension) maintains a single monotonic
// `revision: number` per project, scoped to a process lifetime:
//
//   - Starts at 0 when the host first computes a snapshot.
//   - Bumps by 1 every time the host applies a non-empty change set
//     (an asset file edit, a delete, a meta-file write).
//   - Resets to 0 on process restart (the host has no persistent history).
//
// Every full `SnapshotResponse` now echoes `revision` so clients know what to
// pass back as `since_revision` later.
//
// ---------------------------------------------------------------------------
// Reset semantics
// ---------------------------------------------------------------------------
// A delta request can fail to be served as a delta in several legitimate ways:
//
//   - The host restarted (server revision is lower than the client thinks).
//   - The client is too far behind — the host only keeps a bounded change
//     history (see `SNAPSHOT_DELTA_MAX_HISTORY`).
//   - The filter arguments differ from what produced the base snapshot. The
//     host does not track per-filter histories; mismatched filters force a
//     full rebuild on the client.
//
// In every case the host responds with `reset: true` and a full `snapshot`
// payload, plus a `WARNING_DELTA_RESET` warning explaining the cause. The
// client MUST discard local state and apply `snapshot` as if it were a fresh
// `unity_graph_snapshot` response.
//
// ---------------------------------------------------------------------------
// Identity rules
// ---------------------------------------------------------------------------
// Nodes: keyed by `id`. `nodes_added` / `nodes_removed` / `nodes_updated` are
// disjoint within a single delta (a single revision either adds a node, drops
// it, or replaces its attributes — never two of those at once).
//
// Edges: keyed by the triple `(source, target, kind)`. Edges have no per-edge
// id and metadata changes are rare, so we model edge updates as remove+add
// rather than a third bucket — this also keeps the wire flat.
//
// Apply order on the receiver:
//   1. `nodes_removed`  (drops dangling edges automatically in Graphology)
//   2. `edges_removed`
//   3. `nodes_added`
//   4. `nodes_updated`  (replace attributes; node id is already present)
//   5. `edges_added`
//
// This order avoids spurious "edge endpoint missing" errors at the consumer.

import type {
  EdgeKind,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  GraphSourcePhase,
  GraphStats,
  NodeKind,
} from './graph-types.js';
import type { BaseRequest, BaseResponse, Warning } from './snapshot-wire.js';

/**
 * Identity for an edge in a delta payload. Edges have no standalone id, so
 * removals must carry the full triple. `(source, target, kind)` must be
 * unique within a snapshot — multi-edges of the same kind between the same
 * endpoints are collapsed by the host's deduper before they reach the wire.
 */
export interface EdgeKey {
  source: string;
  target: string;
  kind: EdgeKind;
}

/**
 * Changes between `base_revision` and `new_revision`. Apply in the order
 * described in the module header. After applying:
 *
 *   client.revision === new_revision
 *   client.stats    === stats (replace wholesale, not incremental math)
 */
export interface SnapshotDelta {
  base_revision: number;
  new_revision: number;
  /** ISO-8601 timestamp at which the host minted `new_revision`. */
  generated_at: string;
  /** Same `source_phase` as the most recent snapshot. Cannot change inside
   *  a delta — a phase change (e.g. Phase 1 → Phase 2 when code edges come
   *  online) forces a reset. */
  source_phase: GraphSourcePhase;

  nodes_added: GraphNode[];
  nodes_removed: string[];
  nodes_updated: GraphNode[];

  edges_added: GraphEdge[];
  edges_removed: EdgeKey[];

  /** New totals at `new_revision`. The client SHOULD replace its cached
   *  stats wholesale rather than try to math them out of the buckets above —
   *  the host's counters include skipped-instance / skipped-field tallies
   *  that are not derivable from the visible add/remove lists. */
  stats: GraphStats;

  /** Project-relative paths that triggered this delta. Optional, for
   *  debugging and telemetry — the apply logic ignores it. Capped at
   *  `SNAPSHOT_DELTA_AFFECTED_PATHS_CAP`; if more files changed in this
   *  revision the host truncates and emits a warning. */
  affected_paths?: string[];
}

export interface SnapshotDeltaRequest extends BaseRequest {
  /** Revision the client last applied. Pass `0` to force a reset (useful for
   *  bootstrap when the client has no cache but wants the same code path). */
  since_revision: number;

  // Filters must match the request that produced the base snapshot. A mismatch
  // returns `reset: true`. Keep this in sync with `SnapshotRequest`.
  include_kinds?: NodeKind[];
  exclude_kinds?: NodeKind[];
  path_globs?: string[];
  include_orphans?: boolean;
}

/**
 * Either a delta (`reset: false`) or a full reset (`reset: true`).
 *
 * Discriminate on `reset`:
 *
 *   if (resp.reset) applyFullSnapshot(resp.snapshot!, resp.new_revision);
 *   else            applyDelta(resp.delta!);
 *
 * The other field is always omitted to keep payloads minimal. Both branches
 * echo `new_revision` so callers can store it without branching.
 */
export interface SnapshotDeltaResponse extends BaseResponse {
  reset: boolean;
  new_revision: number;
  delta?: SnapshotDelta;
  snapshot?: GraphSnapshot;
}

/** Default ring buffer depth: how many past revisions the host keeps so it
 *  can serve a delta without resetting. Sized for ~30s of typical edit
 *  bursts on a large Unity project — beyond that, a full rebuild is cheap
 *  enough relative to the storage cost. */
export const SNAPSHOT_DELTA_MAX_HISTORY = 64;

/** Soft cap on `affected_paths` so the wire payload doesn't balloon during
 *  bulk operations (folder rename, asset import). Hosts SHOULD emit a
 *  `WARNING_DELTA_AFFECTED_PATHS_TRUNCATED` warning when capped. */
export const SNAPSHOT_DELTA_AFFECTED_PATHS_CAP = 256;

/** Warning emitted when the host had to reset instead of serving a delta.
 *  `context.reason` is one of: `"server_restart"`, `"history_exhausted"`,
 *  `"filter_mismatch"`, `"phase_change"`, `"no_base"`. */
export const WARNING_DELTA_RESET = 'delta_reset';

/** Warning emitted when `affected_paths` was truncated to
 *  `SNAPSHOT_DELTA_AFFECTED_PATHS_CAP`. `context.total` carries the actual
 *  count so clients can surface a "many files changed" hint. */
export const WARNING_DELTA_AFFECTED_PATHS_TRUNCATED =
  'delta_affected_paths_truncated';

// ---------------------------------------------------------------------------
// Helpers — pure, no I/O. Kept here (not in traversal.ts) because they're
// part of the wire contract: callers on either side of the bridge should
// agree on edge identity and on how to validate a payload before applying.
// ---------------------------------------------------------------------------

/** Field separator inside a canonical edge key string. Uses ASCII Unit
 *  Separator (U+001F) so the value can never collide with characters that
 *  legitimately appear in node ids (paths, `::` namespaces) or edge kinds. */
export const EDGE_KEY_SEPARATOR = '\u001F';

/** Canonical string form of an edge key. Used as Map key in apply paths. */
export function edgeKey(e: EdgeKey | GraphEdge): string {
  return e.source + EDGE_KEY_SEPARATOR + e.target + EDGE_KEY_SEPARATOR + e.kind;
}

/** True when a delta is structurally well-formed for application against
 *  a client that holds `base_revision`. Cheap sanity checks only — does not
 *  detect every conflict (e.g. an `edges_added` whose endpoints aren't in
 *  the client's current node set after applying removals). Callers that
 *  need full validation should run it after the apply step and roll back
 *  on failure. */
export function isApplicableDelta(
  delta: SnapshotDelta,
  clientRevision: number,
): boolean {
  if (delta.base_revision !== clientRevision) return false;
  if (delta.new_revision <= delta.base_revision) return false;
  return true;
}
