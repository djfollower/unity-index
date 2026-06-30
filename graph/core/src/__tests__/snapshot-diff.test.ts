import { describe, expect, it } from 'vitest';
import type {
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  GraphStats,
} from '../graph-types.js';
import { edgeKey } from '../snapshot-delta-wire.js';
import {
  __forTests,
  diffSnapshots,
  isEmptyDelta,
} from '../snapshot-diff.js';

const stats: GraphStats = {
  node_count: 0,
  edge_count: 0,
  skipped_component_instances: 0,
  skipped_component_fields: 0,
};

const snap = (
  nodes: GraphNode[],
  edges: GraphEdge[],
  overrides: Partial<GraphSnapshot> = {},
): GraphSnapshot => ({
  nodes,
  edges,
  generated_at: '2026-06-29T00:00:00Z',
  source_phase: 'asset',
  stats,
  ...overrides,
});

const node = (id: string, p: Partial<GraphNode> = {}): GraphNode => ({
  id,
  kind: 'script',
  label: id,
  metadata: {},
  ...p,
});

const edge = (
  source: string,
  target: string,
  p: Partial<GraphEdge> = {},
): GraphEdge => ({
  source,
  target,
  kind: 'script_used_by_prefab',
  metadata: {},
  ...p,
});

const opts = { base_revision: 1, new_revision: 2 };

describe('diffSnapshots — empty cases', () => {
  it('two identical snapshots produce an empty delta', () => {
    const a = snap([node('n1')], [edge('n1', 'n2')]);
    const b = snap([node('n1')], [edge('n1', 'n2')]);
    const d = diffSnapshots(a, b, opts);
    expect(isEmptyDelta(d)).toBe(true);
    expect(d.base_revision).toBe(1);
    expect(d.new_revision).toBe(2);
  });

  it('empty → empty is empty', () => {
    expect(isEmptyDelta(diffSnapshots(snap([], []), snap([], []), opts))).toBe(
      true,
    );
  });
});

describe('diffSnapshots — node lifecycle', () => {
  it('added nodes show up in nodes_added', () => {
    const d = diffSnapshots(
      snap([node('a')], []),
      snap([node('a'), node('b')], []),
      opts,
    );
    expect(d.nodes_added.map((n) => n.id)).toEqual(['b']);
    expect(d.nodes_removed).toEqual([]);
    expect(d.nodes_updated).toEqual([]);
  });

  it('removed nodes show up in nodes_removed', () => {
    const d = diffSnapshots(
      snap([node('a'), node('b')], []),
      snap([node('a')], []),
      opts,
    );
    expect(d.nodes_removed).toEqual(['b']);
    expect(d.nodes_added).toEqual([]);
  });

  it('updated label is captured as nodes_updated, not as add+remove', () => {
    const d = diffSnapshots(
      snap([node('a', { label: 'old' })], []),
      snap([node('a', { label: 'new' })], []),
      opts,
    );
    expect(d.nodes_added).toEqual([]);
    expect(d.nodes_removed).toEqual([]);
    expect(d.nodes_updated.map((n) => n.label)).toEqual(['new']);
  });

  it('metadata change is detected via deep equality', () => {
    const d = diffSnapshots(
      snap([node('a', { metadata: { count: 1 } })], []),
      snap([node('a', { metadata: { count: 2 } })], []),
      opts,
    );
    expect(d.nodes_updated.map((n) => n.id)).toEqual(['a']);
  });

  it('semantically-equal metadata (different key order) is not a change', () => {
    const d = diffSnapshots(
      snap([node('a', { metadata: { x: 1, y: 2 } })], []),
      snap([node('a', { metadata: { y: 2, x: 1 } })], []),
      opts,
    );
    expect(d.nodes_updated).toEqual([]);
  });

  it('a location appearing / disappearing is a change', () => {
    const d = diffSnapshots(
      snap([node('a')], []),
      snap([node('a', { location: { line: 5 } })], []),
      opts,
    );
    expect(d.nodes_updated.map((n) => n.id)).toEqual(['a']);
  });
});

describe('diffSnapshots — edge lifecycle', () => {
  it('added edges show up in edges_added', () => {
    const d = diffSnapshots(
      snap([node('a'), node('b')], []),
      snap([node('a'), node('b')], [edge('a', 'b')]),
      opts,
    );
    expect(d.edges_added.length).toBe(1);
    expect(d.edges_removed).toEqual([]);
  });

  it('removed edges show up in edges_removed as bare keys', () => {
    const d = diffSnapshots(
      snap([node('a'), node('b')], [edge('a', 'b')]),
      snap([node('a'), node('b')], []),
      opts,
    );
    expect(d.edges_removed).toEqual([
      { source: 'a', target: 'b', kind: 'script_used_by_prefab' },
    ]);
    expect(d.edges_added).toEqual([]);
  });

  it('edge metadata change is modeled as remove + add', () => {
    const before = edge('a', 'b', { metadata: { count: 1 } });
    const after = edge('a', 'b', { metadata: { count: 2 } });
    const d = diffSnapshots(
      snap([node('a'), node('b')], [before]),
      snap([node('a'), node('b')], [after]),
      opts,
    );
    expect(d.edges_removed.map(edgeKey)).toEqual([edgeKey(before)]);
    expect(d.edges_added.map(edgeKey)).toEqual([edgeKey(after)]);
  });

  it('edges differing by kind alone are treated as distinct', () => {
    const e1 = edge('a', 'b', { kind: 'script_used_by_prefab' });
    const e2 = edge('a', 'b', { kind: 'script_used_by_scene' });
    const d = diffSnapshots(
      snap([node('a'), node('b')], [e1]),
      snap([node('a'), node('b')], [e2]),
      opts,
    );
    expect(d.edges_removed.length).toBe(1);
    expect(d.edges_removed[0].kind).toBe('script_used_by_prefab');
    expect(d.edges_added.length).toBe(1);
    expect(d.edges_added[0].kind).toBe('script_used_by_scene');
  });
});

describe('diffSnapshots — metadata pass-through', () => {
  it('echoes affected_paths verbatim into the delta', () => {
    const d = diffSnapshots(snap([], []), snap([], []), {
      ...opts,
      affected_paths: ['Assets/Foo.prefab', 'Assets/Bar.cs'],
    });
    expect(d.affected_paths).toEqual([
      'Assets/Foo.prefab',
      'Assets/Bar.cs',
    ]);
  });

  it('inherits generated_at from `next` snapshot by default', () => {
    const d = diffSnapshots(
      snap([], [], { generated_at: 'A' }),
      snap([], [], { generated_at: 'B' }),
      opts,
    );
    expect(d.generated_at).toBe('B');
  });

  it('an explicit generated_at override wins', () => {
    const d = diffSnapshots(snap([], []), snap([], []), {
      ...opts,
      generated_at: 'override',
    });
    expect(d.generated_at).toBe('override');
  });

  it('copies stats from `next`, not derives them from buckets', () => {
    const d = diffSnapshots(
      snap([], []),
      snap([], [], {
        stats: {
          node_count: 99,
          edge_count: 42,
          skipped_component_instances: 7,
          skipped_component_fields: 3,
        },
      }),
      opts,
    );
    // The diff's buckets are empty (we passed empty `nodes`/`edges`) but stats
    // must reflect `next`'s reported totals so the client can drop its
    // previous stats wholesale.
    expect(d.stats.node_count).toBe(99);
    expect(d.stats.skipped_component_instances).toBe(7);
  });
});

describe('canonicalJson', () => {
  it('handles primitives and null', () => {
    expect(__forTests.canonicalJson(null)).toBe('null');
    expect(__forTests.canonicalJson(1)).toBe('1');
    expect(__forTests.canonicalJson('x')).toBe('"x"');
    expect(__forTests.canonicalJson(true)).toBe('true');
  });

  it('sorts object keys', () => {
    expect(__forTests.canonicalJson({ b: 1, a: 2 })).toBe(
      __forTests.canonicalJson({ a: 2, b: 1 }),
    );
  });

  it('preserves array order', () => {
    expect(__forTests.canonicalJson([1, 2, 3])).toBe('[1,2,3]');
    expect(__forTests.canonicalJson([3, 2, 1])).not.toBe('[1,2,3]');
  });
});
