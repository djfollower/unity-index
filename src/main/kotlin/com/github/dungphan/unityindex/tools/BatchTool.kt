package com.github.dungphan.unityindex.tools

import com.github.dungphan.unityindex.constants.ParamNames
import com.github.dungphan.unityindex.constants.ToolNames
import com.github.dungphan.unityindex.server.ProjectResolver
import com.github.dungphan.unityindex.server.models.ContentBlock
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.project.Project
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Multi-call dispatcher. Lets a client send N tool invocations in a single MCP
 * request; the server runs them with shared PSI sync and bounded concurrency.
 *
 * Targeting the 30k-file Unity project case where naive per-call MCP traffic
 * pays PSI/VFS sync, project resolution, and read-action acquisition per call.
 *
 * Wire shape is described in the tool's `description` and in
 * `vscode-extension/src/tools/batchTool.ts` — keep both in lockstep.
 */
class BatchTool(
    private val registry: ToolRegistry
) : AbstractMcpTool() {

    companion object {
        private val LOG = logger<BatchTool>()

        // Hard upper bound on entries per batch. Sized for the "sweep 256
        // symbols at once" case; raise after we have real timing data on a
        // 30k-file Unity project. Bumping this requires re-checking
        // BATCH_REQUEST_TIMEOUT_MS in KtorMcpServer — at the current
        // 300s envelope cap and ~1s/entry worst case for symbol lookups,
        // 256 is the largest batch that comfortably fits.
        const val MAX_ENTRIES = 256
        const val DEFAULT_CONCURRENCY = 8
        const val MAX_CONCURRENCY = 16

        // Per-entry budget. Mirrors the single-call timeout in KtorMcpServer.
        const val DEFAULT_ENTRY_TIMEOUT_MS = 120_000L

        // Whole-batch budget. Server cap; clients may request lower via
        // `timeoutMs`. Matches BATCH_REQUEST_TIMEOUT_MS in KtorMcpServer.
        const val MAX_BATCH_TIMEOUT_MS = 300_000L
        const val DEFAULT_BATCH_TIMEOUT_MS = 120_000L
    }

    override val name = ToolNames.BATCH

    override val description = """
        Run multiple MCP tool calls in a single request. Use for any sweep that would
        otherwise issue N per-call requests — e.g. resolving N symbols, reading N files,
        or finding usages for N positions. The server amortizes PSI sync and project
        resolution across the whole batch, and runs entries concurrently (up to
        $DEFAULT_CONCURRENCY by default).

        Hard limits: up to $MAX_ENTRIES entries per call; concurrency capped at $MAX_CONCURRENCY;
        whole-batch wall clock capped at ${MAX_BATCH_TIMEOUT_MS}ms.

        Parameters:
        - calls (required): array of {id, tool, arguments}. `id` is a client-chosen
          string echoed in the response; must be unique within the batch. `tool` is any
          registered MCP tool name except `ide_batch` (no nesting). `arguments` is the
          object that tool's schema expects.
        - project_path (optional): merged into each call's `arguments` if the entry
          does not already set it. Saves repeating the workspace path on every entry.
        - stopOnError (optional, default false): if true, abort on the first entry
          that returns status="error"; remaining entries return status="skipped".
        - maxConcurrency (optional, default $DEFAULT_CONCURRENCY, max $MAX_CONCURRENCY).
        - timeoutMs (optional, default ${DEFAULT_BATCH_TIMEOUT_MS}, max $MAX_BATCH_TIMEOUT_MS):
          whole-batch wall clock budget.

        Response envelope:
        {
          "results": [
            { "id": "...", "status": "ok",      "result": <ToolCallResult> },
            { "id": "...", "status": "error",   "error": "<dispatch failure>" },
            { "id": "...", "status": "skipped", "reason": "stopOnError" | "batchTimeout" }
          ],
          "syncMs": <int>,   // time spent on shared PSI/VFS sync
          "totalMs": <int>,  // wall clock for the whole batch
          "concurrency": <int>
        }

        `status="ok"` includes tool-level errors (`result.isError=true`); `status="error"`
        is reserved for dispatch failures (unknown tool, malformed entry, nested batch).
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .projectPath()
        .property(
            name = "calls",
            schema = buildJsonObject {
                put("type", "array")
                put("description", "Tool calls to execute (1..$MAX_ENTRIES).")
                put("minItems", 1)
                put("maxItems", MAX_ENTRIES)
                put("items", buildJsonObject {
                    put("type", "object")
                    put("required", buildJsonArray {
                        add("id"); add("tool"); add("arguments")
                    })
                    put("properties", buildJsonObject {
                        put("id", buildJsonObject {
                            put("type", "string")
                            put("description", "Client-chosen key, unique within the batch.")
                        })
                        put("tool", buildJsonObject {
                            put("type", "string")
                            put("description", "Registered tool name. `ide_batch` is rejected.")
                        })
                        put("arguments", buildJsonObject {
                            put("type", "object")
                            put("description", "Arguments object for that tool's schema.")
                        })
                    })
                })
            },
            required = true
        )
        .booleanProperty(
            "stopOnError",
            "If true, abort on the first entry that returns status=\"error\"; remaining entries return status=\"skipped\". Default false."
        )
        .intProperty(
            "maxConcurrency",
            "Max parallel entries, default $DEFAULT_CONCURRENCY, max $MAX_CONCURRENCY."
        )
        .intProperty(
            "timeoutMs",
            "Whole-batch wall clock budget in ms, default $DEFAULT_BATCH_TIMEOUT_MS, max $MAX_BATCH_TIMEOUT_MS."
        )
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val batchStart = System.currentTimeMillis()

        val callsElement = arguments["calls"]
            ?: return createErrorResult("Missing required parameter: calls")
        if (callsElement !is JsonArray) {
            return createErrorResult("`calls` must be a JSON array")
        }
        if (callsElement.isEmpty()) {
            return createErrorResult("`calls` must contain at least one entry")
        }
        if (callsElement.size > MAX_ENTRIES) {
            return createErrorResult("`calls` exceeds the per-batch limit of $MAX_ENTRIES (got ${callsElement.size})")
        }

        val entries = mutableListOf<Entry>()
        val seenIds = mutableSetOf<String>()
        for ((index, element) in callsElement.withIndex()) {
            val parsed = parseEntry(element, index, seenIds)
            when (parsed) {
                is EntryParse.Ok -> entries.add(parsed.entry)
                is EntryParse.Invalid -> return createErrorResult(parsed.message)
            }
        }

        val inheritedProjectPath = arguments[ParamNames.PROJECT_PATH]?.jsonPrimitive?.contentOrNull
        val stopOnError = arguments["stopOnError"]?.jsonPrimitive?.booleanOrNull ?: false
        val maxConcurrency = (arguments["maxConcurrency"]?.jsonPrimitive?.int ?: DEFAULT_CONCURRENCY)
            .coerceIn(1, MAX_CONCURRENCY)
        val batchTimeoutMs = (arguments["timeoutMs"]?.jsonPrimitive?.int?.toLong() ?: DEFAULT_BATCH_TIMEOUT_MS)
            .coerceIn(1_000L, MAX_BATCH_TIMEOUT_MS)

        // PSI sync already ran in AbstractMcpTool.execute() before we got here;
        // its elapsed time is rolled into syncMs by subtracting doExecute start
        // from batch start at the caller — but doExecute is what we're inside.
        // We report 0 here and let the AbstractMcpTool execute timer log the
        // pre-sync cost separately.
        val syncMs = 0L

        LOG.info(
            "BatchTool: ${entries.size} entries, concurrency=$maxConcurrency, " +
                "timeoutMs=$batchTimeoutMs, stopOnError=$stopOnError"
        )

        val semaphore = Semaphore(maxConcurrency)
        val results = arrayOfNulls<EntryResult>(entries.size)
        val abort = java.util.concurrent.atomic.AtomicBoolean(false)
        val timedOut = java.util.concurrent.atomic.AtomicBoolean(false)

        try {
            withTimeout(batchTimeoutMs) {
                coroutineScope {
                    entries.mapIndexed { index, entry ->
                        async(Dispatchers.Default) {
                            if (stopOnError && abort.get()) {
                                results[index] = EntryResult.Skipped(entry.id, "stopOnError")
                                return@async
                            }
                            semaphore.withPermit {
                                if (stopOnError && abort.get()) {
                                    results[index] = EntryResult.Skipped(entry.id, "stopOnError")
                                    return@withPermit
                                }
                                results[index] = runEntry(entry, inheritedProjectPath)
                                if (stopOnError && results[index] is EntryResult.Error) {
                                    abort.set(true)
                                }
                            }
                        }
                    }.awaitAll()
                }
            }
        } catch (e: TimeoutCancellationException) {
            timedOut.set(true)
            LOG.warn("BatchTool: hit whole-batch timeout after ${batchTimeoutMs}ms")
        } catch (e: ProcessCanceledException) {
            throw e
        } catch (e: CancellationException) {
            throw e
        }

        // Fill in any null slots (timed out or never scheduled before timeout).
        for (i in results.indices) {
            if (results[i] == null) {
                results[i] = EntryResult.Skipped(entries[i].id, "batchTimeout")
            }
        }

        val totalMs = System.currentTimeMillis() - batchStart
        val envelope = buildEnvelope(results.requireNoNulls().toList(), syncMs, totalMs, maxConcurrency)
        return ToolCallResult(
            content = listOf(ContentBlock.Text(text = formatStructuredPayload(envelope))),
            isError = false
        )
    }

    private suspend fun runEntry(entry: Entry, inheritedProjectPath: String?): EntryResult {
        val tool = registry.getTool(entry.tool)
            ?: return EntryResult.Error(entry.id, "Tool not found: ${entry.tool}")

        val mergedArgs = mergeProjectPath(entry.arguments, inheritedProjectPath)
        val projectPath = mergedArgs[ParamNames.PROJECT_PATH]?.jsonPrimitive?.contentOrNull
        val resolved = ProjectResolver.resolveOrOpen(projectPath)
        if (resolved.isError) {
            // Project resolution failure surfaces as a tool-level error result
            // (matches single-call behavior in JsonRpcHandler), so we return
            // status="ok" with the error envelope from the resolver.
            return EntryResult.Ok(entry.id, resolved.errorResult!!)
        }

        val entryStart = System.currentTimeMillis()
        return try {
            val result = withTimeout(DEFAULT_ENTRY_TIMEOUT_MS) {
                tool.execute(resolved.project!!, mergedArgs, skipPsiSync = true)
            }
            val elapsed = System.currentTimeMillis() - entryStart
            LOG.debug("BatchTool entry id=${entry.id} tool=${entry.tool} done in ${elapsed}ms")
            EntryResult.Ok(entry.id, result)
        } catch (e: TimeoutCancellationException) {
            val elapsed = System.currentTimeMillis() - entryStart
            EntryResult.Ok(
                entry.id,
                ToolCallResult(
                    content = listOf(ContentBlock.Text(
                        text = "Entry timed out after ${elapsed}ms (limit ${DEFAULT_ENTRY_TIMEOUT_MS}ms)"
                    )),
                    isError = true
                )
            )
        } catch (e: ProcessCanceledException) {
            throw e
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            LOG.warn("BatchTool entry id=${entry.id} tool=${entry.tool} threw", e)
            EntryResult.Ok(
                entry.id,
                ToolCallResult(
                    content = listOf(ContentBlock.Text(text = e.message ?: "Unknown error")),
                    isError = true
                )
            )
        }
    }

    private fun mergeProjectPath(args: JsonObject, inherited: String?): JsonObject {
        if (inherited == null) return args
        if (args[ParamNames.PROJECT_PATH] != null && args[ParamNames.PROJECT_PATH] !is JsonNull) return args
        return JsonObject(args + (ParamNames.PROJECT_PATH to JsonPrimitive(inherited)))
    }

    private sealed class EntryParse {
        data class Ok(val entry: Entry) : EntryParse()
        data class Invalid(val message: String) : EntryParse()
    }

    private fun parseEntry(element: JsonElement, index: Int, seenIds: MutableSet<String>): EntryParse {
        if (element !is JsonObject) {
            return EntryParse.Invalid("calls[$index] must be an object")
        }
        val id = element["id"]?.jsonPrimitive?.contentOrNull
            ?: return EntryParse.Invalid("calls[$index].id is required and must be a non-empty string")
        if (id.isBlank()) {
            return EntryParse.Invalid("calls[$index].id must be non-empty")
        }
        if (!seenIds.add(id)) {
            return EntryParse.Invalid("calls[$index].id duplicates an earlier entry: \"$id\"")
        }
        val tool = element["tool"]?.jsonPrimitive?.contentOrNull
            ?: return EntryParse.Invalid("calls[$index].tool is required and must be a string")
        if (tool == ToolNames.BATCH) {
            return EntryParse.Invalid("calls[$index] (id=\"$id\"): ide_batch cannot be nested")
        }
        val argsElement = element["arguments"]
            ?: return EntryParse.Invalid("calls[$index].arguments is required (use {} for none)")
        if (argsElement !is JsonObject) {
            return EntryParse.Invalid("calls[$index].arguments must be an object")
        }
        return EntryParse.Ok(Entry(id = id, tool = tool, arguments = argsElement))
    }

    private fun buildEnvelope(
        results: List<EntryResult>,
        syncMs: Long,
        totalMs: Long,
        concurrency: Int
    ): String {
        val payload = buildJsonObject {
            put("results", buildJsonArray {
                for (r in results) {
                    add(when (r) {
                        is EntryResult.Ok -> buildJsonObject {
                            put("id", r.id)
                            put("status", "ok")
                            put("result", json.encodeToJsonElement(r.result))
                        }
                        is EntryResult.Error -> buildJsonObject {
                            put("id", r.id)
                            put("status", "error")
                            put("error", r.message)
                        }
                        is EntryResult.Skipped -> buildJsonObject {
                            put("id", r.id)
                            put("status", "skipped")
                            put("reason", r.reason)
                        }
                    })
                }
            })
            put("syncMs", syncMs)
            put("totalMs", totalMs)
            put("concurrency", concurrency)
        }
        return json.encodeToString(JsonElement.serializer(), payload)
    }

    private data class Entry(
        val id: String,
        val tool: String,
        val arguments: JsonObject
    )

    private sealed class EntryResult {
        data class Ok(val id: String, val result: ToolCallResult) : EntryResult()
        data class Error(val id: String, val message: String) : EntryResult()
        data class Skipped(val id: String, val reason: String) : EntryResult()
    }
}
