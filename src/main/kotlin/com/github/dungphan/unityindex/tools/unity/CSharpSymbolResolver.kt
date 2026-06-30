package com.github.dungphan.unityindex.tools.unity

import com.github.dungphan.unityindex.util.ClassResolver
import com.github.dungphan.unityindex.util.PlatformFallbacks
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiNamedElement
import com.intellij.psi.util.PsiTreeUtil

/**
 * Shared helpers for parsing `unity://csharp/...` symbol IDs (the Day 8
 * `unity_graph_code_edges` wire contract — see graph-schema.md §1) and
 * resolving them to live PSI elements via the host IDE's existing
 * Go-to-Class / Go-to-Symbol infrastructure.
 *
 * The resolver intentionally stays narrow: it only does ID parsing and
 * delegates the heavy lifting to [ClassResolver.findClassByName] (which
 * already carries the proven RD-proxy fallback chain — see CLAUDE.md §4).
 * Do NOT reimplement name / container / hierarchy resolution here.
 */
object CSharpSymbolResolver {

    private val LOG = logger<CSharpSymbolResolver>()

    const val PREFIX = "unity://csharp/"

    enum class SymbolKind { TYPE, METHOD, OTHER }

    data class ParsedSymbolId(
        val raw: String,
        val docId: String,
        val kind: SymbolKind,
        /** Fully-qualified container (the type for METHOD, the type itself for TYPE). */
        val typeName: String,
        /** Method name for METHOD ids, null otherwise. */
        val methodName: String?,
    )

    data class ResolvedSymbol(
        val id: ParsedSymbolId,
        val element: PsiElement,
        /** The owning class element for METHOD resolutions, same as [element] for TYPE. */
        val typeElement: PsiElement?,
    )

    /**
     * Parse a wire-format symbol id. Returns null when the id is empty or
     * missing the `unity://csharp/` prefix — the tool turns null into an
     * `invalid_id` error envelope. Stale-but-well-formed ids (correctly
     * shaped but unresolvable) come back as a non-null ParsedSymbolId and
     * are reported via `unresolved_ids` once resolution fails.
     */
    fun parse(rawId: String): ParsedSymbolId? {
        val trimmed = rawId.trim()
        if (trimmed.isEmpty() || !trimmed.startsWith(PREFIX)) return null
        val docId = trimmed.removePrefix(PREFIX)
        if (docId.length < 3 || docId[1] != ':') {
            // Doc-comment ids are always "<prefix>:<body>" (T:, M:, P:, F:, E:, N:).
            return ParsedSymbolId(trimmed, docId, SymbolKind.OTHER, docId, null)
        }
        val prefixChar = docId[0]
        val body = docId.substring(2)
        return when (prefixChar) {
            'T' -> ParsedSymbolId(trimmed, docId, SymbolKind.TYPE, body, null)
            'M' -> {
                // M:Ns.Type.Method(arg1,arg2) — strip arg list, then split on last '.'
                val nameNoArgs = body.substringBefore('(')
                val typeName = nameNoArgs.substringBeforeLast('.', "")
                val methodName = nameNoArgs.substringAfterLast('.', nameNoArgs)
                if (typeName.isEmpty() || methodName.isEmpty()) {
                    ParsedSymbolId(trimmed, docId, SymbolKind.OTHER, body, null)
                } else {
                    ParsedSymbolId(trimmed, docId, SymbolKind.METHOD, typeName, methodName)
                }
            }
            else -> ParsedSymbolId(trimmed, docId, SymbolKind.OTHER, body, null)
        }
    }

    /**
     * Resolve a parsed id to a live PSI element. Must be called inside a
     * read action. Returns null when the id can't be resolved — the caller
     * is expected to add the raw id to `unresolved_ids`.
     */
    fun resolve(project: Project, id: ParsedSymbolId): ResolvedSymbol? {
        return try {
            val typeElement = ClassResolver.findClassByName(project, id.typeName) ?: return null
            when (id.kind) {
                SymbolKind.TYPE -> ResolvedSymbol(id, typeElement, typeElement)
                SymbolKind.METHOD -> {
                    val methodName = id.methodName ?: return null
                    val method = findMemberByName(typeElement, methodName) ?: return null
                    ResolvedSymbol(id, method, typeElement)
                }
                SymbolKind.OTHER -> null
            }
        } catch (e: Exception) {
            LOG.debug("CSharpSymbolResolver.resolve failed for ${id.raw}: ${e.message}", e)
            null
        }
    }

    /**
     * Best-effort member-by-name lookup within a class element. We don't
     * match the parameter list (signatures from DocumentationCommentId are
     * the C# spec encoding, which is non-trivial to round-trip); the first
     * member whose name matches wins. Day 8 tests will tighten this if
     * overload disambiguation becomes load-bearing.
     */
    private fun findMemberByName(classElement: PsiElement, methodName: String): PsiElement? {
        val direct = PsiTreeUtil.findChildrenOfType(classElement, PsiNamedElement::class.java)
            .firstOrNull { (it as? PsiNamedElement)?.name == methodName && it !== classElement }
        return direct
    }

    /** Resolved enclosing-type info for a reference. `name` is best-effort —
     *  for RD proxies the PSI name accessors return null/blank, so we fall
     *  through to a reflective `getName()` and finally the file basename
     *  (Unity is one-class-per-file). */
    data class EnclosingType(val name: String, val kind: String)

    /**
     * Walk `refElement`'s parent chain looking for the enclosing
     * class/interface/struct/enum, then extract a name with the proven
     * RD-proxy fallback chain (CLAUDE.md §4). `null` when the parent walk
     * lands on a file-level reference (file-scoped using-directive etc.).
     *
     * Must be called inside a read action.
     */
    fun findEnclosingType(refElement: PsiElement): EnclosingType? {
        val container = PlatformFallbacks.findContainingClass(refElement) ?: run {
            // Parent walk failed (common for RD-backed proxies). Fall back to
            // the file basename — Unity convention is one class per file.
            val basename = refElement.containingFile?.virtualFile?.nameWithoutExtension
            return basename?.takeIf { it.isNotBlank() }?.let { EnclosingType(it, "class") }
        }
        val name = (container as? PsiNamedElement)?.name
            ?: tryGetName(container)
            ?: container.containingFile?.virtualFile?.nameWithoutExtension
            ?: return null
        val kind = PlatformFallbacks.classifyElementKind(container)
        return EnclosingType(name, kind)
    }

    private fun tryGetName(element: PsiElement): String? = try {
        element.javaClass.getMethod("getName").invoke(element) as? String
    } catch (_: Exception) {
        null
    }

    /** Build a `unity://csharp/T:<qualifiedName>` id. */
    fun typeId(qualifiedName: String): String = PREFIX + "T:" + qualifiedName

    /** Build a `unity://csharp/M:<owner>.<methodName>` id. We omit the arg
     *  list because the PlatformFallbacks intermediate data classes don't
     *  carry it; Day 8.6 may upgrade this once a full DocumentationCommentId
     *  encoder exists. */
    fun methodId(ownerType: String, methodName: String): String =
        PREFIX + "M:" + ownerType + "." + methodName
}
