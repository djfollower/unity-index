package com.github.dungphan.unityindex.tools.navigation

import com.github.dungphan.unityindex.constants.ErrorMessages
import com.github.dungphan.unityindex.constants.ParamNames
import com.github.dungphan.unityindex.handlers.BuiltInSearchScope
import com.github.dungphan.unityindex.handlers.BuiltInSearchScopeResolver
import com.github.dungphan.unityindex.handlers.CallElementData
import com.github.dungphan.unityindex.handlers.LanguageHandlerRegistry
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.models.CallElement
import com.github.dungphan.unityindex.tools.models.CallHierarchyResult
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.github.dungphan.unityindex.util.PlatformFallbacks
import com.github.dungphan.unityindex.util.ProjectUtils
import com.github.dungphan.unityindex.util.PsiUtils
import com.github.dungphan.unityindex.util.RiderProtocolHost
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiDocumentManager
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Tool for analyzing method call relationships in C# / Unity projects.
 *
 * Delegates to Rider protocol or platform fallbacks via [LanguageHandlerRegistry].
 */
class CallHierarchyTool : AbstractMcpTool() {

    override val name = "ide_call_hierarchy"

    override val description = """
        Build a call hierarchy tree for a method. Use to trace execution flow—find what calls this method (callers) or what this method calls (callees).

        Returns: recursive tree with method signatures, file locations (line/column), and nested call relationships.

        Target: file + line + column (position-based lookup).

        Parameters: direction (required): "callers" or "callees". depth (optional, default: 3, max: 5). scope (optional, default: "project_files"; supported: project_files, project_and_libraries, project_production_files, project_test_files).

        Example: {"file": "Assets/Scripts/PlayerController.cs", "line": 42, "column": 10, "direction": "callers"}
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .projectPath()
        .file(required = false, description = "Project-relative file path, or a dependency/library absolute path or jar:// URL previously returned by the plugin. Required for position-based lookup.")
        .lineAndColumn(required = false)
        .languageAndSymbol(required = false)
        .enumProperty("direction", "Direction: 'callers' (methods that call this method) or 'callees' (methods this method calls)", listOf("callers", "callees"), required = true)
        .intProperty("depth", "How many levels deep to traverse the call hierarchy (default: 3, max: 5)")
        .scopeProperty("Search scope. Default: project_files.")
        .booleanProperty(ParamNames.INCLUDE_GENERATED, "Include callers/callees in generated sources. Default: true.")
        .build()

    companion object {
        private const val DEFAULT_DEPTH = 3
        private const val MAX_DEPTH = 5
    }

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val direction = arguments["direction"]?.jsonPrimitive?.content
            ?: return createErrorResult("Missing required parameter: direction")
        val depth = (arguments["depth"]?.jsonPrimitive?.int ?: DEFAULT_DEPTH).coerceIn(1, MAX_DEPTH)

        val file = optionalStringArg(arguments, ParamNames.FILE)
        val line = arguments[ParamNames.LINE]?.jsonPrimitive?.int
        val column = arguments[ParamNames.COLUMN]?.jsonPrimitive?.int

        if (file != null && line != null && column != null) {
            val rdResult = tryRiderCallHierarchy(project, file, line, column, direction, depth)
            if (rdResult != null) return rdResult
        }

        val rawScope = rawScopeValue(arguments[ParamNames.SCOPE])
        val scope = try {
            BuiltInSearchScopeResolver.parse(arguments, BuiltInSearchScope.PROJECT_FILES)
        } catch (_: IllegalArgumentException) {
            return createInvalidScopeError(rawScope)
        } catch (_: IllegalStateException) {
            return createInvalidScopeError(rawScope)
        }
        if (direction !in listOf("callers", "callees")) {
            return createErrorResult("direction must be 'callers' or 'callees'")
        }
        val excludeGenerated = resolveExcludeGenerated(arguments, default = true)

        requireSmartMode(project)

        return suspendingReadAction {
            ProgressManager.checkCanceled() // Allow cancellation

            val element = resolveElementFromArguments(project, arguments, allowLibraryFilesForPosition = true).getOrElse {
                return@suspendingReadAction createErrorResult(it.message ?: ErrorMessages.COULD_NOT_RESOLVE_SYMBOL)
            }

            // Find appropriate handler for this element's language
            val handler = LanguageHandlerRegistry.getCallHierarchyHandler(element)

            ProgressManager.checkCanceled()

            val hierarchyData = handler?.getCallHierarchy(element, project, direction, depth, scope, excludeGenerated)
                ?: PlatformFallbacks.getCallHierarchy(element, project, direction, depth, scope, excludeGenerated)

            if (hierarchyData == null) {
                val isSymbolMode = optionalStringArg(arguments, ParamNames.LANGUAGE) != null
                return@suspendingReadAction createErrorResult(
                    if (isSymbolMode) "No method/function found for the specified symbol"
                    else "No method/function found at position"
                )
            }

            // Convert handler result to tool result
            createJsonResult(CallHierarchyResult(
                element = convertToCallElement(hierarchyData.element),
                calls = hierarchyData.calls.map { convertToCallElement(it) }
            ))
        }
    }

    /**
     * Converts handler CallElementData to tool CallElement.
     */
    private fun convertToCallElement(data: CallElementData): CallElement {
        return CallElement(
            name = data.name,
            file = data.file,
            line = data.line,
            column = data.column,
            language = data.language,
            children = data.children?.map { convertToCallElement(it) }
        )
    }

    private suspend fun tryRiderCallHierarchy(
        project: Project,
        filePath: String,
        line: Int,
        column: Int,
        direction: String,
        depth: Int
    ): ToolCallResult? {
        val virtualFile = PsiUtils.resolveVirtualFileAnywhere(project, filePath) ?: return null
        if (!RiderProtocolHost.shouldUseRiderProtocol(virtualFile)) return null

        val document = suspendingReadAction {
            PsiDocumentManager.getInstance(project).getDocument(
                PsiUtils.getPsiFile(project, filePath) ?: return@suspendingReadAction null
            )
        } ?: return null

        val offset = getOffset(document, line, column) ?: return null

        val result = RiderProtocolHost.callHierarchyViaRd(
            project, virtualFile, offset, direction, depth
        ) ?: return null

        fun convertRdElement(el: RiderProtocolHost.RdCallHierarchyElementResult): CallElement {
            return CallElement(
                name = el.name,
                file = el.filePath?.let { ProjectUtils.getRelativePath(project, it) } ?: "",
                line = 0,
                column = 0,
                language = "C#",
                children = el.children?.map { convertRdElement(it) }
            )
        }

        return createJsonResult(CallHierarchyResult(
            element = convertRdElement(result),
            calls = result.children?.map { convertRdElement(it) } ?: emptyList()
        ))
    }
}
