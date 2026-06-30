// Day 9.4 — chain highlighter coverage. The interesting case the plan
// names: prefab → script → class → MonoBehaviour. Hovering any node in
// that chain should light up all four.

import { describe, expect, it } from 'vitest';
import Graph from 'graphology';
import {
  MAX_CHAIN_HOPS,
  MAX_CHAIN_NODES,
  computeCrossDomainChain,
} from '../crossDomain';

function buildChainGraph(): Graph {
  const g = new Graph({ type: 'directed', multi: true });
  g.addNode('prefab:Player', { kind: 'prefab', label: 'Player.prefab' });
  g.addNode('script:PlayerController', { kind: 'script', label: 'PlayerController.cs' });
  g.addNode('unity://csharp/T:Game.PlayerController', { kind: 'class', label: 'PlayerController' });
  g.addNode('unity://csharp/T:UnityEngine.MonoBehaviour', { kind: 'class', label: 'MonoBehaviour' });
  // prefab uses the script
  g.addEdgeWithKey('e1', 'script:PlayerController', 'prefab:Player', { kind: 'script_used_by_prefab' });
  // script declares the class
  g.addEdgeWithKey('e2', 'script:PlayerController', 'unity://csharp/T:Game.PlayerController', { kind: 'script_declares_class' });
  // class inherits MonoBehaviour
  g.addEdgeWithKey('e3', 'unity://csharp/T:Game.PlayerController', 'unity://csharp/T:UnityEngine.MonoBehaviour', { kind: 'class_inherits_from' });
  return g;
}

describe('computeCrossDomainChain', () => {
  it('lights the full chain when hovering the script', () => {
    const g = buildChainGraph();
    const chain = computeCrossDomainChain(g, 'script:PlayerController');
    expect(chain.nodes.has('prefab:Player')).toBe(true);
    expect(chain.nodes.has('script:PlayerController')).toBe(true);
    expect(chain.nodes.has('unity://csharp/T:Game.PlayerController')).toBe(true);
    expect(chain.nodes.has('unity://csharp/T:UnityEngine.MonoBehaviour')).toBe(true);
    expect(chain.edges.size).toBe(3);
  });

  it('lights the full chain when hovering the prefab', () => {
    const g = buildChainGraph();
    const chain = computeCrossDomainChain(g, 'prefab:Player');
    expect(chain.nodes.size).toBe(4);
  });

  it('lights the full chain when hovering MonoBehaviour', () => {
    const g = buildChainGraph();
    const chain = computeCrossDomainChain(g, 'unity://csharp/T:UnityEngine.MonoBehaviour');
    expect(chain.nodes.has('prefab:Player')).toBe(true);
    expect(chain.nodes.has('script:PlayerController')).toBe(true);
  });

  it('returns empty chain when the focus has no script_declares_class crossing', () => {
    // Two prefabs that share a script — no class boundary in sight.
    const g = new Graph({ type: 'directed', multi: true });
    g.addNode('prefab:A', { kind: 'prefab' });
    g.addNode('prefab:B', { kind: 'prefab' });
    g.addNode('script:S', { kind: 'script' });
    g.addEdgeWithKey('e1', 'script:S', 'prefab:A', { kind: 'script_used_by_prefab' });
    g.addEdgeWithKey('e2', 'script:S', 'prefab:B', { kind: 'script_used_by_prefab' });
    const chain = computeCrossDomainChain(g, 'script:S');
    expect(chain.nodes.size).toBe(0);
    expect(chain.edges.size).toBe(0);
  });

  it('returns empty for a missing focus node', () => {
    const g = buildChainGraph();
    const chain = computeCrossDomainChain(g, 'nope');
    expect(chain.nodes.size).toBe(0);
  });

  it('respects max hop budget', () => {
    // Build a long inheritance chain: C0 → C1 → C2 → ... → C10, plus a
    // script that declares C0. With maxHops=2 we should reach C0 (1
    // hop via script_declares_class), C1 (2 hops), but not C2.
    const g = new Graph({ type: 'directed', multi: true });
    g.addNode('script:S', { kind: 'script' });
    g.addNode('unity://csharp/T:C0', { kind: 'class' });
    g.addEdgeWithKey('e0', 'script:S', 'unity://csharp/T:C0', { kind: 'script_declares_class' });
    for (let i = 0; i < 5; i++) {
      const parent = `unity://csharp/T:C${i + 1}`;
      g.addNode(parent, { kind: 'class' });
      g.addEdgeWithKey(`e${i + 1}`, `unity://csharp/T:C${i}`, parent, { kind: 'class_inherits_from' });
    }
    const chain = computeCrossDomainChain(g, 'script:S', 2);
    expect(chain.nodes.has('unity://csharp/T:C0')).toBe(true);
    expect(chain.nodes.has('unity://csharp/T:C1')).toBe(true);
    expect(chain.nodes.has('unity://csharp/T:C2')).toBe(false);
  });

  it('caps total chain size at MAX_CHAIN_NODES', () => {
    // Star around a class: 500 scripts all declaring the same class. The
    // chain visit must stop early so the reducer never sees more than the
    // cap.
    const g = new Graph({ type: 'directed', multi: true });
    g.addNode('unity://csharp/T:Hub', { kind: 'class' });
    for (let i = 0; i < 500; i++) {
      g.addNode(`script:S${i}`, { kind: 'script' });
      g.addEdgeWithKey(`e${i}`, `script:S${i}`, 'unity://csharp/T:Hub', { kind: 'script_declares_class' });
    }
    const chain = computeCrossDomainChain(g, 'unity://csharp/T:Hub');
    expect(chain.nodes.size).toBeLessThanOrEqual(MAX_CHAIN_NODES);
  });
});

describe('exported constants', () => {
  it('expose hop/node caps for the reducer to read', () => {
    expect(MAX_CHAIN_HOPS).toBeGreaterThan(0);
    expect(MAX_CHAIN_NODES).toBeGreaterThan(0);
  });
});
