import * as vscode from "vscode";
import { AbstractMcpTool } from "../abstractTool";
import { TOOL_NAMES, PARAM_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext, resolveFilePath } from "../../server/projectResolver";
import { Args, optionalInt, requireString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import { ReadFileResult } from "../../models/toolModels";

export class ReadFileTool extends AbstractMcpTool {
  protected readonly requiresLsp = false;

  readonly name = TOOL_NAMES.READ_FILE;
  readonly description =
    "Read a project file. Optionally restrict to a line range. Use sparingly — semantic tools are usually faster than reading raw content.";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .file(true)
    .intProperty("startLine", "First line to include (1-based, inclusive).")
    .intProperty("endLine", "Last line to include (1-based, inclusive).")
    .build();

  protected async doExecute(
    project: ProjectContext,
    args: Args,
  ): Promise<ToolCallResult> {
    const file = requireString(args, PARAM_NAMES.FILE);
    const startLine = optionalInt(args, "startLine");
    const endLine = optionalInt(args, "endLine");

    const uri = vscode.Uri.file(resolveFilePath(project, file));
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch (e) {
      return this.error(`File not found: ${file}`);
    }

    let content: string;
    let s: number | null = null;
    let e: number | null = null;
    if (startLine !== undefined || endLine !== undefined) {
      s = Math.max(1, startLine ?? 1);
      e = Math.min(doc.lineCount, endLine ?? doc.lineCount);
      const range = new vscode.Range(
        s - 1,
        0,
        e - 1,
        doc.lineAt(e - 1).text.length,
      );
      content = doc.getText(range);
    } else {
      content = doc.getText();
    }

    const result: ReadFileResult = {
      file,
      content,
      language: doc.languageId || null,
      lineCount: doc.lineCount,
      startLine: s,
      endLine: e,
      isLibraryFile: false,
    };
    return this.json(result);
  }
}
