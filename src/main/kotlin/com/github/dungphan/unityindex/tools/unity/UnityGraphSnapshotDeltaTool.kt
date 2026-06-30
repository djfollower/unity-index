package com.github.dungphan.unityindex.tools.unity

import com.github.dungphan.unityindex.constants.ToolNames
import com.github.dungphan.unityindex.graph.GraphSnapshotCache
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.models.GraphSnapshotDeltaRequest
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.intellij.openapi.project.Project
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Day 7 MCP surface for incremental Unity asset graph updates. Wire format
 * documented in `graph/core/src/snapshot-delta-wire.ts`.
 *
 * Routes through {@link GraphSnapshotCache} which holds the unfiltered
 * snapshot, listens to project VFS events, and serves a one-step delta when
 * a client is exactly one revision behind. Clients more than one revision
 * behind, or requesting a filtered delta, receive a `reset: true` response
 * carrying the current full snapshot.
 */
class UnityGraphSnapshotDeltaTool : AbstractMcpTool() {

    override val requiresPsiSync: Boolean = false

    override val name: String = ToolNames.UNITY_GRAPH_SNAPSHOT_DELTA

    override val description: String = """
        Return the changes to the Unity asset graph since a previously-cached `revision`. The response is either a `SnapshotDelta` (when the host can serve incremental changes) or a full reset payload (when the cache is cold, history is exhausted, or filters mismatched).

        Pass `since_revision = 0` to bootstrap. Filtered delta requests (`include_kinds` / `exclude_kinds` / `path_globs` / `include_orphans = false`) currently always reset with a full filtered snapshot.

        Parameters:
        - since_revision (required): the `revision` the client last applied.
        - include_kinds / exclude_kinds / path_globs / include_orphans: same semantics as `unity_graph_snapshot`. A filter mismatch with the cached base forces a reset.
        - project_path (optional): only needed when multiple projects are open.
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .projectPath()
        .property("since_revision", buildJsonObject {
            put("type", JsonPrimitive("integer"))
            put("description", JsonPrimitive("Revision the client last applied. Pass 0 to bootstrap."))
        })
        .property("include_kinds", buildJsonObject {
            put("type", JsonPrimitive("array"))
            put("description", JsonPrimitive("Restrict the delta to nodes of these NodeKinds."))
            put("items", buildJsonObject { put("type", JsonPrimitive("string")) })
        })
        .property("exclude_kinds", buildJsonObject {
            put("type", JsonPrimitive("array"))
            put("description", JsonPrimitive("Drop nodes of these NodeKinds. Applied after include_kinds."))
            put("items", buildJsonObject { put("type", JsonPrimitive("string")) })
        })
        .property("path_globs", buildJsonObject {
            put("type", JsonPrimitive("array"))
            put("description", JsonPrimitive("Project-relative globs that nodes must match."))
            put("items", buildJsonObject { put("type", JsonPrimitive("string")) })
        })
        .booleanProperty("include_orphans", "Default true. When false, nodes with degree 0 are dropped.")
        .stringProperty("request_id", "Optional; echoed back on the response for client correlation.")
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val request = try {
            json.decodeFromJsonElement(GraphSnapshotDeltaRequest.serializer(), arguments)
        } catch (e: Exception) {
            return createErrorResult("Invalid arguments: ${e.message}")
        }

        return try {
            val response = withContext(Dispatchers.IO) {
                GraphSnapshotCache.get(project).delta(request)
            }
            createJsonResult(response)
        } catch (e: IllegalStateException) {
            createErrorResult(e.message ?: "Failed to build asset graph")
        } catch (e: Exception) {
            createErrorResult("Failed to build asset graph: ${e.message}")
        }
    }
}
