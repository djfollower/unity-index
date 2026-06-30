# Unity Index Graph — MCP Tool Surface

The MCP tools that expose the graph defined in [`graph-schema.md`](./graph-schema.md). Inspired by GitNexus's `query` / `impact` / `context`, adapted to the `unity_*` naming convention used by the existing tools.

**Goals**
- Cover the full Phase 1 + Phase 2 roadmap so the webview (and external MCP clients) have a stable surface.
- Match the existing tool conventions in `src/main/kotlin/.../tools/` and `vscode-extension/src/tools/` so a single MCP client config works against either variant.
- Keep tools batch-capable from the start. Day 8 (C# code edges) cannot afford per-symbol round-trips.

**Non-goals**
- Not a streaming API. Snapshots are returned whole or paginated; no incremental push to clients.
- Not stateful. Each call is independent; no server-side session/cursor that lives between requests beyond an opaque pagination token.

---

## 1. Conventions

### 1.1 Naming
- All graph tools are prefixed `unity_graph_*`.
- All accept a `project_path` argument resolved via `ProjectResolver` (Kotlin) / `projectResolver.ts` (TS), matching every other tool in the project.
- Optional `request_id` echoed back in the response for client correlation.

### 1.2 Transport
- JSON-RPC 2.0 over the existing Streamable HTTP / Legacy SSE endpoints exposed by `KtorMcpServer.kt` / `httpServer.ts`.
- No new routes. No new ports.

### 1.3 Common request envelope

```ts
interface BaseRequest {
  project_path: string;       // workspace root, resolved by ProjectResolver
  request_id?: string;
}
```

### 1.4 Common response envelope

```ts
interface BaseResponse {
  request_id?: string;
  generated_at: string;       // ISO timestamp
  warnings?: Warning[];       // non-fatal: stale IDs, partial results, dropped nodes
}

interface Warning {
  code: string;               // e.g. "id_unresolved", "lsp_not_ready", "partial_snapshot"
  message: string;
  context?: Record<string, unknown>;
}
```

### 1.5 Error envelope

Fatal errors use JSON-RPC error responses with `code` in the `-32000` range and a structured `data` payload:

```ts
interface RpcError {
  code: number;
  message: string;
  data?: {
    kind: 'project_not_found' | 'project_not_ready' | 'invalid_id'
        | 'invalid_query' | 'budget_exceeded' | 'internal';
    detail?: string;
    retryable?: boolean;
  };
}
```

Non-fatal degradations (one stale ID in a batch of 100, LSP partially indexed, etc.) go through `warnings[]` on a successful response, not errors. Agents should be able to make progress with partial data.

### 1.6 Pagination

Tools that may return >5,000 nodes accept `pagination`:

```ts
interface PageRequest {
  page_size?: number;         // default 5000, max 20000
  cursor?: string;            // opaque; from previous response
}

interface PageResponse {
  next_cursor?: string;       // absent when the snapshot is complete
  total_estimated?: number;   // best-effort total node count
}
```

Cursor is opaque — clients must not parse it. Implementation can encode (offset, snapshot_version) or similar.

---

## 2. Tool inventory

| Tool                        | Phase | Purpose                                                        | Returns                       |
|-----------------------------|-------|----------------------------------------------------------------|-------------------------------|
| `unity_graph_snapshot`      | 1     | Full asset graph (paginated).                                  | `GraphSnapshot`               |
| `unity_graph_neighbors`     | 1     | N-hop neighborhood of one or more node IDs.                    | `GraphSnapshot`               |
| `unity_graph_impact`        | 1     | Reverse-reachable closure (delete-blast-radius).               | `GraphSnapshot` + impact list |
| `unity_graph_context`       | 1     | Agent-friendly: node + 1-hop + flat metadata.                  | `ContextBundle`               |
| `unity_graph_expand`        | 1     | Materialize sub-file detail (component_instance, etc.) for one container. | `GraphSnapshot`     |
| `unity_graph_code_edges`    | 2     | Batch C# edges (calls, inheritance, refs) for N symbols.       | `GraphSnapshot` (edges-heavy) |
| `unity_graph_query`         | 2     | DSL query against the graph.                                   | `QueryResult`                 |

All Phase 1 tools must ship together — they share the same harvest pipeline and node ID scheme. Phase 2 tools layer on top without changing Phase 1 wire shapes.

---

## 3. Tool specifications

### 3.1 `unity_graph_snapshot` (Phase 1)

Full graph harvest of asset-domain nodes and edges. Source of truth for the initial webview render.

**Input**
```ts
interface SnapshotRequest extends BaseRequest {
  include_kinds?: NodeKind[];      // default: all asset kinds (no code nodes)
  exclude_kinds?: NodeKind[];      // applied after include_kinds
  path_globs?: string[];           // include-only filter; standard glob syntax
  include_orphans?: boolean;       // default true; orphan = node with degree 0
  pagination?: PageRequest;
  include_class_anchors?: boolean; // Day 8.4; default false. Materialize one
                                   //   `class` node per `script_declares_class`
                                   //   target so the webview has anchor IDs for
                                   //   Day 8 code-edge expansion. Suppresses
                                   //   the `dangling_csharp_targets` warning.
}
```

**Output**
```ts
interface SnapshotResponse extends BaseResponse {
  snapshot: GraphSnapshot;
  page?: PageResponse;
}
```

**Behavior**
- Asset-domain only by default. To get code nodes, call `unity_graph_code_edges` after.
- `include_class_anchors=true` adds stub `class` nodes (`metadata.anchor=true`, `metadata.declaring_script=<script-id>`) for every `script_declares_class` target. Anchors carry the declaring script's path, so click-through still works; no code edges are emitted until the caller invokes `unity_graph_code_edges`. The two tools intentionally stay split so that opening the panel doesn't pay the cost of a C# index walk.
- `path_globs` filter at the node level; edges between in-scope and out-of-scope nodes are dropped.
- `include_orphans=false` post-filters disconnected nodes; useful for "show me what's actually wired up."
- Sub-file kinds (`component_instance`, `component_field`) are never returned, even if explicitly requested in `include_kinds`. Use `unity_graph_expand` instead. The response carries `warnings: [{ code: 'subfile_kind_ignored' }]` if requested.

**Errors**
- `project_not_found`, `project_not_ready` (Unity asset DB still indexing).

---

### 3.2 `unity_graph_neighbors` (Phase 1)

Subgraph centered on one or more node IDs, out to N hops.

**Input**
```ts
interface NeighborsRequest extends BaseRequest {
  node_ids: string[];              // 1..100
  hops?: number;                   // default 1, max 4
  direction?: 'in' | 'out' | 'both';   // default 'both'
  edge_kinds?: EdgeKind[];         // filter edges considered during traversal
  max_nodes?: number;              // hard cap on returned nodes, default 2000
}
```

**Output**
```ts
interface NeighborsResponse extends BaseResponse {
  snapshot: GraphSnapshot;
  truncated?: boolean;             // true if max_nodes was hit
}
```

**Behavior**
- BFS from each seed; union the results.
- If a seed ID is invalid (refactored, stale), it's dropped with a `warnings: [{ code: 'id_unresolved', context: { id } }]` and traversal continues for the rest.

---

### 3.3 `unity_graph_impact` (Phase 1)

"What breaks if I delete this." Reverse-reachable closure with classification.

**Input**
```ts
interface ImpactRequest extends BaseRequest {
  node_ids: string[];              // 1..50
  max_depth?: number;              // default unlimited
  classify?: boolean;              // default true; tags each impacted node with directness
}
```

**Output**
```ts
interface ImpactResponse extends BaseResponse {
  snapshot: GraphSnapshot;         // impacted subgraph
  impact: ImpactedNode[];
}

interface ImpactedNode {
  id: string;
  distance: number;                // hops from any seed
  classification?: 'direct' | 'transitive' | 'weak'; // weak = referenced only via serialized fields, recoverable
  reason: string;                  // human-readable: "scene 'Main' contains prefab 'Enemy'"
}
```

**Behavior**
- Walks **incoming** edges (e.g. `script_used_by_prefab` traversed prefab → script). The `direction` semantics for impact are fixed; clients use `neighbors` if they want forward.
- `classification.weak` lets agents distinguish "deleting this script breaks compile" from "deleting this asset leaves a missing reference warning."

---

### 3.4 `unity_graph_context` (Phase 1)

Optimized for agent prompts. Returns a single node plus its immediate neighborhood, flattened into a shape that's easy to drop into an LLM context window without further transformation.

**Input**
```ts
interface ContextRequest extends BaseRequest {
  node_id: string;
  include_code_summary?: boolean;  // default true; pulls symbol structure via FileStructureTool for script nodes
  include_diagnostics?: boolean;   // default false; calls GetDiagnosticsTool for the file
  max_neighbors?: number;          // default 50
}
```

**Output**
```ts
interface ContextResponse extends BaseResponse {
  node: GraphNode;
  incoming: EdgeWithEndpoint[];
  outgoing: EdgeWithEndpoint[];
  code_summary?: string;           // present iff node is a script and include_code_summary
  diagnostics?: DiagnosticSummary[];
}

interface EdgeWithEndpoint {
  edge: GraphEdge;
  other: GraphNode;                // the node on the other end
}
```

**Behavior**
- Different return shape from other tools — deliberately. Agents call this when they want to "understand" one thing, not when they want graph data.
- `code_summary` is markdown-ish; not structured. Trade-off accepted for prompt brevity.

---

### 3.5 `unity_graph_expand` (Phase 1)

Materialize sub-file detail (`component_instance`, `component_field`) for one container. Drives the expand-on-demand subgraph view defined in `graph-schema.md` §2.3.

**Input**
```ts
interface ExpandRequest extends BaseRequest {
  container_id: string;            // must be a prefab/scene/so node ID
}
```

**Output**
```ts
interface ExpandResponse extends BaseResponse {
  snapshot: GraphSnapshot;         // contains the container + its component_instance + component_field nodes + internal edges
}
```

**Behavior**
- Only call when the user explicitly drills into a single container. Never called for the project-wide view.
- Returns sub-file nodes that other tools refuse to return.

---

### 3.6 `unity_graph_code_edges` (Phase 2)

Batch C# edge lookup. **Load-bearing for Phase 2 perf** — replaces N round-trips with one.

**Input**
```ts
interface CodeEdgesRequest extends BaseRequest {
  symbol_ids: string[];            // 1..500; unity://csharp/... IDs
  edge_kinds?: ('class_inherits_from' | 'class_implements_interface'
              | 'method_overrides_method' | 'method_calls_method'
              | 'class_references_class')[];   // default: all
  include_targets?: boolean;       // default true; if false, returns edges only (target nodes assumed already known to caller)
}
```

**Output**
```ts
interface CodeEdgesResponse extends BaseResponse {
  snapshot: GraphSnapshot;         // nodes (if include_targets) + edges
  unresolved_ids?: string[];       // symbol IDs we couldn't resolve (stale/refactored)
}
```

**Behavior**
- Internally batches calls to `TypeHierarchyTool` (supertypes → `class_inherits_from` / `class_implements_interface`), `FindSuperMethodsTool` (→ `method_overrides_method`), `CallHierarchyTool` (callees → `method_calls_method`), and `ReferencesSearch` / `executeReferenceProvider` with an enclosing-type walk (→ `class_references_class`).
- For Rider: must use the proven defensive RD-proxy resolution chain documented in `CLAUDE.md` §4. Do not reimplement; reuse `CSharpSymbolResolver` (which delegates to `ClassResolver.findClassByName` + `PlatformFallbacks.findContainingClass`).
- Symbol IDs that can't be resolved go to `unresolved_ids[]`, not errors — partial success is acceptable.
- Pair with `unity_graph_snapshot` using `include_class_anchors=true` (Day 8.4) so the webview has stable `unity://csharp/T:...` node IDs to attach the response edges to.
- The webview also routes through this tool via an in-process bridge handler (`unity_graph_code_edges` wire type) so a click-to-expand never goes over HTTP.

**Known gaps (carry-forward, tracked for a follow-up release)**
- `method_calls_method.metadata.call_sites[].kind` defaults to `'direct'` on both hosts. Rider's `CallElementData` doesn't surface dispatch kind, and Roslyn LSP doesn't expose it through `executeCallHierarchyProvider`. Tightening needs PSI/semantic-tokens inspection of each call expression.
- Method IDs are minted as `M:<owner>.<name>` without a parameter list, because the intermediate data classes don't preserve signatures. Overload disambiguation falls through to first-match-by-name. Full `DocumentationCommentId` round-trip is a separate task.
- Rider currently uses partial-DocId labels for method targets while VS Code uses LSP display names; clients correlating results across hosts should join on label rather than ID until ID generation converges.

---

### 3.7 `unity_graph_query` (Phase 2)

DSL query over the in-memory graph. Specifics of the DSL grammar are deferred to Day 12; this tool reserves the surface.

**Input**
```ts
interface QueryRequest extends BaseRequest {
  query: string;                   // DSL string
  return_shape?: 'snapshot' | 'rows';   // default 'snapshot'
  max_results?: number;            // default 1000
}
```

**Output**
```ts
type QueryResponse =
  | (BaseResponse & { snapshot: GraphSnapshot })
  | (BaseResponse & { rows: Record<string, unknown>[]; columns: string[] });
```

**Errors**
- `invalid_query` with `detail` carrying parse position.

---

## 4. Phase 1 vs Phase 2

| Tool                     | Phase | Ships with    |
|--------------------------|-------|---------------|
| `unity_graph_snapshot`   | 1     | Day 2         |
| `unity_graph_neighbors`  | 1     | Day 6         |
| `unity_graph_impact`     | 1     | Day 6         |
| `unity_graph_context`    | 1     | Day 6         |
| `unity_graph_expand`     | 1     | Day 6 or 7    |
| `unity_graph_code_edges` | 2     | Day 8         |
| `unity_graph_query`      | 2     | Day 12        |

All tools are present in the schema docs from day one so the webview can be coded against the final surface and degrade gracefully (e.g. hide "Show impact" until the tool reports as available).

---

## 5. Lockstep requirements (per CLAUDE.md)

Every change to this surface lands in both implementations in the same commit:

- **Kotlin side**: tools under `src/main/kotlin/com/github/dungphan/unityindex/tools/unity/`, registered in `ToolRegistry.kt`, with `@Serializable` request/response data classes in `tools/models/`.
- **TS side**: tools under `vscode-extension/src/tools/unity/`, registered alongside existing Unity tools, with matching interfaces in `vscode-extension/src/tools/models/`.
- **Wire format is the contract.** Field names, JSON shape, error codes match exactly. If a feature can only be implemented on one side (e.g. a Rider-only Roslyn capability), document the gap in `vscode-extension/README.md` rather than silently diverging.

---

## 6. Open questions deferred to implementation

- **Snapshot freshness.** Does `unity_graph_snapshot` rebuild on every call, or cache with invalidation? Lean toward rebuild + Day 7 incremental updates; revisit if Day 2 measurements show it's too slow.
- **Cursor encoding.** Opaque, but implementations need to agree on what's encoded (offset? content-hash + offset? snapshot version?). Decide in Day 2 PR.
- **`unity_graph_query` DSL.** Roll-our-own vs. embedded Cypher subset (e.g. `cypher-query-language` npm package). Decide in Day 12.
- **Streaming.** If snapshots regularly exceed 50k nodes, consider a streaming variant. Not a Phase 1 concern.
- **Webview ↔ server transport.** Webview can call MCP tools directly (in-process from the extension) or over the same HTTP/SSE surface external clients use. Recommend in-process for the webview to avoid the JSON-RPC overhead, but the data shapes are identical.
