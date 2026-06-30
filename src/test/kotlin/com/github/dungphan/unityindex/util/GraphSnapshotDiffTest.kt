package com.github.dungphan.unityindex.util

import com.github.dungphan.unityindex.tools.models.EdgeKind
import com.github.dungphan.unityindex.tools.models.GraphEdge
import com.github.dungphan.unityindex.tools.models.GraphEdgeKey
import com.github.dungphan.unityindex.tools.models.GraphNode
import com.github.dungphan.unityindex.tools.models.GraphSnapshot
import com.github.dungphan.unityindex.tools.models.GraphSourcePhase
import com.github.dungphan.unityindex.tools.models.GraphStats
import com.github.dungphan.unityindex.tools.models.NodeKind
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Day 7 — diff correctness tests. Algorithmic mirror of
 * graph/core/src/__tests__/snapshot-diff.test.ts. Any change to the diff
 * semantics must update both files in lockstep (cross-impl rule).
 */
class GraphSnapshotDiffTest {

    private val stats = GraphStats(
        node_count = 0,
        edge_count = 0,
        skipped_component_instances = 0,
        skipped_component_fields = 0,
    )

    private fun snap(
        nodes: List<GraphNode> = emptyList(),
        edges: List<GraphEdge> = emptyList(),
        generatedAt: String = "2026-06-29T00:00:00Z",
    ): GraphSnapshot = GraphSnapshot(
        nodes = nodes,
        edges = edges,
        generated_at = generatedAt,
        source_phase = GraphSourcePhase.ASSET,
        stats = stats,
    )

    private fun node(
        id: String,
        label: String = id,
        kind: NodeKind = NodeKind.SCRIPT,
        metadata: JsonObject = JsonObject(emptyMap()),
        path: String? = null,
    ): GraphNode = GraphNode(
        id = id,
        kind = kind,
        label = label,
        path = path,
        guid = null,
        location = null,
        metadata = metadata,
    )

    private fun edge(
        source: String,
        target: String,
        kind: EdgeKind = EdgeKind.SCRIPT_USED_BY_PREFAB,
        metadata: JsonObject = JsonObject(emptyMap()),
    ): GraphEdge = GraphEdge(
        source = source,
        target = target,
        kind = kind,
        metadata = metadata,
    )

    private val opts = GraphSnapshotDiff.Options(baseRevision = 1, newRevision = 2)

    // ------------------------------------------------------------------------
    // Empty cases
    // ------------------------------------------------------------------------

    @Test
    fun `two identical snapshots produce an empty delta`() {
        val a = snap(nodes = listOf(node("n1")), edges = listOf(edge("n1", "n2")))
        val b = snap(nodes = listOf(node("n1")), edges = listOf(edge("n1", "n2")))
        val d = GraphSnapshotDiff.diff(a, b, opts)
        assertTrue(GraphSnapshotDiff.isEmpty(d))
        assertEquals(1, d.base_revision)
        assertEquals(2, d.new_revision)
    }

    @Test
    fun `empty to empty is empty`() {
        val d = GraphSnapshotDiff.diff(snap(), snap(), opts)
        assertTrue(GraphSnapshotDiff.isEmpty(d))
    }

    // ------------------------------------------------------------------------
    // Node lifecycle
    // ------------------------------------------------------------------------

    @Test
    fun `added nodes show up in nodes_added`() {
        val d = GraphSnapshotDiff.diff(
            prev = snap(nodes = listOf(node("a"))),
            next = snap(nodes = listOf(node("a"), node("b"))),
            opts = opts,
        )
        assertEquals(listOf("b"), d.nodes_added.map { it.id })
        assertTrue(d.nodes_removed.isEmpty())
        assertTrue(d.nodes_updated.isEmpty())
    }

    @Test
    fun `removed nodes show up in nodes_removed`() {
        val d = GraphSnapshotDiff.diff(
            prev = snap(nodes = listOf(node("a"), node("b"))),
            next = snap(nodes = listOf(node("a"))),
            opts = opts,
        )
        assertEquals(listOf("b"), d.nodes_removed)
        assertTrue(d.nodes_added.isEmpty())
    }

    @Test
    fun `updated label is captured as nodes_updated`() {
        val d = GraphSnapshotDiff.diff(
            prev = snap(nodes = listOf(node("a", label = "old"))),
            next = snap(nodes = listOf(node("a", label = "new"))),
            opts = opts,
        )
        assertTrue(d.nodes_added.isEmpty())
        assertTrue(d.nodes_removed.isEmpty())
        assertEquals(listOf("new"), d.nodes_updated.map { it.label })
    }

    @Test
    fun `metadata change is detected via deep equality`() {
        val meta1 = buildJsonObject { put("count", JsonPrimitive(1)) } as JsonObject
        val meta2 = buildJsonObject { put("count", JsonPrimitive(2)) } as JsonObject
        val d = GraphSnapshotDiff.diff(
            prev = snap(nodes = listOf(node("a", metadata = meta1))),
            next = snap(nodes = listOf(node("a", metadata = meta2))),
            opts = opts,
        )
        assertEquals(listOf("a"), d.nodes_updated.map { it.id })
    }

    @Test
    fun `semantically equal metadata with different key order is not a change`() {
        val m1 = buildJsonObject {
            put("x", JsonPrimitive(1))
            put("y", JsonPrimitive(2))
        } as JsonObject
        val m2 = buildJsonObject {
            put("y", JsonPrimitive(2))
            put("x", JsonPrimitive(1))
        } as JsonObject
        val d = GraphSnapshotDiff.diff(
            prev = snap(nodes = listOf(node("a", metadata = m1))),
            next = snap(nodes = listOf(node("a", metadata = m2))),
            opts = opts,
        )
        assertTrue(d.nodes_updated.isEmpty())
    }

    // ------------------------------------------------------------------------
    // Edge lifecycle
    // ------------------------------------------------------------------------

    @Test
    fun `added edges show up in edges_added`() {
        val d = GraphSnapshotDiff.diff(
            prev = snap(nodes = listOf(node("a"), node("b"))),
            next = snap(nodes = listOf(node("a"), node("b")), edges = listOf(edge("a", "b"))),
            opts = opts,
        )
        assertEquals(1, d.edges_added.size)
        assertTrue(d.edges_removed.isEmpty())
    }

    @Test
    fun `removed edges show up in edges_removed as bare keys`() {
        val d = GraphSnapshotDiff.diff(
            prev = snap(nodes = listOf(node("a"), node("b")), edges = listOf(edge("a", "b"))),
            next = snap(nodes = listOf(node("a"), node("b"))),
            opts = opts,
        )
        assertEquals(
            listOf(GraphEdgeKey("a", "b", EdgeKind.SCRIPT_USED_BY_PREFAB)),
            d.edges_removed,
        )
        assertTrue(d.edges_added.isEmpty())
    }

    @Test
    fun `edge metadata change is modeled as remove plus add`() {
        val before = edge(
            "a", "b",
            metadata = (buildJsonObject { put("count", JsonPrimitive(1)) } as JsonObject),
        )
        val after = edge(
            "a", "b",
            metadata = (buildJsonObject { put("count", JsonPrimitive(2)) } as JsonObject),
        )
        val d = GraphSnapshotDiff.diff(
            prev = snap(nodes = listOf(node("a"), node("b")), edges = listOf(before)),
            next = snap(nodes = listOf(node("a"), node("b")), edges = listOf(after)),
            opts = opts,
        )
        assertEquals(1, d.edges_added.size)
        assertEquals(1, d.edges_removed.size)
        assertEquals(EdgeKind.SCRIPT_USED_BY_PREFAB, d.edges_added[0].kind)
        assertEquals("a", d.edges_removed[0].source)
    }

    @Test
    fun `edges differing only by kind are treated as distinct`() {
        val e1 = edge("a", "b", kind = EdgeKind.SCRIPT_USED_BY_PREFAB)
        val e2 = edge("a", "b", kind = EdgeKind.SCRIPT_USED_BY_SCENE)
        val d = GraphSnapshotDiff.diff(
            prev = snap(nodes = listOf(node("a"), node("b")), edges = listOf(e1)),
            next = snap(nodes = listOf(node("a"), node("b")), edges = listOf(e2)),
            opts = opts,
        )
        assertEquals(1, d.edges_removed.size)
        assertEquals(EdgeKind.SCRIPT_USED_BY_PREFAB, d.edges_removed[0].kind)
        assertEquals(1, d.edges_added.size)
        assertEquals(EdgeKind.SCRIPT_USED_BY_SCENE, d.edges_added[0].kind)
    }

    // ------------------------------------------------------------------------
    // Metadata pass-through
    // ------------------------------------------------------------------------

    @Test
    fun `affected_paths is passed through verbatim`() {
        val d = GraphSnapshotDiff.diff(
            prev = snap(),
            next = snap(),
            opts = opts.copy(affectedPaths = listOf("Assets/Foo.prefab", "Assets/Bar.cs")),
        )
        assertEquals(listOf("Assets/Foo.prefab", "Assets/Bar.cs"), d.affected_paths)
    }

    @Test
    fun `generated_at defaults to next snapshot timestamp`() {
        val d = GraphSnapshotDiff.diff(
            prev = snap(generatedAt = "A"),
            next = snap(generatedAt = "B"),
            opts = opts,
        )
        assertEquals("B", d.generated_at)
    }

    @Test
    fun `generated_at override wins`() {
        val d = GraphSnapshotDiff.diff(
            prev = snap(),
            next = snap(),
            opts = opts.copy(generatedAt = "override"),
        )
        assertEquals("override", d.generated_at)
    }

    // ------------------------------------------------------------------------
    // canonicalJson primitives
    // ------------------------------------------------------------------------

    @Test
    fun `canonicalJson sorts object keys`() {
        val a = buildJsonObject {
            put("b", JsonPrimitive(1))
            put("a", JsonPrimitive(2))
        }
        val b = buildJsonObject {
            put("a", JsonPrimitive(2))
            put("b", JsonPrimitive(1))
        }
        assertEquals(
            GraphSnapshotDiff.canonicalJson(a),
            GraphSnapshotDiff.canonicalJson(b),
        )
    }

    @Test
    fun `canonicalJson preserves array order`() {
        val arr = kotlinx.serialization.json.JsonArray(
            listOf(JsonPrimitive(1), JsonPrimitive(2), JsonPrimitive(3))
        )
        val rev = kotlinx.serialization.json.JsonArray(
            listOf(JsonPrimitive(3), JsonPrimitive(2), JsonPrimitive(1))
        )
        assertNotEquals(
            GraphSnapshotDiff.canonicalJson(arr),
            GraphSnapshotDiff.canonicalJson(rev),
        )
    }

    @Test
    fun `edgeKeyString uses U+001F separator and includes kind`() {
        val e = edge("source-id", "target-id", kind = EdgeKind.SERIALIZED_BINDING)
        val s = GraphSnapshotDiff.edgeKeyString(e)
        // Three fields joined by Unit Separator
        assertEquals(2, s.count { it == '\u001F' })
        assertTrue(s.startsWith("source-id"))
        assertTrue(s.endsWith(EdgeKind.SERIALIZED_BINDING.name))
    }
}
