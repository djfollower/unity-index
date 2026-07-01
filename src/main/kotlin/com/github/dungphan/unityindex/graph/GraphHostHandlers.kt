package com.github.dungphan.unityindex.graph

import com.github.dungphan.unityindex.tools.models.CodeEdgesRequest
import com.github.dungphan.unityindex.tools.models.CodeEdgesResponse
import com.github.dungphan.unityindex.tools.models.DiagnosticsBatchRequest
import com.github.dungphan.unityindex.tools.models.DiagnosticsBatchResponse
import com.github.dungphan.unityindex.tools.models.GraphSnapshotRequest
import com.github.dungphan.unityindex.tools.unity.UnityGraphCodeEdgesTool
import com.github.dungphan.unityindex.tools.unity.UnityGraphDiagnosticsTool
import com.github.dungphan.unityindex.util.GraphBuildProgress
import com.github.dungphan.unityindex.util.GraphClassAnchors
import com.intellij.ide.actions.RevealFileAction
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.PlatformDataKeys
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.nio.file.Paths

// Dispatch table for bridge requests coming from the graph webview. Day 1
// implements the hello round-trip; Day 3 adds `unity_graph_snapshot`, calling
// the same in-process builder the MCP tool path uses (no HTTP hop).
object GraphHostHandlers {

    private val json = Json { ignoreUnknownKeys = true }

    fun dispatch(
        type: String,
        payload: JsonElement?,
        project: Project?,
        progress: GraphHostBridge.ProgressEmitter? = null,
    ): JsonElement {
        return when (type) {
            GraphWireTypes.HELLO -> handleHello(payload)
            GraphWireTypes.SNAPSHOT -> handleSnapshot(payload, project, progress)
            GraphWireTypes.OPEN_FILE -> handleOpenFile(payload, project)
            GraphWireTypes.FIND_USAGES -> handleFindUsages(payload, project)
            GraphWireTypes.REVEAL_IN_EXPLORER -> handleRevealInExplorer(payload, project)
            GraphWireTypes.GET_FILTER_STATE -> handleGetFilterState(project)
            GraphWireTypes.SET_FILTER_STATE -> handleSetFilterState(payload, project)
            GraphWireTypes.CODE_EDGES -> handleCodeEdges(payload, project)
            GraphWireTypes.DIAGNOSTICS -> handleDiagnostics(payload, project)
            GraphWireTypes.SAVED_VIEWS_LIST -> handleListSavedViews(project)
            GraphWireTypes.SAVED_VIEWS_SAVE -> handleSaveSavedView(payload, project)
            GraphWireTypes.SAVED_VIEWS_DELETE -> handleDeleteSavedView(payload, project)
            GraphWireTypes.SAVE_FILE -> handleSaveFile(payload, project)
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

    /** Day 8.5 — lazy code-edge expansion from the webview. Routes through
     *  the same in-process harvester the MCP tool uses (no HTTP hop) and
     *  bypasses the response formatter so the webview always gets raw JSON
     *  regardless of the user's `mcp.responseFormat` setting. */
    private fun handleCodeEdges(payload: JsonElement?, project: Project?): JsonElement {
        project ?: throw IllegalStateException("no_project_open")
        val request = decodeOrThrow(
            payload,
            CodeEdgesRequest.serializer(),
            "invalid_code_edges_request",
        )
        val response = UnityGraphCodeEdgesTool.runDirect(project, request)
        return json.encodeToJsonElement(CodeEdgesResponse.serializer(), response)
    }

    /** Day 10 — diagnostics overlay refresh from the webview. Routes
     *  through the same in-process harvester the MCP tool uses (no HTTP
     *  hop) so badges / heatmap / errors-only filter share the same
     *  source. */
    private fun handleDiagnostics(payload: JsonElement?, project: Project?): JsonElement {
        project ?: throw IllegalStateException("no_project_open")
        val request = decodeOrThrow(
            payload,
            DiagnosticsBatchRequest.serializer(),
            "invalid_diagnostics_request",
        )
        val response = UnityGraphDiagnosticsTool.runDirect(project, request)
        return json.encodeToJsonElement(DiagnosticsBatchResponse.serializer(), response)
    }

    private fun handleSnapshot(
        payload: JsonElement?,
        project: Project?,
        progress: GraphHostBridge.ProgressEmitter?,
    ): JsonElement {
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

        // 0.5.10 — route through GraphSnapshotCache so the panel reuses the
        // same cached revision the MCP tool path builds (was: direct
        // UnityAssetGraphBuilder.build under ReadAction.compute — every panel
        // open on a very big project paid the full walk again, and the read
        // lock could starve write-intent actions on the EDT for minutes).
        // The cache internally serialises the build on a plain lock; VFS
        // walks + raw YAML parsing don't need a platform read action.
        //
        // Per-file progress: the builder invokes the reporter on every asset
        // file it inspects. The emitter throttles at 250ms so a 50k-file scan
        // sends ~1 msg/s across the wire while the UI still feels live. The
        // heartbeat covers the aggregation phase between the walk finishing
        // and the response being encoded — no per-file ticks there, but the
        // 60s inter-message timeout on the webview side still needs to see
        // traffic. Emitter is a no-op if progress is null (tests / direct
        // dispatch calls without a bridge).
        val response = if (progress != null) {
            val reporter = GraphBuildProgress { phase, current, total, message ->
                progress.report(phase, current, total, message)
            }
            progress.withHeartbeat(
                intervalMs = 15_000L,
                phase = "snapshot",
                initialMessage = "scanning Unity assets",
            ) {
                GraphSnapshotCache.get(project).snapshot(request, reporter)
            }
        } else {
            GraphSnapshotCache.get(project).snapshot(request)
        }

        // Day 8.4 — opt-in class-anchor projection. The MCP tool path applies
        // this in UnityGraphSnapshotTool.applyClassAnchors; the bridge bypasses
        // the tool, so we mirror the projection here. Without it the webview's
        // `script_declares_class` targets stay dangling and `anchorIdFor` can't
        // resolve a code anchor → the "Expand code edges" menu action is
        // silently filtered out for every node.
        val withAnchors = if (request.include_class_anchors == true) {
            val result = GraphClassAnchors.materialize(response.snapshot, response.warnings)
            if (result.anchorsAdded > 0) {
                response.copy(snapshot = result.snapshot, warnings = result.warnings)
            } else response
        } else response

        return json.encodeToJsonElement(GraphSnapshotResponseSerializer, withAnchors)
    }

    // Tiny alias so the call site reads cleanly.
    private val GraphSnapshotResponseSerializer =
        com.github.dungphan.unityindex.tools.models.GraphSnapshotResponse.serializer()

    // -----------------------------------------------------------------------
    // Day 4 — click-through actions
    // -----------------------------------------------------------------------
    //
    // All three handlers share path-resolution + EDT-dispatch plumbing. Stable
    // error strings (mirrored in vscode-extension/src/graphHost/hostHandlers.ts)
    // — the webview translates them into user-friendly copy.

    @Serializable
    private data class OpenFileWire(
        val path: String? = null,
        val line: Int? = null,
        val column: Int? = null,
    )

    @Serializable
    private data class FindUsagesWire(
        val node_id: String? = null,
        val path: String? = null,
        val line: Int? = null,
        val column: Int? = null,
    )

    @Serializable
    private data class RevealWire(val path: String? = null)

    private fun handleOpenFile(payload: JsonElement?, project: Project?): JsonElement {
        project ?: throw IllegalStateException("no_project_open")
        val req = decodeOrThrow(payload, OpenFileWire.serializer(), "invalid_open_file_request")
        val file = resolveOpenable(project, req.path)
        openOnEdt(project, file, req.line, req.column)
            ?: throw IllegalStateException("file_not_found")
        return buildJsonObject { put("opened", JsonPrimitive(true)) }
    }

    private fun handleFindUsages(payload: JsonElement?, project: Project?): JsonElement {
        project ?: throw IllegalStateException("no_project_open")
        val req = decodeOrThrow(payload, FindUsagesWire.serializer(), "invalid_find_usages_request")
        val file = resolveOpenable(project, req.path)
        val editor = openOnEdt(project, file, req.line, req.column)
            ?: throw IllegalStateException("file_not_found")
        // Invoke Rider's native Find Usages against the caret position we just
        // placed. Same pattern as RiderProtocolHost.executeAction — runs on
        // EDT, fire-and-forget; the user sees the usages tool window pop open.
        invokeActionOnEdt(project, editor, "FindUsages")
        return buildJsonObject { put("invoked", JsonPrimitive(true)) }
    }

    private fun handleRevealInExplorer(payload: JsonElement?, project: Project?): JsonElement {
        project ?: throw IllegalStateException("no_project_open")
        val req = decodeOrThrow(payload, RevealWire.serializer(), "invalid_reveal_request")
        val file = resolveOpenable(project, req.path)
        // RevealFileAction.openFile picks the right system file manager on
        // each platform (Finder / Explorer / Files). The IDE-flavoured
        // "Select in Project View" alternative wouldn't match the menu wording.
        ApplicationManager.getApplication().invokeAndWait {
            RevealFileAction.openFile(File(file.path))
        }
        return buildJsonObject { put("revealed", JsonPrimitive(true)) }
    }

    // -----------------------------------------------------------------------
    // Day 5 — filter state persistence
    // -----------------------------------------------------------------------
    //
    // Project-scoped service holds the durable copy; the webview owns the live
    // UI state. Get is sync (read from service), Set serialises into the
    // service which IntelliJ will then persist at project close.

    @Serializable
    private data class FilterStateWire(
        val hiddenKinds: List<String> = emptyList(),
        val search: String = "",
        // Day 9 — assets|code|combined. Unknown values fall back to
        // "combined" so a webview sending a future value can't wedge state.
        val domain: String = "combined",
    )

    private fun coerceDomain(raw: String): String = when (raw) {
        "assets", "code", "combined" -> raw
        else -> "combined"
    }

    @Serializable
    private data class SetFilterStateWire(val state: FilterStateWire = FilterStateWire())

    private fun handleGetFilterState(project: Project?): JsonElement {
        project ?: throw IllegalStateException("no_project_open")
        val current = GraphFilterStateService.get(project).read()
        val state = buildJsonObject {
            put(
                "hiddenKinds",
                kotlinx.serialization.json.JsonArray(current.hiddenKinds.map { JsonPrimitive(it) }),
            )
            put("search", JsonPrimitive(current.search))
            put("domain", JsonPrimitive(coerceDomain(current.domain)))
        }
        return buildJsonObject { put("state", state) }
    }

    private fun handleSetFilterState(payload: JsonElement?, project: Project?): JsonElement {
        project ?: throw IllegalStateException("no_project_open")
        val req = try {
            if (payload != null && payload is JsonObject) {
                json.decodeFromJsonElement(SetFilterStateWire.serializer(), payload)
            } else {
                SetFilterStateWire()
            }
        } catch (e: Exception) {
            throw IllegalArgumentException("invalid_filter_state: ${e.message}")
        }
        GraphFilterStateService.get(project).write(
            req.state.hiddenKinds,
            req.state.search,
            coerceDomain(req.state.domain),
        )
        return buildJsonObject { put("saved", JsonPrimitive(true)) }
    }

    // -----------------------------------------------------------------------
    // Day 11 — saved views
    // -----------------------------------------------------------------------
    //
    // Payloads are pass-through JSON: the webview owns the `SavedView` shape
    // (see graph/core/src/export-wire.ts), and this handler just guards on
    // `name` being present + non-empty. Storage keeps entries as raw JSON
    // strings so future field additions don't require a Kotlin serializer
    // bump.

    private fun handleListSavedViews(project: Project?): JsonElement {
        project ?: throw IllegalStateException("no_project_open")
        val views = GraphSavedViewsService.get(project).list()
        return buildJsonObject {
            put("views", kotlinx.serialization.json.JsonArray(views))
        }
    }

    private fun handleSaveSavedView(payload: JsonElement?, project: Project?): JsonElement {
        project ?: throw IllegalStateException("no_project_open")
        val obj = payload as? JsonObject
            ?: throw IllegalArgumentException("invalid_saved_view")
        val view = obj["view"] as? JsonObject
            ?: throw IllegalArgumentException("invalid_saved_view")
        val name = (view["name"] as? JsonPrimitive)?.contentOrNull
        if (name.isNullOrEmpty()) throw IllegalArgumentException("invalid_saved_view")
        GraphSavedViewsService.get(project).upsert(view)
        return buildJsonObject { put("saved", JsonPrimitive(true)) }
    }

    private fun handleDeleteSavedView(payload: JsonElement?, project: Project?): JsonElement {
        project ?: throw IllegalStateException("no_project_open")
        val name = (payload as? JsonObject)
            ?.get("name")
            ?.let { it as? JsonPrimitive }
            ?.contentOrNull
        if (name.isNullOrEmpty()) {
            return buildJsonObject { put("deleted", JsonPrimitive(false)) }
        }
        val removed = GraphSavedViewsService.get(project).delete(name)
        return buildJsonObject { put("deleted", JsonPrimitive(removed)) }
    }

    // -----------------------------------------------------------------------
    // Day 11 — save-file (PNG / SVG / JSON exports)
    // -----------------------------------------------------------------------
    //
    // Runs Rider's native save dialog, decodes base64 to bytes, writes with
    // NIO. All heavy lifting stays off the EDT — only the dialog is invoked
    // on the UI thread. `saved: false` on user cancel is not an error.

    @Serializable
    private data class SaveFileWire(
        val defaultName: String? = null,
        val kind: String? = null,
        val contentBase64: String? = null,
    )

    private fun handleSaveFile(payload: JsonElement?, project: Project?): JsonElement {
        project ?: throw IllegalStateException("no_project_open")
        val req = decodeOrThrow(payload, SaveFileWire.serializer(), "invalid_save_request")
        val defaultName = req.defaultName?.takeIf { it.isNotEmpty() }
            ?: throw IllegalArgumentException("invalid_save_request")
        val kind = req.kind?.takeIf { it == "png" || it == "svg" || it == "json" }
            ?: throw IllegalArgumentException("invalid_save_request")
        val contentBase64 = req.contentBase64
            ?: throw IllegalArgumentException("invalid_save_request")

        val descriptor = com.intellij.openapi.fileChooser.FileSaverDescriptor(
            "Export Graph",
            "Choose a location to save the exported ${kind.uppercase()} file",
            kind,
        )
        val holder = arrayOfNulls<java.io.File>(1)
        ApplicationManager.getApplication().invokeAndWait {
            val factory = com.intellij.openapi.fileChooser.FileChooserFactory.getInstance()
            val dialog = factory.createSaveFileDialog(descriptor, project)
            val baseDir = project.basePath?.let { LocalFileSystem.getInstance().findFileByPath(it) }
            val chosen = dialog.save(baseDir, defaultName) ?: return@invokeAndWait
            holder[0] = chosen.file
        }
        val target = holder[0]
            ?: return buildJsonObject { put("saved", JsonPrimitive(false)) }

        val bytes = java.util.Base64.getDecoder().decode(contentBase64)
        java.nio.file.Files.write(target.toPath(), bytes)
        return buildJsonObject {
            put("saved", JsonPrimitive(true))
            put("path", JsonPrimitive(target.absolutePath))
        }
    }

    private fun <T> decodeOrThrow(
        payload: JsonElement?,
        serializer: kotlinx.serialization.KSerializer<T>,
        errorKey: String,
    ): T {
        return try {
            if (payload != null && payload is JsonObject) {
                json.decodeFromJsonElement(serializer, payload)
            } else {
                throw IllegalArgumentException("$errorKey: payload missing")
            }
        } catch (e: Exception) {
            throw IllegalArgumentException("$errorKey: ${e.message}")
        }
    }

    private fun resolveOpenable(project: Project, rawPath: String?): VirtualFile {
        if (rawPath.isNullOrEmpty()) throw IllegalArgumentException("file_not_found")
        val projectRoot = project.basePath
            ?: throw IllegalStateException("no_project_open")
        val candidate = if (Paths.get(rawPath).isAbsolute) {
            Paths.get(rawPath).normalize()
        } else {
            Paths.get(projectRoot, rawPath).normalize()
        }
        val rootNorm = Paths.get(projectRoot).normalize()
        if (!candidate.startsWith(rootNorm)) {
            throw IllegalArgumentException("path_outside_project")
        }
        // VFS lookup — synchronous, safe off-EDT (LocalFileSystem refresh is
        // not needed for files that already exist on disk).
        val vFile = LocalFileSystem.getInstance().findFileByPath(candidate.toString())
            ?: throw IllegalArgumentException("file_not_found")
        if (!vFile.exists()) throw IllegalArgumentException("file_not_found")
        return vFile
    }

    // Opens the file in the IDE editor on EDT, optionally at a 1-based
    // line/column. Returns the Editor on success, or null when the IDE
    // refuses to open (binary file, missing PSI for the language, etc).
    private fun openOnEdt(
        project: Project,
        file: VirtualFile,
        line: Int?,
        column: Int?,
    ): Editor? {
        val safeLine = if (line != null && line > 0) line - 1 else 0
        val safeCol = if (column != null && column > 0) column - 1 else 0
        var opened: Editor? = null
        ApplicationManager.getApplication().invokeAndWait {
            try {
                val descriptor = OpenFileDescriptor(project, file, safeLine, safeCol)
                opened = FileEditorManager.getInstance(project).openTextEditor(descriptor, true)
            } catch (t: Throwable) {
                // Logged at INFO upstream — leave `opened` null so the caller
                // throws the stable error string for the webview.
            }
        }
        return opened
    }

    private fun invokeActionOnEdt(project: Project, editor: Editor, actionId: String) {
        ApplicationManager.getApplication().invokeLater {
            val action = ActionManager.getInstance().getAction(actionId) ?: return@invokeLater
            val context = SimpleDataContext.builder()
                .add(CommonDataKeys.PROJECT, project)
                .add(CommonDataKeys.EDITOR, editor)
                .add(PlatformDataKeys.FILE_EDITOR, FileEditorManager.getInstance(project).selectedEditor)
                .build()
            @Suppress("DEPRECATION")
            val event = AnActionEvent.createFromAnAction(action, null, ActionPlaces.UNKNOWN, context)
            action.actionPerformed(event)
        }
    }
}
