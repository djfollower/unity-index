package com.github.dungphan.unityindex.tools.unity

import com.github.dungphan.unityindex.constants.ToolNames
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.github.dungphan.unityindex.util.UnityAssetIndex
import com.intellij.openapi.project.Project
import kotlinx.serialization.json.JsonObject

class GetUnityEventBindingsTool : AbstractMcpTool() {

    override val requiresPsiSync: Boolean = false

    override val name = ToolNames.GET_UNITY_EVENT_BINDINGS

    override val description = """
        Find UnityEvent bindings (Button.onClick, custom events, etc.) that call a specific method. These bindings are serialized in prefab/scene YAML files as m_PersistentCalls — invisible to code-only analysis.

        Use this to discover how a method is invoked from the Unity Editor (UI buttons, animation events, custom UnityEvents wired in the Inspector).

        Parameters:
        - methodName (required): The method name to search for (e.g. "OnStartButtonClicked", "TakeDamage").
        - project_path (optional): Only needed with multiple projects open.

        Returns: List of bindings with asset file, event field, target type, GameObject name, and call state.

        Example: {"methodName": "OnStartButtonClicked"}
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .stringProperty("methodName", "The method name to search for in UnityEvent persistent call bindings", required = true)
        .projectPath()
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val methodName = requiredStringArg(arguments, "methodName")
            .getOrElse { return createErrorResult(it.message ?: "Missing methodName") }

        val index = UnityAssetIndex.create(project)
            ?: return createErrorResult("Cannot resolve Unity project directory")

        val result = index.findEventBindings(methodName)
        return createJsonResult(result)
    }
}
