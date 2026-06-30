// Day 8.6 — webview-side anchor resolution. `fetchCodeEdges` itself is a
// thin bridge call, not worth testing in isolation; the contract that
// matters is `anchorIdFor`, which translates a clicked node into the
// csharp ID the Day 8 tool expects. The eligibility predicate depends on
// this resolution, so a regression here silently disables the menu action
// for the wrong kinds.

import { describe, expect, it } from 'vitest';
import Graph from 'graphology';
import { anchorIdFor } from '../codeEdges';

function graphWith(
  nodes: Array<{ id: string; kind: string }>,
  edges: Array<{ source: string; target: string; kind: string }> = [],
): Graph {
  const g = new Graph({ type: 'directed', multi: true });
  for (const n of nodes) g.addNode(n.id, { kind: n.kind });
  for (const e of edges) {
    g.addEdgeWithKey(`${e.kind}:${e.source}:${e.target}`, e.source, e.target, {
      kind: e.kind,
    });
  }
  return g;
}

describe('anchorIdFor', () => {
  it('returns the node id when the node is a class anchor', () => {
    const id = 'unity://csharp/T:Foo.Bar';
    const g = graphWith([{ id, kind: 'class' }]);
    expect(anchorIdFor(g, id)).toBe(id);
  });

  it('handles interface / struct / enum kinds the same way', () => {
    for (const kind of ['interface', 'struct', 'enum'] as const) {
      const id = `unity://csharp/T:Foo.${kind}`;
      const g = graphWith([{ id, kind }]);
      expect(anchorIdFor(g, id), `kind=${kind}`).toBe(id);
    }
  });

  it('returns undefined when a class-kind id does not carry the csharp prefix', () => {
    // Sanity guard: a future kind that lands in the class bucket without
    // the csharp scheme (e.g. a hypothetical TypeScript-language class)
    // must not be treated as a Day 8 anchor.
    const g = graphWith([{ id: 'unity://other/T:Foo', kind: 'class' }]);
    expect(anchorIdFor(g, 'unity://other/T:Foo')).toBeUndefined();
  });

  it('walks script_declares_class on script nodes', () => {
    const scriptId = 'unity://script/Assets/Player.cs';
    const classId = 'unity://csharp/T:Foo.Player';
    const g = graphWith(
      [
        { id: scriptId, kind: 'script' },
        { id: classId, kind: 'class' },
      ],
      [{ source: scriptId, target: classId, kind: 'script_declares_class' }],
    );
    expect(anchorIdFor(g, scriptId)).toBe(classId);
  });

  it('ignores other outgoing edges from script nodes', () => {
    const scriptId = 'unity://script/Assets/Player.cs';
    const prefabId = 'unity://prefab/abc';
    const g = graphWith(
      [
        { id: scriptId, kind: 'script' },
        { id: prefabId, kind: 'prefab' },
      ],
      [{ source: scriptId, target: prefabId, kind: 'script_used_by_prefab' }],
    );
    expect(anchorIdFor(g, scriptId)).toBeUndefined();
  });

  it('returns undefined for asset-kind nodes', () => {
    const g = graphWith([{ id: 'unity://prefab/abc', kind: 'prefab' }]);
    expect(anchorIdFor(g, 'unity://prefab/abc')).toBeUndefined();
  });

  it('returns undefined for nodes not in the graph', () => {
    const g = graphWith([]);
    expect(anchorIdFor(g, 'unity://csharp/T:Missing')).toBeUndefined();
  });
});
