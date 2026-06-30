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

## Performance budgets (Day 7)

Vitest perf tests live alongside the unit tests and gate algorithmic regressions
in the core operations the host watcher fires on every edit burst. Budgets are
set generously (~3× the median observed on a MacBook M-series) so CI runners
don't flake; if you change a budget, document the why in the same commit.

| Operation                                    | Budget | Observed (dev machine) | Test file                                                  |
| -------------------------------------------- | -----: | ---------------------: | ---------------------------------------------------------- |
| `diffSnapshots` — 10k nodes, unchanged       | 200 ms |                  40 ms | `graph/core/src/__tests__/scale.perf.test.ts`              |
| `diffSnapshots` — 10k nodes, 100-file change | 200 ms |                  37 ms | `graph/core/src/__tests__/scale.perf.test.ts`              |
| `buildAdjacency` — 10k / 30k                 | 150 ms |                   3 ms | `graph/core/src/__tests__/scale.perf.test.ts`              |
| `neighbors hop=2` — random seed              |  50 ms |                  <1 ms | `graph/core/src/__tests__/scale.perf.test.ts`              |
| `impact` — random script seed                | 100 ms |                  <1 ms | `graph/core/src/__tests__/scale.perf.test.ts`              |
| `applyDeltaToGraph` — 100-file delta vs 10k  |  10 ms |                  <1 ms | `graph/webview/src/lib/__tests__/applyDelta.perf.test.ts`  |

The synthetic fixture (`graph/core/src/__tests__/scale.fixtures.ts`) generates
a deterministic 10k-node / 30k-edge `GraphSnapshot` modelled after a real Unity
project mix (~55% scripts, ~18% prefabs, ~5% scenes, the rest scriptable objects
and assets) plus the dangling `script_declares_class` tail that Day 2 emits. A
seeded Mulberry32 PRNG drives all picks so the same numbers print run after run.

The disk-walking part of `UnityAssetGraphBuilder` is intentionally NOT covered
here — that path is dominated by VFS / `fs.readFile` latency and benchmarked
manually against real Unity projects.

## Status

Day 7 (incremental updates + perf) complete. See
`docs/unity-index-graph-plan.md` for the rolling status of later days.
