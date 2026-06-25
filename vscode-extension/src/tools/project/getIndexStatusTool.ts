import { AbstractMcpTool } from "../abstractTool";
import { TOOL_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext } from "../../server/projectResolver";
import { Args } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import { ToolContext } from "../abstractTool";
import { IndexStatusResult } from "../../models/toolModels";

export class GetIndexStatusTool extends AbstractMcpTool {
  // Whole point of this tool is to report status before LSP is ready.
  protected readonly requiresLsp = false;

  readonly name = TOOL_NAMES.INDEX_STATUS;
  readonly description =
    "Report whether C# Dev Kit / Roslyn LSP has finished loading the solution. " +
    "Call this if other navigation tools return empty / stale results — they may be waiting on indexing.";
  readonly inputSchema = SchemaBuilder.tool().projectPath().build();

  protected async doExecute(
    project: ProjectContext,
    _args: Args,
    ctx: ToolContext,
  ): Promise<ToolCallResult> {
    const ready = ctx.readiness.isReady();
    const result: IndexStatusResult = {
      isDumbMode: !ready,
      isIndexing: !ready,
      indexingProgress: null,
      unityAssets: ctx.assetIndex.status(project),
    };
    return this.json(result);
  }
}
