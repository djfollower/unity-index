import * as vscode from "vscode";
import * as path from "path";
import { AbstractMcpTool } from "../abstractTool";
import { TOOL_NAMES, PARAM_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext, toRelativeUri } from "../../server/projectResolver";
import { Args, optionalInt, optionalString, requireString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import { FileMatch, FindFileResult } from "../../models/toolModels";

export class FindFileTool extends AbstractMcpTool {
  // Pure FS — doesn't need C# LSP.
  protected readonly requiresLsp = false;

  readonly name = TOOL_NAMES.FIND_FILE;
  readonly description =
    "Find files in the project by name or glob pattern. Use to locate scripts, prefabs, scenes, assets.";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .stringProperty(PARAM_NAMES.QUERY, "Filename pattern or glob. Plain text matches anywhere in the path.", true)
    .stringProperty(PARAM_NAMES.FILE_PATTERN, "Optional glob to restrict search (e.g. '**/*.cs').")
    .intProperty(PARAM_NAMES.LIMIT, "Max results. Default 100.")
    .build();

  protected async doExecute(
    project: ProjectContext,
    args: Args,
  ): Promise<ToolCallResult> {
    const query = requireString(args, PARAM_NAMES.QUERY);
    const limit = optionalInt(args, PARAM_NAMES.LIMIT) ?? 100;
    const filePattern = optionalString(args, PARAM_NAMES.FILE_PATTERN);

    const glob = filePattern && filePattern.length > 0
      ? filePattern
      : query.includes("*") || query.includes("?")
        ? query
        : `**/*${query}*`;

    const include = new vscode.RelativePattern(project.rootUri, glob);
    const uris = await vscode.workspace.findFiles(
      include,
      "**/{node_modules,Library,Temp,obj,bin}/**",
      limit + 1,
    );

    const matches: FileMatch[] = uris.slice(0, limit).map((uri) => {
      const rel = toRelativeUri(project, uri);
      return {
        name: path.basename(rel),
        path: rel,
        directory: path.dirname(rel),
      };
    });

    const result: FindFileResult = {
      files: matches,
      totalCount: uris.length,
      query,
    };
    return this.json(result);
  }
}
