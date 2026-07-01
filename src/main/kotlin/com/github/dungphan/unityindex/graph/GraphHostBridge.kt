package com.github.dungphan.unityindex.graph

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
// Per-browser JS↔Kotlin bridge for the graph webview.
//
// Wire format mirrors graph/core/src/host-bridge.ts: messages are JSON-
// stringified BridgeEnvelopes carried in both directions. Stringifying once
// on each side avoids JBCef's flaky structured JS↔JVM marshalling for
// nested objects and lets us use kotlinx.serialization cleanly.
//
// JS → Kotlin: webview calls window.unityIndex.postToHost(json) which is
// wired (via JBCefJSQuery.inject) to a handler that dispatches into
// GraphHostHandlers.
//
// Kotlin → JS: this side calls window.unityIndex.fromHost(json) via
// executeJavaScript. The JSON-quoted string is injected as a JS literal so
// the runtime parses it back transparently.
class GraphHostBridge(
    private val project: Project?,
    private val browser: JBCefBrowser,
) : Disposable {

    private val json = Json { ignoreUnknownKeys = true }
    // Upcast: there are two overloads of create() and the JBCefBrowser one
    // is deprecated; the JBCefBrowserBase form is the supported API.
    private val query: JBCefJSQuery = JBCefJSQuery.create(browser as JBCefBrowserBase)

    init {
        query.addHandler { envJson ->
            if (!envJson.isNullOrEmpty()) {
                handleIncoming(envJson)
            }
            null
        }
    }

    override fun dispose() {
        query.dispose()
    }

    // Returns the HTML with a <script> stub injected into <head> that creates
    // window.unityIndex BEFORE the bundle's module script runs. Required
    // because the webview's pickBridge() sniffs `window.unityIndex` at mount
    // time — using onLoadEnd to wire it up loses the race (module scripts
    // execute before onLoadEnd fires).
    fun injectIntoHtml(html: String): String {
        val postToHost = query.inject("json")
        // VS Code uses nonce="..." but Rider's loadHTML has no CSP, so the
        // inline script runs unconditionally.
        val stub = """
            <script>
              window.unityIndex = {
                postToHost: function(json) { $postToHost },
                fromHost: undefined
              };
            </script>
        """.trimIndent()
        val headOpen = Regex("<head\\b[^>]*>", RegexOption.IGNORE_CASE).find(html)
        return if (headOpen != null) {
            val insertAt = headOpen.range.last + 1
            html.substring(0, insertAt) + "\n" + stub + html.substring(insertAt)
        } else {
            stub + html
        }
    }

    private fun handleIncoming(envJson: String) {
        val env = try {
            json.decodeFromString(BridgeEnvelope.serializer(), envJson)
        } catch (t: Throwable) {
            LOG.warn("graph: bad envelope from webview: ${t.message}")
            return
        }
        if (env.kind != "request" || env.id == null) {
            return
        }

        // Dispatch off the EDT — handler may do PSI work in the future.
        ApplicationManager.getApplication().executeOnPooledThread {
            val progress = ProgressEmitter(env.id, env.type)
            val response = try {
                val payload = GraphHostHandlers.dispatch(env.type, env.payload, project, progress)
                BridgeEnvelope(kind = "response", id = env.id, type = env.type, payload = payload)
            } catch (t: Throwable) {
                LOG.warn("graph: handler for '${env.type}' threw", t)
                BridgeEnvelope(
                    kind = "response",
                    id = env.id,
                    type = env.type,
                    error = BridgeError(t.message ?: t.javaClass.simpleName),
                )
            } finally {
                progress.stop()
            }
            sendToWebview(response)
        }
    }

    // Per-request progress channel. Handlers grab this to emit heartbeats
    // during long-running work; the webview resets its request timeout on
    // every heartbeat, so a very big project's cold-start scan can take
    // minutes without tripping the 60s inter-message timeout in
    // graph/webview/src/lib/snapshot.ts.
    inner class ProgressEmitter(
        private val requestId: String,
        private val requestType: String,
    ) {
        @Volatile private var stopped = false
        // Last payload the builder reported. Retained so the periodic
        // heartbeat can re-emit it during phases where the builder is doing
        // work but hasn't ticked (e.g., the initial VFS walk before it hits
        // the first asset file). Guarded by no lock — reads and writes are
        // both plain volatile references; races only cost a duplicate emit.
        @Volatile private var lastPayload: JsonElement? = null
        // Throttle wall-clock so per-file reports don't flood the webview.
        // 250ms strikes the balance where a 10k-file scan sends ~40 messages
        // instead of 10k, and the UI updates at a rate humans can read.
        @Volatile private var lastEmitAtMs: Long = 0L

        fun stop() {
            stopped = true
        }

        fun emit(payload: JsonElement) {
            if (stopped) return
            lastPayload = payload
            val env = BridgeEnvelope(
                kind = "progress",
                id = requestId,
                type = requestType,
                payload = payload,
            )
            sendToWebview(env)
        }

        // Convenience: emit a phase/message payload. Shape matches
        // graph/core/src/host-bridge.ts ProgressPayload.
        fun emit(phase: String?, message: String?, current: Int? = null, total: Int? = null) {
            emit(buildPayload(phase, message, current, total))
        }

        /**
         * Throttled per-file reporter for [GraphBuildProgress]. Always
         * updates the retained payload so the next heartbeat sees fresh
         * data, but only crosses the wire if [THROTTLE_MS] has elapsed
         * since the last emit. Guarantees one final emit at each phase
         * transition (`phase` change) so the UI never gets stuck showing
         * "scanning" while resolution is running.
         */
        fun report(phase: String, current: Int, total: Int?, message: String?) {
            if (stopped) return
            val payload = buildPayload(phase, message, current, total)
            lastPayload = payload
            val now = System.currentTimeMillis()
            val prev = lastEmitAtMs
            val phaseChanged = (lastReportedPhase != phase)
            if (phaseChanged || now - prev >= PROGRESS_THROTTLE_MS) {
                lastEmitAtMs = now
                lastReportedPhase = phase
                val env = BridgeEnvelope(
                    kind = "progress",
                    id = requestId,
                    type = requestType,
                    payload = payload,
                )
                sendToWebview(env)
            }
        }

        @Volatile private var lastReportedPhase: String? = null

        private fun buildPayload(
            phase: String?,
            message: String?,
            current: Int?,
            total: Int?,
        ): JsonElement = buildJsonObject {
            if (phase != null) put("phase", JsonPrimitive(phase))
            if (message != null) put("message", JsonPrimitive(message))
            if (current != null) put("current", JsonPrimitive(current))
            if (total != null) put("total", JsonPrimitive(total))
        }

        /**
         * Start a periodic heartbeat that fires until `stop()` is called or
         * [block] completes. Each fire re-emits the latest payload the
         * builder reported through [report], or a fallback phase/message if
         * nothing has been reported yet. The heartbeat exists to cover
         * phases where no per-file report fires (e.g., long-running
         * aggregation) so the webview's inter-message timeout never trips.
         * Runs `block` on the calling thread; the heartbeat runs on a
         * daemon executor.
         */
        fun <T> withHeartbeat(
            intervalMs: Long,
            phase: String,
            initialMessage: String? = null,
            block: () -> T,
        ): T {
            emit(phase, initialMessage)
            val executor = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { r ->
                Thread(r, "unity-index-graph-progress-$requestId").apply { isDaemon = true }
            }
            val fallback = buildPayload(phase, initialMessage, null, null)
            val future = executor.scheduleAtFixedRate(
                { emit(lastPayload ?: fallback) },
                intervalMs,
                intervalMs,
                java.util.concurrent.TimeUnit.MILLISECONDS,
            )
            return try {
                block()
            } finally {
                future.cancel(false)
                executor.shutdownNow()
            }
        }

    }

    private fun sendToWebview(env: BridgeEnvelope) {
        val payloadJson = json.encodeToString(BridgeEnvelope.serializer(), env)
        // CEF's executeJavaScript parses the entire script through V8. On big
        // Unity projects the snapshot JSON is multi-MB; injecting it as a
        // single string literal silently truncates or crashes the renderer
        // (symptom: gray blank panel, no logs). Split into chunks well under
        // any practical V8 source-size cliff and reassemble on the JS side.
        val messageId = env.id ?: "evt-${nextEventId.incrementAndGet()}"
        val total = (payloadJson.length + CHUNK_BYTES - 1) / CHUNK_BYTES
        ApplicationManager.getApplication().invokeLater {
            if (total <= 1) {
                emitChunk(messageId, 0, 1, payloadJson)
                return@invokeLater
            }
            var i = 0
            var offset = 0
            while (offset < payloadJson.length) {
                val end = minOf(offset + CHUNK_BYTES, payloadJson.length)
                emitChunk(messageId, i, total, payloadJson.substring(offset, end))
                offset = end
                i++
            }
        }
    }

    private fun emitChunk(messageId: String, index: Int, total: Int, chunk: String) {
        val idLit = json.encodeToString(String.serializer(), messageId)
        val chunkLit = json.encodeToString(String.serializer(), chunk)
        val script = """
            if (window.unityIndex && typeof window.unityIndex.fromHostChunk === 'function') {
              window.unityIndex.fromHostChunk($idLit, $index, $total, $chunkLit);
            } else if (window.unityIndex && typeof window.unityIndex.fromHost === 'function' && $total === 1) {
              window.unityIndex.fromHost($chunkLit);
            }
        """.trimIndent()
        browser.cefBrowser.executeJavaScript(script, browser.cefBrowser.url, 0)
    }

    companion object {
        private val LOG = logger<GraphHostBridge>()
        // 128 KiB per chunk. Leaves comfortable headroom below CEF/V8's
        // pathological large-source thresholds while keeping the chunk count
        // bounded (a 50 MB payload is ~400 chunks).
        private const val CHUNK_BYTES = 128 * 1024
        // Per-file report throttle. 250ms balances "UI feels live" against
        // "webview isn't drowning in messages" — a 50k-file scan emits
        // ~1 msg/s at this rate.
        private const val PROGRESS_THROTTLE_MS = 250L
        private val nextEventId = java.util.concurrent.atomic.AtomicLong(0)
    }
}
