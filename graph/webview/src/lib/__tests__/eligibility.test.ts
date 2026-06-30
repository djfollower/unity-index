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
  it('shows only focus_neighborhood for a node with no path/GUID/incoming-edges', () => {
    // focus_neighborhood is always available — Day 6 added it so users can
    // pivot on any node, including csharp dangling targets.
    expect(
      actionsForNode({ kind: 'script', hasPath: false, hasGuid: false }).map((a) => a.id),
    ).toEqual(['focus_neighborhood']);
  });

  it('shows open + reveal for assets that carry path but not GUID', () => {
    const ids = actionsForNode({
      kind: 'asset',
      hasPath: true,
      hasGuid: false,
    }).map((a) => a.id);
    expect(ids).toEqual(['focus_neighborhood', 'open_file', 'reveal_in_explorer']);
  });

  it('shows the full set for a script with path + GUID + incoming edges', () => {
    const ids = actionsForNode({
      kind: 'script',
      hasPath: true,
      hasGuid: true,
      hasIncomingEdges: true,
    }).map((a) => a.id);
    expect(ids).toEqual([
      'focus_neighborhood',
      'show_impact',
      'open_file',
      'find_usages',
      'reveal_in_explorer',
      'copy_guid',
    ]);
  });

  it('hides show_impact for orphan leaves (no incoming edges)', () => {
    // Day 6 Task 10 — impact on an orphan leaf would be a no-op, so the
    // menu hides the action.
    const ids = actionsForNode({
      kind: 'script',
      hasPath: true,
      hasGuid: true,
      hasIncomingEdges: false,
    }).map((a) => a.id);
    expect(ids).not.toContain('show_impact');
  });

  it('hides find_usages for non-code asset kinds even when path is set', () => {
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
      hasIncomingEdges: true,
      hasCodeAnchor: true,
    }).map((a) => a.id);
    expect(subset).toEqual(order); // matches the canonical sort
  });

  it('marks copy_guid plus the Day-6 focus actions as synchronous', () => {
    const sync = ALL_ACTIONS.filter((a) => a.isSync).map((a) => a.id);
    expect(sync).toEqual(['focus_neighborhood', 'show_impact', 'copy_guid']);
  });

  it('shows expand_code_edges only when an anchor exists and is not yet expanded', () => {
    const facts = {
      kind: 'script' as const,
      hasPath: true,
      hasGuid: true,
      hasIncomingEdges: true,
    };
    expect(
      actionsForNode({ ...facts }).map((a) => a.id),
    ).not.toContain('expand_code_edges');
    expect(
      actionsForNode({ ...facts, hasCodeAnchor: true }).map((a) => a.id),
    ).toContain('expand_code_edges');
    expect(
      actionsForNode({ ...facts, hasCodeAnchor: true, codeEdgesExpanded: true }).map(
        (a) => a.id,
      ),
    ).not.toContain('expand_code_edges');
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
          for (const hasIncomingEdges of [false, true]) {
            const facts = { kind, hasPath, hasGuid, hasIncomingEdges };
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
    }
  });
});
