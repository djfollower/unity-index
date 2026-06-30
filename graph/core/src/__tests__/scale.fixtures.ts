// Day 7 Task 9 — synthetic large-graph fixture used by perf budgets.
//
// Generates a deterministic GraphSnapshot of any (nodeCount, edgeCount) size
// for use in vitest perf tests. The shape approximates a real Unity project
// (Player + Asteroids type) — a long tail of script nodes, fewer prefabs and
// scenes, plus some scriptable objects + plain assets — so the edge mix has
// the same density-per-kind that production code paths must handle.
//
// Determinism: a Mulberry32 PRNG seeded with a fixed constant drives every
// random pick (cluster path picks, edge endpoints, metadata counts). The
// generated snapshot is byte-stable across machines and runs, which matters
// for perf-budget tests so an unrelated commit doesn't appear to "regress"
// because a different seed happened to produce a thicker graph.

import type {
  EdgeKind,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  NodeKind,
} from '../graph-types.js';

/** Mulberry32 — small, fast, well-distributed PRNG. Returns 0…1. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface KindSpec {
  kind: NodeKind;
  // Fractional share of total node count.
  share: number;
  // Path template — `{i}` is replaced with the node index within this kind.
  pathTemplate: (i: number) => string;
  // Edge kinds that may originate from this node kind.
  outgoingEdgeKinds: EdgeKind[];
}

// Roughly modelled after the "Player vs. Asteroids" Day-6 fixture but scaled.
// Shares sum to 1.0; rounding deals with floor.
const KIND_MIX: KindSpec[] = [
  {
    kind: 'script',
    share: 0.55,
    pathTemplate: (i) => `Assets/Scripts/${folderOf(i)}/Class${i}.cs`,
    outgoingEdgeKinds: ['script_declares_class'],
  },
  {
    kind: 'prefab',
    share: 0.18,
    pathTemplate: (i) => `Assets/Prefabs/${folderOf(i)}/P${i}.prefab`,
    outgoingEdgeKinds: ['serialized_binding'],
  },
  {
    kind: 'scene',
    share: 0.05,
    pathTemplate: (i) => `Assets/Scenes/S${i}.unity`,
    outgoingEdgeKinds: ['scene_contains_prefab'],
  },
  {
    kind: 'so',
    share: 0.07,
    pathTemplate: (i) => `Assets/Data/${folderOf(i)}/SO${i}.asset`,
    outgoingEdgeKinds: ['serialized_binding'],
  },
  {
    kind: 'asset',
    share: 0.15,
    pathTemplate: (i) => `Assets/Art/${folderOf(i)}/A${i}.asset`,
    outgoingEdgeKinds: [],
  },
];

// Sub-folder buckets so the cluster-LOD path also sees realistic group sizes.
function folderOf(i: number): string {
  const buckets = ['Core', 'UI', 'Combat', 'Audio', 'Input', 'World'];
  return buckets[i % buckets.length]!;
}

export interface ScaleOptions {
  nodeCount: number;
  edgeCount: number;
  seed?: number;
}

export interface ScaleSnapshot {
  snapshot: GraphSnapshot;
  /** Node ids by kind, for quick targeted lookups in tests. */
  byKind: Record<NodeKind, string[]>;
}

/**
 * Generate a synthetic snapshot. Pure (no I/O). For the canonical perf
 * budget pass {@link DEFAULT_NODE_COUNT} / {@link DEFAULT_EDGE_COUNT}.
 */
export function buildScaleSnapshot(opts: ScaleOptions): ScaleSnapshot {
  const { nodeCount, edgeCount } = opts;
  const random = rng(opts.seed ?? 0xC0FFEE);

  // ---- nodes -----------------------------------------------------------
  const nodes: GraphNode[] = [];
  const byKind: Record<string, string[]> = {};
  let assigned = 0;
  for (let s = 0; s < KIND_MIX.length; s += 1) {
    const spec = KIND_MIX[s]!;
    // Final bucket absorbs the rounding remainder.
    const target = s === KIND_MIX.length - 1
      ? nodeCount - assigned
      : Math.floor(nodeCount * spec.share);
    for (let i = 0; i < target; i += 1) {
      const path = spec.pathTemplate(i);
      const id = `unity://${spec.kind}/${path}`;
      nodes.push({
        id,
        kind: spec.kind,
        label: path.split('/').pop()!,
        path,
        metadata: {},
      });
      (byKind[spec.kind] ||= []).push(id);
    }
    assigned += target;
  }

  // ---- edges -----------------------------------------------------------
  // Connect prefabs/scenes/SOs to scripts so the graph isn't a forest of
  // unrelated nodes. Production graphs are dense around script_used_by_*.
  const scriptIds = byKind.script ?? [];
  const prefabIds = byKind.prefab ?? [];
  const sceneIds = byKind.scene ?? [];
  const soIds = byKind.so ?? [];
  const assetIds = byKind.asset ?? [];

  const edges: GraphEdge[] = [];
  const seenEdgeKey = new Set<string>();

  function tryAddEdge(source: string, target: string, kind: EdgeKind): boolean {
    if (source === target) return false;
    const k = `${kind} ${source} ${target}`;
    if (seenEdgeKey.has(k)) return false;
    seenEdgeKey.add(k);
    edges.push({ source, target, kind, metadata: {} });
    return true;
  }

  // ~40% of the edges are script_used_by_prefab.
  const targetUsedByPrefab = Math.floor(edgeCount * 0.4);
  let added = 0;
  while (added < targetUsedByPrefab && prefabIds.length > 0 && scriptIds.length > 0) {
    const src = scriptIds[Math.floor(random() * scriptIds.length)]!;
    const dst = prefabIds[Math.floor(random() * prefabIds.length)]!;
    if (tryAddEdge(src, dst, 'script_used_by_prefab')) added += 1;
  }

  // ~15% script_used_by_scene
  let target = Math.floor(edgeCount * 0.15);
  added = 0;
  while (added < target && sceneIds.length > 0 && scriptIds.length > 0) {
    const src = scriptIds[Math.floor(random() * scriptIds.length)]!;
    const dst = sceneIds[Math.floor(random() * sceneIds.length)]!;
    if (tryAddEdge(src, dst, 'script_used_by_scene')) added += 1;
  }

  // ~15% scene_contains_prefab
  target = Math.floor(edgeCount * 0.15);
  added = 0;
  while (added < target && sceneIds.length > 0 && prefabIds.length > 0) {
    const src = sceneIds[Math.floor(random() * sceneIds.length)]!;
    const dst = prefabIds[Math.floor(random() * prefabIds.length)]!;
    if (tryAddEdge(src, dst, 'scene_contains_prefab')) added += 1;
  }

  // ~10% serialized_binding prefab→so
  target = Math.floor(edgeCount * 0.1);
  added = 0;
  while (added < target && prefabIds.length > 0 && soIds.length > 0) {
    const src = prefabIds[Math.floor(random() * prefabIds.length)]!;
    const dst = soIds[Math.floor(random() * soIds.length)]!;
    if (tryAddEdge(src, dst, 'serialized_binding')) added += 1;
  }

  // ~10% serialized_binding prefab→asset
  target = Math.floor(edgeCount * 0.1);
  added = 0;
  while (added < target && prefabIds.length > 0 && assetIds.length > 0) {
    const src = prefabIds[Math.floor(random() * prefabIds.length)]!;
    const dst = assetIds[Math.floor(random() * assetIds.length)]!;
    if (tryAddEdge(src, dst, 'serialized_binding')) added += 1;
  }

  // Remainder: script_declares_class to synthetic targets. These are the
  // dangling csharp targets we expect production graphs to ship.
  while (edges.length < edgeCount && scriptIds.length > 0) {
    const src = scriptIds[edges.length % scriptIds.length]!;
    const dst = `unity://csharp/T:Class${edges.length}`;
    if (!tryAddEdge(src, dst, 'script_declares_class')) {
      // Pathological duplicate path — bail to avoid infinite loop.
      break;
    }
  }

  const snapshot: GraphSnapshot = {
    nodes,
    edges,
    generated_at: '2026-06-30T00:00:00Z',
    source_phase: 'asset',
    stats: {
      node_count: nodes.length,
      edge_count: edges.length,
      skipped_component_instances: 0,
      skipped_component_fields: 0,
    },
  };

  return { snapshot, byKind: byKind as Record<NodeKind, string[]> };
}

/**
 * Generate a "next" snapshot that differs from a base by exactly
 * `changedFiles` files (additions + updates + removals split roughly
 * evenly). Returns the modified snapshot plus the list of `affected_paths`
 * that would have been reported by the watcher.
 */
export function perturbSnapshot(
  base: GraphSnapshot,
  byKind: Record<NodeKind, string[]>,
  changedFiles: number,
  seed = 0xBADCAFE,
): { snapshot: GraphSnapshot; affectedPaths: string[] } {
  const random = rng(seed);
  const nodes: GraphNode[] = base.nodes.slice();
  const edges: GraphEdge[] = base.edges.slice();

  const affected: string[] = [];

  // 1/3 additions
  const newCount = Math.floor(changedFiles / 3);
  for (let i = 0; i < newCount; i += 1) {
    const path = `Assets/Scripts/Added/New${i}_${seed}.cs`;
    const id = `unity://script/${path}`;
    nodes.push({
      id,
      kind: 'script',
      label: `New${i}.cs`,
      path,
      metadata: {},
    });
    affected.push(path);
  }

  // 1/3 updates (mutate label on a random existing node)
  const updateCount = Math.floor(changedFiles / 3);
  const scriptIds = byKind.script ?? [];
  for (let i = 0; i < updateCount && scriptIds.length > 0; i += 1) {
    const idx = Math.floor(random() * scriptIds.length);
    const targetId = scriptIds[idx]!;
    const nodeIdx = nodes.findIndex((n) => n.id === targetId);
    if (nodeIdx < 0) continue;
    const original = nodes[nodeIdx]!;
    nodes[nodeIdx] = { ...original, label: `${original.label}*` };
    if (original.path) affected.push(original.path);
  }

  // Remainder: removals
  const removeCount = changedFiles - newCount - updateCount;
  const removedIds = new Set<string>();
  for (let i = 0; i < removeCount && scriptIds.length > 0; i += 1) {
    const idx = Math.floor(random() * scriptIds.length);
    const id = scriptIds[idx]!;
    if (removedIds.has(id)) continue;
    removedIds.add(id);
    const path = nodes.find((n) => n.id === id)?.path;
    if (path) affected.push(path);
  }
  const survivors = nodes.filter((n) => !removedIds.has(n.id));
  const survivorEdges = edges.filter(
    (e) => !removedIds.has(e.source) && !removedIds.has(e.target),
  );

  const snapshot: GraphSnapshot = {
    nodes: survivors,
    edges: survivorEdges,
    generated_at: '2026-06-30T00:00:01Z',
    source_phase: base.source_phase,
    stats: {
      node_count: survivors.length,
      edge_count: survivorEdges.length,
      skipped_component_instances: 0,
      skipped_component_fields: 0,
    },
  };

  return { snapshot, affectedPaths: affected };
}

/** Canonical scale targets used by the perf tests. */
export const DEFAULT_NODE_COUNT = 10_000;
export const DEFAULT_EDGE_COUNT = 30_000;
