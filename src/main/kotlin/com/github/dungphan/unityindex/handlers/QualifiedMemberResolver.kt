package com.github.dungphan.unityindex.handlers

import com.github.dungphan.unityindex.tools.models.ResolvedFrom
import com.github.dungphan.unityindex.tools.models.SymbolMatch
import com.github.dungphan.unityindex.util.PlatformFallbacks
import com.github.dungphan.unityindex.util.ProjectUtils
import com.github.dungphan.unityindex.util.RiderNavigationProbe
import com.intellij.navigation.NavigationItem
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiNamedElement
import com.intellij.psi.PsiNameIdentifierOwner
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.psi.search.searches.DefinitionsScopedSearch
import com.intellij.psi.util.PsiTreeUtil
import com.intellij.util.Processor

/**
 * Resolves `Type.Member` queries when the Go to Symbol popup returns nothing — typically because
 * `Member` is inherited from a base class. Mirrors the TS QualifiedMemberResolver.
 *
 * Strategy:
 *   1. Split the query at the last `.` into [requestedType] / [requestedMember].
 *   2. Find [requestedType] via the class popup, walk its supertype chain via [PlatformFallbacks].
 *   3. Search for [requestedMember] via the symbol popup; keep candidates whose container matches
 *      [requestedType] or any reachable supertype.
 *   4. Return the closest match — direct on Type, else the nearest base — annotated with [ResolvedFrom].
 */
object QualifiedMemberResolver {

    private val LOG = logger<QualifiedMemberResolver>()
    private const val CLASS_LOOKUP_LIMIT = 10
    private const val MEMBER_LOOKUP_LIMIT = 200
    private const val SUPERTYPE_WALK_LIMIT = 32

    data class Parts(val type: String, val member: String)

    fun parse(query: String): Parts? {
        val dot = query.lastIndexOf('.')
        if (dot <= 0 || dot >= query.length - 1) return null
        val type = query.substring(0, dot).trim()
        val member = query.substring(dot + 1).trim()
        if (type.isEmpty() || member.isEmpty()) return null
        // Bail on segments with whitespace or other separators that aren't C# identifiers.
        if (!type.all { it.isLetterOrDigit() || it == '_' || it == '.' }) return null
        if (!member.all { it.isLetterOrDigit() || it == '_' }) return null
        return Parts(type, member)
    }

    data class InheritedResolution(
        val element: PsiElement,
        val symbolMatch: SymbolMatch,
        val resolvedFrom: ResolvedFrom
    )

    /**
     * Same as [resolveInherited] but also returns the resolved PSI element. Use when the caller
     * needs a [PsiElement] to feed into ReferencesSearch (e.g. FindUsagesTool).
     */
    fun resolveInheritedElement(
        project: Project,
        query: String,
        scope: GlobalSearchScope,
        languageFilter: Set<String>? = null
    ): InheritedResolution? {
        val best = findBestCandidate(project, query, scope) ?: return null
        val resolvedFrom = ResolvedFrom(
            requestedType = best.requestedType,
            requestedMember = best.requestedMember,
            declaringType = best.containerName,
            kind = if (best.depth == 0) "DIRECT" else "BASE_CLASS_FALLBACK"
        )
        val symbolMatch = toSymbolMatch(
            project = project,
            item = best.item,
            target = best.target,
            scope = scope,
            languageFilter = languageFilter,
            resolvedFrom = resolvedFrom
        ) ?: return null
        return InheritedResolution(best.target, symbolMatch, resolvedFrom)
    }

    /**
     * Resolve [query] as Type.Member when popup search returned no hits.
     *
     * Returns the base-class member (with [SymbolMatch.resolvedFrom] populated) or null if the
     * type can't be found or the member isn't declared anywhere on the inheritance chain.
     */
    fun resolveInherited(
        project: Project,
        query: String,
        scope: GlobalSearchScope,
        languageFilter: Set<String>? = null
    ): SymbolMatch? = resolveInheritedElement(project, query, scope, languageFilter)?.symbolMatch

    private fun findBestCandidate(
        project: Project,
        query: String,
        scope: GlobalSearchScope
    ): CandidateMatch? {
        val parts = parse(query) ?: return null
        val (typeName, memberName) = parts
        val shortType = typeName.substringAfterLast('.')

        // Step 1 — find Type via class popup.
        val typeCandidates = try {
            PopupFaithfulSymbolSearch.searchClasses(project, shortType, scope, CLASS_LOOKUP_LIMIT).candidates
        } catch (e: Exception) {
            LOG.debug("Class popup lookup for '$shortType' failed: ${e.message}", e)
            return null
        }
        val typeElement = typeCandidates
            .mapNotNull { extractPsiElement(it.item) }
            .firstOrNull { (it as? PsiNamedElement)?.name == shortType || tryGetName(it) == shortType }
            ?: typeCandidates.firstOrNull()?.item?.let { extractPsiElement(it) }
            ?: return null

        // Step 2 — collect ancestor type names (Type + supertypes).
        val ancestorNames = collectAncestorNames(typeElement, project)
        if (ancestorNames.isEmpty()) return null

        // Step 3 — search for Member alone, filter to candidates declared on any ancestor.
        val memberCandidates = try {
            PopupFaithfulSymbolSearch.search(project, memberName, scope, MEMBER_LOOKUP_LIMIT).candidates
        } catch (e: Exception) {
            LOG.debug("Member popup lookup for '$memberName' failed: ${e.message}", e)
            return null
        }

        return memberCandidates.mapNotNull { candidate ->
            val item = candidate.item
            val element = extractPsiElement(item) ?: return@mapNotNull null
            val target = element.navigationElement ?: element
            val actualName = (target as? PsiNamedElement)?.name ?: tryGetName(target)
            if (actualName != memberName) return@mapNotNull null
            val containerName = extractContainerName(target) ?: return@mapNotNull null
            val ancestorIndex = ancestorNames.indexOf(containerName)
            if (ancestorIndex < 0) return@mapNotNull null
            CandidateMatch(
                item = item,
                target = target,
                containerName = containerName,
                depth = ancestorIndex,
                requestedType = typeName,
                requestedMember = memberName
            )
        }.minByOrNull { it.depth }
    }

    private data class CandidateMatch(
        val item: NavigationItem,
        val target: PsiElement,
        val containerName: String,
        val depth: Int,
        val requestedType: String,
        val requestedMember: String
    )

    /**
     * Returns [Type, Supertype1, Supertype2, ...] ordered by depth from Type.
     * First element is always the type's own name so direct declarations are preferred.
     */
    private fun collectAncestorNames(typeElement: PsiElement, project: Project): List<String> {
        val ordered = mutableListOf<String>()
        val seen = mutableSetOf<String>()

        val typeName = (typeElement as? PsiNamedElement)?.name ?: tryGetName(typeElement)
        if (typeName != null && seen.add(typeName)) ordered.add(typeName)

        val hierarchy = try {
            PlatformFallbacks.getTypeHierarchy(typeElement, project)
        } catch (e: Exception) {
            LOG.debug("Type hierarchy lookup failed: ${e.message}", e)
            null
        }
        hierarchy?.supertypes?.take(SUPERTYPE_WALK_LIMIT)?.forEach { supertype ->
            // TypeElementData.name can be qualified (e.g. "Namespace.Item"); index by simple name
            // because containerName from PSI is also the simple name.
            val simple = supertype.name.substringAfterLast('.')
            if (seen.add(simple)) ordered.add(simple)
        }
        return ordered
    }

    private fun extractPsiElement(item: NavigationItem): PsiElement? {
        return when (item) {
            is PsiElement -> item
            else -> try {
                val method = item.javaClass.getMethod("getElement")
                method.invoke(item) as? PsiElement
            } catch (_: Exception) {
                null
            }
        }
    }

    private fun tryGetName(element: PsiElement): String? = try {
        element.javaClass.getMethod("getName").invoke(element) as? String
    } catch (_: Exception) {
        null
    }

    private fun extractContainerName(element: PsiElement): String? {
        var parent = element.parent
        while (parent != null) {
            val parentClassName = parent.javaClass.simpleName.lowercase()
            if (parentClassName.contains("class") || parentClassName.contains("interface") ||
                parentClassName.contains("struct") || parentClassName.contains("type")) {
                val name = (parent as? PsiNamedElement)?.name ?: tryGetName(parent)
                if (!name.isNullOrBlank()) return name
            }
            parent = parent.parent
        }
        return null
    }

    private fun toSymbolMatch(
        project: Project,
        item: NavigationItem,
        target: PsiElement,
        scope: GlobalSearchScope,
        languageFilter: Set<String>?,
        resolvedFrom: ResolvedFrom
    ): SymbolMatch? {
        val name = (target as? PsiNamedElement)?.name ?: tryGetName(target) ?: return null
        val position = resolvePosition(item, target, project) ?: return null
        if (!scope.contains(position.file)) return null

        val language = when (target.language.id) {
            "C#" -> "C#"
            else -> target.language.displayName
        }.ifBlank { inferLanguageFromExtension(position.file) }

        if (languageFilter != null && languageFilter.none { it.equals(language, ignoreCase = true) }) {
            return null
        }

        val qualifiedName = try {
            target.javaClass.getMethod("getQualifiedName").invoke(target) as? String
        } catch (_: Exception) {
            null
        }

        return SymbolMatch(
            name = name,
            qualifiedName = qualifiedName,
            kind = classifyKind(target),
            file = ProjectUtils.getToolFilePath(project, position.file),
            line = position.line,
            column = position.column,
            containerName = resolvedFrom.declaringType,
            language = language,
            resolvedFrom = resolvedFrom
        )
    }

    private data class ResolvedPosition(val file: VirtualFile, val line: Int, val column: Int)

    private fun resolvePosition(item: NavigationItem, target: PsiElement, project: Project): ResolvedPosition? {
        val virtualFile = target.containingFile?.virtualFile
        if (virtualFile != null) {
            val document = getDocument(project, target)
            val offset = document?.let { resolveOffset(target, it) }
            if (document != null && offset != null) {
                val lineIndex = document.getLineNumber(offset)
                val column = offset - document.getLineStartOffset(lineIndex) + 1
                return ResolvedPosition(virtualFile, lineIndex + 1, column)
            }
        }
        val probe = RiderNavigationProbe.probe(item, project) ?: return null
        return ResolvedPosition(probe.file, probe.line, probe.column)
    }

    private fun getDocument(project: Project, element: PsiElement): Document? {
        val psiFile = element.containingFile ?: return null
        return PsiDocumentManager.getInstance(project).getDocument(psiFile)
            ?: psiFile.virtualFile?.let { FileDocumentManager.getInstance().getDocument(it) }
    }

    private fun resolveOffset(element: PsiElement, document: Document): Int? {
        val nameIdentifierOffset = (element as? PsiNameIdentifierOwner)?.nameIdentifier?.textOffset
        if (nameIdentifierOffset != null && nameIdentifierOffset > 0) return nameIdentifierOffset
        val offset = element.textOffset
        if (offset > 0) return offset
        return null
    }

    /**
     * Given a base member element (e.g. Item.UniqueID), find same-named members declared on
     * subtypes (Product.UniqueID, etc.). Returns the override PSI elements ready to feed into
     * ReferencesSearch. Mirrors qualifiedMemberResolver.ts#findOverrideMembers.
     */
    fun findOverrideMembers(
        project: Project,
        baseMember: PsiElement,
        scope: GlobalSearchScope,
        limit: Int = 64
    ): List<OverrideMember> {
        val memberName = (baseMember as? PsiNamedElement)?.name ?: tryGetName(baseMember) ?: return emptyList()
        val containingType = findContainingType(baseMember) ?: return emptyList()

        val overrides = mutableListOf<OverrideMember>()
        try {
            DefinitionsScopedSearch.search(containingType, scope).forEach(Processor { subtype ->
                if (subtype === containingType) return@Processor true
                if (overrides.size >= limit) return@Processor false
                val match = findNamedChild(subtype, memberName)
                if (match != null && match !== baseMember) {
                    val typeName = (subtype as? PsiNamedElement)?.name ?: tryGetName(subtype)
                        ?: return@Processor true
                    overrides.add(OverrideMember(typeName = typeName, element = match))
                }
                true
            })
        } catch (e: Exception) {
            LOG.debug("Override walking failed for ${baseMember.javaClass.simpleName}: ${e.message}", e)
        }
        return overrides
    }

    data class OverrideMember(val typeName: String, val element: PsiElement)

    private fun findContainingType(element: PsiElement): PsiElement? {
        var parent: PsiElement? = element.parent
        while (parent != null) {
            val name = parent.javaClass.simpleName.lowercase()
            if (name.contains("class") || name.contains("interface") ||
                name.contains("struct") || (name.contains("type") && parent is PsiNamedElement)) {
                return parent
            }
            parent = parent.parent
        }
        return null
    }

    private fun findNamedChild(typeElement: PsiElement, memberName: String): PsiElement? {
        return PsiTreeUtil.findChildrenOfType(typeElement, PsiNamedElement::class.java)
            .firstOrNull { it !== typeElement && it.name == memberName }
    }

    private fun classifyKind(element: PsiElement): String {
        val className = element.javaClass.simpleName.lowercase()
        return when {
            className.contains("method") -> "METHOD"
            className.contains("function") -> "FUNCTION"
            className.contains("field") -> "FIELD"
            className.contains("property") -> "PROPERTY"
            className.contains("constant") -> "CONSTANT"
            className.contains("variable") -> "VARIABLE"
            className.contains("class") -> "CLASS"
            className.contains("interface") -> "INTERFACE"
            else -> "SYMBOL"
        }
    }

    private fun inferLanguageFromExtension(file: VirtualFile): String = when (file.extension?.lowercase()) {
        "cs" -> "C#"
        "shader" -> "ShaderLab"
        "uxml" -> "XML"
        "uss" -> "CSS"
        else -> ""
    }
}
