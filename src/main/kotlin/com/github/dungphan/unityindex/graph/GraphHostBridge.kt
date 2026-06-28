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
            val response = try {
                val payload = GraphHostHandlers.dispatch(env.type, env.payload, project)
                BridgeEnvelope(kind = "response", id = env.id, type = env.type, payload = payload)
            } catch (t: Throwable) {
                LOG.warn("graph: handler for '${env.type}' threw", t)
                BridgeEnvelope(
                    kind = "response",
                    id = env.id,
                    type = env.type,
                    error = BridgeError(t.message ?: t.javaClass.simpleName),
                )
            }
            sendToWebview(response)
        }
    }

    private fun sendToWebview(env: BridgeEnvelope) {
        val payloadJson = json.encodeToString(BridgeEnvelope.serializer(), env)
        // JSON-quote the payload so it survives embedding in a JS string
        // literal without further escaping.
        val jsStringLiteral = json.encodeToString(String.serializer(), payloadJson)
        val script = """
            if (window.unityIndex && typeof window.unityIndex.fromHost === 'function') {
              window.unityIndex.fromHost($jsStringLiteral);
            }
        """.trimIndent()
        ApplicationManager.getApplication().invokeLater {
            browser.cefBrowser.executeJavaScript(script, browser.cefBrowser.url, 0)
        }
    }

    companion object {
        private val LOG = logger<GraphHostBridge>()
    }
}
