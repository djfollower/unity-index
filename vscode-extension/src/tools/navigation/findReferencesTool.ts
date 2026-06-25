import * as vscode from "vscode";
import { AbstractMcpTool, fromPosition, toPosition } from "../abstractTool";
import { TOOL_NAMES, PARAM_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext, resolveFilePath, toRelativePath } from "../../server/projectResolver";
import { Args, clamp, optionalInt, requireString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import { executeReferences } from "../../utils/lspBridge";
import { FindUsagesResult, UsageLocation } from "../../models/toolModels";

export class FindReferencesTool extends AbstractMcpTool {
  readonly name = TOOL_NAMES.FIND_REFERENCES;
  readonly description =
    "Find all references to a symbol across the project. Use when you need to know where a method, class, field, or variable is used. " +
    "Returns file/line/column locations with context snippets. " +
    "Target: file + line + column (position-based lookup). Example: {\"file\": \"Assets/Scripts/PlayerController.cs\", \"line\": 15, \"column\": 10}. " +
    "Note: if every usage looks like AddListener(X) / RegisterCallback(X) / += X (or the Remove/-= counterparts), the method is an event handler — its real call sites are wherever the event is dispatched. Find the event's declaration and run ide_find_references on it, or ide_search_text on the event name. For Unity Inspector-wired UnityEvents, use unity_get_unity_event_bindings.";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .file(true)
    .lineAndColumn(true)
    .intProperty(PARAM_NAMES.MAX_RESULTS, "Max results to return. Default 500.")
    .intProperty(
      PARAM_NAMES.CONTEXT_LINES,
      "How many surrounding source lines to include per usage. Default 1 (the hit line only); max 10. Bigger = larger response; use when you need to see the enclosing scope without a follow-up read.",
    )
    .build();

  protected async doExecute(
    project: ProjectContext,
    args: Args,
  ): Promise<ToolCallResult> {
    const file = requireString(args, PARAM_NAMES.FILE);
    const line = optionalInt(args, PARAM_NAMES.LINE);
    const column = optionalInt(args, PARAM_NAMES.COLUMN);
    if (line === undefined || column === undefined) {
      return this.error("Missing line or column");
    }
    const maxResults = optionalInt(args, PARAM_NAMES.MAX_RESULTS) ?? 500;
    const contextLines = clamp(
      optionalInt(args, PARAM_NAMES.CONTEXT_LINES) ?? 1,
      1,
      10,
    );

    const uri = vscode.Uri.file(resolveFilePath(project, file));
    const locations = await executeReferences(uri, toPosition(line, column));

    const truncated = locations.length > maxResults;
    const slice = truncated ? locations.slice(0, maxResults) : locations;

    const usages: UsageLocation[] = [];
    for (const loc of slice) {
      const doc = await safeOpen(loc.uri);
      const startLine = loc.range.start.line;
      const context = doc
        ? extractContext(doc, startLine, contextLines)
        : "";
      usages.push({
        file: toRelativePath(project, loc.uri.fsPath),
        line: startLine + 1,
        column: loc.range.start.character + 1,
        context,
        type: "REFERENCE",
        astPath: [],
      });
    }

    const result: FindUsagesResult = {
      usages,
      totalCount: locations.length,
      truncated,
      hint: handlerRegistrationHint(usages) ?? undefined,
    };
    return this.json(result);
  }
}

/**
 * If most non-declaration usages look like event-handler registrations
 * (AddListener / RegisterCallback / += / Subscribe), nudge the caller to chase
 * the event's dispatch sites — otherwise the result looks "complete" with N
 * direct hits and the agent stops, missing the indirect call chain.
 *
 * Heuristic: ≥2 non-declaration usages and ≥50% of them match a registration
 * pattern. Conservative on purpose; we'd rather miss a hint than mislead.
 */
const HANDLER_PATTERNS = [
  /\.AddListener\s*\(/,
  /\.RemoveListener\s*\(/,
  /\.RegisterCallback\s*\(/,
  /\.UnregisterCallback\s*\(/,
  /\bSubscribe\s*\(/,
  /\bUnsubscribe\s*\(/,
  // C# event subscription: `something += MethodName` and `-=`.
  /[+\-]=\s*[A-Za-z_]/,
];

function handlerRegistrationHint(usages: UsageLocation[]): string | null {
  const nonDecl = usages.filter((u) => !/DECLARATION$/.test(u.type));
  if (nonDecl.length < 2) return null;
  let hits = 0;
  for (const u of nonDecl) {
    if (HANDLER_PATTERNS.some((re) => re.test(u.context))) hits++;
  }
  if (hits * 2 < nonDecl.length) return null;
  return (
    "Every usage looks like an event-handler registration (AddListener / RegisterCallback / += / Subscribe). " +
    "The method is invoked indirectly via the event it subscribes to — to find its real call sites, locate the event declaration " +
    "(usually the field passed to AddListener) and run ide_find_references on that event, or ide_search_text on its name. " +
    "For Unity Inspector-wired UnityEvents, also try unity_get_unity_event_bindings."
  );
}

async function safeOpen(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch {
    return undefined;
  }
}

/**
 * One line by default (preserves 0.4.0 wire shape) or a centered window when
 * the caller opts into more. The hit line is the middle of the window; we
 * clip to file bounds rather than padding so the result stays cheap to scan.
 */
function extractContext(
  doc: vscode.TextDocument,
  hitLine: number,
  contextLines: number,
): string {
  if (contextLines <= 1) return doc.lineAt(hitLine).text.trim();
  const radius = Math.floor((contextLines - 1) / 2);
  const start = Math.max(0, hitLine - radius);
  const end = Math.min(doc.lineCount - 1, hitLine + (contextLines - 1 - radius));
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    out.push(`${i + 1}: ${doc.lineAt(i).text}`);
  }
  return out.join("\n");
}
