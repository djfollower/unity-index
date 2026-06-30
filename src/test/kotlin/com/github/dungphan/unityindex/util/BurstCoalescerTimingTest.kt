package com.github.dungphan.unityindex.util

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Day 7 — coalescer timing tests. Algorithmic mirror of
 * `vscode-extension/src/utils/__tests__/burstCoalescer.test.ts`.
 *
 * The TS side tests behaviour with fake timers; here we test the pure delay
 * computation that drives an IntelliJ Alarm. The Alarm itself is trusted
 * (platform-provided) and exercised in real Rider sessions, not in unit tests.
 */
class BurstCoalescerTimingTest {

    @Test
    fun `first event arms a fresh window with debounce delay`() {
        val state = BurstCoalescerTiming.State()
        val delay = state.scheduleAndNextDelay(now = 1_000_000L, debounceMs = 150, maxWaitMs = 1000)
        assertEquals(150, delay)
        assertEquals(1_000_000L, state.burstStartedAt)
    }

    @Test
    fun `subsequent events within debounce window keep returning debounceMs`() {
        val state = BurstCoalescerTiming.State()
        val start = 1_000_000L
        state.scheduleAndNextDelay(start, 150, 1000)
        val mid = state.scheduleAndNextDelay(start + 50, 150, 1000)
        assertEquals(150, mid)
    }

    @Test
    fun `delay shrinks toward the ceiling as time elapses`() {
        val state = BurstCoalescerTiming.State()
        val start = 1_000_000L
        state.scheduleAndNextDelay(start, 150, 1000)
        // 900ms into the burst — debounce would defer to 1050ms, but the
        // ceiling fires at 1000ms (100ms from now).
        val delay = state.scheduleAndNextDelay(start + 900, 150, 1000)
        assertEquals(100, delay)
    }

    @Test
    fun `delay clamps to zero when the ceiling has already elapsed`() {
        val state = BurstCoalescerTiming.State()
        val start = 1_000_000L
        state.scheduleAndNextDelay(start, 150, 1000)
        val delay = state.scheduleAndNextDelay(start + 2000, 150, 1000)
        assertEquals(0, delay)
    }

    @Test
    fun `fired() resets the window so the next event starts fresh`() {
        val state = BurstCoalescerTiming.State()
        val start = 1_000_000L
        state.scheduleAndNextDelay(start, 150, 1000)
        state.scheduleAndNextDelay(start + 500, 150, 1000)
        state.fired()
        assertEquals(-1L, state.burstStartedAt)
        // After firing, the burst start should be the NEW event, not the original.
        val delay = state.scheduleAndNextDelay(start + 600, 150, 1000)
        assertEquals(150, delay)
        assertEquals(start + 600, state.burstStartedAt)
    }

    @Test
    fun `nextDelay is pure and does not need state`() {
        // At t=0, ceiling fires in maxWaitMs.
        assertEquals(150, BurstCoalescerTiming.nextDelay(0, 0, 150, 1000))
        // At t=900, ceiling fires in 100ms.
        assertEquals(100, BurstCoalescerTiming.nextDelay(900, 0, 150, 1000))
        // At t=1500, ceiling already past; clamp to 0.
        assertEquals(0, BurstCoalescerTiming.nextDelay(1500, 0, 150, 1000))
    }

    @Test
    fun `rejects maxWaitMs equal to or below debounceMs`() {
        val state = BurstCoalescerTiming.State()
        assertThrows(IllegalArgumentException::class.java) {
            state.scheduleAndNextDelay(now = 0, debounceMs = 150, maxWaitMs = 150)
        }
        assertThrows(IllegalArgumentException::class.java) {
            state.scheduleAndNextDelay(now = 0, debounceMs = 200, maxWaitMs = 100)
        }
    }

    @Test
    fun `production constants match the TS contract`() {
        // Drift here means one host feels snappier than the other for the
        // same user gesture. Keep WATCHER_* in lockstep with
        // vscode-extension/src/utils/burstCoalescer.ts.
        assertEquals(150, WATCHER_DEBOUNCE_MS)
        assertEquals(1000, WATCHER_MAX_WAIT_MS)
        assertTrue(WATCHER_MAX_WAIT_MS > WATCHER_DEBOUNCE_MS)
    }
}
