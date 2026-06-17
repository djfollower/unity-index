package com.github.dungphan.unityindex.server

import com.github.dungphan.unityindex.constants.ErrorMessages
import com.github.dungphan.unityindex.settings.McpSettings
import com.github.dungphan.unityindex.server.models.ContentBlock
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.util.ResponseFormatter
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.module.ModuleManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.roots.ModuleRootManager
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*

internal data class AvailableProjectEntry(
    val name: String,
    val path: String,
    val workspace: String? = null
)

internal fun buildAvailableProjectsJson(
    entries: List<AvailableProjectEntry>,
    includeWorkspaceSubProjects: Boolean
): JsonArray = buildJsonArray {
    for (entry in entries) {
        if (!includeWorkspaceSubProjects && entry.workspace != null) continue
        add(buildJsonObject {
            put("name", entry.name)
            put("path", entry.path)
            entry.workspace?.let { put("workspace", it) }
        })
    }
}

internal fun buildStructuredErrorResult(
    payload: JsonObject,
    format: McpSettings.ResponseFormat = McpSettings.ResponseFormat.JSON
): ToolCallResult {
    val json = Json { encodeDefaults = true; prettyPrint = false }
    return try {
        val jsonText = json.encodeToString(payload)
        ToolCallResult(
            content = listOf(
                ContentBlock.Text(
                    text = ResponseFormatter.formatStructuredPayload(jsonText, format)
                )
            ),
            isError = true
        )
    } catch (e: Exception) {
        val message = e.message?.takeIf { it.isNotBlank() } ?: "unknown error"
        ToolCallResult(
            content = listOf(ContentBlock.Text(text = "Response formatting failed: $message")),
            isError = true
        )
    }
}

object ProjectResolver {

    private val LOG = logger<ProjectResolver>()

    fun normalizePath(path: String): String {
        return path.trimEnd('/', '\\').replace('\\', '/')
    }

    data class Result(
        val project: Project? = null,
        val errorResult: ToolCallResult? = null,
        val isError: Boolean = false
    )

    fun resolve(projectPath: String?): Result {
        val openProjects = ProjectManager.getInstance().openProjects
            .filter { !it.isDefault }

        if (openProjects.isEmpty()) {
            return Result(
                isError = true,
                errorResult = buildStructuredErrorResult(
                    payload = buildJsonObject {
                        put("error", ErrorMessages.ERROR_NO_PROJECT_OPEN)
                        put("message", ErrorMessages.MSG_NO_PROJECT_OPEN)
                    },
                    format = responseFormat()
                )
            )
        }

        if (projectPath != null) {
            val normalizedPath = normalizePath(projectPath)

            val exactMatch = openProjects.find { normalizePath(it.basePath ?: "") == normalizedPath }
            if (exactMatch != null) {
                return Result(project = exactMatch)
            }

            val moduleMatch = findProjectByModuleContentRoot(openProjects, normalizedPath)
            if (moduleMatch != null) {
                return Result(project = moduleMatch)
            }

            val parentMatch = openProjects.find { proj ->
                val basePath = normalizePath(proj.basePath ?: "")
                basePath.isNotEmpty() && normalizedPath.startsWith("$basePath/")
            }
            if (parentMatch != null) {
                return Result(project = parentMatch)
            }

            return Result(
                isError = true,
                errorResult = buildStructuredErrorResult(
                    payload = buildJsonObject {
                        put("error", ErrorMessages.ERROR_PROJECT_NOT_FOUND)
                        put("message", ErrorMessages.msgProjectNotFound(projectPath))
                        put("hint", diagnoseProjectPath(normalizedPath))
                        put("available_projects", buildAvailableProjectsArray(openProjects))
                    },
                    format = responseFormat()
                )
            )
        }

        if (openProjects.size == 1) {
            return Result(project = openProjects.first())
        }

        return Result(
            isError = true,
            errorResult = buildStructuredErrorResult(
                payload = buildJsonObject {
                    put("error", ErrorMessages.ERROR_MULTIPLE_PROJECTS)
                    put("message", ErrorMessages.MSG_MULTIPLE_PROJECTS)
                    put("available_projects", buildAvailableProjectsArray(openProjects))
                },
                format = responseFormat()
            )
        )
    }

    private fun findProjectByModuleContentRoot(projects: List<Project>, normalizedPath: String): Project? {
        for (project in projects) {
            try {
                val modules = ModuleManager.getInstance(project).modules
                for (module in modules) {
                    val contentRoots = ModuleRootManager.getInstance(module).contentRoots
                    for (root in contentRoots) {
                        if (normalizePath(root.path) == normalizedPath) {
                            return project
                        }
                    }
                }
            } catch (e: Exception) {
                LOG.debug("Failed to check module content roots for project ${project.name}", e)
            }
        }
        return null
    }

    private fun buildAvailableProjectsArray(openProjects: List<Project>): JsonArray {
        val includeWorkspaceSubProjects = isExpandedMode()
        val entries = collectAvailableProjectEntries(openProjects, includeWorkspaceSubProjects)
        return buildAvailableProjectsJson(entries, includeWorkspaceSubProjects)
    }

    private fun collectAvailableProjectEntries(
        openProjects: List<Project>,
        includeWorkspaceSubProjects: Boolean
    ): List<AvailableProjectEntry> {
        val entries = mutableListOf<AvailableProjectEntry>()
        for (proj in openProjects) {
            entries += AvailableProjectEntry(
                name = proj.name,
                path = proj.basePath ?: ""
            )

            if (!includeWorkspaceSubProjects) continue

            try {
                val modules = ModuleManager.getInstance(proj).modules
                for (module in modules) {
                    val contentRoots = ModuleRootManager.getInstance(module).contentRoots
                    for (root in contentRoots) {
                        val rootPath = root.path
                        if (rootPath != proj.basePath) {
                            entries += AvailableProjectEntry(
                                name = module.name,
                                path = rootPath,
                                workspace = proj.name
                            )
                        }
                    }
                }
            } catch (e: Exception) {
                LOG.debug("Failed to list module content roots for project ${proj.name}", e)
            }
        }
        return entries
    }

    private fun isExpandedMode(): Boolean =
        runCatching { McpSettings.getInstance().availableProjectsMode }
            .getOrDefault(McpSettings.AvailableProjectsMode.EXPANDED) ==
            McpSettings.AvailableProjectsMode.EXPANDED

    suspend fun resolveOrOpen(projectPath: String?): Result {
        return resolve(projectPath)
    }

    private fun diagnoseProjectPath(normalizedPath: String): String {
        val dir = java.io.File(normalizedPath)
        return when {
            !dir.exists() -> "Path does not exist on disk."
            !dir.isDirectory -> "Path is a file, not a directory — project_path must point to a project root directory."
            !java.io.File(dir, ".idea").exists() ->
                "Path exists but has no .idea directory — not an IntelliJ project."
            else ->
                "Path has a .idea directory but is not open in the IDE."
        }
    }

    private fun responseFormat(): McpSettings.ResponseFormat =
        runCatching { McpSettings.getInstance().responseFormat }
            .getOrDefault(McpSettings.ResponseFormat.JSON)
}
