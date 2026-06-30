import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTICS_DEFAULT_MAX_MESSAGES,
  DIAGNOSTICS_MAX_MESSAGES_PER_NODE,
  DIAGNOSTICS_MAX_NODES,
  type DiagnosticMessage,
  type DiagnosticsBatchRequest,
  type DiagnosticsBatchResponse,
  type NodeDiagnostics,
} from '../diagnostics-wire.js';
import { DIAGNOSTICS_GRAPH_TYPE } from '../messages.js';

describe('DIAGNOSTICS_GRAPH_TYPE', () => {
  it('matches the locked tool name', () => {
    // Bridge dispatch on both hosts keys off this literal. If it changes,
    // Kotlin's ToolNames.UNITY_GRAPH_DIAGNOSTICS must change too.
    expect(DIAGNOSTICS_GRAPH_TYPE).toBe('unity_graph_diagnostics');
  });
});

describe('diagnostics caps', () => {
  it('exposes the documented caps', () => {
    expect(DIAGNOSTICS_MAX_NODES).toBe(500);
    expect(DIAGNOSTICS_DEFAULT_MAX_MESSAGES).toBe(3);
    expect(DIAGNOSTICS_MAX_MESSAGES_PER_NODE).toBe(10);
  });
});

describe('DiagnosticsBatchRequest shape', () => {
  it('accepts the minimal request', () => {
    const req: DiagnosticsBatchRequest = {
      project_path: '/tmp/proj',
      node_ids: ['unity://csharp/T:Foo.Bar'],
    };
    expect(req.node_ids).toHaveLength(1);
  });

  it('accepts every documented optional field', () => {
    const req: DiagnosticsBatchRequest = {
      project_path: '/tmp/proj',
      request_id: 'r1',
      node_ids: [
        'unity://csharp/T:Foo.Bar',
        'unity://script/Assets/Scripts/Player.cs',
      ],
      include_messages: false,
      max_messages_per_node: 5,
    };
    expect(req.include_messages).toBe(false);
    expect(req.max_messages_per_node).toBe(5);
  });
});

describe('DiagnosticsBatchResponse shape', () => {
  it('models a populated response with mixed clean / dirty nodes', () => {
    const msg: DiagnosticMessage = {
      severity: 'error',
      message: "The name 'Foo' does not exist in the current context",
      line: 42,
      column: 13,
    };
    const dirty: NodeDiagnostics = {
      node_id: 'unity://csharp/T:Foo.Bar',
      errors: 1,
      warnings: 2,
      infos: 0,
      max_severity: 'error',
      top_messages: [msg],
    };
    const clean: NodeDiagnostics = {
      node_id: 'unity://script/Assets/Scripts/Player.cs',
      errors: 0,
      warnings: 0,
      infos: 0,
      max_severity: 'none',
      top_messages: [],
    };
    const res: DiagnosticsBatchResponse = {
      generated_at: '2026-06-30T00:00:00Z',
      diagnostics: [dirty, clean],
      unresolved_ids: ['unity://csharp/T:Foo.Renamed'],
    };
    expect(res.diagnostics).toHaveLength(2);
    expect(res.diagnostics[0].max_severity).toBe('error');
    expect(res.diagnostics[1].errors).toBe(0);
    expect(res.unresolved_ids).toEqual(['unity://csharp/T:Foo.Renamed']);
  });

  it('allows include_messages=false responses with no top_messages', () => {
    const res: DiagnosticsBatchResponse = {
      generated_at: '2026-06-30T00:00:00Z',
      diagnostics: [
        {
          node_id: 'unity://csharp/T:Foo.Bar',
          errors: 3,
          warnings: 0,
          infos: 0,
          max_severity: 'error',
        },
      ],
    };
    expect(res.diagnostics[0].top_messages).toBeUndefined();
  });
});
