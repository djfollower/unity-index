package com.github.dungphan.unityindex.util

import com.intellij.navigation.NavigationItem
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiFile

/**
 * Best-effort extraction of file + position from a [NavigationItem] whose underlying
 * PSI element is a Rider RD-backed proxy (text offsets are 0, language displayName is empty).
 *
 * Uses reflection over well-known method names so we don't take a compile-time dependency on
 * the Rider SDK. Returns null if no usable position can be probed — callers should treat that
 * as "skip this item" rather than emitting a fake (1, 1) location.
 */
object RiderNavigationProbe {

    private val LOG = logger<RiderNavigationProbe>()

    data class ProbeResult(
        val file: VirtualFile,
        val line: Int,
        val column: Int
    )

    private val OFFSET_GETTERS = listOf(
        "getOffset",
        "getNavigationOffset",
        "getStartOffset",
        "getTextOffset"
    )

    private val FILE_GETTERS = listOf(
        "getVirtualFile",
        "getFile",
        "getContainingFile"
    )

    fun probe(item: NavigationItem, project: Project): ProbeResult? {
        if (item is OpenFileDescriptor) {
            return offsetToLineColumn(item.file, item.offset)?.let { (line, column) ->
                ProbeResult(item.file, line, column)
            }
        }

        val file = probeFile(item) ?: return null
        val offset = probeOffset(item) ?: return null
        return offsetToLineColumn(file, offset)?.let { (line, column) ->
            ProbeResult(file, line, column)
        }
    }

    private fun probeFile(item: Any): VirtualFile? {
        for (getter in FILE_GETTERS) {
            when (val v = invokeNoArg(item, getter)) {
                is VirtualFile -> return v
                is PsiFile -> v.virtualFile?.let { return it }
            }
        }
        return null
    }

    private fun probeOffset(item: Any): Int? {
        for (getter in OFFSET_GETTERS) {
            val v = invokeNoArg(item, getter)
            if (v is Int && v > 0) return v
        }
        val range = invokeNoArg(item, "getTextRange") ?: return null
        val start = invokeNoArg(range, "getStartOffset")
        return (start as? Int)?.takeIf { it > 0 }
    }

    private fun offsetToLineColumn(file: VirtualFile, offset: Int): Pair<Int, Int>? {
        val document = FileDocumentManager.getInstance().getDocument(file) ?: return null
        if (offset < 0 || offset > document.textLength) return null
        val lineIndex = document.getLineNumber(offset)
        val column = offset - document.getLineStartOffset(lineIndex) + 1
        return (lineIndex + 1) to column
    }

    private fun invokeNoArg(target: Any, methodName: String): Any? {
        return try {
            val method = target.javaClass.methods
                .firstOrNull { it.name == methodName && it.parameterCount == 0 }
                ?: return null
            method.invoke(target)
        } catch (e: Exception) {
            LOG.debug("Reflection ${methodName}() on ${target.javaClass.simpleName} failed: ${e.message}")
            null
        }
    }
}
