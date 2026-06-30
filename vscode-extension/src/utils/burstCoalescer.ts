/**
 * Day 7 — debounce + throttle for the watcher → cache pipeline.
 *
 * The watcher path needs two timing guarantees:
 *
 *   1. Trailing debounce — when the user finishes a burst of saves, the
 *      rebuild should fire shortly after the last event so the UI feels
 *      responsive.
 *   2. Hard throttle ceiling — when the burst never ends (e.g. Reimport All
 *      spraying events for 30s), the trailing-debounce-only model defers the
 *      rebuild forever. A ceiling guarantees we catch up at least every
 *      `maxWaitMs`.
 *
 * Implementation: every {@link schedule} call resets the debounce timer. The
 * first call inside an idle window also arms a ceiling timer. Whichever
 * fires first wins; both clear on fire (or on {@link cancel}).
 *
 * Re-entrant safety: `fire()` runs synchronously on the timer thread. If
 * `fire()` itself calls `schedule()` (e.g. because the rebuild signalled more
 * work), the next call starts a fresh window — the old timers are already
 * cleared by the time `fire()` is invoked.
 *
 * The class is timer-implementation-agnostic except for `setTimeout` /
 * `clearTimeout`; vitest's `vi.useFakeTimers()` drives it deterministically
 * in tests.
 */
export class BurstCoalescer {
  private debounceTimer?: NodeJS.Timeout;
  private ceilingTimer?: NodeJS.Timeout;

  constructor(
    /** Fired exactly once per coalesced burst. */
    private readonly fire: () => void,
    /** Idle gap before the trailing edge fires. ~150ms matches the
     *  user-perceived "is the action over" threshold. */
    private readonly debounceMs: number,
    /** Hard ceiling that catches sustained bursts. Must be > debounceMs. */
    private readonly maxWaitMs: number,
  ) {
    if (maxWaitMs <= debounceMs) {
      throw new Error(
        `BurstCoalescer: maxWaitMs (${maxWaitMs}) must be > debounceMs (${debounceMs})`,
      );
    }
  }

  /** Record an event. Idempotent within a debounce window. */
  schedule(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.fireNow(), this.debounceMs);
    if (!this.ceilingTimer) {
      this.ceilingTimer = setTimeout(() => this.fireNow(), this.maxWaitMs);
    }
  }

  /** Cancel any pending fire without invoking the callback. Used on dispose. */
  cancel(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.ceilingTimer) clearTimeout(this.ceilingTimer);
    this.debounceTimer = undefined;
    this.ceilingTimer = undefined;
  }

  /** True iff a fire is currently scheduled. Public for tests / introspection. */
  isPending(): boolean {
    return this.debounceTimer !== undefined || this.ceilingTimer !== undefined;
  }

  private fireNow(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.ceilingTimer) clearTimeout(this.ceilingTimer);
    this.debounceTimer = undefined;
    this.ceilingTimer = undefined;
    this.fire();
  }
}

/** Day-7 watcher → cache pipeline timing. Both VS Code and Rider use these
 *  numbers; drift would mean one host feels snappier than the other for the
 *  same user gesture. */
export const WATCHER_DEBOUNCE_MS = 150;
export const WATCHER_MAX_WAIT_MS = 1000;
