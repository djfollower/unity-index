package com.github.dungphan.unityindex.util

import com.github.dungphan.unityindex.settings.McpSettings

object ResponseFormatter {

    fun formatStructuredPayload(jsonText: String, format: McpSettings.ResponseFormat): String {
        return when (format) {
            McpSettings.ResponseFormat.JSON -> jsonText
        }
    }
}
