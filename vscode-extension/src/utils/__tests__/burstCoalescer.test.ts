import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BurstCoalescer } from "../burstCoalescer";

describe("BurstCoalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once after the debounce gap when events stop", () => {
    const fire = vi.fn();
    const c = new BurstCoalescer(fire, 100, 1000);
    c.schedule();
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("repeated schedules within the debounce window extend the trailing edge", () => {
    const fire = vi.fn();
    const c = new BurstCoalescer(fire, 100, 1000);
    c.schedule();
    vi.advanceTimersByTime(80);
    c.schedule(); // resets debounce
    vi.advanceTimersByTime(80);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(25);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("ceiling fires when bursts never stop within maxWaitMs", () => {
    const fire = vi.fn();
    const c = new BurstCoalescer(fire, 100, 1000);
    // Rapid-fire every 50ms — the trailing-debounce edge is never reached.
    for (let i = 0; i < 25; i += 1) {
      c.schedule();
      vi.advanceTimersByTime(50);
    }
    // 25 * 50 = 1250ms elapsed; ceiling fired at 1000ms regardless.
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("fires only once per coalesced burst", () => {
    const fire = vi.fn();
    const c = new BurstCoalescer(fire, 100, 1000);
    c.schedule();
    vi.advanceTimersByTime(101);
    expect(fire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("a new burst after a fire starts a fresh window", () => {
    const fire = vi.fn();
    const c = new BurstCoalescer(fire, 100, 1000);
    c.schedule();
    vi.advanceTimersByTime(150);
    expect(fire).toHaveBeenCalledTimes(1);
    c.schedule();
    vi.advanceTimersByTime(150);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("cancel() drops pending fire without invoking", () => {
    const fire = vi.fn();
    const c = new BurstCoalescer(fire, 100, 1000);
    c.schedule();
    c.cancel();
    vi.advanceTimersByTime(2000);
    expect(fire).not.toHaveBeenCalled();
    expect(c.isPending()).toBe(false);
  });

  it("rejects maxWaitMs <= debounceMs to prevent silent misconfigurations", () => {
    expect(() => new BurstCoalescer(() => {}, 100, 100)).toThrow();
    expect(() => new BurstCoalescer(() => {}, 200, 100)).toThrow();
  });

  it("isPending reflects active state", () => {
    const c = new BurstCoalescer(vi.fn(), 100, 1000);
    expect(c.isPending()).toBe(false);
    c.schedule();
    expect(c.isPending()).toBe(true);
    vi.advanceTimersByTime(150);
    expect(c.isPending()).toBe(false);
  });
});
