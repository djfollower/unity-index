import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Graph from "graphology";
import {
  isWorkerSupported,
  layoutCircular,
  layoutForceAtlas2,
  LayoutSupervisor,
} from "../layout";

function smallGraph(): Graph {
  const g = new Graph({ type: "directed", multi: true });
  g.addNode("a", { x: 0, y: 0, size: 4 });
  g.addNode("b", { x: 0.1, y: -0.1, size: 4 });
  g.addNode("c", { x: -0.2, y: 0.3, size: 4 });
  g.addEdgeWithKey("a-b", "a", "b", { size: 1 });
  g.addEdgeWithKey("b-c", "b", "c", { size: 1 });
  return g;
}

describe("isWorkerSupported", () => {
  it("returns false in the node test environment (no Worker global)", () => {
    expect(isWorkerSupported()).toBe(false);
  });
});

describe("layoutForceAtlas2 / layoutCircular", () => {
  it("synchronous FA2 leaves nodes off the origin", () => {
    const g = smallGraph();
    layoutForceAtlas2(g, { iterations: 30 });
    const xs = g.mapNodes((_, attrs) => attrs.x as number);
    expect(xs.some((x) => Math.abs(x) > 0.01)).toBe(true);
  });

  it("circular spreads nodes onto a ring", () => {
    const g = smallGraph();
    layoutCircular(g);
    const positions: Array<[number, number]> = g.mapNodes(
      (_, attrs) => [attrs.x as number, attrs.y as number],
    );
    // Distances from origin should be roughly equal (ring layout).
    const r = positions.map(([x, y]) => Math.sqrt(x * x + y * y));
    const min = Math.min(...r);
    const max = Math.max(...r);
    expect(min).toBeGreaterThan(0);
    expect(max / min).toBeLessThan(2);
  });

  it("no-ops on an empty graph", () => {
    const g = new Graph();
    expect(() => layoutForceAtlas2(g)).not.toThrow();
    expect(() => layoutCircular(g)).not.toThrow();
  });
});

describe("LayoutSupervisor — Worker-unavailable fallback path", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    // The supervisor logs a single warn when Worker construction fails in
    // jsdom / node. Suppress it so test output stays readable.
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  it("start() does not throw when Worker is unavailable", () => {
    const g = smallGraph();
    const sup = new LayoutSupervisor(g);
    expect(() => sup.start(1000)).not.toThrow();
    sup.kill();
  });

  it("start() seeds the graph synchronously so nodes leave the origin", () => {
    const g = smallGraph();
    // Reset to origin so we can verify the seed pass.
    g.forEachNode((id) => {
      g.setNodeAttribute(id, "x", 0);
      g.setNodeAttribute(id, "y", 0);
    });
    // Slight jitter so FA2 has a gradient to work with.
    g.setNodeAttribute("a", "x", 0.001);
    g.setNodeAttribute("b", "y", -0.001);
    const sup = new LayoutSupervisor(g);
    sup.start(1000);
    const moved = g.mapNodes(
      (_, a) => Math.abs(a.x as number) + Math.abs(a.y as number),
    );
    expect(moved.some((m) => m > 0.01)).toBe(true);
    sup.kill();
  });

  it("kill() is idempotent and prevents subsequent start()", () => {
    const g = smallGraph();
    const sup = new LayoutSupervisor(g);
    sup.kill();
    sup.kill();
    sup.start(1000);
    expect(sup.isRunning()).toBe(false);
  });

  it("start() on an empty graph is a no-op", () => {
    const sup = new LayoutSupervisor(new Graph());
    expect(() => sup.start(1000)).not.toThrow();
    expect(sup.isRunning()).toBe(false);
  });

  it("stop() before start() does not throw", () => {
    const sup = new LayoutSupervisor(smallGraph());
    expect(() => sup.stop()).not.toThrow();
  });
});
