import { AbstractMcpTool, ToolContext } from "../abstractTool";
import { TOOL_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext } from "../../server/projectResolver";
import { Args, requireString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";

export class GetUnityEventBindingsTool extends AbstractMcpTool {
  protected readonly requiresLsp = false;
  readonly isHeavyScan = true;

  readonly name = TOOL_NAMES.GET_UNITY_EVENT_BINDINGS;
  readonly description =
    "Find UnityEvent bindings (Button.onClick, custom events, etc.) that call a specific method. " +
    "These bindings live in prefab/scene YAML as m_PersistentCalls — invisible to code-only analysis.";
  readonly inputSchema = SchemaBuilder.tool()
    .stringProperty("methodName", "The method name to search for in UnityEvent persistent call bindings", true)
    .projectPath()
    .build();

  protected async doExecute(
    project: ProjectContext,
    args: Args,
    ctx: ToolContext,
  ): Promise<ToolCallResult> {
    const methodName = requireString(args, "methodName");
    const index = await ctx.assetIndex.get(project);
    return this.json(await index.findEventBindings(methodName, ctx.signal));
  }
}
