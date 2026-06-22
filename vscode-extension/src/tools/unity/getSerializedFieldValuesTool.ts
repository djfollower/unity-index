import { AbstractMcpTool } from "../abstractTool";
import { TOOL_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext } from "../../server/projectResolver";
import { Args, requireString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import { UnityAssetIndex } from "../../utils/unityAssetIndex";

export class GetSerializedFieldValuesTool extends AbstractMcpTool {
  protected readonly requiresLsp = false;

  readonly name = TOOL_NAMES.GET_SERIALIZED_FIELD_VALUES;
  readonly description =
    "Read serialized field values for a MonoBehaviour across all prefabs and scenes. " +
    "Shows what values a field has in each instance without opening the Unity Editor.";
  readonly inputSchema = SchemaBuilder.tool()
    .stringProperty("typeName", "The C# class name of the MonoBehaviour", true)
    .stringProperty("fieldName", "The serialized field name as it appears in YAML assets", true)
    .projectPath()
    .build();

  protected async doExecute(
    project: ProjectContext,
    args: Args,
  ): Promise<ToolCallResult> {
    const typeName = requireString(args, "typeName");
    const fieldName = requireString(args, "fieldName");
    const index = new UnityAssetIndex(project);
    const result = index.findSerializedFieldValues(typeName, fieldName);
    if (result.scriptGuid === null) {
      return this.error(
        `No .cs script file found matching type name '${typeName}'. ` +
          "Ensure the file is named " + typeName + ".cs and has a .meta file.",
      );
    }
    return this.json(result);
  }
}
