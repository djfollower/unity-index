package com.github.dungphan.unityindex.graph

import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBLabel
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import java.awt.BorderLayout
import javax.swing.BorderFactory
import javax.swing.JComponent
import javax.swing.JPanel

class GraphToolWindowFactory : ToolWindowFactory, DumbAware {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val component: JComponent = when {
            !JBCefApp.isSupported() -> unsupportedPanel()
            else -> createBrowserPanel(project, toolWindow.disposable)
                ?: bundleMissingPanel()
        }
        val content = ContentFactory.getInstance().createContent(component, "", false)
        toolWindow.contentManager.addContent(content)
    }

    private fun unsupportedPanel(): JComponent =
        infoPanel(
            "<html><b>JCEF unavailable on this runtime.</b><br/><br/>" +
                "The graph viewer needs an IDE runtime with JCEF enabled.<br/>" +
                "Run <code>Help &rarr; Find Action &rarr; Choose Boot Runtime</code> " +
                "and switch to a JBR with JCEF.</html>",
        )

    private fun bundleMissingPanel(): JComponent =
        infoPanel(
            "<html><b>Graph bundle missing from plugin jar.</b><br/><br/>" +
                "Expected <code>/graph/index.html</code> on the classpath.<br/>" +
                "Rebuild the plugin with <code>./gradlew buildPlugin</code>.</html>",
        )

    private fun infoPanel(html: String): JComponent {
        val panel = JPanel(BorderLayout())
        panel.border = BorderFactory.createEmptyBorder(16, 16, 16, 16)
        panel.add(JBLabel(html), BorderLayout.NORTH)
        return panel
    }

    private fun createBrowserPanel(project: Project, parent: Disposable): JComponent? {
        val html = readBundle() ?: return null

        val browser = JBCefBrowser()
        Disposer.register(parent, browser)

        val bridge = GraphHostBridge(project, browser)
        Disposer.register(parent, bridge)

        // loadHTML sidesteps custom-scheme registration (no public API in
        // 2025.1 to mark a custom scheme as standard for ESM CORS). The
        // bundle is produced by vite-plugin-singlefile so everything is
        // inline — no external asset URLs to resolve. See plan §Day 0.A
        // "Webview asset loading".
        //
        // Inject the bridge stub into <head> BEFORE loadHTML so window.
        // unityIndex exists when the bundle's pickBridge() runs at module
        // load — otherwise the webview falls back to the noop bridge.
        browser.loadHTML(bridge.injectIntoHtml(html))
        return browser.component
    }

    private fun readBundle(): String? {
        val stream = javaClass.getResourceAsStream(BUNDLE_RESOURCE)
        if (stream == null) {
            LOG.warn("graph: $BUNDLE_RESOURCE not found on classpath; did processResources include the bundle?")
            return null
        }
        return stream.bufferedReader(Charsets.UTF_8).use { it.readText() }
    }

    companion object {
        private const val BUNDLE_RESOURCE = "/graph/index.html"
        private val LOG = logger<GraphToolWindowFactory>()
    }
}
