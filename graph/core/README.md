# `graph/core`

Host-agnostic TypeScript: the graph data model, builders, query, and the webview ↔ host bridge abstraction. Imported by `webview/` and `vscode-bridge/`.

## What lives here

- **Schema types** (`GraphNode`, `GraphEdge`, `GraphSnapshot`, `NodeKind`, `EdgeKind`) — the canonical TS shape from [`docs/graph-schema.md`](../../docs/graph-schema.md).
- **Symbol ID utilities** — `unity://` URI parsing, construction, the script ↔ class bridge resolver.
- **Graph builders** — assemble a `GraphSnapshot` from MCP tool responses; dedup edges; aggregate sub-file detail (component instances, serialized fields) into edge metadata.
- **Graph algorithms** — BFS, impact (reverse-reachable closure), neighborhood extraction. Backed by Graphology.
- **Host bridge interface** — `HostBridge` (`postToHost`, `onFromHost`) implemented twice (in `vscode-bridge/` and `rider-bridge/`'s JS side).
- **Query DSL** (Phase 2 / Day 12) — parser + evaluator.

## What does NOT live here

- Host APIs (no `import vscode from 'vscode'`, no JCEF references).
- Sigma rendering or Svelte components — those live in `webview/`.
- MCP transport — `core` consumes MCP tool *responses*, doesn't speak the wire protocol.
