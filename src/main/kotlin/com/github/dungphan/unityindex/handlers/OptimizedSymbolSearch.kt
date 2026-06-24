package com.github.dungphan.unityindex.handlers

import com.github.dungphan.unityindex.util.ProjectUtils
import com.github.dungphan.unityindex.util.RiderNavigationProbe
import com.intellij.navigation.ChooseByNameContributor
import com.intellij.navigation.ChooseByNameContributorEx
import com.intellij.navigation.NavigationItem
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiNameIdentifierOwner
import com.intellij.psi.PsiNamedElement
import com.intellij.psi.codeStyle.MinusculeMatcher
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.util.indexing.FindSymbolParameters

/**
 * Optimized symbol search using IntelliJ's built-in infrastructure.
 *
 * This class leverages the same APIs that power IntelliJ's "Go to Symbol" dialog (Ctrl+Alt+Shift+N),
 * providing optimized search with caching, word index, and prefix matching.
 *
 * ## Performance Characteristics
 *
 * - Uses [DefaultChooseByNameItemProvider] which has internal optimizations
 * - Leverages registered [ChooseByNameContributor]s for all languages
 * - Uses [MinusculeMatcher] for CamelCase, substring, and typo-tolerant matching
 * - Early termination when limit is reached
 *
 * ## Usage
 *
 * ```kotlin
 * val results = OptimizedSymbolSearch.search(project, "UserService", scope, limit = 25)
 * ```
 */
object OptimizedSymbolSearch {

    private val LOG = logger<OptimizedSymbolSearch>()

    /**
     * Search for symbols using the optimized platform infrastructure.
     *
     * @param project The project to search in
     * @param pattern The search pattern (supports CamelCase, substring, and typo-tolerant matching)
     * @param scope The search scope (project only or including libraries)
     * @param limit Maximum number of results to return
     * @param languageFilter Optional filter to restrict results to specific languages
     * @return List of matching symbols
     */
    fun search(
        project: Project,
        pattern: String,
        scope: GlobalSearchScope,
        limit: Int,
        languageFilter: Set<String>? = null
    ): List<SymbolData> {
        if (pattern.isBlank()) return emptyList()

        LOG.debug("Searching for symbols matching '$pattern' (limit=$limit, filter=$languageFilter)")

        try {
            var popupLimit = limit
            val popupLimitCap = maxOf(limit * 8, limit + 200)

            while (true) {
                val popupResults = PopupFaithfulSymbolSearch.search(project, pattern, scope, popupLimit)
                val results = popupResults.candidates
                    .mapNotNull { candidate -> convertToSymbolData(candidate.item, project, scope, languageFilter) }
                    .distinctBy { "${it.file}:${it.line}:${it.column}:${it.name}" }

                if (results.size >= limit || popupResults.candidates.size < popupLimit || popupLimit >= popupLimitCap) {
                    LOG.debug("Found ${results.size} symbols via popup-backed search")
                    return results.take(limit)
                }

                popupLimit = minOf(popupLimitCap, popupLimit * 2)
            }
        } catch (e: Exception) {
            LOG.debug("Popup-backed symbol search failed, falling back to contributor iteration: ${e.message}", e)
        }

        return legacySearch(project, pattern, scope, limit, languageFilter)
    }

    /**
     * Legacy contributor iteration path kept as a fallback if the popup-backed search fails.
     */
    private fun legacySearch(
        project: Project,
        pattern: String,
        scope: GlobalSearchScope,
        limit: Int,
        languageFilter: Set<String>? = null
    ): List<SymbolData> {
        val results = mutableListOf<SymbolData>()
        val seen = mutableSetOf<String>() // Deduplication key: file:line:column:name
        val matcher = createMatcher(pattern)
        val nameFilter = createNameFilter(pattern, matcher)

        for (contributor in ChooseByNameContributor.SYMBOL_EP_NAME.extensionList) {
            if (results.size >= limit) break

            try {
                processContributor(contributor, project, pattern, scope, limit, languageFilter, nameFilter, matcher, results, seen)
            } catch (e: Exception) {
                LOG.debug("Error processing contributor ${contributor.javaClass.simpleName}: ${e.message}")
            }
        }

        val sortedResults = results.sortedWith(compareBy(
            { !it.name.equals(pattern, ignoreCase = true) },
            { -matcher.matchingDegree(it.name) }
        ))

        LOG.debug("Found ${sortedResults.size} symbols via legacy contributor iteration")
        return sortedResults.take(limit)
    }

    private fun processContributor(
        contributor: ChooseByNameContributor,
        project: Project,
        pattern: String,
        scope: GlobalSearchScope,
        limit: Int,
        languageFilter: Set<String>?,
        nameFilter: (String) -> Boolean,
        matcher: MinusculeMatcher,
        results: MutableList<SymbolData>,
        seen: MutableSet<String>
    ) {
        if (contributor is ChooseByNameContributorEx) {
            // Modern API with Processor pattern - streaming, memory efficient
            val matchingNames = mutableListOf<String>()

            contributor.processNames(
                { name ->
                    if (nameFilter(name)) {
                        matchingNames.add(name)
                    }
                    matchingNames.size < limit * 3 // Collect extra for filtering
                },
                scope,
                null
            )

            for (name in matchingNames) {
                if (results.size >= limit) break

                val params = FindSymbolParameters.wrap(pattern, scope)
                contributor.processElementsWithName(
                    name,
                    { item ->
                        if (results.size >= limit) return@processElementsWithName false

                        val symbolData = convertToSymbolData(item, project, scope, languageFilter)
                        if (symbolData != null) {
                            val key = "${symbolData.file}:${symbolData.line}:${symbolData.column}:${symbolData.name}"
                            if (key !in seen) {
                                seen.add(key)
                                results.add(symbolData)
                            }
                        }
                        true
                    },
                    params
                )
            }
        } else {
            // Legacy API - load all names then filter
            val names = contributor.getNames(project, true)
            val matchingNames = names.filter { nameFilter(it) }

            for (name in matchingNames) {
                if (results.size >= limit) break

                val items = contributor.getItemsByName(name, pattern, project, true)
                for (item in items) {
                    if (results.size >= limit) break

                    val symbolData = convertToSymbolData(item, project, scope, languageFilter)
                    if (symbolData != null) {
                        val key = "${symbolData.file}:${symbolData.line}:${symbolData.column}:${symbolData.name}"
                        if (key !in seen) {
                            seen.add(key)
                            results.add(symbolData)
                        }
                    }
                }
            }
        }
    }

    /**
     * Convert a NavigationItem or PsiElement to SymbolData.
     *
     * Returns null when the item can't be located to a real source position. In Rider, C# symbols
     * arrive as RD-backed proxy NavigationItems whose PSI surface reports textOffset=0 and empty
     * Language; emitting them as (line: 1, column: 1) would look like a text-search fallback to
     * callers. We try PSI first, then fall back to a reflective probe of the NavigationItem itself.
     */
    private fun convertToSymbolData(
        item: NavigationItem,
        project: Project,
        scope: GlobalSearchScope,
        languageFilter: Set<String>?
    ): SymbolData? {
        val element = when (item) {
            is PsiElement -> item
            else -> {
                try {
                    val method = item.javaClass.getMethod("getElement")
                    method.invoke(item) as? PsiElement
                } catch (_: Exception) {
                    null
                }
            }
        } ?: return null

        val targetElement = element.navigationElement ?: element
        val psiLanguage = getLanguageName(targetElement)

        val name = when (targetElement) {
            is PsiNamedElement -> targetElement.name
            else -> {
                try {
                    val method = targetElement.javaClass.getMethod("getName")
                    method.invoke(targetElement) as? String
                } catch (_: Exception) {
                    null
                }
            }
        }?.takeIf { it.isNotBlank() } ?: item.name?.takeIf { it.isNotBlank() } ?: return null

        val directQualifiedName = try {
            val method = targetElement.javaClass.getMethod("getQualifiedName")
            method.invoke(targetElement) as? String
        } catch (_: Exception) {
            null
        }
        val qualifiedName = directQualifiedName ?: buildQualifiedNameFromContainer(targetElement, name)

        val position = resolvePosition(item, targetElement, project) ?: return null
        if (!scope.contains(position.file)) return null

        val language = if (psiLanguage.isNotBlank()) psiLanguage else inferLanguageFromExtension(position.file)
        if (languageFilter != null && languageFilter.none { it.equals(language, ignoreCase = true) }) {
            return null
        }

        val relativePath = ProjectUtils.getToolFilePath(project, position.file)
        val kind = determineKind(targetElement)
        val containerName = getContainerName(targetElement)

        return SymbolData(
            name = name,
            qualifiedName = qualifiedName,
            kind = kind,
            file = relativePath,
            line = position.line,
            column = position.column,
            containerName = containerName,
            language = language
        )
    }

    private data class ResolvedPosition(val file: VirtualFile, val line: Int, val column: Int)

    private fun resolvePosition(
        item: NavigationItem,
        targetElement: PsiElement,
        project: Project
    ): ResolvedPosition? {
        val psiFile = targetElement.containingFile?.virtualFile
        if (psiFile != null) {
            val document = getDocument(project, targetElement)
            val offset = document?.let { resolveOffset(targetElement, it) }
            if (document != null && offset != null) {
                val lineIndex = document.getLineNumber(offset)
                val column = offset - document.getLineStartOffset(lineIndex) + 1
                return ResolvedPosition(psiFile, lineIndex + 1, column)
            }
        }

        val probe = RiderNavigationProbe.probe(item, project)
        if (probe != null) {
            LOG.debug("Recovered position via RiderNavigationProbe: ${item.javaClass.name} -> ${probe.file.name}:${probe.line}:${probe.column}")
            return ResolvedPosition(probe.file, probe.line, probe.column)
        }

        LOG.debug("Dropping symbol: no resolvable position for ${item.javaClass.name}")
        return null
    }

    private fun inferLanguageFromExtension(file: VirtualFile): String {
        return when (file.extension?.lowercase()) {
            "cs" -> "C#"
            "shader" -> "ShaderLab"
            "uxml" -> "XML"
            "uss" -> "CSS"
            else -> ""
        }
    }

    private fun buildQualifiedNameFromContainer(element: PsiElement, name: String): String? {
        var parent = element.parent

        while (parent != null) {
            try {
                val method = parent.javaClass.getMethod("getQualifiedName")
                val parentQualifiedName = method.invoke(parent) as? String
                if (!parentQualifiedName.isNullOrBlank()) {
                    return "$parentQualifiedName.$name"
                }
            } catch (_: Exception) {
                // Ignore and continue walking up the PSI tree.
            }
            parent = parent.parent
        }

        return null
    }

    private fun getLanguageName(element: PsiElement): String {
        return when (element.language.id) {
            "C#" -> "C#"
            else -> element.language.displayName
        }
    }

    private fun getDocument(project: Project, element: PsiElement): com.intellij.openapi.editor.Document? {
        val psiFile = element.containingFile ?: return null
        return PsiDocumentManager.getInstance(project).getDocument(psiFile)
            ?: psiFile.virtualFile?.let {
                com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().getDocument(it)
            }
    }

    private fun getLineNumber(project: Project, element: PsiElement): Int? {
        val document = getDocument(project, element) ?: return null
        val offset = resolveOffset(element, document) ?: return null
        return document.getLineNumber(offset) + 1
    }

    private fun getColumnNumber(project: Project, element: PsiElement): Int? {
        val document = getDocument(project, element) ?: return null
        val offset = resolveOffset(element, document) ?: return null
        val lineNumber = document.getLineNumber(offset)
        return offset - document.getLineStartOffset(lineNumber) + 1
    }

    /**
     * Returns null when the element doesn't expose a usable source offset — typically Rider RD-backed
     * proxy elements where textOffset == 0 and textRange is empty. Callers should treat null as
     * "this element can't be positioned via PSI" and fall back to a NavigationItem-level probe.
     */
    private fun resolveOffset(element: PsiElement, document: com.intellij.openapi.editor.Document): Int? {
        // Prefer the name identifier's offset — for a class declaration with leading attributes
        // like [CreateAssetMenu(...)], element.textOffset can point at the attribute (or to 0)
        // while the actual identifier sits later in the declaration.
        val nameIdentifierOffset = (element as? PsiNameIdentifierOwner)?.nameIdentifier?.textOffset
        if (nameIdentifierOffset != null && nameIdentifierOffset > 0) return nameIdentifierOffset

        val offset = element.textOffset
        if (offset > 0) return offset

        val rawName = (element as? PsiNamedElement)?.name
            ?: try { element.javaClass.getMethod("getName").invoke(element) as? String } catch (_: Exception) { null }
        if (rawName != null && rawName.length > 1) {
            val identifier = rawName.substringBefore('(').substringBefore(':').trim()
            if (identifier.isNotEmpty()) {
                // Scope the regex search to the element's own text range — searching the whole
                // document would otherwise return the first occurrence anywhere in the file,
                // including inside earlier string literals, comments, or attribute arguments.
                val elementRange = element.textRange
                if (elementRange != null && elementRange.length > 0) {
                    val rangeStart = elementRange.startOffset.coerceAtLeast(0)
                    val rangeEnd = elementRange.endOffset.coerceAtMost(document.textLength)
                    if (rangeStart < rangeEnd) {
                        val haystack = document.getText(com.intellij.openapi.util.TextRange(rangeStart, rangeEnd))
                        val identifierPattern = Regex("\\b${Regex.escape(identifier)}\\b")
                        val match = identifierPattern.find(haystack)
                        if (match != null) return rangeStart + match.range.first
                    }
                }
            }
        }
        return null
    }

    private fun determineKind(element: PsiElement): String {
        val className = element.javaClass.simpleName.lowercase()
        return when {
            className.contains("class") -> "CLASS"
            className.contains("interface") -> "INTERFACE"
            className.contains("enum") -> "ENUM"
            className.contains("struct") -> "STRUCT"
            className.contains("trait") -> "TRAIT"
            className.contains("method") -> "METHOD"
            className.contains("function") -> "FUNCTION"
            className.contains("field") -> "FIELD"
            className.contains("variable") -> "VARIABLE"
            className.contains("property") -> "PROPERTY"
            className.contains("constant") -> "CONSTANT"
            else -> "SYMBOL"
        }
    }

    private fun getContainerName(element: PsiElement): String? {
        return try {
            // Try to find containing class/type
            var parent = element.parent
            while (parent != null) {
                val parentClassName = parent.javaClass.simpleName.lowercase()
                if (parentClassName.contains("class") || parentClassName.contains("type")) {
                    val nameMethod = parent.javaClass.getMethod("getName")
                    return nameMethod.invoke(parent) as? String
                }
                parent = parent.parent
            }
            null
        } catch (e: Exception) {
            null
        }
    }

    // Delegated to shared SearchMatchUtils.createMatcher — kept as private alias for call-site clarity
    private fun createMatcher(pattern: String): MinusculeMatcher =
        com.github.dungphan.unityindex.handlers.createMatcher(pattern)

    // Delegated to shared SearchMatchUtils.createNameFilter
    private fun createNameFilter(pattern: String, matcher: MinusculeMatcher): (String) -> Boolean =
        com.github.dungphan.unityindex.handlers.createNameFilter(pattern, "substring", matcher)
}
