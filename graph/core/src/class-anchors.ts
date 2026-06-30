// ---------------------------------------------------------------------------
// Day 8.4 — class-anchor materialization.
//
// The asset snapshot emits `script_declares_class` edges pointing at
// `unity://csharp/T:<ClassName>` IDs that the asset builder never realizes
// as nodes (those targets come from the C# code domain, owned by
// `unity_graph_code_edges`). That leaves the UI nothing to click on when
// the user wants to expand code edges for a script.
//
// `materializeClassAnchors` turns each dangling csharp target into a stub
// `class` node — id only, no incoming code edges yet — so Day 8.5's lazy
// expansion has a stable anchor to attach edges to. The function is pure:
// it returns a new snapshot and never mutates its inputs, which keeps the
// cached unfiltered snapshot safe to reuse across requests.
//
// The Kotlin side (`UnityAssetGraphBuilder.materializeClassAnchors`)
// implements the same algorithm; if you change one, change both — the wire
// contract is byte-identical.
// ---------------------------------------------------------------------------

import type { GraphNode, GraphSnapshot } from './graph-types.js';
import { WARNING_DANGLING_CSHARP_TARGETS, type Warning } from './snapshot-wire.js';

export interface MaterializeOptions {
  /** When provided, `dangling_csharp_targets` warnings are filtered out of
   *  this list (anchors are no longer dangling). Returns a new array — the
   *  caller's list is not mutated. */
  warnings?: Warning[];
}

export interface MaterializeResult {
  snapshot: GraphSnapshot;
  warnings?: Warning[];
  /** Number of new `class` nodes appended. */
  anchorsAdded: number;
}

/**
 * For every `script_declares_class` edge in `snapshot`, ensure a `class`
 * node exists at the target id. Existing nodes (e.g. real class nodes from
 * `unity_graph_code_edges`) are left alone. Anchor nodes carry
 * `metadata.anchor = true` so callers can distinguish them from materialized
 * code nodes.
 */
export function materializeClassAnchors(
  snapshot: GraphSnapshot,
  options: MaterializeOptions = {},
): MaterializeResult {
  const existing = new Set(snapshot.nodes.map((n) => n.id));
  const scriptsById = new Map<string, GraphNode>();
  for (const n of snapshot.nodes) {
    if (n.kind === 'script') scriptsById.set(n.id, n);
  }

  const anchors: GraphNode[] = [];
  const seen = new Set<string>();
  for (const e of snapshot.edges) {
    if (e.kind !== 'script_declares_class') continue;
    if (existing.has(e.target) || seen.has(e.target)) continue;
    seen.add(e.target);
    const script = scriptsById.get(e.source);
    // The csharp id format is `unity://csharp/T:<ClassName>`; strip the
    // prefix to get a readable label. We deliberately do not parse beyond
    // the literal prefix — the encoder owns the format.
    const PREFIX = 'unity://csharp/T:';
    const label = e.target.startsWith(PREFIX) ? e.target.slice(PREFIX.length) : e.target;
    const anchor: GraphNode = {
      id: e.target,
      kind: 'class',
      label,
      metadata: {
        anchor: true,
        declaring_script: e.source,
      },
    };
    if (script?.path !== undefined) anchor.path = script.path;
    anchors.push(anchor);
  }

  if (anchors.length === 0) {
    const r: MaterializeResult = { snapshot, anchorsAdded: 0 };
    if (options.warnings !== undefined) r.warnings = options.warnings;
    return r;
  }

  const next: GraphSnapshot = {
    ...snapshot,
    nodes: [...snapshot.nodes, ...anchors],
    stats: {
      ...snapshot.stats,
      node_count: snapshot.stats.node_count + anchors.length,
    },
  };

  const filteredWarnings = options.warnings?.filter(
    (w) => w.code !== WARNING_DANGLING_CSHARP_TARGETS,
  );
  const r: MaterializeResult = { snapshot: next, anchorsAdded: anchors.length };
  if (filteredWarnings !== undefined) r.warnings = filteredWarnings;
  return r;
}
