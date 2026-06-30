// ForceAtlas2 layout. Day 3 shipped a synchronous main-thread variant; Day 7
// adds {@link LayoutSupervisor}, which delegates iteration to a Web Worker so
// 10k-node projects don't freeze the panel.
//
// Two public modes:
//
//   - {@link layoutForceAtlas2} / {@link layoutCircular} — synchronous, used
//     for standalone mode, tests (jsdom has no `Worker`), and as the
//     supervisor's fallback when worker construction fails.
//
//   - {@link LayoutSupervisor} — async, worker-backed. Wraps
//     `graphology-layout-forceatlas2/worker`. The supervisor mutates the
//     graph's node `x`/`y` continuously while running; Sigma listens to
//     graph events and repaints automatically. Caller drives the lifecycle
//     (start with a duration, stop, kill on destroy).
//
// CSP note: the worker module ships its body as an inline JS string and the
// supervisor wraps it in a Blob URL. `worker-src blob:` must be permitted —
// the vscode-bridge HTML transformer and the rider-bridge JCEF scheme
// handler both include it (see Day 0.A).

import type Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import FA2LayoutSupervisor from 'graphology-layout-forceatlas2/worker';
import { circular } from 'graphology-layout';

export interface LayoutOptions {
  iterations?: number;
}

const DEFAULT_ITERATIONS = 300;

// Day-3 caps. Day 7's worker pipeline lets us render past SOFT_LAYOUT_CAP
// without the UI freeze — App.svelte uses the supervisor whenever a Worker
// is available and falls back to these on tests / Worker-less hosts. The
// HARD_RENDER_CAP remains: above ~20k nodes Sigma's WebGL pipeline itself
// gets slow regardless of where layout runs.
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

export function layoutCircular(graph: Graph): void {
  if (graph.order === 0) return;
  circular.assign(graph, { scale: Math.max(1, Math.sqrt(graph.order) / 4) });
}

// ---------------------------------------------------------------------------
// Day 7 — worker-backed layout supervisor.
// ---------------------------------------------------------------------------

/** True when the runtime can spawn a Web Worker. False under vitest/jsdom
 *  and in any host that strips the constructor. Callers can branch on this
 *  to decide whether to use {@link LayoutSupervisor} or stay synchronous. */
export function isWorkerSupported(): boolean {
  return typeof Worker !== 'undefined';
}

/**
 * Owns one `FA2LayoutSupervisor` per graph. Lifecycle is caller-driven:
 *
 *   const sup = new LayoutSupervisor(graph);
 *   sup.start(5000);   // bake for 5s, then auto-stop
 *   // …user interacts; Sigma repaints as positions stream in…
 *   sup.kick(1500);    // delta added new nodes — settle for another 1.5s
 *   sup.kill();        // on destroy / new snapshot
 *
 * The supervisor seeds positions with a synchronous one-shot pass before
 * starting the worker, so node placement is never (0, 0) — the worker
 * iterates from a reasonable starting state and converges faster. Without
 * the seed, FA2 deadlocks at the origin when every node starts at the same
 * point.
 */
export class LayoutSupervisor {
  private readonly graph: Graph;
  private impl: FA2LayoutSupervisor | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private killed = false;

  constructor(graph: Graph) {
    this.graph = graph;
  }

  /** Begin (or re-begin) layout iteration. Auto-stops after `durationMs`. */
  start(durationMs: number): void {
    if (this.killed) return;
    if (this.graph.order === 0) return;
    this.seedIfNeeded();
    if (!this.impl) {
      try {
        const settings = forceAtlas2.inferSettings(this.graph);
        this.impl = new FA2LayoutSupervisor(this.graph, { settings });
      } catch (e) {
        // Worker construction can fail under restrictive CSP or when the
        // worker module's Blob URL is rejected. Fall back to the sync
        // pass we already did during seeding — at least the user sees a
        // laid-out graph, just not animated.
        console.warn('[unity-index-graph] worker layout unavailable:', e);
        this.killed = true;
        return;
      }
    }
    if (!this.impl.isRunning()) this.impl.start();
    this.armStopTimer(durationMs);
  }

  /** Extend an already-running layout for another `durationMs`, or start a
   *  fresh burst if currently stopped. Used after a delta apply so newly-
   *  added nodes settle without forcing a full re-bake. */
  kick(durationMs: number): void {
    this.start(durationMs);
  }

  /** Pause iteration immediately. The supervisor instance stays alive so a
   *  subsequent `start()` can resume without re-spawning the worker. */
  stop(): void {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.impl?.isRunning()) this.impl.stop();
  }

  /** Tear down the worker and detach its graph listeners. Idempotent. */
  kill(): void {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.impl) {
      this.impl.kill();
      this.impl = null;
    }
    this.killed = true;
  }

  isRunning(): boolean {
    return this.impl?.isRunning() ?? false;
  }

  private armStopTimer(durationMs: number): void {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      if (this.impl?.isRunning()) this.impl.stop();
    }, durationMs);
  }

  /**
   * One synchronous FA2 pass to lift nodes off the origin before the worker
   * spins up. `snapshotToGraph` already seeds random `[-1, 1]` positions, so
   * we only need a short pass (~50 iterations) to give the worker a sensible
   * starting state — the worker then refines further.
   *
   * Skipped when the graph already has non-trivial positions (a previous
   * supervisor run, or a manual layout call upstream).
   */
  private seedIfNeeded(): void {
    if (this.impl) return; // worker is already animating; positions are live
    if (this.graph.order > SOFT_LAYOUT_CAP) {
      // Sync FA2 above the soft cap freezes the UI — fall back to circular
      // for seeding. The worker still iterates against a circular layout.
      layoutCircular(this.graph);
      return;
    }
    layoutForceAtlas2(this.graph, { iterations: 50 });
  }
}
