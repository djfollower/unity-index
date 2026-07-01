import { describe, expect, it } from 'vitest';
import {
  EXPORT_SCHEMA_MAJOR,
  EXPORT_SCHEMA_VERSION,
  assertCompatibleExport,
  createExportEnvelope,
  type ExportDocument,
  type SavedView,
} from '../export-wire.js';
import type { GraphSnapshot } from '../graph-types.js';

// Day 11 Task 10 — end-to-end round-trip tests. Every export must survive
// JSON serialise → parse → validate without dropping the fields the
// webview and MCP clients rely on. Version-mismatch handling gets its
// own dedicated case because that's the load-bearing safety net.

const snapshot: GraphSnapshot = {
  nodes: [
    {
      id: 'unity://script/Assets/Player.cs',
      kind: 'script',
      label: 'Player',
      path: 'Assets/Player.cs',
      metadata: {},
    },
    {
      id: 'unity://prefab/Assets/Player.prefab',
      kind: 'prefab',
      label: 'Player.prefab',
      path: 'Assets/Player.prefab',
      guid: 'abc123',
      metadata: { componentCount: 4 },
    },
  ],
  edges: [
    {
      source: 'unity://script/Assets/Player.cs',
      target: 'unity://prefab/Assets/Player.prefab',
      kind: 'script_used_by_prefab',
      metadata: { via: 'MonoScript' },
    },
  ],
  generated_at: '2026-07-01T10:00:00.000Z',
  source_phase: 'asset',
  stats: {
    node_count: 2,
    edge_count: 1,
    skipped_component_instances: 3,
    skipped_component_fields: 7,
  },
};

const savedView: SavedView = {
  name: 'core scripts',
  description: 'MonoBehaviour subclasses only',
  createdAt: '2026-07-01T09:00:00.000Z',
  filter: {
    hiddenKinds: ['scene', 'prefab_variant'],
    search: 'controller',
    domain: 'combined',
  },
  focusStack: [
    { nodeId: 'unity://csharp/T:UnityEngine.MonoBehaviour', hops: 4, direction: 'in', kind: 'neighbors' },
  ],
  camera: { x: 0.42, y: 0.61, ratio: 0.85, angle: 0 },
  positions: {
    'unity://script/Assets/Player.cs': { x: 0.1, y: 0.2 },
  },
};

describe('ExportDocument round-trip', () => {
  it('preserves snapshot nodes and edges through JSON', () => {
    const doc = createExportEnvelope({
      snapshot,
      producer: 'vscode',
      producerVersion: '0.5.10',
      sourceProject: 'GameProject',
      now: () => new Date('2026-07-01T12:00:00.000Z'),
    });
    const wire = JSON.stringify(doc);
    const parsed = assertCompatibleExport(JSON.parse(wire));
    expect(parsed.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(parsed.snapshot.nodes).toEqual(snapshot.nodes);
    expect(parsed.snapshot.edges).toEqual(snapshot.edges);
    expect(parsed.snapshot.stats).toEqual(snapshot.stats);
    expect(parsed.meta.producer).toBe('vscode');
    expect(parsed.meta.sourceProject).toBe('GameProject');
  });

  it('preserves saved views (filter, focus, camera, positions)', () => {
    const doc: ExportDocument = {
      ...createExportEnvelope({
        snapshot,
        producer: 'rider',
        producerVersion: '0.5.10',
      }),
      savedViews: [savedView],
    };
    const parsed = assertCompatibleExport(JSON.parse(JSON.stringify(doc)));
    expect(parsed.savedViews).toHaveLength(1);
    const v = parsed.savedViews![0]!;
    expect(v.name).toBe(savedView.name);
    expect(v.filter).toEqual(savedView.filter);
    expect(v.focusStack).toEqual(savedView.focusStack);
    expect(v.camera).toEqual(savedView.camera);
    expect(v.positions).toEqual(savedView.positions);
  });

  it('preserves code-edge slice when present', () => {
    const codeSnapshot: GraphSnapshot = {
      nodes: [
        {
          id: 'unity://csharp/T:Game.Player',
          kind: 'class',
          label: 'Player',
          metadata: { anchor: false },
        },
      ],
      edges: [],
      generated_at: '2026-07-01T10:05:00.000Z',
      source_phase: 'code',
      stats: {
        node_count: 1,
        edge_count: 0,
        skipped_component_instances: 0,
        skipped_component_fields: 0,
      },
    };
    const doc: ExportDocument = {
      ...createExportEnvelope({
        snapshot,
        producer: 'mcp',
        producerVersion: '0.5.10',
      }),
      codeEdges: {
        snapshot: codeSnapshot,
        edgeKinds: ['class_inherits_from'],
        unresolvedIds: ['unity://csharp/T:Legacy.Thing'],
      },
    };
    const parsed = assertCompatibleExport(JSON.parse(JSON.stringify(doc)));
    expect(parsed.codeEdges).toBeDefined();
    expect(parsed.codeEdges!.snapshot.source_phase).toBe('code');
    expect(parsed.codeEdges!.edgeKinds).toEqual(['class_inherits_from']);
    expect(parsed.codeEdges!.unresolvedIds).toEqual(['unity://csharp/T:Legacy.Thing']);
  });

  it('rejects a document whose schema major is newer than this build', () => {
    const doc = createExportEnvelope({
      snapshot,
      producer: 'vscode',
      producerVersion: '0.6.0',
    });
    const forged = { ...doc, schemaVersion: `${EXPORT_SCHEMA_MAJOR + 1}.0` };
    expect(() => assertCompatibleExport(forged)).toThrow(/not supported by this build/);
  });

  it('accepts a document whose minor version is newer than this build (additive)', () => {
    const doc = createExportEnvelope({
      snapshot,
      producer: 'mcp',
      producerVersion: '0.5.10',
    });
    const forged = { ...doc, schemaVersion: `${EXPORT_SCHEMA_MAJOR}.99` };
    // Even better: additive extra fields should survive parse without
    // throwing — we only guard on major mismatch.
    const parsed = assertCompatibleExport({ ...forged, futureExtra: { note: 'ok' } });
    expect(parsed.snapshot).toEqual(snapshot);
  });

  it('accepts a document with no saved views and no code-edge slice', () => {
    const doc = createExportEnvelope({
      snapshot,
      producer: 'mcp',
      producerVersion: '0.5.10',
    });
    const parsed = assertCompatibleExport(JSON.parse(JSON.stringify(doc)));
    expect(parsed.savedViews).toBeUndefined();
    expect(parsed.codeEdges).toBeUndefined();
  });
});
