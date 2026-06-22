import { AbstractMcpTool } from "../abstractTool";
import { TOOL_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext } from "../../server/projectResolver";
import { Args, requireString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import { UnityAssetIndex } from "../../utils/unityAssetIndex";

export class GetUnityEventBindingsTool extends AbstractMcpTool {
  protected readonly requiresLsp = false;

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
  ): Promise<ToolCallResult> {
    const methodName = requireString(args, "methodName");
    const index = new UnityAssetIndex(project);
    return this.json(index.findEventBindings(methodName));
  }
}
