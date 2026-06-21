package com.github.dungphan.unityindex.handlers

import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.search.DelegatingGlobalSearchScope
import com.intellij.psi.search.GlobalSearchScope

/**
 * A [GlobalSearchScope] that delegates to [baseScope] but rejects files that the IDE
 * marks as *generated sources*.
 *
 * [ProjectFileIndex.isInGeneratedSources] keys off the project model's generated-source
 * roots, so it excludes exactly the generated output and nothing hand-written.
 */
class GeneratedSourcesExcludingScope(
    baseScope: GlobalSearchScope,
    private val fileIndex: ProjectFileIndex,
) : DelegatingGlobalSearchScope(baseScope) {

    override fun contains(file: VirtualFile): Boolean {
        if (!super.contains(file)) return false
        return !fileIndex.isInGeneratedSources(file)
    }

    companion object {
        /**
         * Wrap [scope] so generated sources are excluded. Returns [scope] unchanged when
         * [exclude] is false, so callers can expose an opt-out (e.g. for debugging codegen).
         */
        fun wrap(project: Project, scope: GlobalSearchScope, exclude: Boolean): GlobalSearchScope {
            if (!exclude) return scope
            val fileIndex = ProjectFileIndex.getInstance(project)
            return GeneratedSourcesExcludingScope(scope, fileIndex)
        }
    }
}
