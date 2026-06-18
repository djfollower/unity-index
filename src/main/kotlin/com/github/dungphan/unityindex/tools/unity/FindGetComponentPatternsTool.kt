package com.github.dungphan.unityindex.tools.unity

import com.github.dungphan.unityindex.constants.ToolNames
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.github.dungphan.unityindex.util.ProjectUtils
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileVisitor
import com.intellij.openapi.vfs.LocalFileSystem
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

class FindGetComponentPatternsTool : AbstractMcpTool() {

    override val requiresPsiSync: Boolean = false

    override val name = ToolNames.FIND_GETCOMPONENT_PATTERNS

    override val description = """
        Find all GetComponent<T>() usage patterns for a given type in C# code. Detects GetComponent, AddComponent, TryGetComponent, and GetComponents variants (including array and list forms).

        These patterns reveal implicit coupling between components that is invisible to standard reference analysis — Unity's de facto dependency injection.

        Parameters:
        - typeName (required): The component type name to search for (e.g. "Rigidbody", "PlayerController").
        - project_path (optional): Only needed with multiple projects open.

        Returns: List of matches with file, line, column, the matched expression, and the pattern variant.

        Example: {"typeName": "Rigidbody"}
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .stringProperty("typeName", "The component type name to search for in GetComponent patterns", required = true)
        .projectPath()
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val typeName = requiredStringArg(arguments, "typeName")
            .getOrElse { return createErrorResult(it.message ?: "Missing typeName") }

        val basePath = project.basePath
            ?: return createErrorResult("Cannot determine project base path")

        val projectDir = LocalFileSystem.getInstance().findFileByPath(basePath)
            ?: return createErrorResult("Project directory not found: $basePath")

        val patterns = buildPatterns(typeName)
        val matches = mutableListOf<GetComponentMatch>()

        VfsUtilCore.visitChildrenRecursively(projectDir, object : VirtualFileVisitor<Unit>() {
            override fun visitFile(file: VirtualFile): Boolean {
                if (file.isDirectory) {
                    val name = file.name
                    if (name == "Library" || name == "Temp" || name == "Logs" || name == "obj") return false
                    return true
                }
                if (file.extension == "cs") {
                    scanFile(file, patterns, basePath, matches)
                }
                return true
            }
        })

        matches.sortBy { it.file }

        return createJsonResult(GetComponentPatternsResult(
            typeName = typeName,
            matches = matches,
            totalCount = matches.size
        ))
    }

    private fun buildPatterns(typeName: String): List<PatternDef> {
        val methods = listOf(
            "GetComponent", "GetComponents", "GetComponentInChildren", "GetComponentsInChildren",
            "GetComponentInParent", "GetComponentsInParent", "AddComponent",
            "TryGetComponent"
        )

        val patternDefs = mutableListOf<PatternDef>()
        for (method in methods) {
            patternDefs.add(PatternDef(
                regex = Regex("""$method\s*<\s*$typeName\s*>\s*\("""),
                variant = "$method<$typeName>()"
            ))
            patternDefs.add(PatternDef(
                regex = Regex("""$method\s*\(\s*typeof\s*\(\s*$typeName\s*\)"""),
                variant = "$method(typeof($typeName))"
            ))
        }
        return patternDefs
    }

    private fun scanFile(
        file: VirtualFile,
        patterns: List<PatternDef>,
        basePath: String,
        matches: MutableList<GetComponentMatch>
    ) {
        val content = try {
            String(file.contentsToByteArray(), Charsets.UTF_8)
        } catch (_: Exception) {
            return
        }

        val lines = content.lines()
        val relativePath = file.path.removePrefix(basePath).removePrefix("/")

        for ((lineIndex, line) in lines.withIndex()) {
            for (pattern in patterns) {
                val matchResult = pattern.regex.find(line) ?: continue
                matches.add(GetComponentMatch(
                    file = relativePath,
                    line = lineIndex + 1,
                    column = matchResult.range.first + 1,
                    context = line.trim(),
                    variant = pattern.variant
                ))
            }
        }
    }

    private data class PatternDef(val regex: Regex, val variant: String)
}

@Serializable
data class GetComponentMatch(
    val file: String,
    val line: Int,
    val column: Int,
    val context: String,
    val variant: String
)

@Serializable
data class GetComponentPatternsResult(
    val typeName: String,
    val matches: List<GetComponentMatch>,
    val totalCount: Int
)
