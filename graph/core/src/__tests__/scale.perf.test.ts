// Day 7 Task 9 — perf budgets at the "scale matters" boundary.
//
// These tests guard the in-memory operations that the host watchers fire on
// every edit burst. The disk-walking part of UnityAssetGraphBuilder is NOT
// tested here — that path is dominated by VFS / fs.readFile latency and is
// covered by manual perf passes in real Unity projects.
//
// Budgets are conservative — set to ~3x the median observed on the dev
// machine (MacBook M-series) so the tests don't go red on a busy CI runner
// while still catching real algorithmic regressions. If you change a budget,
// document the why in the same commit.
//
// Why use `performance.now()`: vitest runs in node which exposes a
// high-resolution clock without any DOM. We measure the median of 3 runs to
// reject one-off GC pauses; the median is what the budget caps.

import { describe, expect, it } from 'vitest';
import { diffSnapshots, isEmptyDelta } from '../snapshot-diff.js';
import { buildAdjacency, neighbors, impact } from '../traversal.js';
import {
  DEFAULT_EDGE_COUNT,
  DEFAULT_NODE_COUNT,
  buildScaleSnapshot,
  perturbSnapshot,
} from './scale.fixtures.js';

function median(times: number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function measureMs(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

// One synthetic 10k/30k snapshot, reused across tests. Building it isn't
// free (~50ms) so we amortise across the suite rather than rebuilding per
// test.
const base = buildScaleSnapshot({
  nodeCount: DEFAULT_NODE_COUNT,
  edgeCount: DEFAULT_EDGE_COUNT,
});

describe('scale fixture sanity', () => {
  it('builds at the requested node count', () => {
    expect(base.snapshot.nodes.length).toBe(DEFAULT_NODE_COUNT);
  });

  it('builds at (close to) the requested edge count', () => {
    // The generator falls back to script_declares_class to fill any deficit,
    // but it can be a few short if duplicates exhaust the script pool.
    expect(base.snapshot.edges.length).toBeGreaterThan(DEFAULT_EDGE_COUNT - 200);
    expect(base.snapshot.edges.length).toBeLessThanOrEqual(DEFAULT_EDGE_COUNT);
  });

  it('every node id is unique (the diff identity rule depends on this)', () => {
    const ids = new Set(base.snapshot.nodes.map((n) => n.id));
    expect(ids.size).toBe(base.snapshot.nodes.length);
  });
});

describe('perf budgets — 10k nodes / 30k edges', () => {
  it('diffSnapshots against an unchanged snapshot completes in <200ms', () => {
    const ms = median([
      measureMs(() => diffSnapshots(base.snapshot, base.snapshot, {
        base_revision: 1,
        new_revision: 2,
      })),
      measureMs(() => diffSnapshots(base.snapshot, base.snapshot, {
        base_revision: 1,
        new_revision: 2,
      })),
      measureMs(() => diffSnapshots(base.snapshot, base.snapshot, {
        base_revision: 1,
        new_revision: 2,
      })),
    ]);
    expect(ms).toBeLessThan(200);
  });

  it('diffSnapshots against ~100 changed files completes in <200ms', () => {
    const { snapshot: next } = perturbSnapshot(
      base.snapshot,
      base.byKind,
      100,
    );
    const ms = median([
      measureMs(() => diffSnapshots(base.snapshot, next, {
        base_revision: 1,
        new_revision: 2,
      })),
      measureMs(() => diffSnapshots(base.snapshot, next, {
        base_revision: 1,
        new_revision: 2,
      })),
      measureMs(() => diffSnapshots(base.snapshot, next, {
        base_revision: 1,
        new_revision: 2,
      })),
    ]);
    expect(ms).toBeLessThan(200);
  });

  it('the diff actually carries the ~100-file change set', () => {
    const { snapshot: next } = perturbSnapshot(
      base.snapshot,
      base.byKind,
      100,
    );
    const d = diffSnapshots(base.snapshot, next, {
      base_revision: 1,
      new_revision: 2,
    });
    expect(isEmptyDelta(d)).toBe(false);
    // 100 changed files split 1/3 add + 1/3 update + 1/3 remove. Some
    // updates land on the same node twice (rng collision), so the bucket
    // totals can be slightly off — broad bounds catch real bugs.
    expect(d.nodes_added.length).toBeGreaterThan(20);
    expect(d.nodes_removed.length).toBeGreaterThan(20);
    expect(d.nodes_updated.length).toBeGreaterThan(0);
  });

  it('buildAdjacency on 10k/30k completes in <150ms', () => {
    const ms = median([
      measureMs(() => buildAdjacency(base.snapshot)),
      measureMs(() => buildAdjacency(base.snapshot)),
      measureMs(() => buildAdjacency(base.snapshot)),
    ]);
    expect(ms).toBeLessThan(150);
  });

  it('neighbors hop=2 from a random seed completes in <50ms', () => {
    const adj = buildAdjacency(base.snapshot);
    const seed = base.byKind.script![0]!;
    const ms = median([
      measureMs(() => neighbors(adj, [seed], { hops: 2, direction: 'both', maxNodes: 1000 })),
      measureMs(() => neighbors(adj, [seed], { hops: 2, direction: 'both', maxNodes: 1000 })),
      measureMs(() => neighbors(adj, [seed], { hops: 2, direction: 'both', maxNodes: 1000 })),
    ]);
    expect(ms).toBeLessThan(50);
  });

  it('impact analysis from a random script seed completes in <100ms', () => {
    const adj = buildAdjacency(base.snapshot);
    const seed = base.byKind.script![0]!;
    const ms = median([
      measureMs(() => impact(adj, [seed], { maxNodes: 1000 })),
      measureMs(() => impact(adj, [seed], { maxNodes: 1000 })),
      measureMs(() => impact(adj, [seed], { maxNodes: 1000 })),
    ]);
    expect(ms).toBeLessThan(100);
  });
});
