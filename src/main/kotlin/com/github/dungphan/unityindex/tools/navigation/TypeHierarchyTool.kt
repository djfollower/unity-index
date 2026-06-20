package com.github.dungphan.unityindex.tools.navigation

import com.github.dungphan.unityindex.constants.ParamNames
import com.github.dungphan.unityindex.handlers.BuiltInSearchScope
import com.github.dungphan.unityindex.handlers.BuiltInSearchScopeResolver
import com.github.dungphan.unityindex.handlers.LanguageHandlerRegistry
import com.github.dungphan.unityindex.handlers.TypeElementData
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.models.TypeElement
import com.github.dungphan.unityindex.tools.models.TypeHierarchyResult
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.github.dungphan.unityindex.util.PlatformFallbacks
import com.github.dungphan.unityindex.util.PsiUtils
import com.github.dungphan.unityindex.util.RiderProtocolHost
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Tool for retrieving type hierarchies across multiple languages.
 *
 * Supports: Java, Kotlin, Python, JavaScript, TypeScript, PHP, Rust
 *
 * Delegates to language-specific handlers via [LanguageHandlerRegistry].
 */
class TypeHierarchyTool : AbstractMcpTool() {

    override val name = "ide_type_hierarchy"

    override val description = """
        Get the complete inheritance hierarchy for a class or interface. Use when you need to understand class relationships, find parent classes, or discover all subclasses.

        Languages: Java, Kotlin, C#, Python, JavaScript, TypeScript, PHP, Rust.

        Rust note: className parameter not supported for Rust; use file + line + column instead.

        Returns: target class info, full supertype chain (recursive), and all subtypes in the project.

        Parameters: Either className (e.g., "com.example.MyClass") OR file + line + column. scope (optional, default: "project_files"; supported: project_files, project_and_libraries, project_production_files, project_test_files).

        Example: {"className": "com.example.UserService", "scope": "project_and_libraries"} or {"file": "src/MyClass.java", "line": 10, "column": 14}
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .projectPath()
        .stringProperty("className", "Fully qualified class name (e.g., 'com.example.MyClass' for Java or 'App\\\\Models\\\\User' for PHP). RECOMMENDED - use this if you know the class name.")
        .file(required = false, description = "Path to file relative to project root (e.g., 'src/main/java/com/example/MyClass.java'). Use with line and column.")
        .intProperty("line", "1-based line number where the class is defined. Required if using file parameter.")
        .intProperty("column", "1-based column number. Required if using file parameter.")
        .scopeProperty("Search scope. Default: project_files.")
        .booleanProperty(ParamNames.INCLUDE_GENERATED, "Include supertypes/subtypes defined in generated sources (KSP/Dagger/annotation-processor output). Default: true — keep generated types in the hierarchy.")
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        requireSmartMode(project)

        val file = arguments["file"]?.jsonPrimitive?.content
        val line = arguments["line"]?.jsonPrimitive?.int
        val column = arguments["column"]?.jsonPrimitive?.int

        if (file != null && line != null && column != null) {
            val rdResult = tryRiderTypeHierarchy(project, file, line, column)
            if (rdResult != null) return rdResult
        }

        val className = arguments["className"]?.jsonPrimitive?.content
        val rawScope = rawScopeValue(arguments[ParamNames.SCOPE])
        val scope = try {
            BuiltInSearchScopeResolver.parse(arguments, BuiltInSearchScope.PROJECT_FILES)
        } catch (_: IllegalArgumentException) {
            return createInvalidScopeError(rawScope)
        } catch (_: IllegalStateException) {
            return createInvalidScopeError(rawScope)
        }
        val excludeGenerated = resolveExcludeGenerated(arguments, default = true)
        return suspendingReadAction {
            ProgressManager.checkCanceled() // Allow cancellation

            val element = resolveTargetElement(project, arguments)
            if (element == null) {
                val errorMsg = when {
                    className != null -> "Class '$className' not found in project '${project.name}'. Verify the fully qualified name is correct and the class is part of this project."
                    file != null -> "No class found at the specified file/line/column position."
                    else -> "Provide either 'className' (e.g., 'com.example.MyClass') or 'file' + 'line' + 'column'."
                }
                return@suspendingReadAction createErrorResult(errorMsg)
            }

            // Find appropriate handler for this element's language
            val handler = LanguageHandlerRegistry.getTypeHierarchyHandler(element)

            ProgressManager.checkCanceled()

            val hierarchyData = handler?.getTypeHierarchy(element, project, scope, excludeGenerated)
                ?: PlatformFallbacks.getTypeHierarchy(element, project, scope, excludeGenerated)

            if (hierarchyData == null) {
                return@suspendingReadAction createErrorResult("No class/type found at the specified position.")
            }

            // Convert handler result to tool result
            createJsonResult(TypeHierarchyResult(
                element = convertToTypeElement(hierarchyData.element),
                supertypes = hierarchyData.supertypes.map { convertToTypeElement(it) },
                subtypes = hierarchyData.subtypes.map { convertToTypeElement(it) }
            ))
        }
    }



    private fun resolveTargetElement(project: Project, arguments: JsonObject): PsiElement? {
        // Try className first (Java/Kotlin specific)
        val className = arguments["className"]?.jsonPrimitive?.content
        if (className != null) {
            return findClassByName(project, className)
        }

        // Otherwise use file/line/column (works for all languages)
        val file = arguments["file"]?.jsonPrimitive?.content ?: return null
        val line = arguments["line"]?.jsonPrimitive?.int ?: return null
        val column = arguments["column"]?.jsonPrimitive?.int ?: return null

        return findPsiElement(project, file, line, column)
    }

    /**
     * Converts handler TypeElementData to tool TypeElement.
     */
    private fun convertToTypeElement(data: TypeElementData): TypeElement {
        return TypeElement(
            name = data.name,
            file = data.file,
            kind = data.kind,
            language = data.language,
            supertypes = data.supertypes?.map { convertToTypeElement(it) }
        )
    }

    private suspend fun tryRiderTypeHierarchy(
        project: Project,
        filePath: String,
        line: Int,
        column: Int
    ): ToolCallResult? {
        val virtualFile = PsiUtils.resolveVirtualFileAnywhere(project, filePath) ?: return null
        if (!RiderProtocolHost.shouldUseRiderProtocol(virtualFile)) return null

        val document = suspendingReadAction {
            PsiDocumentManager.getInstance(project).getDocument(
                PsiUtils.getPsiFile(project, filePath) ?: return@suspendingReadAction null
            )
        } ?: return null

        val offset = getOffset(document, line, column) ?: return null

        val result = RiderProtocolHost.typeHierarchyViaRd(project, virtualFile, offset) ?: return null

        val baseItem = result.items.firstOrNull { it.isBase }
        val baseElement = TypeElement(
            name = baseItem?.typeName ?: result.baseTypeName,
            file = filePath,
            kind = "class",
            language = "C#",
            supertypes = null
        )

        val supertypes = mutableListOf<TypeElement>()
        val subtypes = mutableListOf<TypeElement>()

        // Build tree from flat items using parentId
        val baseId = baseItem?.id
        for (item in result.items) {
            if (item.isBase) continue
            val element = TypeElement(
                name = item.typeName,
                file = item.containerInfo,
                kind = "class",
                language = "C#",
                supertypes = null
            )
            if (baseId != null && item.parentId == baseId) {
                subtypes.add(element)
            } else if (item.parentId != null && item.parentId != baseId) {
                // Items whose parent is not the base are likely supertypes or deeper subtypes
                supertypes.add(element)
            } else {
                subtypes.add(element)
            }
        }

        return createJsonResult(TypeHierarchyResult(
            element = baseElement,
            supertypes = supertypes,
            subtypes = subtypes
        ))
    }
}
