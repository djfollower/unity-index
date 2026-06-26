package com.github.dungphan.unityindex.tools.navigation

import com.github.dungphan.unityindex.constants.ParamNames
import com.github.dungphan.unityindex.constants.ToolNames
import com.github.dungphan.unityindex.handlers.BuiltInSearchScope
import com.github.dungphan.unityindex.handlers.BuiltInSearchScopeResolver
import com.github.dungphan.unityindex.handlers.OptimizedSymbolSearch
import com.github.dungphan.unityindex.handlers.QualifiedMemberResolver
import com.github.dungphan.unityindex.handlers.SymbolData
import com.github.dungphan.unityindex.server.PaginationService
import com.github.dungphan.unityindex.server.ProjectResolver
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.models.FindSymbolResult
import com.github.dungphan.unityindex.tools.models.SymbolMatch
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.github.dungphan.unityindex.util.UnityAssetQueryHint
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.psi.util.PsiModificationTracker
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Tool for searching code symbols by name in C# / Unity projects.
 *
 * Delegates to the headless Go to Symbol popup stack via [OptimizedSymbolSearch],
 * so matching and ranking follow Rider's own Go to Symbol popup.
 */
class FindSymbolTool : AbstractMcpTool() {

    companion object {
        private const val DEFAULT_PAGE_SIZE = 25
        private const val MAX_PAGE_SIZE = PaginationService.MAX_PAGE_SIZE
    }

    override val name = ToolNames.FIND_SYMBOL

    override val description = """
        Search for symbols by name across the codebase. Use when you know a symbol name but not its location—finds classes, methods, fields, and properties. Faster and more accurate than grep for code navigation.

        Matching and ranking follow Rider's Go to Symbol popup, including qualified queries like "PlayerController.Update".

        Returns: matching symbols with qualified names, file paths, line/column numbers, and kind.

        Supports pagination: first call returns results + nextCursor. Pass cursor to get the next page.
        Parameters: query (required for fresh search), scope (optional, default: "project_files"; supported: project_files, project_and_libraries, project_production_files, project_test_files), language (optional case-insensitive filter, e.g. "C#"), pageSize (optional, default: 25, max: 500), cursor (for pagination, replaces search params; project_path may still be required).

        Example: {"query": "PlayerController"} or {"query": "OnCollisionEnter", "scope": "project_and_libraries"}
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .projectPath()
        .stringProperty(ParamNames.QUERY, "Search pattern. Matching follows IntelliJ's Go to Symbol popup, including qualified queries. Required for fresh search, ignored when cursor is provided.")
        .scopeProperty("Search scope. Default: project_files.")
        .stringProperty(ParamNames.LANGUAGE, "Filter results by language (e.g., \"C#\"). Case-insensitive. Optional.")
        .booleanProperty(ParamNames.INCLUDE_GENERATED, "Include symbols defined in generated sources. Default: false.")
        .intProperty(ParamNames.LIMIT, "Maximum results per page (deprecated, use pageSize). Default: $DEFAULT_PAGE_SIZE, max: $MAX_PAGE_SIZE.")
        .stringProperty("cursor", "Pagination cursor from a previous response. When provided, returns the next page of results. Search parameters are ignored; project_path and pageSize may still be provided.")
        .intProperty("pageSize", "Results per page. Default: $DEFAULT_PAGE_SIZE, max: $MAX_PAGE_SIZE.")
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val cursor = optionalStringArg(arguments, ParamNames.CURSOR)
        if (cursor != null) {
            val pageSize = resolveExplicitPageSize(arguments, aliases = arrayOf("limit"))
            return buildPaginatedResult<SymbolMatch, FindSymbolResult>(getPageFromCache(cursor, pageSize, project)) { items, page ->
                FindSymbolResult(
                    symbols = items,
                    totalCount = page.totalCollected,
                    query = page.metadata["query"] ?: "",
                    nextCursor = page.nextCursor,
                    hasMore = page.hasMore,
                    totalCollected = page.totalCollected,
                    offset = page.offset,
                    pageSize = page.pageSize,
                    stale = page.stale
                )
            }
        }

        val query = arguments[ParamNames.QUERY]?.jsonPrimitive?.content
            ?: return createErrorResult("Missing required parameter: ${ParamNames.QUERY}")
        val rawScope = rawScopeValue(arguments[ParamNames.SCOPE])
        val scope = try {
            BuiltInSearchScopeResolver.parse(arguments, BuiltInSearchScope.PROJECT_FILES)
        } catch (_: IllegalArgumentException) {
            return createInvalidScopeError(rawScope)
        } catch (_: IllegalStateException) {
            return createInvalidScopeError(rawScope)
        }
        val languageFilter = arguments[ParamNames.LANGUAGE]?.jsonPrimitive?.content
        val excludeGenerated = resolveExcludeGenerated(arguments, default = false)
        val pageSize = resolvePageSize(arguments, DEFAULT_PAGE_SIZE, aliases = arrayOf("limit"))
        val collectLimit = maxOf(PaginationService.DEFAULT_OVERCOLLECT, pageSize)

        if (query.isBlank()) {
            return createErrorResult("Query cannot be empty")
        }

        requireSmartMode(project)

        val token = suspendingReadAction {
            val searchScope = BuiltInSearchScopeResolver.resolveGlobalScope(project, scope, excludeGenerated)
            val nativeLanguageFilter = languageFilter?.takeIf { it.isNotBlank() }?.let { setOf(it) }
            val symbols = OptimizedSymbolSearch.search(
                project = project,
                pattern = query,
                scope = searchScope,
                limit = collectLimit,
                languageFilter = nativeLanguageFilter
            )

            // Inheritance fallback: when "Type.Member" returns nothing, try resolving Member on
            // a base class of Type. Mirrors the TS QualifiedMemberResolver.
            val matches: List<SymbolMatch> = if (symbols.isEmpty()) {
                val inherited = QualifiedMemberResolver.resolveInherited(
                    project = project,
                    query = query,
                    scope = searchScope,
                    languageFilter = nativeLanguageFilter
                )
                if (inherited != null) listOf(inherited) else emptyList()
            } else {
                symbols.map { it.toSymbolMatch() }
            }

            val searchExtender: suspend (Set<String>, Int) -> List<PaginationService.SerializedResult> = { seenKeys, limit ->
                suspendingReadAction {
                    extendSearchSymbols(project, query, scope, languageFilter, seenKeys, limit, excludeGenerated)
                }
            }

            val serializedResults = matches.map { sym ->
                PaginationService.SerializedResult(
                    key = sym.paginationKey(),
                    data = json.encodeToJsonElement(sym)
                )
            }

            val paginationService = ApplicationManager.getApplication().getService(PaginationService::class.java)
            paginationService.createCursor(
                toolName = name,
                results = serializedResults,
                seenKeys = serializedResults.map { it.key }.toSet(),
                searchExtender = searchExtender,
                psiModCount = PsiModificationTracker.getInstance(project).modificationCount,
                projectBasePath = ProjectResolver.normalizePath(project.basePath ?: ""),
                metadata = mapOf("query" to query)
            )
        }

        return buildPaginatedResult<SymbolMatch, FindSymbolResult>(getPageFromCache(token, pageSize, project)) { items, page ->
            val effectiveQuery = page.metadata["query"] ?: ""
            val fallbackMatch = items.firstOrNull { it.resolvedFrom != null }
            val resolutionHint = fallbackMatch?.resolvedFrom?.let {
                "${it.requestedType}.${it.requestedMember} isn't declared on ${it.requestedType}; resolved on base type ${it.declaringType}."
            }
            FindSymbolResult(
                symbols = items,
                totalCount = page.totalCollected,
                query = effectiveQuery,
                nextCursor = page.nextCursor,
                hasMore = page.hasMore,
                totalCollected = page.totalCollected,
                offset = page.offset,
                pageSize = page.pageSize,
                stale = page.stale,
                hint = resolutionHint
                    ?: if (items.isEmpty() && page.totalCollected == 0) UnityAssetQueryHint.forEmptyResult(effectiveQuery) else null
            )
        }
    }

    /**
     * Re-executes the popup-backed search to collect more results beyond the initial cache.
     * Skips already-seen keys in the caller's cache — O(total_results) per extension because
     * the popup APIs don't support offset-based iteration.
     */
    private fun extendSearchSymbols(
        project: Project,
        query: String,
        scope: BuiltInSearchScope,
        languageFilter: String?,
        seenKeys: Set<String>,
        limit: Int,
        excludeGenerated: Boolean
    ): List<PaginationService.SerializedResult> {
        val searchScope = BuiltInSearchScopeResolver.resolveGlobalScope(project, scope, excludeGenerated)
        val nativeLanguageFilter = languageFilter?.takeIf { it.isNotBlank() }?.let { setOf(it) }
        val symbols = OptimizedSymbolSearch.search(
            project = project,
            pattern = query,
            scope = searchScope,
            limit = limit + seenKeys.size,
            languageFilter = nativeLanguageFilter
        )

        return symbols.asSequence()
            .map { it.toSymbolMatch() }
            .filter { sym -> sym.paginationKey() !in seenKeys }
            .take(limit)
            .map { sym ->
                PaginationService.SerializedResult(
                    key = sym.paginationKey(),
                    data = json.encodeToJsonElement(sym)
                )
            }
            .toList()
    }

    private fun SymbolData.toSymbolMatch(): SymbolMatch = SymbolMatch(
        name = name,
        qualifiedName = qualifiedName,
        kind = kind,
        file = file,
        line = line,
        column = column,
        containerName = containerName,
        language = language
    )

    private fun SymbolMatch.paginationKey(): String = "$file:$line:$column:$name"


}
