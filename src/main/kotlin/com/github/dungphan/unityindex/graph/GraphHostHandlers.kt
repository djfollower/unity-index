package com.github.dungphan.unityindex.graph

import com.intellij.openapi.project.Project
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

// Dispatch table for bridge requests coming from the graph webview. Day 1
// only implements the hello round-trip — proves the bridge end-to-end before
// real data flows in Day 2.
object GraphHostHandlers {
    fun dispatch(type: String, payload: JsonElement?, project: Project?): JsonElement {
        @Suppress("UNUSED_VARIABLE")
        val ignoredProject = project // unused on Day 1 — kept so Day 2 callers don't have to change shape
        return when (type) {
            GraphWireTypes.HELLO -> handleHello(payload)
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
}
