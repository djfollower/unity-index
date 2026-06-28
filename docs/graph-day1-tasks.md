# Day 1 — Task breakdown

Source: [`unity-index-graph-plan.md`](unity-index-graph-plan.md) §Day 1.

**Day 1 goal:** an empty panel opens in Rider and VS Code, shows a hardcoded "hello graph" with 3 nodes via Sigma.js + Graphology (per Day 0.A — supersedes the Cytoscape mention in the plan's older Day 1 prose).

Stack reminder (locked in `graph-decisions.md`): TypeScript + Svelte + Sigma + Graphology + Vite, ES2022 target, `base: './'` mandatory.

---

## Task 1 — Workspace plumbing

Add root npm workspaces so `graph/core/` and `graph/webview/` can share a single install with `vscode-extension/`.

- Add root `package.json` declaring `"workspaces": ["vscode-extension", "graph/core", "graph/webview"]`. `"private": true`, no `dependencies`/`devDependencies` at the root.
- Create stub `package.json` files in `graph/core/` and `graph/webview/` (private, version mirrored from `gradle.properties#pluginVersion`) so the workspace member globs resolve.
- Delete `vscode-extension/package-lock.json` and `vscode-extension/node_modules/`.
- Run `npm install` from the repo root. Verify a single `package-lock.json` lands at the root and `vscode-extension/` has a symlinked `node_modules/.bin/tsc`.
- Verify `vscode-extension` still builds: `npm -w vscode-extension run compile` and `npm -w vscode-extension run package`. The packager spawns `npx vsce` — npm workspaces should still resolve it via hoisted bins.

**vsce flag:** `vscode-extension/scripts/package.js` now passes `--no-dependencies` to `vsce package`. Under npm workspaces, vsce's dependency walk reaches into the hoisted root `node_modules/` and produces paths like `../settings.gradle.kts` that crash packaging. The extension has zero runtime npm deps (only `vscode` from the host + Node built-ins), so `--no-dependencies` is correct today. If a real runtime dep is ever added, switch to bundling (esbuild) and keep the flag.

**Out of scope:** esbuild. Reserved for the day a bridge grows real npm deps.

**Note on bridges:** `graph/rider-bridge/` and `graph/vscode-bridge/` are NOT workspace packages (see Day 0.A package-manager bullet). They stay as plain source dirs. No `package.json` for either on Day 1.

---

## Task 2 — `graph/core/` host-bridge contract

Set up the package that defines the webview ↔ host wire shape.

- `package.json`: TS, ESM (`"type": "module"`), private.
- `tsconfig.json`: target ES2022, module `ESNext`, `moduleResolution: bundler`, `strict: true`, `declaration: true`, `outDir: dist`.
- `src/host-bridge.ts`: export the `HostBridge` interface (`postToHost(msg)`, `onFromHost(handler)`) plus shared message types — at minimum a `HelloGraphRequest` / `HelloGraphResponse` pair so Day 1 can prove the round-trip.
- `src/index.ts`: re-export the public surface.
- Vitest config stub (no tests yet — keeps Day 2 from having to add it under deadline).

---

## Task 3 — `graph/webview/` Vite + Svelte + Sigma app

Standalone webview app that boots and renders 3 hardcoded nodes.

- `package.json`: depends on `sigma`, `graphology`, `svelte`. Dev deps: `vite`, `@sveltejs/vite-plugin-svelte`, `typescript`, `svelte-check`.
- `vite.config.ts`: Svelte plugin, `base: './'`, `build.target: 'es2022'`, single-page output to `dist/`.
- `index.html`: minimal shell with `<div id="app">`.
- `src/main.ts`: mounts `App.svelte`.
- `src/App.svelte`: on mount, creates a Graphology graph with 3 hardcoded nodes + 2 edges and renders via Sigma into a `<div>`.
- `src/bridge/vscode.ts` + `src/bridge/rider.ts`: both implement `HostBridge` from `graph/core`. Pick the right one at boot by sniffing `acquireVsCodeApi` vs `window.unityIndex`.
- On mount, fire a `HelloGraphRequest` through the bridge and log the response — proves the bridge before the extensions even render real data.
- Smoke test: `npm -w graph/webview run dev` opens a browser at `localhost:5173` and shows the 3 nodes (no host wired yet; the bridge call will fall through to a noop).

---

## Task 4 — VS Code extension wiring (bridge lives in `vscode-extension/src/graphHost/`)

**Deviation from the Day-0 folder layout.** The plan placed the host-side bridge code in `graph/vscode-bridge/`, but the extension's `tsconfig.json` has `"rootDir": "src"` and tsc refuses to compile files outside it. Workarounds (relaxing `rootDir` → ugly `dist/` shape; TS project references → heavy for Day 1) weren't worth it for three small files. The bridge now lives in `vscode-extension/src/graphHost/` and `graph/vscode-bridge/` keeps only its README as a placeholder. Easy to refactor back once a real reason appears.

Naming: `graphHost/` (not `graph/`) avoids colliding with the webview bundle copied into `dist/graph/` at package time.

graph-core is imported **types only** by the host. graph-core ships ESM (`"type": "module"`) and the extension is CJS — full runtime interop would need a dual ESM/CJS build. Wire strings (e.g. `'unity_graph_hello'`) are inlined in `hostHandlers.ts` with a back-reference comment to `graph/core/src/messages.ts`. Drift surfaces at runtime as a webview timeout.

Get the Vite bundle running inside a VS Code webview, with CSP done correctly.

- `vscode-extension/src/graphHost/graphPanel.ts`: `GraphPanel` class creates a `WebviewPanel`, loads `dist/graph/index.html`, runs the **CSP-injecting HTML transformer**, dispatches incoming `request` envelopes through `hostHandlers.ts` and sends back `response` envelopes via `webview.postMessage`.
- `vscode-extension/src/graphHost/htmlTransformer.ts`: rewrites every `href=` / `src=` to `webview.asWebviewUri(...)` (skips absolute URLs) and injects a `<meta http-equiv="Content-Security-Policy">` tag right after `<head>`. CSP literal: `default-src 'none'; script-src ${cspSource}; style-src ${cspSource}; img-src ${cspSource} data: blob:; font-src ${cspSource}; connect-src ${cspSource}; worker-src ${cspSource} blob:;` — note `'unsafe-inline'` for styles was dropped because Vite emits an external stylesheet and Sigma applies inline-style mutations via `element.style.x = y` (which CSP doesn't cover).
- `vscode-extension/src/graphHost/hostHandlers.ts`: dispatch table keyed on the wire `type` string. Day 1 only handles `'unity_graph_hello'`, returning `{ greeting, host: 'vscode' }`.
- `vscode-extension/src/extension.ts`: register `unityIndex.openGraph` command — invokes `GraphPanel.reveal(context.extensionUri, log)`. **No sidebar view registered** — a node graph wants editor real estate, not a 200px sidebar pane. Sidebar can be added later.
- `vscode-extension/package.json#contributes.commands`: add `unityIndex.openGraph`.
- `vscode-extension/scripts/package.js`: before invoking `vsce`, run `npm -w @unity-index/graph-webview run build` and `fs.cpSync` `graph/webview/dist/*` into `vscode-extension/dist/graph/`.

**Smoke test:** `npm -w vscode-extension run package:install`, reload VS Code, run `Unity Index: Open Graph` — see 3 nodes + hello round-trip in the status bar.

---

## Task 5 — Rider plugin wiring (single-file bundle + `loadHTML`)

**Pivot from Day 0.A "custom scheme handler" plan.** API archaeology against IntelliJ Platform 2025.1 (`com.intellij.ui.jcef.JBCefApp`) showed two problems:
- `JBCefStreamResourceHandler` is at `com.intellij.ui.jcef.utils` (minor — typo in import).
- **`JBCefApp.addCefCustomSchemeHandlerFactory(...)` is package-private with no extension point exposed to plugins.** There is no documented public way for a third-party plugin to register a custom scheme as "standard" for ESM/CORS purposes in 2025.1.

Rather than fight the missing API, switched to **vite-plugin-singlefile**:
- `graph/webview/vite.config.ts` adds `viteSingleFile()`, `cssCodeSplit: false`, `assetsInlineLimit: 100_000_000`. Output is a single `dist/index.html` (~190 KB raw / 50 KB gzipped — same budget impact as before).
- Rider side just calls `JBCefBrowser.loadHTML(html)` after reading `/graph/index.html` from the classpath. No scheme handler, no scheme service, no init-order ordering question.
- VS Code side: HTML transformer simplified — no `asWebviewUri` rewrites needed (nothing external left) — and switched to **nonce-based CSP** since the bundle is now one big inline `<script type="module">` + one inline `<style>`. Strict `default-src 'none'`; `script-src 'nonce-XYZ'`; `style-src 'nonce-XYZ'`.

Same folder-layout deviation as Task 4 applies: Kotlin code lives in `src/main/kotlin/com/github/dungphan/unityindex/graph/`, not in `graph/rider-bridge/`. The `graph/rider-bridge/` folder keeps its README as a placeholder.

**Files in `src/main/kotlin/com/github/dungphan/unityindex/graph/`:**
- `GraphBridgeProtocol.kt` — `BridgeEnvelope` / `BridgeError` (kotlinx.serialization) matching `graph/core/src/host-bridge.ts`. `GraphWireTypes.HELLO = "unity_graph_hello"` mirrors `graph/core/src/messages.ts`.
- `GraphHostHandlers.kt` — dispatch table. Day 1 handles only `HELLO`, returns `{ greeting, host: "rider" }`.
- `GraphHostBridge.kt` — per-browser JS↔Kotlin bridge. `JBCefJSQuery.create(browser as JBCefBrowserBase)` (the non-deprecated overload). Exposes `injectIntoHtml(html)` which prepends a `<script>` stub into `<head>` defining `window.unityIndex = { postToHost(json) { <query.inject('json')> }, fromHost: undefined }`. Incoming envelopes dispatched off the EDT via `executeOnPooledThread`; responses sent back as `window.unityIndex.fromHost("<json-quoted-string>")` via `executeJavaScript`.
  - **Gotcha caught at smoke test:** the bridge stub MUST be injected into the HTML before `loadHTML`, not via a post-load `executeJavaScript`. First attempt used `addLoadHandler.onLoadEnd` to inject — but the bundle's module script (which calls `pickBridge()` and reads `window.unityIndex` synchronously) runs *before* `onLoadEnd` fires. Result: the webview saw no `unityIndex` and fell back to the noop bridge, reporting `standalone (no host)` in the status bar despite Kotlin happily registering itself afterwards. Pre-load HTML injection wins the race deterministically. `GraphToolWindowFactory.createBrowserPanel` calls `browser.loadHTML(bridge.injectIntoHtml(html))`.
- `GraphToolWindowFactory.kt` — `JBCefApp.isSupported()` guard with friendly fallback; bundle-missing fallback; `JBCefBrowser().loadHTML(htmlReadFromClasspath)`. Implements `DumbAware`.

**`plugin.xml`:** added `<toolWindow id="Unity Index Graph" anchor="right" icon="AllIcons.Toolwindows.WebToolWindow" factoryClass="...GraphToolWindowFactory"/>`.

**`build.gradle.kts`:** two new tasks —
- `buildGraphWebview` (Exec): runs `npm -w @unity-index/graph-webview run build` from `rootDir`. Declares inputs (everything under `graph/webview/` minus `dist`/`node_modules`, plus `graph/core/src`, root `package.json` + `package-lock.json`) and outputs (`graph/webview/dist`) so Gradle's up-to-date check skips re-build correctly.
- `copyGraphBundle` (Sync): depends on `buildGraphWebview`, syncs `graph/webview/dist/` → `src/main/resources/graph/`. Sync (not Copy) so removed files don't pile up.
- `processResources` gets `dependsOn(copyGraphBundle)`, so the bundle is in place before the jar is built. `src/main/resources/graph/` is added to `.gitignore` — it's a build artifact.

**Smoke test:** `./gradlew buildPlugin` → install `build/distributions/unity-index-rider-0.5.0.zip` → open the "Unity Index Graph" tool window → see 3 nodes + hello round-trip.

---

## Task 6 — Lockstep version bump

- Bump `gradle.properties#pluginVersion` to `0.5.0` (next minor — Day 1 introduces a meaningful new surface).
- Bump `vscode-extension/package.json#version` to match.
- Mirror `0.5.0` into the new `graph/core/package.json` and `graph/webview/package.json`.
- One commit; reference the lockstep rule from `CLAUDE.md`.

---

## Task 7 — Smoke test + commit

- `./gradlew buildPlugin` → install in Rider → open tool window → see 3 nodes + bridge round-trip log.
- `cd vscode-extension && npm run package:install` → reload window → run `Unity Index: Open Graph` → see 3 nodes + bridge round-trip log.
- Commit: `Day 1: webview skeleton in both extensions`.

---

## Execution order

`1 → 2 → 3` are strictly sequential (later tasks need earlier ones' build output).
`4` and `5` are independent and parallelizable once `3` lands.
`6` and `7` close out.

## Risks already mitigated

- **JCEF + ESM:** custom scheme handler instead of `jar:file://`. See plan §Day 0.A "Webview asset loading."
- **VS Code CSP:** dedicated transformer subtask in Task 4. CSP string is spelled out above.
- **npm workspace + vsce:** bridges stay out of workspaces. No esbuild needed yet.
