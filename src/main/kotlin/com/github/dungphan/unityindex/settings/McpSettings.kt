package com.github.dungphan.unityindex.settings

import com.github.dungphan.unityindex.McpConstants
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service

@Service(Service.Level.APP)
@State(
    name = "UnityIndexMcpSettings",
    storages = [Storage("unity-index-mcp.xml")]
)
class McpSettings : PersistentStateComponent<McpSettings.State> {

    enum class AvailableProjectsMode {
        EXPANDED,
        COMPACT
    }

    enum class ResponseFormat {
        JSON
    }

    data class State(
        var syncExternalChanges: Boolean = false,
        var availableProjectsMode: AvailableProjectsMode = AvailableProjectsMode.EXPANDED,
        var responseFormat: ResponseFormat = ResponseFormat.JSON,
        var disabledTools: MutableSet<String> = mutableSetOf(),
        var serverPort: Int = -1,
        var serverHost: String = McpConstants.DEFAULT_SERVER_HOST,
        var unixSocketEnabled: Boolean = false,
        var unixSocketPath: String = McpConstants.DEFAULT_UNIX_SOCKET_PATH,
    )

    private var state = State()

    override fun getState(): State = state

    override fun loadState(state: State) {
        this.state = state
    }

    var syncExternalChanges: Boolean
        get() = state.syncExternalChanges
        set(value) { state.syncExternalChanges = value }

    var availableProjectsMode: AvailableProjectsMode
        get() = state.availableProjectsMode
        set(value) { state.availableProjectsMode = value }

    var responseFormat: ResponseFormat
        get() = state.responseFormat
        set(value) { state.responseFormat = value }

    var disabledTools: Set<String>
        get() = state.disabledTools.toSet()
        set(value) { state.disabledTools = value.toMutableSet() }

    var serverPort: Int
        get() = if (state.serverPort == -1) McpConstants.getDefaultServerPort() else state.serverPort
        set(value) { state.serverPort = value }

    var serverHost: String
        get() = state.serverHost
        set(value) { state.serverHost = value }

    var unixSocketEnabled: Boolean
        get() = state.unixSocketEnabled
        set(value) { state.unixSocketEnabled = value }

    var unixSocketPath: String
        get() = state.unixSocketPath
        set(value) { state.unixSocketPath = value }

    fun isToolEnabled(toolName: String): Boolean = toolName !in state.disabledTools

    fun setToolEnabled(toolName: String, enabled: Boolean) {
        if (enabled) {
            state.disabledTools.remove(toolName)
        } else {
            state.disabledTools.add(toolName)
        }
    }

    companion object {
        fun getInstance(): McpSettings = service()
    }
}
