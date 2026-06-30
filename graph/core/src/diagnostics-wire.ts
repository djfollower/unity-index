// ---------------------------------------------------------------------------
// unity_graph_diagnostics — Day 10 overlay feed.
//
// Batch lookup: given N graph node IDs, return per-node diagnostic counts
// (errors / warnings / infos) plus optional top messages. Powers three
// webview features that all share the same underlying data:
//
//   1. node badges                       (errors > 0 → red dot + count)
//   2. heatmap mode                      (color by max_severity)
//   3. "show only nodes with errors"     (client-side filter, errors > 0)
//
// We deliberately do NOT extend `unity_graph_snapshot` with diagnostics
// fields: diagnostics tend to change far more often than the asset graph,
// and folding them into the snapshot would invalidate the Day 7 delta
// stream every keystroke. A dedicated batch tool lets the webview poll
// just the visible-node set on a much faster cadence.
//
// Symbol ID scheme (matches graph-schema.md §1):
//   - Code symbols  → `unity://csharp/T:Foo.Bar`, `unity://csharp/M:...`
//   - Script files  → `unity://script/<project-relative-path>`
// Hosts may also accept any node ID whose underlying entity is anchored to
// a file path — see the `unresolved_ids` partial-success contract below.
//
// Kotlin (`UnityGraphDiagnosticsTool.kt`) and TypeScript
// (`unityGraphDiagnosticsTool.ts`) MUST keep field names byte-for-byte
// identical with the shapes below — a single MCP client config has to
// work against either host.
// ---------------------------------------------------------------------------

import type { BaseRequest, BaseResponse } from './snapshot-wire.js';

/** Cap on `node_ids` per request. Picked to match
 *  `CODE_EDGES_MAX_SYMBOLS` so the webview can reuse the same batching
 *  policy for both tools. */
export const DIAGNOSTICS_MAX_NODES = 500;

/** Default cap on per-node `top_messages` entries when
 *  `include_messages !== false`. Three matches the typical badge tooltip
 *  budget (error + 2 warnings) without bloating the payload on hub files
 *  that easily accumulate 50+ diagnostics. */
export const DIAGNOSTICS_DEFAULT_MAX_MESSAGES = 3;

/** Hard upper bound on `max_messages_per_node`. Anything beyond this is
 *  not useful in a hover tooltip and would push response sizes into delta
 *  territory; callers that genuinely want the full list should call
 *  `ide_diagnostics` for the specific file. */
export const DIAGNOSTICS_MAX_MESSAGES_PER_NODE = 10;

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/** Aggregated max severity surfaced on every NodeDiagnostics — saves the
 *  webview from re-deriving it on every render. `'none'` means the node
 *  has zero diagnostics and is the clean-state default for the heatmap
 *  palette. */
export type MaxDiagnosticSeverity = DiagnosticSeverity | 'none';

export interface DiagnosticMessage {
  severity: DiagnosticSeverity;
  message: string;
  /** 1-based, matches `GraphNodeLocation`. Omitted when the host can't
   *  attribute the diagnostic to a specific span (rare; full-file
   *  errors). */
  line?: number;
  column?: number;
}

export interface NodeDiagnostics {
  /** Echoed from the request so the client can re-key without tracking
   *  request order. */
  node_id: string;
  errors: number;
  warnings: number;
  infos: number;
  /** Pre-computed `max(severity)` over the node's diagnostics. `'none'`
   *  when all three counts are zero. */
  max_severity: MaxDiagnosticSeverity;
  /** Present when `include_messages !== false`. Length capped at
   *  `max_messages_per_node` (default
   *  `DIAGNOSTICS_DEFAULT_MAX_MESSAGES`). Sort order is severity desc,
   *  then file order. */
  top_messages?: DiagnosticMessage[];
}

export interface DiagnosticsBatchRequest extends BaseRequest {
  /** 1..DIAGNOSTICS_MAX_NODES graph node IDs. Hosts reject with
   *  `invalid_id` if empty. Node IDs that parse cleanly but can't be
   *  mapped to a file come back in `unresolved_ids` (partial success). */
  node_ids: string[];
  /** When false, `top_messages` is omitted from every NodeDiagnostics.
   *  Use for the heatmap / badge-counts case where only the aggregate is
   *  needed — saves wire bytes on hub files with hundreds of
   *  diagnostics. Default: true. */
  include_messages?: boolean;
  /** Cap on `top_messages.length` per node. Clamped to
   *  `[1, DIAGNOSTICS_MAX_MESSAGES_PER_NODE]`; defaults to
   *  `DIAGNOSTICS_DEFAULT_MAX_MESSAGES`. Ignored when
   *  `include_messages === false`. */
  max_messages_per_node?: number;
}

export interface DiagnosticsBatchResponse extends BaseResponse {
  /** One entry per resolved node_id. Order is NOT guaranteed to match
   *  the request — callers must re-key on `node_id`. Nodes with zero
   *  diagnostics ARE included (so the webview can blank stale badges
   *  without a separate "cleared" signal). */
  diagnostics: NodeDiagnostics[];
  /** Node IDs that parsed cleanly but couldn't be mapped to a file —
   *  e.g. a stale `unity://csharp/T:Ns.Type` for a renamed class, or a
   *  sub-file kind (`method`, `field`) the host can't resolve to its
   *  declaring file. Empty/omitted = everything resolved. */
  unresolved_ids?: string[];
}
