# `graph/rider-bridge`

Kotlin glue between the Rider plugin and the `webview/` bundle. Owns everything JCEF-specific so `webview/` stays host-agnostic.

## What lives here

- **Tool window registration** — registers the graph tool window via `plugin.xml`.
- **JCEF host** — `JBCefBrowser` setup; loads the `webview/dist/` bundle from plugin resources.
- **`HostBridge` implementation (Kotlin side)** — `JBCefJSQuery` for JS→Kotlin, injected `window.unityIndex.fromHost` for Kotlin→JS.
- **In-process MCP routing** — dispatches `unity_graph_*` tool calls to the shared tool registry inside the IDE process.
- **Editor integration** — `FileEditorManager.openFile` on node click (Day 4); navigation to symbols via PSI helpers.

## What does NOT live here

- Graph data model or algorithms — those live in `core/` (TypeScript), consumed by the webview not this module.
- UI components — those live in `webview/`.
- HTTP/SSE transport — that lives in `src/main/kotlin/.../server/`. The bridge bypasses it for in-process calls but the same tool registry is shared.

## Resource layout

The Vite bundle from `graph/webview/dist/` is copied into `src/main/resources/graph/` at build time (Gradle task wired before `processResources`). The JCEF browser loads from there.

## Defensive RD-proxy resolution

Any code in this module that resolves Rider PSI elements MUST reuse the proven fallback chain documented in `CLAUDE.md` (`FindClassTool`, `OptimizedSymbolSearch`, `RiderNavigationProbe`). Do not write a parallel "close-but-not-equal" copy.
