package com.github.dungphan.unityindex.util

import com.github.dungphan.unityindex.tools.models.EdgeKind
import com.github.dungphan.unityindex.tools.models.GraphEdge
import com.github.dungphan.unityindex.tools.models.GraphNode
import com.github.dungphan.unityindex.tools.models.GraphSnapshot
import com.github.dungphan.unityindex.tools.models.GraphSourcePhase
import com.github.dungphan.unityindex.tools.models.GraphStats
import com.github.dungphan.unityindex.tools.models.GraphWarning
import com.github.dungphan.unityindex.tools.models.NodeKind
import kotlinx.serialization.json.buildJsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Day 8.6 — parity tests for [GraphClassAnchors]. The Kotlin and TS
 * implementations of `materializeClassAnchors` must produce identical
 * output for identical input; this file mirrors
 * graph/core/src/__tests__/class-anchors.test.ts case-for-case. Any
 * semantic change must update both.
 */
class GraphClassAnchorsTest {

    private val stats = GraphStats(0, 0, 0, 0)

    private val scriptNode = GraphNode(
        id = "unity://script/Assets/Player.cs",
        kind = NodeKind.SCRIPT,
        label = "Player.cs",
        path = "Assets/Player.cs",
        guid = null,
        location = null,
        metadata = buildJsonObject {},
    )

    private val declaresEdge = GraphEdge(
        source = scriptNode.id,
        target = "unity://csharp/T:Foo.Player",
        kind = EdgeKind.SCRIPT_DECLARES_CLASS,
        metadata = buildJsonObject {},
    )

    private fun snap(nodes: List<GraphNode>, edges: List<GraphEdge>): GraphSnapshot =
        GraphSnapshot(
            nodes = nodes,
            edges = edges,
            generated_at = "2026-06-30T00:00:00Z",
            source_phase = GraphSourcePhase.ASSET,
            stats = stats.copy(node_count = nodes.size, edge_count = edges.size),
        )

    @Test
    fun `returns the same snapshot when there are no script_declares_class edges`() {
        val s = snap(listOf(scriptNode), emptyList())
        val result = GraphClassAnchors.materialize(s, warnings = null)
        assertEquals(0, result.anchorsAdded)
        assertSame(s, result.snapshot)
    }

    @Test
    fun `materializes one anchor per dangling csharp target`() {
        val s = snap(listOf(scriptNode), listOf(declaresEdge))
        val result = GraphClassAnchors.materialize(s, warnings = null)
        assertEquals(1, result.anchorsAdded)
        assertEquals(2, result.snapshot.nodes.size)
        val anchor = result.snapshot.nodes.first { it.id == declaresEdge.target }
        assertEquals(NodeKind.CLASS, anchor.kind)
        assertEquals("Foo.Player", anchor.label)
        assertEquals("Assets/Player.cs", anchor.path)
        assertEquals("true", anchor.metadata["anchor"].toString())
        assertEquals("\"${scriptNode.id}\"", anchor.metadata["declaring_script"].toString())
        assertEquals(2, result.snapshot.stats.node_count)
    }

    @Test
    fun `does not duplicate when the target already has a node`() {
        val real = GraphNode(
            id = declaresEdge.target,
            kind = NodeKind.CLASS,
            label = "Player",
            path = null,
            guid = null,
            location = null,
            metadata = buildJsonObject {},
        )
        val s = snap(listOf(scriptNode, real), listOf(declaresEdge))
        val result = GraphClassAnchors.materialize(s, warnings = null)
        assertEquals(0, result.anchorsAdded)
        assertSame(s, result.snapshot)
    }

    @Test
    fun `strips dangling_csharp_targets warning, leaves others alone`() {
        val dangling = GraphWarning(
            code = GraphWarningCodes.DANGLING_CSHARP_TARGETS,
            message = "old text",
            context = null,
        )
        val other = GraphWarning(
            code = GraphWarningCodes.UNRESOLVED_TARGETS,
            message = "unrelated",
            context = null,
        )
        val s = snap(listOf(scriptNode), listOf(declaresEdge))
        val result = GraphClassAnchors.materialize(s, warnings = listOf(dangling, other))
        assertEquals(listOf(other), result.warnings)
    }

    @Test
    fun `does not mutate the input snapshot`() {
        val nodes = listOf(scriptNode)
        val edges = listOf(declaresEdge)
        val s = snap(nodes, edges)
        GraphClassAnchors.materialize(s, warnings = null)
        // Data classes are immutable, but we also want to confirm we didn't
        // hand back a list that aliases the same backing collection.
        assertEquals(1, s.nodes.size)
        assertEquals(1, s.edges.size)
    }

    @Test
    fun `null warnings stay null when nothing changed`() {
        val s = snap(listOf(scriptNode), emptyList())
        val result = GraphClassAnchors.materialize(s, warnings = null)
        assertNull(result.warnings)
        assertTrue(result.anchorsAdded == 0)
    }
}
