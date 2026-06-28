# Day 3 — Task breakdown

Source: [`unity-index-graph-plan.md`](unity-index-graph-plan.md) §Day 3.

**Day 3 goal:** open the panel in Rider or VS Code, the webview calls `unity_graph_snapshot` through the host bridge, and the real asset graph for the active workspace/project renders with per-kind styling, a force-directed layout, and basic pan/zoom/drag/select. No filters, no click-through, no incremental updates — those are Days 4–7.

**Source of truth:**
- Wire shape — [`graph-schema.md`](./graph-schema.md) §5 and [`graph-mcp-tools.md`](./graph-mcp-tools.md) §3.1 (already implemented in Day 2 as `unity_graph_snapshot`).
- Stack — [`graph-decisions.md`](./graph-decisions.md): Sigma.js + Graphology, Svelte, TS, Vite, ES2022, `base: './'`. The plan's mention of "Cytoscape `fcose` or `cola`" is superseded — Day 3 uses **`graphology-layout-forceatlas2`**, optionally its supervisor for animation, **on the main thread**. Worker offloading is Day 7's problem.

**Lockstep rule:** the new bridge message (`unity_graph_snapshot`) lands in both the Kotlin and TS host dispatchers in the same commit. The webview is host-agnostic — it sees one bridge.

**Day 2 reuse:** both extensions already register `unity_graph_snapshot` as an MCP tool with a complete `SnapshotRequest` → `SnapshotResponse` path through `UnityAssetGraphBuilder` (Kotlin) and `buildAssetGraph` (TS). Day 3 wires the existing builders into the in-process bridge — **do not duplicate the build logic**. Per Day 0.A "MCP routing in-process": the bridge calls the builder directly, not over HTTP.

---

## Task 1 — Snapshot bridge message in `graph/core/`

Extend the bridge protocol with the snapshot round-trip. Pure type additions; no behavior.

- `graph/core/src/messages.ts`:
  - Add `export const SNAPSHOT_GRAPH_TYPE = 'unity_graph_snapshot' as const;` — string MUST match `ToolNames.UNITY_GRAPH_SNAPSHOT` (Kotlin) and `TOOL_NAMES.UNITY_GRAPH_SNAPSHOT` (TS) so the same identifier flows through both bridge and HTTP paths.
  - Re-export `SnapshotRequest` and `SnapshotResponse` from `./snapshot-wire.js` for webview ergonomics (so the webview imports a single module).
- `graph/core/src/index.ts`: re-export the new constant.
- Mirror the new constant in `GraphWireTypes.kt` (`const val SNAPSHOT = "unity_graph_snapshot"`). One line, one commit.
- No new envelope shape — the existing `BridgeEnvelope` carries it.

**Why a separate wire constant per message instead of one generic `mcpToolCall`:** the bridge already discriminates by `type` and the host dispatchers are small `when`/`switch` tables. Mixing tool calls into a generic envelope buries the contract; keeping one constant per supported tool keeps drift visible at compile time.

---

## Task 2 — VS Code host dispatch: `unity_graph_snapshot`

Wire the in-process call inside the existing VS Code bridge dispatcher.

- `vscode-extension/src/graphHost/hostHandlers.ts`:
  - Add a `SNAPSHOT_GRAPH_TYPE = 'unity_graph_snapshot'` constant (mirror of `graph/core` per the existing "constants inlined because graph-core ships ESM and this extension is CJS" deviation note in the file).
  - Add a `case SNAPSHOT_GRAPH_TYPE` branch:
    1. Resolve the active `ProjectContext` via the same `projectResolver` the HTTP path uses. **Picking rule:** if `payload.project_path` is provided, use it; otherwise pick the single Unity-shaped workspace folder (one containing `ProjectVersion.txt` under `ProjectSettings/`). If the workspace has zero Unity projects, throw an `Error("no_unity_project")`; if it has more than one and `payload.project_path` is missing, throw `Error("multiple_projects_specify_project_path")`. The webview surfaces these as the empty-state copy.
    2. Decode `payload` as `Partial<SnapshotRequest>` and forward to `buildAssetGraph(workspace, request)` directly — same call the snapshot tool makes.
    3. Return the `SnapshotResponse` envelope (same shape Task 4 of Day 2 produces). Do NOT call the tool registry's `execute` indirection — the bridge owns the in-process fast path.
- The dispatcher signature stays sync-returning-Promise; the webview round-trip mechanism already awaits it.

**Reuse boundary:** `buildAssetGraph` already accepts an `AssetIndexLike` and a `SnapshotRequest`; the snapshot tool already wraps it with `generated_at`. Refactor the wrapping into a tiny shared helper (`runSnapshot(workspace, request): Promise<SnapshotResponse>`) called by both `unityGraphSnapshotTool.ts` and `hostHandlers.ts`. **No second copy of the response-shaping logic.**

---

## Task 3 — Rider host dispatch: `unity_graph_snapshot`

Mirror Task 2 on the Kotlin side.

- `src/main/kotlin/com/github/dungphan/unityindex/graph/GraphHostHandlers.kt`:
  - Add a `GraphWireTypes.SNAPSHOT` branch in `dispatch`:
    1. Resolve the `Project` argument the bridge was constructed with (`GraphHostBridge` already binds one Project per tool window — the existing dispatcher signature receives `project: Project?`). Throw if null with a stable message string the webview can surface.
    2. Decode `payload` as `SnapshotRequest` via `Json.decodeFromJsonElement` (kotlinx).
    3. Call into the same builder path `UnityGraphSnapshotTool.doExecute` uses. Like Task 2, extract a tiny `GraphSnapshotRunner.run(project, request): SnapshotResponse` helper so both the MCP tool and the bridge dispatcher call the same function — no duplicated `Instant.now()` / `SnapshotResponse` shaping.
- Reuse the existing kotlinx `Json` instance from `GraphBridgeProtocol` neighbors; no new serializer config.

**Project disambiguation:** unlike VS Code, Rider always has a single bound `Project` per tool window — no multi-project picker on Day 3. If `payload.project_path` arrives and disagrees with `project.basePath`, log a warning but honor the bound `Project` (the tool window owns the context).

---

## Task 4 — Webview: snapshot fetch + loading/empty/error states

Replace the Day 1 hardcoded 3-node graph with a real fetch.

- `graph/webview/src/lib/snapshot.ts` (new): `export async function fetchSnapshot(bridge: HostBridge, req: Partial<SnapshotRequest> = {}): Promise<SnapshotResponse>` — thin wrapper around `request(bridge, SNAPSHOT_GRAPH_TYPE, req, { timeoutMs: 30_000 })`. 30s ceiling because real Unity projects on cold-start take 5–15s for the first asset-index pass (see `unity-index-graph-plan.md` Day 0.A sampled volumes).
- `graph/webview/src/App.svelte`:
  - Replace the hardcoded `graph.addNode(...)` block with:
    1. `state: 'loading' | 'empty' | 'ready' | 'error'`.
    2. On mount, after `pickBridge`, if `host === 'standalone'` keep showing 3 placeholder nodes (dev-mode smoke test) and set state `'ready'`.
    3. Otherwise `await fetchSnapshot(bridge)`. On success with `snapshot.nodes.length === 0` set `'empty'`; on success with nodes set `'ready'` and pass through Task 5. On thrown error set `'error'` and surface `e.message`.
  - Loading: full-canvas spinner + "loading project graph…" copy.
  - Empty: copy = "No Unity assets found in this project." plus a "Retry" button that re-fires the fetch.
  - Error: copy = the thrown message verbatim. Two stable strings the user might see — `no_unity_project` and `multiple_projects_specify_project_path` — get human-friendly translation in the webview, all others render raw. **Do not retry automatically on error**; the user clicks Retry.
- Surface the `snapshot.stats` (node count, edge count, skipped instance count) and any `warnings[]` in the existing top status bar — replaces the Day 1 "bridge ok — ..." string.

**Why not stream the snapshot:** Day 2 pagination is implemented as slice-after-build, so streaming a chunked response gains nothing on Day 3. Day 7 owns incremental updates, not Day 3.

---

## Task 5 — Webview: snapshot → Graphology adapter

Convert `SnapshotResponse` into a Graphology graph instance. Pure data, no rendering.

- `graph/webview/src/lib/snapshotToGraph.ts` (new):
  - `export function buildGraphologyGraph(snapshot: GraphSnapshot): Graph` — directed, **non-multi** (per `graph-types.ts` the schema is single-edge-per-(source, target, kind), but Graphology only dedupes by (source, target); collapse multiple kinds onto one edge with a `kinds: EdgeKind[]` attribute, or use `multi: true` and key edges by `${kind}:${source}:${target}`). **Pick `multi: true` with a deterministic key** — keeping edge kinds separate is the right call for the per-kind styling in Task 7.
  - Node attributes set on add: `label` (from `node.label`), `kind`, `path`, `guid`, `x` (random in `[-1,1]`), `y` (random in `[-1,1]`), `size` (kind-dependent — set defaults in Task 6 helper), `color` (kind-dependent, same helper).
  - Edge attributes: `kind`, `size: 1`, `color` (kind-dependent), `type: 'arrow'`.
  - Drop edges whose `source` or `target` does not exist in `nodes[]`. **Specifically expected for Day 2's `script_declares_class` edges pointing to dangling `csharp://` IDs** — the Day 2 builder emits these intentionally (schema §3.1) and they get filled in by Day 8. Count drops and surface `dangling_csharp_targets: N` in the status bar so the gap is visible. Do not warn loudly on each drop.
- `graph/webview/src/lib/__tests__/snapshotToGraph.test.ts` (Vitest, lives next to the source; uses the same Vitest config Day 2 introduced for `graph/core/`):
  - A snapshot with 4 nodes + 3 edges builds a graph with the same counts.
  - A dangling-target edge is dropped; the returned `{ graph, droppedEdges }` tuple reports `droppedEdges === 1`.
  - Multi-edge between the same pair with two different `kind`s ends up as two edges in the graph.

**No layout in this task.** This module is pure; Task 6 owns layout.

---

## Task 6 — Webview: ForceAtlas2 layout

Spread the nodes meaningfully before the first paint.

- Add `graphology-layout-forceatlas2` to `graph/webview/package.json` dependencies. Do NOT add the `graphology-layout-forceatlas2/worker` import yet — keep workers out of Day 3 to limit moving pieces. Day 7 owns the worker swap.
- `graph/webview/src/lib/layout.ts` (new): `export function layoutForceAtlas2(graph: Graph, opts: { iterations?: number } = {}): void`. Defaults: `iterations: 300`, `settings: forceAtlas2.inferSettings(graph)` (size-aware defaults).
- Call it in `App.svelte` between "graph built" and "Sigma instantiated." Synchronous run is fine up to ~5k nodes (Sigma's own benchmark); above that the UI freezes — accept this for Day 3 and let Day 7 fix it with the worker variant. Note the threshold in a comment in `layout.ts` so the future Day 7 author finds it.
- **Pre-layout seed**: random positions in `[-1, 1]` are required — forceatlas2 with `(0, 0)` starting positions deadlocks.

---

## Task 7 — Webview: per-kind node + edge styling

Make kinds visually distinguishable.

- `graph/webview/src/lib/style.ts` (new):
  - `export const NODE_STYLE: Record<NodeKind, { color: string; size: number }>`. Concrete palette (locked here so Day 4+ don't bikeshed it):
    - `script` — `#ffaa00`, size `8`
    - `prefab` — `#4f7cff`, size `10`
    - `prefab_variant` — `#7aa0ff`, size `10`
    - `scene` — `#22cc88`, size `12`
    - `so` — `#cc66ff`, size `8`
    - `asset` — `#888888`, size `6`
    - `addressable_group` — `#dd5577`, size `10`
    - All `code` kinds (`namespace`, `class`, `interface`, `struct`, `enum`, `method`, `property`, `field`) — `#cccccc`, size `4`. **Not emitted in Day 2** but mapped now so Day 8 doesn't trip on missing entries.
    - `component_instance` / `component_field` — same `#cccccc`, size `2`. Never rendered top-level (Day 2 schema rule); the mapping exists only so an accidental emit doesn't crash the renderer.
  - `export const EDGE_STYLE: Record<EdgeKind, { color: string; type: 'arrow' | 'line'; size: number }>`. Concrete palette:
    - `script_used_by_prefab`, `script_used_by_scene` — `#4f7cff`, `arrow`, `1.5`
    - `scene_contains_prefab` — `#22cc88`, `arrow`, `1.5`
    - `prefab_variant_of` — `#7aa0ff`, `arrow`, `1.0`
    - `serialized_binding` — `#888888`, `arrow`, `1.0`
    - `script_declares_class` — `#aaaaaa`, `line` (no arrow), `0.5` — declaration, not a reference
    - Code edges (`class_inherits_from`, `class_implements_interface`, `method_overrides_method`, `method_calls_method`, `class_references_class`) — placeholder `#555555`, `arrow`, `0.8`. Day 9 owns the real code-edge palette; Day 3 just keeps the map total.
    - `guid_resolves_to`, `addressable_group_contains` — `#666666`, `arrow`, `0.8`.
  - **Total map by construction** — TS exhaustiveness check via a satisfies type so adding a new `NodeKind` / `EdgeKind` breaks the build.
- Apply via Sigma's settings rather than mutating per-node attributes: `nodeReducer: (key, attrs) => ({ ...attrs, color: NODE_STYLE[attrs.kind].color, size: NODE_STYLE[attrs.kind].size, label: attrs.label })` and the analogous `edgeReducer`. Reducers are the right place because Day 4 (highlight on click) and Day 5 (filter fade) chain into the same hook — no later refactor needed.
- **Icons deferred.** The plan says "icon + color"; SVG/PNG icons on Sigma nodes require either a custom node program (~150 LOC) or the `@sigma/node-image` plugin. Day 3 ships color + size only and uses node **shape** (circle for assets, square for scripts via `@sigma/node-square` only if free; otherwise size+color is enough). Icons land in Day 14 polish; cite this deviation in the commit message.

---

## Task 8 — Webview: interactions (pan, zoom, drag, select)

Sigma gives pan/zoom for free. Drag and select need ~30 lines.

- Pan/zoom: Sigma defaults are correct (mousewheel zoom, drag-pan); no code.
- Node drag: copy the canonical Sigma drag pattern — `downNode` → `mousemovebody` → `mouseup`, updating `graph.setNodeAttribute(node, 'x', ...)` on the camera-projected coordinates. Lives in `graph/webview/src/lib/drag.ts` so Day 7's worker layout can swap it without touching `App.svelte`.
- Select: `sigma.on('clickNode', ({ node }) => selectedNode = node)` and `sigma.on('clickStage', () => selectedNode = null)`. `selectedNode` is a Svelte `$state` string-or-null.
- Visual selection feedback: the node reducer reads `selectedNode` and returns `{ ...attrs, highlighted: true, zIndex: 1 }` for the selected key, plus dim others to 60% opacity. Same reducer touched in Task 7.
- **No keyboard navigation, no right-click, no double-click on Day 3** — context menu + double-click open-in-editor are Day 4's scope. Wire only the click selection so Day 4 has a `selectedNode` state to read from.

---

## Task 9 — Hard cap + perf guardrails for Day 3 only

Real projects sampled in Day 0.A produce ~8–13k file-level nodes; main-thread ForceAtlas2 + Sigma without a worker handles that, but the first paint can stall a few seconds.

- Add a **soft cap of 5000 nodes for the Day 3 main-thread layout**. If `snapshot.nodes.length > 5000`, skip the layout pass, lay out on a circular ring via `graphology-layout/circular`, and show a one-line status-bar warning "graph too large for default layout (N nodes) — Day 7 will fix." This keeps the UI usable on big projects without freezing for 30s.
- Above 20k nodes, show the empty-state copy with a different message ("graph has N nodes — pagination + worker layout land in Day 7") and skip rendering entirely. Acceptable for now because no current sample crosses 20k; protects the user from a tab crash.
- **No virtualization, no clustering, no LOD on Day 3** — Day 7 owns those.

---

## Task 10 — Lockstep version bump

Day 3 adds a webview-side bridge call but does not change the MCP wire shape (the snapshot tool exists from Day 2). Conservative bump:

- `gradle.properties#pluginVersion` → `0.5.2` (patch — additive only).
- `vscode-extension/package.json#version` → `0.5.2`.
- `graph/core/package.json`, `graph/webview/package.json` → `0.5.2`.
- Single commit: `Day 3: render real asset graph in webview`.

---

## Execution order

`1` first (types) so both hosts can compile against the same constant. After that:
- TS lane: `2 → 4 → 5 → 6 → 7 → 8 → 9`.
- Kotlin lane: `3` (parallelizable with Task 2 once Task 1 lands).
- `5` has a Vitest test (the only one on Day 3); land it before merging Task 7 so the dangling-edge drop case is locked.
- `10` closes out.

End-to-end manual check before commit: open Rider on `cbg-client/`, then VS Code on the same path. Both should render the same node/edge counts in the status bar (matches the Day 2 byte-equivalence acceptance criterion). A visible layout difference is fine — ForceAtlas2 is non-deterministic without a fixed seed.

---

## Risks already mitigated

- **Cytoscape vs Sigma drift in the plan prose:** this breakdown explicitly picks Graphology + ForceAtlas2; the plan's `fcose`/`cola` mention is dead.
- **Main-thread layout freeze on real projects:** Task 9's soft + hard caps keep the UI alive until Day 7 ships a worker.
- **Dangling `csharp://` targets from Day 2:** Task 5 silently drops them and surfaces the count, matching the Day 2 warning contract — no scary red error for an intentional Phase-2 gap.
- **Project picker ambiguity in multi-folder VS Code workspaces:** Task 2 fails loudly with a stable error string the webview translates; no silent "first folder wins" pick that breaks reproducibility.

---

## Out of scope (deferred)

- Click-through to editor / context menu / "find usages" — Day 4.
- Filters, search, fade-non-matches — Day 5.
- Subgraph focus, breadcrumbs, "show impact" — Day 6.
- Worker-thread layout, virtualization, LOD clustering — Day 7.
- C# / code edges (the styling map already accommodates them) — Day 8.
- Icons — Day 14 polish.
- File-watching / incremental snapshot refresh — Day 7.
