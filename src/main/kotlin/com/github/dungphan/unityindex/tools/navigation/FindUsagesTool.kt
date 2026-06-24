package com.github.dungphan.unityindex.tools.navigation

import com.github.dungphan.unityindex.constants.ErrorMessages
import com.github.dungphan.unityindex.constants.ParamNames
import com.github.dungphan.unityindex.constants.ToolNames
import com.github.dungphan.unityindex.constants.UsageTypes
import com.github.dungphan.unityindex.handlers.BuiltInSearchScope
import com.github.dungphan.unityindex.handlers.BuiltInSearchScopeResolver
import com.github.dungphan.unityindex.server.PaginationService
import com.github.dungphan.unityindex.server.ProjectResolver
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.models.FindUsagesResult
import com.github.dungphan.unityindex.tools.models.UsageLocation
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.github.dungphan.unityindex.util.ProjectUtils
import com.github.dungphan.unityindex.util.PsiUtils
import com.github.dungphan.unityindex.util.RiderProtocolHost
import com.intellij.find.findUsages.FindUsagesHandlerFactory
import com.intellij.find.findUsages.FindUsagesHandlerBase
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiNamedElement
import com.intellij.psi.SmartPointerManager
import com.intellij.psi.search.searches.ReferencesSearch
import com.intellij.psi.util.PsiModificationTracker
import com.intellij.usageView.UsageInfo
import com.intellij.util.Processor
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive

class FindUsagesTool : AbstractMcpTool() {

    companion object {
        private val LOG = logger<FindUsagesTool>()
        private const val DEFAULT_MAX_RESULTS = 100
        private const val MAX_PAGE_SIZE = PaginationService.MAX_PAGE_SIZE

        private val PROJECT_METADATA_EXTENSIONS = setOf(
            "csproj", "vbproj", "fsproj", "sln", "props", "targets",
            "vcxproj", "shproj", "projitems"
        )

        private fun isProjectMetadataFile(file: VirtualFile): Boolean =
            file.extension?.lowercase() in PROJECT_METADATA_EXTENSIONS

        internal fun searchInfrastructureErrorMessage(error: Throwable): String {
            val detail = error.message?.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""
            return "Reference search failed due to IDE/plugin API incompatibility (${error::class.simpleName}$detail). " +
                "Try ide_search_text as a fallback and check plugin compatibility against the current IDE build."
        }
    }

    override val name = ToolNames.FIND_REFERENCES

    override val description = """
        Find all references to a symbol across the project. Use when you need to understand how a class, method, field, or variable is used before modifying or removing it.

        Returns: file paths, line numbers, context snippets, and reference types (method_call, field_access, import, etc.).

        Supports pagination: first call returns results + nextCursor. Pass cursor to get the next page.

        Target (mutually exclusive):
        - file + line + column: position-based lookup (necessary for fresh search, ignored when cursor is provided)
        - cursor: pagination cursor from a previous response

        Parameters: scope (optional, default: "project_files"; supported: project_files, project_and_libraries, project_production_files, project_test_files), pageSize (optional, default: 100, max: 500).

        Example: {"file": "Assets/Scripts/PlayerController.cs", "line": 25, "column": 18}
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .projectPath()
        .file(required = false, description = "Project-relative file path, or a dependency/library absolute path or jar:// URL previously returned by the plugin. Required for position-based lookup.")
        .lineAndColumn(required = false)
        .languageAndSymbol(required = false)
        .scopeProperty("Search scope. Default: project_files.")
        .booleanProperty(ParamNames.INCLUDE_GENERATED, "Include references in generated sources. Default: true. Set false to drop generated output when it dominates the result set.")
        .intProperty("maxResults", "Maximum results per page (deprecated, use pageSize). Default: $DEFAULT_MAX_RESULTS, max: $MAX_PAGE_SIZE.")
        .stringProperty("cursor", "Pagination cursor from a previous response. When provided, returns the next page of results. Search parameters are ignored; project_path and pageSize may still be provided.")
        .intProperty("pageSize", "Results per page. Default: $DEFAULT_MAX_RESULTS, max: $MAX_PAGE_SIZE.")
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val cursor = optionalStringArg(arguments, ParamNames.CURSOR)
        if (cursor != null) {
            val pageSize = resolveExplicitPageSize(arguments, aliases = arrayOf("maxResults"))
            return buildPaginatedResult<UsageLocation, FindUsagesResult>(getPageFromCache(cursor, pageSize, project)) { items, page ->
                FindUsagesResult(
                    usages = items,
                    totalCount = page.totalCollected,
                    truncated = page.hasMore,
                    nextCursor = page.nextCursor,
                    hasMore = page.hasMore,
                    totalCollected = page.totalCollected,
                    offset = page.offset,
                    pageSize = page.pageSize,
                    stale = page.stale
                )
            }
        }

        val pageSize = resolvePageSize(arguments, DEFAULT_MAX_RESULTS, aliases = arrayOf("maxResults"))
        val collectLimit = maxOf(PaginationService.DEFAULT_OVERCOLLECT, pageSize)
        val excludeGenerated = resolveExcludeGenerated(arguments, default = true)
        val rawScope = rawScopeValue(arguments[ParamNames.SCOPE])
        val scope = try {
            BuiltInSearchScopeResolver.parse(arguments, BuiltInSearchScope.PROJECT_FILES)
        } catch (_: IllegalArgumentException) {
            return createInvalidScopeError(rawScope)
        } catch (_: IllegalStateException) {
            return createInvalidScopeError(rawScope)
        }
        requireSmartMode(project)

        val file = optionalStringArg(arguments, ParamNames.FILE)
        val line = arguments[ParamNames.LINE]?.jsonPrimitive?.int
        val column = arguments[ParamNames.COLUMN]?.jsonPrimitive?.int

        if (file != null && line != null && column != null) {
            val rdResult = tryRiderFindUsages(project, file, line, column, pageSize)
            if (rdResult != null) return rdResult
        }

        val cursorToken = suspendingReadAction {
            val element = resolveElementFromArguments(project, arguments, allowLibraryFilesForPosition = true).getOrElse {
                return@suspendingReadAction null to createErrorResult(it.message ?: ErrorMessages.COULD_NOT_RESOLVE_SYMBOL)
            }

            val targetElement = element as? PsiNamedElement
                ?: (PsiUtils.resolveTargetElement(element)
                    ?: return@suspendingReadAction null to createErrorResult(ErrorMessages.NO_NAMED_ELEMENT))

            LOG.info("FindUsages target: ${targetElement.javaClass.simpleName} name='${(targetElement as? PsiNamedElement)?.name}' text='${targetElement.text?.take(80)}' file=${targetElement.containingFile?.name}")

            val usages = ConcurrentLinkedQueue<UsageLocation>()
            val totalFound = AtomicInteger(0)
            val totalCountLimit = collectLimit * 10
            val searchScope = BuiltInSearchScopeResolver.resolveGlobalScope(project, scope, excludeGenerated)

            try {
                val handler = findUsagesHandler(project, targetElement)
                if (handler != null) {
                    LOG.info("FindUsages: using FindUsagesHandler (${handler.javaClass.simpleName})")
                    val options = handler.getFindUsagesOptions(null)
                    handler.processElementUsages(targetElement, Processor { usageInfo ->
                        ProgressManager.checkCanceled()
                        val refElement = usageInfo.element ?: return@Processor true
                        if (refElement == targetElement) return@Processor true
                        val refFile = refElement.containingFile?.virtualFile
                        if (refFile != null && searchScope.contains(refFile) && !isProjectMetadataFile(refFile)) {
                            val total = totalFound.incrementAndGet()
                            if (total <= collectLimit) {
                                usageInfoToLocation(project, usageInfo, refElement)?.let { usages.add(it) }
                            }
                            total < totalCountLimit
                        } else {
                            true
                        }
                    }, options)
                } else {
                    ReferencesSearch.search(targetElement, searchScope).forEach(Processor { reference ->
                        ProgressManager.checkCanceled()

                        val refElement = reference.element
                        val refFile = refElement.containingFile?.virtualFile
                        if (refFile != null && searchScope.contains(refFile) && !isProjectMetadataFile(refFile)) {
                            val total = totalFound.incrementAndGet()

                            if (total <= collectLimit) {
                                val document = PsiDocumentManager.getInstance(project)
                                    .getDocument(refElement.containingFile)
                                if (document != null) {
                                    val lineNumber = document.getLineNumber(refElement.textOffset) + 1
                                    val columnNumber = refElement.textOffset -
                                        document.getLineStartOffset(lineNumber - 1) + 1

                                    val lineText = document.getText(
                                        TextRange(
                                            document.getLineStartOffset(lineNumber - 1),
                                            document.getLineEndOffset(lineNumber - 1)
                                        )
                                    ).trim()

                                    usages.add(UsageLocation(
                                        file = getRelativePath(project, refFile),
                                        line = lineNumber,
                                        column = columnNumber,
                                        context = lineText,
                                        type = classifyUsage(refElement),
                                        astPath = PsiUtils.getAstPath(refElement)
                                    ))
                                }
                            }

                            total < totalCountLimit
                        } else {
                            true
                        }
                    })
                }
            } catch (e: LinkageError) {
                LOG.warn("Reference search failed for ${targetElement.javaClass.name}", e)
                return@suspendingReadAction null to createErrorResult(searchInfrastructureErrorMessage(e))
            }

            val usagesList = usages.toList()
                .distinctBy { "${it.file}:${it.line}:${it.column}" }

            val smartPointer = SmartPointerManager.getInstance(project).createSmartPsiElementPointer(targetElement)

            val searchExtender: suspend (Set<String>, Int) -> List<PaginationService.SerializedResult> = { seenKeys, limit ->
                suspendingReadAction {
                    val el = smartPointer.element
                        ?: throw IllegalStateException("Target element no longer valid")
                    extendFindUsages(project, el, seenKeys, limit, scope, excludeGenerated)
                }
            }

            val serializedResults = usagesList.map { usage ->
                PaginationService.SerializedResult(
                    key = "${usage.file}:${usage.line}:${usage.column}",
                    data = json.encodeToJsonElement(usage)
                )
            }

            val paginationService = ApplicationManager.getApplication().getService(PaginationService::class.java)
            val token = paginationService.createCursor(
                toolName = name,
                results = serializedResults,
                seenKeys = serializedResults.map { it.key }.toSet(),
                searchExtender = searchExtender,
                psiModCount = PsiModificationTracker.getInstance(project).modificationCount,
                projectBasePath = ProjectResolver.normalizePath(project.basePath ?: "")
            )

            token to null
        }

        val (token, errorResult) = cursorToken
        if (errorResult != null) return errorResult

        return buildPaginatedResult<UsageLocation, FindUsagesResult>(getPageFromCache(token!!, pageSize, project)) { items, page ->
            FindUsagesResult(
                usages = items,
                totalCount = page.totalCollected,
                truncated = page.hasMore,
                nextCursor = page.nextCursor,
                hasMore = page.hasMore,
                totalCollected = page.totalCollected,
                offset = page.offset,
                pageSize = page.pageSize,
                stale = page.stale
            )
        }
    }

    private fun findUsagesHandler(project: Project, element: PsiElement): FindUsagesHandlerBase? {
        try {
            for (factory in FindUsagesHandlerFactory.EP_NAME.getExtensions(project)) {
                try {
                    if (factory.canFindUsages(element)) {
                        val handler = factory.createFindUsagesHandler(element, false)
                        if (handler != null) return handler
                    }
                } catch (_: Exception) {
                }
            }
        } catch (e: Throwable) {
            LOG.warn("FindUsagesHandlerFactory EP not available, falling back to ReferencesSearch", e)
        }
        return null
    }

    private fun usageInfoToLocation(project: Project, usageInfo: UsageInfo, refElement: PsiElement): UsageLocation? {
        val refFile = refElement.containingFile?.virtualFile ?: return null
        val document = PsiDocumentManager.getInstance(project).getDocument(refElement.containingFile) ?: return null
        val offset = usageInfo.navigationOffset
        val lineNumber = document.getLineNumber(offset) + 1
        val columnNumber = offset - document.getLineStartOffset(lineNumber - 1) + 1
        val lineText = document.getText(
            TextRange(
                document.getLineStartOffset(lineNumber - 1),
                document.getLineEndOffset(lineNumber - 1)
            )
        ).trim()
        return UsageLocation(
            file = getRelativePath(project, refFile),
            line = lineNumber,
            column = columnNumber,
            context = lineText,
            type = classifyUsage(refElement),
            astPath = PsiUtils.getAstPath(refElement)
        )
    }

    private fun extendFindUsages(
        project: Project,
        targetElement: PsiElement,
        seenKeys: Set<String>,
        limit: Int,
        scope: BuiltInSearchScope,
        excludeGenerated: Boolean
    ): List<PaginationService.SerializedResult> {
        val newResults = ConcurrentLinkedQueue<PaginationService.SerializedResult>()
        val count = AtomicInteger(0)
        val searchScope = BuiltInSearchScopeResolver.resolveGlobalScope(project, scope, excludeGenerated)

        try {
            val handler = findUsagesHandler(project, targetElement)
            if (handler != null) {
                val options = handler.getFindUsagesOptions(null)
                handler.processElementUsages(targetElement, Processor { usageInfo ->
                    ProgressManager.checkCanceled()
                    val refElement = usageInfo.element ?: return@Processor true
                    if (refElement == targetElement) return@Processor true
                    val refFile = refElement.containingFile?.virtualFile
                    if (refFile != null && searchScope.contains(refFile) && !isProjectMetadataFile(refFile)) {
                        val location = usageInfoToLocation(project, usageInfo, refElement) ?: return@Processor true
                        val key = "${location.file}:${location.line}:${location.column}"
                        if (key !in seenKeys) {
                            val slot = count.incrementAndGet()
                            if (slot <= limit) {
                                newResults.add(PaginationService.SerializedResult(key, json.encodeToJsonElement(location)))
                            }
                            slot < limit
                        } else {
                            true
                        }
                    } else {
                        true
                    }
                }, options)
            } else {
                ReferencesSearch.search(targetElement, searchScope).forEach(Processor { reference ->
                    ProgressManager.checkCanceled()
                    val refElement = reference.element
                    val refFile = refElement.containingFile?.virtualFile
                    if (refFile != null && searchScope.contains(refFile) && !isProjectMetadataFile(refFile)) {
                        val document = PsiDocumentManager.getInstance(project).getDocument(refElement.containingFile)
                        if (document != null) {
                            val lineNumber = document.getLineNumber(refElement.textOffset) + 1
                            val columnNumber = refElement.textOffset - document.getLineStartOffset(lineNumber - 1) + 1
                            val key = "${getRelativePath(project, refFile)}:$lineNumber:$columnNumber"

                            if (key !in seenKeys) {
                                val slot = count.incrementAndGet()
                                if (slot <= limit) {
                                    val lineText = document.getText(
                                        TextRange(document.getLineStartOffset(lineNumber - 1), document.getLineEndOffset(lineNumber - 1))
                                    ).trim()
                                    val usage = UsageLocation(
                                        file = getRelativePath(project, refFile),
                                        line = lineNumber,
                                        column = columnNumber,
                                        context = lineText,
                                        type = classifyUsage(refElement),
                                        astPath = PsiUtils.getAstPath(refElement)
                                    )
                                    newResults.add(PaginationService.SerializedResult(key, json.encodeToJsonElement(usage)))
                                }
                                slot < limit
                            } else {
                                true
                            }
                        } else true
                    } else true
                })
            }
        } catch (e: LinkageError) {
            LOG.warn("Reference search pagination failed for ${targetElement.javaClass.name}", e)
            throw IllegalStateException(searchInfrastructureErrorMessage(e), e)
        }

        return newResults.toList()
    }

    private fun classifyUsage(element: PsiElement): String {
        val parent = element.parent ?: return UsageTypes.REFERENCE
        val parentClass = parent.javaClass.simpleName

        return when {
            // Order matters: more specific patterns first.
            parentClass.contains("MethodCall") || parentClass.contains("Invocation") -> UsageTypes.METHOD_CALL
            parentClass.contains("NewExpression") || parentClass.contains("ObjectCreation") ||
                parentClass.contains("ArrayCreation") -> UsageTypes.CONSTRUCTOR_CALL
            parentClass.contains("TypeOf") || parentClass.contains("TypeArgument") ||
                parentClass.contains("TypeUsage") -> UsageTypes.TYPE_REFERENCE
            parentClass.contains("Attribute") -> UsageTypes.ATTRIBUTE
            parentClass.contains("FieldDeclaration") -> UsageTypes.FIELD_DECLARATION
            parentClass.contains("PropertyDeclaration") -> UsageTypes.PROPERTY_DECLARATION
            parentClass.contains("Field") -> UsageTypes.FIELD_ACCESS
            parentClass.contains("Import") || parentClass.contains("Using") -> UsageTypes.IMPORT
            parentClass.contains("Parameter") -> UsageTypes.PARAMETER
            parentClass.contains("Variable") -> UsageTypes.VARIABLE
            else -> UsageTypes.REFERENCE
        }
    }

    private fun classifyRdUsage(usage: RiderProtocolHost.RdUsageResult): String {
        // Rider's UsageView attaches a group describing the kind of usage
        // (e.g. "New instance creation", "Type argument", "Field declaration").
        // Prefer that over read/write flags, which only describe value access
        // and are meaningless for type-level references.
        for (group in usage.groupTexts) {
            classifyFromGroupText(group)?.let { return it }
        }
        return when {
            usage.isWrite -> UsageTypes.WRITE
            usage.isRead -> UsageTypes.READ
            else -> UsageTypes.REFERENCE
        }
    }

    private fun classifyFromGroupText(text: String): String? {
        if (text.isBlank()) return null
        val t = text.lowercase()
        return when {
            "typeof" in t -> UsageTypes.TYPE_REFERENCE
            "type argument" in t -> UsageTypes.TYPE_REFERENCE
            "type constraint" in t -> UsageTypes.TYPE_REFERENCE
            "base type" in t || "base class" in t || "base interface" in t -> UsageTypes.TYPE_REFERENCE
            "type check" in t || "is-expression" in t || "is expression" in t -> UsageTypes.TYPE_REFERENCE
            "cast" in t -> UsageTypes.TYPE_REFERENCE
            "extends list" in t || "implements list" in t -> UsageTypes.TYPE_REFERENCE
            "new instance" in t || "object creation" in t -> UsageTypes.CONSTRUCTOR_CALL
            "new array" in t || "array creation" in t -> UsageTypes.CONSTRUCTOR_CALL
            "attribute" in t -> UsageTypes.ATTRIBUTE
            "field declaration" in t -> UsageTypes.FIELD_DECLARATION
            "property declaration" in t -> UsageTypes.PROPERTY_DECLARATION
            "method declaration" in t || "function declaration" in t -> UsageTypes.METHOD_DECLARATION
            "method call" in t || "method invocation" in t || "invocation" in t -> UsageTypes.METHOD_CALL
            "member access" in t || "static class member access" in t || "nameof" in t -> UsageTypes.MEMBER_ACCESS
            "parameter declaration" in t -> UsageTypes.PARAMETER
            "local variable" in t || "variable declaration" in t -> UsageTypes.VARIABLE
            "using directive" in t || "import" in t -> UsageTypes.IMPORT
            else -> null
        }
    }

    private suspend fun tryRiderFindUsages(
        project: Project,
        filePath: String,
        line: Int,
        column: Int,
        pageSize: Int
    ): ToolCallResult? {
        val virtualFile = PsiUtils.resolveVirtualFileAnywhere(project, filePath) ?: return null
        if (!RiderProtocolHost.shouldUseRiderProtocol(virtualFile)) return null

        val document = suspendingReadAction {
            PsiUtils.getPsiFile(project, filePath)?.let {
                PsiDocumentManager.getInstance(project).getDocument(it)
            }
        } ?: return null

        val offset = getOffset(document, line, column) ?: return null

        val rdUsages = RiderProtocolHost.findUsagesViaRd(project, virtualFile, offset) ?: return null

        val usages = rdUsages.map { usage ->
            val relPath = ProjectUtils.getRelativePath(project, usage.filePath)
            val type = classifyRdUsage(usage)
            UsageLocation(
                file = relPath,
                line = usage.line,
                column = usage.column,
                context = usage.text.trim(),
                type = type,
                astPath = usage.groupTexts
            )
        }.distinctBy { "${it.file}:${it.line}:${it.column}" }

        val displayUsages = usages.take(pageSize)

        return createJsonResult(FindUsagesResult(
            usages = displayUsages,
            totalCount = usages.size,
            truncated = usages.size > pageSize,
            nextCursor = null,
            hasMore = usages.size > pageSize,
            totalCollected = usages.size,
            offset = 0,
            pageSize = pageSize,
            stale = false
        ))
    }
}
