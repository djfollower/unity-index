// Day 7 — pure snapshot diff. Same code path on both bridges: the cache holds
// the last unfiltered snapshot, the watcher signals a new one, and this
// function computes the SnapshotDelta to ship over the wire.
//
// Identity rules match snapshot-delta-wire.ts:
//   - Nodes are keyed by `id`.
//   - Edges are keyed by `(source, target, kind)` via `edgeKey()`.
//
// Update detection on nodes is deep-equality over the user-visible attrs
// (kind, label, path, guid, location, metadata). Metadata comparison uses
// canonical JSON.stringify because nodes' metadata is opaque JsonObject /
// Record<string, unknown> on both sides.
//
// Edge updates are modelled as remove + add (see the schema doc for the
// rationale). If a `(source, target, kind)` exists in both snapshots but its
// metadata differs, this function emits the key in `edges_removed` *and* the
// new edge in `edges_added`. The receiver applies removes before adds so the
// net effect is replacement.

import type {
  GraphEdge,
  GraphNode,
  GraphSnapshot,
} from './graph-types.js';
import type { EdgeKey, SnapshotDelta } from './snapshot-delta-wire.js';
import { edgeKey } from './snapshot-delta-wire.js';

export interface DiffSnapshotsOptions {
  base_revision: number;
  new_revision: number;
  /** Project-relative paths that triggered the rebuild. Pass through; do not
   *  use to gate the diff itself (the diff is a structural comparison and is
   *  correct even when `affected_paths` is empty or stale). */
  affected_paths?: string[];
  /** Optional override for `generated_at`. Defaults to `next.generated_at` so
   *  the delta carries the same timestamp as the snapshot it produced. */
  generated_at?: string;
}

/**
 * Diff two snapshots. Pure; no I/O; no mutation of inputs.
 *
 * Pre-condition: callers must have already decided `next` is the successor of
 * `prev` at the chosen revision pair. `diffSnapshots` does not validate that
 * `prev` and `next` came from the same project or share `source_phase` — the
 * cache layer above is responsible for emitting a `reset` when those don't
 * match. (We could check, but the answer is the same: the caller wouldn't
 * have called us if a reset was the right move.)
 */
export function diffSnapshots(
  prev: GraphSnapshot,
  next: GraphSnapshot,
  opts: DiffSnapshotsOptions,
): SnapshotDelta {
  const prevNodes = new Map<string, GraphNode>();
  for (const n of prev.nodes) prevNodes.set(n.id, n);
  const nextNodes = new Map<string, GraphNode>();
  for (const n of next.nodes) nextNodes.set(n.id, n);

  const nodes_added: GraphNode[] = [];
  const nodes_removed: string[] = [];
  const nodes_updated: GraphNode[] = [];

  for (const [id, node] of nextNodes) {
    const prior = prevNodes.get(id);
    if (!prior) {
      nodes_added.push(node);
    } else if (!nodesEqual(prior, node)) {
      nodes_updated.push(node);
    }
  }
  for (const id of prevNodes.keys()) {
    if (!nextNodes.has(id)) nodes_removed.push(id);
  }

  const prevEdges = new Map<string, GraphEdge>();
  for (const e of prev.edges) prevEdges.set(edgeKey(e), e);
  const nextEdges = new Map<string, GraphEdge>();
  for (const e of next.edges) nextEdges.set(edgeKey(e), e);

  const edges_added: GraphEdge[] = [];
  const edges_removed: EdgeKey[] = [];

  for (const [key, edge] of nextEdges) {
    const prior = prevEdges.get(key);
    if (!prior) {
      edges_added.push(edge);
    } else if (!metadataEqual(prior.metadata, edge.metadata)) {
      // Edge metadata changed — remove the old, add the new.
      edges_removed.push({
        source: prior.source,
        target: prior.target,
        kind: prior.kind,
      });
      edges_added.push(edge);
    }
  }
  for (const [key, edge] of prevEdges) {
    if (!nextEdges.has(key)) {
      edges_removed.push({
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
      });
    }
  }

  const result: SnapshotDelta = {
    base_revision: opts.base_revision,
    new_revision: opts.new_revision,
    generated_at: opts.generated_at ?? next.generated_at,
    source_phase: next.source_phase,
    nodes_added,
    nodes_removed,
    nodes_updated,
    edges_added,
    edges_removed,
    stats: next.stats,
  };
  // `exactOptionalPropertyTypes` forbids setting an optional to `undefined` —
  // omit the key when no paths were passed.
  if (opts.affected_paths !== undefined) {
    result.affected_paths = opts.affected_paths;
  }
  return result;
}

/**
 * True when the diff is empty — useful for the cache layer to decide whether
 * a revision bump is even warranted. A file-system event burst can fire the
 * watcher without actually changing what the graph sees (e.g. someone saves
 * an unrelated file under Assets/), and we'd rather not advance the revision
 * counter for a no-op.
 */
export function isEmptyDelta(d: SnapshotDelta): boolean {
  return (
    d.nodes_added.length === 0 &&
    d.nodes_removed.length === 0 &&
    d.nodes_updated.length === 0 &&
    d.edges_added.length === 0 &&
    d.edges_removed.length === 0
  );
}

// ---------------------------------------------------------------------------
// Equality helpers — module-private. Exported for tests via `__forTests`
// only; do not rely on these from production code paths.
// ---------------------------------------------------------------------------

function nodesEqual(a: GraphNode, b: GraphNode): boolean {
  if (a.kind !== b.kind) return false;
  if (a.label !== b.label) return false;
  if ((a.path ?? null) !== (b.path ?? null)) return false;
  if ((a.guid ?? null) !== (b.guid ?? null)) return false;

  const al = a.location, bl = b.location;
  if (al && bl) {
    if (al.line !== bl.line) return false;
    if ((al.column ?? null) !== (bl.column ?? null)) return false;
  } else if (al || bl) {
    return false;
  }
  return metadataEqual(a.metadata, b.metadata);
}

function metadataEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  // Canonical-key JSON is sufficient: both producers go through the same
  // serialisers, so key order is stable on each side. We sort keys to
  // protect against a future divergence.
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]))
      .join(',') +
    '}'
  );
}

/** Exposed only for tests. Production code must use `diffSnapshots`. */
export const __forTests = { nodesEqual, metadataEqual, canonicalJson };
