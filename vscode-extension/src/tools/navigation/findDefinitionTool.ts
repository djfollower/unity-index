import * as vscode from "vscode";
import { AbstractMcpTool, toPosition } from "../abstractTool";
import { TOOL_NAMES, PARAM_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext, resolveFilePath, toRelativePath } from "../../server/projectResolver";
import { Args, clamp, optionalBoolean, optionalInt, requireString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import { executeDefinition } from "../../utils/lspBridge";
import { DefinitionResult } from "../../models/toolModels";

const DEFAULT_PREVIEW_LINES = 50;
const MAX_PREVIEW_LINES = 500;

export class FindDefinitionTool extends AbstractMcpTool {
  readonly name = TOOL_NAMES.FIND_DEFINITION;
  readonly description =
    "Navigate to where a symbol is defined (Go to Definition). Works for classes, methods, variables, using directives. " +
    "Returns the file path, line/column of the definition, a code preview, and the symbol name. " +
    "Target: file + line + column (position-based lookup). Example: {\"file\": \"Assets/Scripts/PlayerController.cs\", \"line\": 15, \"column\": 10}";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .file(true)
    .lineAndColumn(true)
    .booleanProperty(
      PARAM_NAMES.FULL_ELEMENT_PREVIEW,
      "If true, return the full element body instead of a short snippet.",
    )
    .intProperty(
      PARAM_NAMES.MAX_PREVIEW_LINES,
      `Max lines when fullElementPreview=true. Default ${DEFAULT_PREVIEW_LINES}, max ${MAX_PREVIEW_LINES}.`,
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
    const fullPreview = optionalBoolean(args, PARAM_NAMES.FULL_ELEMENT_PREVIEW) ?? false;
    const maxLines = clamp(
      optionalInt(args, PARAM_NAMES.MAX_PREVIEW_LINES) ?? DEFAULT_PREVIEW_LINES,
      1,
      MAX_PREVIEW_LINES,
    );

    const uri = vscode.Uri.file(resolveFilePath(project, file));
    const defs = await executeDefinition(uri, toPosition(line, column));
    if (defs.length === 0) {
      return this.error("Could not resolve symbol definition");
    }

    const target = defs[0];
    const doc = await vscode.workspace.openTextDocument(target.uri);
    const startLine = target.range.start.line;
    const startCol = target.range.start.character;

    let preview: string;
    if (fullPreview) {
      const endLine = Math.min(doc.lineCount - 1, startLine + maxLines - 1);
      const text = doc.getText(
        new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length),
      );
      const totalLines = endLine - startLine + 1;
      preview =
        totalLines >= maxLines
          ? `${text}\n// ... truncated (showing ${maxLines} lines)`
          : text;
    } else {
      const previewStart = Math.max(0, startLine - 2);
      const previewEnd = Math.min(doc.lineCount - 1, startLine + 2);
      const lines: string[] = [];
      for (let i = previewStart; i <= previewEnd; i++) {
        lines.push(`${i + 1}: ${doc.lineAt(i).text}`);
      }
      preview = lines.join("\n");
    }

    const symbolName = doc.getText(target.range).trim() || file.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "");

    const result: DefinitionResult = {
      file: toRelativePath(project, target.uri.fsPath),
      line: startLine + 1,
      column: startCol + 1,
      preview,
      symbolName,
      astPath: [],
    };
    return this.json(result);
  }
}
