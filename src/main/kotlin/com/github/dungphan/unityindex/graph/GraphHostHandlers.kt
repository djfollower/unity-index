package com.github.dungphan.unityindex.graph

import com.github.dungphan.unityindex.tools.models.GraphSnapshotRequest
import com.github.dungphan.unityindex.util.UnityAssetGraphBuilder
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.project.Project
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

// Dispatch table for bridge requests coming from the graph webview. Day 1
// implements the hello round-trip; Day 3 adds `unity_graph_snapshot`, calling
// the same in-process builder the MCP tool path uses (no HTTP hop).
object GraphHostHandlers {

    private val json = Json { ignoreUnknownKeys = true }

    fun dispatch(type: String, payload: JsonElement?, project: Project?): JsonElement {
        return when (type) {
            GraphWireTypes.HELLO -> handleHello(payload)
            GraphWireTypes.SNAPSHOT -> handleSnapshot(payload, project)
            else -> throw IllegalArgumentException("unity_graph: unknown request type '$type'")
        }
    }

    private fun handleHello(payload: JsonElement?): JsonElement {
        val name = (payload as? JsonObject)
            ?.get("name")
            ?.jsonPrimitive
            ?.contentOrNull
            ?: "webview"
        return buildJsonObject {
            put("greeting", JsonPrimitive("hello, $name"))
            put("host", JsonPrimitive("rider"))
        }
    }

    private fun handleSnapshot(payload: JsonElement?, project: Project?): JsonElement {
        // The bridge is bound to exactly one Project per tool window; if it's
        // null the panel was opened outside a project context (shouldn't happen
        // in practice). Stable error string so the webview can surface it.
        project ?: throw IllegalStateException("no_project_open")

        val request = try {
            if (payload != null && payload is JsonObject) {
                json.decodeFromJsonElement(GraphSnapshotRequest.serializer(), payload)
            } else {
                GraphSnapshotRequest()
            }
        } catch (e: Exception) {
            throw IllegalArgumentException("invalid_snapshot_request: ${e.message}")
        }

        // UnityAssetGraphBuilder.build walks VFS and needs a read action.
        // We're already on a pooled thread (per GraphHostBridge), but VFS
        // access requires a read lock — ReadAction.compute is the
        // non-suspending equivalent of the tool path's suspendingReadAction.
        val response = ReadAction.compute<_, RuntimeException> {
            UnityAssetGraphBuilder.build(project, request)
        }

        return json.encodeToJsonElement(GraphSnapshotResponseSerializer, response)
    }

    // Tiny alias so the call site reads cleanly.
    private val GraphSnapshotResponseSerializer =
        com.github.dungphan.unityindex.tools.models.GraphSnapshotResponse.serializer()
}
