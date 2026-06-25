package com.github.dungphan.unityindex.tools.unity

import com.github.dungphan.unityindex.constants.ToolNames
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.github.dungphan.unityindex.util.UnityAssetIndex
import com.intellij.openapi.project.Project
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import java.io.File

/**
 * Mirrors the TS FindAssetReferencesTool. Reproduces the Rider "paste a GUID
 * into Find in Files" workflow as a first-class MCP tool, driven by the
 * cached GUID map in UnityAssetIndex.
 */
class FindAssetReferencesTool : AbstractMcpTool() {

    override val requiresPsiSync: Boolean = false

    override val name = ToolNames.FIND_ASSET_REFERENCES

    override val description = """
        Find every Unity asset (prefab/scene/scriptable-object/material/animator/etc.) that references a given asset by its GUID. Pass either `assetPath` (any asset under the project) or `guid` directly. Returns each hit with the enclosing YAML field (e.g. m_Sprite), the fileID when present, and a `shadowed` flag.

        `shadowed=true` flags dangling references: the YAML still names a field on a MonoBehaviour script that the script's class no longer declares (e.g. a serialized sprite assigned in a prefab after the field was removed from the .cs source). `shadowed=null` means undetermined (not under a MonoBehaviour, no field hint, or the script class couldn't be resolved).

        Use for questions like "which prefabs use this sprite?", "which scenes embed this prefab?", "which assets bind to this ScriptableObject?", "which prefabs still reference a field that's been deleted?". GUIDs are 32-char unique hex, so there are essentially no false positives.

        Parameters:
        - assetPath (optional): Project-relative or absolute path to an asset; the tool resolves its GUID from the .meta file.
        - guid (optional): 32-char hex GUID, used when assetPath is omitted.
        - maxResults (optional): Cap on references returned. Default 500.
        - project_path (optional): Only needed with multiple projects open.

        Example: {"assetPath": "Assets/UI/Sprites/Coin.png"}
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .projectPath()
        .stringProperty("assetPath", "Project-relative or absolute path to an asset. The tool resolves its GUID from the .meta file.")
        .stringProperty("guid", "Asset GUID (32-char hex). Used directly when assetPath is omitted.")
        .intProperty("maxResults", "Max references to return. Default 500.")
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val assetPath = optionalStringArg(arguments, "assetPath")
        val guidArg = optionalStringArg(arguments, "guid")
        val maxResults = arguments["maxResults"]?.jsonPrimitive?.int ?: DEFAULT_MAX_RESULTS

        val index = UnityAssetIndex.create(project)
            ?: return createErrorResult("Cannot resolve Unity project directory")

        val guid: String = when {
            guidArg != null -> {
                val normalized = guidArg.trim().lowercase()
                if (!GUID_REGEX.matches(normalized)) {
                    return createErrorResult("Invalid guid: '$guidArg'. Expected a 32-char hex string.")
                }
                normalized
            }
            assetPath != null -> {
                val basePath = project.basePath
                    ?: return createErrorResult("Cannot resolve project base path")
                val absPath = if (File(assetPath).isAbsolute) {
                    assetPath
                } else {
                    "$basePath/$assetPath"
                }
                index.getGuidResolver().getGuidForPath(absPath)
                    ?: return createErrorResult("No .meta file found for asset '$assetPath'. Check the path and confirm the .meta file exists alongside it.")
            }
            else -> return createErrorResult("Provide either `assetPath` or `guid`.")
        }

        val result = index.findAssetReferences(guid, maxResults)
        return createJsonResult(result)
    }

    companion object {
        private const val DEFAULT_MAX_RESULTS = 500
        private val GUID_REGEX = Regex("^[0-9a-fA-F]{32}$")
    }
}
