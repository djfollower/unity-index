// Day 11 Task 6: assemble the full v1 export document from the live
// webview state. Serializes the current graphology graph (not just the
// last snapshot response) so any code-edge expansions or delta updates
// the user has performed since load are captured.
//
// Coordinates + Sigma display data intentionally stay OUT. The snapshot
// wire shape has no position field; layouts are re-derived on import.
// Saved views carry camera + positions separately for the ones that
// truly need it.

import type Graph from 'graphology';
import {
  createExportEnvelope,
  type ExportDocument,
  type ExportProducer,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
  type SavedView,
  type SnapshotResponse,
} from '@unity-index/graph-core';

export interface AssembleArgs {
  /** Response from the last full snapshot fetch. Used for `generated_at`,
   *  `source_phase`, `stats`, and as a fallback when the live graph is
   *  empty (e.g. everything hidden by filter). */
  lastSnapshot: SnapshotResponse;
  /** Live graphology graph — this is what actually reflects the user's
   *  session (initial snapshot + deltas + code-edge expansions). */
  liveGraph: Graph;
  /** Saved views to embed. Usually the current `savedViewsStore.views`
   *  array — but callers may filter it (e.g. to only export the active
   *  view for a smaller file). */
  savedViews: SavedView[];
  producer: ExportProducer;
  producerVersion: string;
  sourceProject?: string;
  sourceProjectPath?: string;
  note?: string;
}

/** Walks the live graph back into the wire `GraphSnapshot` shape. We only
 *  read attributes the snapshot schema defines; Sigma-only fields like
 *  `x` / `y` / `color` are dropped. */
function graphToSnapshot(graph: Graph, base: GraphSnapshot): GraphSnapshot {
  const nodes: GraphNode[] = [];
  graph.forEachNode((id, attrs) => {
    const kind = attrs.kind;
    if (typeof kind !== 'string') return; // defensive: skip non-schema nodes
    const node: GraphNode = {
      id,
      kind: kind as GraphNode['kind'],
      label: typeof attrs.label === 'string' ? attrs.label : id,
      metadata: (attrs.metadata as Record<string, unknown>) ?? {},
    };
    if (typeof attrs.path === 'string') node.path = attrs.path;
    if (typeof attrs.guid === 'string') node.guid = attrs.guid;
    if (attrs.location && typeof attrs.location === 'object') {
      const loc = attrs.location as { line?: unknown; column?: unknown };
      if (typeof loc.line === 'number') {
        node.location = { line: loc.line };
        if (typeof loc.column === 'number') node.location.column = loc.column;
      }
    }
    nodes.push(node);
  });

  const edges: GraphEdge[] = [];
  graph.forEachEdge((_edge, attrs, source, target) => {
    const kind = attrs.kind;
    if (typeof kind !== 'string') return;
    edges.push({
      source,
      target,
      kind: kind as GraphEdge['kind'],
      metadata: (attrs.metadata as Record<string, unknown>) ?? {},
    });
  });

  return {
    nodes,
    edges,
    generated_at: base.generated_at,
    source_phase: base.source_phase,
    stats: {
      node_count: nodes.length,
      edge_count: edges.length,
      // The live graph doesn't track sub-file kinds separately; carry the
      // base stats through so import sees a plausible pre-projection view.
      skipped_component_instances: base.stats.skipped_component_instances,
      skipped_component_fields: base.stats.skipped_component_fields,
    },
  };
}

export function assembleExportDocument(args: AssembleArgs): ExportDocument {
  const snapshot = graphToSnapshot(args.liveGraph, args.lastSnapshot.snapshot);
  const doc = createExportEnvelope({
    snapshot,
    producer: args.producer,
    producerVersion: args.producerVersion,
    ...(args.sourceProject !== undefined ? { sourceProject: args.sourceProject } : {}),
    ...(args.sourceProjectPath !== undefined
      ? { sourceProjectPath: args.sourceProjectPath }
      : {}),
    ...(args.note !== undefined ? { note: args.note } : {}),
  });
  if (args.savedViews.length > 0) doc.savedViews = args.savedViews;
  return doc;
}
