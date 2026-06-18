package com.github.dungphan.unityindex.tools.unity

import com.github.dungphan.unityindex.constants.ToolNames
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.models.AssemblyDefinition
import com.github.dungphan.unityindex.tools.models.AssemblyMapResult
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileVisitor
import com.intellij.openapi.vfs.LocalFileSystem
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class GetAssemblyMapTool : AbstractMcpTool() {

    override val requiresPsiSync: Boolean = false

    override val name = ToolNames.GET_ASSEMBLY_MAP

    override val description = """
        Get the Unity project's assembly definition (.asmdef) structure and dependency graph. Returns all assembly definitions with their names, references, platform targets, and constraints.

        Use this to understand how the codebase is partitioned into compilation units, what depends on what, and where to place new code. Editor-only assemblies are flagged.

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

        val asmdefFiles = mutableListOf<VirtualFile>()
        VfsUtilCore.visitChildrenRecursively(projectDir, object : VirtualFileVisitor<Unit>() {
            override fun visitFile(file: VirtualFile): Boolean {
                if (file.extension == "asmdef") {
                    asmdefFiles.add(file)
                }
                return true
            }
        })

        if (asmdefFiles.isEmpty()) {
            return createJsonResult(AssemblyMapResult(
                assemblies = emptyList(),
                totalCount = 0,
                projectPath = basePath
            ))
        }

        val assemblies = asmdefFiles.mapNotNull { file ->
            parseAsmdef(file, basePath)
        }.sortedBy { it.name }

        return createJsonResult(AssemblyMapResult(
            assemblies = assemblies,
            totalCount = assemblies.size,
            projectPath = basePath
        ))
    }

    private fun parseAsmdef(file: VirtualFile, basePath: String): AssemblyDefinition? {
        return try {
            val content = String(file.contentsToByteArray(), Charsets.UTF_8)
            val jsonObj = json.parseToJsonElement(content).jsonObject

            val name = jsonObj["name"]?.jsonPrimitive?.content ?: return null
            val relativePath = file.path.removePrefix(basePath).removePrefix("/")

            val references = jsonObj["references"]?.jsonArray
                ?.map { it.jsonPrimitive.content } ?: emptyList()

            val includePlatforms = jsonObj["includePlatforms"]?.jsonArray
                ?.map { it.jsonPrimitive.content } ?: emptyList()

            val excludePlatforms = jsonObj["excludePlatforms"]?.jsonArray
                ?.map { it.jsonPrimitive.content } ?: emptyList()

            val defineConstraints = jsonObj["defineConstraints"]?.jsonArray
                ?.map { it.jsonPrimitive.content } ?: emptyList()

            val isEditorOnly = includePlatforms.singleOrNull() == "Editor" ||
                relativePath.contains("/Editor/", ignoreCase = true)

            AssemblyDefinition(
                name = name,
                file = relativePath,
                rootNamespace = jsonObj["rootNamespace"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() },
                references = references,
                includePlatforms = includePlatforms,
                excludePlatforms = excludePlatforms,
                allowUnsafeCode = jsonObj["allowUnsafeCode"]?.jsonPrimitive?.booleanOrNull ?: false,
                autoReferenced = jsonObj["autoReferenced"]?.jsonPrimitive?.booleanOrNull ?: true,
                noEngineReferences = jsonObj["noEngineReferences"]?.jsonPrimitive?.booleanOrNull ?: false,
                defineConstraints = defineConstraints,
                isEditorOnly = isEditorOnly
            )
        } catch (e: Exception) {
            null
        }
    }
}
