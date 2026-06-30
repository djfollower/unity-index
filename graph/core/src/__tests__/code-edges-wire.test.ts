import { describe, expect, it } from 'vitest';
import {
  CODE_EDGES_DEFAULT_SUBTYPES_MAX_DEPTH,
  CODE_EDGES_MAX_SUBTYPES,
  CODE_EDGES_MAX_SYMBOLS,
  type CodeEdgeKind,
  type CodeEdgesRequest,
  type CodeEdgesResponse,
  type MethodCallSite,
} from '../code-edges-wire.js';
import { CODE_EDGES_GRAPH_TYPE } from '../messages.js';
import type { GraphEdge, GraphNode } from '../graph-types.js';

const blankStats = {
  node_count: 0,
  edge_count: 0,
  skipped_component_instances: 0,
  skipped_component_fields: 0,
};

describe('CODE_EDGES_GRAPH_TYPE', () => {
  it('matches the locked tool name from graph-mcp-tools.md §3.6', () => {
    // The bridge dispatch table on both hosts keys off this literal. If it
    // changes, Kotlin's ToolNames.UNITY_GRAPH_CODE_EDGES must change too.
    expect(CODE_EDGES_GRAPH_TYPE).toBe('unity_graph_code_edges');
  });
});

describe('CODE_EDGES_MAX_SYMBOLS', () => {
  it('matches the documented cap (graph-mcp-tools.md §3.6 "1..500")', () => {
    expect(CODE_EDGES_MAX_SYMBOLS).toBe(500);
  });
});

describe('CODE_EDGES_MAX_SUBTYPES + default depth', () => {
  it('exposes the Day 9.3 preset caps', () => {
    expect(CODE_EDGES_MAX_SUBTYPES).toBe(2000);
    expect(CODE_EDGES_DEFAULT_SUBTYPES_MAX_DEPTH).toBe(8);
  });
});

describe('CodeEdgesRequest.subtypes_of (Day 9.3)', () => {
  it('accepts a request with subtypes_of and no symbol_ids', () => {
    const req: CodeEdgesRequest = {
      project_path: '/tmp/proj',
      subtypes_of: 'unity://csharp/T:UnityEngine.MonoBehaviour',
    };
    expect(req.subtypes_of).toContain('MonoBehaviour');
    expect(req.symbol_ids).toBeUndefined();
  });

  it('accepts a request mixing subtypes_of with seed symbols and a depth cap', () => {
    const req: CodeEdgesRequest = {
      project_path: '/tmp/proj',
      symbol_ids: ['unity://csharp/T:Foo.Bar'],
      subtypes_of: 'unity://csharp/T:UnityEngine.MonoBehaviour',
      subtypes_max_depth: 4,
    };
    expect(req.subtypes_max_depth).toBe(4);
  });
});

// Compile-time shape sanity. These tests don't exercise logic — they exist so
// TS fails loudly the moment a wire field gets renamed or its type drifts,
// since drift between Kotlin and TS implementations is the most common way
// this contract breaks.
describe('CodeEdgesRequest shape', () => {
  it('accepts the minimal request', () => {
    const req: CodeEdgesRequest = {
      project_path: '/tmp/proj',
      symbol_ids: ['unity://csharp/T:Foo.Bar'],
    };
    expect(req.symbol_ids).toHaveLength(1);
  });

  it('accepts every documented optional field', () => {
    const req: CodeEdgesRequest = {
      project_path: '/tmp/proj',
      request_id: 'r1',
      symbol_ids: [
        'unity://csharp/T:Foo.Bar',
        'unity://csharp/M:Foo.Bar.Baz(System.Int32)',
      ],
      edge_kinds: [
        'class_inherits_from',
        'class_implements_interface',
        'method_overrides_method',
        'method_calls_method',
        'class_references_class',
      ] satisfies CodeEdgeKind[],
      include_targets: false,
    };
    expect(req.include_targets).toBe(false);
  });
});

describe('CodeEdgesResponse shape', () => {
  it('models a populated response with unresolved IDs', () => {
    const callSite: MethodCallSite = { line: 42, kind: 'virtual' };
    const node: GraphNode = {
      id: 'unity://csharp/T:Foo.Bar',
      kind: 'class',
      label: 'Bar',
      metadata: {},
    };
    const inherits: GraphEdge = {
      source: 'unity://csharp/T:Foo.Bar',
      target: 'unity://csharp/T:UnityEngine.MonoBehaviour',
      kind: 'class_inherits_from',
      metadata: {},
    };
    const calls: GraphEdge = {
      source: 'unity://csharp/M:Foo.Bar.Update',
      target: 'unity://csharp/M:Foo.Other.DoWork',
      kind: 'method_calls_method',
      metadata: { call_sites: [callSite] },
    };

    const res: CodeEdgesResponse = {
      generated_at: '2026-06-30T00:00:00Z',
      snapshot: {
        nodes: [node],
        edges: [inherits, calls],
        generated_at: '2026-06-30T00:00:00Z',
        source_phase: 'code',
        stats: { ...blankStats, node_count: 1, edge_count: 2 },
      },
      unresolved_ids: ['unity://csharp/T:Foo.Renamed'],
    };

    expect(res.snapshot.source_phase).toBe('code');
    expect(res.snapshot.edges[1].metadata.call_sites).toEqual([callSite]);
    expect(res.unresolved_ids).toHaveLength(1);
  });

  it('allows include_targets=false responses with edges-only snapshots', () => {
    const res: CodeEdgesResponse = {
      generated_at: '2026-06-30T00:00:00Z',
      snapshot: {
        nodes: [],
        edges: [
          {
            source: 'unity://csharp/T:Foo.A',
            target: 'unity://csharp/T:Foo.B',
            kind: 'class_references_class',
            metadata: {},
          },
        ],
        generated_at: '2026-06-30T00:00:00Z',
        source_phase: 'code',
        stats: { ...blankStats, edge_count: 1 },
      },
    };

    expect(res.snapshot.nodes).toHaveLength(0);
    expect(res.unresolved_ids).toBeUndefined();
  });
});
