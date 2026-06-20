package com.github.dungphan.unityindex.tools.navigation

import com.github.dungphan.unityindex.handlers.LanguageHandlerRegistry
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.models.FileStructureResult
import com.github.dungphan.unityindex.tools.models.StructureKind
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.github.dungphan.unityindex.util.IdeStructureViewExtractor
import com.github.dungphan.unityindex.util.TreeFormatter
import com.intellij.openapi.project.Project
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Tool for analyzing the hierarchical structure of source files.
 *
 * Provides a tree-formatted view of file structure similar to IDE's Structure view,
 * showing classes, methods, fields, Markdown headings, and their nesting relationships.
 *
 * Supports: Java, Kotlin, Python, JavaScript, TypeScript, PHP, Markdown
 */
class FileStructureTool : AbstractMcpTool() {

    override val name = "ide_file_structure"

    override val description = """
        Get the hierarchical structure of a source file (similar to IDE's Structure view).

        Shows classes, methods, fields, functions, PHP namespaces, constants, enum cases, Markdown headings, and their nesting relationships in a tree format.

        Supports: Java, Kotlin, C#, Python, JavaScript, TypeScript, PHP, Markdown, and any language with IDE Structure View support.

        Returns: Formatted tree string with element types, modifiers, signatures, and line numbers.

        Parameters: file (required) - Path relative to project root

        Example: {"file": "src/main/java/com/example/MyClass.java"}
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .projectPath()
        .file(description = "Path to file relative to project root (e.g., 'src/main/java/com/example/MyClass.java'). REQUIRED.")
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val file = requiredStringArg(arguments, "file").getOrElse {
            return createErrorResult(it.message ?: "Missing required parameter: file")
        }

        return suspendingReadAction {
            val psiFile = getPsiFile(project, file)
                ?: return@suspendingReadAction createErrorResult("File not found: $file")

            // Try language-specific handler first, fall back to platform StructureView
            val handler = LanguageHandlerRegistry.getStructureHandler(psiFile)
            val nodes = if (handler != null) {
                handler.getFileStructure(psiFile, project)
            } else {
                IdeStructureViewExtractor.extract(psiFile, project, genericStructureClassifier())
            }

            if (nodes.isEmpty()) {
                return@suspendingReadAction createSuccessResult(
                    "File is empty or has no parseable structure.\n\n" +
                    "File: ${psiFile.name}\n" +
                    "Language: ${psiFile.language.id}"
                )
            }

            // Format as tree
            val treeString = TreeFormatter.format(nodes, psiFile.name, psiFile.language.id)

            createJsonResult(FileStructureResult(
                file = file,
                language = psiFile.language.id,
                structure = treeString
            ))
        }
    }

    private fun genericStructureClassifier(): IdeStructureViewExtractor.Classifier {
        return IdeStructureViewExtractor.Classifier { value, presentation ->
            val name = presentation.presentableText ?: return@Classifier null
            val locationString = presentation.locationString
            val className = value?.javaClass?.simpleName?.lowercase() ?: ""
            val kind = when {
                className.contains("interface") -> StructureKind.INTERFACE
                className.contains("enum") -> StructureKind.ENUM
                className.contains("class") -> StructureKind.CLASS
                className.contains("method") || className.contains("function") -> StructureKind.METHOD
                className.contains("field") -> StructureKind.FIELD
                className.contains("property") -> StructureKind.PROPERTY
                className.contains("constructor") -> StructureKind.CONSTRUCTOR
                className.contains("namespace") -> StructureKind.NAMESPACE
                className.contains("constant") -> StructureKind.CONSTANT
                else -> StructureKind.UNKNOWN
            }
            IdeStructureViewExtractor.StructureElementInfo(
                name = name,
                kind = kind,
                modifiers = emptyList(),
                signature = locationString
            )
        }
    }
}
