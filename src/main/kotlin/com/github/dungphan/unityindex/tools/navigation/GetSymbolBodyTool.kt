package com.github.dungphan.unityindex.tools.navigation

import com.github.dungphan.unityindex.constants.ErrorMessages
import com.github.dungphan.unityindex.constants.ParamNames
import com.github.dungphan.unityindex.constants.ToolNames
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.models.SymbolBodyResult
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.github.dungphan.unityindex.util.ProjectUtils
import com.github.dungphan.unityindex.util.PsiUtils
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiNameIdentifierOwner
import com.intellij.psi.PsiNamedElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive

/**
 * Mirrors vscode-extension/src/tools/navigation/getSymbolBodyTool.ts. Returns
 * the full source text of the enclosing declared symbol at a given position,
 * so agents can read a method body in one shot instead of chaining
 * find_definition → ide_read_file with a guessed line range.
 *
 * The "enclosing" element is the nearest ancestor that is a named
 * declaration (method, field, class, namespace) — same notion as PSI's
 * `getParentOfType<PsiNameIdentifierOwner>`.
 */
class GetSymbolBodyTool : AbstractMcpTool() {

    override val name = ToolNames.GET_SYMBOL_BODY

    override val description = """
        Return the full source text of the enclosing symbol (method, property, class, field, etc.) at a given position. Use this after ide_find_definition / ide_find_symbol / ide_find_references when you want to read the actual body — it replaces the manual ide_read_file with a guessed line range, since the symbol's precise span is taken straight from PSI.

        Target: file + line + column.

        Parameters:
        - maxLines (optional): cap the returned body. Default 500, max 2000. Hits set truncated=true.
        - project_path (optional): only needed with multiple projects open.

        Example: {"file": "Assets/Scripts/HomeHeader.cs", "line": 94, "column": 18}
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .projectPath()
        .file(required = true)
        .lineAndColumn(required = true)
        .intProperty("maxLines", "Cap on returned body. Default $DEFAULT_MAX_LINES, max $MAX_MAX_LINES.")
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val file = requiredStringArg(arguments, ParamNames.FILE)
            .getOrElse { return createErrorResult(it.message ?: "Missing file") }
        val line = arguments[ParamNames.LINE]?.jsonPrimitive?.int
            ?: return createErrorResult("Missing line")
        val column = arguments[ParamNames.COLUMN]?.jsonPrimitive?.int
            ?: return createErrorResult("Missing column")
        val maxLines = (arguments["maxLines"]?.jsonPrimitive?.int ?: DEFAULT_MAX_LINES)
            .coerceIn(1, MAX_MAX_LINES)

        return suspendingReadAction {
            val psiFile = PsiUtils.getPsiFile(project, file)
                ?: return@suspendingReadAction createErrorResult("File not found: $file")
            val document = PsiDocumentManager.getInstance(project).getDocument(psiFile)
                ?: return@suspendingReadAction createErrorResult(ErrorMessages.COULD_NOT_RESOLVE_SYMBOL)

            val element = PsiUtils.findElementAtPosition(project, file, line, column)
                ?: return@suspendingReadAction createErrorResult(
                    "No PSI element at this position. Pass a position inside a declared method/property/class/field — not a blank line, comment, or using directive."
                )

            val enclosing = findEnclosingDeclaration(element)
                ?: return@suspendingReadAction createErrorResult(
                    "No enclosing symbol at this position. Pass a position inside a declared method/property/class/field."
                )

            val range = enclosing.textRange
            val startLineIdx = document.getLineNumber(range.startOffset)
            val declaredEndLineIdx = document.getLineNumber(range.endOffset)
            val cappedEndIdx = minOf(declaredEndLineIdx, startLineIdx + maxLines - 1)
            val truncated = cappedEndIdx < declaredEndLineIdx
            val startOffset = document.getLineStartOffset(startLineIdx)
            val endOffset = document.getLineEndOffset(cappedEndIdx)
            val text = document.getText(com.intellij.openapi.util.TextRange(startOffset, endOffset))

            val symbolName = (enclosing as? PsiNamedElement)?.name ?: enclosing.javaClass.simpleName
            val qualifiedName = qualifiedNameOf(enclosing) ?: symbolName
            val kind = describeKind(enclosing)

            val virtualFile = psiFile.virtualFile
            val relativePath = virtualFile?.let { ProjectUtils.getRelativePath(project, it.path) } ?: file

            createJsonResult(
                SymbolBodyResult(
                    file = relativePath,
                    symbolKind = kind,
                    symbolName = symbolName,
                    qualifiedName = qualifiedName,
                    startLine = startLineIdx + 1,
                    endLine = cappedEndIdx + 1,
                    text = text,
                    truncated = truncated
                )
            )
        }
    }

    private fun findEnclosingDeclaration(start: PsiElement): PsiElement? {
        // Walk up looking for the closest named declaration. `PsiNameIdentifierOwner`
        // covers methods, fields, properties, classes, namespaces in IntelliJ's
        // C# / Java / Kotlin / etc. We accept the closest match — the document-
        // symbol equivalent of the deepest containing range.
        var cursor: PsiElement? = start
        while (cursor != null) {
            if (cursor is PsiNameIdentifierOwner && cursor !is com.intellij.psi.PsiFile) {
                return cursor
            }
            cursor = cursor.parent
        }
        return null
    }

    private fun qualifiedNameOf(element: PsiElement): String? {
        val parts = mutableListOf<String>()
        var cursor: PsiElement? = element
        while (cursor != null && cursor !is com.intellij.psi.PsiFile) {
            if (cursor is PsiNamedElement) {
                cursor.name?.let { parts.add(0, it) }
            }
            cursor = cursor.parent
        }
        return parts.joinToString(".").takeIf { it.isNotEmpty() }
    }

    private fun describeKind(element: PsiElement): String {
        val name = element.javaClass.simpleName
        // Trim IDE-specific suffixes — what we want is the *shape* of the
        // declaration (Class, Method, Field). Heuristic, but matches the
        // strings the TS side returns via vscode.SymbolKind names.
        return when {
            name.contains("Method", ignoreCase = true) -> "Method"
            name.contains("Function", ignoreCase = true) -> "Function"
            name.contains("Constructor", ignoreCase = true) -> "Constructor"
            name.contains("Property", ignoreCase = true) -> "Property"
            name.contains("Field", ignoreCase = true) -> "Field"
            name.contains("Class", ignoreCase = true) -> "Class"
            name.contains("Interface", ignoreCase = true) -> "Interface"
            name.contains("Struct", ignoreCase = true) -> "Struct"
            name.contains("Enum", ignoreCase = true) -> "Enum"
            name.contains("Namespace", ignoreCase = true) -> "Namespace"
            else -> name.removeSuffix("Impl").removeSuffix("Stub")
        }
    }

    companion object {
        private const val DEFAULT_MAX_LINES = 500
        private const val MAX_MAX_LINES = 2000
    }
}
