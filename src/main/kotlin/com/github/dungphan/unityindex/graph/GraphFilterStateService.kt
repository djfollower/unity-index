package com.github.dungphan.unityindex.graph

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project

// Day 5 — project-scoped filter state persistence. Mirrors the VS Code
// graphPanel's workspaceState. One @State service per project; IntelliJ
// serialises the `Inner` POJO to `.idea/unity-index-graph-filter.xml` on
// project close and restores on open.
//
// Field shapes must stay in lockstep with graph/core/src/messages.ts
// FilterState. We store `hiddenKinds` as ArrayList<String> (IntelliJ's XML
// serializer doesn't like Set<String>); the dispatch layer normalises it
// back to the wire shape.
@State(
    name = "UnityIndexGraphFilterState",
    storages = [Storage("unity-index-graph-filter.xml")],
)
@Service(Service.Level.PROJECT)
class GraphFilterStateService : PersistentStateComponent<GraphFilterStateService.Inner> {
    data class Inner(
        var hiddenKinds: MutableList<String> = mutableListOf(),
        var search: String = "",
        // Day 9 — domain toggle (assets|code|combined). Stored as a free-form
        // string so an older webview that doesn't know about the field still
        // round-trips it; the dispatch layer + webview both coerce unknown
        // values to "combined".
        var domain: String = "combined",
    )

    private var inner = Inner()

    override fun getState(): Inner = inner

    override fun loadState(state: Inner) {
        inner = state
    }

    fun read(): Inner = Inner(
        hiddenKinds = inner.hiddenKinds.toMutableList(),
        search = inner.search,
        domain = inner.domain,
    )

    fun write(hiddenKinds: List<String>, search: String, domain: String) {
        inner = Inner(
            hiddenKinds = hiddenKinds.toMutableList(),
            search = search,
            domain = domain,
        )
    }

    companion object {
        fun get(project: Project): GraphFilterStateService = project.service()
    }
}
