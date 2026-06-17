package com.github.dungphan.unityindex.util

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiManager

object ClassResolver {

    fun findClassByName(project: Project, qualifiedName: String): PsiElement? {
        return try {
            findClassByNameWithJavaPlugin(project, qualifiedName)
        } catch (_: Exception) {
            null
        }
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
}
