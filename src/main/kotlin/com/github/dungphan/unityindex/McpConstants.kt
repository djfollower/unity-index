package com.github.dungphan.unityindex

import com.github.dungphan.unityindex.util.IdeProductInfo

object McpConstants {
    const val PLUGIN_NAME = "Unity Index MCP Server"
    const val TOOL_WINDOW_ID = PLUGIN_NAME
    const val NOTIFICATION_GROUP_ID = PLUGIN_NAME
    const val SETTINGS_DISPLAY_NAME = PLUGIN_NAME

    const val DEFAULT_SERVER_HOST = "127.0.0.1"

    @JvmStatic
    fun getDefaultServerPort(): Int = IdeProductInfo.getDefaultPort()

    const val DEFAULT_SERVER_PORT = 29170

    const val MCP_ENDPOINT_PATH = "/unity-index-mcp"
    const val SSE_ENDPOINT_PATH = "$MCP_ENDPOINT_PATH/sse"
    const val STREAMABLE_HTTP_ENDPOINT_PATH = "$MCP_ENDPOINT_PATH/streamable-http"
    const val SESSION_ID_PARAM = "sessionId"

    const val JSON_RPC_VERSION = "2.0"

    const val LEGACY_MCP_PROTOCOL_VERSION = "2024-11-05"
    const val STREAMABLE_HTTP_MCP_PROTOCOL_VERSION = "2025-03-26"
    const val MCP_PROTOCOL_VERSION = STREAMABLE_HTTP_MCP_PROTOCOL_VERSION

    @JvmStatic
    fun getServerName(): String = IdeProductInfo.getServerName()

    const val SERVER_NAME = "unity-index-mcp"
    const val SERVER_VERSION = "0.1.0"
    const val SERVER_DESCRIPTION = "Code intelligence server for Unity C# projects in JetBrains Rider. Use this instead of grep/ripgrep for semantic code understanding. Capabilities: find usages, go to definition, type/call hierarchies, find implementations, symbol search, diagnostics."
}
