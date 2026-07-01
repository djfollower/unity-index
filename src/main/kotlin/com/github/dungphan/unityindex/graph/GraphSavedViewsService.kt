package com.github.dungphan.unityindex.graph

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

// Day 11 — project-scoped saved-views persistence. Mirrors the VS Code
// graphPanel's workspaceState entry. One @State service per project;
// IntelliJ serialises `Inner` to `.idea/unity-index-graph-saved-views.xml`.
//
// Views are stored as opaque JSON strings so the schema can evolve without
// forcing an IntelliJ serializer bump. The wire shape is `SavedView` from
// graph/core/src/export-wire.ts — the dispatch layer round-trips raw
// JsonObject payloads without validating them here (a corrupt entry drops
// on the JSON re-parse in the handler).
@State(
    name = "UnityIndexGraphSavedViews",
    storages = [Storage("unity-index-graph-saved-views.xml")],
)
@Service(Service.Level.PROJECT)
class GraphSavedViewsService : PersistentStateComponent<GraphSavedViewsService.Inner> {

    data class Inner(
        // Each entry is a serialised `SavedView` JSON object. We keep the
        // JSON as a String rather than a nested @Serializable POJO so we can
        // round-trip webview-only fields (like `positions`) that would need
        // separate Kotlin serializers otherwise.
        var views: MutableList<String> = mutableListOf(),
    )

    private var inner = Inner()

    override fun getState(): Inner = inner
    override fun loadState(state: Inner) {
        inner = state
    }

    /** Snapshot of the list as parsed `JsonObject`s. Malformed entries are
     *  silently dropped so a hand-edited XML file can't wedge the panel. */
    fun list(): List<JsonObject> {
        val out = ArrayList<JsonObject>(inner.views.size)
        for (raw in inner.views) {
            try {
                val el = json.parseToJsonElement(raw)
                if (el is JsonObject) out.add(el)
            } catch (_: Throwable) {
                // Skip corrupt entry — Day 11 doesn't need error UI here.
            }
        }
        return out
    }

    /** Upserts by the `name` field. Callers ensure `view` is a JsonObject
     *  with a string `name`. Newest write ends up at index 0 so the
     *  dropdown shows most-recently-saved first. */
    fun upsert(view: JsonObject) {
        val name = view["name"]?.let { it as? kotlinx.serialization.json.JsonPrimitive }?.content
            ?: throw IllegalArgumentException("invalid_saved_view")
        val kept = ArrayList<String>(inner.views.size)
        for (raw in inner.views) {
            val existingName = try {
                (json.parseToJsonElement(raw) as? JsonObject)?.let { obj ->
                    (obj["name"] as? kotlinx.serialization.json.JsonPrimitive)?.content
                }
            } catch (_: Throwable) { null }
            if (existingName != null && existingName != name) kept.add(raw)
        }
        inner = Inner(views = (mutableListOf(json.encodeToString(JsonElement.serializer(), view)) + kept).toMutableList())
    }

    /** Returns true if the entry existed and was removed. */
    fun delete(name: String): Boolean {
        val before = inner.views.size
        val filtered = inner.views.filter { raw ->
            val existingName = try {
                (json.parseToJsonElement(raw) as? JsonObject)?.let { obj ->
                    (obj["name"] as? kotlinx.serialization.json.JsonPrimitive)?.content
                }
            } catch (_: Throwable) { null }
            existingName != name
        }
        if (filtered.size == before) return false
        inner = Inner(views = filtered.toMutableList())
        return true
    }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }
        fun get(project: Project): GraphSavedViewsService = project.service()
    }
}
