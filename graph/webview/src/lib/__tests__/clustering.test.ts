import { describe, expect, it } from 'vitest';
import Graph from 'graphology';
import {
  buildClustering,
  clusterIdFor,
  LOD_THRESHOLD,
  NO_PATH_CLUSTER,
} from '../clustering';

function makeGraph(
  nodes: Array<{ id: string; path?: string; x?: number; y?: number }>,
  edges: Array<{ key: string; source: string; target: string }>,
): Graph {
  const g = new Graph({ type: 'directed', multi: true });
  for (const n of nodes) {
    g.addNode(n.id, { path: n.path, x: n.x ?? 0, y: n.y ?? 0, size: 4 });
  }
  for (const e of edges) {
    g.addEdgeWithKey(e.key, e.source, e.target, { size: 1 });
  }
  return g;
}

describe('clusterIdFor', () => {
  it('uses the file parent directory, truncated to two segments', () => {
    expect(clusterIdFor('Assets/Scripts/Player.cs')).toBe('Assets/Scripts');
  });

  it('clusters root-level files (`X.cs`) into NO_PATH_CLUSTER', () => {
    expect(clusterIdFor('README.md')).toBe(NO_PATH_CLUSTER);
  });

  it('clusters files directly in a top folder under that folder', () => {
    expect(clusterIdFor('Assets/X.cs')).toBe('Assets');
  });

  it('returns NO_PATH_CLUSTER when path is undefined', () => {
    expect(clusterIdFor(undefined)).toBe(NO_PATH_CLUSTER);
  });

  it('groups nested files under the same two-segment parent prefix', () => {
    const a = clusterIdFor('Assets/Scripts/Player/Foo.cs');
    const b = clusterIdFor('Assets/Scripts/Enemy/Bar.cs');
    expect(a).toBe(b);
    expect(a).toBe('Assets/Scripts');
  });

  it('truncates very-deep paths so the cluster stays top-level', () => {
    expect(clusterIdFor('Assets/Scripts/Player/Enemy/Foo.cs')).toBe(
      'Assets/Scripts',
    );
  });
});

describe('buildClustering', () => {
  it('returns empty clustering on an empty graph', () => {
    const c = buildClustering(new Graph());
    expect(c.clusterCount).toBe(0);
    expect(c.representatives.size).toBe(0);
    expect(c.representativeEdges.size).toBe(0);
  });

  it('groups nodes by their top-level Assets/ subfolder', () => {
    const g = makeGraph(
      [
        { id: 'a', path: 'Assets/Scripts/Foo.cs' },
        { id: 'b', path: 'Assets/Scripts/Bar.cs' },
        { id: 'c', path: 'Assets/Prefabs/Player.prefab' },
        { id: 'd', path: 'Packages/com.unity/Thing.cs' },
      ],
      [],
    );
    const c = buildClustering(g);
    expect(c.nodeToCluster.get('a')).toBe('Assets/Scripts');
    expect(c.nodeToCluster.get('b')).toBe('Assets/Scripts');
    expect(c.nodeToCluster.get('c')).toBe('Assets/Prefabs');
    expect(c.nodeToCluster.get('d')).toBe('Packages/com.unity');
    expect(c.clusterCount).toBe(3);
  });

  it('picks exactly one representative per cluster', () => {
    const g = makeGraph(
      [
        { id: 'a', path: 'Assets/Scripts/A.cs' },
        { id: 'b', path: 'Assets/Scripts/B.cs' },
        { id: 'c', path: 'Assets/Scripts/C.cs' },
      ],
      [],
    );
    const c = buildClustering(g);
    // All three are in the same cluster — exactly one wins.
    let count = 0;
    for (const id of ['a', 'b', 'c']) if (c.representatives.has(id)) count += 1;
    expect(count).toBe(1);
  });

  it('picks the representative closest to the cluster centroid', () => {
    const g = makeGraph(
      [
        // Centroid is roughly (0.5, 0). `b` is nearest.
        { id: 'a', path: 'X/Y/a.cs', x: 0, y: 0 },
        { id: 'b', path: 'X/Y/b.cs', x: 0.5, y: 0 },
        { id: 'c', path: 'X/Y/c.cs', x: 1, y: 0 },
      ],
      [],
    );
    const c = buildClustering(g);
    expect(c.representatives.has('b')).toBe(true);
  });

  it('representative choice is deterministic on a centroid tie (lexicographic)', () => {
    const g = makeGraph(
      [
        // Symmetric layout: both nodes are equidistant from centroid (0, 0).
        { id: 'z', path: 'X/Y/z.cs', x: 1, y: 0 },
        { id: 'a', path: 'X/Y/a.cs', x: -1, y: 0 },
      ],
      [],
    );
    const c = buildClustering(g);
    expect(c.representatives.has('a')).toBe(true);
    expect(c.representatives.has('z')).toBe(false);
  });

  it('collapses nodes without a path into NO_PATH_CLUSTER', () => {
    const g = makeGraph(
      [
        { id: 'a' },
        { id: 'b' },
        { id: 'c', path: 'Assets/X.cs' },
      ],
      [],
    );
    const c = buildClustering(g);
    expect(c.nodeToCluster.get('a')).toBe(NO_PATH_CLUSTER);
    expect(c.nodeToCluster.get('b')).toBe(NO_PATH_CLUSTER);
    expect(c.nodeToCluster.get('c')).toBe('Assets');
  });

  it('keeps exactly one representative edge per inter-cluster pair', () => {
    const g = makeGraph(
      [
        { id: 'a1', path: 'X/A/a1.cs' },
        { id: 'a2', path: 'X/A/a2.cs' },
        { id: 'b1', path: 'X/B/b1.cs' },
        { id: 'b2', path: 'X/B/b2.cs' },
      ],
      [
        { key: 'a1-b1', source: 'a1', target: 'b1' },
        { key: 'a1-b2', source: 'a1', target: 'b2' },
        { key: 'a2-b1', source: 'a2', target: 'b1' },
      ],
    );
    const c = buildClustering(g);
    expect(c.representativeEdges.size).toBe(1);
  });

  it('excludes intra-cluster edges from the representative set', () => {
    const g = makeGraph(
      [
        { id: 'a', path: 'X/Y/a.cs' },
        { id: 'b', path: 'X/Y/b.cs' },
      ],
      [{ key: 'a-b', source: 'a', target: 'b' }],
    );
    const c = buildClustering(g);
    expect(c.representativeEdges.has('a-b')).toBe(false);
  });

  it('treats (A→B) and (B→A) as distinct cluster pairs', () => {
    const g = makeGraph(
      [
        { id: 'a', path: 'X/A/a.cs' },
        { id: 'b', path: 'X/B/b.cs' },
      ],
      [
        { key: 'a-b', source: 'a', target: 'b' },
        { key: 'b-a', source: 'b', target: 'a' },
      ],
    );
    const c = buildClustering(g);
    expect(c.representativeEdges.size).toBe(2);
  });

  it('LOD_THRESHOLD is well-defined and > 1 (LOD only kicks in when zoomed out)', () => {
    expect(LOD_THRESHOLD).toBeGreaterThan(1);
  });
});
