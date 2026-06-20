package com.github.dungphan.unityindex.util

import com.github.dungphan.unityindex.handlers.PopupFaithfulSymbolSearch
import com.intellij.navigation.NavigationItem
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiNamedElement
import com.intellij.psi.search.GlobalSearchScope

object ClassResolver {

    private val LOG = logger<ClassResolver>()

    fun findClassByName(project: Project, qualifiedName: String): PsiElement? {
        // Try JavaPsiFacade first (works for Java/Kotlin)
        try {
            val result = findClassByNameWithJavaPlugin(project, qualifiedName)
            if (result != null) return result
        } catch (_: Exception) {
        }

        // Fallback: use GotoClassModel2 via PopupFaithfulSymbolSearch (works for C# in Rider, etc.)
        try {
            val result = findClassByPopupSearch(project, qualifiedName)
            if (result != null) return result
        } catch (e: Exception) {
            LOG.debug("Popup-based class search failed for '$qualifiedName': ${e.message}", e)
        }

        return null
    }

    private fun findClassByNameWithJavaPlugin(project: Project, qualifiedName: String): PsiElement? {
        val javaPsiFacadeClass = Class.forName("com.intellij.psi.JavaPsiFacade")
        val globalSearchScopeClass = Class.forName("com.intellij.psi.search.GlobalSearchScope")

        val getInstanceMethod = javaPsiFacadeClass.getMethod("getInstance", Project::class.java)
        val javaPsiFacade = getInstanceMethod.invoke(null, project)

        val projectScopeMethod = globalSearchScopeClass.getMethod("projectScope", Project::class.java)
        val allScopeMethod = globalSearchScopeClass.getMethod("allScope", Project::class.java)

        val projectScope = projectScopeMethod.invoke(null, project)
        val allScope = allScopeMethod.invoke(null, project)

        val findClassMethod = javaPsiFacadeClass.getMethod("findClass", String::class.java, globalSearchScopeClass)

        val classInProject = findClassMethod.invoke(javaPsiFacade, qualifiedName, projectScope) as PsiElement?
        if (classInProject != null) return PsiUtils.getNavigationElement(classInProject)

        val classInAll = findClassMethod.invoke(javaPsiFacade, qualifiedName, allScope) as PsiElement?
        if (classInAll != null) return PsiUtils.getNavigationElement(classInAll)

        return null
    }

    private fun findClassByPopupSearch(project: Project, qualifiedName: String): PsiElement? {
        val simpleName = qualifiedName.substringAfterLast('.').substringAfterLast('\\')
        val scope = GlobalSearchScope.allScope(project)
        val results = PopupFaithfulSymbolSearch.searchClasses(project, simpleName, scope, 50)

        for (candidate in results.candidates) {
            val item = candidate.item
            val fullName = candidate.fullName ?: (item as? PsiNamedElement)?.name
            if (fullName == qualifiedName || fullName == qualifiedName.replace('\\', '.')) {
                val psiElement = (item as? PsiElement) ?: (item as? NavigationItem)?.let {
                    try {
                        it.javaClass.getMethod("getPsiElement").invoke(it) as? PsiElement
                    } catch (_: Exception) { null }
                }
                if (psiElement != null) return PsiUtils.getNavigationElement(psiElement)
            }
        }

        // If no exact match, return first result if only searching by simple name
        if (results.candidates.isNotEmpty()) {
            val first = results.candidates.first().item
            val psiElement = first as? PsiElement
            if (psiElement != null) return PsiUtils.getNavigationElement(psiElement)
        }

        return null
    }
}
