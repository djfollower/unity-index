package com.github.dungphan.unityindex.util

import com.github.dungphan.unityindex.tools.models.EdgeKind
import com.github.dungphan.unityindex.tools.models.GraphEdge
import com.github.dungphan.unityindex.tools.models.GraphNode
import com.github.dungphan.unityindex.tools.models.GraphSnapshot
import com.github.dungphan.unityindex.tools.models.ImpactClassification
import com.github.dungphan.unityindex.tools.models.ImpactedNode
import com.github.dungphan.unityindex.tools.models.TraversalDirection

/**
 * Pure-data port of `graph/core/src/traversal.ts`. The two implementations
 * MUST produce identical (node, edge, classification, sort) outputs for the
 * same snapshot — verified by `GraphTraversalTest` (Day 6 Task 11).
 *
 * Classification tables + edge-verb table live here too; whenever you edit
 * them in TS, mirror the change here in the same commit.
 */
object GraphTraversal {

    data class AdjacencyIndex(
        val out: Map<String, List<GraphEdge>>,
        val incoming: Map<String, List<GraphEdge>>,
        val nodesById: Map<String, GraphNode>,
    )

    fun buildAdjacency(snapshot: GraphSnapshot): AdjacencyIndex {
        val out = HashMap<String, MutableList<GraphEdge>>()
        val incoming = HashMap<String, MutableList<GraphEdge>>()
        val nodesById = LinkedHashMap<String, GraphNode>()
        for (n in snapshot.nodes) nodesById[n.id] = n
        for (e in snapshot.edges) {
            out.getOrPut(e.source) { mutableListOf() }.add(e)
            incoming.getOrPut(e.target) { mutableListOf() }.add(e)
        }
        return AdjacencyIndex(
            out = out.mapValues { it.value.toList() },
            incoming = incoming.mapValues { it.value.toList() },
            nodesById = nodesById,
        )
    }

    // --- neighbors ----------------------------------------------------------

    data class NeighborsOptions(
        val hops: Int,
        val direction: TraversalDirection,
        val edgeKinds: Set<EdgeKind>? = null,
        val maxNodes: Int,
    )

    data class NeighborsResult(
        val nodes: List<GraphNode>,
        val edges: List<GraphEdge>,
        val truncated: Boolean,
        val unresolvedIds: List<String>,
    )

    fun neighbors(
        adj: AdjacencyIndex,
        seeds: List<String>,
        opts: NeighborsOptions,
    ): NeighborsResult {
        val unresolved = mutableListOf<String>()
        val resolved = mutableListOf<String>()
        for (id in seeds) {
            if (adj.nodesById.containsKey(id)) resolved.add(id) else unresolved.add(id)
        }

        val visited = LinkedHashSet<String>()
        val edgeKeys = HashSet<String>()
        val resultEdges = mutableListOf<GraphEdge>()
        var truncated = false

        var frontier = mutableListOf<String>()
        for (id in resolved) {
            if (visited.contains(id)) continue
            if (visited.size >= opts.maxNodes) {
                truncated = true
                break
            }
            visited.add(id)
            frontier.add(id)
        }

        outer@ for (depth in 0 until opts.hops) {
            if (frontier.isEmpty()) break
            val next = mutableListOf<String>()
            for (src in frontier) {
                val cands = edgesForDirection(adj, src, opts.direction)
                for (e in cands) {
                    if (opts.edgeKinds != null && e.kind !in opts.edgeKinds) continue
                    val other = otherEnd(e, src, opts.direction) ?: continue
                    val key = "${e.kind.serialName()}:${e.source}:${e.target}"
                    if (edgeKeys.add(key)) resultEdges.add(e)
                    if (!visited.contains(other)) {
                        if (visited.size >= opts.maxNodes) {
                            truncated = true
                            break@outer
                        }
                        visited.add(other)
                        next.add(other)
                    }
                }
            }
            frontier = next
        }

        val nodes = visited.mapNotNull { adj.nodesById[it] }
        return NeighborsResult(
            nodes = nodes,
            edges = resultEdges.toList(),
            truncated = truncated,
            unresolvedIds = unresolved.toList(),
        )
    }

    private fun edgesForDirection(
        adj: AdjacencyIndex,
        id: String,
        direction: TraversalDirection,
    ): List<GraphEdge> {
        return when (direction) {
            TraversalDirection.OUT -> adj.out[id] ?: emptyList()
            TraversalDirection.IN -> adj.incoming[id] ?: emptyList()
            TraversalDirection.BOTH -> {
                val o = adj.out[id] ?: emptyList()
                val i = adj.incoming[id] ?: emptyList()
                if (o.isEmpty()) i else if (i.isEmpty()) o else o + i
            }
        }
    }

    private fun otherEnd(
        e: GraphEdge,
        from: String,
        direction: TraversalDirection,
    ): String? {
        return when (direction) {
            TraversalDirection.OUT -> if (e.source == from) e.target else null
            TraversalDirection.IN -> if (e.target == from) e.source else null
            TraversalDirection.BOTH -> when (from) {
                e.source -> e.target
                e.target -> e.source
                else -> null
            }
        }
    }

    // --- impact -------------------------------------------------------------

    data class ImpactOptions(
        val maxDepth: Int? = null,
        val classify: Boolean,
    )

    data class ImpactResult(
        val nodes: List<GraphNode>,
        val edges: List<GraphEdge>,
        val impacted: List<ImpactedNode>,
    )

    // Mirror of DIRECT_EDGE_KINDS in traversal.ts.
    private val DIRECT_EDGE_KINDS: Set<EdgeKind> = setOf(
        EdgeKind.SCRIPT_USED_BY_PREFAB,
        EdgeKind.SCRIPT_USED_BY_SCENE,
        EdgeKind.SCENE_CONTAINS_PREFAB,
        EdgeKind.PREFAB_VARIANT_OF,
        EdgeKind.CLASS_INHERITS_FROM,
        EdgeKind.CLASS_IMPLEMENTS_INTERFACE,
        EdgeKind.METHOD_OVERRIDES_METHOD,
    )

    // Mirror of EDGE_VERBS in traversal.ts.
    private val EDGE_VERBS: Map<EdgeKind, String> = mapOf(
        EdgeKind.SCRIPT_USED_BY_PREFAB to "uses script",
        EdgeKind.SCRIPT_USED_BY_SCENE to "uses script",
        EdgeKind.SCENE_CONTAINS_PREFAB to "contains prefab",
        EdgeKind.PREFAB_VARIANT_OF to "is variant of",
        EdgeKind.SERIALIZED_BINDING to "references",
        EdgeKind.GUID_RESOLVES_TO to "resolves to",
        EdgeKind.ADDRESSABLE_GROUP_CONTAINS to "groups",
        EdgeKind.CLASS_INHERITS_FROM to "inherits",
        EdgeKind.CLASS_IMPLEMENTS_INTERFACE to "implements",
        EdgeKind.METHOD_OVERRIDES_METHOD to "overrides",
        EdgeKind.METHOD_CALLS_METHOD to "calls",
        EdgeKind.CLASS_REFERENCES_CLASS to "references",
        EdgeKind.SCRIPT_DECLARES_CLASS to "declares",
    )

    private fun impactReason(other: GraphNode, seed: GraphNode, edge: GraphEdge): String {
        val verb = EDGE_VERBS[edge.kind] ?: "is connected to"
        return "${other.kind.serialName()} '${other.label}' $verb '${seed.label}'"
    }

    fun impact(
        adj: AdjacencyIndex,
        seeds: List<String>,
        opts: ImpactOptions,
    ): ImpactResult {
        val seedSet = LinkedHashSet<String>()
        for (id in seeds) if (adj.nodesById.containsKey(id)) seedSet.add(id)

        data class VisitInfo(
            val distance: Int,
            val predEdge: GraphEdge? = null,
            val predId: String? = null,
            val weakOnPath: Boolean = false,
        )

        val visited = LinkedHashMap<String, VisitInfo>()
        val max = opts.maxDepth ?: Int.MAX_VALUE

        var frontier = mutableListOf<String>()
        for (id in seedSet) {
            visited[id] = VisitInfo(distance = 0)
            frontier.add(id)
        }

        var depth = 0
        while (depth < max && frontier.isNotEmpty()) {
            val next = mutableListOf<String>()
            for (src in frontier) {
                val incoming = adj.incoming[src] ?: continue
                val fromInfo = visited[src]
                val fromWeak = fromInfo?.weakOnPath == true
                for (e in incoming) {
                    val other = e.source
                    if (visited.containsKey(other)) continue
                    val weakOnPath = fromWeak || e.kind == EdgeKind.SERIALIZED_BINDING
                    visited[other] = VisitInfo(
                        distance = depth + 1,
                        predEdge = e,
                        predId = src,
                        weakOnPath = weakOnPath,
                    )
                    next.add(other)
                }
            }
            frontier = next
            depth += 1
        }

        val impacted = mutableListOf<ImpactedNode>()
        val nodes = mutableListOf<GraphNode>()
        val edgeKeys = HashSet<String>()
        val resultEdges = mutableListOf<GraphEdge>()

        for ((id, info) in visited) {
            val node = adj.nodesById[id] ?: continue
            nodes.add(node)
            if (id in seedSet) continue

            var cursor = id
            var reachedSeed: GraphNode? = null
            var firstHopEdge: GraphEdge? = null
            var firstHopOther: GraphNode? = null
            while (true) {
                val ci = visited[cursor]
                if (ci?.predEdge == null || ci.predId == null) {
                    reachedSeed = adj.nodesById[cursor]
                    break
                }
                val key = "${ci.predEdge.kind.serialName()}:${ci.predEdge.source}:${ci.predEdge.target}"
                if (edgeKeys.add(key)) resultEdges.add(ci.predEdge)
                if (firstHopEdge == null) {
                    firstHopEdge = ci.predEdge
                    firstHopOther = adj.nodesById[ci.predId]
                }
                cursor = ci.predId
            }

            val classification: ImpactClassification? = when {
                !opts.classify -> null
                info.weakOnPath -> ImpactClassification.WEAK
                info.distance == 1 && firstHopEdge != null && firstHopEdge.kind in DIRECT_EDGE_KINDS ->
                    ImpactClassification.DIRECT
                else -> ImpactClassification.TRANSITIVE
            }

            val reason = when {
                firstHopEdge != null && firstHopOther != null && reachedSeed != null ->
                    impactReason(node, firstHopOther, firstHopEdge)
                reachedSeed != null ->
                    "${node.kind.serialName()} '${node.label}' reaches '${reachedSeed.label}'"
                else -> "${node.kind.serialName()} '${node.label}'"
            }

            impacted.add(
                ImpactedNode(
                    id = id,
                    distance = info.distance,
                    classification = classification,
                    reason = reason,
                )
            )
        }

        // Sort: distance asc, id lex asc — required for byte-equivalence.
        impacted.sortWith(compareBy({ it.distance }, { it.id }))

        return ImpactResult(nodes = nodes.toList(), edges = resultEdges.toList(), impacted = impacted.toList())
    }

    // --- context ------------------------------------------------------------

    data class ContextOptions(val maxNeighbors: Int)

    data class ContextResult(
        val node: GraphNode,
        val incoming: List<EdgeEndpoint>,
        val outgoing: List<EdgeEndpoint>,
        val truncated: Boolean,
    )

    data class EdgeEndpoint(val edge: GraphEdge, val other: GraphNode)

    fun context(
        adj: AdjacencyIndex,
        nodeId: String,
        opts: ContextOptions,
    ): ContextResult? {
        val node = adj.nodesById[nodeId] ?: return null
        val incomingEdges = adj.incoming[nodeId] ?: emptyList()
        val outgoingEdges = adj.out[nodeId] ?: emptyList()

        var truncated = false
        val incoming = mutableListOf<EdgeEndpoint>()
        for (e in incomingEdges) {
            if (incoming.size >= opts.maxNeighbors) {
                truncated = true
                break
            }
            val other = adj.nodesById[e.source] ?: continue
            incoming.add(EdgeEndpoint(e, other))
        }
        val outgoing = mutableListOf<EdgeEndpoint>()
        for (e in outgoingEdges) {
            if (outgoing.size >= opts.maxNeighbors) {
                truncated = true
                break
            }
            val other = adj.nodesById[e.target] ?: continue
            outgoing.add(EdgeEndpoint(e, other))
        }
        return ContextResult(node, incoming.toList(), outgoing.toList(), truncated)
    }
}

// Helper: serialize an enum to its @SerialName string so edge-key strings
// match between TS (kind string) and Kotlin (enum). The @SerialName lookup
// requires reflection on JVM; we hard-code the table here to avoid that
// cost on the hot path.
private fun EdgeKind.serialName(): String = when (this) {
    EdgeKind.SCRIPT_USED_BY_PREFAB -> "script_used_by_prefab"
    EdgeKind.SCRIPT_USED_BY_SCENE -> "script_used_by_scene"
    EdgeKind.SCENE_CONTAINS_PREFAB -> "scene_contains_prefab"
    EdgeKind.PREFAB_VARIANT_OF -> "prefab_variant_of"
    EdgeKind.SERIALIZED_BINDING -> "serialized_binding"
    EdgeKind.GUID_RESOLVES_TO -> "guid_resolves_to"
    EdgeKind.ADDRESSABLE_GROUP_CONTAINS -> "addressable_group_contains"
    EdgeKind.CLASS_INHERITS_FROM -> "class_inherits_from"
    EdgeKind.CLASS_IMPLEMENTS_INTERFACE -> "class_implements_interface"
    EdgeKind.METHOD_OVERRIDES_METHOD -> "method_overrides_method"
    EdgeKind.METHOD_CALLS_METHOD -> "method_calls_method"
    EdgeKind.CLASS_REFERENCES_CLASS -> "class_references_class"
    EdgeKind.SCRIPT_DECLARES_CLASS -> "script_declares_class"
}

private fun com.github.dungphan.unityindex.tools.models.NodeKind.serialName(): String = when (this) {
    com.github.dungphan.unityindex.tools.models.NodeKind.SCRIPT -> "script"
    com.github.dungphan.unityindex.tools.models.NodeKind.PREFAB -> "prefab"
    com.github.dungphan.unityindex.tools.models.NodeKind.PREFAB_VARIANT -> "prefab_variant"
    com.github.dungphan.unityindex.tools.models.NodeKind.SCENE -> "scene"
    com.github.dungphan.unityindex.tools.models.NodeKind.SO -> "so"
    com.github.dungphan.unityindex.tools.models.NodeKind.ASSET -> "asset"
    com.github.dungphan.unityindex.tools.models.NodeKind.ADDRESSABLE_GROUP -> "addressable_group"
    com.github.dungphan.unityindex.tools.models.NodeKind.NAMESPACE -> "namespace"
    com.github.dungphan.unityindex.tools.models.NodeKind.CLASS -> "class"
    com.github.dungphan.unityindex.tools.models.NodeKind.INTERFACE -> "interface"
    com.github.dungphan.unityindex.tools.models.NodeKind.STRUCT -> "struct"
    com.github.dungphan.unityindex.tools.models.NodeKind.ENUM -> "enum"
    com.github.dungphan.unityindex.tools.models.NodeKind.METHOD -> "method"
    com.github.dungphan.unityindex.tools.models.NodeKind.PROPERTY -> "property"
    com.github.dungphan.unityindex.tools.models.NodeKind.FIELD -> "field"
    com.github.dungphan.unityindex.tools.models.NodeKind.COMPONENT_INSTANCE -> "component_instance"
    com.github.dungphan.unityindex.tools.models.NodeKind.COMPONENT_FIELD -> "component_field"
}
