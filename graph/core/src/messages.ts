// Typed message payloads carried over the host-bridge envelope. Keep one
// `<NAME>_TYPE` string constant per message so both sides reference the same
// literal — drift is caught at compile time on the TS side and at runtime in
// the host's dispatch table (Kotlin / TS host).
//
// Day 1 only defines the hello round-trip. Day 2+ add snapshot / impact /
// context / open-file / etc.

// ---------------------------------------------------------------------------
// hello — Day 1 round-trip probe. Webview sends a name, host echoes a
// greeting. Used to prove the bridge end-to-end before any real data flows.
// ---------------------------------------------------------------------------

export const HELLO_GRAPH_TYPE = 'unity_graph_hello' as const;

export interface HelloGraphRequest {
  name: string;
}

export interface HelloGraphResponse {
  greeting: string;
  host: 'vscode' | 'rider';
}

// ---------------------------------------------------------------------------
// snapshot — Day 3 wires the webview to the existing `unity_graph_snapshot`
// MCP tool through the in-process host bridge. The wire string MUST match
// ToolNames.UNITY_GRAPH_SNAPSHOT (Kotlin) and TOOL_NAMES.UNITY_GRAPH_SNAPSHOT
// (TS) so the same identifier flows through the bridge and HTTP paths.
// Request/response payload types live in ./snapshot-wire.ts and are
// re-exported from ./index.ts for webview ergonomics.
// ---------------------------------------------------------------------------

export const SNAPSHOT_GRAPH_TYPE = 'unity_graph_snapshot' as const;

// ---------------------------------------------------------------------------
// Day 7 — incremental snapshot updates. Sent over the bridge by the webview
// after it has cached a full snapshot and remembered its `revision`. The wire
// string MUST match ToolNames.UNITY_GRAPH_SNAPSHOT_DELTA (Kotlin) and
// TOOL_NAMES.UNITY_GRAPH_SNAPSHOT_DELTA (TS). Payload shapes live in
// ./snapshot-delta-wire.ts.
// ---------------------------------------------------------------------------

export const SNAPSHOT_DELTA_GRAPH_TYPE = 'unity_graph_snapshot_delta' as const;

// ---------------------------------------------------------------------------
// Day 6 — neighbors / impact / context. The webview does not call these over
// the bridge today (it traverses the in-memory Graphology graph locally — see
// graph-day6-tasks.md Task 7). The constants live here so Day 11 (saved
// views) and Day 12 (query DSL) can route through the bridge without
// re-declaring the wire strings. The string values MUST match
// ToolNames.UNITY_GRAPH_* (Kotlin) and TOOL_NAMES.UNITY_GRAPH_* (TS).
// ---------------------------------------------------------------------------

export const NEIGHBORS_GRAPH_TYPE = 'unity_graph_neighbors' as const;
export const IMPACT_GRAPH_TYPE = 'unity_graph_impact' as const;
export const CONTEXT_GRAPH_TYPE = 'unity_graph_context' as const;

// ---------------------------------------------------------------------------
// Day 8 — batch C# semantic edges. The webview calls this after the user
// expands a class/script node so we can lazily pull inheritance / call /
// reference edges without paying for them on initial load. The wire string
// MUST match ToolNames.UNITY_GRAPH_CODE_EDGES (Kotlin) and
// TOOL_NAMES.UNITY_GRAPH_CODE_EDGES (TS). Payload shapes live in
// ./code-edges-wire.ts.
// ---------------------------------------------------------------------------

export const CODE_EDGES_GRAPH_TYPE = 'unity_graph_code_edges' as const;

// ---------------------------------------------------------------------------
// Day 10 — diagnostics overlay. The webview calls this on a fast cadence
// for the currently visible node set (badges + heatmap + errors-only
// filter all share the same response). The wire string MUST match
// ToolNames.UNITY_GRAPH_DIAGNOSTICS (Kotlin) and
// TOOL_NAMES.UNITY_GRAPH_DIAGNOSTICS (TS). Payload shapes live in
// ./diagnostics-wire.ts.
// ---------------------------------------------------------------------------

export const DIAGNOSTICS_GRAPH_TYPE = 'unity_graph_diagnostics' as const;

// ---------------------------------------------------------------------------
// Day 4 click-through actions. Each one is fired by the webview in response
// to a user gesture (double-click, right-click → menu item) and routed to the
// host through the same bridge envelope as `hello` / `snapshot`. Responses
// carry no useful payload — success is the IDE doing something visible to the
// user; failures throw `Error(message)` which the bridge turns into an
// `error: { message }` envelope the webview surfaces in its status bar.
//
// Stable error strings (so the webview can decide on copy/CTA):
//   - 'file_not_found'        — the path didn't resolve under the project
//   - 'path_outside_project'  — path resolved but is outside the workspace
//   - 'no_project_open'       — bridge invoked before a project is bound
//   - 'unsupported_kind'      — node kind has no useful action here
// ---------------------------------------------------------------------------

export const OPEN_FILE_TYPE = 'unity_graph_open_file' as const;

export interface OpenFileRequest {
  /** Project-relative or absolute path. Resolution mirrors `project_path`
   *  handling in ProjectResolver — absolute paths are taken as-is, relative
   *  paths are joined to the resolved project root. */
  path: string;
  /** 1-based line number. Omit to open at the top of the file. */
  line?: number;
  /** 1-based column. Ignored when `line` is omitted. */
  column?: number;
}

export interface OpenFileResponse {
  opened: true;
}

export const FIND_USAGES_TYPE = 'unity_graph_find_usages' as const;

export interface FindUsagesRequest {
  /** Graph node ID (so the host can log which node triggered the call). */
  node_id: string;
  /** Path of the declaring file — required so we can navigate before invoking
   *  the IDE's native Find Usages action against the symbol at the caret. */
  path: string;
  /** 1-based caret position. The host opens the file at this position then
   *  triggers the native references panel. When omitted, the host opens at
   *  the top of the file (Find Usages will still work for the first symbol
   *  found there — useful for single-class scripts). */
  line?: number;
  column?: number;
}

export interface FindUsagesResponse {
  invoked: true;
}

export const REVEAL_IN_EXPLORER_TYPE = 'unity_graph_reveal_in_explorer' as const;

export interface RevealInExplorerRequest {
  /** Path to reveal in the OS file manager (Finder / Explorer / Files). */
  path: string;
}

export interface RevealInExplorerResponse {
  revealed: true;
}

// ---------------------------------------------------------------------------
// Day 5 filter state. The webview owns the canonical filter UI; the host is
// just durable storage scoped to the active workspace / project. Round-trip:
//   1. webview boots → calls `get_filter_state` once after snapshot is ready
//   2. user toggles a kind / types in the search bar → store change
//   3. store change → debounced `set_filter_state` (no response payload used)
//
// `hiddenKinds` carries NodeKind strings. We type it as `string[]` on the
// wire so a future host version that knows about new kinds can persist them
// without forcing a lockstep webview bump; the webview validates and drops
// unknown entries on hydrate (see filterStore).
//
// `search` is a free-text fuzzy query. Persisted so reopening the panel
// restores the last view. Empty string = no active search.
//
// Day 9 — `domain` adds a three-way assets/code/combined toggle. It composes
// with `hiddenKinds` (both must allow a kind for a node to render); the
// toggle is the bulk macro, the per-kind checkboxes are the fine grain.
// Persisted on the wire as a string so older hosts that round-trip the field
// untouched still work; the webview coerces unknown values to "combined".
// ---------------------------------------------------------------------------

export const GET_FILTER_STATE_TYPE = 'unity_graph_get_filter_state' as const;
export const SET_FILTER_STATE_TYPE = 'unity_graph_set_filter_state' as const;

export type FilterDomain = 'assets' | 'code' | 'combined';

export interface FilterState {
  hiddenKinds: string[];
  search: string;
  /** Day 9 — domain toggle. Older hosts may omit; webview defaults to
   *  'combined' when missing or unrecognised. */
  domain?: FilterDomain;
}

export interface GetFilterStateRequest {}

export interface GetFilterStateResponse {
  state: FilterState;
}

export interface SetFilterStateRequest {
  state: FilterState;
}

export interface SetFilterStateResponse {
  saved: true;
}

// ---------------------------------------------------------------------------
// Day 11 — saved views. The webview owns the live UI ("apply this view"); the
// host is durable per-workspace/per-project storage. Round-trip:
//   1. webview opens Views dropdown → `unity_graph_saved_views_list`
//   2. user picks Save → `unity_graph_saved_views_save({ view })`, upsert by name
//   3. user picks Delete → `unity_graph_saved_views_delete({ name })`
// "Load" is client-side: pick a `SavedView` from the list response and let the
// webview apply its filter/focus/camera state locally. The payload shape is
// `SavedView` from ./export-wire.ts — kept there so `unity_graph_export`
// serialises identical bytes without a second declaration.
// ---------------------------------------------------------------------------

export const SAVED_VIEWS_LIST_TYPE = 'unity_graph_saved_views_list' as const;
export const SAVED_VIEWS_SAVE_TYPE = 'unity_graph_saved_views_save' as const;
export const SAVED_VIEWS_DELETE_TYPE = 'unity_graph_saved_views_delete' as const;

export interface SavedViewsListRequest {}

export interface SavedViewsListResponse {
  views: import('./export-wire.js').SavedView[];
}

export interface SavedViewsSaveRequest {
  view: import('./export-wire.js').SavedView;
}

export interface SavedViewsSaveResponse {
  saved: true;
}

export interface SavedViewsDeleteRequest {
  name: string;
}

export interface SavedViewsDeleteResponse {
  deleted: boolean;
}

// ---------------------------------------------------------------------------
// Day 11 — save-file endpoint. Shared plumbing behind the PNG (Task 4), SVG
// (Task 5), and JSON (Task 6) export buttons. Content is base64 so the wire
// stays UTF-8 clean regardless of MIME. The host runs its native save dialog
// against `defaultName`, then writes `contentBase64` decoded to bytes. No
// implicit path resolution — the user's dialog choice is the path.
//
// Response reports `saved: false` when the user cancels (not an error).
// Errors (permission denied, disk full, etc.) come back as thrown Error on
// the bridge, letting the webview surface a stable message in its toaster.
// ---------------------------------------------------------------------------

export const SAVE_FILE_TYPE = 'unity_graph_save_file' as const;

export type SaveFileKind = 'png' | 'svg' | 'json';

export interface SaveFileRequest {
  /** Suggested filename (with extension) shown in the host save dialog.
   *  Callers pass e.g. `unity-graph.png`; the user may rename before saving. */
  defaultName: string;
  /** Content type. Used to pick the save-dialog filter and to sanity-check
   *  the extension the user picks (best-effort, not enforced). */
  kind: SaveFileKind;
  /** Payload, base64-encoded. Binary formats (PNG) encode raw bytes; text
   *  formats (SVG, JSON) encode UTF-8 bytes. */
  contentBase64: string;
}

export interface SaveFileResponse {
  /** True when a file was written. False when the user cancelled the
   *  dialog — that's an expected outcome, not an error. */
  saved: boolean;
  /** Absolute path of the written file. Omitted when `saved: false`. */
  path?: string;
}

// ---------------------------------------------------------------------------
// Day 11 Task 8 — offline mode. Fired by the host as an EVENT envelope
// (not a request) to hand the webview a pre-parsed ExportDocument. The
// webview enters read-only mode: live delta subscription pauses,
// click-through actions gate off, a banner names the source.
// ---------------------------------------------------------------------------

export const SNAPSHOT_LOAD_STATIC_TYPE = 'unity_graph_snapshot_load_static' as const;

export interface SnapshotLoadStaticEvent {
  document: import('./export-wire.js').ExportDocument;
}
