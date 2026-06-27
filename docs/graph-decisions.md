# Unity Index Graph — Tech Stack Decisions

Decision record for the `graph/` module. Day 0.A deliverable from `unity-index-graph-plan.md`.

Format per entry: **Decision** → **Why** → **Alternatives considered** → **Revisit when**. The point of writing these down is that future-us (or a new contributor) doesn't relitigate calls that were already weighed.

Locked: 2026-06-27.

---

## 1. Viz library: **Sigma.js + Graphology**

**Why.**
Sampled a real Unity project (`/Users/dungphan/cbg-client/Assets/AlleyLabs.Game.AnimalDungeon`):

| | Count |
|---|---|
| Scripts (.cs) | 2,329 |
| Prefabs | 3,182 |
| Scenes | 35 |
| ScriptableObjects | 602 |
| Materials | 1,330 |
| Controllers + anims | 536 |
| **File-level subtotal** | **~8,000** |
| Component instances (YAML) | ~310,000 |

This is **one Assets subfolder**. A whole project is 2–4×. File-level nodes alone (~8–32k) sit at the painful edge of Cytoscape.js (smooth ≤3k, painful ≥20k) and squarely inside Sigma's WebGL comfort zone (10–50k smooth, 100k+ fine).

Graphology is the natural pair: clean property-graph data model + bundled algorithms (BFS, shortest path, communities) we need anyway for `unity_graph_impact` / `unity_graph_context` / `unity_graph_query`. Sigma renders; Graphology stores. Clean split.

**Alternatives considered.**
- **Cytoscape.js** — was the original recommendation. Better declarative styling and richer built-in interactions. Demoted after the node-count check: it doesn't survive 8k+ nodes comfortably.
- **D3 force** — maximum flexibility, but every roadmap feature (filter, layout swap, badges, export) hand-rolled. Slow to build, hard to maintain.
- **React Flow** — beautiful defaults, but built for hand-curated node-editor UIs, not discovered graphs of this size.

**Cost we're paying.**
Sigma's lower-level rendering means Days 3–5 (styling, context menus, badges) cost roughly 1.5–2× the UI code Cytoscape would. Acceptable; the alternative is fighting perf forever.

**Revisit when.**
- We commit to a hybrid view (Sigma for the overview, a smaller lib for focused subgraphs <500 nodes) — Cytoscape could come back as the subgraph renderer.
- Sigma's API changes break our adaptation layer enough that maintenance cost outweighs perf benefit.

---

## 2. Shared core language: **TypeScript**

**Why.**
`vscode-extension/` is already TS. The Rider JCEF webview loads the same JS bundle as VS Code's webview, so one TS codebase serves both UIs without duplication. The Kotlin side stays Kotlin; only the *shared* code (graph model, webview UI) is TS.

**Alternatives considered.** None seriously. JavaScript-without-types is a regression. Kotlin/JS adds a build step and ecosystem mismatch for zero gain.

**Revisit when.** Never, realistically.

---

## 3. UI framework: **Svelte**

**Why.**
The Sigma canvas handles the graph itself, but the panel chrome (sidebars, filter UI, search bar, context menus, metadata panels) is plain DOM. Svelte's reactivity model fits Days 5/6/11 (filters, breadcrumbs, saved views) at roughly half the code of React. Compiles away — adds ~15KB runtime vs React's ~45KB.

**Alternatives considered.**
- **React** — safe default, larger ecosystem (Headless UI, etc.), but heavier and more boilerplate for a single-panel UI.
- **Preact** — React API with ~3KB runtime. Genuinely tempting; rejected because Svelte's reactivity ergonomics matter more for the filter-heavy Days 5/6/11.
- **Vanilla TS** — too much DOM bookkeeping for the roadmap. Save the bytes, pay the dev time. Wrong trade.

**Revisit when.**
- We hit a Svelte-specific bug we can't work around.
- A Phase 3+ feature (multi-panel, embedded editor, etc.) makes React's ecosystem advantage worth the bytes.

---

## 4. Build tooling: **Vite**

**Why.**
Standard for webview bundles. Fast dev loop (HMR matters when iterating on graph styling). Simple production output. Native ESM. First-class Svelte support via `@sveltejs/vite-plugin-svelte`. First-class Vitest pairing.

**Output target: ES2022.** Both VS Code webviews (Electron Chromium, ~v124+) and IntelliJ JCEF (CEF/Chromium ~v122+) are modern enough. No transpilation down to older targets needed.

**Alternatives considered.**
- **esbuild directly** — fast, but we'd hand-roll plugin support for Svelte, HMR, CSS handling.
- **Webpack** — more configuration, slower dev loop, no real upside.

**Revisit when.** Vite breaks a tool we depend on, or a future bundling concern (e.g. micro-frontends, plugin loading) isn't well-served.

---

## 5. Package manager: **npm workspaces**

**Why.**
`vscode-extension/` already uses npm. Adding workspaces at the repo root means a single `package-lock.json` and one `npm install` covers all TS packages. Doesn't force contributors to install a new tool.

Workspace members:
- `vscode-extension/`
- `graph/core/`
- `graph/webview/`
- `graph/vscode-bridge/`

The Kotlin (`src/`) and Rider bridge (`graph/rider-bridge/`) stay outside npm — managed by Gradle.

**Alternatives considered.**
- **pnpm workspaces** — faster install, stricter dependency resolution. Rejected: adds a tool install step for every contributor for marginal gain at our scale.
- **yarn** — same as pnpm rationale, plus the v1/v2/berry split is its own headache.
- **Standalone packages with `file:` references** — works in tiny projects, fragile when cross-package imports compose.

**Revisit when.**
- Install times become a real bottleneck (we're shipping many more workspace packages).
- A pnpm-only tool we need refuses to work under npm.

---

## 6. Module format: **ESM in webview, CJS in extension host**

**Why.**
- The webview bundle is loaded by the browser-equivalent runtime (Electron/JCEF). ESM is native.
- VS Code extensions are loaded by Node's CJS module system. Switching to ESM is possible (with `"type": "module"`) but adds friction for marginal gain in our setup.

Strict rule: don't mix. `graph/core/` exports both via `package.json#exports`; consumers pick the right one.

**Alternatives considered.**
- **ESM everywhere.** Cleaner long-term, but VS Code's ESM-extension support is still maturing and adds startup quirks. Defer.
- **CJS everywhere.** Forces awkward bundling for the webview side. No.

**Revisit when.** VS Code's ESM extension story stabilizes and other extensions we look at have switched.

---

## 7. Versioning: **all `graph/*` packages private, mirrored to `pluginVersion`**

**Why.**
CLAUDE.md mandates `gradle.properties.pluginVersion` and `vscode-extension/package.json#version` move together. The `graph/*` workspace packages must mirror the same number so the shipped bundle versions are coherent across the Rider zip, the VSIX, and any future inspection.

Every `graph/*` `package.json` carries `"private": true`. We don't publish to npm; the packages exist for workspace tooling only.

**Alternatives considered.**
- **Independent semver per package.** Adds a release matrix to maintain for zero user benefit (no external consumer).
- **Publish to npm.** Out of scope; the artifact users care about is the IDE extension, not standalone packages.

**Revisit when.** A package becomes genuinely standalone (e.g. someone wants to consume `graph/core/` outside our extensions).

---

## 8. Folder layout

```
graph/
  core/            # TS: graph model, builders, query, host-bridge abstraction
  webview/         # Vite + Svelte app: Sigma UI
  rider-bridge/    # Kotlin glue: JCEF webview host + JBCefJSQuery IPC
  vscode-bridge/   # TS glue: VS Code webview host + postMessage IPC
```

**Why.**
- `core/` is the only place graph types live. Both bridges and the webview import from it.
- `webview/` is host-agnostic — never imports VS Code or JCEF APIs directly.
- Bridges own host-specific code and stay thin.

**Alternatives considered.**
- **Flat `graph/`** with no subdivision. Fine until the first bridge file leaks a `vscode` import into the webview. Subdivision is the cheapest way to enforce the layering.
- **Top-level repo folders (`webview/`, `bridges/`)** instead of nested under `graph/`. Rejected: `CLAUDE.md` already partitions by deliverable (`src/` = Rider, `vscode-extension/` = VS Code). A single `graph/` folder is the third sibling, parallel and discoverable.

**Revisit when.** A second graph view (e.g. a CLI dump or standalone web app) ships. Then `webview/` becomes one of multiple consumers and may move up a level.

---

## 9. Webview ↔ host bridge: **abstraction in `graph/core/host-bridge.ts`**

**Why.**
The webview must talk to two different host APIs:
- VS Code: `acquireVsCodeApi()` + `window.addEventListener('message')`
- Rider JCEF: `JBCefJSQuery` for JS→Kotlin, injected `window.unityIndex.fromHost` for Kotlin→JS

A single interface (`postToHost(msg)`, `onFromHost(handler)`) is implemented twice. Svelte components never import either API directly — they see only the abstraction.

**MCP routing is in-process.** Both bridges call the local MCP tool registry directly inside the extension host process. External MCP clients (Claude Code, agent runners) still use the HTTP/SSE surface. The wire shape is identical either way — same JSON-RPC tool calls, same response schemas.

**Why in-process for the webview.**
- Avoids the JSON-RPC parse/serialize overhead on the hot path.
- No port management ("what if 29170 is taken?") inside the extension's own UI.
- The bridge code runs in the same process as the tool registry already.

**Alternatives considered.**
- **Webview calls HTTP/SSE like external clients.** Symmetrical, but pays serialization cost twice for no benefit when both sides are in the same process.
- **Direct host imports in the webview.** Couples Svelte components to VS Code and JCEF APIs. Doubles UI code. Rejected.

**Revisit when.**
- The bridge surface grows past ~10 methods (then it's worth a code generator).
- A third host (CLI, standalone web app) arrives — at which point the abstraction's been validated by use.

---

## 10. Asset pipeline into shipped artifacts

**Why.**
The Vite output (`graph/webview/dist/`) must land inside both shipped artifacts. The mechanism is:

- **VS Code**: `vscode-extension/scripts/package.js` extended to copy `graph/webview/dist/` into `vscode-extension/dist/graph/` before invoking `vsce package`. Lands in the VSIX.
- **Rider**: a Gradle task wired before `processResources` copies `graph/webview/dist/` into `src/main/resources/graph/`. Lands in the plugin zip.

Both happen as side effects of the existing build commands documented in `CLAUDE.md` (`./gradlew buildPlugin`, `npm run package`). Contributors don't learn new commands.

**Alternatives considered.**
- **Manual copy step.** Will be forgotten. No.
- **Symlinks.** Break on Windows contributors.
- **Two separate build artifacts.** Doubles disk and confuses the lockstep version contract.

**Revisit when.** Build outputs diverge meaningfully (e.g. Rider needs a different bundle target than VS Code). Not foreseen.

---

## 11. Testing: **Vitest on `graph/core/` only**

**Why.**
`graph/core/` has non-trivial logic that warrants tests from Day 2 onwards: URI parsing for the symbol ID scheme, GUID resolution, edge dedup, snapshot building, BFS/impact algorithms via Graphology. Vitest is Vite-native — near-zero config given we're already on Vite.

UI tests (Svelte, Sigma rendering) are deferred to Day 14 polish. Visual graph code is hard to assert against, and the manual feedback loop in JCEF/VS Code is fast enough during development.

The existing Kotlin and VS Code extension code stays as-is (no new test framework imposed). New MCP tools on either side get integration tests within their respective existing test setups, if any.

**Alternatives considered.**
- **Jest.** More common, more config for Vite integration. No benefit for our scope.
- **No tests.** Tempting for a small module. Rejected: the ID scheme is load-bearing per `graph-schema.md` and silent breakage is unacceptable.
- **Playwright on the webview.** Overkill at Phase 1. Reconsider at Day 14 if real users hit visual regressions.

**Revisit when.** Day 14 — add Playwright if visual regressions warrant it.

---

## 12. Browser/runtime target: **ES2022**

**Why.**
- VS Code webviews run Electron Chromium — currently v124+ depending on user's VS Code version. Modern.
- IntelliJ JCEF — CEF v122+ in IntelliJ Platform 2024.x. Modern.
- Both support ES2022 features (top-level await, error cause, regex match indices, class fields). Targeting older means hand-rolling polyfills for nothing.

Set in `vite.config.ts`: `build.target: 'es2022'`.

**Alternatives considered.**
- **ES2020 / ES2017** — conservative defaults. Unnecessary; both hosts moved on.
- **ESNext** — moves with TypeScript; risks shipping features the runtime doesn't support yet. Stick to a pinned target.

**Revisit when.** ES2024+ features become genuinely useful (e.g. native record/tuple support) and both hosts ship the runtime.

---

## 13. Bundle size budget: **≤500KB gzipped initial, 1MB hard ceiling**

**Why.**
JCEF and VS Code webviews both fetch the bundle on panel open. A multi-MB bundle has visible startup latency on cold open. Sigma (~150KB) + Graphology (~50KB) + Svelte runtime (~15KB) + our code at ~200KB leaves headroom inside 500KB.

If we drift past 1MB, something is wrong — likely culprit: shipping a CSS framework (don't), or embedding a heavyweight query DSL parser (defer to a separate chunk via dynamic import).

**Alternatives considered.**
- **No budget.** Bundles grow silently until users complain.
- **Stricter (≤250KB).** Forces us to forgo Svelte and write vanilla — already rejected in §3.

**Revisit when.** The webview takes >500ms to render on a representative machine, or measured bundle size exceeds 1MB.

---

## 14. Logging + debugging

**Why.**
Default webview `console.*` output is invisible in production. For development we want it surfaced.

- **Dev mode**: webview `console.*` calls are piped to the extension's output channel.
  - VS Code: dedicated output channel `Unity Index Graph`.
  - Rider: piped to `idea.log` via a `JBCefBrowser` console listener.
- **Source maps**: shipped in dev, stripped in prod.
- **Prod**: console output dropped at build time (Vite's `define` + `drop_console`). No telemetry, no remote logging.

Consistent with Day 14's "log nothing" stance for shipped artifacts.

**Alternatives considered.**
- **Remote error reporting** (Sentry, etc.) — rejected; we don't collect telemetry.
- **Always-on console.** Fine in dev, noisy and potentially leaky in prod.

**Revisit when.** Users report bugs we can't reproduce without remote logs. Then opt-in diagnostics, not always-on telemetry.

---

## Quick-reference summary

| Area | Choice |
|---|---|
| Viz library | Sigma.js + Graphology |
| Language | TypeScript |
| UI framework | Svelte |
| Build tool | Vite (target ES2022) |
| Package manager | npm workspaces |
| Module format | ESM in webview, CJS in extension host |
| Versioning | `private: true`, mirrored to `pluginVersion` |
| Folder layout | `graph/{core,webview,rider-bridge,vscode-bridge}` |
| Webview ↔ host | Abstraction in `graph/core/host-bridge.ts`, in-process MCP |
| Asset pipeline | Vite output copied into VSIX + Rider zip via existing build commands |
| Testing | Vitest on `graph/core/` only; UI tests deferred to Day 14 |
| Bundle budget | ≤500KB gzipped, 1MB ceiling |
| Logging | Dev pipes console to extension output; prod drops |
