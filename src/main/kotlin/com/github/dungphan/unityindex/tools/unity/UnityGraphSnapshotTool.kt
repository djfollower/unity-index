package com.github.dungphan.unityindex.tools.unity

import com.github.dungphan.unityindex.constants.ToolNames
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.models.GraphSnapshotRequest
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.github.dungphan.unityindex.util.UnityAssetGraphBuilder
import com.intellij.openapi.project.Project
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Day 2 MCP surface for the Unity asset graph. Wire format documented in
 * `docs/graph-mcp-tools.md` §3.1 (request/response) and `docs/graph-schema.md`
 * (node + edge taxonomy).
 *
 * Asset-domain only. Code edges (csharp nodes) arrive in Day 8.
 */
class UnityGraphSnapshotTool : AbstractMcpTool() {

    override val requiresPsiSync: Boolean = false

    override val name: String = ToolNames.UNITY_GRAPH_SNAPSHOT

    override val description: String = """
        Return the full Unity asset graph as a GraphSnapshot — every script, prefab, scene, ScriptableObject, and asset under the project, plus the edges between them (script_used_by_prefab/scene, scene_contains_prefab, prefab_variant_of, serialized_binding, script_declares_class).

        Sub-file kinds (`component_instance`, `component_field`) are never returned as top-level nodes; their counts go into `stats.skipped_component_*` and the underlying IDs ride along as edge metadata. Use `unity_graph_expand` (Phase 1, ships Day 6 or 7) to materialize them for a single container.

        `script_declares_class` edges point to `unity://csharp/T:<ClassName>` IDs that Day 8 (`unity_graph_code_edges`) will materialize. A single `dangling_csharp_targets` warning is emitted when any such edges are present.

        Parameters:
        - include_kinds (optional): NodeKind[] — keep only nodes of these kinds.
        - exclude_kinds (optional): NodeKind[] — applied after include_kinds.
        - path_globs (optional): string[] — include-only path filter (** any depth, * single segment, ? single char).
        - include_orphans (optional): bool — default true; when false, drop degree-0 nodes.
        - pagination (optional): { page_size?: int, cursor?: string } — opaque cursor.
        - project_path (optional): only needed when multiple projects are open.
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .projectPath()
        .property("include_kinds", buildJsonObject {
            put("type", JsonPrimitive("array"))
            put("description", JsonPrimitive("Restrict the snapshot to these NodeKinds (e.g. script, prefab, scene, so, asset)."))
            put("items", buildJsonObject {
                put("type", JsonPrimitive("string"))
            })
        })
        .property("exclude_kinds", buildJsonObject {
            put("type", JsonPrimitive("array"))
            put("description", JsonPrimitive("Drop nodes of these NodeKinds. Applied after include_kinds."))
            put("items", buildJsonObject { put("type", JsonPrimitive("string")) })
        })
        .property("path_globs", buildJsonObject {
            put("type", JsonPrimitive("array"))
            put("description", JsonPrimitive("Project-relative globs that nodes must match; edges crossing the boundary are dropped."))
            put("items", buildJsonObject { put("type", JsonPrimitive("string")) })
        })
        .booleanProperty("include_orphans", "Default true. When false, nodes with degree 0 are dropped.")
        .property("pagination", buildJsonObject {
            put("type", JsonPrimitive("object"))
            put("description", JsonPrimitive("Opaque pagination cursor. Slice nodes; edges crossing the page boundary are dropped."))
            put("properties", buildJsonObject {
                put("page_size", buildJsonObject {
                    put("type", JsonPrimitive("integer"))
                    put("description", JsonPrimitive("Default 5000, max 20000."))
                })
                put("cursor", buildJsonObject {
                    put("type", JsonPrimitive("string"))
                    put("description", JsonPrimitive("Opaque cursor from the previous response."))
                })
            })
        })
        .stringProperty("request_id", "Optional; echoed back on the response for client correlation.")
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val request = try {
            json.decodeFromJsonElement(GraphSnapshotRequest.serializer(), arguments)
        } catch (e: Exception) {
            return createErrorResult("Invalid arguments: ${e.message}")
        }

        return try {
            // UnityAssetGraphBuilder touches VFS + parses raw YAML — no PSI.
            // Wrapping in a platform read action held the read lock through a
            // multi-minute walk on large projects, starving write-intent actions
            // and freezing the EDT. Run on IO instead.
            val response = withContext(Dispatchers.IO) {
                UnityAssetGraphBuilder.build(project, request)
            }
            createJsonResult(response)
        } catch (e: IllegalStateException) {
            createErrorResult(e.message ?: "Failed to build asset graph")
        } catch (e: Exception) {
            createErrorResult("Failed to build asset graph: ${e.message}")
        }
    }

}
