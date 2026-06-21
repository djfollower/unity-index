package com.github.dungphan.unityindex.handlers

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.search.DelegatingGlobalSearchScope
import com.intellij.psi.search.GlobalSearchScope

/**
 * A [GlobalSearchScope] that delegates to [baseScope] but rejects files in excluded
 * directories (build output, Unity Library/Temp/Logs, worktrees).
 */
class ExcludedPathScope(
    baseScope: GlobalSearchScope,
    private val basePath: String,
) : DelegatingGlobalSearchScope(baseScope) {

    override fun contains(file: VirtualFile): Boolean {
        if (!super.contains(file)) return false
        val relativePath = file.path.removePrefix(basePath).removePrefix("/")
        return !isExcludedPath(relativePath)
    }
}

/**
 * Wraps [GlobalSearchScope.projectScope] or [GlobalSearchScope.allScope] with
 * excluded-path filtering so that build output, Unity cache dirs, and worktree files
 * are never processed by the IDE's search APIs.
 */
fun createFilteredScope(project: Project, includeLibraries: Boolean = false): GlobalSearchScope {
    val basePath = project.basePath ?: ""
    val baseScope = if (includeLibraries) {
        GlobalSearchScope.allScope(project)
    } else {
        GlobalSearchScope.projectScope(project)
    }
    return ExcludedPathScope(baseScope, basePath)
}
