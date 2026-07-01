package com.github.dungphan.unityindex.graph

import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import java.util.concurrent.CopyOnWriteArrayList

// Day 11 Task 8 — process-local registry of live GraphHostBridge instances
// per project. Populated by the bridge constructor; queried by the "Open
// Graph from File…" action so it can hand a parsed ExportDocument to the
// same webview the user is looking at.
//
// One bridge per tool window session in practice. We use a list rather
// than a single slot so an unexpected transient overlap (bridge recreated
// while the old one is still disposing) doesn't drop the new instance.
@Service(Service.Level.PROJECT)
class GraphBridgeRegistry {
    private val bridges = CopyOnWriteArrayList<GraphHostBridge>()

    fun register(bridge: GraphHostBridge) {
        bridges.add(bridge)
    }

    fun unregister(bridge: GraphHostBridge) {
        bridges.remove(bridge)
    }

    /** Most recently registered bridge, or null if the graph tool window
     *  hasn't been opened yet in this session. */
    fun current(): GraphHostBridge? = bridges.lastOrNull()

    companion object {
        fun get(project: Project): GraphBridgeRegistry = project.service()
    }
}
