package com.github.dungphan.unityindex.tools.unity

import com.github.dungphan.unityindex.constants.ToolNames
import com.github.dungphan.unityindex.graph.GraphSnapshotCache
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.models.GraphSnapshotRequest
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.github.dungphan.unityindex.util.GraphClassAnchors
import com.intellij.openapi.project.Project
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.time.Instant

/**
 * Day 11 Task 7 — `unity_graph_export`.
 *
 * Returns a v1 `ExportDocument` (see graph/core/src/export-wire.ts) that a
 * client can persist to disk and re-import via the extension's "Open Graph
 * from File…" command. Mirrors what the webview's JSON export button
 * produces so a single MCP-driven workflow can bundle a graph without a
 * human sitting in front of the UI.
 *
 * Scope: asset snapshot + saved views + meta. Code-edge slices stay lazy —
 * clients that need them call `unity_graph_code_edges` separately and can
 * attach the result to a `codeEdges` block if their workflow requires it.
 */
class UnityGraphExportTool : AbstractMcpTool() {

    override val requiresPsiSync: Boolean = false

    override val name: String = ToolNames.UNITY_GRAPH_EXPORT

    override val description: String = """
        Return a self-contained JSON export of the current Unity graph — asset snapshot, saved views (if any), and producer metadata — wrapped in the v1 `ExportDocument` envelope so the same file can be re-loaded via the "Open Graph from File…" extension command.

        Scope: asset snapshot + `meta`. Saved views and code-edge slices are UI/workflow concerns and are not attached — call `unity_graph_code_edges` separately and merge results into a `codeEdges` block if your workflow needs them.

        Parameters:
        - include_class_anchors (optional): bool — materialize class anchors for `script_declares_class` targets before export. Same behaviour as `unity_graph_snapshot`.
        - note (optional): string — free-form note embedded in `meta.note` (e.g. a PR number).
        - project_path (optional): only needed when multiple projects are open.
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .projectPath()
        .booleanProperty(
            "include_class_anchors",
            "Default false. When true, materialize `class` anchors for `script_declares_class` targets before serialising.",
        )
        .stringProperty("note", "Free-form note embedded in `meta.note`.")
        .stringProperty("request_id", "Optional; echoed back on the response for client correlation.")
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val includeAnchors = (arguments["include_class_anchors"] as? JsonPrimitive)?.booleanOrNull ?: false
        val note = (arguments["note"] as? JsonPrimitive)?.contentOrNullIfBlank()
        val requestId = (arguments["request_id"] as? JsonPrimitive)?.contentOrNullIfBlank()

        return try {
            val snapshotResponse = withContext(Dispatchers.IO) {
                val req = GraphSnapshotRequest(include_class_anchors = includeAnchors)
                GraphSnapshotCache.get(project).snapshot(req)
            }
            val finalResponse = if (includeAnchors) {
                val res = GraphClassAnchors.materialize(snapshotResponse.snapshot, snapshotResponse.warnings)
                if (res.anchorsAdded > 0) snapshotResponse.copy(snapshot = res.snapshot, warnings = res.warnings)
                else snapshotResponse
            } else snapshotResponse
            val snapshotJson = json.encodeToJsonElement(
                com.github.dungphan.unityindex.tools.models.GraphSnapshot.serializer(),
                finalResponse.snapshot,
            )
            val doc = buildDocument(
                snapshotJson = snapshotJson,
                sourceProject = project.name,
                sourceProjectPath = project.basePath,
                note = note,
                requestId = requestId,
            )
            createJsonResult(doc)
        } catch (e: Exception) {
            createErrorResult("Failed to export graph: ${e.message}")
        }
    }

    private fun buildDocument(
        snapshotJson: JsonElement,
        sourceProject: String?,
        sourceProjectPath: String?,
        note: String?,
        requestId: String?,
    ): JsonObject = buildJsonObject {
        put("schemaVersion", JsonPrimitive(SCHEMA_VERSION))
        put("exportedAt", JsonPrimitive(Instant.now().toString()))
        put(
            "meta",
            buildJsonObject {
                put("producer", JsonPrimitive("mcp"))
                put("producerVersion", JsonPrimitive(PRODUCER_VERSION))
                if (sourceProject != null) put("sourceProject", JsonPrimitive(sourceProject))
                if (sourceProjectPath != null) put("sourceProjectPath", JsonPrimitive(sourceProjectPath))
                if (note != null) put("note", JsonPrimitive(note))
            },
        )
        put("snapshot", snapshotJson)
        if (requestId != null) put("request_id", JsonPrimitive(requestId))
    }

    companion object {
        /** Mirrors EXPORT_SCHEMA_VERSION in graph/core/src/export-wire.ts. */
        private const val SCHEMA_VERSION = "1.0"

        /** Mirrors gradle.properties#pluginVersion. Bumped in lockstep with
         *  vscode-extension/package.json per CLAUDE.md rule 3. */
        private const val PRODUCER_VERSION = "0.5.11"
    }
}

private val JsonPrimitive.booleanOrNull: Boolean?
    get() = when (this.content) {
        "true" -> true
        "false" -> false
        else -> null
    }

private fun JsonPrimitive.contentOrNullIfBlank(): String? =
    this.content.takeIf { it.isNotBlank() }
