# Day 2 — Task breakdown

Source: [`unity-index-graph-plan.md`](unity-index-graph-plan.md) §Day 2.

**Day 2 goal:** ship `unity_graph_snapshot` in both the Rider plugin and the VS Code extension. One MCP call returns the full asset-domain `GraphSnapshot` defined in [`graph-schema.md`](./graph-schema.md). Webview wiring is Day 3 — Day 2 is server-only.

**Source of truth:** [`graph-schema.md`](./graph-schema.md) for node/edge shapes and IDs; [`graph-mcp-tools.md`](./graph-mcp-tools.md) §3.1 for the request/response envelope. Where the older plain-prose Day 2 in `unity-index-graph-plan.md` disagrees with the schema doc (e.g. it lists `scene_contains_component`, `serialized_field_binds`, `guid_resolves_to` as edge kinds; it lists `component_instance` as a node kind), the schema doc wins. Day 2 emits the schema's edge taxonomy (`script_used_by_prefab`, `script_used_by_scene`, `scene_contains_prefab`, `serialized_binding`, `prefab_variant_of`, `script_declares_class`) and never emits `component_instance` as a top-level node — instance IDs ride along as edge metadata.

**Lockstep rule:** every wire-shape change lands in both Kotlin and TS in the same commit. JSON field names are the contract.

---

## Task 1 — Lock the wire types in `graph/core/`

`graph/core/` already exists from Day 1 and is the canonical home for the TS schema (per `graph-schema.md` §5). Make it the single source the webview and the VS Code host both import.

- `graph/core/src/graph-types.ts` (new): export `NodeKind`, `EdgeKind`, `GraphNode`, `GraphEdge`, `GraphSnapshot` exactly as in `graph-schema.md` §5. No additions, no renames.
- `graph/core/src/snapshot-wire.ts` (new): export `SnapshotRequest`, `SnapshotResponse`, `BaseResponse`, `Warning`, `PageRequest`, `PageResponse`, `RpcError` exactly as in `graph-mcp-tools.md` §1 + §3.1.
- `graph/core/src/index.ts`: re-export both. Webview and host import types only (`import type`) — graph-core stays type-only at the host boundary, consistent with the Day 1 deviation note.
- No tests on the type module — Vitest covers behavior, not type declarations.

**Output:** types compile under `tsc --noEmit` from both `vscode-extension/` and `graph/webview/`.

---

## Task 2 — Kotlin: `GraphSnapshot` models

Mirror the TS types as `@Serializable` Kotlin data classes so JSON-RPC serialization is automatic.

- `src/main/kotlin/com/github/dungphan/unityindex/tools/models/GraphSnapshotModels.kt` (new):
  - `GraphNode`, `GraphEdge`, `GraphSnapshot`, `GraphStats` matching §5 of the schema doc.
  - `NodeKind` and `EdgeKind` as `enum class` with `@SerialName` per kind so the wire string is the same camel/snake-case as TS (`script_used_by_prefab`, etc.).
  - `metadata: JsonObject` (kotlinx) — free-form per the schema. Do not introduce per-kind metadata data classes; that's premature and forces lockstep on metadata shape we haven't fully settled.
- `SnapshotRequest`, `SnapshotResponse`, `PageRequest`, `PageResponse`, `Warning` as `@Serializable` mirror types in the same file (or `GraphWireModels.kt` if separation reads cleaner — keep the file count low).

**Why a flat metadata blob:** schema doc §2.4 declares it free-form. Locking down a typed metadata model would mean a third lockstep surface (Kotlin model + TS interface + per-kind union) that we'd have to rev every time we add a metadata key. JSON object is enough until Phase 2.

---

## Task 3 — Kotlin: `UnityAssetGraphBuilder`

Pure builder over the existing `UnityAssetIndex` + `UnityYamlParser`. **No new YAML parsing.** This is the load-bearing principle from `CLAUDE.md` — exploit the existing index.

- `src/main/kotlin/com/github/dungphan/unityindex/util/UnityAssetGraphBuilder.kt` (new):
  - Single entry point: `fun build(project: Project, request: SnapshotRequest): GraphSnapshot`.
  - Pulls from `UnityAssetIndex.create(project)`. Reuses its GUID resolver, prefab/scene parsing, MonoBehaviour script links, serialized-field binding map. **Do not re-walk the asset tree** if `UnityAssetIndex` already exposes it; extend it minimally if it doesn't.
  - Emits one `script` node per `.cs` (workspace-relative path → URI), one `prefab` / `scene` / `so` / `asset` node per file (GUID → URI). `addressable_group` only if detected — skip on Day 2 if the index doesn't already track it (file a follow-up rather than parsing addressable assets fresh).
  - `prefab_variant` is a node kind, not an edge — set `kind=prefab_variant` and add a `prefab_variant_of` edge to the source prefab.
  - Edge emission (per schema §3.1 / §3.3):
    - `script_used_by_prefab` — per (script, prefab) pair, with `component_instance_ids: string[]` aggregated across instances.
    - `script_used_by_scene` — same, per (script, scene).
    - `scene_contains_prefab` — per (scene, prefab) with `instance_count`.
    - `serialized_binding` — aggregated per (owner, target) with `bindings: { field_name, component_instance_id }[]`. **One edge per pair**, not one per field. Owner ∈ {prefab, scene, so}; target = anything.
    - `script_declares_class` — one per script, target ID synthesized as `unity://csharp/T:<namespace>.<ClassName>` using the filename rule from schema §1.3. Namespace inference: leave blank (`unity://csharp/T:<ClassName>`) on Day 2 if the asset index doesn't already record it. The `csharp` node is **not** emitted by Day 2 — only the edge dangles toward an ID the Day 8 harvest will fill in. Document this in the snapshot's `warnings[]` if any such edges are emitted (one summary warning per build, not one per script).
    - `prefab_variant_of` — when a prefab's YAML has `m_PrefabAsset` → `m_PrefabInstance`, link variant → base.
  - **No `component_instance` nodes.** Count them and report in `stats.skipped_component_instances`. Same for `component_field` → `stats.skipped_component_fields`.
  - **No `guid_resolves_to` edges.** Schema §3.1 marks them "mostly internal." Skip on Day 2.
- Filtering inside the builder (request-driven):
  - `include_kinds`, `exclude_kinds`, `path_globs`, `include_orphans` applied at node level after harvest; edges between in-scope and out-of-scope nodes are dropped (per `graph-mcp-tools.md` §3.1).
  - If `include_kinds` mentions `component_instance` or `component_field`, drop them silently and add a `{ code: 'subfile_kind_ignored' }` warning to the response.

**Reuse boundary:** if `UnityAssetIndex` exposes a binding map keyed by (owner-guid, target-guid), reuse it directly. If it only exposes "given a GUID, find references," call it once per asset is fine for Day 2 — perf is Day 7's problem.

---

## Task 4 — Kotlin: `UnityGraphSnapshotTool` + registration

The MCP-facing wrapper. Thin.

- `src/main/kotlin/com/github/dungphan/unityindex/tools/unity/UnityGraphSnapshotTool.kt` (new):
  - Extends `AbstractMcpTool`. `requiresPsiSync = false` (no PSI involved).
  - `name = ToolNames.UNITY_GRAPH_SNAPSHOT` (add constant to `ToolNames.kt`).
  - `description`: short paragraph + parameter list, in the same voice as `FindAssetReferencesTool`.
  - `inputSchema` via `SchemaBuilder` — `projectPath()`, `arrayProperty("include_kinds")`, `arrayProperty("exclude_kinds")`, `arrayProperty("path_globs")`, `boolProperty("include_orphans")`, plus a `pagination` object. If `SchemaBuilder` has no array/object helpers yet, add them — keep them generic.
  - `doExecute` decodes `SnapshotRequest` from `arguments`, calls `UnityAssetGraphBuilder.build(...)`, wraps into `SnapshotResponse` with `generated_at = Instant.now()`, returns via `createJsonResult`.
  - Pagination: opaque cursor. Encode `Base64(JSON({ snapshot_version: <epoch-millis>, offset: <int> }))`. The builder always rebuilds — pagination just slices the resulting `nodes[]` array. Document the encoding inline (one line, no external doc — cursor is opaque to clients).
- `ToolRegistry.kt`: register inside `registerUnityTools()`. Order doesn't matter; alphabetize roughly with the other Unity tools.
- `ToolNames.kt`: add `const val UNITY_GRAPH_SNAPSHOT = "unity_graph_snapshot"`.

---

## Task 5 — TS: `UnityAssetGraphBuilder`

Mirror Task 3 in TypeScript using `unityAssetIndex.ts` + `unityYaml.ts`. **Same algorithm, same edge dedup rules, same warning codes** — the JSON output of the two builders must be byte-equivalent for the same project.

- `vscode-extension/src/utils/unityAssetGraphBuilder.ts` (new):
  - Single entry point: `export async function buildAssetGraph(workspace: vscode.WorkspaceFolder, request: SnapshotRequest): Promise<GraphSnapshot>`.
  - Pulls from `unityAssetIndexManager.ts`. Reuses GUID resolver, prefab/scene maps, serialized-field bindings.
  - Emits the same node + edge taxonomy as Task 3. Same `unity://` URI builders — factor `buildScriptId`, `buildPrefabId`, etc. into `vscode-extension/src/utils/graphIds.ts` so the snapshot tool and the Day 6 neighbors tool both call them.
  - Same `csharp` URI dangling-edge behavior + summary warning.
  - Same pagination + filtering.
- `vscode-extension/src/utils/graphIds.ts` (new): URI builders. Add a parallel Kotlin file `GraphIds.kt` in `util/` so both sides have a one-stop helper — small duplication is fine because the IDs are stable and the URI shape is one line each.

**Lockstep gut check:** an end-to-end snapshot of `cbg-client/Assets/AlleyLabs.Game.AnimalDungeon` taken from the Kotlin tool and the TS tool, sorted by `id`, should match field-for-field. This is the Day 2 acceptance criterion (see Task 8).

---

## Task 6 — TS: `unityGraphSnapshotTool.ts` + registration

Mirror Task 4.

- `vscode-extension/src/tools/unity/unityGraphSnapshotTool.ts` (new): extends `AbstractTool`, `name: 'unity_graph_snapshot'`, decodes the request, calls `buildAssetGraph`, returns `SnapshotResponse`.
- Same `schemaBuilder` call shape; if `vscode-extension/src/utils/schema.ts` lacks array/object helpers, add them in lockstep with the Kotlin `SchemaBuilder`.
- Register alongside other Unity tools in whatever the TS equivalent of `ToolRegistry.registerUnityTools` is (`vscode-extension/src/tools/registry.ts` or `extension.ts`).
- Add the tool name to any shared name constant file the TS side uses.

---

## Task 7 — Vitest: builder unit tests

Per `graph-decisions.md`, Vitest is in `graph/core/`. The TS builder lives in `vscode-extension/`, but harvest logic is testable with a synthetic project tree on disk.

- `vscode-extension/src/utils/__tests__/unityAssetGraphBuilder.test.ts` (new) — or under `graph/core/` if we move the builder there in a future cleanup. For Day 2, keep it next to the source.
- Fixtures under `vscode-extension/src/utils/__tests__/fixtures/asset-graph/` — a 4-asset toy project: one script, one prefab using the script, one scene containing the prefab, one ScriptableObject. Hand-written .meta + .prefab + .unity YAML; ~50 lines total.
- Cases:
  - Happy path: 4 nodes + the expected edges, IDs match schema §1.
  - Prefab variant: variant prefab → `prefab_variant_of` edge + `kind=prefab_variant`.
  - Serialized binding aggregation: a prefab with three fields pointing to the same target → one `serialized_binding` edge with `bindings.length === 3`.
  - `include_kinds: ['component_instance']` → warning `subfile_kind_ignored`, no such nodes in output.
  - `include_orphans: false` → orphan asset dropped.
  - `path_globs: ['Assets/Foo/**']` → out-of-scope nodes dropped, edges crossing the boundary dropped.
  - Stats: `skipped_component_instances` non-zero on a prefab with components.
- Kotlin equivalent: not required Day 2. The TS tests cover the algorithm; the Kotlin builder is verified end-to-end by the cross-impl diff in Task 8.

---

## Task 8 — Cross-implementation byte-equivalence check

Lockstep gut check. Not automated on Day 2; a manual one-shot verification before commit.

- Pick the existing real project sample: `cbg-client/Assets/AlleyLabs.Game.AnimalDungeon` (referenced in `graph-decisions.md` §rendering as ~13k file-level nodes).
- Call `unity_graph_snapshot` against Rider (port 29170) and VS Code (port 29270), saving outputs to `/tmp/snap-rider.json` and `/tmp/snap-vscode.json`.
- Diff after sorting nodes by `id` and edges by `(source, target, kind)`. Any non-trivial diff is a lockstep bug to fix before commit.
- Acceptance: `stats.node_count`, `stats.edge_count`, `stats.skipped_component_instances` match exactly. Per-node `metadata` may differ in key order but not in content (decode and compare via a small jq filter — leave that filter in the PR description, no script committed).

### Recommended one-shot procedure

```bash
# Save both snapshots through the existing MCP HTTP endpoint:
curl -s -X POST http://127.0.0.1:29170/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"unity_graph_snapshot","arguments":{}}}' \
  | jq -r '.result.content[0].text' > /tmp/snap-rider.json
curl -s -X POST http://127.0.0.1:29270/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"unity_graph_snapshot","arguments":{}}}' \
  | jq -r '.result.content[0].text' > /tmp/snap-vscode.json

# Sort + normalize before diffing — both implementations emit nodes/edges in
# walk order, which differs between VFS and Node fs.
jq '.snapshot.stats' /tmp/snap-rider.json /tmp/snap-vscode.json
jq '{
  nodes: (.snapshot.nodes | sort_by(.id)),
  edges: (.snapshot.edges | sort_by([.source, .target, .kind]))
}' /tmp/snap-rider.json > /tmp/snap-rider.norm.json
jq '{
  nodes: (.snapshot.nodes | sort_by(.id)),
  edges: (.snapshot.edges | sort_by([.source, .target, .kind]))
}' /tmp/snap-vscode.json > /tmp/snap-vscode.norm.json
diff -u /tmp/snap-rider.norm.json /tmp/snap-vscode.norm.json | head -100
```

Tolerated differences:
- Metadata key order — both producers emit JSON object keys in insertion order; `jq` normalizes for the diff.
- `generated_at` timestamps — different per call, ignore.

Anything else is a lockstep bug.

---

## Task 9 — Docs

- `docs/graph-mcp-tools.md` §3.1 — already specifies `unity_graph_snapshot`. **No change to the spec.** If the implementation discovers a divergence, the spec wins and the implementation changes.
- `docs/mcp-tools.md` (the existing per-tool catalog the README points to, if any — check before writing): append `unity_graph_snapshot` with a one-paragraph blurb and an example invocation. If no such doc exists yet, defer to Day 14's packaging pass — don't invent a doc for one tool.
- `vscode-extension/README.md` — add `unity_graph_snapshot` to the tool list. Keep the entry to one line; the wire details live in `graph-mcp-tools.md`.
- README parity: same line in the root `README.md` tool list.

---

## Task 10 — Lockstep version bump

Day 2 changes the wire surface (new tool). Per `CLAUDE.md` lockstep rules:

- Bump `gradle.properties#pluginVersion` to `0.5.1` (patch — new tool is additive, no breaking change to existing tools).
- Bump `vscode-extension/package.json#version` to match.
- Mirror `0.5.1` into `graph/core/package.json` and `graph/webview/package.json` (the latter unchanged in Day 2 but versioned in lockstep).
- One commit, message: `Day 2: unity_graph_snapshot in both extensions`.

---

## Execution order

`1 → 2 → 3 → 4` strictly sequential on the Kotlin side; `1 → 5 → 6` on the TS side. Tasks 3+4 and 5+6 are parallelizable across the two sides once Task 1 lands. Task 7 (tests) can begin alongside Task 5 with fixtures. Task 8 (cross-impl diff) is the gate before Task 10 commit.

`9` and `10` close out.

---

## Risks already mitigated

- **Schema/plan drift:** the plan's edge list disagrees with the schema doc; this breakdown defers to the schema doc explicitly so we don't ship two different wire shapes.
- **Sub-file explosion:** ~310k component instances on a real Unity project would blow up the snapshot. Schema §2.3 plus this breakdown keep them out of top-level nodes and into edge metadata + stats counters.
- **csharp dangling IDs:** Day 2 emits `script_declares_class` edges to `csharp` IDs that won't be materialized until Day 8. Documented as one summary warning per snapshot so clients (including the webview) can ignore unresolved targets without surprise.
- **Lockstep divergence:** Task 8 acts as the byte-equivalence gate before commit.

---

## Out of scope (deferred from Day 2 prose)

- Pagination perf (Day 7 owns it; Day 2 implements correctness via slice-after-build, not chunked harvest).
- Incremental updates / file watcher (Day 7).
- Webview rendering (Day 3).
- C# / code edges (Day 8).
- Addressables harvest beyond what `UnityAssetIndex` already tracks (file follow-up if missing).
- `guid_resolves_to` edges (schema marks "mostly internal").
- DSL queries (Day 12).
