// Day 7 Task 9 — perf budget for the webview's delta apply path.
//
// The host watcher fires up to once per 1s ceiling under sustained edit
// bursts (see WATCHER_MAX_WAIT_MS); the webview's poll interval is 1.5s.
// applyDeltaToGraph runs once per delta poll — anything north of a few tens
// of ms here would compete with the 60Hz rAF budget Sigma uses for layout
// streaming.
//
// Budget: <30ms median for a 100-file delta against a 10k-node base.

import { describe, expect, it } from 'vitest';
import Graph from 'graphology';
import {
  DEFAULT_EDGE_COUNT,
  DEFAULT_NODE_COUNT,
  buildScaleSnapshot,
  perturbSnapshot,
} from '../../../../core/src/__tests__/scale.fixtures.js';
import { diffSnapshots } from '../../../../core/src/snapshot-diff.js';
import { buildGraphologyGraph } from '../snapshotToGraph';
import { applyDeltaToGraph } from '../applyDelta';

function median(times: number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function measure(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

const base = buildScaleSnapshot({
  nodeCount: DEFAULT_NODE_COUNT,
  edgeCount: DEFAULT_EDGE_COUNT,
});

describe('applyDeltaToGraph perf — 10k base, 100-file delta', () => {
  it('apply completes in <10ms median against a prebuilt 10k graph', () => {
    // Each measurement must apply against a FRESH graph copy — otherwise
    // the second apply sees a no-op (the first call mutated the graph)
    // and the median misleads. Prebuild three independent graphs.
    const { snapshot: next } = perturbSnapshot(
      base.snapshot,
      base.byKind,
      100,
    );
    const delta = diffSnapshots(base.snapshot, next, {
      base_revision: 1,
      new_revision: 2,
    });
    const graphs = [
      buildGraphologyGraph(base.snapshot).graph,
      buildGraphologyGraph(base.snapshot).graph,
      buildGraphologyGraph(base.snapshot).graph,
    ];
    const ms = median(
      graphs.map((g) => measure(() => applyDeltaToGraph(g, delta))),
    );
    expect(ms).toBeLessThan(10);
  });

  it('apply of an empty delta is sub-millisecond', () => {
    const { graph } = buildGraphologyGraph(base.snapshot);
    const noop = diffSnapshots(base.snapshot, base.snapshot, {
      base_revision: 1,
      new_revision: 2,
    });
    const ms = median([
      measure(() => applyDeltaToGraph(graph, noop)),
      measure(() => applyDeltaToGraph(graph, noop)),
      measure(() => applyDeltaToGraph(graph, noop)),
    ]);
    expect(ms).toBeLessThan(5);
  });
});

// Suppress unused-import warning for Graph (kept as a transitive type).
void Graph;
