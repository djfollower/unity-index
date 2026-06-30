package com.github.dungphan.unityindex.graph

import com.github.dungphan.unityindex.tools.models.CodeEdgesRequest
import com.github.dungphan.unityindex.tools.models.CodeEdgesResponse
import com.github.dungphan.unityindex.tools.models.GraphSnapshotRequest
import com.github.dungphan.unityindex.tools.unity.UnityGraphCodeEdgesTool
import com.github.dungphan.unityindex.util.GraphClassAnchors
import com.github.dungphan.unityindex.util.UnityAssetGraphBuilder
import com.intellij.ide.actions.RevealFileAction
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.PlatformDataKeys
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
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

    fun dispatch(type: String, payload: JsonElement?, project: Project?): JsonElement {
        return when (type) {
            GraphWireTypes.HELLO -> handleHello(payload)
            GraphWireTypes.SNAPSHOT -> handleSnapshot(payload, project)
            GraphWireTypes.OPEN_FILE -> handleOpenFile(payload, project)
            GraphWireTypes.FIND_USAGES -> handleFindUsages(payload, project)
            GraphWireTypes.REVEAL_IN_EXPLORER -> handleRevealInExplorer(payload, project)
            GraphWireTypes.GET_FILTER_STATE -> handleGetFilterState(project)
            GraphWireTypes.SET_FILTER_STATE -> handleSetFilterState(payload, project)
            GraphWireTypes.CODE_EDGES -> handleCodeEdges(payload, project)
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
