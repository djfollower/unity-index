# Unity Index Graph

Visual graph viewer for Unity projects, built on top of the `unity-index` MCP tools. Ships as a webview panel inside both the Rider plugin (`src/`) and the VS Code extension (`vscode-extension/`).

## Design docs (read first)

- [`docs/unity-index-graph-plan.md`](../docs/unity-index-graph-plan.md) — implementation plan, broken into discrete days.
- [`docs/graph-decisions.md`](../docs/graph-decisions.md) — locked tech stack decisions with rationale.
- [`docs/graph-schema.md`](../docs/graph-schema.md) — node/edge taxonomy + symbol ID scheme. The contract everything depends on.
- [`docs/graph-mcp-tools.md`](../docs/graph-mcp-tools.md) — MCP tool surface.

## Layout

```
graph/
  core/            # TS: graph model, builders, query, host-bridge abstraction
  webview/         # Vite + Svelte app: Sigma UI
  rider-bridge/    # Kotlin glue: JCEF webview host + JBCefJSQuery IPC
  vscode-bridge/   # TS glue: VS Code webview host + postMessage IPC
```

The layering is enforced by import discipline:

- `webview/` never imports VS Code or JCEF APIs directly — it sees only the `host-bridge` abstraction from `core/`.
- `core/` has no host-specific code at all.
- `rider-bridge/` and `vscode-bridge/` own everything host-specific and stay thin.

## Status

Day 0 (design contracts) complete. Day 1 (webview skeleton) not yet started.
