package com.github.dungphan.unityindex.graph

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// Wire envelope matching graph/core/src/host-bridge.ts. Single flat shape
// rather than a sealed class so kotlinx.serialization can round-trip with
// the loose-typed TS side without needing a polymorphic discriminator setup.
// `kind` is the union discriminator ("request" | "response" | "event").
@Serializable
data class BridgeEnvelope(
    val kind: String,
    val id: String? = null,
    val type: String,
    val payload: JsonElement? = null,
    val error: BridgeError? = null,
)

@Serializable
data class BridgeError(val message: String)

object GraphWireTypes {
    // Mirror of graph/core/src/messages.ts HELLO_GRAPH_TYPE. Drift surfaces
    // at runtime as a webview timeout.
    const val HELLO = "unity_graph_hello"
}
