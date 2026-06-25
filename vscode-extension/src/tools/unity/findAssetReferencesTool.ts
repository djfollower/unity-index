import * as path from "path";
import { AbstractMcpTool, ToolContext } from "../abstractTool";
import { TOOL_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext, resolveFilePath } from "../../server/projectResolver";
import { Args, optionalInt, optionalString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";

const DEFAULT_MAX_RESULTS = 500;
const GUID_REGEX = /^[0-9a-fA-F]{32}$/;

/**
 * Mirrors the Rider workflow of "copy a GUID from an asset's .meta, paste
 * into Find in Files, see which prefabs/scenes/scriptable-objects reference
 * it" — but driven from the cached UnityAssetIndex so the substring scan
 * skips ~all assets cheaply, and YAML is never fully parsed.
 *
 * Prefer this over plain text search for "which assets use X" questions:
 * GUIDs are 32-char unique hex, so there are essentially no false positives.
 */
export class FindAssetReferencesTool extends AbstractMcpTool {
  protected readonly requiresLsp = false;
  readonly isHeavyScan = true;

  readonly name = TOOL_NAMES.FIND_ASSET_REFERENCES;
  readonly description =
    "Find every Unity asset (prefab/scene/scriptable-object/material/animator/etc.) that references a given asset by its GUID. " +
    "Pass either `assetPath` (any asset under the project) or `guid` directly. " +
    "Returns each hit with the enclosing YAML field (e.g. m_Sprite) and the fileID when present. " +
    "Use for questions like 'which prefabs use this sprite?', 'which scenes embed this prefab?', 'which assets bind to this ScriptableObject?'.";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .stringProperty(
      "assetPath",
      "Project-relative or absolute path to an asset. The tool resolves its GUID from the .meta file.",
    )
    .stringProperty("guid", "Asset GUID (32-char hex). Used directly when assetPath is omitted.")
    .intProperty("maxResults", `Max references to return. Default ${DEFAULT_MAX_RESULTS}.`)
    .build();

  protected async doExecute(
    project: ProjectContext,
    args: Args,
    ctx: ToolContext,
  ): Promise<ToolCallResult> {
    const assetPath = optionalString(args, "assetPath");
    const guidArg = optionalString(args, "guid");
    const maxResults =
      optionalInt(args, "maxResults") ?? DEFAULT_MAX_RESULTS;

    const index = await ctx.assetIndex.get(project);

    let guid: string | undefined;
    if (guidArg) {
      const normalized = guidArg.trim().toLowerCase();
      if (!GUID_REGEX.test(normalized)) {
        return this.error(
          `Invalid guid: '${guidArg}'. Expected a 32-char hex string.`,
        );
      }
      guid = normalized;
    } else if (assetPath) {
      const absPath = path.normalize(resolveFilePath(project, assetPath));
      guid = index.guidFor(absPath);
      if (!guid) {
        return this.error(
          `No .meta file found for asset '${assetPath}'. Check the path and confirm the .meta file exists alongside it.`,
        );
      }
    } else {
      return this.error("Provide either `assetPath` or `guid`.");
    }

    const result = await index.findAssetReferences(guid, maxResults, ctx.signal);
    return this.json(result);
  }
}
