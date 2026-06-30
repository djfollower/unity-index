// Day 7 Task 8 — folder-based LOD clustering.
//
// When the camera is zoomed far out, drawing 30k individual nodes is wasted
// pixels: nodes overlap each other into a smear and labels can't be read.
// We collapse the graph by top-level Assets/ subfolder and render one
// "cluster" node per folder, with inter-cluster edges aggregated.
//
// The base graph stays untouched — we never mutate it for LOD. Sigma's
// reducers consult the cluster state (computed by `buildClustering`) and
// the live camera ratio to decide what to draw. This keeps focus / search /
// delta-apply / drag-position state intact across zoom changes: zooming in
// re-reveals the exact nodes that were there before.
//
// Clustering rules (assets-first, per CLAUDE.md):
//   - A node's cluster is the first two segments of its `path` attribute,
//     e.g. `Assets/Scripts/Player.cs` → `Assets/Scripts`,
//     `Assets/Foo.cs` → `Assets`, `Packages/Some/Thing.cs` → `Packages/Some`.
//   - Nodes without a `path` (csharp dangling targets, etc.) land in
//     `__no_path__` so they cluster together rather than each becoming
//     their own representative.
//   - One node per cluster acts as the visible representative; the choice
//     is deterministic (node closest to the cluster centroid) so the same
//     folder shows the same icon across renders.
//
// Aggregation:
//   - For each ordered pair (srcCluster, dstCluster), one base edge whose
//     endpoints land in those clusters is picked as the representative.
//     When zoomed out, the reducer keeps that edge visible and hides the
//     rest. Edges within a single cluster (intra-folder) are always hidden
//     when zoomed out — they have no value at that LOD.
//
// Threshold:
//   - Sigma's camera ratio grows as the user zooms out (ratio=1 is the
//     default fit). Above `LOD_THRESHOLD` we switch to cluster mode. The
//     value is intentionally generous so cluster mode kicks in only when
//     individual nodes would be illegible anyway.

import type Graph from 'graphology';

/** Sigma camera ratio above which we switch to cluster-mode rendering. */
export const LOD_THRESHOLD = 4;

/** Stable id for nodes that have no `path` attribute. Folder-style so the
 *  representative selection logic treats it like any other cluster. */
export const NO_PATH_CLUSTER = '__no_path__';

export interface ClusterInfo {
  /** Cluster identifier — the folder string (e.g. `Assets/Scripts`). */
  id: string;
  /** Display label shown when the cluster collapses. Includes the count. */
  label: string;
  /** Node ids that belong to this cluster. */
  members: string[];
  /** Node id picked as the visual stand-in when zoomed out. */
  representative: string;
}

export interface Clustering {
  /** Reverse index from base node id → cluster id. Cheap O(1) lookup in
   *  the per-frame reducer. */
  nodeToCluster: Map<string, string>;
  /** Set of base node ids that act as their cluster's representative.
   *  In cluster mode, all OTHER nodes hide. */
  representatives: Set<string>;
  /** Cluster-mode edge representative set. An edge key in this set is the
   *  one drawn for an inter-cluster pair; all other edges hide when zoomed
   *  out. Intra-cluster edges are never in the set. */
  representativeEdges: Set<string>;
  /** Per-representative-node display attrs (label + scaled size). The
   *  reducer overlays these on the existing node attrs in cluster mode. */
  repAttrs: Map<string, { label: string; size: number }>;
  /** Number of clusters. Mostly for debugging / status copy. */
  clusterCount: number;
}

const EMPTY_CLUSTERING: Clustering = {
  nodeToCluster: new Map(),
  representatives: new Set(),
  representativeEdges: new Set(),
  repAttrs: new Map(),
  clusterCount: 0,
};

export function emptyClustering(): Clustering {
  return EMPTY_CLUSTERING;
}

/**
 * Compute cluster assignments + representatives + aggregated edge set.
 * Pure (no Sigma, no DOM) so vitest can pin behaviour without a render
 * environment. Re-run after every snapshot load and after delta applies
 * that touched node membership.
 */
export function buildClustering(graph: Graph): Clustering {
  if (graph.order === 0) return EMPTY_CLUSTERING;

  // Pass 1 — gather members per cluster and accumulate position sums so
  // the representative pick can be centroid-based without a second sweep.
  const members = new Map<string, string[]>();
  const centroidSum = new Map<string, { x: number; y: number; n: number }>();
  graph.forEachNode((id, attrs) => {
    const cluster = clusterIdFor(attrs.path as string | undefined);
    let bucket = members.get(cluster);
    if (!bucket) {
      bucket = [];
      members.set(cluster, bucket);
    }
    bucket.push(id);
    const c = centroidSum.get(cluster);
    const x = (attrs.x as number) ?? 0;
    const y = (attrs.y as number) ?? 0;
    if (c) {
      c.x += x;
      c.y += y;
      c.n += 1;
    } else {
      centroidSum.set(cluster, { x, y, n: 1 });
    }
  });

  // Pass 2 — pick the representative for each cluster: the member node
  // closest to the cluster centroid. Ties broken by lexicographic id so
  // the choice is stable across renders.
  const representatives = new Set<string>();
  const repAttrs = new Map<string, { label: string; size: number }>();
  const nodeToCluster = new Map<string, string>();
  for (const [cluster, ids] of members) {
    const c = centroidSum.get(cluster)!;
    const cx = c.x / c.n;
    const cy = c.y / c.n;
    let bestId = ids[0]!;
    let bestDist = Infinity;
    for (const id of ids) {
      const x = (graph.getNodeAttribute(id, 'x') as number) ?? 0;
      const y = (graph.getNodeAttribute(id, 'y') as number) ?? 0;
      const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d < bestDist || (d === bestDist && id < bestId)) {
        bestDist = d;
        bestId = id;
      }
      nodeToCluster.set(id, cluster);
    }
    representatives.add(bestId);
    repAttrs.set(bestId, {
      label: clusterLabel(cluster, ids.length),
      // Cluster size grows with sqrt(memberCount) so big folders read as
      // visibly bigger without a 10k-member cluster eclipsing the panel.
      size: 8 + Math.sqrt(ids.length) * 1.5,
    });
  }

  // Pass 3 — pick one representative edge per (srcCluster, dstCluster).
  // Multi-edges between the same cluster pair collapse to a single visible
  // line at the LOD level. Intra-cluster edges are deliberately excluded.
  const seen = new Set<string>();
  const representativeEdges = new Set<string>();
  graph.forEachEdge((edgeKey, _attrs, source, target) => {
    const src = nodeToCluster.get(source);
    const dst = nodeToCluster.get(target);
    if (!src || !dst) return;
    if (src === dst) return;
    const pairKey = `${src}${dst}`;
    if (seen.has(pairKey)) return;
    seen.add(pairKey);
    representativeEdges.add(edgeKey);
  });

  return {
    nodeToCluster,
    representatives,
    representativeEdges,
    repAttrs,
    clusterCount: members.size,
  };
}

/**
 * Cluster id for a path. Strategy: take the file's parent directory and
 * truncate to the first two segments so deeply-nested files still group
 * by a meaningful top-level folder. Examples:
 *
 *   `Assets/Scripts/Player.cs`             → `Assets/Scripts`
 *   `Assets/Scripts/Player/Foo.cs`         → `Assets/Scripts`
 *   `Assets/Scripts/Player/Enemy/Foo.cs`   → `Assets/Scripts`
 *   `Assets/X.cs`                          → `Assets`
 *   `X.cs`                                 → `NO_PATH_CLUSTER`
 *
 * The `NO_PATH_CLUSTER` fallback also covers nodes without a `path` attr
 * at all (csharp dangling targets and similar).
 */
export function clusterIdFor(path: string | undefined): string {
  if (!path) return NO_PATH_CLUSTER;
  const segments = path.split('/');
  // Drop the basename so a file is bucketed by its containing folder.
  const parentSegments = segments.slice(0, -1);
  if (parentSegments.length === 0) return NO_PATH_CLUSTER;
  if (parentSegments.length >= 2) {
    return `${parentSegments[0]}/${parentSegments[1]}`;
  }
  return parentSegments[0]!;
}

function clusterLabel(clusterId: string, count: number): string {
  const folder = clusterId === NO_PATH_CLUSTER ? '(no path)' : clusterId;
  return `${folder} · ${count.toLocaleString()}`;
}
