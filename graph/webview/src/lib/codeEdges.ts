// Day 8.5 — webview side of the lazy code-edge expansion.
//
// The webview never renders C# code edges on initial load — Day 4 already
// proved that even ~10k asset nodes need careful budgeting, and pulling the
// C# class graph for every script up front would blow that budget by an
// order of magnitude. Instead the user expands one node at a time and the
// bridge hands back just that symbol's neighbourhood.
//
// The wire shape mirrors `docs/graph-mcp-tools.md` §3.6. We only set
// `symbol_ids` and `include_targets` from the webview — `edge_kinds`
// defaults to all five and is good enough for the menu-driven flow.

import type Graph from 'graphology';
import {
  CODE_EDGES_GRAPH_TYPE,
  request,
  type CodeEdgesRequest,
  type CodeEdgesResponse,
  type HostBridge,
} from '@unity-index/graph-core';

// 20s ceiling: the same MonoBehaviour-heavy hubs that cap
// CLASS_REFERENCES_HIT_LIMIT at 5000 in the Kotlin tool can still take a
// few seconds on cold start when Roslyn / RD warm their caches. Tighter
// than the snapshot's 30s because an interactive click that hangs for half
// a minute is a worse UX than a refused expansion.
const CODE_EDGES_TIMEOUT_MS = 20_000;

export async function fetchCodeEdges(
  bridge: HostBridge,
  symbolId: string,
): Promise<CodeEdgesResponse> {
  const req: CodeEdgesRequest = {
    project_path: '',
    symbol_ids: [symbolId],
    include_targets: true,
  };
  return request<CodeEdgesRequest, CodeEdgesResponse>(
    bridge,
    CODE_EDGES_GRAPH_TYPE,
    req,
    { timeoutMs: CODE_EDGES_TIMEOUT_MS },
  );
}

/** Resolve the `unity://csharp/T:...` anchor id for `nodeId`. Returns
 *  undefined when the node isn't a code-domain anchor and the menu action
 *  should be hidden. We don't read `metadata` off the graphology node
 *  because `snapshotToGraph.ts` doesn't copy that field today; instead we
 *  use the graph topology directly (class nodes carry the id, script nodes
 *  point at it via `script_declares_class`). */
export function anchorIdFor(graph: Graph, nodeId: string): string | undefined {
  if (!graph.hasNode(nodeId)) return undefined;
  const attrs = graph.getNodeAttributes(nodeId) as Record<string, unknown>;
  const kind = typeof attrs.kind === 'string' ? attrs.kind : '';
  if (kind === 'class' || kind === 'interface' || kind === 'struct' || kind === 'enum') {
    return nodeId.startsWith('unity://csharp/') ? nodeId : undefined;
  }
  if (kind === 'script') {
    let found: string | undefined;
    graph.forEachOutboundEdge(nodeId, (_edge, edgeAttrs, _src, target) => {
      if (found !== undefined) return;
      if ((edgeAttrs as { kind?: string }).kind === 'script_declares_class') {
        if (typeof target === 'string' && target.startsWith('unity://csharp/')) {
          found = target;
        }
      }
    });
    return found;
  }
  return undefined;
}
