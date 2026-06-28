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
// ---------------------------------------------------------------------------

export const GET_FILTER_STATE_TYPE = 'unity_graph_get_filter_state' as const;
export const SET_FILTER_STATE_TYPE = 'unity_graph_set_filter_state' as const;

export interface FilterState {
  hiddenKinds: string[];
  search: string;
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
