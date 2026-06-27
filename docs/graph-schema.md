# Unity Index Graph — Schema

The load-bearing design contract. Every later day of `unity-index-graph-plan.md` builds against this.

**Goals**
- One node ID for any entity, whether discovered from YAML harvest or Roslyn lookup. Edges must always match.
- File-level rendering by default; sub-file detail preserved as metadata, not nodes.
- Stable enough that node IDs survive file moves where Unity itself preserves identity (i.e. GUIDs).

**Non-goals**
- Not a Cypher-compatible schema. We borrow concepts from GitNexus / property-graph DBs but the wire format is plain JSON over MCP.
- Not a persistence schema. The graph lives in memory; this doc describes the in-memory + wire shape only.

---

## 1. Symbol ID scheme

A single uniform URI scheme. One ID format end to end, parsable with a single regex, easy to log, easy to debug.

```
unity://<kind>/<key>[#<sub>]
```

| Kind         | Key                                       | Example                                                          | Stable across |
|--------------|-------------------------------------------|------------------------------------------------------------------|---------------|
| `script`     | workspace-relative path                   | `unity://script/Assets/Foo/PlayerController.cs`                  | file rename invalidates ID (intentional — see §1.2) |
| `prefab`     | Unity GUID                                | `unity://prefab/8c1f3e9b4d7a4c5e9f1a2b3c4d5e6f70`                | rename, move, refactor |
| `scene`      | Unity GUID                                | `unity://scene/1a2b3c4d5e6f70718c1f3e9b4d7a4c5e`                 | rename, move |
| `so`         | Unity GUID                                | `unity://so/<guid>` (ScriptableObject)                           | rename, move |
| `asset`      | Unity GUID                                | `unity://asset/<guid>` (material/texture/audio/etc.)             | rename, move |
| `csharp`     | Roslyn DocumentationCommentId             | `unity://csharp/T:AlleyLabs.Foo.Bar`<br>`unity://csharp/M:AlleyLabs.Foo.Bar.Baz(System.Int32)` | refactor preserves; rename does not |
| `component`  | `<owner-guid>/<fileID>` (sub-file only)   | `unity://component/8c1f.../-7332817840205590843`                 | until owner prefab is re-saved |
| `field`      | `<owner-id-base64>/<fieldName>` (sub-file)| `unity://field/dW5pdHk6Ly9j.../targetPrefab`                     | until owner is edited |

### 1.1 Why this scheme

- **Single parsable format.** `unity://<kind>/<rest>` — one regex, one switch.
- **GUIDs for asset stability.** Unity assigns a GUID to every asset; it survives renames and moves. A prefab's node ID never changes for a refactor, so edges don't dangle.
- **Paths for scripts.** Counterintuitive but deliberate: scripts have GUIDs too (`Foo.cs.meta`), but a script *file* is most often referenced by code, not by GUID. Path is the natural key for editor jumps. The GUID is stored as node metadata for cross-checking. (See §1.3 for the script ↔ class bridge.)
- **Roslyn DocId for code.** Industry-standard, stable through method body edits, captures arity + parameter types (so overloads don't collide).
- **Sub-file kinds keyed by owner.** Component and field IDs embed their owner's ID so the parent can always be recovered. They're never top-level nodes (see Day 0.B), but agents may still pass them around.

### 1.2 Stability rules

- A node ID is **stable** for as long as the underlying Unity entity preserves its GUID, or the C# symbol preserves its DocId.
- A script file rename **invalidates** its `unity://script/...` ID. Mitigation: when a graph snapshot is rebuilt, the new path becomes the new ID; the old ID is dropped from the graph. The script GUID (from `.meta`) is preserved as node metadata so dangling edges in a stale snapshot can be repaired by a follow-up call.
- A C# rename refactor invalidates the DocId. We do not attempt rename tracking; clients are expected to re-query after refactors.

### 1.3 The script ↔ class bridge

The single most important consistency rule. A Unity script file always declares one primary public class with the same name as the file (Unity enforces this). The bridge:

```
unity://script/Assets/Foo/PlayerController.cs   ⟷   unity://csharp/T:<namespace>.PlayerController
```

- Schema **must** record this pairing as a `script_declares_class` edge on every `script` node.
- When a YAML harvest produces a `script_used_by_prefab` edge targeting a `script` node, the C# enrichment phase (Day 8) follows the bridge to attach call edges to the corresponding `csharp` node.
- If multiple top-level classes exist in one file, the primary (filename-matching) one is the bridge target. Others are still represented as `csharp` nodes but don't get the bridge.

---

## 2. Node taxonomy

### 2.1 File-level node kinds (rendered by default)

| Kind                | Source                              | Phase | Notes |
|---------------------|-------------------------------------|-------|-------|
| `script`            | `.cs` file                          | 1     | One node per file. Bridges to `csharp` via §1.3. |
| `prefab`            | `.prefab` file                      | 1     | |
| `prefab_variant`    | `.prefab` with `m_PrefabAsset` ref  | 1     | Sub-kind of `prefab`; carries `variant_of` metadata. |
| `scene`             | `.unity` file                       | 1     | |
| `so`                | `.asset` with MonoScript ref        | 1     | ScriptableObject. |
| `asset`             | catch-all (`.mat`, `.png`, `.wav`, `.shader`, `.controller`, `.anim`, `.fbx`, …) | 1 | One node per file; `asset_type` field carries the extension. |
| `addressable_group` | `AddressableAssetGroup.asset`       | 1     | Only if Addressables are detected in the project. |

### 2.2 Code node kinds (rendered by default in Phase 2)

| Kind        | Source                              | Phase | Notes |
|-------------|-------------------------------------|-------|-------|
| `namespace` | Roslyn                              | 2     | Collapsible container. |
| `class`     | Roslyn                              | 2     | |
| `interface` | Roslyn                              | 2     | |
| `struct`    | Roslyn                              | 2     | |
| `enum`      | Roslyn                              | 2     | |
| `method`    | Roslyn                              | 2     | Lazy: only materialized when a class is expanded. |
| `property`  | Roslyn                              | 2     | Lazy. |
| `field`     | Roslyn (code field)                 | 2     | Lazy. Not to be confused with `component_field` below. |

> Note: all code nodes use the `csharp` URI kind (`unity://csharp/T:...`, `unity://csharp/M:...`). Node `kind` (`class`, `method`, …) is a property; the URI prefix lets us identify code symbols generically.

### 2.3 Sub-file kinds (never top-level; edge metadata or expand-on-demand)

| Kind               | Source                              | Phase | Notes |
|--------------------|-------------------------------------|-------|-------|
| `component_instance` | `--- !u!N &fileID` block in prefab/scene YAML | 1 | ~310k per Assets subfolder in real projects. Rendered only inside a focused prefab/scene subgraph view. |
| `component_field`  | `[SerializeField]` value in YAML    | 1     | Same constraint. The serialized field binding, not the C# field declaration. |

### 2.4 Common node fields

Every node carries:

```ts
{
  id: string;                 // unity:// URI
  kind: string;               // one of the kinds above
  label: string;              // display name (filename, class name, etc.)
  path?: string;              // workspace-relative path (always present for file-level nodes)
  guid?: string;              // Unity GUID if applicable (always for assets; also for scripts via .meta)
  location?: { line: number; column?: number };  // for code nodes
  metadata: Record<string, unknown>;             // free-form per-kind extras
}
```

Per-kind metadata examples:
- `script`: `{ guid, primary_class_id, namespace, declared_types: string[] }`
- `prefab`: `{ guid, variant_of?: id, component_count: number }`
- `scene`: `{ guid, root_object_count, component_count }`
- `class`: `{ namespace, is_monobehaviour: bool, supertype_ids: id[], diagnostic_count?: number }`
- `asset`: `{ guid, asset_type: "material" | "texture" | "audio" | ... }`

---

## 3. Edge taxonomy

All edges are directed. Cardinality is many-to-many unless stated.

### 3.1 Asset edges (Phase 1)

| Kind                       | From → To                | Carries                                                                 |
|----------------------------|--------------------------|-------------------------------------------------------------------------|
| `script_used_by_prefab`    | `script` → `prefab`      | `component_instance_ids: string[]` (every component on the prefab that uses this script) |
| `script_used_by_scene`     | `script` → `scene`       | `component_instance_ids: string[]` |
| `scene_contains_prefab`    | `scene` → `prefab`       | `instance_count: number` |
| `prefab_variant_of`        | `prefab` → `prefab`      | (no extras) |
| `serialized_binding`       | (owner) → (target)       | `bindings: { field_name: string, component_instance_id: string }[]`<br>Owner is a `prefab`/`scene`/`so`; target is any asset/script/prefab/scene. Aggregated per `(owner, target)` pair so we don't get N edges between the same two nodes. |
| `guid_resolves_to`         | `<any with guid>` → `<any>` | Only emitted when a `.meta` GUID is referenced but resolution requires extra work. Mostly internal. |
| `addressable_group_contains` | `addressable_group` → `<any>` | Only if Addressables present. |

### 3.2 Code edges (Phase 2)

| Kind                        | From → To                | Carries                                                       |
|-----------------------------|--------------------------|---------------------------------------------------------------|
| `class_inherits_from`       | `class` → `class`        | (no extras) |
| `class_implements_interface`| `class` → `interface`    | (no extras) |
| `method_overrides_method`   | `method` → `method`      | (no extras) |
| `method_calls_method`       | `method` → `method`      | `call_sites: { line: number, kind: 'virtual'\|'direct'\|'interface' }[]` |
| `class_references_class`    | `class` → `class`        | Aggregate of method-level references at the class level (cheaper view). |

### 3.3 Cross-domain bridge edges

| Kind                       | From → To                | Carries                              |
|----------------------------|--------------------------|--------------------------------------|
| `script_declares_class`    | `script` → `class`       | The §1.3 bridge. Emitted once per script. |

### 3.4 Common edge fields

```ts
{
  source: string;            // node id
  target: string;            // node id
  kind: string;              // one of the kinds above
  metadata: Record<string, unknown>;   // edge-kind-specific (see "Carries" columns above)
}
```

No edge ID. The tuple `(source, target, kind)` is unique. Re-deriving the same edge in a refresh replaces its `metadata` in place.

---

## 4. Reference kinds (edge subtypes)

For edges that have meaningful variants, the variant lives in `metadata.kind` (or per-call-site `kind`) rather than as a top-level edge kind. This keeps the edge taxonomy small.

- `method_calls_method.call_sites[].kind`: `direct` | `virtual` | `interface` | `delegate`
- `serialized_binding.bindings[]`: implicit kind from the target's node kind (`asset`, `prefab`, `script`, `scene`, `so`)
- `script_used_by_prefab` / `script_used_by_scene`: no subtype needed; usage is uniform.

Rationale: Day 12's query DSL benefits more from a flat edge taxonomy with rich metadata than from a deep hierarchy.

---

## 5. The schema in TypeScript

The canonical type definitions, used by `graph/core/`. Both Kotlin and TS implementations of MCP tools serialize to this shape exactly.

```ts
export type NodeKind =
  | 'script' | 'prefab' | 'prefab_variant' | 'scene' | 'so' | 'asset' | 'addressable_group'
  | 'namespace' | 'class' | 'interface' | 'struct' | 'enum'
  | 'method' | 'property' | 'field'
  | 'component_instance' | 'component_field';

export type EdgeKind =
  // asset
  | 'script_used_by_prefab' | 'script_used_by_scene'
  | 'scene_contains_prefab' | 'prefab_variant_of'
  | 'serialized_binding' | 'guid_resolves_to' | 'addressable_group_contains'
  // code
  | 'class_inherits_from' | 'class_implements_interface'
  | 'method_overrides_method' | 'method_calls_method' | 'class_references_class'
  // bridge
  | 'script_declares_class';

export interface GraphNode {
  id: string;                     // unity:// URI
  kind: NodeKind;
  label: string;
  path?: string;
  guid?: string;
  location?: { line: number; column?: number };
  metadata: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  metadata: Record<string, unknown>;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  generated_at: string;           // ISO timestamp
  source_phase: 'asset' | 'code' | 'combined';
  stats: {
    node_count: number;
    edge_count: number;
    skipped_component_instances: number;   // sub-file kinds counted but not rendered
    skipped_component_fields: number;
  };
}
```

---

## 6. Open questions deferred to Day 0.C (MCP tool surface)

These shape tool inputs/outputs but don't change the node/edge model:

- Pagination strategy for `unity_graph_snapshot` on huge projects.
- Filtering by node kind / path glob at the tool level vs. webview level.
- Whether `unity_graph_context` returns a `GraphSnapshot` or a flatter agent-friendly shape.
- Error envelope when an ID can't be resolved (stale path, missing GUID, refactored DocId).

---

## 7. Worked example

A scene `Main.unity` contains an instance of prefab `Enemy.prefab`, which has a `MonoBehaviour` component referencing script `Enemy.cs` (which declares class `Game.Enemy`), and that component's `targetPrefab` field is bound to `Bullet.prefab`.

**Nodes**
```
unity://scene/aaaa…           kind=scene  label="Main"
unity://prefab/bbbb…          kind=prefab label="Enemy"
unity://prefab/cccc…          kind=prefab label="Bullet"
unity://script/Assets/Enemy.cs  kind=script label="Enemy.cs" guid=dddd…
unity://csharp/T:Game.Enemy   kind=class  label="Enemy"
```

**Edges**
```
scene_contains_prefab     scene(Main) → prefab(Enemy)         { instance_count: 1 }
script_used_by_scene      script(Enemy.cs) → scene(Main)      { component_instance_ids: ["aaaa…/-7332…"] }
script_used_by_prefab     script(Enemy.cs) → prefab(Enemy)    { component_instance_ids: ["bbbb…/-7332…"] }
serialized_binding        prefab(Enemy) → prefab(Bullet)      { bindings: [{ field_name: "targetPrefab", component_instance_id: "bbbb…/-7332…" }] }
script_declares_class     script(Enemy.cs) → class(Game.Enemy)
```

No `component_instance` nodes are rendered. The instance IDs live as edge metadata, available for an expand-on-demand subgraph view if the user focuses the `Enemy` prefab.
