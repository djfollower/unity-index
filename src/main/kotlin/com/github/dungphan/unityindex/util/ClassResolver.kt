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
        try {
            val result = findClassByPopupSearch(project, qualifiedName)
            if (result != null) return result
        } catch (e: Exception) {
            LOG.debug("Popup-based class search failed for '$qualifiedName': ${e.message}", e)
        }

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
