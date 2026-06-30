// Day 9.4 — cross-domain chain highlighter. A "cross-domain chain" is any
// path that crosses the `script_declares_class` boundary between an
// asset-domain node (prefab/scene/script/SO) and a code-domain node
// (class/interface/struct). The interesting structural fact is the chain:
//
//   prefab/scene  ──script_used_by_*──▶  script
//                                          │
//                                          ▼  (script_declares_class)
//                                       class
//                                          │
//                                          ▼  (class_inherits_from)
//                                       BaseClass
//                                          │
//                                          ▼
//                                       MonoBehaviour
//
// On hover of any node in such a chain, we want the entire chain to light
// up so the user can see "this prefab → this script → this class → this
// inheritance ancestor" at a glance. That's what this module computes.
//
// The walk is bounded: at most MAX_CHAIN_HOPS hops in each direction, plus
// a hard cap on the total node count so a hub class (MonoBehaviour itself
// has hundreds of declaring scripts) doesn't paint the entire canvas.

import type Graph from 'graphology';

/** Plan said 5 hops; we keep one extra hop of margin for asset→script
 *  edges + script→class + 3 levels of inheritance. */
export const MAX_CHAIN_HOPS = 5;

/** Defensive cap on total chain size. Hub classes (MonoBehaviour,
 *  Component, Object) connect to thousands of nodes; without a cap a
 *  single hover would flood the reducer with the whole graph and stall
 *  Sigma. 200 is enough for any humane chain but instantly bounded. */
export const MAX_CHAIN_NODES = 200;

const ASSET_TO_SCRIPT_EDGES = new Set<string>([
  'script_used_by_prefab',
  'script_used_by_scene',
  'scene_contains_prefab',
  'prefab_variant_of',
  'serialized_binding',
]);

const SCRIPT_DECLARES_CLASS = 'script_declares_class';

const CODE_INHERITANCE_EDGES = new Set<string>([
  'class_inherits_from',
  'class_implements_interface',
]);

export interface CrossDomainChain {
  /** All node ids on the chain, including the focus node. */
  nodes: Set<string>;
  /** All edge ids on the chain. */
  edges: Set<string>;
}

const EMPTY: CrossDomainChain = { nodes: new Set(), edges: new Set() };

/** Compute the cross-domain chain anchored on `focusNodeId`. Returns the
 *  empty chain when the focus has no path to a `script_declares_class`
 *  boundary — only nodes that actually bridge the domains get highlighted.
 *
 *  Algorithm: split the walk in two halves.
 *   - Asset half: from the focus, walk OUTBOUND through asset edges until
 *     we land on a `script` node, then cross `script_declares_class` to
 *     pick up its declared class.
 *   - Code half: from any class we touch (including ones reached via the
 *     asset half), walk OUTBOUND through `class_inherits_from` /
 *     `class_implements_interface` to collect ancestors.
 *   - Reverse direction is also walked so hovering a class or a
 *     MonoBehaviour-parent surfaces the chain in the other direction.
 *
 *  Hop counting is by graph edges (not by domains crossed); maxHops caps
 *  total traversal depth. */
export function computeCrossDomainChain(
  graph: Graph,
  focusNodeId: string,
  maxHops: number = MAX_CHAIN_HOPS,
): CrossDomainChain {
  if (!graph.hasNode(focusNodeId)) return EMPTY;

  const nodes = new Set<string>([focusNodeId]);
  const edges = new Set<string>();

  // BFS in both directions; each queued frame carries the remaining hop
  // budget. We accept ANY incident edge of an interesting kind so the
  // walk traverses asset↔script, script↔class, class↔class freely.
  const queue: Array<{ id: string; hopsLeft: number }> = [{ id: focusNodeId, hopsLeft: maxHops }];
  let crossedBoundary = false;

  while (queue.length > 0) {
    if (nodes.size >= MAX_CHAIN_NODES) break;
    const { id, hopsLeft } = queue.shift()!;
    if (hopsLeft <= 0) continue;
    if (!graph.hasNode(id)) continue;

    graph.forEachEdge(id, (edgeId, attrs, source, target) => {
      if (edges.has(edgeId)) return;
      const kind = typeof attrs.kind === 'string' ? attrs.kind : '';
      if (!isChainEdge(kind)) return;
      if (kind === SCRIPT_DECLARES_CLASS) crossedBoundary = true;
      edges.add(edgeId);
      const other = source === id ? target : source;
      if (typeof other === 'string' && !nodes.has(other)) {
        if (nodes.size >= MAX_CHAIN_NODES) return;
        nodes.add(other);
        queue.push({ id: other, hopsLeft: hopsLeft - 1 });
      }
    });
  }

  // A chain is only interesting if it crossed the asset↔code boundary at
  // least once. Without that we'd light up trivial subgraphs (e.g. two
  // prefabs sharing a script — useful, but not a cross-domain chain).
  if (!crossedBoundary) return EMPTY;
  return { nodes, edges };
}

function isChainEdge(kind: string): boolean {
  return (
    ASSET_TO_SCRIPT_EDGES.has(kind) ||
    kind === SCRIPT_DECLARES_CLASS ||
    CODE_INHERITANCE_EDGES.has(kind)
  );
}
