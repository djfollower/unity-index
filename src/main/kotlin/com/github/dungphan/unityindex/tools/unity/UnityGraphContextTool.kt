package com.github.dungphan.unityindex.tools.unity

import com.github.dungphan.unityindex.constants.ToolNames
import com.github.dungphan.unityindex.server.models.ContentBlock
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.intelligence.GetDiagnosticsTool
import com.github.dungphan.unityindex.tools.models.DiagnosticSummary
import com.github.dungphan.unityindex.tools.models.EdgeWithEndpoint
import com.github.dungphan.unityindex.tools.models.FileStructureResult
import com.github.dungphan.unityindex.tools.models.GraphContextRequest
import com.github.dungphan.unityindex.tools.models.GraphContextResponse
import com.github.dungphan.unityindex.tools.models.GraphSnapshotRequest
import com.github.dungphan.unityindex.tools.models.NodeKind
import com.github.dungphan.unityindex.tools.models.ProblemInfo
import com.github.dungphan.unityindex.tools.navigation.FileStructureTool
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.github.dungphan.unityindex.util.GraphTraversal
import com.github.dungphan.unityindex.util.UnityAssetGraphBuilder
import com.intellij.openapi.project.Project
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Day-6 MCP surface — see `docs/graph-mcp-tools.md` §3.4.
 * Single node + 1-hop neighborhood, optimized for LLM prompts. Optionally
 * enriches script nodes with a code summary (FileStructureTool) and
 * diagnostics (GetDiagnosticsTool). No new analysis paths.
 */
class UnityGraphContextTool : AbstractMcpTool() {

    companion object {
        private const val DEFAULT_MAX_NEIGHBORS = 50
        private const val HARD_MAX_NEIGHBORS = 10_000
    }

    override val requiresPsiSync: Boolean = false

    override val name: String = ToolNames.UNITY_GRAPH_CONTEXT

    override val description: String = """
        Return a single graph node plus its 1-hop neighborhood, optimized for LLM prompt construction.
        Optionally enriches script nodes with a code-summary (ide_file_structure) and diagnostics (ide_diagnostics).
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .projectPath()
        .stringProperty("node_id", "Graph node ID to focus on.", required = true)
        .booleanProperty("include_code_summary", "Default true. For script nodes, attaches a markdown-ish code summary.")
        .booleanProperty("include_diagnostics", "Default false. Attach diagnostics for the node's file (if any).")
        .intProperty("max_neighbors", "Cap per direction. Default $DEFAULT_MAX_NEIGHBORS.")
        .stringProperty("request_id", "Optional; echoed back on the response for client correlation.")
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val request = try {
            json.decodeFromJsonElement(GraphContextRequest.serializer(), arguments)
        } catch (e: Exception) {
            return createErrorResult("Invalid arguments: ${e.message}")
        }
        val nodeId = request.node_id?.takeIf { it.isNotBlank() }
            ?: return createStructuredErrorResult(buildJsonObject {
                put("error", buildJsonObject {
                    put("kind", JsonPrimitive("invalid_id"))
                    put("detail", JsonPrimitive("node_id is required"))
                })
            })
        val includeCodeSummary = request.include_code_summary ?: true
        val includeDiagnostics = request.include_diagnostics ?: false
        val maxNeighbors = (request.max_neighbors ?: DEFAULT_MAX_NEIGHBORS).coerceIn(1, HARD_MAX_NEIGHBORS)

        return try {
            val snapshotReq = GraphSnapshotRequest(project_path = request.project_path)
            val fullResponse = withContext(Dispatchers.IO) {
                UnityAssetGraphBuilder.build(project, snapshotReq)
            }
            val adj = GraphTraversal.buildAdjacency(fullResponse.snapshot)
            val result = GraphTraversal.context(
                adj,
                nodeId,
                GraphTraversal.ContextOptions(maxNeighbors = maxNeighbors),
            ) ?: return createStructuredErrorResult(buildJsonObject {
                put("error", buildJsonObject {
                    put("kind", JsonPrimitive("invalid_id"))
                    put("detail", JsonPrimitive("node_id '$nodeId' not present in the current snapshot"))
                })
            })

            val incoming = result.incoming.map { EdgeWithEndpoint(it.edge, it.other) }
            val outgoing = result.outgoing.map { EdgeWithEndpoint(it.edge, it.other) }

            val codeSummary: String? = if (includeCodeSummary && result.node.kind == NodeKind.SCRIPT && result.node.path != null) {
                tryCodeSummary(project, result.node.path)
            } else null
            val diagnostics: List<DiagnosticSummary>? = if (includeDiagnostics && result.node.path != null) {
                tryDiagnostics(project, result.node.path).takeIf { it.isNotEmpty() }
            } else null

            val response = GraphContextResponse(
                request_id = request.request_id,
                generated_at = java.time.Instant.now().toString(),
                warnings = null,
                node = result.node,
                incoming = incoming,
                outgoing = outgoing,
                code_summary = codeSummary,
                diagnostics = diagnostics,
                truncated = if (result.truncated) true else null,
            )
            createJsonResult(response)
        } catch (e: IllegalStateException) {
            createErrorResult(e.message ?: "Failed to compute context")
        } catch (e: Exception) {
            createErrorResult("Failed to compute context: ${e.message}")
        }
    }

    private suspend fun tryCodeSummary(project: Project, filePath: String): String? {
        return try {
            val tool = FileStructureTool()
            val res = tool.execute(
                project,
                buildJsonObject { put("file", JsonPrimitive(filePath)) },
                skipPsiSync = true,
            )
            if (res.isError) return null
            val text = (res.content.firstOrNull() as? ContentBlock.Text)?.text ?: return null
            val parsed = try {
                json.decodeFromString(FileStructureResult.serializer(), text)
            } catch (_: Exception) {
                // FileStructureTool may return a wrapped tree string. Return raw text
                // (still useful) if it isn't structured JSON.
                return text.takeIf { it.isNotBlank() }
            }
            parsed.structure.takeIf { it.isNotBlank() }
        } catch (_: Exception) {
            null
        }
    }

    private suspend fun tryDiagnostics(project: Project, filePath: String): List<DiagnosticSummary> {
        return try {
            val tool = GetDiagnosticsTool()
            val res = tool.execute(
                project,
                buildJsonObject { put("file", JsonPrimitive(filePath)) },
                skipPsiSync = true,
            )
            if (res.isError) return emptyList()
            val text = (res.content.firstOrNull() as? ContentBlock.Text)?.text ?: return emptyList()
            val problems = extractProblems(text)
            problems.map { p ->
                DiagnosticSummary(
                    severity = p.severity,
                    message = p.message,
                    line = p.line,
                )
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun extractProblems(text: String): List<ProblemInfo> {
        // GetDiagnosticsTool returns a structured payload that may be the raw
        // JSON, a wrapped envelope, or a formatted string depending on the
        // user's response-format setting. Try the raw JSON path first.
        return try {
            val element = json.parseToJsonElement(text)
            val obj = element as? JsonObject ?: return emptyList()
            val problemsArr = obj["problems"] ?: return emptyList()
            json.decodeFromJsonElement(kotlinx.serialization.builtins.ListSerializer(ProblemInfo.serializer()), problemsArr)
        } catch (_: Exception) {
            emptyList()
        }
    }
}
