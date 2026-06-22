import * as vscode from "vscode";
import { AbstractMcpTool } from "../abstractTool";
import { TOOL_NAMES, PARAM_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext } from "../../server/projectResolver";
import { Args, optionalInt, requireString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import { executeWorkspaceSymbols } from "../../utils/lspBridge";
import { FindClassResult } from "../../models/toolModels";
import { toSymbolMatch } from "./findSymbolTool";

const CLASS_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
]);

export class FindClassTool extends AbstractMcpTool {
  readonly name = TOOL_NAMES.FIND_CLASS;
  readonly description =
    "Find a class, struct, interface, or enum by name (Go to Type).";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .stringProperty(PARAM_NAMES.CLASS_NAME, "Class name (or fragment) to search for.", true)
    .intProperty(PARAM_NAMES.LIMIT, "Max results. Default 50.")
    .build();

  protected async doExecute(
    project: ProjectContext,
    args: Args,
  ): Promise<ToolCallResult> {
    const className = requireString(args, PARAM_NAMES.CLASS_NAME);
    const limit = optionalInt(args, PARAM_NAMES.LIMIT) ?? 50;

    const all = await executeWorkspaceSymbols(className);
    const filtered = all.filter(
      (s) =>
        CLASS_KINDS.has(s.kind) &&
        s.location.uri.fsPath.startsWith(project.rootPath),
    );
    const slice = filtered.slice(0, limit);

    const result: FindClassResult = {
      classes: slice.map((s) => toSymbolMatch(s, project)),
      totalCount: filtered.length,
      query: className,
    };
    return this.json(result);
  }
}
