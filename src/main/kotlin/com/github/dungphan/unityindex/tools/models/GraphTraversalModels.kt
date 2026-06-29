package com.github.dungphan.unityindex.tools.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Wire-format mirrors for the Day-6 neighbors/impact/context tools.
 * Field names match `graph/core/src/neighbors-wire.ts` exactly — both sides
 * are serializing to the same JSON.
 */

@Serializable
enum class TraversalDirection {
    @SerialName("in") IN,
    @SerialName("out") OUT,
    @SerialName("both") BOTH,
}

@Serializable
enum class ImpactClassification {
    @SerialName("direct") DIRECT,
    @SerialName("transitive") TRANSITIVE,
    @SerialName("weak") WEAK,
}

// --- neighbors --------------------------------------------------------------

@Serializable
data class GraphNeighborsRequest(
    val project_path: String? = null,
    val request_id: String? = null,
    val node_ids: List<String> = emptyList(),
    val hops: Int? = null,
    val direction: TraversalDirection? = null,
    val edge_kinds: List<EdgeKind>? = null,
    val max_nodes: Int? = null,
)

@Serializable
data class GraphNeighborsResponse(
    val request_id: String? = null,
    val generated_at: String,
    val warnings: List<GraphWarning>? = null,
    val snapshot: GraphSnapshot,
    val truncated: Boolean? = null,
)

// --- impact -----------------------------------------------------------------

@Serializable
data class GraphImpactRequest(
    val project_path: String? = null,
    val request_id: String? = null,
    val node_ids: List<String> = emptyList(),
    val max_depth: Int? = null,
    val classify: Boolean? = null,
)

@Serializable
data class ImpactedNode(
    val id: String,
    val distance: Int,
    val classification: ImpactClassification? = null,
    val reason: String,
)

@Serializable
data class GraphImpactResponse(
    val request_id: String? = null,
    val generated_at: String,
    val warnings: List<GraphWarning>? = null,
    val snapshot: GraphSnapshot,
    val impact: List<ImpactedNode>,
)

// --- context ----------------------------------------------------------------

@Serializable
data class GraphContextRequest(
    val project_path: String? = null,
    val request_id: String? = null,
    val node_id: String? = null,
    val include_code_summary: Boolean? = null,
    val include_diagnostics: Boolean? = null,
    val max_neighbors: Int? = null,
)

@Serializable
data class EdgeWithEndpoint(
    val edge: GraphEdge,
    val other: GraphNode,
)

// TODO(day-10): replace with the canonical diagnostic shape from the Day 10
// ide_diagnostics rework. Placeholder lets context tools compile now.
@Serializable
data class DiagnosticSummary(
    val severity: String,
    val message: String,
    val line: Int? = null,
)

@Serializable
data class GraphContextResponse(
    val request_id: String? = null,
    val generated_at: String,
    val warnings: List<GraphWarning>? = null,
    val node: GraphNode,
    val incoming: List<EdgeWithEndpoint>,
    val outgoing: List<EdgeWithEndpoint>,
    val code_summary: String? = null,
    val diagnostics: List<DiagnosticSummary>? = null,
    val truncated: Boolean? = null,
)
