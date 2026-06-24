import * as vscode from "vscode";
import { AbstractMcpTool, fromPosition, toPosition } from "../abstractTool";
import { TOOL_NAMES, PARAM_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext, resolveFilePath, toRelativePath } from "../../server/projectResolver";
import { Args, optionalInt, requireString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import { executeReferences } from "../../utils/lspBridge";
import { FindUsagesResult, UsageLocation } from "../../models/toolModels";

export class FindReferencesTool extends AbstractMcpTool {
  readonly name = TOOL_NAMES.FIND_REFERENCES;
  readonly description =
    "Find all references to a symbol across the project. Use when you need to know where a method, class, field, or variable is used. " +
    "Returns file/line/column locations with context snippets. " +
    "Target: file + line + column (position-based lookup). Example: {\"file\": \"Assets/Scripts/PlayerController.cs\", \"line\": 15, \"column\": 10}";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .file(true)
    .lineAndColumn(true)
    .intProperty(PARAM_NAMES.MAX_RESULTS, "Max results to return. Default 500.")
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

    const uri = vscode.Uri.file(resolveFilePath(project, file));
    const locations = await executeReferences(uri, toPosition(line, column));

    const truncated = locations.length > maxResults;
    const slice = truncated ? locations.slice(0, maxResults) : locations;

    const usages: UsageLocation[] = [];
    for (const loc of slice) {
      const doc = await safeOpen(loc.uri);
      const startLine = loc.range.start.line;
      const context = doc?.lineAt(startLine).text.trim() ?? "";
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
    };
    return this.json(result);
  }
}

async function safeOpen(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch {
    return undefined;
  }
}
