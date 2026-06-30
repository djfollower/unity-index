package com.github.dungphan.unityindex.util

/**
 * Day 7 — pure timing helper for the watcher → cache pipeline. Algorithmic
 * mirror of `vscode-extension/src/utils/burstCoalescer.ts`.
 *
 * The watcher path needs two guarantees:
 *
 *   1. Trailing debounce — when the user finishes a burst of saves, the
 *      rebuild fires shortly after the last event so the UI feels responsive.
 *   2. Hard throttle ceiling — when the burst never ends (e.g. Reimport All
 *      spraying events for 30s), the trailing-debounce-only model defers
 *      the rebuild forever. A ceiling guarantees we catch up at least every
 *      [maxWaitMs].
 *
 * This object is pure (no I/O, no platform deps); IntelliJ's `Alarm` drives
 * it from the cache. Keeping it pure lets the JUnit5 test target it without
 * a platform fixture.
 *
 * Usage pattern:
 * ```
 * private val timing = BurstCoalescerTiming.State()
 * fun onEvent(now: Long) {
 *     val delay = timing.scheduleAndNextDelay(now, DEBOUNCE_MS, MAX_WAIT_MS)
 *     alarm.cancelAllRequests()
 *     alarm.addRequest({ fire(); timing.fired() }, delay)
 * }
 * ```
 */
object BurstCoalescerTiming {

    /** Mutable bookkeeping. Single-threaded by convention — guard with the
     *  same lock the caller uses for its other state. */
    class State {
        /** Wall-clock ms when the current burst's first event arrived, or
         *  `-1` when idle (no pending fire). */
        var burstStartedAt: Long = -1L
            private set

        /** Called from the caller's `fire()` after the rebuild completes (or
         *  from a cancel path). Resets the window so the next event starts
         *  a fresh debounce + ceiling. */
        fun fired() {
            burstStartedAt = -1L
        }

        /** Pure: given a new event at `now`, return the delay (ms, ≥ 0)
         *  until the timer should fire. Updates internal state to remember
         *  the burst start. The caller cancels any previously-scheduled
         *  timer and arms a new one with this delay. */
        fun scheduleAndNextDelay(now: Long, debounceMs: Int, maxWaitMs: Int): Int {
            require(maxWaitMs > debounceMs) {
                "maxWaitMs ($maxWaitMs) must be > debounceMs ($debounceMs)"
            }
            if (burstStartedAt < 0L) burstStartedAt = now
            return nextDelay(now, burstStartedAt, debounceMs, maxWaitMs)
        }
    }

    /**
     * Pure delay computation. Exposed for testing and for callers that want
     * to know the next fire time without mutating state.
     *
     * Returns the smaller of:
     *   - `debounceMs` (trailing edge: fire after this idle gap), and
     *   - `maxWaitMs - (now - burstStartedAt)` (ceiling: hard upper bound).
     *
     * Always non-negative; clamps to 0 when the ceiling has already elapsed
     * (caller should fire immediately).
     */
    fun nextDelay(
        now: Long,
        burstStartedAt: Long,
        debounceMs: Int,
        maxWaitMs: Int,
    ): Int {
        val elapsed = (now - burstStartedAt).coerceAtLeast(0L)
        val ceilingRemaining = (maxWaitMs - elapsed).coerceAtLeast(0L)
        return minOf(debounceMs.toLong(), ceilingRemaining).toInt()
    }
}

/** Day-7 watcher → cache pipeline timing. Must match the TS-side
 *  `WATCHER_DEBOUNCE_MS` / `WATCHER_MAX_WAIT_MS` in burstCoalescer.ts —
 *  drift means one host feels snappier than the other for the same user
 *  gesture. */
const val WATCHER_DEBOUNCE_MS = 150
const val WATCHER_MAX_WAIT_MS = 1000
