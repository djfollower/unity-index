// ---------------------------------------------------------------------------
// unity_graph_code_edges — see docs/graph-mcp-tools.md §3.6.
//
// Batch C# edge lookup. Day 8's load-bearing endpoint: takes N C# symbol IDs
// (`unity://csharp/T:Ns.Type`, `unity://csharp/M:Ns.Type.Method(args)`) and
// returns inheritance / call / reference edges plus, by default, the target
// nodes needed to render them. Replaces N round-trips on Phase-2 graphs.
//
// Symbol ID scheme (locked in docs/graph-schema.md §1):
//   - Code symbols  → `unity://csharp/<DocumentationCommentId>`
//       e.g. `unity://csharp/T:Foo.Bar`
//            `unity://csharp/M:Foo.Bar.Baz(System.Int32)`
//   - Script files  → `unity://script/<project-relative-path>`
//     bridged to their declared class via the existing
//     `script_declares_class` edge so the asset graph and the code graph
//     share node IDs at the file boundary.
//
// Kotlin (`UnityGraphCodeEdgesTool.kt`) and TypeScript
// (`unityGraphCodeEdgesTool.ts`) MUST keep field names byte-for-byte
// identical with the shapes below — a single MCP client config has to work
// against either host.
// ---------------------------------------------------------------------------

import type { GraphSnapshot } from './graph-types.js';
import type { BaseRequest, BaseResponse } from './snapshot-wire.js';

/** Edge kinds returned by `unity_graph_code_edges`. A strict subset of the
 *  graph-wide `EdgeKind` union — kept as its own type so callers can declare
 *  "I only want inheritance" without widening to asset edges they'll never
 *  see from this tool. Mirrors the list in graph-mcp-tools.md §3.6. */
export type CodeEdgeKind =
  | 'class_inherits_from'
  | 'class_implements_interface'
  | 'method_overrides_method'
  | 'method_calls_method'
  | 'class_references_class';

/** Subtype recorded in `metadata.call_sites[].kind` on a
 *  `method_calls_method` edge. See graph-schema.md §2 / §3. */
export type MethodCallKind = 'direct' | 'virtual' | 'interface' | 'delegate';

/** Per-call-site detail stored in `method_calls_method.metadata.call_sites`.
 *  Schema documented in graph-schema.md §3 (method_calls_method row). */
export interface MethodCallSite {
  line: number;
  kind: MethodCallKind;
}

export const CODE_EDGES_MAX_SYMBOLS = 500;

export interface CodeEdgesRequest extends BaseRequest {
  /** 1..CODE_EDGES_MAX_SYMBOLS `unity://csharp/...` IDs. Hosts reject the
   *  request with `invalid_id` if any entry is empty or missing the
   *  `unity://csharp/` prefix. Stale-but-well-formed IDs are returned in
   *  `unresolved_ids` rather than erroring (partial success). */
  symbol_ids: string[];
  /** Filter — only return edges of these kinds. Omit / empty for all. */
  edge_kinds?: CodeEdgeKind[];
  /** When false, the response contains edges only and `snapshot.nodes` is
   *  empty. Use when the caller already has the target nodes locally and
   *  wants to skip the wire cost of re-sending them. Default: true. */
  include_targets?: boolean;
}

export interface CodeEdgesResponse extends BaseResponse {
  /** Edges (always) plus target nodes (when `include_targets !== false`).
   *  `snapshot.source_phase` is `'code'`. Sub-file kinds (`component_*`,
   *  `field`) never appear here — they belong to expand-on-demand. */
  snapshot: GraphSnapshot;
  /** Symbol IDs that parsed cleanly but didn't resolve to a live symbol —
   *  e.g. renamed since the last MCP query. Empty/omitted = everything
   *  resolved. */
  unresolved_ids?: string[];
}
