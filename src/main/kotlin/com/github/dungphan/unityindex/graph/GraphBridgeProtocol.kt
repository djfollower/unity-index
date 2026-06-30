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

    // Mirror of graph/core/src/messages.ts SNAPSHOT_GRAPH_TYPE. Also matches
    // ToolNames.UNITY_GRAPH_SNAPSHOT so the same identifier flows through
    // both the bridge and HTTP paths.
    const val SNAPSHOT = "unity_graph_snapshot"

    // Day 4 click-through actions — mirrors of graph/core/src/messages.ts
    // OPEN_FILE_TYPE / FIND_USAGES_TYPE / REVEAL_IN_EXPLORER_TYPE.
    const val OPEN_FILE = "unity_graph_open_file"
    const val FIND_USAGES = "unity_graph_find_usages"
    const val REVEAL_IN_EXPLORER = "unity_graph_reveal_in_explorer"

    // Day 5 filter state persistence — mirrors of graph/core/src/messages.ts
    // GET_FILTER_STATE_TYPE / SET_FILTER_STATE_TYPE.
    const val GET_FILTER_STATE = "unity_graph_get_filter_state"
    const val SET_FILTER_STATE = "unity_graph_set_filter_state"

    // Day 8.5 — batch C# semantic-edge harvest, invoked when the user expands
    // a class/script anchor in the webview. Mirror of graph/core/src/messages
    // .ts CODE_EDGES_GRAPH_TYPE; also matches ToolNames.UNITY_GRAPH_CODE_EDGES
    // so the same identifier flows through both the bridge and HTTP paths.
    const val CODE_EDGES = "unity_graph_code_edges"

    // Day 10 — batched diagnostics overlay (badges + heatmap + errors-only
    // filter). Mirror of graph/core/src/messages.ts DIAGNOSTICS_GRAPH_TYPE;
    // also matches ToolNames.UNITY_GRAPH_DIAGNOSTICS so the same identifier
    // flows through both the bridge and HTTP paths.
    const val DIAGNOSTICS = "unity_graph_diagnostics"
}
