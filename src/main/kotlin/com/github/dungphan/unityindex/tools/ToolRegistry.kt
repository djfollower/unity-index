package com.github.dungphan.unityindex.tools

import com.github.dungphan.unityindex.handlers.LanguageHandlerRegistry
import com.github.dungphan.unityindex.server.McpServerService
import com.github.dungphan.unityindex.server.models.ToolDefinition
import com.github.dungphan.unityindex.settings.McpSettings
import com.github.dungphan.unityindex.tools.intelligence.GetDiagnosticsTool
import com.github.dungphan.unityindex.tools.navigation.FindClassTool
import com.github.dungphan.unityindex.tools.navigation.FindDefinitionTool
import com.github.dungphan.unityindex.tools.navigation.FindFileTool
import com.github.dungphan.unityindex.tools.navigation.FindSymbolTool
import com.github.dungphan.unityindex.tools.navigation.FindUsagesTool
import com.github.dungphan.unityindex.tools.navigation.GetSymbolBodyTool
import com.github.dungphan.unityindex.tools.navigation.ReadFileTool
import com.github.dungphan.unityindex.tools.navigation.SearchTextTool
import com.github.dungphan.unityindex.tools.project.BuildProjectTool
import com.github.dungphan.unityindex.tools.project.GetIndexStatusTool
import com.github.dungphan.unityindex.tools.project.SyncFilesTool
import com.github.dungphan.unityindex.tools.unity.GetAssemblyMapTool
import com.github.dungphan.unityindex.tools.unity.GetComponentUsageTool
import com.github.dungphan.unityindex.tools.unity.FindGetComponentPatternsTool
import com.github.dungphan.unityindex.tools.unity.GetApiUsageTool
import com.github.dungphan.unityindex.tools.unity.FindAssetReferencesTool
import com.github.dungphan.unityindex.tools.unity.GetProjectContextTool
import com.github.dungphan.unityindex.tools.unity.GetSerializedFieldValuesTool
import com.github.dungphan.unityindex.tools.unity.GetUnityEventBindingsTool
import com.github.dungphan.unityindex.tools.unity.UnityGraphCodeEdgesTool
import com.github.dungphan.unityindex.tools.unity.UnityGraphContextTool
import com.github.dungphan.unityindex.tools.unity.UnityGraphImpactTool
import com.github.dungphan.unityindex.tools.unity.UnityGraphNeighborsTool
import com.github.dungphan.unityindex.tools.unity.UnityGraphSnapshotDeltaTool
import com.github.dungphan.unityindex.tools.unity.UnityGraphSnapshotTool
import com.intellij.openapi.diagnostic.logger
import java.util.concurrent.ConcurrentHashMap

class ToolRegistry {

    companion object {
        private val LOG = logger<ToolRegistry>()
    }

    private val tools = ConcurrentHashMap<String, McpTool>()

    fun register(tool: McpTool) {
        tools[tool.name] = tool
        LOG.info("Registered MCP tool: ${tool.name}")
    }

    fun unregister(toolName: String) {
        tools.remove(toolName)
        LOG.info("Unregistered MCP tool: $toolName")
    }

    fun getTool(name: String): McpTool? = tools[name]

    fun getAllTools(): List<McpTool> = tools.values.toList()

    fun getToolDefinitions(): List<ToolDefinition> {
        val settings = McpSettings.getInstance()
        return tools.values
            .filter { settings.isToolEnabled(it.name) }
            .map { tool ->
                ToolDefinition(
                    name = tool.name,
                    description = tool.description,
                    inputSchema = tool.inputSchema
                )
            }
    }

    fun getAllToolDefinitions(): List<ToolDefinition> {
        return tools.values.map { tool ->
            ToolDefinition(
                name = tool.name,
                description = tool.description,
                inputSchema = tool.inputSchema
            )
        }
    }

    fun registerBuiltInTools() {
        LanguageHandlerRegistry.registerHandlers()

        registerUniversalTools()
        registerUnityTools()
        registerLanguageNavigationTools()

        // BatchTool must be registered last — it holds a reference to `this`
        // registry so it can dispatch entries to any other registered tool.
        register(BatchTool(this))

        LOG.info("Registered ${tools.size} built-in MCP tools")
        logAvailableLanguages()
    }

    private fun logAvailableLanguages() {
        val typeHierarchyLangs = LanguageHandlerRegistry.getSupportedLanguagesForTypeHierarchy()
        val implementationLangs = LanguageHandlerRegistry.getSupportedLanguagesForImplementations()
        val callHierarchyLangs = LanguageHandlerRegistry.getSupportedLanguagesForCallHierarchy()
        val superMethodsLangs = LanguageHandlerRegistry.getSupportedLanguagesForSuperMethods()
        val structureLangs = LanguageHandlerRegistry.getSupportedLanguagesForStructure()

        LOG.info("Language support - TypeHierarchy: $typeHierarchyLangs, " +
            "Implementations: $implementationLangs, " +
            "CallHierarchy: $callHierarchyLangs, " +
            "SuperMethods: $superMethodsLangs, " +
            "Structure: $structureLangs")
    }

    private fun registerUniversalTools() {
        register(FindUsagesTool())
        register(FindDefinitionTool())
        register(GetDiagnosticsTool())
        register(GetIndexStatusTool())
        register(SyncFilesTool())
        register(BuildProjectTool())
        register(FindClassTool())
        register(FindFileTool())
        register(FindSymbolTool())
        register(SearchTextTool())
        register(ReadFileTool())
        register(GetSymbolBodyTool())

        LOG.info("Registered universal tools")
    }

    private fun registerUnityTools() {
        register(GetAssemblyMapTool())
        register(GetComponentUsageTool())
        register(GetUnityEventBindingsTool())
        register(FindGetComponentPatternsTool())
        register(GetSerializedFieldValuesTool())
        register(GetProjectContextTool())
        register(GetApiUsageTool())
        register(FindAssetReferencesTool())
        register(UnityGraphSnapshotTool())
        register(UnityGraphSnapshotDeltaTool())
        register(UnityGraphNeighborsTool())
        register(UnityGraphImpactTool())
        register(UnityGraphContextTool())
        register(UnityGraphCodeEdgesTool())

        LOG.info("Registered Unity-specific tools")
    }

    private data class ConditionalTool(
        val className: String,
        val isAvailable: () -> Boolean
    )

    private val languageNavigationTools = listOf(
        ConditionalTool("com.github.dungphan.unityindex.tools.navigation.TypeHierarchyTool") { LanguageHandlerRegistry.hasTypeHierarchyHandlers() },
        ConditionalTool("com.github.dungphan.unityindex.tools.navigation.FindImplementationsTool") { LanguageHandlerRegistry.hasImplementationsHandlers() },
        ConditionalTool("com.github.dungphan.unityindex.tools.navigation.CallHierarchyTool") { LanguageHandlerRegistry.hasCallHierarchyHandlers() },
        ConditionalTool("com.github.dungphan.unityindex.tools.navigation.FindSuperMethodsTool") { LanguageHandlerRegistry.hasSuperMethodsHandlers() },
        ConditionalTool("com.github.dungphan.unityindex.tools.navigation.FileStructureTool") { LanguageHandlerRegistry.hasStructureHandlers() },
    )

    private fun registerLanguageNavigationTools() {
        for (tool in languageNavigationTools) {
            try {
                if (tool.isAvailable()) {
                    val toolClass = Class.forName(tool.className)
                    register(toolClass.getDeclaredConstructor().newInstance() as McpTool)
                }
            } catch (e: Exception) {
                LOG.warn("Failed to register language navigation tool ${tool.className}: ${e.message}")
            }
        }
    }
}
