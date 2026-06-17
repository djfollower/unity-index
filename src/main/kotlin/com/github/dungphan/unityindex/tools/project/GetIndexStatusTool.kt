package com.github.dungphan.unityindex.tools.project

import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.models.IndexStatusResult
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.intellij.openapi.project.DumbService
import com.intellij.openapi.project.Project
import kotlinx.serialization.json.JsonObject

class GetIndexStatusTool : AbstractMcpTool() {

    // This tool only checks status, no PSI operations needed
    override val requiresPsiSync: Boolean = false

    override val name = "ide_index_status"

    override val description = """
        Check if the IDE is ready for code intelligence operations. Use when other tools fail with indexing errors, or to verify IDE readiness before batch operations.

        Returns: isDumbMode (true = indexing in progress, limited functionality), isIndexing flag. When isDumbMode is true, wait and retry—most tools require indexing to complete.

        Parameters: project_path (optional, only needed with multiple projects open).

        Example: {}
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .projectPath()
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val dumbService = DumbService.getInstance(project)
        val isDumb = dumbService.isDumb

        return createJsonResult(IndexStatusResult(
            isDumbMode = isDumb,
            isIndexing = isDumb,
            indexingProgress = null
        ))
    }
}
