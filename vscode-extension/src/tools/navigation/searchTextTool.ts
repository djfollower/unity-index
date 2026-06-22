import * as vscode from "vscode";
import { AbstractMcpTool } from "../abstractTool";
import { TOOL_NAMES, PARAM_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext, toRelativeUri } from "../../server/projectResolver";
import {
  Args,
  optionalBoolean,
  optionalInt,
  optionalString,
  requireString,
} from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import { SearchTextResult, TextMatch } from "../../models/toolModels";

const DEFAULT_LIMIT = 200;
const EXCLUDE_GLOB = "**/{node_modules,Library,Temp,obj,bin,.git}/**";

export class SearchTextTool extends AbstractMcpTool {
  // Plain-text search doesn't need C# LSP.
  protected readonly requiresLsp = false;

  readonly name = TOOL_NAMES.SEARCH_TEXT;
  readonly description =
    "Plain-text search across project files. Use only when a semantic search (find_references, find_symbol) isn't applicable — e.g. matching strings inside comments or asset metadata.";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .stringProperty(PARAM_NAMES.QUERY, "Text or regex pattern to search for.", true)
    .booleanProperty(PARAM_NAMES.REGEX, "Treat query as a regex. Default false.")
    .booleanProperty(PARAM_NAMES.CASE_SENSITIVE, "Case-sensitive match. Default false.")
    .stringProperty(PARAM_NAMES.FILE_PATTERN, "Glob restricting files (e.g. '**/*.cs').")
    .intProperty(PARAM_NAMES.LIMIT, `Max matches. Default ${DEFAULT_LIMIT}.`)
    .build();

  protected async doExecute(
    project: ProjectContext,
    args: Args,
  ): Promise<ToolCallResult> {
    const query = requireString(args, PARAM_NAMES.QUERY);
    const isRegex = optionalBoolean(args, PARAM_NAMES.REGEX) ?? false;
    const caseSensitive = optionalBoolean(args, PARAM_NAMES.CASE_SENSITIVE) ?? false;
    const filePattern = optionalString(args, PARAM_NAMES.FILE_PATTERN);
    const limit = optionalInt(args, PARAM_NAMES.LIMIT) ?? DEFAULT_LIMIT;

    const re = buildRegex(query, isRegex, caseSensitive);
    if (!re) return this.error("Invalid regex");

    const include = new vscode.RelativePattern(
      project.rootUri,
      filePattern && filePattern.length > 0 ? filePattern : "**/*",
    );
    const uris = await vscode.workspace.findFiles(include, EXCLUDE_GLOB, 5000);

    const matches: TextMatch[] = [];
    for (const uri of uris) {
      if (matches.length >= limit) break;
      let doc: vscode.TextDocument;
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch {
        continue;
      }
      for (let i = 0; i < doc.lineCount && matches.length < limit; i++) {
        const lineText = doc.lineAt(i).text;
        re.lastIndex = 0;
        const m = re.exec(lineText);
        if (!m) continue;
        matches.push({
          file: toRelativeUri(project, uri),
          line: i + 1,
          column: m.index + 1,
          context: lineText.trim(),
          contextType: "CODE",
        });
      }
    }

    const result: SearchTextResult = {
      matches,
      totalCount: matches.length,
      query,
    };
    return this.json(result);
  }
}

function buildRegex(
  pattern: string,
  isRegex: boolean,
  caseSensitive: boolean,
): RegExp | null {
  const flags = caseSensitive ? "g" : "gi";
  const source = isRegex ? pattern : escapeRegex(pattern);
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
