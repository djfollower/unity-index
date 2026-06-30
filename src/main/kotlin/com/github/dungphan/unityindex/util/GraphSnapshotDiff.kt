package com.github.dungphan.unityindex.util

import com.github.dungphan.unityindex.tools.models.GraphEdge
import com.github.dungphan.unityindex.tools.models.GraphEdgeKey
import com.github.dungphan.unityindex.tools.models.GraphNode
import com.github.dungphan.unityindex.tools.models.GraphSnapshot
import com.github.dungphan.unityindex.tools.models.GraphSnapshotDelta
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Day 7 — pure snapshot diff. Mirrors `graph/core/src/snapshot-diff.ts`. The
 * cross-impl byte-equivalence rule from CLAUDE.md applies: a change here must
 * be reflected in the TS file with the same identity and equality semantics,
 * or one host will compute deltas the other refuses to apply.
 *
 * Identity:
 *   - Nodes are keyed by `id`.
 *   - Edges are keyed by `(source, target, kind)` via [edgeKeyString].
 *
 * Update detection on nodes is deep equality over the user-visible attrs
 * (kind, label, path, guid, location, metadata). Metadata comparison uses
 * canonical JSON (sorted object keys) because the wire payload is opaque
 * `JsonObject` on this side and `Record<string, unknown>` on the TS side.
 *
 * Edge updates are modelled as remove + add — see snapshot-delta-wire.ts.
 */
object GraphSnapshotDiff {

    data class Options(
        val baseRevision: Int,
        val newRevision: Int,
        /** Project-relative paths that triggered the rebuild. Pass through. */
        val affectedPaths: List<String>? = null,
        /** Override for `generated_at`; defaults to `next.generated_at`. */
        val generatedAt: String? = null,
    )

    /**
     * Diff two snapshots. Pure; no I/O; no mutation of inputs.
     *
     * Pre-condition: callers must have already decided `next` is the
     * successor of `prev` at the chosen revision pair. The cache layer is
     * responsible for emitting a `reset` when the inputs aren't a valid
     * successor pair (different project, different `source_phase`, etc.).
     */
    fun diff(prev: GraphSnapshot, next: GraphSnapshot, opts: Options): GraphSnapshotDelta {
        val prevNodes = HashMap<String, GraphNode>(prev.nodes.size)
        for (n in prev.nodes) prevNodes[n.id] = n
        val nextNodes = HashMap<String, GraphNode>(next.nodes.size)
        for (n in next.nodes) nextNodes[n.id] = n

        val nodesAdded = ArrayList<GraphNode>()
        val nodesRemoved = ArrayList<String>()
        val nodesUpdated = ArrayList<GraphNode>()

        for ((id, node) in nextNodes) {
            val prior = prevNodes[id]
            when {
                prior == null -> nodesAdded.add(node)
                !nodesEqual(prior, node) -> nodesUpdated.add(node)
            }
        }
        for (id in prevNodes.keys) {
            if (id !in nextNodes) nodesRemoved.add(id)
        }

        val prevEdges = HashMap<String, GraphEdge>(prev.edges.size)
        for (e in prev.edges) prevEdges[edgeKeyString(e)] = e
        val nextEdges = HashMap<String, GraphEdge>(next.edges.size)
        for (e in next.edges) nextEdges[edgeKeyString(e)] = e

        val edgesAdded = ArrayList<GraphEdge>()
        val edgesRemoved = ArrayList<GraphEdgeKey>()

        for ((key, edge) in nextEdges) {
            val prior = prevEdges[key]
            when {
                prior == null -> edgesAdded.add(edge)
                !metadataEqual(prior.metadata, edge.metadata) -> {
                    edgesRemoved.add(GraphEdgeKey(prior.source, prior.target, prior.kind))
                    edgesAdded.add(edge)
                }
            }
        }
        for ((key, edge) in prevEdges) {
            if (key !in nextEdges) {
                edgesRemoved.add(GraphEdgeKey(edge.source, edge.target, edge.kind))
            }
        }

        return GraphSnapshotDelta(
            base_revision = opts.baseRevision,
            new_revision = opts.newRevision,
            generated_at = opts.generatedAt ?: next.generated_at,
            source_phase = next.source_phase,
            nodes_added = nodesAdded,
            nodes_removed = nodesRemoved,
            nodes_updated = nodesUpdated,
            edges_added = edgesAdded,
            edges_removed = edgesRemoved,
            stats = next.stats,
            affected_paths = opts.affectedPaths,
        )
    }

    /** Returns true if the delta has no node or edge changes. The cache uses
     *  this to skip revision bumps for spurious file-system events. */
    fun isEmpty(d: GraphSnapshotDelta): Boolean {
        return d.nodes_added.isEmpty() &&
            d.nodes_removed.isEmpty() &&
            d.nodes_updated.isEmpty() &&
            d.edges_added.isEmpty() &&
            d.edges_removed.isEmpty()
    }

    /**
     * Implementation-internal edge key used as a HashMap lookup during the
     * diff. Differs from `edgeKey()` in graph/core only in the enum portion:
     * TS uses the wire string (e.g. `script_used_by_prefab`) while we use
     * `EdgeKind.name` here. This key never crosses the wire — what crosses
     * is the GraphEdgeKey triple, which serialises via @SerialName and
     * therefore matches TS byte-for-byte.
     */
    fun edgeKeyString(e: GraphEdge): String {
        return e.source + EDGE_KEY_SEPARATOR + e.target + EDGE_KEY_SEPARATOR + e.kind.name
    }

    /** Same U+001F unit-separator as graph/core's `EDGE_KEY_SEPARATOR`. */
    const val EDGE_KEY_SEPARATOR = "\u001F"

    // ------------------------------------------------------------------------
    // Equality helpers — internal. Exposed via @VisibleForTesting only.
    // ------------------------------------------------------------------------

    internal fun nodesEqual(a: GraphNode, b: GraphNode): Boolean {
        if (a.kind != b.kind) return false
        if (a.label != b.label) return false
        if (a.path != b.path) return false
        if (a.guid != b.guid) return false

        val al = a.location
        val bl = b.location
        if (al != null && bl != null) {
            if (al.line != bl.line) return false
            if (al.column != bl.column) return false
        } else if (al != null || bl != null) {
            return false
        }
        return metadataEqual(a.metadata, b.metadata)
    }

    internal fun metadataEqual(a: JsonObject, b: JsonObject): Boolean {
        if (a.size != b.size) return false
        return canonicalJson(a) == canonicalJson(b)
    }

    internal fun canonicalJson(v: JsonElement): String {
        return when (v) {
            is JsonNull -> "null"
            is JsonPrimitive -> v.toString()
            is JsonArray -> v.joinToString(prefix = "[", postfix = "]") { canonicalJson(it) }
            is JsonObject -> v.keys.sorted().joinToString(prefix = "{", postfix = "}") { k ->
                "\"" + k + "\":" + canonicalJson(v[k]!!)
            }
        }
    }
}
