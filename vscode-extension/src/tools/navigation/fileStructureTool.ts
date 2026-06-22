import * as vscode from "vscode";
import { AbstractMcpTool, symbolKindName } from "../abstractTool";
import { TOOL_NAMES, PARAM_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext, resolveFilePath } from "../../server/projectResolver";
import { Args, requireString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import { executeDocumentSymbols } from "../../utils/lspBridge";
import { FileStructureItem, FileStructureResult } from "../../models/toolModels";

export class FileStructureTool extends AbstractMcpTool {
  readonly name = TOOL_NAMES.FILE_STRUCTURE;
  readonly description =
    "Return the structural outline of a file (classes, methods, fields). Mirrors the VS Code Outline view.";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .file(true)
    .build();

  protected async doExecute(
    project: ProjectContext,
    args: Args,
  ): Promise<ToolCallResult> {
    const file = requireString(args, PARAM_NAMES.FILE);
    const uri = vscode.Uri.file(resolveFilePath(project, file));
    const doc = await vscode.workspace.openTextDocument(uri);
    const symbols = await executeDocumentSymbols(uri);

    const items = symbols.map((s) => toItem(s));
    const result: FileStructureResult = {
      file: file,
      language: doc.languageId || null,
      items,
    };
    return this.json(result);
  }
}

function toItem(
  s: vscode.DocumentSymbol | vscode.SymbolInformation,
): FileStructureItem {
  const range = "children" in s ? s.range : s.location.range;
  const selection = "children" in s ? s.selectionRange : s.location.range;
  const item: FileStructureItem = {
    name: s.name,
    kind: symbolKindName(s.kind),
    line: selection.start.line + 1,
    column: selection.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
  if ("detail" in s && s.detail) item.detail = s.detail;
  if ("children" in s && s.children.length > 0) {
    item.children = s.children.map(toItem);
  }
  return item;
}
