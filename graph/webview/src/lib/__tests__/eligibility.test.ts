import { describe, expect, it } from 'vitest';
import type { NodeKind } from '@unity-index/graph-core';
import {
  ALL_ACTIONS,
  actionsForNode,
  isEligible,
} from '../eligibility';

// The eligibility matrix here is the contract between the snapshot's
// per-node metadata and the right-click menu's visible items. If a future
// schema change adds a new code-bearing kind, this test should fail loudly
// until the kind is added to CODE_BEARING_KINDS.

describe('eligibility.actionsForNode', () => {
  it('hides everything for a node with no path and no GUID', () => {
    expect(
      actionsForNode({ kind: 'script', hasPath: false, hasGuid: false }),
    ).toEqual([]);
  });

  it('shows open + reveal for assets that carry path but not GUID', () => {
    // Catch-all `asset` nodes are not code-bearing, so Find Usages stays
    // hidden; the GUID copy item is gated on the node actually having one.
    const ids = actionsForNode({
      kind: 'asset',
      hasPath: true,
      hasGuid: false,
    }).map((a) => a.id);
    expect(ids).toEqual(['open_file', 'reveal_in_explorer']);
  });

  it('shows all four actions for a script with path + GUID', () => {
    const ids = actionsForNode({
      kind: 'script',
      hasPath: true,
      hasGuid: true,
    }).map((a) => a.id);
    expect(ids).toEqual([
      'open_file',
      'find_usages',
      'reveal_in_explorer',
      'copy_guid',
    ]);
  });

  it('hides find_usages for non-code asset kinds even when path is set', () => {
    // Prefab / scene / SO are file-level assets that go through Reveal in
    // Explorer or Open File, but the IDE's references panel only operates on
    // code, so we don't show Find Usages for them.
    for (const kind of ['prefab', 'scene', 'so', 'asset'] as const) {
      const ids = actionsForNode({ kind, hasPath: true, hasGuid: true }).map(
        (a) => a.id,
      );
      expect(ids, `kind=${kind}`).not.toContain('find_usages');
    }
  });

  it('preserves ALL_ACTIONS order regardless of which subset is eligible', () => {
    const order = ALL_ACTIONS.map((a) => a.id);
    const subset = actionsForNode({
      kind: 'script',
      hasPath: true,
      hasGuid: true,
    }).map((a) => a.id);
    expect(subset).toEqual(order); // matches the canonical sort
  });

  it('marks copy_guid as the only synchronous action', () => {
    // The menu component uses isSync to decide whether to flash a toast or
    // wait for the bridge round-trip. Locking this here keeps the contract
    // explicit if new actions are added.
    const sync = ALL_ACTIONS.filter((a) => a.isSync).map((a) => a.id);
    expect(sync).toEqual(['copy_guid']);
  });

  it('isEligible matches actionsForNode for every kind+facts combo', () => {
    const kinds: NodeKind[] = [
      'script',
      'prefab',
      'scene',
      'so',
      'asset',
      'class',
      'method',
    ];
    for (const kind of kinds) {
      for (const hasPath of [false, true]) {
        for (const hasGuid of [false, true]) {
          const facts = { kind, hasPath, hasGuid };
          const filtered = new Set(actionsForNode(facts).map((a) => a.id));
          for (const action of ALL_ACTIONS) {
            expect(
              isEligible(action.id, facts),
              `${action.id} for ${JSON.stringify(facts)}`,
            ).toBe(filtered.has(action.id));
          }
        }
      }
    }
  });
});
