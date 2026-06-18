package com.github.dungphan.unityindex.tools.unity

import com.github.dungphan.unityindex.constants.ToolNames
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.github.dungphan.unityindex.util.UnityAssetIndex
import com.intellij.openapi.project.Project
import kotlinx.serialization.json.JsonObject

class GetComponentUsageTool : AbstractMcpTool() {

    override val requiresPsiSync: Boolean = false

    override val name = ToolNames.GET_COMPONENT_USAGE

    override val description = """
        Find where a Unity MonoBehaviour or ScriptableObject is attached in scenes (.unity) and prefabs (.prefab). This is invisible to code-only analysis — these references are serialized in YAML asset files, not in C# code.

        Parameters:
        - typeName (required): The C# class name (e.g. "PlayerController", "EnemyAI"). Matched against .cs file names.
        - project_path (optional): Only needed with multiple projects open.

        Returns: List of asset files where the component is used, with GameObject names and file IDs.

        Example: {"typeName": "PlayerController"}
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .stringProperty("typeName", "The C# class name of the MonoBehaviour or ScriptableObject", required = true)
        .projectPath()
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val typeName = requiredStringArg(arguments, "typeName")
            .getOrElse { return createErrorResult(it.message ?: "Missing typeName") }

        val index = UnityAssetIndex.create(project)
            ?: return createErrorResult("Cannot resolve Unity project directory")

        val result = index.findComponentUsages(typeName)

        if (result.scriptGuid == null) {
            return createErrorResult("No .cs script file found matching type name '$typeName'. Ensure the file is named $typeName.cs and has a .meta file.")
        }

        return createJsonResult(result)
    }
}
