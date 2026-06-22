import * as vscode from "vscode";
import { AbstractMcpTool, symbolKindName } from "../abstractTool";
import { TOOL_NAMES, PARAM_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext, toRelativePath } from "../../server/projectResolver";
import { Args, optionalInt, requireString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import { executeWorkspaceSymbols } from "../../utils/lspBridge";
import { FindSymbolResult, SymbolMatch } from "../../models/toolModels";

export class FindSymbolTool extends AbstractMcpTool {
  readonly name = TOOL_NAMES.FIND_SYMBOL;
  readonly description =
    "Find symbols (classes, methods, fields, etc.) by name across the project. Uses VS Code's workspace symbol search. " +
    "Returns file/line/column locations with kind info.";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .stringProperty(PARAM_NAMES.QUERY, "Symbol name fragment to search for.", true)
    .intProperty(PARAM_NAMES.LIMIT, "Max symbols to return. Default 100.")
    .build();

  protected async doExecute(
    project: ProjectContext,
    args: Args,
  ): Promise<ToolCallResult> {
    const query = requireString(args, PARAM_NAMES.QUERY);
    const limit = optionalInt(args, PARAM_NAMES.LIMIT) ?? 100;

    const all = await executeWorkspaceSymbols(query);
    const filtered = all.filter((s) =>
      s.location.uri.fsPath.startsWith(project.rootPath),
    );
    const slice = filtered.slice(0, limit);
    const symbols: SymbolMatch[] = slice.map((s) => toSymbolMatch(s, project));

    const result: FindSymbolResult = {
      symbols,
      totalCount: filtered.length,
      query,
    };
    return this.json(result);
  }
}

export function toSymbolMatch(
  s: vscode.SymbolInformation,
  project: ProjectContext,
): SymbolMatch {
  return {
    name: s.name,
    qualifiedName: s.containerName ? `${s.containerName}.${s.name}` : s.name,
    kind: symbolKindName(s.kind),
    file: toRelativePath(project, s.location.uri.fsPath),
    line: s.location.range.start.line + 1,
    column: s.location.range.start.character + 1,
    containerName: s.containerName || null,
  };
}
