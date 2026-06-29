import { describe, expect, it } from 'vitest';
import {
  buildAdjacency,
  context,
  impact,
  neighbors,
} from '../traversal.js';
import {
  buildFixtureSnapshot,
  ENEMY_PREFAB,
  ENEMY_SCRIPT,
  ICON_ASSET,
  MAIN_SCENE,
  ORPHAN_ASSET,
  PLAYER_CLASS,
  PLAYER_PREFAB,
  PLAYER_SCRIPT,
  PLAYER_VARIANT,
  STATS_SO,
} from './traversal.fixtures.js';

const snapshot = buildFixtureSnapshot();
const adj = buildAdjacency(snapshot);

describe('neighbors', () => {
  it('1-hop out from prefab returns the scripts that use it', () => {
    const r = neighbors(adj, [PLAYER_PREFAB], {
      hops: 1,
      direction: 'in',
      maxNodes: 100,
    });
    const ids = new Set(r.nodes.map((n) => n.id));
    expect(ids.has(PLAYER_SCRIPT)).toBe(true);
    expect(ids.has(MAIN_SCENE)).toBe(true);
    expect(ids.has(PLAYER_VARIANT)).toBe(true);
    expect(r.truncated).toBe(false);
    expect(r.unresolvedIds).toEqual([]);
  });

  it('2-hop both expands script → prefab → scene', () => {
    const r = neighbors(adj, [PLAYER_SCRIPT], {
      hops: 2,
      direction: 'both',
      maxNodes: 100,
    });
    const ids = new Set(r.nodes.map((n) => n.id));
    expect(ids.has(PLAYER_PREFAB)).toBe(true);
    expect(ids.has(MAIN_SCENE)).toBe(true);
  });

  it('direction:in from a leaf script finds nothing (script has no inbound)', () => {
    const r = neighbors(adj, [PLAYER_SCRIPT], {
      hops: 4,
      direction: 'in',
      maxNodes: 100,
    });
    // only the seed itself
    expect(r.nodes.map((n) => n.id)).toEqual([PLAYER_SCRIPT]);
  });

  it('edgeKinds filter blocks traversal of excluded edges during BFS', () => {
    const r = neighbors(adj, [MAIN_SCENE], {
      hops: 2,
      direction: 'both',
      edgeKinds: new Set(['scene_contains_prefab']),
      maxNodes: 100,
    });
    const ids = new Set(r.nodes.map((n) => n.id));
    // reaches prefabs (scene_contains_prefab) but not their inbound scripts.
    expect(ids.has(PLAYER_PREFAB)).toBe(true);
    expect(ids.has(ENEMY_PREFAB)).toBe(true);
    expect(ids.has(ENEMY_SCRIPT)).toBe(false);
  });

  it('maxNodes truncation flags result + caps node count', () => {
    const r = neighbors(adj, [PLAYER_SCRIPT], {
      hops: 4,
      direction: 'both',
      maxNodes: 2,
    });
    expect(r.truncated).toBe(true);
    expect(r.nodes.length).toBeLessThanOrEqual(2);
  });

  it('unresolved seed mixed with resolved seed continues for the rest', () => {
    const r = neighbors(adj, ['unity://script/Bogus.cs', PLAYER_PREFAB], {
      hops: 1,
      direction: 'in',
      maxNodes: 100,
    });
    expect(r.unresolvedIds).toEqual(['unity://script/Bogus.cs']);
    expect(r.nodes.some((n) => n.id === PLAYER_PREFAB)).toBe(true);
  });

  it('orphan node returns only itself', () => {
    const r = neighbors(adj, [ORPHAN_ASSET], {
      hops: 2,
      direction: 'both',
      maxNodes: 100,
    });
    expect(r.nodes.map((n) => n.id)).toEqual([ORPHAN_ASSET]);
  });
});

describe('impact', () => {
  // Impact walks edges incoming to the seed (§3.3 "what breaks if I delete
  // this"). In this fixture, deleting PLAYER_PREFAB breaks the script(s)
  // that use it, the scene that contains it, and its variant. Seeding on
  // prefabs/assets/SOs gives non-empty impact; seeding on a script returns
  // empty because script→prefab edges are outgoing-from-script in our
  // schema (see docs/graph-schema.md §3.1).

  it('direct script_used_by_prefab classifies as direct', () => {
    const r = impact(adj, [PLAYER_PREFAB], { classify: true });
    const script = r.impacted.find((n) => n.id === PLAYER_SCRIPT);
    expect(script?.classification).toBe('direct');
    expect(script?.distance).toBe(1);
    expect(script?.reason).toContain('Player');
  });

  it('serialized_binding on path classifies as weak', () => {
    // Deleting ICON_ASSET — what depends on it?
    const r = impact(adj, [ICON_ASSET], { classify: true });
    const playerPrefab = r.impacted.find((n) => n.id === PLAYER_PREFAB);
    expect(playerPrefab?.classification).toBe('weak');
    // STATS_SO also reaches ICON via serialized_binding directly.
    const stats = r.impacted.find((n) => n.id === STATS_SO);
    expect(stats?.classification).toBe('weak');
  });

  it('2-hop non-serialized chain classifies as transitive', () => {
    // PLAYER_PREFAB ← (scene_contains_prefab) ← MAIN_SCENE ← (script_used_by_scene) ← ENEMY_SCRIPT
    const r = impact(adj, [PLAYER_PREFAB], { classify: true });
    const enemy = r.impacted.find((n) => n.id === ENEMY_SCRIPT);
    expect(enemy?.classification).toBe('transitive');
    expect(enemy?.distance).toBe(2);
  });

  it('respects max_depth', () => {
    const r = impact(adj, [PLAYER_PREFAB], { classify: true, maxDepth: 1 });
    expect(r.impacted.some((n) => n.id === ENEMY_SCRIPT)).toBe(false);
    expect(r.impacted.some((n) => n.id === MAIN_SCENE)).toBe(true);
  });

  it('impacted is sorted by (distance asc, id lex asc)', () => {
    const r = impact(adj, [PLAYER_PREFAB], { classify: true });
    for (let i = 1; i < r.impacted.length; i += 1) {
      const a = r.impacted[i - 1];
      const b = r.impacted[i];
      if (a.distance === b.distance) {
        expect(a.id <= b.id).toBe(true);
      } else {
        expect(a.distance).toBeLessThan(b.distance);
      }
    }
  });
});

describe('context', () => {
  it('returns node + inlined neighbors', () => {
    const r = context(adj, PLAYER_PREFAB, { maxNeighbors: 50 });
    expect(r).toBeDefined();
    expect(r!.node.id).toBe(PLAYER_PREFAB);
    // incoming: PLAYER_SCRIPT (script_used_by_prefab), MAIN_SCENE
    //   (scene_contains_prefab), PLAYER_VARIANT (prefab_variant_of)
    expect(r!.incoming.length).toBe(3);
    // outgoing: ICON_ASSET (serialized_binding)
    expect(r!.outgoing.length).toBe(1);
    expect(r!.truncated).toBe(false);
  });

  it('caps each direction independently and flags truncated', () => {
    const r = context(adj, PLAYER_PREFAB, { maxNeighbors: 2 });
    expect(r!.incoming.length).toBe(2);
    expect(r!.truncated).toBe(true);
  });

  it('returns undefined for unknown node', () => {
    const r = context(adj, 'unity://script/Missing.cs', { maxNeighbors: 50 });
    expect(r).toBeUndefined();
  });

  it('class hierarchy edges surface via context', () => {
    const r = context(adj, PLAYER_CLASS, { maxNeighbors: 50 });
    expect(r!.outgoing.some((e) => e.edge.kind === 'class_inherits_from')).toBe(true);
    expect(r!.outgoing.some((e) => e.edge.kind === 'class_implements_interface')).toBe(true);
  });
});
