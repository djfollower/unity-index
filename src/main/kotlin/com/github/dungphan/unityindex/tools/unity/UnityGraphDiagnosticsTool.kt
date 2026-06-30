package com.github.dungphan.unityindex.tools.unity

import com.github.dungphan.unityindex.constants.ToolNames
import com.github.dungphan.unityindex.server.BuildDiagnosticsCacheService
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.models.BuildMessage
import com.github.dungphan.unityindex.tools.models.DiagnosticMessage
import com.github.dungphan.unityindex.tools.models.DiagnosticSeverity
import com.github.dungphan.unityindex.tools.models.DiagnosticsBatchRequest
import com.github.dungphan.unityindex.tools.models.DiagnosticsBatchResponse
import com.github.dungphan.unityindex.tools.models.MaxDiagnosticSeverity
import com.github.dungphan.unityindex.tools.models.NodeDiagnostics
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File

/**
 * Day 10 — diagnostics overlay for the graph webview. Wire format
 * documented in `docs/graph-mcp-tools.md` and `graph/core/src/diagnostics-wire.ts`.
 *
 * Given up to [DIAGNOSTICS_MAX_NODES] graph node IDs, returns per-node
 * counts (errors / warnings / infos), the max severity, and (optionally)
 * a small list of top messages. Powers three webview features that share
 * the same response: badges, heatmap, and the "errors-only" filter.
 *
 * Data source: [BuildDiagnosticsCacheService] — the last build's
 * compiler/build-event messages indexed by file path. We deliberately do
 * NOT trigger fresh daemon highlighting per node here; calling
 * `DiagnosticsAnalysisService.analyzeFile` 500× would spike CPU and add
 * tens of seconds of latency to a screen refresh. For deep per-file
 * inspection callers should drop back to `ide_diagnostics`.
 *
 * Node-id → file resolution mirrors the snapshot ID scheme
 * (graph-schema.md §1):
 *   - `unity://script/<project-relative-path>` → path after the prefix
 *   - `unity://csharp/T:Ns.Type`              → declaring file via
 *                                                [CSharpSymbolResolver]
 *   - `unity://csharp/M:Ns.Type.Method(...)`  → declaring file of the
 *                                                enclosing type
 *
 * Anything else, or a parse that resolves nowhere, is returned in
 * `unresolved_ids` (partial success — matches the code-edges contract).
 */
class UnityGraphDiagnosticsTool : AbstractMcpTool() {

    companion object {
        private val LOG = logger<UnityGraphDiagnosticsTool>()
        const val DIAGNOSTICS_MAX_NODES = 500
        const val DIAGNOSTICS_DEFAULT_MAX_MESSAGES = 3
        const val DIAGNOSTICS_MAX_MESSAGES_PER_NODE = 10

        /** Day 10 — bridge-friendly synchronous entry point used by the
         *  graph webview's overlay refresh. Caller must already be off the
         *  EDT (we acquire a platform read lock). Throws
         *  [IllegalArgumentException] with a leading `invalid_id` /
         *  `invalid_arguments` token for validation failures so the
         *  bridge's generic error path surfaces a stable string to the
         *  webview; any other failure propagates as-is. The MCP
         *  `doExecute` path keeps its own typed error-envelope handling
         *  and does not call this. */
        fun runDirect(project: Project, request: DiagnosticsBatchRequest): DiagnosticsBatchResponse {
            if (request.node_ids.isEmpty()) {
                throw IllegalArgumentException("invalid_id: node_ids must contain at least one entry")
            }
            if (request.node_ids.size > DIAGNOSTICS_MAX_NODES) {
                throw IllegalArgumentException("invalid_arguments: node_ids has ${request.node_ids.size} entries, max $DIAGNOSTICS_MAX_NODES")
            }
            val tool = UnityGraphDiagnosticsTool()
            val includeMessages = request.include_messages ?: true
            val maxMessages = (request.max_messages_per_node ?: DIAGNOSTICS_DEFAULT_MAX_MESSAGES)
                .coerceIn(1, DIAGNOSTICS_MAX_MESSAGES_PER_NODE)
            val cache = BuildDiagnosticsCacheService.getInstance(project)
            val byPath = tool.indexByCanonicalPath(project, cache.getLastBuildDiagnostics())
            val (diagnostics, unresolved) = ReadAction.compute<Pair<List<NodeDiagnostics>, List<String>>, Throwable> {
                val out = ArrayList<NodeDiagnostics>(request.node_ids.size)
                val miss = ArrayList<String>()
                for (rawId in request.node_ids) {
                    val absPath = tool.resolveNodeIdToAbsolutePath(project, rawId)
                    if (absPath == null) {
                        miss.add(rawId)
                        continue
                    }
                    val msgs = byPath[absPath].orEmpty()
                    out.add(tool.aggregate(rawId, msgs, includeMessages, maxMessages))
                }
                out to miss
            }
            return DiagnosticsBatchResponse(
                request_id = request.request_id,
                generated_at = java.time.Instant.now().toString(),
                warnings = null,
                diagnostics = diagnostics,
                unresolved_ids = unresolved.takeIf { it.isNotEmpty() },
            )
        }
    }

    override val requiresPsiSync: Boolean = false

    override val name: String = ToolNames.UNITY_GRAPH_DIAGNOSTICS

    override val description: String = """
        Batch diagnostics lookup for the graph overlay. Given up to $DIAGNOSTICS_MAX_NODES graph node IDs, returns per-node counts (errors, warnings, infos), the max severity, and (when `include_messages` is not false) a small `top_messages` list.

        Accepts:
        - `unity://script/<project-relative-path>` — the file directly
        - `unity://csharp/T:Ns.Type`              — the declaring file of the type
        - `unity://csharp/M:Ns.Type.Method(...)`  — the declaring file of the method's enclosing type

        Diagnostics source: the IDE's last-build cache (compiler + build-event messages). Faster than `ide_diagnostics` for hundreds of nodes because it does NOT trigger fresh daemon highlighting per file; drop back to `ide_diagnostics` for live per-file analysis.

        Parameters:
        - node_ids: 1..$DIAGNOSTICS_MAX_NODES graph node IDs.
        - include_messages (optional, default true): when false, `top_messages` is omitted (counts-only response).
        - max_messages_per_node (optional, default $DIAGNOSTICS_DEFAULT_MAX_MESSAGES, max $DIAGNOSTICS_MAX_MESSAGES_PER_NODE): cap on `top_messages.length` per node.
        - project_path (optional): only needed when multiple projects are open.

        Node IDs that parse cleanly but don't resolve to a file (renamed class, sub-file kind we can't anchor) come back in `unresolved_ids` rather than erroring (partial success).
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .projectPath()
        .property("node_ids", buildJsonObject {
            put("type", JsonPrimitive("array"))
            put("description", JsonPrimitive("1..$DIAGNOSTICS_MAX_NODES graph node IDs (e.g. `unity://script/Assets/Scripts/Player.cs`, `unity://csharp/T:Foo.Bar`)."))
            put("items", buildJsonObject { put("type", JsonPrimitive("string")) })
        }, required = true)
        .booleanProperty("include_messages", "Default true. When false, `top_messages` is omitted (counts-only).")
        .property("max_messages_per_node", buildJsonObject {
            put("type", JsonPrimitive("integer"))
            put("description", JsonPrimitive("Cap on `top_messages.length` per node. Default $DIAGNOSTICS_DEFAULT_MAX_MESSAGES, clamped to $DIAGNOSTICS_MAX_MESSAGES_PER_NODE."))
        })
        .stringProperty("request_id", "Optional; echoed back on the response for client correlation.")
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val request = try {
            json.decodeFromJsonElement(DiagnosticsBatchRequest.serializer(), arguments)
        } catch (e: Exception) {
            return createStructuredErrorResult(buildJsonObject {
                put("error", buildJsonObject {
                    put("kind", JsonPrimitive("invalid_arguments"))
                    put("detail", JsonPrimitive(e.message ?: "could not decode DiagnosticsBatchRequest"))
                })
            })
        }

        if (request.node_ids.isEmpty()) {
            return invalidIdError("node_ids must contain at least one entry")
        }
        if (request.node_ids.size > DIAGNOSTICS_MAX_NODES) {
            return createStructuredErrorResult(buildJsonObject {
                put("error", buildJsonObject {
                    put("kind", JsonPrimitive("invalid_arguments"))
                    put("detail", JsonPrimitive("node_ids has ${request.node_ids.size} entries, max $DIAGNOSTICS_MAX_NODES"))
                })
            })
        }

        val includeMessages = request.include_messages ?: true
        val maxMessages = (request.max_messages_per_node ?: DIAGNOSTICS_DEFAULT_MAX_MESSAGES)
            .coerceIn(1, DIAGNOSTICS_MAX_MESSAGES_PER_NODE)

        // Build the file→messages index once. BuildDiagnosticsCacheService is
        // a per-project service; entries already carry an absolute or
        // project-relative file path (the BuildListenerUtils normaliser is
        // best-effort). We canonicalise to absolute paths so both forms hit
        // the same bucket.
        val cache = BuildDiagnosticsCacheService.getInstance(project)
        val byPath: Map<String, List<BuildMessage>> = indexByCanonicalPath(project, cache.getLastBuildDiagnostics())

        // Resolution + aggregation must run inside a read action because the
        // C# id branch touches PSI via CSharpSymbolResolver.
        val (diagnostics, unresolved) = ReadAction.compute<Pair<List<NodeDiagnostics>, List<String>>, Throwable> {
            val out = ArrayList<NodeDiagnostics>(request.node_ids.size)
            val miss = ArrayList<String>()
            for (rawId in request.node_ids) {
                val absPath = resolveNodeIdToAbsolutePath(project, rawId)
                if (absPath == null) {
                    miss.add(rawId)
                    continue
                }
                val msgs = byPath[absPath].orEmpty()
                out.add(aggregate(rawId, msgs, includeMessages, maxMessages))
            }
            out to miss
        }

        val generatedAt = java.time.Instant.now().toString()
        return createJsonResult(DiagnosticsBatchResponse(
            request_id = request.request_id,
            generated_at = generatedAt,
            warnings = null,
            diagnostics = diagnostics,
            unresolved_ids = unresolved.takeIf { it.isNotEmpty() },
        ))
    }

    private fun invalidIdError(detail: String): ToolCallResult =
        createStructuredErrorResult(buildJsonObject {
            put("error", buildJsonObject {
                put("kind", JsonPrimitive("invalid_id"))
                put("detail", JsonPrimitive(detail))
            })
        })

    /** Build a path→messages lookup keyed by canonical absolute path. Build
     *  cache entries may carry either absolute or project-relative paths; we
     *  resolve relatives against `project.basePath` so callers can match on
     *  either form. Entries with no `file` are dropped (not attributable to
     *  a graph node). */
    internal fun indexByCanonicalPath(project: Project, messages: List<BuildMessage>): Map<String, List<BuildMessage>> {
        if (messages.isEmpty()) return emptyMap()
        val base = project.basePath?.let { File(it).canonicalPath }
        val map = HashMap<String, MutableList<BuildMessage>>()
        for (m in messages) {
            val f = m.file?.takeIf { it.isNotBlank() } ?: continue
            val abs = try {
                if (File(f).isAbsolute) File(f).canonicalPath
                else if (base != null) File(base, f).canonicalPath
                else File(f).canonicalPath
            } catch (_: Exception) {
                continue
            }
            map.getOrPut(abs) { mutableListOf() }.add(m)
        }
        return map
    }

    /** Map a node id to the canonical absolute path of its declaring file,
     *  or null when the id is unparseable / unresolvable. Must run inside a
     *  read action (the csharp branch touches PSI). */
    internal fun resolveNodeIdToAbsolutePath(project: Project, rawId: String): String? {
        val id = rawId.trim()
        if (id.isEmpty()) return null
        return when {
            id.startsWith("unity://script/") -> {
                val rel = id.removePrefix("unity://script/")
                resolveFile(project, rel)?.canonicalPath()
            }
            id.startsWith(CSharpSymbolResolver.PREFIX) -> {
                val parsed = CSharpSymbolResolver.parse(id) ?: return null
                if (parsed.kind == CSharpSymbolResolver.SymbolKind.OTHER) return null
                val resolved = try {
                    CSharpSymbolResolver.resolve(project, parsed)
                } catch (e: Throwable) {
                    LOG.debug("csharp resolve failed for $id: ${e.message}", e)
                    null
                } ?: return null
                val anchor = resolved.typeElement ?: resolved.element
                anchor.containingFile?.virtualFile?.canonicalPath()
            }
            else -> null
        }
    }

    private fun VirtualFile.canonicalPath(): String? = try {
        File(this.path).canonicalPath
    } catch (_: Exception) {
        this.path
    }

    /** Reduce a file's build messages to a [NodeDiagnostics]. The
     *  `category` field on [BuildMessage] is "ERROR" / "WARNING" / "INFO"
     *  (set by `BuildListenerUtils.extractBuildMessage` /
     *  `extractCompilerMessages`). Anything we don't recognise gets
     *  bucketed as `info` so we don't drop counts on the floor. */
    internal fun aggregate(
        nodeId: String,
        messages: List<BuildMessage>,
        includeMessages: Boolean,
        maxMessages: Int,
    ): NodeDiagnostics {
        var errors = 0
        var warnings = 0
        var infos = 0
        val typed = ArrayList<Pair<DiagnosticSeverity, BuildMessage>>(messages.size)
        for (m in messages) {
            val sev = severityOf(m.category)
            when (sev) {
                DiagnosticSeverity.ERROR -> errors++
                DiagnosticSeverity.WARNING -> warnings++
                DiagnosticSeverity.INFO -> infos++
            }
            typed.add(sev to m)
        }
        val maxSev = when {
            errors > 0 -> MaxDiagnosticSeverity.ERROR
            warnings > 0 -> MaxDiagnosticSeverity.WARNING
            infos > 0 -> MaxDiagnosticSeverity.INFO
            else -> MaxDiagnosticSeverity.NONE
        }
        val top: List<DiagnosticMessage>? = if (!includeMessages) null else {
            typed
                .sortedWith(compareBy { severityRank(it.first) })
                .take(maxMessages)
                .map { (sev, m) -> DiagnosticMessage(severity = sev, message = m.message, line = m.line, column = m.column) }
        }
        return NodeDiagnostics(
            node_id = nodeId,
            errors = errors,
            warnings = warnings,
            infos = infos,
            max_severity = maxSev,
            top_messages = top,
        )
    }

    private fun severityOf(category: String?): DiagnosticSeverity = when (category?.uppercase()) {
        "ERROR" -> DiagnosticSeverity.ERROR
        "WARNING" -> DiagnosticSeverity.WARNING
        else -> DiagnosticSeverity.INFO
    }

    /** Sort key — lower is more severe, so `sortedBy { severityRank(it) }`
     *  surfaces errors first. Matches the order documented in the wire
     *  contract (severity desc, then file order). */
    private fun severityRank(s: DiagnosticSeverity): Int = when (s) {
        DiagnosticSeverity.ERROR -> 0
        DiagnosticSeverity.WARNING -> 1
        DiagnosticSeverity.INFO -> 2
    }
}
