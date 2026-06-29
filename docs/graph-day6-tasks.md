# Day 6 — Task breakdown

Source: [`unity-index-graph-plan.md`](unity-index-graph-plan.md) §Day 6 and [`graph-mcp-tools.md`](./graph-mcp-tools.md) §3.2–§3.4 (`unity_graph_neighbors`, `unity_graph_impact`, `unity_graph_context`).

**Day 6 goal:** ship subgraph navigation in the webview (focus on a node → N-hop neighborhood, breadcrumb stack, reset, show impact) AND land the three Phase-1 MCP tools that expose the same operations to external agents (`unity_graph_neighbors`, `unity_graph_impact`, `unity_graph_context`). `unity_graph_expand` is deferred to Day 7 — it ships with sub-file rendering, not with focus navigation.

**Source of truth:**
- Wire shapes — [`graph-mcp-tools.md`](./graph-mcp-tools.md) §3.2/§3.3/§3.4. Field names are the contract.
- Stack — same as Day 3: Graphology in-memory traversal in the webview, kotlinx-serializable mirrors on the Kotlin side. No new dependencies.
- Pre-existing snapshot — Day 2's `UnityAssetGraphBuilder` / `buildAssetGraph` is the only graph source. Day 6 traversal is pure BFS/reverse-BFS over an already-built snapshot; **do not** add a second harvest path.

**Lockstep rule:** every new tool name, request shape, response shape, and warning code lands in both Kotlin and TS in the same commit. The traversal *algorithm* is implemented twice (TS in `graph/core`, Kotlin in a new helper) but must produce byte-equivalent node/edge lists for the same snapshot — Task 11's tests lock this in.

**Key architectural call for the webview:** focus / impact run against the **in-memory Graphology graph** that's already loaded — no bridge round-trip. The MCP tools exist for external clients (Claude Code, etc.), not the webview's first paint. Rationale: the snapshot is already in the webview's heap (≤20k nodes per Day 3 cap), Graphology has BFS in 5 lines, and a bridge hop would add 50–200ms for nothing. The two implementations stay aligned because they share the same pure traversal module (Task 2).

**Day 5 reuse:** filter state (`hiddenKinds`, `search`) coexists with focus. The user must be able to focus a subgraph AND apply a kind filter — neither overrides the other. Task 8 spells out the composition rule.

---

## Task 1 — Wire types + message constants in `graph/core/`

Lock the contract before either side dispatches. Pure types — no behavior.

- `graph/core/src/neighbors-wire.ts` (new):
  - `NeighborsRequest`, `NeighborsResponse` exactly as in `graph-mcp-tools.md` §3.2.
  - `ImpactRequest`, `ImpactResponse`, `ImpactedNode`, `ImpactClassification = 'direct' | 'transitive' | 'weak'` per §3.3.
  - `ContextRequest`, `ContextResponse`, `EdgeWithEndpoint`, `DiagnosticSummary` (placeholder — Day 10 owns the real shape; declare `{ severity: 'error'|'warning'|'info'; message: string; line?: number }` so the type compiles now). The placeholder MUST be tagged with a `// TODO(day-10):` comment so the Day 10 author finds it.
- `graph/core/src/messages.ts`: add `NEIGHBORS_GRAPH_TYPE`, `IMPACT_GRAPH_TYPE`, `CONTEXT_GRAPH_TYPE` constants. Strings MUST match `ToolNames.UNITY_GRAPH_*` (Kotlin) and `TOOL_NAMES.UNITY_GRAPH_*` (TS). Even though the webview does not call these over the bridge on Day 6 (it traverses locally — see Task 7), declare the constants now: Day 11 (saved views) and Day 12 (query DSL) will route through the bridge and we want one place where the wire strings live.
- `graph/core/src/index.ts`: re-export everything.
- New warning codes added to `snapshot-wire.ts` next to the existing `WARNING_*` constants: `WARNING_ID_UNRESOLVED = 'id_unresolved'` and `WARNING_NEIGHBORS_TRUNCATED = 'neighbors_truncated'`. Mirror in Kotlin (`GraphWarningCodes` object — create it if it doesn't exist; existing warnings currently live as inline string literals in `UnityAssetGraphBuilder.kt`. **Refactor those to the new object in the same commit** so warning-code drift is impossible.)

**Why a separate `*-wire.ts` per tool family instead of one mega-file:** `snapshot-wire.ts` is already 60 lines of types you import wholesale. Adding three more request/response pairs there crosses the readability threshold. One file per tool family keeps each under 80 lines and makes Day 8's `code-edges-wire.ts` and Day 12's `query-wire.ts` land mechanically.

---

## Task 2 — Pure traversal helpers in `graph/core/`

The webview and the TS host MCP tool share this code. The Kotlin host re-implements the same algorithm (Task 6). The shared module is the single point that defines what "neighbors" / "impact" mean.

- `graph/core/src/traversal.ts` (new). Pure functions over a `GraphSnapshot` — no Graphology dependency, no DOM dependency, no host dependency. **Graph-core stays Graphology-free** (per Day 1's "host imports are type-only from graph-core"); only `graph/webview/` depends on Graphology. The traversal walks the raw `nodes[]`/`edges[]` directly via an indexed view.
  - `buildAdjacency(snapshot: GraphSnapshot): AdjacencyIndex` — once-per-snapshot O(N+E) build of `{ out: Map<string, GraphEdge[]>; in: Map<string, GraphEdge[]>; nodesById: Map<string, GraphNode> }`. Caller responsible for caching; both tool handlers and the webview build it once per snapshot and reuse across calls.
  - `neighbors(adj, seeds, opts): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean; unresolvedIds: string[] }` — BFS from each seed; union the results.
    - `opts`: `{ hops: number; direction: 'in'|'out'|'both'; edgeKinds?: Set<EdgeKind>; maxNodes: number }`.
    - Unresolved seed IDs (not in `nodesById`) collected, not thrown — matches the §3.2 contract.
    - `truncated=true` when `maxNodes` is hit during expansion (current frontier dropped, not partial).
    - Edge filter applied **during traversal**, not after — an excluded edge kind must not even count toward the hop budget. This is load-bearing for Day 12's pattern queries.
  - `impact(adj, seeds, opts): { nodes: GraphNode[]; edges: GraphEdge[]; impacted: ImpactedNode[] }` — reverse-reachable closure.
    - **Direction is fixed to incoming** per §3.3 — "what breaks if I delete this." Do not parameterize.
    - `opts`: `{ maxDepth?: number; classify: boolean }`.
    - `distance`: BFS depth from any seed (min across seeds, since seeds union).
    - `classification` rules (locked here, not in MCP-tool docs, because both implementations must agree):
      - `direct` — distance === 1 AND the connecting edge is one of: `script_used_by_prefab`, `script_used_by_scene`, `scene_contains_prefab`, `prefab_variant_of`, `class_inherits_from`, `class_implements_interface`, `method_overrides_method`. These are "compile/run breaks immediately."
      - `weak` — ANY edge in the path from this node back to a seed is `serialized_binding`. Serialized references survive deletion as missing-reference warnings, not compile failures. Distance can be anything.
      - `transitive` — everything else.
    - `reason` string: `"<other_kind> '<other_label>' <edge_verb> '<seed_label>'"`, with `edge_verb` a per-EdgeKind lookup table living in the same file (so both halves of the lockstep agree on copy). Example: `"scene 'Main' contains prefab 'Player'"`.
  - `context(adj, nodeId, opts): { node: GraphNode; incoming: EdgeWithEndpoint[]; outgoing: EdgeWithEndpoint[]; truncated: boolean }` — node + 1-hop neighbors with their endpoint nodes inlined. `opts.maxNeighbors` (default 50) caps each direction independently; if one direction is capped, `truncated=true` so the host can attach the warning.
- `graph/core/src/__tests__/traversal.test.ts` (Vitest). Bench cases — each ≤30 lines, hand-built snapshot:
  - 1-hop out: seed=prefab, expect direct script + edge in result.
  - 2-hop both: seed=script, expect prefab + scene + their connecting edges.
  - `direction: 'in'` from a leaf script returns scenes/prefabs that reference it.
  - `edgeKinds` filter: with `[scene_contains_prefab]` only, BFS from a scene doesn't traverse `script_used_by_*`.
  - `maxNodes=2` hit mid-expansion → `truncated=true`, 2 nodes returned.
  - Unresolved seed mixed with resolved seed: result excludes the bad id, populates `unresolvedIds`, traversal continues for the rest.
  - Impact: `serialized_binding` on the path → `weak` classification.
  - Impact: direct `script_used_by_prefab` neighbor → `direct` classification.
  - Impact: 2-hop chain with no serialized edges → `transitive`.
  - Context: 1-hop with `maxNeighbors=3` and 5 actual neighbors → 3 returned, `truncated=true`.

**Why pure-data over a Graphology wrapper:** the MCP tools (Tasks 4/5/6) don't need a renderer; they only need the algorithm. Forcing a Graphology dep on `graph/core/` would bloat the host's bundle for no gain. Webview wraps the result back into Graphology for rendering (Task 7).

---

## Task 3 — TS MCP tool: `unity_graph_neighbors`

- `vscode-extension/src/tools/unity/unityGraphNeighborsTool.ts` (new). Mirrors `unityGraphSnapshotTool.ts` structure: extends `AbstractTool`, accepts `NeighborsRequest`, returns `{ snapshot: GraphSnapshot, truncated?: boolean, warnings?: Warning[] }`.
- Pipeline: resolve project → `buildAssetGraph(...)` → `buildAdjacency(snapshot)` → `neighbors(adj, ...)` → wrap result `GraphNode[]`/`GraphEdge[]` into a fresh `GraphSnapshot` (re-emit `generated_at`, recompute `stats` for the subset; `source_phase` carries over from the source snapshot — currently always `asset` until Day 8).
- Validation: `node_ids` between 1 and 100 (per §3.2); `hops` clamped to 1..4; `max_nodes` default 2000, hard ceiling 20000.
- Warnings:
  - Each unresolved seed → one warning `{ code: 'id_unresolved', context: { id } }`.
  - If `truncated` → `{ code: 'neighbors_truncated', context: { max_nodes } }`.
- Register in `vscode-extension/src/server/toolRegistry.ts` (or wherever the existing graph snapshot tool is registered) alongside Phase-1 tools. Add `UNITY_GRAPH_NEIGHBORS: "unity_graph_neighbors"` to `vscode-extension/src/constants.ts`.
- **Reuse boundary:** the response-shaping logic (re-emit `generated_at`, recompute `stats`) is identical across neighbors/impact/context tools. Extract a `subgraphResponse(nodes, edges, sourcePhase): GraphSnapshot` helper into `vscode-extension/src/utils/unityAssetGraphBuilder.ts` next to `buildAssetGraph` so all three Day 6 tools call the same shaper. **No three near-identical copies.**

---

## Task 4 — TS MCP tool: `unity_graph_impact`

- `vscode-extension/src/tools/unity/unityGraphImpactTool.ts` (new). Same pipeline as Task 3 but calls `impact(adj, seeds, opts)`.
- Response shape: `{ snapshot, impact: ImpactedNode[], warnings? }`. `impact[]` must be sorted by `distance` ascending then `id` lexicographically so byte-equivalence with the Kotlin side is checkable.
- Validation: `node_ids` between 1 and 50 (per §3.3); `max_depth` optional unbounded.
- Same warning shape as Task 3 for unresolved IDs.
- Register + add `UNITY_GRAPH_IMPACT` constant.

---

## Task 5 — TS MCP tool: `unity_graph_context`

- `vscode-extension/src/tools/unity/unityGraphContextTool.ts` (new).
- Pipeline: build snapshot + adjacency, call `context(adj, node_id, { maxNeighbors })`. Wrap result as `ContextResponse`.
- `include_code_summary` (default true): if `node.kind === 'script'` AND `node.path` resolves to a `.cs` file, delegate to the existing `FileStructureTool` (do NOT re-parse the file) and serialize its markdown-ish output into `code_summary`. For non-script nodes (or when `FileStructureTool` returns empty), omit the field. **Reuse boundary:** call `FileStructureTool.execute` directly with a synthesized request; do not copy the parsing logic.
- `include_diagnostics` (default false): if true, call `GetDiagnosticsTool` for `node.path`; map each diagnostic to the placeholder `DiagnosticSummary` shape (Task 1). Day 10 will replace the placeholder with the real Day-10 type.
- Unresolved `node_id` → JSON-RPC error `invalid_id` per §1.5. **This differs from neighbors/impact** which accept partial seeds — context is single-node and an unresolvable input means there's nothing to return.
- Register + add `UNITY_GRAPH_CONTEXT` constant.

---

## Task 6 — Kotlin MCP tools: neighbors + impact + context

Mirror Tasks 3–5 in Kotlin. One commit, both sides.

- `src/main/kotlin/com/github/dungphan/unityindex/util/GraphTraversal.kt` (new). Pure Kotlin port of `graph/core/src/traversal.ts` — same algorithm, same classification table, same edge-verb lookup. Operates over `GraphSnapshot` from `tools/models/GraphSnapshotModels.kt`.
  - `data class AdjacencyIndex(val out: Map<String, List<GraphEdge>>, val incoming: Map<String, List<GraphEdge>>, val nodesById: Map<String, GraphNode>)` — note `incoming` not `in` (Kotlin keyword).
  - `fun buildAdjacency(snapshot: GraphSnapshot): AdjacencyIndex`.
  - `fun neighbors(adj, seeds, opts): NeighborsResult`.
  - `fun impact(adj, seeds, opts): ImpactResult`.
  - `fun context(adj, nodeId, opts): ContextResult`.
- `src/main/kotlin/com/github/dungphan/unityindex/tools/models/GraphTraversalModels.kt` (new). `@Serializable` mirrors of the wire types from Task 1:
  - `GraphNeighborsRequest`, `GraphNeighborsResponse`.
  - `GraphImpactRequest`, `GraphImpactResponse`, `ImpactedNode`, `ImpactClassification` enum with `@SerialName("direct"|"transitive"|"weak")`.
  - `GraphContextRequest`, `GraphContextResponse`, `EdgeWithEndpoint`, `DiagnosticSummary` placeholder.
- Three tools under `src/main/kotlin/com/github/dungphan/unityindex/tools/unity/`:
  - `UnityGraphNeighborsTool.kt`
  - `UnityGraphImpactTool.kt`
  - `UnityGraphContextTool.kt`
- Each extends `AbstractMcpTool`, gets a `SchemaBuilder` input schema mirroring the TS validation rules (`node_ids` 1..100 / 1..50 for neighbors/impact, `hops` 1..4, etc.), wraps `UnityAssetGraphBuilder.build(...)` then calls into `GraphTraversal`.
- Register all three in `ToolRegistry.registerBuiltInTools()`.
- Add `UNITY_GRAPH_NEIGHBORS`, `UNITY_GRAPH_IMPACT`, `UNITY_GRAPH_CONTEXT` to `ToolNames.kt`.
- For `UnityGraphContextTool.kt`, `include_code_summary`: delegate to `FileStructureTool.doExecute` exactly like the TS side; for `include_diagnostics`, delegate to `DiagnosticsAnalysisService`. **No new analysis paths.**

**RD-proxy guard (per CLAUDE.md):** context resolution must NOT walk PSI directly for the C# pieces — Day 6 only touches `script` nodes via their file paths, which the existing tools already handle. If a future change makes context walk symbol nodes, route through the defensive helpers in `FindClassTool` / `OptimizedSymbolSearch`.

---

## Task 7 — Webview: focus subgraph (local traversal, no bridge)

The user clicks a node → "Focus on this node" → the panel renders only that node's N-hop neighborhood. Pure client-side, using the loaded snapshot.

- `graph/webview/src/lib/focus.ts` (new). Thin Graphology wrapper around `graph/core` traversal — keeps the snapshot wrapped in Graphology for rendering while delegating the algorithm to the shared module:
  - State shape: `FocusFrame = { nodeId: string; hops: number; direction: 'in'|'out'|'both' }`. A stack of frames is the breadcrumb (Task 9).
  - `computeVisibleNodes(snapshot, focusStack): { nodes: Set<string>; edges: Set<string> }` — applies the **last** frame to the full snapshot via `neighbors(adj, [last.nodeId], { hops: last.hops, direction: last.direction, maxNodes: HARD_RENDER_CAP })`. Earlier breadcrumb frames are navigation history, not composition.
  - Returns edge keys in the same format the Graphology graph uses (`${kind}:${source}:${target}` per Day 3's `multi: true` choice).
- `App.svelte`: add `focusStack: FocusFrame[] = $state([])`. Recompute `visibleNodesRef` / `visibleEdgesRef` in a `$effect` triggered by `focusStack` or `currentSnapshot` change. Reducer-only changes — never delete graph nodes/edges, only set `hidden: true` via the existing node/edge reducer pattern from Day 3 Task 7. This preserves layout positions across focus/unfocus.
- Default values: when entering focus, `hops: 1, direction: 'both'`. Toolbar controls (Task 9) let the user bump hops to 2 or 3 and flip direction.
- **Layout behavior:** do NOT re-run ForceAtlas2 on focus. The existing positions stay; hidden nodes are simply not drawn. Re-layout on focus would (a) freeze the UI a second time and (b) make the "exit focus" transition jarring because positions would no longer match where the user remembers them. Note this in a code comment so the future Day-7 worker-layout author doesn't auto-relayout on focus.
- **Empty focus:** if the seed has no neighbors at the requested hops, render just the seed node + an empty-state overlay "no neighbors at N hops — try increasing depth or switching direction."

---

## Task 8 — Webview: focus × filter composition

Day 5 filters (`hiddenKinds`, `search`) coexist with focus. Lock the composition rule.

- `App.svelte`: the node-visibility reducer composes the three masks with AND:
  - Visible iff: `(focusStack.length === 0 || visibleNodes.has(id)) && !hiddenKinds.has(kind) && (searchActive ? relatedRef.has(id) : true)`.
- Edge visibility: edge visible iff both endpoints visible AND `(focusStack.length === 0 || visibleEdges.has(edgeKey))`.
- **Status-bar copy update:** when focus is active, append `· focused on <label> (N hops, <direction>) — X/Y nodes visible` after the existing snapshot/filter status. Show the hop count and direction explicitly so the user understands what they're seeing without opening a tooltip.

---

## Task 9 — Webview: breadcrumb + focus controls

The focus stack needs a visible trail and a way out.

- `graph/webview/src/lib/Breadcrumb.svelte` (new). Pinned to the top-left of the canvas, above the status bar. Renders:
  - "Full graph" anchor (always present; clicking clears the stack).
  - One chip per stack frame: `<NodeLabel> · <kind icon> · ✕`. Clicking the chip body pops the stack down to (and including) that frame; clicking ✕ pops just that frame.
  - Hops control on the **active** (last) frame only: a tiny `−/[hops]/+` stepper, clamped 1..4 (per §3.2 hop max).
  - Direction toggle on the active frame: `←/↔/→` icons mapping to `in`/`both`/`out`.
  - "Reset" button at the right that clears the stack. Same effect as clicking "Full graph" — both exist for discoverability.
- Visual style matches the existing FilterSidebar / SearchBar dark-theme palette (`#1f1f1f` background, `#3a3a3a` border, `#ddd` text). No new color tokens.
- Keyboard: `Esc` while focused pops the top frame (or clears if only one). Wire in `App.svelte` next to the existing key handlers, but **only when no input is focused** — typing Esc in the search bar should clear the search, not the focus. Check `document.activeElement?.tagName === 'INPUT'` before consuming.

---

## Task 10 — Webview: "Focus on this node" and "Show impact" context menu items

Hook the new operations into the existing right-click menu.

- `graph/webview/src/lib/eligibility.ts`:
  - Add `'focus_neighborhood'` and `'show_impact'` to `ActionId`.
  - Add to `ALL_ACTIONS`:
    - `{ id: 'focus_neighborhood', label: 'Focus on this node', isSync: true }`
    - `{ id: 'show_impact', label: 'Show impact', isSync: true }`
  - `isEligible`:
    - `focus_neighborhood`: any node — no path/guid required.
    - `show_impact`: any node with **incoming** edges (so the menu doesn't offer impact for orphan leaves where the answer is "nothing"). Eligibility takes new `NodeFacts.hasIncomingEdges: boolean` field; ContextMenu populates it from `graph.inDegree(nodeId) > 0`.
- `App.svelte` action dispatcher: route the two new actions to local focus-stack mutations, not bridge calls:
  - `focus_neighborhood`: push `{ nodeId, hops: 1, direction: 'both' }`.
  - `show_impact`: push `{ nodeId, hops: 4, direction: 'in' }` — impact is "everything that reaches me," which matches `direction: 'in'` traversal. Hops 4 caps render to a reasonable subgraph even on deeply-coupled prefab chains; the user can step it down via the breadcrumb's hops stepper.
- For `show_impact`, additionally compute the classification (`impact` from `graph/core/traversal`) and render colored badges on impacted nodes via the existing node reducer: red ring for `direct`, orange ring for `transitive`, dashed gray ring for `weak`. The ring uses Sigma's `borderColor`/`borderSize` settings (free with Sigma's default node program — no custom program needed). When the user pops the impact frame, badges clear.
- Tests:
  - `graph/webview/src/lib/__tests__/eligibility.test.ts`: add cases for the two new actions, including `show_impact` requiring `hasIncomingEdges`.
  - No DOM test for the menu wiring itself — App.svelte UI tests are deferred to Day 14.

---

## Task 11 — Cross-implementation byte-equivalence test

The two `neighbors`/`impact`/`context` implementations (TS in `graph/core`, Kotlin in `GraphTraversal.kt`) must produce identical results for the same snapshot, or external MCP clients see different graphs depending on which extension served them.

- TS side: `graph/core/src/__tests__/traversal.fixtures.ts` exports a hand-built snapshot fixture (~15 nodes, ~20 edges covering every node kind + every Day-6 edge kind) and the **expected** outputs for a fixed set of queries (3 neighbors calls, 3 impact calls, 2 context calls). Already covered partially by Task 2 tests; consolidate into a shared fixture module.
- Kotlin side: `src/test/kotlin/com/github/dungphan/unityindex/util/GraphTraversalTest.kt` (new). Loads the same fixture JSON (committed under `src/test/resources/graph/traversal-fixture.json`, generated from the TS fixture via a one-time script committed at `graph/core/scripts/dump-fixture.ts`). Runs the same queries. Asserts node ID lists, edge `(source, target, kind)` tuples, and impact classifications all match the TS expected outputs.
- The fixture JSON is the contract — if the TS-side fixture changes, the Kotlin-side fixture must be re-dumped in the same commit (CI doesn't enforce this yet; add a one-line note to `CLAUDE.md` under the lockstep section).
- **What this catches:** classification-table drift, edge-verb-table drift, BFS tie-breaking divergence, sort-order divergence in `impact[]`. All real risks given the algorithm lives in two languages.

---

## Task 12 — Version bump + docs

- `gradle.properties#pluginVersion` → **`0.5.5`** (patch — additive, no Day 1–5 wire shapes change).
- `vscode-extension/package.json#version` → `0.5.5`.
- `graph/core/package.json`, `graph/webview/package.json` → `0.5.5`.
- `vscode-extension/README.md`: append a one-line entry to the existing tool table for each of the three new MCP tools (link to `graph-mcp-tools.md` §3.2–§3.4 for the schemas).
- `docs/graph-mcp-tools.md` table at §4: change ship-with column for `unity_graph_neighbors`, `unity_graph_impact`, `unity_graph_context` from `Day 6` to a checkmark or leave as-is; the doc is the source of truth so leaving the original is fine.
- Single commit: `Day 6: subgraph navigation + neighbors/impact/context MCP tools`.

---

## Execution order

`1` first (types) so both lanes can compile against the same constants.

Then two parallel lanes:

- **TS lane:** `2` (shared traversal + tests) → `3 → 4 → 5` (MCP tools) → `7 → 8 → 9 → 10` (webview UI). Tasks 3/4/5 are independent of each other once `2` lands; they can be three parallel sub-PRs if useful, but lockstep with Task 6 means landing them together is simpler.
- **Kotlin lane:** `6` (mirror of 3/4/5 in one Kotlin commit), parallelizable with the TS MCP tools.

`11` is the gate before merge — it's the only test that catches TS/Kotlin algorithm drift.

`12` closes out.

**End-to-end manual check before commit:** open Rider on `cbg-client/`, focus a `PlayerController.cs` script with hops=1, then bump hops to 2 via the breadcrumb stepper — node count in status bar should change. Right-click "Show impact" on a prefab, confirm red rings on the directly-using scene(s). Repeat in VS Code on the same path; the visible subgraph (node count, edge count) MUST match within the byte-equivalence guarantee from Task 11. From an external MCP client (Claude Code), `unity_graph_neighbors({node_ids: ["unity://script/Assets/Foo.cs"]})` should return the same node set the webview shows when focused on that node.

---

## Risks already mitigated

- **TS/Kotlin algorithm drift:** Task 11's fixture-driven byte-equivalence test catches classification, ordering, and edge-filter divergence at PR time.
- **Bridge round-trip overhead for focus:** Task 7 keeps focus local to the in-memory Graphology graph — no perceptible delay on click.
- **Layout reset on focus surprises the user:** Task 7 explicitly preserves positions; only visibility changes.
- **Focus + filter composition is undefined:** Task 8 spells out the AND rule and updates status-bar copy so the user sees the intersection cardinality.
- **"Show impact" on an orphan leaf returns nothing useful:** Task 10's `hasIncomingEdges` eligibility hides the action when it would be a no-op.
- **DiagnosticSummary type placeholder collides with Day 10:** Task 1's `// TODO(day-10):` comment is the seam; Day 10 widens the type and both implementations rev together.

---

## Out of scope (deferred)

- `unity_graph_expand` (sub-file detail materialization) — Day 7, paired with incremental updates and the worker-thread layout.
- Streaming/incremental focus updates as the snapshot rebuilds — Day 7.
- Code-domain edges in focus results (class hierarchies, call graphs) — Day 8 adds them to the snapshot; Day 6 traversal handles them automatically the moment they appear.
- Diagnostic badges on focus rings — Day 10 (`include_diagnostics: true` in `unity_graph_context` already returns the data; the badge rendering ships with Day 10's heatmap overlay).
- Saved focus views ("bookmark this subgraph") — Day 11.
- Pattern queries that resemble focus ("all prefabs WHERE uses(script:X)") — Day 12's DSL.
- A11y: keyboard focus navigation through breadcrumb chips, ARIA roles beyond the existing menu — Day 14 polish.
