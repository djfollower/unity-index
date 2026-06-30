import { describe, expect, it } from 'vitest';
import type { GraphEdge } from '../graph-types.js';
import {
  EDGE_KEY_SEPARATOR,
  edgeKey,
  isApplicableDelta,
  SNAPSHOT_DELTA_AFFECTED_PATHS_CAP,
  SNAPSHOT_DELTA_MAX_HISTORY,
  WARNING_DELTA_AFFECTED_PATHS_TRUNCATED,
  WARNING_DELTA_RESET,
  type EdgeKey,
  type SnapshotDelta,
  type SnapshotDeltaRequest,
  type SnapshotDeltaResponse,
} from '../snapshot-delta-wire.js';
import { SNAPSHOT_DELTA_GRAPH_TYPE } from '../messages.js';

const edge: GraphEdge = {
  source: 'asset::A',
  target: 'asset::B',
  kind: 'script_used_by_prefab',
  metadata: {},
};

const sep = EDGE_KEY_SEPARATOR;

describe('edgeKey', () => {
  it('canonicalises (source, target, kind) into a stable string', () => {
    expect(edgeKey(edge)).toBe(
      `asset::A${sep}asset::B${sep}script_used_by_prefab`,
    );
  });

  it('accepts a bare EdgeKey too', () => {
    const k: EdgeKey = {
      source: 'a',
      target: 'b',
      kind: 'guid_resolves_to',
    };
    expect(edgeKey(k)).toBe(`a${sep}b${sep}guid_resolves_to`);
  });

  it('uses ASCII Unit Separator (U+001F) so paths and namespaces never collide', () => {
    expect(EDGE_KEY_SEPARATOR).toBe('');
    // A space-containing path component (`foo bar`) followed by a target
    // whose first char is a space must still produce a unique key — possible
    // only if the separator isn't whitespace.
    const a: EdgeKey = {
      source: 'foo bar',
      target: 'baz',
      kind: 'serialized_binding',
    };
    const b: EdgeKey = {
      source: 'foo',
      target: 'bar baz',
      kind: 'serialized_binding',
    };
    expect(edgeKey(a)).not.toBe(edgeKey(b));
  });

  it('distinguishes edges that differ only by kind', () => {
    const a: EdgeKey = { source: 's', target: 't', kind: 'serialized_binding' };
    const b: EdgeKey = { source: 's', target: 't', kind: 'guid_resolves_to' };
    expect(edgeKey(a)).not.toBe(edgeKey(b));
  });

  it('distinguishes edges that differ only by direction', () => {
    const a: EdgeKey = { source: 's', target: 't', kind: 'serialized_binding' };
    const b: EdgeKey = { source: 't', target: 's', kind: 'serialized_binding' };
    expect(edgeKey(a)).not.toBe(edgeKey(b));
  });
});

const blankStats = {
  node_count: 0,
  edge_count: 0,
  skipped_component_instances: 0,
  skipped_component_fields: 0,
};

const emptyDelta = (overrides: Partial<SnapshotDelta> = {}): SnapshotDelta => ({
  base_revision: 1,
  new_revision: 2,
  generated_at: '2026-06-29T00:00:00Z',
  source_phase: 'asset',
  nodes_added: [],
  nodes_removed: [],
  nodes_updated: [],
  edges_added: [],
  edges_removed: [],
  stats: blankStats,
  ...overrides,
});

describe('isApplicableDelta', () => {
  it('passes when the client revision matches and revision moves forward', () => {
    expect(isApplicableDelta(emptyDelta(), 1)).toBe(true);
  });

  it('fails when client revision is behind the delta base', () => {
    expect(isApplicableDelta(emptyDelta({ base_revision: 5 }), 1)).toBe(false);
  });

  it('fails when client revision is ahead of the delta base', () => {
    expect(isApplicableDelta(emptyDelta({ base_revision: 1 }), 5)).toBe(false);
  });

  it('fails when new_revision does not move forward', () => {
    expect(
      isApplicableDelta(
        emptyDelta({ base_revision: 5, new_revision: 5 }),
        5,
      ),
    ).toBe(false);
  });

  it('fails when new_revision moves backward', () => {
    expect(
      isApplicableDelta(
        emptyDelta({ base_revision: 5, new_revision: 4 }),
        5,
      ),
    ).toBe(false);
  });
});

describe('wire constants', () => {
  it('exposes a stable type literal for the bridge', () => {
    expect(SNAPSHOT_DELTA_GRAPH_TYPE).toBe('unity_graph_snapshot_delta');
  });

  it('exposes stable warning codes', () => {
    expect(WARNING_DELTA_RESET).toBe('delta_reset');
    expect(WARNING_DELTA_AFFECTED_PATHS_TRUNCATED).toBe(
      'delta_affected_paths_truncated',
    );
  });

  it('exposes sane budget defaults', () => {
    expect(SNAPSHOT_DELTA_MAX_HISTORY).toBeGreaterThan(0);
    expect(SNAPSHOT_DELTA_AFFECTED_PATHS_CAP).toBeGreaterThan(0);
  });
});

// Compile-time shape sanity. The tests below don't execute meaningful logic —
// they exist so TS will fail loudly if a wire field gets renamed or its type
// drifts, which is the most common way a contract breaks between Kotlin and
// TS implementations.
describe('wire shapes typecheck', () => {
  it('SnapshotDeltaRequest accepts the documented filter fields', () => {
    const req: SnapshotDeltaRequest = {
      project_path: '/tmp/proj',
      request_id: 'r1',
      since_revision: 7,
      include_kinds: ['script', 'prefab'],
      exclude_kinds: ['so'],
      path_globs: ['Assets/**'],
      include_orphans: false,
    };
    expect(req.since_revision).toBe(7);
  });

  it('SnapshotDeltaResponse models the reset / delta branches', () => {
    const reset: SnapshotDeltaResponse = {
      generated_at: '2026-06-29T00:00:00Z',
      reset: true,
      new_revision: 42,
      snapshot: {
        nodes: [],
        edges: [],
        generated_at: '2026-06-29T00:00:00Z',
        source_phase: 'asset',
        stats: blankStats,
      },
      warnings: [
        {
          code: WARNING_DELTA_RESET,
          message: 'host restarted',
          context: { reason: 'server_restart' },
        },
      ],
    };

    const incremental: SnapshotDeltaResponse = {
      generated_at: '2026-06-29T00:00:00Z',
      reset: false,
      new_revision: 43,
      delta: emptyDelta({ base_revision: 42, new_revision: 43 }),
    };

    expect(reset.reset).toBe(true);
    expect(incremental.reset).toBe(false);
  });
});
