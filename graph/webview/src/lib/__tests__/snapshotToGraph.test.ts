import { describe, it, expect } from 'vitest';
import type {
  GraphEdge,
  GraphNode,
  GraphSnapshot,
} from '@unity-index/graph-core';
import { buildGraphologyGraph } from '../snapshotToGraph';

function snap(nodes: GraphNode[], edges: GraphEdge[]): GraphSnapshot {
  return {
    nodes,
    edges,
    generated_at: '2026-06-28T00:00:00Z',
    source_phase: 'asset',
    stats: {
      node_count: nodes.length,
      edge_count: edges.length,
      skipped_component_instances: 0,
      skipped_component_fields: 0,
    },
  };
}

function node(id: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind: 'script',
    label: id,
    metadata: {},
    ...overrides,
  };
}

function edge(
  source: string,
  target: string,
  kind: GraphEdge['kind'],
): GraphEdge {
  return { source, target, kind, metadata: {} };
}

describe('buildGraphologyGraph', () => {
  it('builds nodes and edges 1:1 when all targets resolve', () => {
    const s = snap(
      [
        node('unity://script/Assets/Foo.cs', { kind: 'script' }),
        node('unity://prefab/abc', { kind: 'prefab', label: 'Player.prefab' }),
        node('unity://scene/def', { kind: 'scene', label: 'Main.unity' }),
      ],
      [
        edge('unity://prefab/abc', 'unity://script/Assets/Foo.cs', 'script_used_by_prefab'),
        edge('unity://scene/def', 'unity://prefab/abc', 'scene_contains_prefab'),
      ],
    );

    const { graph, droppedEdges } = buildGraphologyGraph(s);

    expect(graph.order).toBe(3);
    expect(graph.size).toBe(2);
    expect(droppedEdges).toBe(0);
    expect(graph.getNodeAttribute('unity://prefab/abc', 'kind')).toBe('prefab');
    expect(graph.getNodeAttribute('unity://prefab/abc', 'label')).toBe('Player.prefab');
  });

  it('drops edges whose source or target is missing', () => {
    const s = snap(
      [node('unity://script/Assets/Foo.cs', { kind: 'script' })],
      [
        // Dangling target — Day 2 emits these for csharp:// IDs that Day 8
        // will materialize. Should drop, not throw.
        edge(
          'unity://script/Assets/Foo.cs',
          'unity://csharp/T:Foo',
          'script_declares_class',
        ),
        // Dangling source too — defensive.
        edge(
          'unity://prefab/missing',
          'unity://script/Assets/Foo.cs',
          'script_used_by_prefab',
        ),
      ],
    );

    const { graph, droppedEdges } = buildGraphologyGraph(s);

    expect(graph.order).toBe(1);
    expect(graph.size).toBe(0);
    expect(droppedEdges).toBe(2);
  });

  it('keeps multiple edges between the same pair when kinds differ', () => {
    const s = snap(
      [
        node('unity://script/Assets/Foo.cs', { kind: 'script' }),
        node('unity://prefab/abc', { kind: 'prefab' }),
      ],
      [
        edge('unity://prefab/abc', 'unity://script/Assets/Foo.cs', 'script_used_by_prefab'),
        edge('unity://prefab/abc', 'unity://script/Assets/Foo.cs', 'serialized_binding'),
      ],
    );

    const { graph, droppedEdges } = buildGraphologyGraph(s);

    expect(graph.size).toBe(2);
    expect(droppedEdges).toBe(0);
    expect(
      graph.hasEdge('script_used_by_prefab:unity://prefab/abc:unity://script/Assets/Foo.cs'),
    ).toBe(true);
    expect(
      graph.hasEdge('serialized_binding:unity://prefab/abc:unity://script/Assets/Foo.cs'),
    ).toBe(true);
  });
});
