package com.github.dungphan.unityindex.tools.unity

import com.github.dungphan.unityindex.constants.ToolNames
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.models.EdgeKind
import com.github.dungphan.unityindex.tools.models.GraphNeighborsRequest
import com.github.dungphan.unityindex.tools.models.GraphNeighborsResponse
import com.github.dungphan.unityindex.tools.models.GraphSnapshotRequest
import com.github.dungphan.unityindex.tools.models.GraphWarning
import com.github.dungphan.unityindex.tools.models.TraversalDirection
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
 * Day-6 MCP surface — see `docs/graph-mcp-tools.md` §3.2.
 * BFS from each seed (union), capped by hop count + max_nodes.
 */
class UnityGraphNeighborsTool : AbstractMcpTool() {

    companion object {
        private const val DEFAULT_HOPS = 1
        private const val MAX_HOPS = 4
        private const val DEFAULT_MAX_NODES = 2000
        private const val HARD_MAX_NODES = 20_000
        private const val MAX_SEEDS = 100
    }

    override val requiresPsiSync: Boolean = false

    override val name: String = ToolNames.UNITY_GRAPH_NEIGHBORS

    override val description: String = """
        Return the N-hop neighborhood around one or more graph nodes as a GraphSnapshot.
        BFS unions per seed; unresolved seed IDs are dropped (with an id_unresolved warning) and traversal continues for the rest.
        Pair with unity_graph_snapshot to discover IDs first, then use this for focused subgraph queries.
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .projectPath()
        .property("node_ids", buildJsonObject {
            put("type", JsonPrimitive("array"))
            put("description", JsonPrimitive("1..$MAX_SEEDS graph node IDs to seed the BFS."))
            put("items", buildJsonObject { put("type", JsonPrimitive("string")) })
        }, required = true)
        .intProperty("hops", "BFS depth, 1..$MAX_HOPS. Default $DEFAULT_HOPS.")
        .enumProperty(
            "direction",
            "Edge direction to traverse. Default 'both'.",
            listOf("in", "out", "both"),
        )
        .property("edge_kinds", buildJsonObject {
            put("type", JsonPrimitive("array"))
            put("description", JsonPrimitive("Restrict traversal to these EdgeKinds. Excluded kinds don't count toward the hop budget."))
            put("items", buildJsonObject { put("type", JsonPrimitive("string")) })
        })
        .intProperty(
            "max_nodes",
            "Hard cap on returned nodes. Default $DEFAULT_MAX_NODES, max $HARD_MAX_NODES.",
        )
        .stringProperty("request_id", "Optional; echoed back on the response for client correlation.")
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val request = try {
            json.decodeFromJsonElement(GraphNeighborsRequest.serializer(), arguments)
        } catch (e: Exception) {
            return createErrorResult("Invalid arguments: ${e.message}")
        }
        if (request.node_ids.isEmpty() || request.node_ids.size > MAX_SEEDS) {
            return createErrorResult(
                "node_ids must contain between 1 and $MAX_SEEDS entries (got ${request.node_ids.size})."
            )
        }
        val hops = (request.hops ?: DEFAULT_HOPS).coerceIn(1, MAX_HOPS)
        val direction = request.direction ?: TraversalDirection.BOTH
        val maxNodes = (request.max_nodes ?: DEFAULT_MAX_NODES).coerceIn(1, HARD_MAX_NODES)
        val edgeKinds: Set<EdgeKind>? = request.edge_kinds?.toSet()

        return try {
            val snapshotReq = GraphSnapshotRequest(project_path = request.project_path)
            val fullResponse = withContext(Dispatchers.IO) {
                UnityAssetGraphBuilder.build(project, snapshotReq)
            }
            val adj = GraphTraversal.buildAdjacency(fullResponse.snapshot)
            val result = GraphTraversal.neighbors(
                adj,
                request.node_ids,
                GraphTraversal.NeighborsOptions(
                    hops = hops,
                    direction = direction,
                    edgeKinds = edgeKinds,
                    maxNodes = maxNodes,
                ),
            )
            val warnings = mutableListOf<GraphWarning>()
            for (id in result.unresolvedIds) {
                warnings.add(
                    GraphWarning(
                        code = GraphWarningCodes.ID_UNRESOLVED,
                        message = "Seed node id '$id' not present in the current snapshot.",
                        context = buildJsonObject { put("id", JsonPrimitive(id)) },
                    )
                )
            }
            if (result.truncated) {
                warnings.add(
                    GraphWarning(
                        code = GraphWarningCodes.NEIGHBORS_TRUNCATED,
                        message = "BFS hit max_nodes=$maxNodes during expansion.",
                        context = buildJsonObject { put("max_nodes", JsonPrimitive(maxNodes)) },
                    )
                )
            }
            val subgraph = UnityAssetGraphBuilder.subgraphResponse(
                nodes = result.nodes,
                edges = result.edges,
                sourcePhase = fullResponse.snapshot.source_phase,
            )
            val response = GraphNeighborsResponse(
                request_id = request.request_id,
                generated_at = subgraph.generated_at,
                warnings = warnings.takeIf { it.isNotEmpty() },
                snapshot = subgraph,
                truncated = if (result.truncated) true else null,
            )
            createJsonResult(response)
        } catch (e: IllegalStateException) {
            createErrorResult(e.message ?: "Failed to compute neighbors")
        } catch (e: Exception) {
            createErrorResult("Failed to compute neighbors: ${e.message}")
        }
    }
}
