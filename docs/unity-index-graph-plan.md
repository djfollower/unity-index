# Unity Index Graph — Implementation Plan

Visual graph viewer for Unity projects, built on top of `unity-index` MCP tools. Lives in a new `graph/` folder in this repo, shipped as a webview panel inside both the Rider plugin and the VS Code extension.

**Design choices already locked:**
- Webview inside both extensions (not a standalone web app).
- Unity asset graph first; C# semantic edges in Phase 2.
- In-memory graph store (no SQLite cache until proven necessary).
- Same repo as the existing Rider plugin + VS Code extension; stays in lockstep per `CLAUDE.md`.

All features below are in scope. Days are **discrete milestones**, not calendar days — each is shippable on its own. Soft dependencies between days are noted.

---

## Day 0 — Design contracts to lock before code

Three tracks. No implementation. Each produces a doc that later days build against.

### Day 0.A — Tech stack decisions

**Deliverable:** `docs/graph-decisions.md` recording every choice below.

#### Rendering + data model
- **Viz library: Sigma.js + Graphology.** Real Unity projects produce ~8–13k file-level nodes per Assets subfolder and ~310k component instances (sampled from `cbg-client/Assets/AlleyLabs.Game.AnimalDungeon`: 2.3k scripts, 3.2k prefabs, 35 scenes, 600 SOs, 1.3k materials, 150k component instances in prefabs, 160k in scenes). That puts us in Sigma's WebGL comfort zone (10–50k smooth, 100k+ fine) and past Cytoscape's (smooth ≤3k, painful ≥20k). Graphology bundles a clean graph data model + algorithms (BFS, shortest path, communities) we need for `impact` / `context` queries anyway. Cost: lower-level rendering API, so custom node shapes, context menus, and badges in Days 3–5 cost ~1.5–2× the UI code Cytoscape would. Worth it.

#### Language + UI framework
- **Shared core language: TypeScript.** Already the language of `vscode-extension/`. Rider's JCEF webview loads the same JS bundle, so one TS codebase serves both UIs.
- **UI framework: Svelte.** ~15KB runtime, compiles away, reactivity model fits Days 5/6/11 (filters, breadcrumbs, saved views) at roughly half the code of React. React was the safe default; Svelte wins on bundle size and ergonomics for a single-panel UI. Vanilla TS rejected — too much DOM bookkeeping for the roadmap.

#### Build + module setup
- **Build tooling: Vite.** Standard for webview bundles, fast dev loop, simple production output. Vite output target pinned to **ES2022** (both VS Code webviews and IntelliJ JCEF run modern Chromium). Vite `base: './'` is mandatory — both hosts serve the bundle from a non-root path (VS Code: `vscode-webview://…/dist/graph/`, Rider: `unityindex://graph/`) and absolute `/assets/...` paths break under both.
- **Package manager: npm workspaces.** Root `package.json` with workspaces for `vscode-extension/`, `graph/core/`, `graph/webview/`. Single `package-lock.json`. Minimizes churn against existing `vscode-extension/` setup. pnpm was tempting but adds a new tool to install.
  - **`graph/rider-bridge/` and `graph/vscode-bridge/` are deliberately NOT npm workspace packages.** They are plain source dirs imported directly by the extensions. Reason: vsce + npm-workspace symlinks interact badly (vsce historically skips or fails on symlinked `node_modules/` entries), and the blessed monorepo fix — bundling the extension with esbuild + `vsce package --no-dependencies` — is out of scope for the Day 1 "open a panel" milestone. Revisit if/when a bridge grows real npm dependencies.
- **Module format.** Webview bundle stays ESM (browser runtime). Extension host code stays CJS (VS Code extension convention). Don't mix.
- **Versioning.** All `graph/*` packages marked `"private": true`; version field stays mirrored to `gradle.properties.pluginVersion` via the same convention the existing `vscode-extension/package.json` already follows. Never published to npm.

#### Folder layout
```
graph/
  core/            # TS: graph model, builders, query, host-bridge abstraction
  webview/         # Vite + Svelte app: Sigma UI
  rider-bridge/    # Kotlin glue: JCEF webview host + JBCefJSQuery IPC
  vscode-bridge/   # TS glue: VS Code webview host + postMessage IPC
```

#### Webview ↔ host bridge
- **Abstraction in `graph/core/host-bridge.ts`.** Single interface (`postToHost`, `onFromHost`) implemented twice: VS Code (`acquireVsCodeApi` + `window.message`) and Rider (`JBCefJSQuery` for JS→Kotlin, injected `window.unityIndex.fromHost` for Kotlin→JS). The webview Svelte code never imports either directly — it sees only the abstraction.
- **MCP routing in-process.** Both bridges call the local MCP tool registry directly inside the extension host process rather than going back over HTTP/SSE. External MCP clients (e.g. Claude Code) still use the HTTP route; the wire shape is identical.

#### Webview asset loading (per host)
- **VS Code: `asWebviewUri` + CSP-injecting HTML transformer.** The shipped `index.html` cannot be served verbatim — VS Code webviews enforce CSP and require resource URIs to be rewritten through `webview.asWebviewUri(...)`. `graph/vscode-bridge/` owns a small HTML transformer (run at panel-load time) that:
  - rewrites every `src=` / `href=` to the `webview.asWebviewUri` form,
  - injects a `<meta http-equiv="Content-Security-Policy">` tag with `default-src 'none'; script-src ${cspSource}; style-src ${cspSource}; img-src ${cspSource} data: blob:; font-src ${cspSource}; connect-src ${cspSource}; worker-src ${cspSource} blob:;` (the `data:` allowance is required by Sigma's canvas sprite atlas; `worker-src blob:` is pre-emptive for Day 7's layout worker).
  - The webview never loads remote origins — `connect-src` deliberately omits `https:`.
- **Rider: custom JCEF scheme handler.** Loading the bundle via `jar:file://` does NOT work — `jar:` URLs are opaque-origin in Chromium and ESM module loading fails CORS. Instead, `graph/rider-bridge/` registers a `JBCefApp.getInstance().registerSchemeHandlerFactory("unityindex", "graph", …)` at plugin startup that streams resources out of the classloader (`getResourceAsStream("/graph/...")`). The browser loads `unityindex://graph/index.html`, sees a normal HTTP-like origin, and ESM + relative imports + CSP behave like in any browser.
  - Must guard with `JBCefApp.isSupported()`; older JetBrains Runtimes without JCEF show a friendly "JCEF unavailable" message in the tool window instead of crashing.

#### Asset pipeline into shipped artifacts
- **Vite output** → `graph/webview/dist/` (with `base: './'` so all asset paths are relative).
- **VS Code build** copies it into `vscode-extension/dist/graph/` as part of `npm run package` (extend `vscode-extension/scripts/package.js`). Lands in the VSIX.
- **Rider build** copies it into `src/main/resources/graph/` as a Gradle task wired before `processResources`. Lands in the plugin zip and is served by the custom scheme handler at runtime.
- Build commands stay as documented in `CLAUDE.md` (`./gradlew buildPlugin`, `npm run package`) — they pull the bundle implicitly.

#### Testing
- **Vitest** for `graph/core/`. Vite-native, zero-config given the build tool. Covers GUID resolution, ID parsing, edge dedup, snapshot building. UI tests deferred — visual graph code is hard to assert against and Day 14 polish is the right time.
- The Rider and VS Code extension code remains as-is for testing (no new framework imposed).

#### Bundle budget
- Target **initial JS bundle ≤500KB gzipped**. Sigma (~150KB) + Graphology (~50KB) + Svelte runtime (~15KB) + our code leaves headroom.
- Hard ceiling 1MB. If we drift past, revisit (likely culprit: shipping a CSS framework or a query DSL parser).

#### Logging + debugging
- **Dev mode**: webview `console.*` piped to the extension's output channel (VS Code: dedicated channel; Rider: idea.log via a JBCef console listener). Source maps shipped.
- **Prod**: source maps stripped, console output dropped. No telemetry, no remote logging — consistent with Day 14's "log nothing."

### Day 0.B — Graph schema design

**Deliverable:** `docs/graph-schema.md`. The contract every later day depends on.

- **Node taxonomy** — enumerate every node kind across Phase 1 + 2 up front:
  - Assets (file-level, always rendered): `script_file`, `prefab`, `scene`, `scriptable_object`, `asset` (catch-all: materials, textures, audio, shaders, animations, controllers), `addressable_group` (if used).
  - Code: `namespace`, `class`, `interface`, `struct`, `enum`, `method`, `property`, `field`.
  - **Sub-file kinds (never rendered as top-level nodes)**: `component_instance`, `serialized_field`. Sampled volume is ~310k component instances in a single Assets subfolder — orders of magnitude more than file nodes. These are represented as **edge metadata** by default (e.g. a `prefab_uses_script` edge carries a count + list of component instance IDs) and only materialize as nodes inside an **expand-on-demand** subgraph view when a user focuses a single prefab/scene. The schema doc must spell out this dual representation explicitly.
- **Edge taxonomy** — direction + cardinality semantics for each. Edges carry counts + lists of underlying `component_instance` / `serialized_field` IDs so the sub-file detail is preserved without rendering it:
  - Asset: `prefab_uses_script` (with component instance list), `scene_contains_prefab`, `scene_references_script` (with component instance list), `serialized_field_binds_to` (aggregated per file pair), `guid_resolves_to`, `prefab_variant_of`.
  - Code: `class_inherits_from`, `class_implements_interface`, `method_calls_method`, `class_references_class`, `method_overrides_method`.
  - Cross-domain: `script_used_by_prefab` and `script_used_by_scene` — the bridges that unify asset and code graphs at the file level (no `component_instance_of_script` at top level since component instances aren't top-level nodes).
- **Symbol ID scheme** — the load-bearing decision. A script's node ID must be identical whether it came from the YAML harvest or from Roslyn, or edges will dangle. Options:
  - Roslyn `DocumentationCommentId` for code (`T:Foo.Bar`, `M:Foo.Bar.Baz(System.Int32)`) + Unity GUID for assets.
  - Custom URI scheme (`unity://script/Assets/Foo.cs#Bar.Baz`).
  - Mix: GUID for assets, FQN for code, with a documented bridging rule.
- **Reference kinds** — edge subtypes (e.g. `method_calls_method` with `kind: virtual | direct | interface`).
- **Metadata schema** — what fields live on nodes vs edges (file path, line, last-modified, diagnostic count, …).

### Day 0.C — MCP tool surface design

**Deliverable:** `docs/graph-mcp-tools.md`. Inspired by GitNexus's `query` / `impact` / `context`, adapted to our `unity_*` naming.

- `unity_graph_snapshot` — full asset graph dump (Phase 1).
- `unity_graph_neighbors` — N-hop neighborhood of a node ID.
- `unity_graph_impact` — everything downstream of a node (delete-blast-radius).
- `unity_graph_context` — node + 1-hop neighborhood + metadata, optimized for agent prompts.
- `unity_graph_query` — DSL query against the graph (Day 12).
- `unity_graph_code_edges` — batch C# edge lookup for N symbols (Phase 2 batch API).

Lock input/output schemas, error envelopes, and which tools are Phase 1 vs Phase 2. Day 2 implements `snapshot`, Day 6 implements `impact` / `context` / `neighbors`, Day 8 adds `code_edges`, Day 12 adds `query`.

---

## Day 1 — Webview skeleton in both extensions

**Goal:** an empty panel opens in Rider and VS Code, shows a hardcoded "hello graph" with 3 nodes via **Sigma.js + Graphology** (per Day 0.A — supersedes earlier Cytoscape mentions in this section).

- Root `package.json` declares npm workspaces `["vscode-extension", "graph/core", "graph/webview"]`. `graph/rider-bridge/` and `graph/vscode-bridge/` stay as plain source dirs (see Day 0.A package-manager note).
- `graph/core/`: `host-bridge.ts` interface + shared message types. No host code.
- `graph/webview/`: Vite + Svelte + Sigma + Graphology, `base: './'`, renders 3 hardcoded nodes + 2 edges. Bridge implementation picked at boot by sniffing `acquireVsCodeApi` vs `window.unityIndex`.
- VS Code:
  - Register `unityIndex.graph` webview view in sidebar + `unityIndex.openGraph` command.
  - Implement the **CSP-injecting HTML transformer** in `graph/vscode-bridge/` (see Day 0.A "Webview asset loading"). The transformer is a Day 1 deliverable, not an afterthought — without it the bundle won't load.
  - Extend `vscode-extension/scripts/package.js` to build `graph/webview` and copy `dist/` into `vscode-extension/dist/graph/` before VSIX assembly.
- Rider:
  - Register tool window in `plugin.xml` (right anchor).
  - Implement the **custom JCEF scheme handler** (`unityindex://graph/`) in `graph/rider-bridge/`, registered at plugin startup, streaming from the classloader (see Day 0.A). Guard with `JBCefApp.isSupported()`; fall back to a friendly message in the tool window when JCEF is missing.
  - Gradle task `copyGraphBundle` runs `npm -w graph/webview run build` and copies the dist into `src/main/resources/graph/`; wire as a `processResources` dependency.
- Webview ↔ extension postMessage bridge (TS) and JS↔Kotlin bridge (Rider), both implementing `host-bridge.ts`. Round-trip a "hello" message on mount to prove the bridge end-to-end before declaring Day 1 done.
- Lockstep version bump: `gradle.properties#pluginVersion` and `vscode-extension/package.json#version` together; mirror the same version into new `graph/*` package.json files.

**Dependency:** none. **Validates:** webview plumbing + lockstep build pipeline.

---

## Day 2 — Asset graph data model + MCP harvest tool

**Goal:** a new MCP tool returns the full Unity asset graph in one call.

- New tool `unity_graph_snapshot` in both `tools/unity/` folders:
  - Returns `{ nodes: [...], edges: [...] }`.
  - Node kinds: `script`, `prefab`, `scene`, `scriptable_object`, `asset`, `component_instance`.
  - Edge kinds: `prefab_uses_script`, `scene_contains_prefab`, `scene_contains_component`, `serialized_field_binds`, `guid_resolves_to`.
- Reuses existing `UnityYamlParser` + `UnityAssetIndex` on both sides.
- Schema documented in `docs/mcp-tools.md` (or wherever the tool wire format lives).

**Dependency:** none (independent of Day 1). **Validates:** MCP contract for graph data.

---

## Day 3 — Real asset graph rendering

**Goal:** open the panel, see your actual project as a graph.

- Webview calls `unity_graph_snapshot` on open.
- Force-directed layout (Cytoscape `fcose` or `cola`).
- Node styling per kind (icon + color).
- Edge styling per kind (color + arrowhead).
- Pan, zoom, drag, select.
- Loading + empty states.

**Dependency:** Days 1, 2.

---

## Day 4 — Click-through to IDE

**Goal:** the graph is *useful*, not just pretty.

- Single-click node → highlight + show metadata panel (file path, GUID, refs).
- Double-click node → open file in editor at the right line.
  - VS Code: `vscode.window.showTextDocument`.
  - Rider: `FileEditorManager.openFile`.
- Right-click → context menu: "Find usages" (delegates to `FindUsagesTool`), "Reveal in explorer", "Copy GUID".

**Dependency:** Day 3.

---

## Day 5 — Filter + search

- Type filter sidebar (toggle script/prefab/scene visibility).
- Fuzzy name search bar; matched nodes highlighted, others faded.
- Filter state persists per workspace.

**Dependency:** Day 3.

---

## Day 6 — Subgraph navigation

- "Focus on this node" → show only N-hop neighborhood.
- Breadcrumb of focused nodes.
- "Reset to full graph" button.
- "Show impact" → everything downstream of a script (which prefabs/scenes break if it's deleted).

**Dependency:** Day 3.

---

## Day 7 — Incremental updates + perf

- Watch Unity asset directory; on change, recompute affected edges only.
- Debounce + throttle.
- Cytoscape layout in a web worker for large graphs.
- Virtualization / level-of-detail when zoomed out (cluster nodes by folder).

**Dependency:** Days 3, 6. **First "scale matters" milestone.**

---

## Day 8 — C# semantic edges (Phase 2 begins)

**Goal:** add code edges on top of asset edges.

- Extend `unity_graph_snapshot` (or add `unity_graph_code_edges`) to return:
  - `class_inherits_from`
  - `method_calls_method`
  - `class_references_class`
- Sourced from existing `FindUsagesTool`, `TypeHierarchyTool`, `CallHierarchyTool`.
- **Batch endpoint** on unity-index: take N symbols, return all edges. Critical or the round-trips kill perf on 30k-file projects.
- Lazy expansion in UI: don't render all code edges on open; expand per class.

**Dependency:** Day 3. **Real engineering — needs the batch API discussed in `gitnexus-integration.md`.**

---

## Day 9 — Combined view + C# polish

- Toggle: assets-only / code-only / combined.
- Inheritance arrows visually distinct from call arrows.
- "Show MonoBehaviour subclasses" preset.
- Cross-domain edges highlighted (e.g. a prefab → script → base class chain).

**Dependency:** Day 8.

---

## Day 10 — Diagnostics overlay

- `GetDiagnosticsTool` results become node badges (error/warning counts).
- Optional heatmap mode: node size by reference count, color by diagnostic severity.
- Filter: "show only nodes with errors."

**Dependency:** Day 8.

---

## Day 11 — Saved views + export

- Bookmark current filter/focus/layout as a named view.
- Export PNG / SVG of current viewport.
- Export full graph as JSON.
- Import JSON for offline browsing or sharing in PR reviews.

**Dependency:** Days 3, 5, 6.

---

## Day 12 — Query DSL

**Goal:** answer questions the canned UI can't.

- Query bar accepting a small DSL (e.g. `prefabs WHERE uses(script:PlayerController)`).
- Pre-built queries:
  - "unused prefabs" (no scene references)
  - "scripts not in any scene"
  - "MonoBehaviours with no `[SerializeField]`"
  - "circular type dependencies"
- Decide: roll our own DSL, or embed a Cypher subset library.

**Dependency:** Days 2, 8.

---

## Day 13 — Monorepo + multi-project

- Project selector if workspace has multiple `.sln`s.
- Cross-project edges rendered with project-boundary styling.
- Per-project filtering.

**Dependency:** Day 8.

---

## Day 14 — Packaging, docs, polish

- Vite bundle output included in both `build/distributions/` artifacts.
- README screenshots + walkthrough.
- Quickstart in `docs/graph.md`.
- Telemetry-free analytics: log nothing.
- Final lockstep version bump.

**Dependency:** whatever ships.

---

## Cross-cutting concerns (bake in throughout, not separate days)

- **Lockstep with CLAUDE.md.** Every tool/schema change lands in both Kotlin and TS in the same commit.
- **No text-search fallbacks** — graph edges come from semantic tools or YAML parsing, never grep.
- **Defensive RD-proxy handling** when reading C# symbols from Rider (existing `FindClassTool` patterns).
- **In-memory only** until real users hit real slowness.

---

## Suggested order (if you want a default)

Foundation pack: **1 → 2 → 3 → 4**. After Day 4 you have a usable Unity asset graph with click-through. Everything after that is enrichment.
