import { describe, expect, it } from 'vitest';
import { materializeClassAnchors } from '../class-anchors.js';
import {
  WARNING_DANGLING_CSHARP_TARGETS,
  WARNING_UNRESOLVED_TARGETS,
  type Warning,
} from '../snapshot-wire.js';
import type { GraphEdge, GraphNode, GraphSnapshot } from '../graph-types.js';

const blankStats = {
  node_count: 0,
  edge_count: 0,
  skipped_component_instances: 0,
  skipped_component_fields: 0,
};

function snapshot(nodes: GraphNode[], edges: GraphEdge[]): GraphSnapshot {
  return {
    nodes,
    edges,
    generated_at: '2026-06-30T00:00:00Z',
    source_phase: 'asset',
    stats: { ...blankStats, node_count: nodes.length, edge_count: edges.length },
  };
}

const scriptNode: GraphNode = {
  id: 'unity://script/Assets/Player.cs',
  kind: 'script',
  label: 'Player.cs',
  path: 'Assets/Player.cs',
  metadata: {},
};

const declares: GraphEdge = {
  source: scriptNode.id,
  target: 'unity://csharp/T:Foo.Player',
  kind: 'script_declares_class',
  metadata: {},
};

describe('materializeClassAnchors', () => {
  it('returns the same snapshot when there are no script_declares_class edges', () => {
    const snap = snapshot([scriptNode], []);
    const result = materializeClassAnchors(snap);
    expect(result.anchorsAdded).toBe(0);
    expect(result.snapshot).toBe(snap);
  });

  it('materializes one anchor per dangling csharp target', () => {
    const snap = snapshot([scriptNode], [declares]);
    const result = materializeClassAnchors(snap);
    expect(result.anchorsAdded).toBe(1);
    expect(result.snapshot.nodes).toHaveLength(2);
    const anchor = result.snapshot.nodes.find((n) => n.id === declares.target)!;
    expect(anchor.kind).toBe('class');
    expect(anchor.label).toBe('Foo.Player');
    expect(anchor.path).toBe('Assets/Player.cs');
    expect(anchor.metadata).toMatchObject({
      anchor: true,
      declaring_script: scriptNode.id,
    });
    expect(result.snapshot.stats.node_count).toBe(2);
  });

  it('does not duplicate when the target already has a node', () => {
    const real: GraphNode = {
      id: declares.target,
      kind: 'class',
      label: 'Player',
      metadata: { anchor: false },
    };
    const snap = snapshot([scriptNode, real], [declares]);
    const result = materializeClassAnchors(snap);
    expect(result.anchorsAdded).toBe(0);
    expect(result.snapshot).toBe(snap);
  });

  it('strips the dangling_csharp_targets warning, leaves others alone', () => {
    const danglingWarn: Warning = {
      code: WARNING_DANGLING_CSHARP_TARGETS,
      message: 'old text',
    };
    const otherWarn: Warning = {
      code: WARNING_UNRESOLVED_TARGETS,
      message: 'unrelated',
    };
    const snap = snapshot([scriptNode], [declares]);
    const result = materializeClassAnchors(snap, {
      warnings: [danglingWarn, otherWarn],
    });
    expect(result.warnings).toEqual([otherWarn]);
  });

  it('does not mutate the input snapshot', () => {
    const snap = snapshot([scriptNode], [declares]);
    const before = JSON.stringify(snap);
    materializeClassAnchors(snap);
    expect(JSON.stringify(snap)).toBe(before);
  });
});
