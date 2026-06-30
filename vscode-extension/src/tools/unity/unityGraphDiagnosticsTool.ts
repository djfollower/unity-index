import * as vscode from "vscode";
import * as path from "path";
import type {
  DiagnosticMessage,
  DiagnosticSeverity,
  DiagnosticsBatchRequest,
  DiagnosticsBatchResponse,
  MaxDiagnosticSeverity,
  NodeDiagnostics,
} from "@unity-index/graph-core";
import {
  DIAGNOSTICS_DEFAULT_MAX_MESSAGES,
  DIAGNOSTICS_MAX_MESSAGES_PER_NODE,
  DIAGNOSTICS_MAX_NODES,
} from "@unity-index/graph-core";
import { AbstractMcpTool, ToolContext } from "../abstractTool";
import { TOOL_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext } from "../../server/projectResolver";
import { Args } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import { executeWorkspaceSymbols } from "../../utils/lspBridge";

const CSHARP_PREFIX = "unity://csharp/";
const SCRIPT_PREFIX = "unity://script/";

const TYPE_SYMBOL_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
]);
const METHOD_SYMBOL_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Constructor,
]);

/**
 * Day 10 — diagnostics overlay feed for the graph webview. TS mirror of
 * Rider's UnityGraphDiagnosticsTool — wire shape is byte-for-byte
 * identical (see graph/core/src/diagnostics-wire.ts).
 *
 * Batches per-node diagnostic counts (errors / warnings / infos), a
 * pre-computed `max_severity`, and an optional small list of
 * `top_messages`. Powers badges, the heatmap, and the "errors-only"
 * filter from a single response.
 *
 * Data source: `vscode.languages.getDiagnostics()` — the same store the
 * Problems panel reads from. Roslyn LSP pushes diagnostics into this
 * store as files are analysed, so the lookup is O(diagnostics in the
 * workspace) without triggering any fresh analysis per node.
 */
export class UnityGraphDiagnosticsTool extends AbstractMcpTool {
  // Diagnostics are populated by the LSP into VS Code's diagnostic store.
  // We don't strictly need readiness — but waiting for the LSP avoids the
  // race where the first overlay refresh runs before Roslyn has reported
  // anything and shows every node as clean.
  protected readonly requiresLsp = true;

  readonly name = TOOL_NAMES.UNITY_GRAPH_DIAGNOSTICS;
  readonly description =
    `Batch diagnostics lookup for the graph overlay. Given 1..${DIAGNOSTICS_MAX_NODES} graph node IDs, returns per-node counts (errors, warnings, infos), the max severity, and (when include_messages is not false) a small top_messages list. ` +
    "Accepts unity://script/<path>, unity://csharp/T:Ns.Type, and unity://csharp/M:Ns.Type.Method(...) IDs (methods resolve to their enclosing file). " +
    "Diagnostics source: VS Code's stored diagnostics from C# Dev Kit / Roslyn LSP — the same items shown in the Problems panel. " +
    "Drop back to ide_diagnostics for fresh per-file analysis.";

  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .property(
      "node_ids",
      {
        type: "array",
        description: `1..${DIAGNOSTICS_MAX_NODES} graph node IDs (e.g. 'unity://script/Assets/Scripts/Player.cs', 'unity://csharp/T:Foo.Bar').`,
        items: { type: "string" },
      },
      true,
    )
    .booleanProperty(
      "include_messages",
      "Default true. When false, top_messages is omitted (counts-only).",
    )
    .property("max_messages_per_node", {
      type: "integer",
      description: `Cap on top_messages.length per node. Default ${DIAGNOSTICS_DEFAULT_MAX_MESSAGES}, clamped to ${DIAGNOSTICS_MAX_MESSAGES_PER_NODE}.`,
    })
    .stringProperty(
      "request_id",
      "Optional; echoed back on the response for client correlation.",
    )
    .build();

  protected async doExecute(
    project: ProjectContext,
    args: Args,
    _ctx: ToolContext,
  ): Promise<ToolCallResult> {
    const request = args as unknown as DiagnosticsBatchRequest;
    const validation = validateDiagnosticsBatchRequest(request);
    if (validation) return this.structuredError(validation);
    const response = await harvestDiagnostics(project.rootPath, request);
    return this.json(response);
  }
}

/**
 * Shared harvest pipeline. The webview bridge handler calls this
 * directly so the click-driven overlay refresh path doesn't have to drag
 * in the AbstractMcpTool / ToolContext machinery — same shape as
 * `harvestCodeEdges` in unityGraphCodeEdgesTool.ts. Validation errors
 * throw `Error("invalid_id: ...")` (or `invalid_arguments: ...`) so the
 * bridge surfaces a stable string to the webview.
 */
export async function harvestDiagnostics(
  rootPath: string,
  request: DiagnosticsBatchRequest,
): Promise<DiagnosticsBatchResponse> {
  const validation = validateDiagnosticsBatchRequest(request);
  if (validation) {
    const e = validation.error;
    throw new Error(`${e.kind}: ${e.detail}`);
  }
  const includeMessages = request.include_messages !== false;
  const maxMessages = clampMaxMessages(request.max_messages_per_node);

  // Build a path→diagnostics index once (workspace-scoped). vscode's
  // getDiagnostics() returns the entire store; we narrow to the project
  // root so unrelated workspace folders don't pollute hub-file counts.
  const projectRootCanonical = canonicalPath(rootPath);
  const byPath = new Map<string, vscode.Diagnostic[]>();
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    const fsPath = canonicalPath(uri.fsPath);
    if (!fsPath.startsWith(projectRootCanonical)) continue;
    byPath.set(fsPath, [...diags]);
  }

  const diagnostics: NodeDiagnostics[] = [];
  const unresolved: string[] = [];
  for (const rawId of request.node_ids) {
    const absPath = await resolveNodeIdToAbsolutePath(rawId, rootPath);
    if (!absPath) {
      unresolved.push(rawId);
      continue;
    }
    const msgs = byPath.get(canonicalPath(absPath)) ?? [];
    diagnostics.push(aggregate(rootPath, rawId, msgs, includeMessages, maxMessages));
  }

  const response: DiagnosticsBatchResponse = {
    generated_at: new Date().toISOString(),
    diagnostics,
  };
  if (unresolved.length > 0) response.unresolved_ids = unresolved;
  if (request.request_id !== undefined) response.request_id = request.request_id;
  return response;
}

function validateDiagnosticsBatchRequest(
  request: DiagnosticsBatchRequest,
):
  | {
      error: { kind: "invalid_id" | "invalid_arguments"; detail: string };
    }
  | undefined {
  if (!Array.isArray(request.node_ids) || request.node_ids.length === 0) {
    return {
      error: {
        kind: "invalid_id",
        detail: "node_ids must contain at least one entry",
      },
    };
  }
  if (request.node_ids.length > DIAGNOSTICS_MAX_NODES) {
    return {
      error: {
        kind: "invalid_arguments",
        detail: `node_ids has ${request.node_ids.length} entries, max ${DIAGNOSTICS_MAX_NODES}`,
      },
    };
  }
  return undefined;
}

function clampMaxMessages(raw: number | undefined): number {
  const v = raw ?? DIAGNOSTICS_DEFAULT_MAX_MESSAGES;
  if (Number.isNaN(v)) return DIAGNOSTICS_DEFAULT_MAX_MESSAGES;
  return Math.max(1, Math.min(DIAGNOSTICS_MAX_MESSAGES_PER_NODE, Math.floor(v)));
}

/** Canonicalise a path for cross-platform comparison. We can't use
 *  `fs.realpathSync` here because the file may have been deleted between
 *  the build and the overlay refresh; `path.normalize` is good enough for
 *  the diagnostics-store key (Roslyn LSP keys by URI fsPath, which is
 *  already normalised). */
function canonicalPath(p: string): string {
  return path.normalize(p);
}

/** Map a node id to the absolute path of its declaring file, or
 *  undefined when the id is unparseable / unresolvable. Mirrors the
 *  Kotlin resolveNodeIdToAbsolutePath. */
async function resolveNodeIdToAbsolutePath(
  rawId: string,
  rootPath: string,
): Promise<string | undefined> {
  const id = rawId.trim();
  if (id.length === 0) return undefined;
  if (id.startsWith(SCRIPT_PREFIX)) {
    const rel = id.slice(SCRIPT_PREFIX.length);
    if (rel.length === 0) return undefined;
    return path.isAbsolute(rel) ? rel : path.join(rootPath, rel);
  }
  if (id.startsWith(CSHARP_PREFIX)) {
    const docId = id.slice(CSHARP_PREFIX.length);
    if (docId.length < 3 || docId[1] !== ":") return undefined;
    const kind = docId[0];
    const body = docId.slice(2);
    if (kind !== "T" && kind !== "M") return undefined;
    // Strip arg list for M:; we resolve via the enclosing type either way.
    const nameNoArgs = body.split("(")[0];
    const fqn = kind === "M" ? nameNoArgs.split(".").slice(0, -1).join(".") : nameNoArgs;
    if (!fqn) return undefined;
    const simple = fqn.split(".").pop()!;
    const candidates = await executeWorkspaceSymbols(simple);
    const scored = candidates
      .filter((s) => TYPE_SYMBOL_KINDS.has(s.kind) || METHOD_SYMBOL_KINDS.has(s.kind))
      .filter((s) => s.name === simple || s.name.startsWith(simple))
      .filter((s) => TYPE_SYMBOL_KINDS.has(s.kind))
      .filter((s) => s.location.uri.fsPath.startsWith(rootPath))
      .sort((a, b) => {
        // Prefer FQN match — score by container suffix match.
        const wantContainer = fqn.includes(".") ? fqn.slice(0, fqn.lastIndexOf(".")) : "";
        const ac = (a.containerName ?? "").replace(/`\d+/g, "");
        const bc = (b.containerName ?? "").replace(/`\d+/g, "");
        const aMatch = wantContainer && (ac === wantContainer || wantContainer.endsWith(ac)) ? 1 : 0;
        const bMatch = wantContainer && (bc === wantContainer || wantContainer.endsWith(bc)) ? 1 : 0;
        return bMatch - aMatch;
      });
    const top = scored[0];
    if (!top) return undefined;
    return top.location.uri.fsPath;
  }
  return undefined;
}

function aggregate(
  rootPath: string,
  nodeId: string,
  diags: vscode.Diagnostic[],
  includeMessages: boolean,
  maxMessages: number,
): NodeDiagnostics {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  const typed: Array<[DiagnosticSeverity, vscode.Diagnostic]> = [];
  for (const d of diags) {
    const sev = severityOf(d.severity);
    if (!sev) continue;
    if (sev === "error") errors++;
    else if (sev === "warning") warnings++;
    else infos++;
    typed.push([sev, d]);
  }
  let maxSeverity: MaxDiagnosticSeverity;
  if (errors > 0) maxSeverity = "error";
  else if (warnings > 0) maxSeverity = "warning";
  else if (infos > 0) maxSeverity = "info";
  else maxSeverity = "none";

  void rootPath; // reserved for future relative-path attribution
  const out: NodeDiagnostics = {
    node_id: nodeId,
    errors,
    warnings,
    infos,
    max_severity: maxSeverity,
  };
  if (includeMessages) {
    out.top_messages = typed
      .sort((a, b) => severityRank(a[0]) - severityRank(b[0]))
      .slice(0, maxMessages)
      .map<DiagnosticMessage>(([sev, d]) => {
        const msg: DiagnosticMessage = {
          severity: sev,
          message: d.message,
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
        };
        return msg;
      });
  }
  return out;
}

function severityOf(s: vscode.DiagnosticSeverity): DiagnosticSeverity | undefined {
  switch (s) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    case vscode.DiagnosticSeverity.Hint:
      // Hints are surfaced separately by VS Code (squigglies vs. underlines)
      // and would inflate "infos" with low-signal items like "remove
      // unused using"; we drop them from the overlay.
      return undefined;
    default:
      return undefined;
  }
}

function severityRank(s: DiagnosticSeverity): number {
  switch (s) {
    case "error":
      return 0;
    case "warning":
      return 1;
    case "info":
      return 2;
  }
}
