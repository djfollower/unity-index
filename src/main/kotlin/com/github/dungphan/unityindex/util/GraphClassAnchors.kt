package com.github.dungphan.unityindex.util

import com.github.dungphan.unityindex.tools.models.EdgeKind
import com.github.dungphan.unityindex.tools.models.GraphNode
import com.github.dungphan.unityindex.tools.models.GraphSnapshot
import com.github.dungphan.unityindex.tools.models.GraphStats
import com.github.dungphan.unityindex.tools.models.GraphWarning
import com.github.dungphan.unityindex.tools.models.NodeKind
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * Day 8.4 — class-anchor materialization.
 *
 * Mirror of `graph/core/src/class-anchors.ts`. The asset snapshot emits
 * `script_declares_class` edges pointing at `unity://csharp/T:<ClassName>`
 * IDs that the asset builder never realizes as nodes. This helper turns
 * each dangling target into a stub `class` node so the webview has stable
 * anchors for Day 8.5's lazy code-edge expansion.
 *
 * Pure: the input snapshot is never mutated. The Kotlin and TS
 * implementations MUST produce byte-identical output for the same input.
 */
object GraphClassAnchors {

    private const val CSHARP_TYPE_PREFIX = "unity://csharp/T:"

    data class Result(
        val snapshot: GraphSnapshot,
        val warnings: List<GraphWarning>?,
        val anchorsAdded: Int,
    )

    fun materialize(snapshot: GraphSnapshot, warnings: List<GraphWarning>?): Result {
        val existing = snapshot.nodes.mapTo(HashSet()) { it.id }
        val scriptsById = HashMap<String, GraphNode>()
        for (n in snapshot.nodes) {
            if (n.kind == NodeKind.SCRIPT) scriptsById[n.id] = n
        }

        val anchors = mutableListOf<GraphNode>()
        val seen = HashSet<String>()
        for (e in snapshot.edges) {
            if (e.kind != EdgeKind.SCRIPT_DECLARES_CLASS) continue
            if (e.target in existing || e.target in seen) continue
            seen.add(e.target)
            val script = scriptsById[e.source]
            val label = if (e.target.startsWith(CSHARP_TYPE_PREFIX)) e.target.substring(CSHARP_TYPE_PREFIX.length) else e.target
            anchors.add(
                GraphNode(
                    id = e.target,
                    kind = NodeKind.CLASS,
                    label = label,
                    path = script?.path,
                    guid = null,
                    location = null,
                    metadata = buildJsonObject {
                        put("anchor", JsonPrimitive(true))
                        put("declaring_script", JsonPrimitive(e.source))
                    },
                )
            )
        }

        if (anchors.isEmpty()) return Result(snapshot, warnings, 0)

        val next = snapshot.copy(
            nodes = snapshot.nodes + anchors,
            stats = GraphStats(
                node_count = snapshot.stats.node_count + anchors.size,
                edge_count = snapshot.stats.edge_count,
                skipped_component_instances = snapshot.stats.skipped_component_instances,
                skipped_component_fields = snapshot.stats.skipped_component_fields,
            ),
        )
        val filteredWarnings = warnings?.filter { it.code != GraphWarningCodes.DANGLING_CSHARP_TARGETS }
        return Result(next, filteredWarnings, anchors.size)
    }
}
