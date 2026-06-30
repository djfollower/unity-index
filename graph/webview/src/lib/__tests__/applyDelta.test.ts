import { describe, expect, it } from 'vitest';
import type {
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  SnapshotDelta,
} from '@unity-index/graph-core';
import { buildGraphologyGraph } from '../snapshotToGraph';
import { applyDeltaToGraph, edgeKeyOf } from '../applyDelta';

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
  kind: GraphEdge['kind'] = 'script_used_by_prefab',
): GraphEdge => ({ source, target, kind, metadata: {} });

function emptyDelta(
  patch: Partial<SnapshotDelta> = {},
): SnapshotDelta {
  return {
    base_revision: 0,
    new_revision: 1,
    generated_at: '2026-06-29T00:00:00Z',
    source_phase: 'asset',
    nodes_added: [],
    nodes_removed: [],
    nodes_updated: [],
    edges_added: [],
    edges_removed: [],
    stats: {
      node_count: 0,
      edge_count: 0,
      skipped_component_instances: 0,
      skipped_component_fields: 0,
    },
    ...patch,
  };
}

describe('applyDeltaToGraph', () => {
  it('adds new nodes and edges in place', () => {
    const { graph } = buildGraphologyGraph(snap([node('a')], []));
    const result = applyDeltaToGraph(
      graph,
      emptyDelta({
        nodes_added: [node('b', { kind: 'prefab' })],
        edges_added: [edge('a', 'b')],
      }),
    );
    expect(graph.hasNode('b')).toBe(true);
    expect(graph.getNodeAttribute('b', 'kind')).toBe('prefab');
    expect(graph.hasEdge(edgeKeyOf({ source: 'a', target: 'b', kind: 'script_used_by_prefab' }))).toBe(true);
    expect(result.hadChanges).toBe(true);
    expect(result.droppedEdges).toBe(0);
  });

  it('removes nodes and cascades their edges', () => {
    const { graph } = buildGraphologyGraph(
      snap([node('a'), node('b')], [edge('a', 'b')]),
    );
    applyDeltaToGraph(graph, emptyDelta({ nodes_removed: ['b'] }));
    expect(graph.hasNode('b')).toBe(false);
    // The edge a→b was dropped automatically when its endpoint disappeared.
    expect(graph.hasEdge(edgeKeyOf({ source: 'a', target: 'b', kind: 'script_used_by_prefab' }))).toBe(false);
  });

  it('removes explicit edges without touching endpoints', () => {
    const { graph } = buildGraphologyGraph(
      snap([node('a'), node('b')], [edge('a', 'b')]),
    );
    applyDeltaToGraph(graph, emptyDelta({
      edges_removed: [{ source: 'a', target: 'b', kind: 'script_used_by_prefab' }],
    }));
    expect(graph.hasNode('a')).toBe(true);
    expect(graph.hasNode('b')).toBe(true);
    expect(graph.hasEdge(edgeKeyOf({ source: 'a', target: 'b', kind: 'script_used_by_prefab' }))).toBe(false);
  });

  it('updates node attrs without disturbing x/y from layout', () => {
    const { graph } = buildGraphologyGraph(
      snap([node('a', { label: 'old', kind: 'script' })], []),
    );
    graph.setNodeAttribute('a', 'x', 42);
    graph.setNodeAttribute('a', 'y', -17);
    applyDeltaToGraph(graph, emptyDelta({
      nodes_updated: [node('a', { label: 'new', kind: 'prefab' })],
    }));
    expect(graph.getNodeAttribute('a', 'label')).toBe('new');
    expect(graph.getNodeAttribute('a', 'kind')).toBe('prefab');
    expect(graph.getNodeAttribute('a', 'x')).toBe(42);
    expect(graph.getNodeAttribute('a', 'y')).toBe(-17);
  });

  it('promotes nodes_updated to an add when the node was unknown', () => {
    const { graph } = buildGraphologyGraph(snap([], []));
    applyDeltaToGraph(graph, emptyDelta({
      nodes_updated: [node('z', { label: 'late', kind: 'so' })],
    }));
    expect(graph.hasNode('z')).toBe(true);
    expect(graph.getNodeAttribute('z', 'label')).toBe('late');
  });

  it('apply order: edges_added with endpoints in nodes_added in the same delta succeeds', () => {
    const { graph } = buildGraphologyGraph(snap([], []));
    const r = applyDeltaToGraph(graph, emptyDelta({
      nodes_added: [node('a'), node('b', { kind: 'prefab' })],
      edges_added: [edge('a', 'b')],
    }));
    expect(graph.hasEdge(edgeKeyOf({ source: 'a', target: 'b', kind: 'script_used_by_prefab' }))).toBe(true);
    expect(r.droppedEdges).toBe(0);
  });

  it('drops edges whose endpoints are absent (e.g. csharp dangling targets)', () => {
    const { graph } = buildGraphologyGraph(snap([node('a')], []));
    const r = applyDeltaToGraph(graph, emptyDelta({
      edges_added: [edge('a', 'ghost', 'script_declares_class')],
    }));
    expect(r.droppedEdges).toBe(1);
    expect(r.hadChanges).toBe(false); // pure dangling-edge attempt isn't a change
  });

  it('empty delta yields hadChanges=false', () => {
    const { graph } = buildGraphologyGraph(snap([node('a')], []));
    const r = applyDeltaToGraph(graph, emptyDelta());
    expect(r.hadChanges).toBe(false);
  });

  it('survives a remove followed by an edge_remove targeting the cascade', () => {
    // Deltas may legally carry both a node removal and the edge keys it
    // would also drop. The edge_removed pass must tolerate already-gone edges.
    const { graph } = buildGraphologyGraph(
      snap([node('a'), node('b')], [edge('a', 'b')]),
    );
    expect(() =>
      applyDeltaToGraph(graph, emptyDelta({
        nodes_removed: ['b'],
        edges_removed: [{ source: 'a', target: 'b', kind: 'script_used_by_prefab' }],
      })),
    ).not.toThrow();
  });
});
