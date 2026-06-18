package com.github.dungphan.unityindex.tools.unity

import com.github.dungphan.unityindex.constants.ToolNames
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.github.dungphan.unityindex.util.UnityAssetIndex
import com.intellij.openapi.project.Project
import kotlinx.serialization.json.JsonObject

class GetSerializedFieldValuesTool : AbstractMcpTool() {

    override val requiresPsiSync: Boolean = false

    override val name = ToolNames.GET_SERIALIZED_FIELD_VALUES

    override val description = """
        Read serialized field values for a MonoBehaviour across all prefabs and scenes. Shows what values a field has in each instance without opening the Unity Editor.

        Use this to understand configuration: default values, per-instance overrides, and which GameObjects use non-default settings.

        Parameters:
        - typeName (required): The C# class name (e.g. "PlayerController"). Matched against .cs file names.
        - fieldName (required): The serialized field name as it appears in YAML (e.g. "speed", "maxHealth", "m_Target").
        - project_path (optional): Only needed with multiple projects open.

        Returns: List of values found across asset files, with GameObject names and file IDs.

        Example: {"typeName": "PlayerController", "fieldName": "speed"}
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .stringProperty("typeName", "The C# class name of the MonoBehaviour", required = true)
        .stringProperty("fieldName", "The serialized field name as it appears in the YAML asset files", required = true)
        .projectPath()
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val typeName = requiredStringArg(arguments, "typeName")
            .getOrElse { return createErrorResult(it.message ?: "Missing typeName") }

        val fieldName = requiredStringArg(arguments, "fieldName")
            .getOrElse { return createErrorResult(it.message ?: "Missing fieldName") }

        val index = UnityAssetIndex.create(project)
            ?: return createErrorResult("Cannot resolve Unity project directory")

        val result = index.findSerializedFieldValues(typeName, fieldName)

        if (result.scriptGuid == null) {
            return createErrorResult("No .cs script file found matching type name '$typeName'. Ensure the file is named $typeName.cs and has a .meta file.")
        }

        return createJsonResult(result)
    }
}
