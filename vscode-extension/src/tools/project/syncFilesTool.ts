import * as vscode from "vscode";
import { AbstractMcpTool } from "../abstractTool";
import { TOOL_NAMES, PARAM_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext, resolveFilePath } from "../../server/projectResolver";
import { Args, optionalString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import { SyncFilesResult } from "../../models/toolModels";

export class SyncFilesTool extends AbstractMcpTool {
  protected readonly requiresLsp = false;

  readonly name = TOOL_NAMES.SYNC_FILES;
  readonly description =
    "Refresh VS Code's view of the file system after external changes. Optionally restrict to a single path.";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .stringProperty(PARAM_NAMES.PATH, "Optional path to refresh. Default = whole project.")
    .build();

  protected async doExecute(
    project: ProjectContext,
    args: Args,
  ): Promise<ToolCallResult> {
    const path = optionalString(args, PARAM_NAMES.PATH);
    const synced: string[] = [];

    if (path) {
      const absolute = resolveFilePath(project, path);
      const uri = vscode.Uri.file(absolute);
      try {
        await vscode.workspace.fs.stat(uri);
        synced.push(path);
      } catch {
        return this.error(`Path not found: ${path}`);
      }
    } else {
      synced.push(project.rootPath);
    }

    // VS Code's FS layer auto-refreshes via its file watcher; we trigger a noop
    // openTextDocument cycle to nudge the language server.
    try {
      await vscode.commands.executeCommand("dotnet.reloadProject");
    } catch {
      /* command may not be present until C# Dev Kit is active */
    }

    const result: SyncFilesResult = {
      syncedPaths: synced,
      syncedAll: !path,
      message: "File system refresh requested.",
    };
    return this.json(result);
  }
}
