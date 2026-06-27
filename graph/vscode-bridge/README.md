# `graph/vscode-bridge`

TypeScript glue between the VS Code extension host and the `webview/` bundle. Owns everything VS Code–specific so `webview/` stays host-agnostic.

## What lives here

- **Webview panel registration** — declares `unityIndex.graph` as a webview view; loads the `webview/dist/` bundle.
- **`HostBridge` implementation (VS Code side)** — wraps `webview.postMessage` and `webview.onDidReceiveMessage` to satisfy the interface declared in `core/`.
- **In-process MCP routing** — dispatches `unity_graph_*` tool calls to the local tool registry inside the extension host process. No HTTP round-trip.
- **Editor integration** — opens files in the editor on node click (Day 4); shows nodes in explorer on context menu.

## What does NOT live here

- Graph data model or algorithms — those live in `core/`.
- UI components — those live in `webview/`.
- HTTP/SSE transport — that lives in `vscode-extension/src/server/`. The bridge bypasses it for in-process calls but the same tool registry is shared.

## Consumed by

`vscode-extension/` imports this package to wire up the graph panel during activation.
