package com.github.dungphan.unityindex.tools.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
enum class NodeKind {
    @SerialName("script") SCRIPT,
    @SerialName("prefab") PREFAB,
    @SerialName("prefab_variant") PREFAB_VARIANT,
    @SerialName("scene") SCENE,
    @SerialName("so") SO,
    @SerialName("asset") ASSET,
    @SerialName("addressable_group") ADDRESSABLE_GROUP,
    @SerialName("namespace") NAMESPACE,
    @SerialName("class") CLASS,
    @SerialName("interface") INTERFACE,
    @SerialName("struct") STRUCT,
    @SerialName("enum") ENUM,
    @SerialName("method") METHOD,
    @SerialName("property") PROPERTY,
    @SerialName("field") FIELD,
    @SerialName("component_instance") COMPONENT_INSTANCE,
    @SerialName("component_field") COMPONENT_FIELD,
}

@Serializable
enum class EdgeKind {
    @SerialName("script_used_by_prefab") SCRIPT_USED_BY_PREFAB,
    @SerialName("script_used_by_scene") SCRIPT_USED_BY_SCENE,
    @SerialName("scene_contains_prefab") SCENE_CONTAINS_PREFAB,
    @SerialName("prefab_variant_of") PREFAB_VARIANT_OF,
    @SerialName("serialized_binding") SERIALIZED_BINDING,
    @SerialName("guid_resolves_to") GUID_RESOLVES_TO,
    @SerialName("addressable_group_contains") ADDRESSABLE_GROUP_CONTAINS,
    @SerialName("class_inherits_from") CLASS_INHERITS_FROM,
    @SerialName("class_implements_interface") CLASS_IMPLEMENTS_INTERFACE,
    @SerialName("method_overrides_method") METHOD_OVERRIDES_METHOD,
    @SerialName("method_calls_method") METHOD_CALLS_METHOD,
    @SerialName("class_references_class") CLASS_REFERENCES_CLASS,
    @SerialName("script_declares_class") SCRIPT_DECLARES_CLASS,
}

@Serializable
enum class GraphSourcePhase {
    @SerialName("asset") ASSET,
    @SerialName("code") CODE,
    @SerialName("combined") COMBINED,
}

@Serializable
data class GraphNodeLocation(
    val line: Int,
    val column: Int? = null,
)

@Serializable
data class GraphNode(
    val id: String,
    val kind: NodeKind,
    val label: String,
    val path: String? = null,
    val guid: String? = null,
    val location: GraphNodeLocation? = null,
    val metadata: JsonObject,
)

@Serializable
data class GraphEdge(
    val source: String,
    val target: String,
    val kind: EdgeKind,
    val metadata: JsonObject,
)

@Serializable
data class GraphStats(
    val node_count: Int,
    val edge_count: Int,
    val skipped_component_instances: Int,
    val skipped_component_fields: Int,
)

@Serializable
data class GraphSnapshot(
    val nodes: List<GraphNode>,
    val edges: List<GraphEdge>,
    val generated_at: String,
    val source_phase: GraphSourcePhase,
    val stats: GraphStats,
)

@Serializable
data class GraphPageRequest(
    val page_size: Int? = null,
    val cursor: String? = null,
)

@Serializable
data class GraphPageResponse(
    val next_cursor: String? = null,
    val total_estimated: Int? = null,
)

@Serializable
data class GraphWarning(
    val code: String,
    val message: String,
    val context: JsonObject? = null,
)

@Serializable
data class GraphSnapshotRequest(
    val project_path: String? = null,
    val request_id: String? = null,
    val include_kinds: List<NodeKind>? = null,
    val exclude_kinds: List<NodeKind>? = null,
    val path_globs: List<String>? = null,
    val include_orphans: Boolean? = null,
    val pagination: GraphPageRequest? = null,
    /** Day 8.4 — when true, materialize one `class` node per
     *  `script_declares_class` edge target so the UI has anchors for Day 8
     *  code-edge expansion. Mirrors `SnapshotRequest.include_class_anchors`
     *  in graph/core/src/snapshot-wire.ts. */
    val include_class_anchors: Boolean? = null,
)

@Serializable
data class GraphSnapshotResponse(
    val request_id: String? = null,
    val generated_at: String,
    val warnings: List<GraphWarning>? = null,
    val snapshot: GraphSnapshot,
    val page: GraphPageResponse? = null,
    /**
     * Day 7 — revision at which the host minted this snapshot. The client
     * stores this alongside the cached snapshot and passes it back as
     * `since_revision` on `unity_graph_snapshot_delta`. Omitted by hosts
     * that do not maintain incremental state (delta updates unavailable).
     */
    val revision: Int? = null,
)

// ---------------------------------------------------------------------------
// Day 7 — incremental snapshot updates. Mirrors graph/core/src/snapshot-
// delta-wire.ts; see that file for the canonical contract documentation.
// Both implementations MUST emit the same field names and the same
// reset-vs-delta discriminator so a single MCP client config works against
// either host.
// ---------------------------------------------------------------------------

@Serializable
data class GraphEdgeKey(
    val source: String,
    val target: String,
    val kind: EdgeKind,
)

@Serializable
data class GraphSnapshotDelta(
    val base_revision: Int,
    val new_revision: Int,
    val generated_at: String,
    val source_phase: GraphSourcePhase,
    val nodes_added: List<GraphNode>,
    val nodes_removed: List<String>,
    val nodes_updated: List<GraphNode>,
    val edges_added: List<GraphEdge>,
    val edges_removed: List<GraphEdgeKey>,
    val stats: GraphStats,
    val affected_paths: List<String>? = null,
)

@Serializable
data class GraphSnapshotDeltaRequest(
    val project_path: String? = null,
    val request_id: String? = null,
    /** Pass 0 to force a reset path (bootstrap, no client cache). */
    val since_revision: Int,
    val include_kinds: List<NodeKind>? = null,
    val exclude_kinds: List<NodeKind>? = null,
    val path_globs: List<String>? = null,
    val include_orphans: Boolean? = null,
)

// ---------------------------------------------------------------------------
// Day 8 — unity_graph_code_edges. Mirrors graph/core/src/code-edges-wire.ts;
// see that file for the canonical contract documentation. Both
// implementations MUST emit the same field names so a single MCP client
// config works against either host.
// ---------------------------------------------------------------------------

@Serializable
data class CodeEdgesRequest(
    val project_path: String? = null,
    val request_id: String? = null,
    /** 1..500 `unity://csharp/...` IDs. Optional when [subtypes_of] is set. */
    val symbol_ids: List<String> = emptyList(),
    /** Filter — only return edges of these kinds. Omit/empty for all. */
    val edge_kinds: List<EdgeKind>? = null,
    /** When false, the response contains edges only. Default: true. */
    val include_targets: Boolean? = null,
    /** Day 9.3 — transitive subtypes preset. When set, the host BFSes the
     *  type-hierarchy provider's subtypes from this `unity://csharp/T:...`
     *  root and emits the resulting `class_inherits_from` /
     *  `class_implements_interface` edges. See
     *  graph/core/src/code-edges-wire.ts for the full contract. */
    val subtypes_of: String? = null,
    /** Day 9.3 — depth cap for [subtypes_of]. Defaults to 8. */
    val subtypes_max_depth: Int? = null,
)

@Serializable
data class CodeEdgesResponse(
    val request_id: String? = null,
    val generated_at: String,
    val warnings: List<GraphWarning>? = null,
    val snapshot: GraphSnapshot,
    val unresolved_ids: List<String>? = null,
)

// ---------------------------------------------------------------------------
// Day 10 — unity_graph_diagnostics. Mirrors graph/core/src/diagnostics-wire.ts;
// see that file for the canonical contract documentation. Both
// implementations MUST emit the same field names so a single MCP client
// config works against either host.
// ---------------------------------------------------------------------------

@Serializable
enum class DiagnosticSeverity {
    @SerialName("error") ERROR,
    @SerialName("warning") WARNING,
    @SerialName("info") INFO,
}

@Serializable
enum class MaxDiagnosticSeverity {
    @SerialName("error") ERROR,
    @SerialName("warning") WARNING,
    @SerialName("info") INFO,
    @SerialName("none") NONE,
}

@Serializable
data class DiagnosticMessage(
    val severity: DiagnosticSeverity,
    val message: String,
    val line: Int? = null,
    val column: Int? = null,
)

@Serializable
data class NodeDiagnostics(
    val node_id: String,
    val errors: Int,
    val warnings: Int,
    val infos: Int,
    val max_severity: MaxDiagnosticSeverity,
    val top_messages: List<DiagnosticMessage>? = null,
)

@Serializable
data class DiagnosticsBatchRequest(
    val project_path: String? = null,
    val request_id: String? = null,
    val node_ids: List<String> = emptyList(),
    val include_messages: Boolean? = null,
    val max_messages_per_node: Int? = null,
)

@Serializable
data class DiagnosticsBatchResponse(
    val request_id: String? = null,
    val generated_at: String,
    val warnings: List<GraphWarning>? = null,
    val diagnostics: List<NodeDiagnostics>,
    val unresolved_ids: List<String>? = null,
)

@Serializable
data class GraphSnapshotDeltaResponse(
    val request_id: String? = null,
    val generated_at: String,
    val warnings: List<GraphWarning>? = null,
    val reset: Boolean,
    val new_revision: Int,
    val delta: GraphSnapshotDelta? = null,
    val snapshot: GraphSnapshot? = null,
)
