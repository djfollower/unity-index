package com.github.dungphan.unityindex.tools.unity

import com.github.dungphan.unityindex.constants.ToolNames
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileVisitor
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

class GetApiUsageTool : AbstractMcpTool() {

    override val requiresPsiSync: Boolean = false

    override val name = ToolNames.GET_API_USAGE

    override val description = """
        Find all uses of a specific Unity API in C# code. Searches for exact matches of the API name (e.g. "Physics.Raycast", "Instantiate", "Resources.Load", "PlayerPrefs.GetInt").

        Use this to audit API usage patterns, find deprecated API calls, or understand how a specific Unity feature is used across the codebase.

        Parameters:
        - apiName (required): The Unity API to search for (e.g. "Physics.Raycast", "Object.Instantiate", "SendMessage").
        - project_path (optional): Only needed with multiple projects open.

        Returns: List of matches with file, line, column, and surrounding code context.

        Example: {"apiName": "Physics.Raycast"}
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .stringProperty("apiName", "The Unity API name to search for (e.g. \"Physics.Raycast\", \"Instantiate\")", required = true)
        .projectPath()
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val apiName = requiredStringArg(arguments, "apiName")
            .getOrElse { return createErrorResult(it.message ?: "Missing apiName") }

        val basePath = project.basePath
            ?: return createErrorResult("Cannot determine project base path")

        val projectDir = LocalFileSystem.getInstance().findFileByPath(basePath)
            ?: return createErrorResult("Project directory not found: $basePath")

        val pattern = Regex(Regex.escape(apiName))
        val matches = mutableListOf<ApiUsageMatch>()

        VfsUtilCore.visitChildrenRecursively(projectDir, object : VirtualFileVisitor<Unit>() {
            override fun visitFile(file: VirtualFile): Boolean {
                if (file.isDirectory) {
                    val name = file.name
                    if (name == "Library" || name == "Temp" || name == "Logs" || name == "obj") return false
                    return true
                }
                if (file.extension == "cs") {
                    scanFile(file, pattern, basePath, matches)
                }
                return true
            }
        })

        matches.sortBy { it.file }

        return createJsonResult(ApiUsageResult(
            apiName = apiName,
            matches = matches,
            totalCount = matches.size
        ))
    }

    private fun scanFile(
        file: VirtualFile,
        pattern: Regex,
        basePath: String,
        matches: MutableList<ApiUsageMatch>
    ) {
        val content = try {
            String(file.contentsToByteArray(), Charsets.UTF_8)
        } catch (_: Exception) {
            return
        }

        val lines = content.lines()
        val relativePath = file.path.removePrefix(basePath).removePrefix("/")

        for ((lineIndex, line) in lines.withIndex()) {
            val trimmed = line.trim()
            if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("///")) continue

            for (match in pattern.findAll(line)) {
                matches.add(ApiUsageMatch(
                    file = relativePath,
                    line = lineIndex + 1,
                    column = match.range.first + 1,
                    context = trimmed
                ))
            }
        }
    }
}

@Serializable
data class ApiUsageMatch(
    val file: String,
    val line: Int,
    val column: Int,
    val context: String
)

@Serializable
data class ApiUsageResult(
    val apiName: String,
    val matches: List<ApiUsageMatch>,
    val totalCount: Int
)
