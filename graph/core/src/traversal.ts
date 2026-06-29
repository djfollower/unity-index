// Pure-data BFS / reverse-BFS over a GraphSnapshot. No Graphology, no DOM,
// no host dependency — graph-core stays Graphology-free (Day 1 rule).
//
// Shared between:
//   - the in-memory webview focus implementation (graph/webview/src/lib/focus.ts)
//   - the TypeScript MCP tools (vscode-extension/src/tools/unity/unityGraph*Tool.ts)
//   - the Kotlin port (util/GraphTraversal.kt) which MUST stay byte-equivalent
//     for the same snapshot (verified by Day 6 Task 11's fixture test).
//
// Anything semantic (classification rules, edge-verb copy, sort order) is
// defined HERE; the Kotlin side mirrors this file literally.

import type {
  EdgeKind,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
} from './graph-types.js';
import type {
  ImpactClassification,
  ImpactedNode,
  EdgeWithEndpoint,
  TraversalDirection,
} from './neighbors-wire.js';

export interface AdjacencyIndex {
  out: Map<string, GraphEdge[]>;
  in: Map<string, GraphEdge[]>;
  nodesById: Map<string, GraphNode>;
}

export function buildAdjacency(snapshot: GraphSnapshot): AdjacencyIndex {
  const out = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  const nodesById = new Map<string, GraphNode>();
  for (const n of snapshot.nodes) nodesById.set(n.id, n);
  for (const e of snapshot.edges) {
    let o = out.get(e.source);
    if (!o) {
      o = [];
      out.set(e.source, o);
    }
    o.push(e);
    let i = incoming.get(e.target);
    if (!i) {
      i = [];
      incoming.set(e.target, i);
    }
    i.push(e);
  }
  return { out, in: incoming, nodesById };
}

// ---------------------------------------------------------------------------
// neighbors — BFS from each seed; union the results.
// ---------------------------------------------------------------------------

export interface NeighborsOptions {
  hops: number;
  direction: TraversalDirection;
  edgeKinds?: Set<EdgeKind>;
  maxNodes: number;
}

export interface NeighborsResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  unresolvedIds: string[];
}

export function neighbors(
  adj: AdjacencyIndex,
  seeds: string[],
  opts: NeighborsOptions,
): NeighborsResult {
  const unresolvedIds: string[] = [];
  const resolvedSeeds: string[] = [];
  for (const id of seeds) {
    if (adj.nodesById.has(id)) {
      resolvedSeeds.push(id);
    } else {
      unresolvedIds.push(id);
    }
  }

  const visited = new Set<string>();
  const edgeKeys = new Set<string>();
  const resultEdges: GraphEdge[] = [];
  let truncated = false;

  // frontier carries (id, depth). BFS layer-by-layer so the edge-filter +
  // maxNodes truncation is deterministic.
  let frontier: string[] = [];
  for (const id of resolvedSeeds) {
    if (visited.has(id)) continue;
    if (visited.size >= opts.maxNodes) {
      truncated = true;
      break;
    }
    visited.add(id);
    frontier.push(id);
  }

  outer: for (let depth = 0; depth < opts.hops; depth += 1) {
    if (frontier.length === 0) break;
    const next: string[] = [];
    for (const src of frontier) {
      const cands = edgesForDirection(adj, src, opts.direction);
      for (const e of cands) {
        if (opts.edgeKinds && !opts.edgeKinds.has(e.kind)) continue;
        // Edge filter applied DURING traversal so an excluded kind never
        // counts toward the hop budget. Load-bearing for Day 12 DSL.
        const other = otherEnd(e, src, opts.direction);
        if (other === undefined) continue;
        const edgeKey = `${e.kind}:${e.source}:${e.target}`;
        if (!edgeKeys.has(edgeKey)) {
          edgeKeys.add(edgeKey);
          resultEdges.push(e);
        }
        if (!visited.has(other)) {
          if (visited.size >= opts.maxNodes) {
            // Drop this frontier; "truncated" means we stopped expanding,
            // not that partial results came back.
            truncated = true;
            break outer;
          }
          visited.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }

  const nodes: GraphNode[] = [];
  for (const id of visited) {
    const n = adj.nodesById.get(id);
    if (n) nodes.push(n);
  }
  return { nodes, edges: resultEdges, truncated, unresolvedIds };
}

function edgesForDirection(
  adj: AdjacencyIndex,
  id: string,
  direction: TraversalDirection,
): GraphEdge[] {
  if (direction === 'out') return adj.out.get(id) ?? [];
  if (direction === 'in') return adj.in.get(id) ?? [];
  const o = adj.out.get(id) ?? [];
  const i = adj.in.get(id) ?? [];
  if (o.length === 0) return i;
  if (i.length === 0) return o;
  return o.concat(i);
}

function otherEnd(
  e: GraphEdge,
  from: string,
  direction: TraversalDirection,
): string | undefined {
  if (direction === 'out') return e.source === from ? e.target : undefined;
  if (direction === 'in') return e.target === from ? e.source : undefined;
  if (e.source === from) return e.target;
  if (e.target === from) return e.source;
  return undefined;
}

// ---------------------------------------------------------------------------
// impact — reverse-reachable closure with classification.
// Direction is FIXED to incoming per §3.3 ("what breaks if I delete this").
// ---------------------------------------------------------------------------

export interface ImpactOptions {
  maxDepth?: number;
  classify: boolean;
}

export interface ImpactResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  impacted: ImpactedNode[];
}

// Edge kinds where distance===1 means "compile/run break" — kept here, not in
// MCP-tool docs, because Kotlin reads from the same table conceptually.
const DIRECT_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  'script_used_by_prefab',
  'script_used_by_scene',
  'scene_contains_prefab',
  'prefab_variant_of',
  'class_inherits_from',
  'class_implements_interface',
  'method_overrides_method',
]);

// Human-readable verb per EdgeKind. Both languages must read from this table.
const EDGE_VERBS: Record<EdgeKind, string> = {
  script_used_by_prefab: 'uses script',
  script_used_by_scene: 'uses script',
  scene_contains_prefab: 'contains prefab',
  prefab_variant_of: 'is variant of',
  serialized_binding: 'references',
  guid_resolves_to: 'resolves to',
  addressable_group_contains: 'groups',
  class_inherits_from: 'inherits',
  class_implements_interface: 'implements',
  method_overrides_method: 'overrides',
  method_calls_method: 'calls',
  class_references_class: 'references',
  script_declares_class: 'declares',
};

// Reason copy: "<other_kind> '<other_label>' <verb> '<seed_label>'".
function impactReason(
  other: GraphNode,
  seed: GraphNode,
  edge: GraphEdge,
): string {
  const verb = EDGE_VERBS[edge.kind] ?? 'is connected to';
  return `${other.kind} '${other.label}' ${verb} '${seed.label}'`;
}

export function impact(
  adj: AdjacencyIndex,
  seeds: string[],
  opts: ImpactOptions,
): ImpactResult {
  const seedSet = new Set<string>();
  for (const id of seeds) {
    if (adj.nodesById.has(id)) seedSet.add(id);
  }

  // BFS over incoming edges. Track (distance, predecessor edge, predecessor
  // id, weakOnPath) per visited node — needed for classification + reason.
  interface VisitInfo {
    distance: number;
    predEdge?: GraphEdge;
    predId?: string;
    weakOnPath: boolean;
  }
  const visited = new Map<string, VisitInfo>();
  const max = opts.maxDepth ?? Number.POSITIVE_INFINITY;

  let frontier: string[] = [];
  for (const id of seedSet) {
    visited.set(id, { distance: 0, weakOnPath: false });
    frontier.push(id);
  }

  for (let depth = 0; depth < max; depth += 1) {
    if (frontier.length === 0) break;
    const next: string[] = [];
    for (const src of frontier) {
      const incoming = adj.in.get(src) ?? [];
      const fromInfo = visited.get(src);
      const fromWeak = fromInfo?.weakOnPath ?? false;
      for (const e of incoming) {
        const other = e.source;
        if (visited.has(other)) continue;
        const weakOnPath = fromWeak || e.kind === 'serialized_binding';
        visited.set(other, {
          distance: depth + 1,
          predEdge: e,
          predId: src,
          weakOnPath,
        });
        next.push(other);
      }
    }
    frontier = next;
  }

  const impacted: ImpactedNode[] = [];
  const nodes: GraphNode[] = [];
  const edgeKeys = new Set<string>();
  const resultEdges: GraphEdge[] = [];

  // Determine which seed (by label) to use for the reason string. We choose
  // the seed that is the BFS terminus along the predecessor chain — same one
  // the distance is measured from.
  for (const [id, info] of visited) {
    const node = adj.nodesById.get(id);
    if (!node) continue;
    nodes.push(node);
    if (seedSet.has(id)) continue; // seeds themselves are not in `impacted`.

    // Walk the predecessor chain to (a) the seed for the reason, (b) collect
    // edges, (c) classify.
    let cursor = id;
    let reachedSeed: GraphNode | undefined;
    let firstHopEdge: GraphEdge | undefined;
    let firstHopOther: GraphNode | undefined;
    while (true) {
      const ci = visited.get(cursor);
      if (!ci?.predEdge || !ci.predId) {
        reachedSeed = adj.nodesById.get(cursor);
        break;
      }
      const key = `${ci.predEdge.kind}:${ci.predEdge.source}:${ci.predEdge.target}`;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        resultEdges.push(ci.predEdge);
      }
      if (firstHopEdge === undefined) {
        firstHopEdge = ci.predEdge;
        firstHopOther = adj.nodesById.get(ci.predId);
      }
      cursor = ci.predId;
    }

    let classification: ImpactClassification | undefined;
    if (opts.classify) {
      if (info.weakOnPath) {
        classification = 'weak';
      } else if (info.distance === 1 && firstHopEdge && DIRECT_EDGE_KINDS.has(firstHopEdge.kind)) {
        classification = 'direct';
      } else {
        classification = 'transitive';
      }
    }

    const reason =
      firstHopEdge && firstHopOther && reachedSeed
        ? impactReason(node, firstHopOther, firstHopEdge)
        : reachedSeed
          ? `${node.kind} '${node.label}' reaches '${reachedSeed.label}'`
          : `${node.kind} '${node.label}'`;

    const entry: ImpactedNode = {
      id,
      distance: info.distance,
      reason,
    };
    if (classification) entry.classification = classification;
    impacted.push(entry);
  }

  // Sort: distance asc, id lex asc — required for Kotlin byte-equivalence.
  impacted.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return { nodes, edges: resultEdges, impacted };
}

// ---------------------------------------------------------------------------
// context — single node + 1-hop neighbors with endpoints inlined.
// ---------------------------------------------------------------------------

export interface ContextOptions {
  maxNeighbors: number;
}

export interface ContextResult {
  node: GraphNode;
  incoming: EdgeWithEndpoint[];
  outgoing: EdgeWithEndpoint[];
  truncated: boolean;
}

export function context(
  adj: AdjacencyIndex,
  nodeId: string,
  opts: ContextOptions,
): ContextResult | undefined {
  const node = adj.nodesById.get(nodeId);
  if (!node) return undefined;

  const incomingEdges = adj.in.get(nodeId) ?? [];
  const outgoingEdges = adj.out.get(nodeId) ?? [];

  let truncated = false;
  const incoming: EdgeWithEndpoint[] = [];
  for (const e of incomingEdges) {
    if (incoming.length >= opts.maxNeighbors) {
      truncated = true;
      break;
    }
    const other = adj.nodesById.get(e.source);
    if (!other) continue;
    incoming.push({ edge: e, other });
  }
  const outgoing: EdgeWithEndpoint[] = [];
  for (const e of outgoingEdges) {
    if (outgoing.length >= opts.maxNeighbors) {
      truncated = true;
      break;
    }
    const other = adj.nodesById.get(e.target);
    if (!other) continue;
    outgoing.push({ edge: e, other });
  }
  return { node, incoming, outgoing, truncated };
}
