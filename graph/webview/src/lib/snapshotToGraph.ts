// Day 3 Task 5: pure data adapter from a server-side GraphSnapshot to a
// Graphology graph instance. No rendering, no layout, no styling — those
// land in Tasks 6 and 7. Keeping this module pure makes it Vitest-friendly
// and lets Task 7's Sigma reducers read raw `kind` attributes.
//
// Why `multi: true`:
//   Graphology's non-multi mode dedupes by (source, target), but the
//   schema allows multiple edges between the same pair with different
//   kinds (e.g. a script can both `script_used_by_prefab` AND
//   `serialized_binding` against the same prefab). Collapsing them onto
//   one edge would lose information that Task 7's per-kind styling needs
//   to surface. Edge keys are deterministic: `${kind}:${source}:${target}`.
//
// Why drop dangling edges:
//   Day 2 intentionally emits `script_declares_class` edges to
//   `unity://csharp/T:...` IDs that won't exist as nodes until Day 8
//   (per docs/graph-schema.md §1.3). Rather than crash Graphology with
//   "node does not exist", we drop and count. The count flows into the
//   status bar so the gap is visible without scary copy.

import Graph from 'graphology';
import type { GraphSnapshot } from '@unity-index/graph-core';
import { nodeStyleFor } from './style';

export interface BuildResult {
  graph: Graph;
  /** Edges whose source or target was not in the node set. Expected on Day 3
   * for `script_declares_class` → `unity://csharp/...` dangling targets. */
  droppedEdges: number;
}

export function buildGraphologyGraph(snapshot: GraphSnapshot): BuildResult {
  const graph = new Graph({ type: 'directed', multi: true });

  for (const node of snapshot.nodes) {
    if (graph.hasNode(node.id)) continue; // defensive: snapshot should already dedupe
    // Random seed in [-1, 1]. ForceAtlas2 (Task 6) deadlocks if every node
    // starts at (0, 0); the layout itself overrides these in-place.
    const x = Math.random() * 2 - 1;
    const y = Math.random() * 2 - 1;
    // Size baked into the attr (not the reducer) because ForceAtlas2 reads
    // node size when computing repulsion. Color stays out — that's a render-
    // only concern handled by the Sigma node reducer in App.svelte.
    const { size } = nodeStyleFor(node.kind);
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

  let droppedEdges = 0;
  for (const edge of snapshot.edges) {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) {
      droppedEdges++;
      continue;
    }
    const key = `${edge.kind}:${edge.source}:${edge.target}`;
    if (graph.hasEdge(key)) continue; // schema guarantees uniqueness; belt + braces
    graph.addEdgeWithKey(key, edge.source, edge.target, {
      kind: edge.kind,
      size: 1,
      type: 'arrow',
    });
  }

  return { graph, droppedEdges };
}
