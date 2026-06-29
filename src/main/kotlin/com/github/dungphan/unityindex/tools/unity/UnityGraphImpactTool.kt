package com.github.dungphan.unityindex.tools.unity

import com.github.dungphan.unityindex.constants.ToolNames
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.models.GraphImpactRequest
import com.github.dungphan.unityindex.tools.models.GraphImpactResponse
import com.github.dungphan.unityindex.tools.models.GraphSnapshotRequest
import com.github.dungphan.unityindex.tools.models.GraphWarning
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.github.dungphan.unityindex.util.GraphTraversal
import com.github.dungphan.unityindex.util.GraphWarningCodes
import com.github.dungphan.unityindex.util.UnityAssetGraphBuilder
import com.intellij.openapi.project.Project
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Day-6 MCP surface — see `docs/graph-mcp-tools.md` §3.3.
 * Reverse-reachable closure: "what breaks if I delete this." Direction fixed to incoming.
 */
class UnityGraphImpactTool : AbstractMcpTool() {

    companion object {
        private const val MAX_SEEDS = 50
    }

    override val requiresPsiSync: Boolean = false

    override val name: String = ToolNames.UNITY_GRAPH_IMPACT

    override val description: String = """
        Compute the reverse-reachable closure of one or more graph nodes — i.e. everything that breaks if those nodes are deleted.
        Each impacted node carries a distance (BFS depth) and a classification: 'direct' (compile/run break), 'transitive' (depends via another break), or 'weak' (only referenced via serialized fields — survives as a missing-reference warning).
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .projectPath()
        .property("node_ids", buildJsonObject {
            put("type", JsonPrimitive("array"))
            put("description", JsonPrimitive("1..$MAX_SEEDS graph node IDs to seed the reverse-BFS."))
            put("items", buildJsonObject { put("type", JsonPrimitive("string")) })
        }, required = true)
        .intProperty("max_depth", "Optional BFS depth cap. Default unbounded.")
        .booleanProperty("classify", "Default true. Tags each impacted node with directness.")
        .stringProperty("request_id", "Optional; echoed back on the response for client correlation.")
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val request = try {
            json.decodeFromJsonElement(GraphImpactRequest.serializer(), arguments)
        } catch (e: Exception) {
            return createErrorResult("Invalid arguments: ${e.message}")
        }
        if (request.node_ids.isEmpty() || request.node_ids.size > MAX_SEEDS) {
            return createErrorResult(
                "node_ids must contain between 1 and $MAX_SEEDS entries (got ${request.node_ids.size})."
            )
        }
        val classify = request.classify ?: true

        return try {
            val snapshotReq = GraphSnapshotRequest(project_path = request.project_path)
            val fullResponse = withContext(Dispatchers.IO) {
                UnityAssetGraphBuilder.build(project, snapshotReq)
            }
            val adj = GraphTraversal.buildAdjacency(fullResponse.snapshot)
            val unresolved = request.node_ids.filterNot { adj.nodesById.containsKey(it) }
            val resolved = request.node_ids.filter { adj.nodesById.containsKey(it) }

            val result = GraphTraversal.impact(
                adj,
                resolved,
                GraphTraversal.ImpactOptions(maxDepth = request.max_depth, classify = classify),
            )

            val warnings = mutableListOf<GraphWarning>()
            for (id in unresolved) {
                warnings.add(
                    GraphWarning(
                        code = GraphWarningCodes.ID_UNRESOLVED,
                        message = "Seed node id '$id' not present in the current snapshot.",
                        context = buildJsonObject { put("id", JsonPrimitive(id)) },
                    )
                )
            }
            val subgraph = UnityAssetGraphBuilder.subgraphResponse(
                nodes = result.nodes,
                edges = result.edges,
                sourcePhase = fullResponse.snapshot.source_phase,
            )
            val response = GraphImpactResponse(
                request_id = request.request_id,
                generated_at = subgraph.generated_at,
                warnings = warnings.takeIf { it.isNotEmpty() },
                snapshot = subgraph,
                impact = result.impacted,
            )
            createJsonResult(response)
        } catch (e: IllegalStateException) {
            createErrorResult(e.message ?: "Failed to compute impact")
        } catch (e: Exception) {
            createErrorResult("Failed to compute impact: ${e.message}")
        }
    }
}
