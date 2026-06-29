import * as fsp from "fs/promises";
import * as path from "path";
import type {
  EdgeKind,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  NodeKind,
} from "@unity-index/graph-core";
import type {
  SnapshotRequest,
  SnapshotResponse,
  Warning,
} from "@unity-index/graph-core";
import * as ids from "./graphIds";
import { parseUnityYaml, UnityYamlDocument } from "./unityYaml";

/**
 * Slim view of {@link UnityAssetIndex} that the graph builder needs. Pulled out
 * so tests can supply a stub without dragging vscode in.
 */
export interface AssetIndexLike {
  scriptGuids(): IterableIterator<[string, string]>;
  readonly assetFilePaths: readonly string[];
  guidFor(absPath: string): string | undefined;
}

const CLASS_ID_MONOBEHAVIOUR = 114;
const CLASS_ID_PREFAB_INSTANCE = 1001;

const ASSET_FILE_EXTENSIONS = new Set([
  ".prefab",
  ".unity",
  ".asset",
  ".mat",
  ".anim",
  ".controller",
  ".playable",
  ".spriteatlas",
  ".lighting",
  ".shader",
  ".physicMaterial",
  ".physicsMaterial2D",
]);

const YIELD_EVERY = 200;
const yieldEventLoop = () => new Promise<void>((r) => setImmediate(r));

/**
 * Build a Day-2 GraphSnapshot from a Unity project's asset YAML.
 *
 * Reuses {@link UnityAssetIndex}'s cached GUID map + asset file list, and the
 * existing `parseUnityYaml` parser. Matches the algorithm of
 * `UnityAssetGraphBuilder.kt`; the JSON output of the two builders must be
 * equivalent for the same project (the cross-impl gate from
 * docs/graph-day2-tasks.md Task 8).
 */
export async function buildAssetGraph(
  rootPath: string,
  index: AssetIndexLike,
  request: SnapshotRequest,
  signal?: AbortSignal,
): Promise<SnapshotResponse> {
  const toRel = (absPath: string): string =>
    path.relative(rootPath, absPath).split(path.sep).join("/");
  const warnings: Warning[] = [];
  const nodes = new Map<string, GraphNode>();
  const guidToNodeId = new Map<string, string>();
  const scriptIdByGuid = new Map<string, string>();

  // --- Pass 0: script nodes from the .meta GUID map.
  const dangling: GraphEdge[] = [];
  for (const [guid, absPath] of index.scriptGuids()) {
    const rel = toRel(absPath);
    const nodeId = ids.scriptId(rel);
    const className = path.basename(absPath).replace(/\.cs$/, "");
    const csharpId = ids.csharpClassId(className);
    nodes.set(nodeId, {
      id: nodeId,
      kind: "script",
      label: `${className}.cs`,
      path: rel,
      guid,
      metadata: {
        guid,
        primary_class_id: csharpId,
      },
    });
    guidToNodeId.set(guid, nodeId);
    scriptIdByGuid.set(guid, nodeId);
    dangling.push({
      source: nodeId,
      target: csharpId,
      kind: "script_declares_class",
      metadata: {},
    });
  }

  // --- Pass 1: walk asset files; emit asset-domain nodes; collect pending edges.
  const pending: PendingEdge[] = [];
  let skippedComponentInstances = 0;
  let skippedComponentFields = 0;
  let counter = 0;

  for (const file of index.assetFilePaths) {
    if (++counter % YIELD_EVERY === 0) {
      await yieldEventLoop();
      if (signal?.aborted) throw new Error("buildAssetGraph aborted");
    }
    const ext = path.extname(file).toLowerCase();
    if (!ASSET_FILE_EXTENSIONS.has(ext)) continue;

    const ownerGuid = index.guidFor(file);
    if (!ownerGuid) continue;

    let content: string;
    try {
      content = await fsp.readFile(file, "utf-8");
    } catch {
      continue;
    }
    let docs: UnityYamlDocument[];
    try {
      docs = parseUnityYaml(content, file);
    } catch {
      continue;
    }

    const { kind: nodeKind, isVariant } = classify(ext, docs);
    const ownerId = ((): string => {
      switch (nodeKind) {
        case "prefab":
        case "prefab_variant":
          return ids.prefabId(ownerGuid);
        case "scene":
          return ids.sceneId(ownerGuid);
        case "so":
          return ids.soId(ownerGuid);
        default:
          return ids.assetId(ownerGuid);
      }
    })();
    const rel = toRel(file);
    const label = path.basename(file, ext);
    const metadata: Record<string, unknown> = { guid: ownerGuid };
    if (nodeKind === "asset") {
      metadata.asset_type = ext.replace(/^\./, "");
    }
    nodes.set(ownerId, {
      id: ownerId,
      kind: nodeKind,
      label,
      path: rel,
      guid: ownerGuid,
      metadata,
    });
    guidToNodeId.set(ownerGuid, ownerId);

    if (nodeKind === "asset") continue;

    // Walk docs.
    const scriptUsage = new Map<string, string[]>(); // scriptGuid → componentInstanceIds
    for (const doc of docs) {
      if (doc.classId === CLASS_ID_MONOBEHAVIOUR) {
        skippedComponentInstances += 1;
        const compInstance = ids.componentInstanceId(ownerGuid, doc.fileId);
        const scriptGuid = doc.getScriptGuid();
        if (scriptGuid && nodeKind !== "so") {
          let arr = scriptUsage.get(scriptGuid);
          if (!arr) {
            arr = [];
            scriptUsage.set(scriptGuid, arr);
          }
          arr.push(compInstance);
        }
        for (const [key, value] of doc.properties) {
          if (!key.endsWith(".guid")) continue;
          if (key === "m_Script.guid") continue;
          const targetGuid = normalizeGuid(value);
          if (!targetGuid) continue;
          if (targetGuid === ownerGuid) continue;
          const fieldName = key.replace(/\.guid$/, "").split("[")[0];
          if (!fieldName) continue;
          skippedComponentFields += 1;
          pending.push({
            kind: "serialized_binding",
            ownerId,
            targetGuid,
            fieldName,
            componentInstanceId: compInstance,
          });
        }
      } else if (doc.classId === CLASS_ID_PREFAB_INSTANCE) {
        const sourceGuidRaw = doc.properties.get("m_SourcePrefab.guid");
        const sourceGuid = sourceGuidRaw ? normalizeGuid(sourceGuidRaw) : undefined;
        if (!sourceGuid) continue;
        if (nodeKind === "scene") {
          pending.push({
            kind: "scene_contains_prefab",
            sceneId: ownerId,
            sourceGuid,
          });
        } else if (
          (nodeKind === "prefab" || nodeKind === "prefab_variant") &&
          isVariant
        ) {
          pending.push({
            kind: "prefab_variant_of",
            prefabId: ownerId,
            sourceGuid,
          });
        }
      }
    }

    for (const [scriptGuid, componentIds] of scriptUsage) {
      const scriptNodeId = scriptIdByGuid.get(scriptGuid);
      if (!scriptNodeId) continue;
      let edgeKind: EdgeKind;
      if (nodeKind === "scene") edgeKind = "script_used_by_scene";
      else if (nodeKind === "prefab" || nodeKind === "prefab_variant")
        edgeKind = "script_used_by_prefab";
      else continue;
      pending.push({
        kind: "script_usage",
        source: scriptNodeId,
        target: ownerId,
        edgeKind,
        componentInstanceIds: componentIds.slice(),
      });
    }
  }

  // --- Pass 2: resolve deferred edge targets.
  const edges: GraphEdge[] = [...dangling];
  interface BindingBucket {
    source: string;
    target: string;
    list: Array<Record<string, unknown>>;
  }
  const bindings = new Map<string, BindingBucket>();
  // Aggregate scene_contains_prefab by (sceneId, targetId) — the previous
  // edges.find() scan was O(n²) on prefab-heavy scenes.
  const sceneContains = new Map<
    string,
    { source: string; target: string; count: number }
  >();
  let unresolvedSerializedBindingTargets = 0;
  let unresolvedScenePrefabTargets = 0;
  let unresolvedVariantTargets = 0;

  for (const p of pending) {
    if (p.kind === "script_usage") {
      edges.push({
        source: p.source,
        target: p.target,
        kind: p.edgeKind,
        metadata: { component_instance_ids: p.componentInstanceIds },
      });
    } else if (p.kind === "serialized_binding") {
      const targetId = guidToNodeId.get(p.targetGuid);
      if (!targetId) {
        unresolvedSerializedBindingTargets += 1;
        continue;
      }
      const key = `${p.ownerId}|${targetId}`;
      let bucket = bindings.get(key);
      if (!bucket) {
        bucket = { source: p.ownerId, target: targetId, list: [] };
        bindings.set(key, bucket);
      }
      bucket.list.push({
        field_name: p.fieldName,
        component_instance_id: p.componentInstanceId,
      });
    } else if (p.kind === "scene_contains_prefab") {
      const targetId = guidToNodeId.get(p.sourceGuid);
      if (!targetId) {
        unresolvedScenePrefabTargets += 1;
        continue;
      }
      const key = `${p.sceneId}|${targetId}`;
      const existing = sceneContains.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        sceneContains.set(key, {
          source: p.sceneId,
          target: targetId,
          count: 1,
        });
      }
    } else if (p.kind === "prefab_variant_of") {
      const targetId = guidToNodeId.get(p.sourceGuid);
      if (!targetId) {
        unresolvedVariantTargets += 1;
        continue;
      }
      edges.push({
        source: p.prefabId,
        target: targetId,
        kind: "prefab_variant_of",
        metadata: {},
      });
    }
  }

  for (const bucket of bindings.values()) {
    edges.push({
      source: bucket.source,
      target: bucket.target,
      kind: "serialized_binding",
      metadata: { bindings: bucket.list },
    });
  }

  for (const bucket of sceneContains.values()) {
    edges.push({
      source: bucket.source,
      target: bucket.target,
      kind: "scene_contains_prefab",
      metadata: { instance_count: bucket.count },
    });
  }

  // --- Apply filters.
  const includeKinds = request.include_kinds
    ? new Set<NodeKind>(request.include_kinds)
    : undefined;
  const excludeKinds = new Set<NodeKind>(request.exclude_kinds ?? []);
  const pathGlobs = request.path_globs?.map(compileGlob);
  const includeOrphans = request.include_orphans ?? true;

  if (
    includeKinds &&
    (includeKinds.has("component_instance") ||
      includeKinds.has("component_field"))
  ) {
    warnings.push({
      code: "subfile_kind_ignored",
      message:
        "component_instance and component_field are never emitted as top-level nodes; see graph-schema.md §2.3.",
    });
  }

  let filteredNodes: GraphNode[] = Array.from(nodes.values());
  if (includeKinds) {
    filteredNodes = filteredNodes.filter((n) => includeKinds.has(n.kind));
  }
  if (excludeKinds.size > 0) {
    filteredNodes = filteredNodes.filter((n) => !excludeKinds.has(n.kind));
  }
  if (pathGlobs) {
    filteredNodes = filteredNodes.filter((n) => {
      if (!n.path) return false;
      return pathGlobs.some((re) => re.test(n.path!));
    });
  }
  let keptIds = new Set(filteredNodes.map((n) => n.id));
  // script_declares_class deliberately dangles toward csharp:// nodes that
  // Day 8 emits — keep those edges as long as the source script survived.
  const edgeSurvives = (e: GraphEdge): boolean => {
    if (!keptIds.has(e.source)) return false;
    if (e.kind === "script_declares_class") return true;
    return keptIds.has(e.target);
  };
  let filteredEdges = edges.filter(edgeSurvives);

  if (!includeOrphans) {
    const connected = new Set<string>();
    for (const e of filteredEdges) {
      connected.add(e.source);
      if (e.kind !== "script_declares_class") connected.add(e.target);
    }
    filteredNodes = filteredNodes.filter((n) => connected.has(n.id));
    keptIds = new Set(filteredNodes.map((n) => n.id));
    filteredEdges = filteredEdges.filter(edgeSurvives);
  }

  if (filteredEdges.some((e) => e.kind === "script_declares_class")) {
    warnings.push({
      code: "dangling_csharp_targets",
      message:
        "script_declares_class edges point to csharp nodes that Day 2 does not emit; Day 8's code-edges harvest will materialize them.",
    });
  }

  if (
    unresolvedSerializedBindingTargets +
      unresolvedScenePrefabTargets +
      unresolvedVariantTargets >
    0
  ) {
    warnings.push({
      code: "unresolved_targets",
      message:
        "Some edges referenced GUIDs not present in the project's .meta map (likely Unity built-ins or missing assets).",
      context: {
        serialized_binding: unresolvedSerializedBindingTargets,
        scene_contains_prefab: unresolvedScenePrefabTargets,
        prefab_variant_of: unresolvedVariantTargets,
      },
    });
  }

  // --- Pagination (slice nodes; drop edges crossing the window).
  const totalNodes = filteredNodes.length;
  const { offset, pageSize } = decodePagination(request.pagination);
  const effective = pageSize ?? totalNodes;
  const sliceEnd = Math.min(offset + effective, totalNodes);
  const pageNodes =
    offset === 0 && sliceEnd === totalNodes
      ? filteredNodes
      : filteredNodes.slice(Math.min(offset, totalNodes), sliceEnd);
  const pageIds = new Set(pageNodes.map((n) => n.id));
  const pageEdges =
    offset === 0 && sliceEnd === totalNodes
      ? filteredEdges
      : filteredEdges.filter(
          (e) => pageIds.has(e.source) && pageIds.has(e.target),
        );

  const nextCursor = sliceEnd < totalNodes ? encodeCursor(sliceEnd) : undefined;
  const generatedAt = new Date().toISOString();
  const snapshot: GraphSnapshot = {
    nodes: pageNodes,
    edges: pageEdges,
    generated_at: generatedAt,
    source_phase: "asset",
    stats: {
      node_count: pageNodes.length,
      edge_count: pageEdges.length,
      skipped_component_instances: skippedComponentInstances,
      skipped_component_fields: skippedComponentFields,
    },
  };

  const response: SnapshotResponse = {
    generated_at: generatedAt,
    snapshot,
    page: {
      total_estimated: totalNodes,
      ...(nextCursor !== undefined ? { next_cursor: nextCursor } : {}),
    },
  };
  if (request.request_id !== undefined) response.request_id = request.request_id;
  if (warnings.length > 0) response.warnings = warnings;
  return response;
}

function classify(
  ext: string,
  docs: UnityYamlDocument[],
): { kind: NodeKind; isVariant: boolean } {
  switch (ext) {
    case ".prefab": {
      const hasInstance = docs.some((d) => d.classId === CLASS_ID_PREFAB_INSTANCE);
      return hasInstance
        ? { kind: "prefab_variant", isVariant: true }
        : { kind: "prefab", isVariant: false };
    }
    case ".unity":
      return { kind: "scene", isVariant: false };
    case ".asset":
      return docs.some((d) => d.classId === CLASS_ID_MONOBEHAVIOUR)
        ? { kind: "so", isVariant: false }
        : { kind: "asset", isVariant: false };
    default:
      return { kind: "asset", isVariant: false };
  }
}

function normalizeGuid(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/[,}\s]+$/, "");
  if (trimmed.length !== 32) return undefined;
  if (!/^[0-9a-fA-F]{32}$/.test(trimmed)) return undefined;
  const lower = trimmed.toLowerCase();
  if (/^0+$/.test(lower)) return undefined;
  return lower;
}

// Compile a Unity-style glob (Assets/Foo/<doublestar>).
// Supports ** (any depth), * (single segment), ? (single char).
function compileGlob(glob: string): RegExp {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i += 2;
    } else if (c === "*") {
      out += "[^/]*";
      i += 1;
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else if (/[.+(){}|^$[\]\\]/.test(c)) {
      out += "\\" + c;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

function decodePagination(
  pagination: SnapshotRequest["pagination"],
): { offset: number; pageSize: number | undefined } {
  if (!pagination) return { offset: 0, pageSize: undefined };
  const pageSize = pagination.page_size;
  if (!pagination.cursor) return { offset: 0, pageSize };
  try {
    const decoded = Buffer.from(pagination.cursor, "base64url").toString("utf-8");
    const m = /^\{"sv":\d+,"offset":(\d+)\}$/.exec(decoded);
    if (!m) return { offset: 0, pageSize };
    return { offset: parseInt(m[1], 10) || 0, pageSize };
  } catch {
    return { offset: 0, pageSize };
  }
}

function encodeCursor(offset: number): string {
  const payload = `{"sv":0,"offset":${offset}}`;
  return Buffer.from(payload, "utf-8").toString("base64url");
}

type PendingEdge =
  | {
      kind: "script_usage";
      source: string;
      target: string;
      edgeKind: EdgeKind;
      componentInstanceIds: string[];
    }
  | {
      kind: "serialized_binding";
      ownerId: string;
      targetGuid: string;
      fieldName: string;
      componentInstanceId: string;
    }
  | { kind: "scene_contains_prefab"; sceneId: string; sourceGuid: string }
  | { kind: "prefab_variant_of"; prefabId: string; sourceGuid: string };
