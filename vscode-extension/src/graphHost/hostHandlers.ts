// Dispatch table for bridge requests coming from the webview. Each branch
// handles one `type` string and returns the response payload (or throws).
//
// Day 1 only implements the hello round-trip — proves the bridge end-to-end
// before any real data flows. Day 3 adds `unity_graph_snapshot`, calling the
// same in-process builder the MCP tool path uses (no HTTP hop).
//
// The wire strings ('unity_graph_hello' etc.) MUST stay in sync with
// graph/core/src/messages.ts — drift will surface as a webview timeout.
// Types are imported (type-only) from graph-core; constants are inlined
// because graph-core ships ESM and this extension is CJS.

import type {
  CodeEdgesRequest,
  CodeEdgesResponse,
  DiagnosticsBatchRequest,
  DiagnosticsBatchResponse,
  FilterState,
  FindUsagesRequest,
  FindUsagesResponse,
  GetFilterStateResponse,
  HelloGraphRequest,
  HelloGraphResponse,
  OpenFileRequest,
  OpenFileResponse,
  RevealInExplorerRequest,
  RevealInExplorerResponse,
  SetFilterStateRequest,
  SetFilterStateResponse,
  SnapshotRequest,
  SnapshotResponse,
} from "@unity-index/graph-core";
import * as path from "path";
import * as vscode from "vscode";
import { resolveFilePath, resolveProject } from "../server/projectResolver";
import { UnityAssetIndexManager } from "../utils/unityAssetIndexManager";
import { buildAssetGraph } from "../utils/unityAssetGraphBuilder";
import { harvestCodeEdges } from "../tools/unity/unityGraphCodeEdgesTool";
import { harvestDiagnostics } from "../tools/unity/unityGraphDiagnosticsTool";
import { materializeClassAnchors } from "@unity-index/graph-core";

const HELLO_GRAPH_TYPE = "unity_graph_hello"; // mirror of graph/core HELLO_GRAPH_TYPE
const SNAPSHOT_GRAPH_TYPE = "unity_graph_snapshot"; // mirror of graph/core SNAPSHOT_GRAPH_TYPE
// Day 4 click-through action types — mirrors of graph/core OPEN_FILE_TYPE etc.
const OPEN_FILE_TYPE = "unity_graph_open_file";
const FIND_USAGES_TYPE = "unity_graph_find_usages";
const REVEAL_IN_EXPLORER_TYPE = "unity_graph_reveal_in_explorer";
// Day 5 filter persistence — mirrors of graph/core GET/SET_FILTER_STATE_TYPE.
const GET_FILTER_STATE_TYPE = "unity_graph_get_filter_state";
const SET_FILTER_STATE_TYPE = "unity_graph_set_filter_state";
// Day 8.5 — lazy code-edge expansion. Mirror of graph/core CODE_EDGES_GRAPH_TYPE.
const CODE_EDGES_TYPE = "unity_graph_code_edges";
// Day 10 — diagnostics overlay (badges + heatmap + errors-only filter).
// Mirror of graph/core DIAGNOSTICS_GRAPH_TYPE.
const DIAGNOSTICS_TYPE = "unity_graph_diagnostics";

// workspaceState key. Scoped per-workspace so each Unity project keeps its
// own filter view (matches the "persists per workspace" Day 5 requirement).
const FILTER_STATE_STORAGE_KEY = "unityIndex.graph.filterState";

export interface HostHandlerContext {
  /**
   * Returns the live UnityAssetIndexManager owned by the MCP server, or
   * `undefined` if the server isn't running. Lazy so the panel can outlive
   * a stop/start cycle.
   */
  getAssetIndex: () => UnityAssetIndexManager | undefined;
  /**
   * VS Code's per-workspace key/value store. Holds the Day 5 filter state.
   * Passed in (not imported) so unit tests can stub it.
   */
  workspaceState: vscode.Memento;
}

export async function dispatchRequest(
  type: string,
  payload: unknown,
  ctx: HostHandlerContext,
): Promise<unknown> {
  switch (type) {
    case HELLO_GRAPH_TYPE: {
      const req = (payload ?? {}) as Partial<HelloGraphRequest>;
      const name = typeof req.name === "string" ? req.name : "webview";
      const res: HelloGraphResponse = {
        greeting: `hello, ${name}`,
        host: "vscode",
      };
      return res;
    }
    case SNAPSHOT_GRAPH_TYPE: {
      return handleSnapshot(payload, ctx);
    }
    case OPEN_FILE_TYPE: {
      return handleOpenFile(payload);
    }
    case FIND_USAGES_TYPE: {
      return handleFindUsages(payload);
    }
    case REVEAL_IN_EXPLORER_TYPE: {
      return handleRevealInExplorer(payload);
    }
    case GET_FILTER_STATE_TYPE: {
      return handleGetFilterState(ctx);
    }
    case SET_FILTER_STATE_TYPE: {
      return handleSetFilterState(payload, ctx);
    }
    case CODE_EDGES_TYPE: {
      return handleCodeEdges(payload);
    }
    case DIAGNOSTICS_TYPE: {
      return handleDiagnostics(payload);
    }
    default:
      throw new Error(`unity_graph: unknown request type '${type}'`);
  }
}

// ---------------------------------------------------------------------------
// Day 5 — filter state persistence
// ---------------------------------------------------------------------------
//
// Storage shape mirrors `FilterState` from graph-core. We validate on both
// read and write so a malformed value (corrupt globalState, hand-edited
// settings.json, schema bump) defaults back to "nothing hidden, no search"
// rather than crashing the panel.
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function coerceDomain(raw: unknown): FilterState["domain"] {
  return raw === "assets" || raw === "code" || raw === "combined" ? raw : "combined";
}

function coerceFilterState(raw: unknown): FilterState {
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    const hiddenKinds = isStringArray(r.hiddenKinds) ? r.hiddenKinds : [];
    const search = typeof r.search === "string" ? r.search : "";
    const domain = coerceDomain(r.domain);
    return { hiddenKinds, search, domain };
  }
  return { hiddenKinds: [], search: "", domain: "combined" };
}

function handleGetFilterState(ctx: HostHandlerContext): GetFilterStateResponse {
  const raw = ctx.workspaceState.get<unknown>(FILTER_STATE_STORAGE_KEY);
  return { state: coerceFilterState(raw) };
}

async function handleSetFilterState(
  payload: unknown,
  ctx: HostHandlerContext,
): Promise<SetFilterStateResponse> {
  const req = (payload ?? {}) as Partial<SetFilterStateRequest>;
  const state = coerceFilterState(req.state);
  await ctx.workspaceState.update(FILTER_STATE_STORAGE_KEY, state);
  return { saved: true };
}

/** Day 8.5 — lazy code-edge expansion from the webview. Routes through the
 *  same in-process harvester the MCP tool uses (no HTTP hop). Project
 *  resolution mirrors handleSnapshot so the webview doesn't have to know
 *  which workspace folder is bound. */
async function handleCodeEdges(payload: unknown): Promise<CodeEdgesResponse> {
  const req = (payload ?? {}) as Partial<CodeEdgesRequest>;
  const projectPath = typeof req.project_path === "string" ? req.project_path : undefined;
  const resolved = resolveProject(projectPath);
  if (resolved.errorResult || !resolved.project) {
    const text = resolved.errorResult?.content?.[0]?.text ?? "unknown_project_error";
    throw new Error(text);
  }
  const request: CodeEdgesRequest = {
    ...req,
    project_path: resolved.project.rootPath,
    symbol_ids: Array.isArray(req.symbol_ids) ? req.symbol_ids : [],
  };
  return harvestCodeEdges(resolved.project.rootPath, request);
}

/** Day 10 — diagnostics overlay from the webview. Same in-process
 *  harvester as the MCP tool path, so badges / heatmap / errors-only
 *  filter share the same source. */
async function handleDiagnostics(payload: unknown): Promise<DiagnosticsBatchResponse> {
  const req = (payload ?? {}) as Partial<DiagnosticsBatchRequest>;
  const projectPath = typeof req.project_path === "string" ? req.project_path : undefined;
  const resolved = resolveProject(projectPath);
  if (resolved.errorResult || !resolved.project) {
    const text = resolved.errorResult?.content?.[0]?.text ?? "unknown_project_error";
    throw new Error(text);
  }
  const request: DiagnosticsBatchRequest = {
    ...req,
    project_path: resolved.project.rootPath,
    node_ids: Array.isArray(req.node_ids) ? req.node_ids : [],
  };
  return harvestDiagnostics(resolved.project.rootPath, request);
}

async function handleSnapshot(
  payload: unknown,
  ctx: HostHandlerContext,
): Promise<SnapshotResponse> {
  const assetIndex = ctx.getAssetIndex();
  if (!assetIndex) {
    // MCP server not started yet. AutoStart usually covers this; surface a
    // stable string the webview can translate into a "start server" CTA.
    throw new Error("server_not_started");
  }

  const req = (payload ?? {}) as Partial<SnapshotRequest>;
  const projectPath = typeof req.project_path === "string" ? req.project_path : undefined;
  const resolved = resolveProject(projectPath);
  if (resolved.errorResult || !resolved.project) {
    // Translate the resolver's ToolCallResult shape into a thrown Error whose
    // message is the JSON the webview can parse for the `error` key. Day 3's
    // webview (App.svelte error state) renders the raw message; the two
    // stable error keys (`no_project_open`, `multiple_projects_open`) get
    // friendlier copy there.
    const text = resolved.errorResult?.content?.[0]?.text ?? "unknown_project_error";
    throw new Error(text);
  }

  const index = await assetIndex.get(resolved.project);
  // buildAssetGraph already returns a fully-shaped SnapshotResponse
  // (generated_at, stats, warnings, etc.) — same call the MCP tool makes.
  const request: SnapshotRequest = {
    ...req,
    project_path: resolved.project.rootPath,
  };
  const response = await buildAssetGraph(resolved.project.rootPath, index, request);
  // Day 8.4 — mirror the projection UnityGraphSnapshotTool.applyClassAnchors
  // does on the MCP tool path. The bridge skips that wrapper, so without
  // this the webview's `include_class_anchors: true` is silently ignored,
  // csharp anchors never materialize, snapshotToGraph drops the
  // `script_declares_class` edges as dangling, and `anchorIdFor` can't
  // resolve a code anchor → "Expand code edges" disappears from the menu.
  if (request.include_class_anchors) {
    const result = materializeClassAnchors(response.snapshot, {
      warnings: response.warnings,
    });
    if (result.anchorsAdded > 0) {
      return {
        ...response,
        snapshot: result.snapshot,
        warnings: result.warnings,
      };
    }
  }
  return response;
}

// ---------------------------------------------------------------------------
// Day 4 — click-through actions
// ---------------------------------------------------------------------------
//
// Resolves a webview-supplied path against the bound workspace folder. Stable
// error strings (`no_project_open`, `path_outside_project`, `file_not_found`)
// mirror the graph-core wire docstring so the webview can render friendly
// copy. The project resolver is called WITHOUT a project_path arg — these
// actions don't carry one since the panel is bound to the active workspace.
function resolveOpenable(rawPath: string): { absPath: string; uri: vscode.Uri } {
  const resolved = resolveProject(undefined);
  if (resolved.errorResult || !resolved.project) {
    throw new Error("no_project_open");
  }
  const absPath = resolveFilePath(resolved.project, rawPath);
  // Reject paths that escape the workspace root. `path.relative` returning a
  // leading '..' is the canonical "outside" check for cross-platform paths.
  const rel = path.relative(resolved.project.rootPath, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path_outside_project");
  }
  return { absPath, uri: vscode.Uri.file(absPath) };
}

async function handleOpenFile(payload: unknown): Promise<OpenFileResponse> {
  const req = (payload ?? {}) as Partial<OpenFileRequest>;
  if (typeof req.path !== "string" || req.path.length === 0) {
    throw new Error("file_not_found");
  }
  const { uri } = resolveOpenable(req.path);
  const options: vscode.TextDocumentShowOptions = { preview: false };
  if (typeof req.line === "number" && req.line > 0) {
    // 1-based wire → 0-based vscode.Position. Column defaults to 1.
    const line = Math.max(0, req.line - 1);
    const col = typeof req.column === "number" && req.column > 0 ? req.column - 1 : 0;
    const pos = new vscode.Position(line, col);
    options.selection = new vscode.Range(pos, pos);
  }
  try {
    await vscode.window.showTextDocument(uri, options);
  } catch (e) {
    // showTextDocument throws ENOENT-shaped errors when the file is missing;
    // also covers binary files where the user might prefer revealInExplorer.
    // We surface a stable string so the webview can prompt for that instead.
    throw new Error("file_not_found");
  }
  return { opened: true };
}

async function handleFindUsages(payload: unknown): Promise<FindUsagesResponse> {
  const req = (payload ?? {}) as Partial<FindUsagesRequest>;
  if (typeof req.path !== "string" || req.path.length === 0) {
    throw new Error("file_not_found");
  }
  // Reuse the open-file path resolution + navigation. Find Usages is the
  // native references panel triggered against whatever symbol the caret lands
  // on — so positioning the caret first matters.
  await handleOpenFile({
    path: req.path,
    ...(typeof req.line === "number" ? { line: req.line } : {}),
    ...(typeof req.column === "number" ? { column: req.column } : {}),
  });
  // Built-in command id; surfaces the references peek view. The plan
  // (Day 4) explicitly delegates to the IDE's native UI rather than
  // re-implementing FindReferencesTool's flow inside the webview.
  try {
    await vscode.commands.executeCommand("editor.action.referenceSearch.trigger");
  } catch {
    // Non-fatal — the file is already open, the user can run Find Usages
    // themselves. We don't throw so the user still sees the file land.
  }
  return { invoked: true };
}

async function handleRevealInExplorer(
  payload: unknown,
): Promise<RevealInExplorerResponse> {
  const req = (payload ?? {}) as Partial<RevealInExplorerRequest>;
  if (typeof req.path !== "string" || req.path.length === 0) {
    throw new Error("file_not_found");
  }
  const { uri } = resolveOpenable(req.path);
  // `revealFileInOS` opens the host OS file manager (Finder / Explorer /
  // Files) — matches the menu's "Reveal in explorer" wording across platforms.
  // The alternate `revealInExplorer` would only focus the VS Code Explorer
  // panel, which is rarely what users want from a graph node action.
  await vscode.commands.executeCommand("revealFileInOS", uri);
  return { revealed: true };
}
