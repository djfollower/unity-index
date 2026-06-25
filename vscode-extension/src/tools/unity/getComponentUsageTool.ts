import { AbstractMcpTool, ToolContext } from "../abstractTool";
import { TOOL_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext } from "../../server/projectResolver";
import { Args, requireString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";

export class GetComponentUsageTool extends AbstractMcpTool {
  protected readonly requiresLsp = false;
  readonly isHeavyScan = true;

  readonly name = TOOL_NAMES.GET_COMPONENT_USAGE;
  readonly description =
    "Find where a Unity MonoBehaviour or ScriptableObject is attached in scenes (.unity) and prefabs (.prefab). " +
    "These references are serialized in YAML asset files, not in C# code, so they're invisible to find_references.";
  readonly inputSchema = SchemaBuilder.tool()
    .stringProperty("typeName", "The C# class name of the MonoBehaviour or ScriptableObject", true)
    .projectPath()
    .build();

  protected async doExecute(
    project: ProjectContext,
    args: Args,
    ctx: ToolContext,
  ): Promise<ToolCallResult> {
    const typeName = requireString(args, "typeName");
    const index = await ctx.assetIndex.get(project);
    const result = await index.findComponentUsages(typeName, ctx.signal);
    if (result.scriptGuid === null) {
      return this.error(
        `No .cs script file found matching type name '${typeName}'. ` +
          "Ensure the file is named " + typeName + ".cs and has a .meta file.",
      );
    }
    return this.json(result);
  }
}
