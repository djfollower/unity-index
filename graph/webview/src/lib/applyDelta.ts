// Day 7 Task 6 — apply a SnapshotDelta in place to an existing Graphology
// graph, instead of rebuilding the whole graph on every update.
//
// Why in-place: rebuilding loses camera position, layout positions, and forces
// Sigma to re-create all node programs. With ~30k nodes a full rebuild visibly
// freezes the panel for a second or two; applying ~20 changed entries is sub-
// millisecond.
//
// Apply order matches `snapshot-delta-wire.ts` (1) remove nodes (cascades
// dangling edges automatically in Graphology), (2) remove explicit edges,
// (3) add nodes, (4) update node attrs, (5) add edges. This avoids spurious
// "edge endpoint missing" errors when an added edge's endpoints arrive in
// the same delta.
//
// Edge keys must match `snapshotToGraph.ts`: `${kind}:${source}:${target}`.
// Drifting from that key shape would mean delta removals look up a different
// key than the original additions.

import type Graph from 'graphology';
import type { GraphEdge, GraphNode, SnapshotDelta } from '@unity-index/graph-core';
import { nodeStyleFor } from './style';

export interface ApplyDeltaResult {
  /** Edges in `edges_added` whose source/target was not in the graph after
   *  applying node operations. Same `script_declares_class` semantics as
   *  `snapshotToGraph.buildGraphologyGraph` — expected on Day 3, becomes
   *  zero on Day 8 when csharp nodes ship. */
  droppedEdges: number;
  /** True when at least one node or edge actually changed. Lets callers
   *  decide whether to nudge Sigma or skip a refresh entirely. */
  hadChanges: boolean;
}

const edgeKeyOf = (e: { source: string; target: string; kind: string }): string =>
  `${e.kind}:${e.source}:${e.target}`;

export function applyDeltaToGraph(
  graph: Graph,
  delta: SnapshotDelta,
): ApplyDeltaResult {
  let droppedEdges = 0;
  let hadChanges = false;

  // 1. Remove nodes. Graphology drops dangling edges automatically when a
  //    node disappears, so we don't need to enumerate edge removals for the
  //    same node.
  for (const id of delta.nodes_removed) {
    if (graph.hasNode(id)) {
      graph.dropNode(id);
      hadChanges = true;
    }
  }

  // 2. Remove explicit edges. After step 1, an edge may already be gone
  //    because its endpoint was removed — that's fine, skip silently.
  for (const e of delta.edges_removed) {
    const key = edgeKeyOf(e);
    if (graph.hasEdge(key)) {
      graph.dropEdge(key);
      hadChanges = true;
    }
  }

  // 3. Add new nodes. Seed positions in [-1, 1] same way as
  //    snapshotToGraph — the next layout pass will move them.
  for (const node of delta.nodes_added) {
    if (graph.hasNode(node.id)) continue;
    addNode(graph, node);
    hadChanges = true;
  }

  // 4. Update existing nodes. Merge attrs so the layout's `x`/`y` survive;
  //    only the user-visible fields (label, kind, path, guid) change. Node
  //    size is keyed off `kind`, so if kind changed we refresh size too.
  for (const node of delta.nodes_updated) {
    if (!graph.hasNode(node.id)) {
      // Promoted to add: cache was probably reset between fetches and a
      // delta arrived stale. Treat as an add.
      addNode(graph, node);
      hadChanges = true;
      continue;
    }
    const { size } = nodeStyleFor(node.kind);
    graph.mergeNodeAttributes(node.id, {
      label: node.label,
      kind: node.kind,
      path: node.path,
      guid: node.guid,
      size,
    });
    hadChanges = true;
  }

  // 5. Add new edges. Drop edges that dangle after step 1-4 (matches
  //    buildGraphologyGraph's contract for `script_declares_class`).
  for (const edge of delta.edges_added) {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) {
      droppedEdges += 1;
      continue;
    }
    const key = edgeKeyOf(edge);
    if (graph.hasEdge(key)) continue; // belt + braces — schema guarantees uniqueness
    graph.addEdgeWithKey(key, edge.source, edge.target, {
      kind: edge.kind,
      size: 1,
      type: 'arrow',
    });
    hadChanges = true;
  }

  return { droppedEdges, hadChanges };
}

function addNode(graph: Graph, node: GraphNode): void {
  const { size } = nodeStyleFor(node.kind);
  const x = Math.random() * 2 - 1;
  const y = Math.random() * 2 - 1;
  graph.addNode(node.id, {
    label: node.label,
    kind: node.kind,
    path: node.path,
    guid: node.guid,
    x,
    y,
    size,
  });
}

// Re-exported so tests and callers don't have to recompute the edge key shape.
export { edgeKeyOf };
// Avoid the unused-import lint by referencing GraphEdge type in a comment-
// equivalent way: re-export it. (Used by tests.)
export type { GraphEdge };
