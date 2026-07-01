package com.github.dungphan.unityindex.graph

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindowManager
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

// Day 11 Task 8 — "Unity Index: Open Graph from File…" action for Rider.
// Prompts for a JSON export produced by `unity_graph_export` or the
// webview's JSON export button, validates the schema version, opens the
// Unity Index Graph tool window, and posts a `snapshot/load-static`
// event to the webview for offline browsing.
class OpenGraphFromFileAction : AnAction() {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT) ?: return
        val descriptor = FileChooserDescriptorFactory.createSingleFileDescriptor("json")
            .withTitle("Open Unity Index Graph JSON")
            .withDescription("Choose a v${SCHEMA_MAJOR} ExportDocument produced by 'unity_graph_export' or the webview export button.")
        val chosen = FileChooser.chooseFile(descriptor, project, null) ?: return
        val text = try {
            String(chosen.contentsToByteArray(), Charsets.UTF_8)
        } catch (t: Throwable) {
            Messages.showErrorDialog(project, "Could not read file: ${t.message}", DIALOG_TITLE)
            return
        }
        val doc = try {
            validate(text)
        } catch (t: Throwable) {
            Messages.showErrorDialog(project, t.message ?: "invalid export", DIALOG_TITLE)
            return
        }
        // Bring the graph tool window forward so the user sees the load
        // land — matches the VS Code side, where openGraphFromFile also
        // reveals the panel.
        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow("Unity Index Graph")
        toolWindow?.activate(null, true)
        val bridge = GraphBridgeRegistry.get(project).current()
        if (bridge == null) {
            // Retry after the tool window has had a chance to create its
            // browser + bridge. Same principle as the VS Code side's 400ms
            // retry — cheaper than adding a callback.
            javax.swing.Timer(600) {
                val late = GraphBridgeRegistry.get(project).current()
                if (late != null) postLoadStatic(late, doc) else {
                    Messages.showErrorDialog(project, "The graph tool window is not ready. Try opening it first, then run the command again.", DIALOG_TITLE)
                }
            }.apply { isRepeats = false }.start()
            return
        }
        postLoadStatic(bridge, doc)
    }

    private fun postLoadStatic(bridge: GraphHostBridge, doc: JsonObject) {
        val payload = buildJsonObject { put("document", doc) }
        bridge.postEvent(SNAPSHOT_LOAD_STATIC_TYPE, payload)
    }

    private fun validate(rawText: String): JsonObject {
        val parsed = try {
            json.parseToJsonElement(rawText)
        } catch (t: Throwable) {
            throw IllegalArgumentException("Not a valid JSON file: ${t.message}")
        }
        val obj = parsed as? JsonObject
            ?: throw IllegalArgumentException("export document must be a JSON object")
        val version = (obj["schemaVersion"] as? JsonPrimitive)?.content
            ?: throw IllegalArgumentException("export document is missing 'schemaVersion'")
        val match = Regex("^(\\d+)\\.(\\d+)$").matchEntire(version)
            ?: throw IllegalArgumentException("schemaVersion '$version' is not '<major>.<minor>'")
        val major = match.groupValues[1].toInt()
        if (major != SCHEMA_MAJOR) {
            throw IllegalArgumentException(
                "export schema major v$major is not supported by this build (expected v$SCHEMA_MAJOR)",
            )
        }
        obj["snapshot"] as? JsonObject
            ?: throw IllegalArgumentException("export document is missing 'snapshot'")
        return obj
    }

    companion object {
        /** Mirrors EXPORT_SCHEMA_MAJOR in graph/core/src/export-wire.ts. */
        private const val SCHEMA_MAJOR = 1
        /** Mirrors SNAPSHOT_LOAD_STATIC_TYPE in graph/core/src/messages.ts. */
        private const val SNAPSHOT_LOAD_STATIC_TYPE = "unity_graph_snapshot_load_static"
        private const val DIALOG_TITLE = "Open Unity Index Graph"
        private val json = Json { ignoreUnknownKeys = true }
    }
}
