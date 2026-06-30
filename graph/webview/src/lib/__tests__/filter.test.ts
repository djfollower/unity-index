import { describe, expect, it } from 'vitest';
import Graph from 'graphology';
import {
  collectPresentEdgeKinds,
  collectPresentKinds,
  computeMatches,
  reconcileHiddenKinds,
} from '../filter';

function buildGraph(): Graph {
  const g = new Graph({ type: 'directed', multi: true });
  g.addNode('script:Player', {
    label: 'Player.cs',
    kind: 'script',
    path: 'Assets/Scripts/Player.cs',
  });
  g.addNode('script:Enemy', {
    label: 'Enemy.cs',
    kind: 'script',
    path: 'Assets/Scripts/Enemy.cs',
  });
  g.addNode('prefab:Player', {
    label: 'Player.prefab',
    kind: 'prefab',
    path: 'Assets/Prefabs/Player.prefab',
  });
  g.addNode('scene:Main', {
    label: 'Main.unity',
    kind: 'scene',
    path: 'Assets/Scenes/Main.unity',
  });
  return g;
}

describe('computeMatches', () => {
  it('empty query returns no matches', () => {
    const g = buildGraph();
    const { matched, ranked } = computeMatches(g, '');
    expect(matched.size).toBe(0);
    expect(ranked).toEqual([]);
  });

  it('matches against labels and paths', () => {
    const g = buildGraph();
    const { matched } = computeMatches(g, 'player');
    expect(matched.has('script:Player')).toBe(true);
    expect(matched.has('prefab:Player')).toBe(true);
    expect(matched.has('script:Enemy')).toBe(false);
  });

  it('ranks label matches above path-only matches', () => {
    const g = new Graph();
    g.addNode('a', { label: 'Player.cs', kind: 'script', path: 'Foo/Bar.cs' });
    g.addNode('b', { label: 'Bar.cs', kind: 'script', path: 'Foo/Player/Bar.cs' });
    const { ranked } = computeMatches(g, 'player');
    expect(ranked[0]).toBe('a');
  });

  it('trims whitespace queries', () => {
    const g = buildGraph();
    const { matched } = computeMatches(g, '   ');
    expect(matched.size).toBe(0);
  });
});

describe('reconcileHiddenKinds', () => {
  it('keeps kinds that still appear in the snapshot', () => {
    expect(reconcileHiddenKinds(['script', 'prefab'], new Set(['script', 'prefab', 'scene'])))
      .toEqual(['script', 'prefab']);
  });

  it('drops kinds the snapshot no longer carries', () => {
    expect(reconcileHiddenKinds(['script', 'addressable_group'], new Set(['script'])))
      .toEqual(['script']);
  });

  it('handles empty stored list', () => {
    expect(reconcileHiddenKinds([], new Set(['script']))).toEqual([]);
  });
});

describe('collectPresentKinds', () => {
  it('counts nodes per kind', () => {
    const g = buildGraph();
    const counts = collectPresentKinds(g);
    expect(counts.get('script')).toBe(2);
    expect(counts.get('prefab')).toBe(1);
    expect(counts.get('scene')).toBe(1);
  });

  it('treats missing kind attr as unknown', () => {
    const g = new Graph();
    g.addNode('a', { label: 'x' });
    const counts = collectPresentKinds(g);
    expect(counts.get('unknown')).toBe(1);
  });
});

describe('collectPresentEdgeKinds', () => {
  it('collects every edge kind seen', () => {
    const g = new Graph({ type: 'directed', multi: true });
    g.addNode('a');
    g.addNode('b');
    g.addNode('c');
    g.addEdgeWithKey('e1', 'a', 'b', { kind: 'class_inherits_from' });
    g.addEdgeWithKey('e2', 'b', 'c', { kind: 'method_calls_method' });
    g.addEdgeWithKey('e3', 'a', 'c', { kind: 'method_calls_method' });
    const kinds = collectPresentEdgeKinds(g);
    expect(kinds.has('class_inherits_from')).toBe(true);
    expect(kinds.has('method_calls_method')).toBe(true);
    expect(kinds.size).toBe(2);
  });

  it('skips edges with a non-string kind attr', () => {
    const g = new Graph({ type: 'directed', multi: true });
    g.addNode('a');
    g.addNode('b');
    g.addEdgeWithKey('e1', 'a', 'b', {});
    expect(collectPresentEdgeKinds(g).size).toBe(0);
  });
});
