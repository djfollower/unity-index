import * as vscode from "vscode";
import { AbstractMcpTool, symbolKindName, toPosition } from "../abstractTool";
import { TOOL_NAMES, PARAM_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext, resolveFilePath, toRelativePath } from "../../server/projectResolver";
import { Args, optionalInt, requireString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import { executeImplementation } from "../../utils/lspBridge";
import { ImplementationLocation, ImplementationResult } from "../../models/toolModels";

export class FindImplementationsTool extends AbstractMcpTool {
  readonly name = TOOL_NAMES.FIND_IMPLEMENTATIONS;
  readonly description =
    "Find all implementations of an interface or abstract method (Find Implementations). " +
    "Returns the locations of concrete implementations. " +
    "Target: file + line + column (position-based lookup).";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .file(true)
    .lineAndColumn(true)
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

    const uri = vscode.Uri.file(resolveFilePath(project, file));
    const locations = await executeImplementation(uri, toPosition(line, column));

    const implementations: ImplementationLocation[] = [];
    for (const loc of locations) {
      const doc = await safeOpen(loc.uri);
      const lineText = doc?.lineAt(loc.range.start.line).text.trim() ?? "";
      const name = doc?.getText(loc.range).trim() || lineText.slice(0, 80);
      implementations.push({
        name: name || "(impl)",
        file: toRelativePath(project, loc.uri.fsPath),
        line: loc.range.start.line + 1,
        column: loc.range.start.character + 1,
        kind: symbolKindName(vscode.SymbolKind.Method),
      });
    }

    const result: ImplementationResult = {
      implementations,
      totalCount: implementations.length,
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
