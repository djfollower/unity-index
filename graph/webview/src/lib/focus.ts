// Day 6 Task 7: client-side focus subgraph. Pure local traversal over the
// in-memory snapshot — no bridge round-trip. Wraps graph-core's `neighbors`
// in a webview-friendly API while keeping the algorithm shared with the
// MCP tools and the Kotlin port (Day 6 Tasks 2, 3, 6).
//
// Layout-preservation note: the result of this module is *visibility only*.
// The Graphology graph + node positions are untouched, so a focus → unfocus
// round-trip leaves the canvas where the user left it. The future Day-7
// worker-layout author MUST NOT auto-relayout on focus — see comment in
// App.svelte.

import type {
  GraphSnapshot,
  ImpactClassification,
  ImpactedNode,
  TraversalDirection,
} from '@unity-index/graph-core';
import {
  buildAdjacency,
  impact as impactAlgo,
  neighbors as neighborsAlgo,
} from '@unity-index/graph-core';
import { HARD_RENDER_CAP } from './layout';

export type FocusKind = 'neighbors' | 'impact';

export interface FocusFrame {
  nodeId: string;
  hops: number;
  direction: TraversalDirection;
  /** When 'impact', the frame also computes ImpactedNode entries for the
   *  reducer to colour with classification rings. */
  kind: FocusKind;
}

export interface FocusVisibility {
  nodes: Set<string>;
  edges: Set<string>;
  /** Populated only for impact frames; keyed by node id. */
  impactClass: Map<string, ImpactClassification | undefined>;
}

// Cached AdjacencyIndex per snapshot. Cheap to recompute (O(N+E)) but we
// reuse it across hop/direction changes within the same focus session.
let cachedSnapshot: GraphSnapshot | null = null;
let cachedAdj: ReturnType<typeof buildAdjacency> | null = null;

function adjFor(snapshot: GraphSnapshot): ReturnType<typeof buildAdjacency> {
  if (cachedSnapshot === snapshot && cachedAdj) return cachedAdj;
  cachedSnapshot = snapshot;
  cachedAdj = buildAdjacency(snapshot);
  return cachedAdj;
}

/**
 * Apply the *last* frame of `focusStack` (earlier frames are navigation
 * history, not composition). Returns visible node IDs and edge keys in the
 * same `${kind}:${source}:${target}` format snapshotToGraph uses.
 */
export function computeVisibility(
  snapshot: GraphSnapshot,
  focusStack: FocusFrame[],
): FocusVisibility {
  if (focusStack.length === 0) {
    return {
      nodes: new Set(),
      edges: new Set(),
      impactClass: new Map(),
    };
  }
  const last = focusStack[focusStack.length - 1];
  if (!last) {
    return { nodes: new Set(), edges: new Set(), impactClass: new Map() };
  }
  const adj = adjFor(snapshot);

  if (last.kind === 'impact') {
    const res = impactAlgo(adj, [last.nodeId], { classify: true });
    const nodes = new Set<string>();
    nodes.add(last.nodeId);
    for (const n of res.nodes) nodes.add(n.id);
    const edges = new Set<string>();
    for (const e of res.edges) edges.add(`${e.kind}:${e.source}:${e.target}`);
    const impactClass = new Map<string, ImpactClassification | undefined>();
    for (const n of res.impacted as ImpactedNode[]) {
      impactClass.set(n.id, n.classification);
    }
    return { nodes, edges, impactClass };
  }

  const res = neighborsAlgo(adj, [last.nodeId], {
    hops: last.hops,
    direction: last.direction,
    maxNodes: HARD_RENDER_CAP,
  });
  const nodes = new Set<string>();
  for (const n of res.nodes) nodes.add(n.id);
  const edges = new Set<string>();
  for (const e of res.edges) edges.add(`${e.kind}:${e.source}:${e.target}`);
  return { nodes, edges, impactClass: new Map() };
}

/** Reset the adjacency cache. Call on snapshot replace. */
export function resetFocusCache(): void {
  cachedSnapshot = null;
  cachedAdj = null;
}
