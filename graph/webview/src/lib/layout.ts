// Day 3 Task 6: ForceAtlas2 layout, main-thread, synchronous.
//
// Up to ~5k nodes this finishes in well under a second on a modern laptop
// and the UI freeze is imperceptible. Above that the freeze gets noticeable;
// Task 9 (perf guardrails) clamps with a soft cap before this is called, and
// Day 7 will swap in the webworker variant (graphology-layout-forceatlas2/worker).
// If you cross the cap-line, update both this comment and Task 9's threshold.
//
// Why not animate via the supervisor: Day 3 ships a static layout — a single
// pre-render pass is enough to spread nodes meaningfully. Live animation is a
// polish item, not a Day-3 deliverable.

import type Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { circular } from 'graphology-layout';

export interface LayoutOptions {
  iterations?: number;
}

const DEFAULT_ITERATIONS = 300;

// Day 3 caps. Sampled real Unity projects (docs/graph-decisions.md §rendering)
// produce ~8–13k file-level nodes — comfortably past SOFT_LAYOUT_CAP but
// short of HARD_RENDER_CAP. Day 7 swaps in the worker layout and removes
// both caps; update Task 9 of docs/graph-day3-tasks.md if you change them.
export const SOFT_LAYOUT_CAP = 5000;
export const HARD_RENDER_CAP = 20000;

export function layoutForceAtlas2(graph: Graph, opts: LayoutOptions = {}): void {
  if (graph.order === 0) return;
  const settings = forceAtlas2.inferSettings(graph);
  forceAtlas2.assign(graph, {
    iterations: opts.iterations ?? DEFAULT_ITERATIONS,
    settings,
  });
}

// Cheap O(n) ring layout. Used as the fallback when the graph is too big
// for main-thread ForceAtlas2 — nodes are spread predictably so the user
// at least sees the volume of data and can scroll/zoom while waiting for
// Day 7's worker layout.
export function layoutCircular(graph: Graph): void {
  if (graph.order === 0) return;
  circular.assign(graph, { scale: Math.max(1, Math.sqrt(graph.order) / 4) });
}
