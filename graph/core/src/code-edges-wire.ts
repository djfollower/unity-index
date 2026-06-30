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

/** Day 9.3 — transitive-subtypes preset cap. Real MonoBehaviour graphs in
 *  Unity codebases run 200–800 subclasses; 2000 leaves headroom for the
 *  long tail (Object, Component) without letting a worst-case BFS DoS the
 *  webview. Hosts enforce this in addition to `subtypes_max_depth`. */
export const CODE_EDGES_MAX_SUBTYPES = 2000;

/** Default depth limit for transitive subtype walks. Picked empirically:
 *  even deep MonoBehaviour hierarchies in Unity asset stores rarely exceed
 *  6 levels; 8 gives 2× margin and stays well clear of pathological
 *  inheritance chains. */
export const CODE_EDGES_DEFAULT_SUBTYPES_MAX_DEPTH = 8;

export interface CodeEdgesRequest extends BaseRequest {
  /** 1..CODE_EDGES_MAX_SYMBOLS `unity://csharp/...` IDs. Hosts reject the
   *  request with `invalid_id` if any entry is empty or missing the
   *  `unity://csharp/` prefix. Stale-but-well-formed IDs are returned in
   *  `unresolved_ids` rather than erroring (partial success).
   *
   *  Optional when `subtypes_of` is set (the preset mode supplies its own
   *  root). Required otherwise. */
  symbol_ids?: string[];
  /** Filter — only return edges of these kinds. Omit / empty for all. */
  edge_kinds?: CodeEdgeKind[];
  /** When false, the response contains edges only and `snapshot.nodes` is
   *  empty. Use when the caller already has the target nodes locally and
   *  wants to skip the wire cost of re-sending them. Default: true. */
  include_targets?: boolean;
  /** Day 9.3 — transitive-subtypes preset. When set to a
   *  `unity://csharp/T:Ns.Type` id, the host walks the type-hierarchy
   *  provider's subtypes recursively from that root and returns
   *  `class_inherits_from` (or `class_implements_interface`, when the root
   *  is an interface) edges from every subclass back toward the root. Use
   *  this to power "show all MonoBehaviour subclasses" presets without
   *  asking the user to expand each node manually.
   *
   *  When `subtypes_of` is set:
   *   - `symbol_ids` is treated as additional seed symbols (may be empty).
   *   - the walk is capped at `subtypes_max_depth` levels and
   *     `CODE_EDGES_MAX_SUBTYPES` nodes, whichever fires first. Truncation
   *     is surfaced via the standard `warnings` envelope.
   *   - `edge_kinds` still applies; passing `[class_references_class]`
   *     would simply return nothing.
   */
  subtypes_of?: string;
  /** Day 9.3 — depth cap for `subtypes_of`. Defaults to
   *  `CODE_EDGES_DEFAULT_SUBTYPES_MAX_DEPTH`. Hosts clamp to a sane upper
   *  bound (currently 16) so a malicious client can't force an unbounded
   *  walk. */
  subtypes_max_depth?: number;
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
