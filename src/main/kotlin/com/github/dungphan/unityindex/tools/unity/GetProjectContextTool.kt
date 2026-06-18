package com.github.dungphan.unityindex.tools.unity

import com.github.dungphan.unityindex.constants.ToolNames
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

class GetProjectContextTool : AbstractMcpTool() {

    override val requiresPsiSync: Boolean = false

    override val name = ToolNames.GET_PROJECT_CONTEXT

    override val description = """
        Get Unity project context: Unity version, render pipeline, target platforms, company/product name, and installed packages. Essential for any AI agent working with a Unity project — answers "what kind of project is this?" without opening the Editor.

        Parameters: project_path (optional, only needed with multiple projects open).

        Example: {}
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .projectPath()
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val basePath = project.basePath
            ?: return createErrorResult("Cannot determine project base path")

        val projectDir = LocalFileSystem.getInstance().findFileByPath(basePath)
            ?: return createErrorResult("Project directory not found: $basePath")

        val unityVersion = readUnityVersion(projectDir)
        val projectSettings = readProjectSettings(projectDir)
        val packages = readPackageManifest(projectDir)
        val renderPipeline = detectRenderPipeline(packages)

        return createJsonResult(ProjectContextResult(
            unityVersion = unityVersion,
            renderPipeline = renderPipeline,
            companyName = projectSettings["companyName"],
            productName = projectSettings["productName"],
            targetPlatforms = projectSettings["targetPlatforms"]?.split(",")?.map { it.trim() }?.filter { it.isNotEmpty() } ?: emptyList(),
            scriptingBackend = projectSettings["scriptingBackend"],
            apiCompatibilityLevel = projectSettings["apiCompatibilityLevel"],
            packages = packages,
            projectPath = basePath
        ))
    }

    private fun readUnityVersion(projectDir: VirtualFile): String? {
        val versionFile = projectDir.findChild("ProjectSettings")
            ?.findChild("ProjectVersion.txt") ?: return null
        return try {
            val content = String(versionFile.contentsToByteArray(), Charsets.UTF_8)
            VERSION_REGEX.find(content)?.groupValues?.get(1)
        } catch (_: Exception) {
            null
        }
    }

    private fun readProjectSettings(projectDir: VirtualFile): Map<String, String> {
        val settingsFile = projectDir.findChild("ProjectSettings")
            ?.findChild("ProjectSettings.asset") ?: return emptyMap()
        return try {
            val content = String(settingsFile.contentsToByteArray(), Charsets.UTF_8)
            val result = mutableMapOf<String, String>()

            COMPANY_REGEX.find(content)?.groupValues?.get(1)?.let { result["companyName"] = it }
            PRODUCT_REGEX.find(content)?.groupValues?.get(1)?.let { result["productName"] = it }

            val platforms = mutableListOf<String>()
            for (match in PLATFORM_REGEX.findAll(content)) {
                val platform = match.groupValues[1]
                val enabled = match.groupValues[2]
                if (enabled == "1") platforms.add(platform)
            }
            if (platforms.isNotEmpty()) result["targetPlatforms"] = platforms.joinToString(", ")

            SCRIPTING_BACKEND_REGEX.find(content)?.groupValues?.get(1)?.let { value ->
                result["scriptingBackend"] = if (value == "1") "IL2CPP" else "Mono"
            }

            API_COMPAT_REGEX.find(content)?.groupValues?.get(1)?.let { value ->
                result["apiCompatibilityLevel"] = when (value) {
                    "3" -> ".NET Standard 2.1"
                    "6" -> ".NET Framework"
                    else -> value
                }
            }

            result
        } catch (_: Exception) {
            emptyMap()
        }
    }

    private fun readPackageManifest(projectDir: VirtualFile): List<PackageInfo> {
        val manifestFile = projectDir.findChild("Packages")
            ?.findChild("manifest.json") ?: return emptyList()
        return try {
            val content = String(manifestFile.contentsToByteArray(), Charsets.UTF_8)
            val jsonObj = json.parseToJsonElement(content).let { it as? kotlinx.serialization.json.JsonObject } ?: return emptyList()
            val deps = jsonObj["dependencies"]?.let { it as? kotlinx.serialization.json.JsonObject } ?: return emptyList()

            deps.entries.map { (name, version) ->
                PackageInfo(
                    name = name,
                    version = version.toString().trim('"')
                )
            }.sortedBy { it.name }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun detectRenderPipeline(packages: List<PackageInfo>): String {
        val packageNames = packages.map { it.name }.toSet()
        return when {
            "com.unity.render-pipelines.universal" in packageNames -> "URP"
            "com.unity.render-pipelines.high-definition" in packageNames -> "HDRP"
            "com.unity.render-pipelines.core" in packageNames -> "SRP (custom)"
            else -> "Built-in"
        }
    }

    companion object {
        private val VERSION_REGEX = Regex("""m_EditorVersion:\s*(.+)""")
        private val COMPANY_REGEX = Regex("""companyName:\s*(.+)""")
        private val PRODUCT_REGEX = Regex("""productName:\s*(.+)""")
        private val PLATFORM_REGEX = Regex("""enabledNativePlatforms\w*?(\w+):\s*(\d)""")
        private val SCRIPTING_BACKEND_REGEX = Regex("""scriptingBackend:\s*\{[^}]*Standalone:\s*(\d)""")
        private val API_COMPAT_REGEX = Regex("""apiCompatibilityLevelPerPlatform:\s*\{[^}]*Standalone:\s*(\d)""")
    }
}

@Serializable
data class ProjectContextResult(
    val unityVersion: String?,
    val renderPipeline: String,
    val companyName: String?,
    val productName: String?,
    val targetPlatforms: List<String>,
    val scriptingBackend: String?,
    val apiCompatibilityLevel: String?,
    val packages: List<PackageInfo>,
    val projectPath: String
)

@Serializable
data class PackageInfo(
    val name: String,
    val version: String
)
