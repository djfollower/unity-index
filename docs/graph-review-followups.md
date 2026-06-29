# Graph review — follow-ups

Notes from the high-effort review on `feature/graph` (commits `3b98829..7c8792d`). Two confirmed bugs were fixed: TS `fileId` precision loss and the duplicate `m_SourcePrefab.guid` fallback. Everything below is unfinished work from the same review.

---

## Unverified findings from the first pass

Each was flagged with a plausible failure scenario but not deep-dived. Confirm or refute before fixing.

### Performance

- ~~**O(n²) scene-contains-prefab dedup**~~ — Fixed in both `UnityAssetGraphBuilder.kt` (Kotlin) and `unityAssetGraphBuilder.ts` (TS) by switching to a `Map<(sceneId,targetId), count>` aggregate that mirrors the existing `serialized_binding` pattern. Existing builder test suite (7 tests) still passes.

### EDT freeze on big projects (0.5.4) — fixed, but related work remains

`UnityGraphSnapshotTool` wrapped the entire builder in `suspendingReadAction`, holding the platform read lock through a multi-minute VFS walk and freezing the EDT for ~649s on a real big project. Fixed by switching to `withContext(Dispatchers.IO)` — the builder touches no PSI. Still open from the same incident:

- The webview↔host bridge has a **30 s default timeout** (`graph/core/src/host-bridge.ts:71`, `graph/webview/src/lib/snapshot.ts:16`). On big projects the snapshot legitimately takes longer; the webview gives up while the IDE keeps working. Decide: bump the timeout, add progress reporting, or chunk/stream the snapshot. Don't pick until the O(n²) fix above lands and we re-measure.

### Correctness

- **Search with zero matches blanks the canvas** — `App.svelte:157`. When `relatedRef` is empty the reducer hides every node and there's no empty-state copy. UX bug, not a crash.
- **`rel.startsWith("..")` false-positives a literal `..foo` directory** — `vscode-extension/src/graphHost/hostHandlers.ts:190`. Anchor on a segment boundary: `rel === ".." || rel.startsWith(".." + path.sep)`.
- **Kotlin `relativize` fragile on Windows** — `UnityAssetGraphBuilder.kt:494` strips only a single forward slash. If `basePath` and `absolutePath` ever disagree on drive-letter case or trailing slash, `removePrefix` is a no-op and the "relative" path comes out absolute, producing diverged node IDs vs the TS side. Use `java.nio.file.Path.relativize` with normalized paths.
- **`fuzzyScore('')` returns 1** — `graph/webview/src/lib/fuzzy.ts:13`. `computeMatches` guards it, but `fuzzyMatches` (exported sibling) will return true for any haystack. Future caller using `fuzzyMatches` for prefiltering gets "match everything" on the first keystroke.

### State / lifecycle

- **`hydrateFilterState` read-after-write race** — `App.svelte:433`. `presentKinds` is `$state` written inside `renderSnapshot` and read synchronously immediately after; under any future Svelte runtime change where `$state` writes batch/defer, every stored hidden-kind gets reconciled as "not present" and silently dropped. Pass `presentKinds` explicitly or call `collectPresentKinds(currentGraph)` directly.
- **`makeVsCodeBridge` re-adds `window.message` listener** — `graph/webview/src/bridge/vscode.ts:18`. Each call adds another listener and never removes it; if the bridge is ever re-init'd (HMR, manual reload), prior closures keep firing on every message.
- **`componentInstanceId(fileId: string)` is correct now, but** — `graphIds.ts:26`. Type-system doesn't prevent a future caller from passing a number that's been parseInt'd elsewhere. Worth a brand/opaque type if any other call sites grow.

---

## Surfaces I didn't read

The diff is ~11.5k lines across 86 files. I covered the asset-graph builders (both languages), both bridge implementations, the host handlers, the webview entry + drag + filter + fuzzy + IDs. Untouched:

- **Kotlin Day 5 plumbing** — `GraphFilterStateService.kt`, `GraphBridgeProtocol.kt` envelope shapes, the Rider bridge-race fix in commit `9bba807` (only skimmed).
- **Svelte components themselves** — `SelectionPanel.svelte`, `FilterSidebar.svelte`, `SearchBar.svelte`, App.svelte's CSS, search debouncing, scrolling behaviour.
- **Existing test file** — `vscode-extension/src/utils/__tests__/unityAssetGraphBuilder.test.ts` (426 lines). Reading it would tell us which invariants are locked vs which can drift silently.
- **`unityAssetIndexManager.ts`** — invalidation, lifecycle, cache eviction. Important because the host bridge reuses the index across multiple snapshot calls.
- **Build pipeline** — Gradle `copyGraphBundle` task, `vscode-extension/scripts/package.js`, Vite config (`base: './'`, single-file plugin assumptions, ES2022 target), CSP-meta injection.
- **VS Code activation/teardown** — `extension.ts` graph-panel command registration, dispose order, what happens when the workspace switches Unity projects mid-session.
- **Day 5 test files** — `eligibility.test.ts`, `filter.test.ts`, `fuzzy.test.ts`, `snapshotToGraph.test.ts`. Could reveal assumption mismatches with the runtime code.
- **`window.d.ts`, `noop.ts`** — small but type-shape contract.

---

## How to resume

Recommended order when picking this back up:

1. Read `unityAssetGraphBuilder.test.ts` first — it locks in what the builder is supposed to do; gaps there are silent risk.
2. Verify the perf finding (O(n²) scene dedup) — generate a synthetic scene with 1000 PrefabInstance docs, time the builder, decide if worth fixing now.
3. Triage the remaining unverified findings into confirm/refute/wontfix.
4. Then either run the original Phase-1 parallel finder agents on the untouched files, or move on if perceived ROI is low.
