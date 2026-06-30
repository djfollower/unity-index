package com.github.dungphan.unityindex.util

import com.github.dungphan.unityindex.handlers.BuiltInSearchScope
import com.github.dungphan.unityindex.handlers.BuiltInSearchScopeResolver
import com.github.dungphan.unityindex.handlers.CallElementData
import com.github.dungphan.unityindex.handlers.CallHierarchyData
import com.github.dungphan.unityindex.handlers.ImplementationData
import com.github.dungphan.unityindex.handlers.MethodData
import com.github.dungphan.unityindex.handlers.SuperMethodData
import com.github.dungphan.unityindex.handlers.SuperMethodsData
import com.github.dungphan.unityindex.handlers.TypeElementData
import com.github.dungphan.unityindex.handlers.TypeHierarchyData
import com.intellij.find.findUsages.FindUsagesHandlerBase
import com.intellij.find.findUsages.FindUsagesHandlerFactory
import com.intellij.ide.hierarchy.HierarchyBrowserBaseEx
import com.intellij.ide.hierarchy.HierarchyNodeDescriptor
import com.intellij.ide.hierarchy.HierarchyProvider
import com.intellij.ide.hierarchy.HierarchyTreeStructure
import com.intellij.ide.hierarchy.LanguageCallHierarchy
import com.intellij.ide.hierarchy.LanguageTypeHierarchy
import com.intellij.ide.hierarchy.TypeHierarchyBrowserBase
import com.intellij.lang.LanguageExtension
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiNamedElement
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.psi.search.searches.DefinitionsScopedSearch
import com.intellij.psi.util.PsiTreeUtil
import com.intellij.usageView.UsageInfo
import com.intellij.util.Processor

object PlatformFallbacks {

    private val LOG = logger<PlatformFallbacks>()

    // ── FindImplementations (platform-generic via DefinitionsScopedSearch) ──

    fun findImplementations(
        element: PsiElement,
        project: Project,
        scope: BuiltInSearchScope = BuiltInSearchScope.PROJECT_FILES,
        excludeGenerated: Boolean = false
    ): List<ImplementationData>? {
        val target = PsiUtils.resolveTargetElement(element) ?: PsiUtils.findNamedElement(element) ?: return null
        val searchScope = BuiltInSearchScopeResolver.resolveGlobalScope(project, scope, excludeGenerated)

        val results = mutableListOf<ImplementationData>()
        try {
            DefinitionsScopedSearch.search(target, searchScope).forEach { impl ->
                ProgressManager.checkCanceled()
                val loc = elementToLocation(project, impl)
                if (loc != null) {
                    results.add(ImplementationData(
                        name = (impl as? PsiNamedElement)?.name ?: impl.text.take(50),
                        file = loc.file,
                        line = loc.line,
                        column = loc.column,
                        kind = classifyElementKind(impl),
                        language = impl.language.displayName
                    ))
                }
                true
            }
        } catch (e: Exception) {
            LOG.debug("DefinitionsScopedSearch failed: ${e.message}", e)
        }

        if (results.isEmpty()) return null
        return results
    }

    // ── TypeHierarchy (platform-generic via HierarchyProvider EP) ──

    fun getTypeHierarchy(
        element: PsiElement,
        project: Project,
        scope: BuiltInSearchScope = BuiltInSearchScope.PROJECT_FILES,
        excludeGenerated: Boolean = false
    ): TypeHierarchyData? {
        val target = PsiUtils.resolveTargetElement(element) ?: PsiUtils.findNamedElement(element) ?: return null
        val elementData = elementToTypeData(project, target) ?: return null

        val provider = findTypeHierarchyProvider(target) ?: return null
        val dataContext = SimpleDataContext.builder()
            .add(CommonDataKeys.PSI_ELEMENT, target)
            .add(CommonDataKeys.PROJECT, project)
            .build()

        val providerTarget = try {
            provider.getTarget(dataContext)
        } catch (e: Exception) {
            LOG.debug("HierarchyProvider.getTarget failed: ${e.message}", e)
            null
        } ?: return null

        val supertypes = mutableListOf<TypeElementData>()
        val subtypes = mutableListOf<TypeElementData>()

        try {
            val browser = provider.createHierarchyBrowser(providerTarget) as? HierarchyBrowserBaseEx
            if (browser != null) {
                extractHierarchyNodes(browser, TypeHierarchyBrowserBase.getSupertypesHierarchyType(), project, supertypes)
                extractHierarchyNodes(browser, TypeHierarchyBrowserBase.getSubtypesHierarchyType(), project, subtypes)
            }
        } catch (e: Exception) {
            LOG.debug("TypeHierarchy browser extraction failed: ${e.message}", e)
            // Fallback: use DefinitionsScopedSearch for subtypes
            val searchScope = BuiltInSearchScopeResolver.resolveGlobalScope(project, scope, excludeGenerated)
            try {
                DefinitionsScopedSearch.search(providerTarget, searchScope).forEach { impl ->
                    ProgressManager.checkCanceled()
                    val data = elementToTypeData(project, impl)
                    if (data != null) subtypes.add(data)
                    true
                }
            } catch (_: Exception) {}
        }

        return TypeHierarchyData(
            element = elementData,
            supertypes = supertypes,
            subtypes = subtypes
        )
    }

    // ── CallHierarchy (platform-generic via HierarchyProvider EP + FindUsagesHandler) ──

    fun getCallHierarchy(
        element: PsiElement,
        project: Project,
        direction: String,
        depth: Int,
        scope: BuiltInSearchScope = BuiltInSearchScope.PROJECT_FILES,
        excludeGenerated: Boolean = false
    ): CallHierarchyData? {
        val target = PsiUtils.resolveTargetElement(element) ?: PsiUtils.findNamedElement(element) ?: return null
        val elementData = elementToCallData(project, target) ?: return null

        val calls = mutableListOf<CallElementData>()

        if (direction == "callers") {
            // Use FindUsagesHandler to find callers
            val searchScope = BuiltInSearchScopeResolver.resolveGlobalScope(project, scope, excludeGenerated)
            findCallers(target, project, searchScope, calls, currentDepth = 0, maxDepth = depth)
        } else {
            // Try HierarchyProvider for callees
            val provider = findCallHierarchyProvider(target)
            if (provider != null) {
                val dataContext = SimpleDataContext.builder()
                    .add(CommonDataKeys.PSI_ELEMENT, target)
                    .add(CommonDataKeys.PROJECT, project)
                    .build()
                val providerTarget = try { provider.getTarget(dataContext) } catch (_: Exception) { null }
                if (providerTarget != null) {
                    try {
                        val browser = provider.createHierarchyBrowser(providerTarget) as? HierarchyBrowserBaseEx
                        if (browser != null) {
                            val callData = mutableListOf<TypeElementData>()
                            extractHierarchyNodes(browser, "Callees of ${(target as? PsiNamedElement)?.name ?: ""}", project, callData)
                            callData.forEach { data ->
                                calls.add(CallElementData(
                                    name = data.name,
                                    file = data.file ?: "",
                                    line = data.line ?: 0,
                                    column = 1,
                                    language = data.language
                                ))
                            }
                        }
                    } catch (e: Exception) {
                        LOG.debug("Call hierarchy browser failed: ${e.message}", e)
                    }
                }
            }
        }

        return CallHierarchyData(element = elementData, calls = calls)
    }

    // ── FindSuperMethods (platform-generic) ──

    fun findSuperMethods(element: PsiElement, project: Project): SuperMethodsData? {
        val target = PsiUtils.resolveTargetElement(element) ?: PsiUtils.findNamedElement(element) ?: return null

        val loc = elementToLocation(project, target) ?: return null
        val methodData = MethodData(
            name = (target as? PsiNamedElement)?.name ?: target.text.take(50),
            signature = getSignature(target),
            containingClass = getContainingClassName(target),
            file = loc.file,
            line = loc.line,
            column = loc.column,
            language = target.language.displayName
        )

        val hierarchy = mutableListOf<SuperMethodData>()

        // Use type hierarchy to walk supertypes and find matching methods
        val containingClass = findContainingClass(target)
        if (containingClass != null) {
            val provider = findTypeHierarchyProvider(containingClass)
            if (provider != null) {
                val dataContext = SimpleDataContext.builder()
                    .add(CommonDataKeys.PSI_ELEMENT, containingClass)
                    .add(CommonDataKeys.PROJECT, project)
                    .build()
                val providerTarget = try { provider.getTarget(dataContext) } catch (_: Exception) { null }
                if (providerTarget != null) {
                    try {
                        val browser = provider.createHierarchyBrowser(providerTarget) as? HierarchyBrowserBaseEx
                        if (browser != null) {
                            val supertypes = mutableListOf<TypeElementData>()
                            extractHierarchyNodes(browser, TypeHierarchyBrowserBase.getSupertypesHierarchyType(), project, supertypes)
                            val methodName = (target as? PsiNamedElement)?.name
                            if (methodName != null) {
                                for ((index, supertype) in supertypes.withIndex()) {
                                    hierarchy.add(SuperMethodData(
                                        name = methodName,
                                        signature = methodName,
                                        containingClass = supertype.name,
                                        containingClassKind = supertype.kind,
                                        file = supertype.file,
                                        line = supertype.line,
                                        column = null,
                                        isInterface = supertype.kind == "interface",
                                        depth = index + 1,
                                        language = supertype.language
                                    ))
                                }
                            }
                        }
                    } catch (e: Exception) {
                        LOG.debug("Super methods hierarchy walk failed: ${e.message}", e)
                    }
                }
            }
        }

        return SuperMethodsData(method = methodData, hierarchy = hierarchy)
    }

    // ── Private helpers ──

    private fun findTypeHierarchyProvider(element: PsiElement): HierarchyProvider? {
        return findProviderForLanguage(LanguageTypeHierarchy.INSTANCE, element)
    }

    private fun findCallHierarchyProvider(element: PsiElement): HierarchyProvider? {
        return findProviderForLanguage(LanguageCallHierarchy.INSTANCE, element)
    }

    private fun findProviderForLanguage(extension: LanguageExtension<HierarchyProvider>, element: PsiElement): HierarchyProvider? {
        try {
            val providers = extension.allForLanguage(element.language)
            for (p in providers) {
                try {
                    val dataContext = SimpleDataContext.builder()
                        .add(CommonDataKeys.PSI_ELEMENT, element)
                        .add(CommonDataKeys.PROJECT, element.project)
                        .build()
                    if (p.getTarget(dataContext) != null) return p
                } catch (_: Exception) {}
            }
            val fileLanguage = element.containingFile?.language
            if (fileLanguage != null && fileLanguage != element.language) {
                val fileProviders = extension.allForLanguage(fileLanguage)
                for (p in fileProviders) {
                    try {
                        val dataContext = SimpleDataContext.builder()
                            .add(CommonDataKeys.PSI_ELEMENT, element)
                            .add(CommonDataKeys.PROJECT, element.project)
                            .build()
                        if (p.getTarget(dataContext) != null) return p
                    } catch (_: Exception) {}
                }
            }
        } catch (e: Exception) {
            LOG.debug("HierarchyProvider lookup failed: ${e.message}", e)
        }
        return null
    }

    private fun extractHierarchyNodes(
        browser: HierarchyBrowserBaseEx,
        hierarchyType: String,
        project: Project,
        results: MutableList<TypeElementData>
    ) {
        try {
            browser.changeView(hierarchyType)
            val treeModel = browser.getTreeModel(hierarchyType) ?: return
            val root = treeModel.root
            collectDescriptorChildren(root, project, results, visited = mutableSetOf(), depth = 0, maxDepth = 20)
        } catch (e: Exception) {
            LOG.debug("extractHierarchyNodes failed for $hierarchyType: ${e.message}", e)
        }
    }

    private fun collectDescriptorChildren(
        node: Any?,
        project: Project,
        results: MutableList<TypeElementData>,
        visited: MutableSet<Any>,
        depth: Int,
        maxDepth: Int
    ) {
        if (node == null || depth >= maxDepth || !visited.add(node)) return
        val descriptor = node as? HierarchyNodeDescriptor
        if (descriptor != null && depth > 0) {
            val psiElement = descriptor.psiElement
            if (psiElement != null) {
                val data = elementToTypeData(project, psiElement)
                if (data != null) results.add(data)
            }
        }
    }

    private fun findCallers(
        target: PsiElement,
        project: Project,
        searchScope: GlobalSearchScope,
        results: MutableList<CallElementData>,
        currentDepth: Int,
        maxDepth: Int
    ) {
        if (currentDepth >= maxDepth) return

        val handler = findUsagesHandler(target)
        if (handler != null) {
            val options = handler.getFindUsagesOptions(null)
            handler.processElementUsages(target, Processor { usageInfo ->
                ProgressManager.checkCanceled()
                val refElement = usageInfo.element ?: return@Processor true
                if (refElement == target) return@Processor true
                val refFile = refElement.containingFile?.virtualFile
                if (refFile != null && searchScope.contains(refFile)) {
                    val callerMethod = PsiUtils.findNamedElement(refElement)
                    if (callerMethod != null) {
                        val data = elementToCallData(project, callerMethod)
                        if (data != null && results.none { it.file == data.file && it.line == data.line }) {
                            results.add(data)
                        }
                    }
                }
                results.size < 100
            }, options)
        }
    }

    private fun findUsagesHandler(element: PsiElement): FindUsagesHandlerBase? {
        try {
            for (factory in FindUsagesHandlerFactory.EP_NAME.extensionList) {
                try {
                    if (factory.canFindUsages(element)) {
                        val handler = factory.createFindUsagesHandler(element, false)
                        if (handler != null) return handler
                    }
                } catch (_: Exception) {}
            }
        } catch (_: Throwable) {}
        return null
    }

    data class LocationInfo(val file: String, val line: Int, val column: Int)

    private fun elementToLocation(project: Project, element: PsiElement): LocationInfo? {
        val file = element.containingFile?.virtualFile ?: return null
        val document = PsiDocumentManager.getInstance(project).getDocument(element.containingFile) ?: return null
        val line = document.getLineNumber(element.textOffset) + 1
        val column = element.textOffset - document.getLineStartOffset(line - 1) + 1
        return LocationInfo(
            file = ProjectUtils.getRelativePath(project, file),
            line = line,
            column = column
        )
    }

    private fun elementToTypeData(project: Project, element: PsiElement): TypeElementData? {
        val name = (element as? PsiNamedElement)?.name ?: return null
        val loc = elementToLocation(project, element)
        val qualifiedName = try {
            element.javaClass.getMethod("getQualifiedName").invoke(element) as? String
        } catch (_: Exception) {
            null
        }
        return TypeElementData(
            name = name,
            qualifiedName = qualifiedName,
            file = loc?.file,
            line = loc?.line,
            kind = classifyElementKind(element),
            language = element.language.displayName
        )
    }

    private fun elementToCallData(project: Project, element: PsiElement): CallElementData? {
        val name = (element as? PsiNamedElement)?.name ?: element.text.take(50)
        val loc = elementToLocation(project, element) ?: return null
        return CallElementData(
            name = name,
            file = loc.file,
            line = loc.line,
            column = loc.column,
            language = element.language.displayName
        )
    }

    internal fun classifyElementKind(element: PsiElement): String {
        val className = element.javaClass.simpleName.lowercase()
        return when {
            className.contains("interface") -> "interface"
            className.contains("enum") -> "enum"
            className.contains("class") -> "class"
            className.contains("method") || className.contains("function") -> "method"
            className.contains("field") || className.contains("property") -> "field"
            else -> "class"
        }
    }

    private fun getSignature(element: PsiElement): String {
        return try {
            val text = element.text
            val firstLine = text.lines().first()
            if (firstLine.length > 200) firstLine.take(200) + "..." else firstLine
        } catch (_: Exception) {
            (element as? PsiNamedElement)?.name ?: "unknown"
        }
    }

    private fun getContainingClassName(element: PsiElement): String {
        var parent = element.parent
        while (parent != null && parent !is PsiFile) {
            if (parent is PsiNamedElement && parent.name != null) {
                val kind = classifyElementKind(parent)
                if (kind in listOf("class", "interface", "enum")) {
                    return parent.name ?: "unknown"
                }
            }
            parent = parent.parent
        }
        return "unknown"
    }

    internal fun findContainingClass(element: PsiElement): PsiElement? {
        var parent = element.parent
        while (parent != null && parent !is PsiFile) {
            val kind = classifyElementKind(parent)
            if (kind in listOf("class", "interface", "enum")) {
                return parent
            }
            parent = parent.parent
        }
        return null
    }
}
