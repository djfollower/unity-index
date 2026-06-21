package com.github.dungphan.unityindex.tools.navigation

import com.github.dungphan.unityindex.constants.ErrorMessages
import com.github.dungphan.unityindex.constants.ParamNames
import com.github.dungphan.unityindex.handlers.BuiltInSearchScope
import com.github.dungphan.unityindex.handlers.BuiltInSearchScopeResolver
import com.github.dungphan.unityindex.handlers.LanguageHandlerRegistry
import com.github.dungphan.unityindex.server.PaginationService
import com.github.dungphan.unityindex.server.ProjectResolver
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.models.ImplementationLocation
import com.github.dungphan.unityindex.tools.models.ImplementationResult
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.github.dungphan.unityindex.util.PlatformFallbacks
import com.github.dungphan.unityindex.util.ProjectUtils
import com.github.dungphan.unityindex.util.PsiUtils
import com.github.dungphan.unityindex.util.RiderProtocolHost
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.util.PsiModificationTracker
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Tool for finding implementations of interfaces, abstract classes, or methods in C# / Unity projects.
 *
 * Delegates to Rider protocol or platform fallbacks via [LanguageHandlerRegistry].
 */
class FindImplementationsTool : AbstractMcpTool() {

    companion object {
        private const val DEFAULT_PAGE_SIZE = 100
        private const val MAX_PAGE_SIZE = PaginationService.MAX_PAGE_SIZE
    }

    override val name = "ide_find_implementations"

    override val description = """
        Find all implementations of an interface, abstract class, or abstract method. Use to discover concrete implementations when working with abstractions.

        Returns: list of implementing classes/methods with file paths, line/column numbers, and kind (class/method).

        Supports pagination: first call returns results + nextCursor. Pass cursor to get the next page.

        Target (mutually exclusive):
        - file + line + column: position-based lookup (necessary for fresh search, ignored when cursor is provided)
        - cursor: pagination cursor from a previous response

        Parameters: scope (optional, default: "project_files"; supported: project_files, project_and_libraries, project_production_files, project_test_files), pageSize (optional, default: 100, max: 500).

        Example: {"file": "Assets/Scripts/IRepository.cs", "line": 8, "column": 18}
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .projectPath()
        .file(required = false, description = "Project-relative file path, or a dependency/library absolute path or jar:// URL previously returned by the plugin. Required for position-based lookup.")
        .lineAndColumn(required = false)
        .languageAndSymbol(required = false)
        .scopeProperty("Search scope. Default: project_files.")
        .booleanProperty(ParamNames.INCLUDE_GENERATED, "Include implementations in generated sources. Default: false.")
        .stringProperty("cursor", "Pagination cursor from a previous response. When provided, returns the next page of results. Search parameters are ignored; project_path and pageSize may still be provided.")
        .intProperty("pageSize", "Results per page. Default: $DEFAULT_PAGE_SIZE, max: $MAX_PAGE_SIZE.")
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val cursor = optionalStringArg(arguments, ParamNames.CURSOR)
        if (cursor != null) {
            val pageSize = resolveExplicitPageSize(arguments)
            return buildPaginatedResult<ImplementationLocation, ImplementationResult>(getPageFromCache(cursor, pageSize, project)) { items, page ->
                ImplementationResult(
                    implementations = items,
                    totalCount = page.totalCollected,
                    nextCursor = page.nextCursor,
                    hasMore = page.hasMore,
                    totalCollected = page.totalCollected,
                    offset = page.offset,
                    pageSize = page.pageSize,
                    stale = page.stale
                )
            }
        }

        val file = optionalStringArg(arguments, ParamNames.FILE)
        val line = arguments[ParamNames.LINE]?.jsonPrimitive?.int
        val column = arguments[ParamNames.COLUMN]?.jsonPrimitive?.int

        if (file != null && line != null && column != null) {
            val rdResult = tryRiderFindImplementations(project, file, line, column)
            if (rdResult != null) return rdResult
        }

        val pageSize = resolvePageSize(arguments, DEFAULT_PAGE_SIZE)
        val rawScope = rawScopeValue(arguments[ParamNames.SCOPE])
        val scope = try {
            BuiltInSearchScopeResolver.parse(arguments, BuiltInSearchScope.PROJECT_FILES)
        } catch (_: IllegalArgumentException) {
            return createInvalidScopeError(rawScope)
        } catch (_: IllegalStateException) {
            return createInvalidScopeError(rawScope)
        }
        val excludeGenerated = resolveExcludeGenerated(arguments, default = false)
        requireSmartMode(project)

        val cursorToken = suspendingReadAction {
            val element = resolveElementFromArguments(project, arguments, allowLibraryFilesForPosition = true).getOrElse {
                return@suspendingReadAction null to createErrorResult(it.message ?: ErrorMessages.COULD_NOT_RESOLVE_SYMBOL)
            }

            val handler = LanguageHandlerRegistry.getImplementationsHandler(element)
            val implementations = handler?.findImplementations(element, project, scope, excludeGenerated)
                ?: PlatformFallbacks.findImplementations(element, project, scope, excludeGenerated)

            if (implementations == null) {
                val isSymbolMode = optionalStringArg(arguments, ParamNames.LANGUAGE) != null
                return@suspendingReadAction null to createErrorResult(
                    if (isSymbolMode) "No method or class found for the specified symbol"
                    else "No method or class found at position"
                )
            }

            val implementationLocations = implementations.map { impl ->
                ImplementationLocation(
                    name = impl.name,
                    file = impl.file,
                    line = impl.line,
                    column = impl.column,
                    kind = impl.kind,
                    language = impl.language
                )
            }

            val serializedResults = implementationLocations.map { impl ->
                PaginationService.SerializedResult(
                    key = "${impl.file}:${impl.line}:${impl.column}:${impl.name}",
                    data = json.encodeToJsonElement(impl)
                )
            }

            val paginationService = ApplicationManager.getApplication().getService(PaginationService::class.java)
            val token = paginationService.createCursor(
                toolName = name,
                results = serializedResults,
                seenKeys = serializedResults.map { it.key }.toSet(),
                searchExtender = null,
                psiModCount = PsiModificationTracker.getInstance(project).modificationCount,
                projectBasePath = ProjectResolver.normalizePath(project.basePath ?: "")
            )

            token to null
        }

        val (token, errorResult) = cursorToken
        if (errorResult != null) return errorResult

        return buildPaginatedResult<ImplementationLocation, ImplementationResult>(getPageFromCache(token!!, pageSize, project)) { items, page ->
            ImplementationResult(
                implementations = items,
                totalCount = page.totalCollected,
                nextCursor = page.nextCursor,
                hasMore = page.hasMore,
                totalCollected = page.totalCollected,
                offset = page.offset,
                pageSize = page.pageSize,
                stale = page.stale
            )
        }
    }

    private suspend fun tryRiderFindImplementations(
        project: Project,
        filePath: String,
        line: Int,
        column: Int
    ): ToolCallResult? {
        val virtualFile = PsiUtils.resolveVirtualFileAnywhere(project, filePath) ?: return null
        if (!RiderProtocolHost.shouldUseRiderProtocol(virtualFile)) return null

        val document = suspendingReadAction {
            PsiDocumentManager.getInstance(project).getDocument(
                PsiUtils.getPsiFile(project, filePath) ?: return@suspendingReadAction null
            )
        } ?: return null

        val offset = getOffset(document, line, column) ?: return null

        val results = RiderProtocolHost.findImplementationsViaRd(project, virtualFile, offset) ?: return null

        val implementations = results.map { impl ->
            ImplementationLocation(
                name = impl.name,
                file = ProjectUtils.getRelativePath(project, impl.filePath),
                line = impl.line,
                column = impl.column,
                kind = impl.kind,
                language = "C#"
            )
        }

        return createJsonResult(ImplementationResult(
            implementations = implementations,
            totalCount = implementations.size,
            nextCursor = null,
            hasMore = false,
            totalCollected = implementations.size,
            offset = 0,
            pageSize = implementations.size,
            stale = false
        ))
    }
}
