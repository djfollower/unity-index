// Day 10 — webview-side diagnostics overlay. Tests the pure helpers
// (`collectDiagnosticsTargets`, `heatmapColorFor`, `heatmapSizeBoostFor`,
// `isDiagnosticsRelevant`) without touching the Svelte store — the store
// is mostly setters and a fetch wrapper, both better covered by an
// integration smoke test once a real bridge is wired.

import { describe, expect, it } from 'vitest';
import Graph from 'graphology';
import type { NodeDiagnostics } from '@unity-index/graph-core';
import {
  collectDiagnosticsTargets,
  heatmapColorFor,
  heatmapSizeBoostFor,
  isDiagnosticsRelevant,
} from '../diagnostics';

function graphWith(nodes: Array<{ id: string; kind: string }>): Graph {
  const g = new Graph({ type: 'directed', multi: true });
  for (const n of nodes) g.addNode(n.id, { kind: n.kind });
  return g;
}

describe('isDiagnosticsRelevant', () => {
  it('accepts script and code-symbol kinds', () => {
    for (const k of ['script', 'class', 'interface', 'struct', 'enum', 'method']) {
      expect(isDiagnosticsRelevant(k)).toBe(true);
    }
  });

  it('rejects asset-only and sub-file kinds', () => {
    for (const k of [
      'prefab',
      'scene',
      'so',
      'asset',
      'addressable_group',
      'component_field',
      'field',
      'property',
      'namespace',
    ]) {
      expect(isDiagnosticsRelevant(k)).toBe(false);
    }
  });
});

describe('collectDiagnosticsTargets', () => {
  it('returns only diagnostics-relevant node ids', () => {
    const g = graphWith([
      { id: 'unity://script/A.cs', kind: 'script' },
      { id: 'unity://csharp/T:Foo', kind: 'class' },
      { id: 'unity://prefab/aaa', kind: 'prefab' },
      { id: 'unity://csharp/M:Foo.Bar', kind: 'method' },
      { id: 'unity://asset/bbb', kind: 'asset' },
    ]);
    const ids = collectDiagnosticsTargets(g).sort();
    expect(ids).toEqual([
      'unity://csharp/M:Foo.Bar',
      'unity://csharp/T:Foo',
      'unity://script/A.cs',
    ]);
  });

  it('returns [] on an empty graph', () => {
    expect(collectDiagnosticsTargets(new Graph())).toEqual([]);
  });
});

describe('heatmapColorFor', () => {
  const make = (max: NodeDiagnostics['max_severity']): NodeDiagnostics => ({
    node_id: 'x',
    errors: 0,
    warnings: 0,
    infos: 0,
    max_severity: max,
  });

  it('maps severities to the documented palette', () => {
    expect(heatmapColorFor(make('error'))).toBe('#ff5555');
    expect(heatmapColorFor(make('warning'))).toBe('#ffaa33');
    expect(heatmapColorFor(make('info'))).toBe('#5fb3ff');
  });

  it("returns undefined for 'none' so the reducer falls back to the kind palette", () => {
    expect(heatmapColorFor(make('none'))).toBeUndefined();
  });
});

describe('heatmapSizeBoostFor', () => {
  it('returns 0 for zero / negative reference counts', () => {
    expect(heatmapSizeBoostFor(0)).toBe(0);
    expect(heatmapSizeBoostFor(-5)).toBe(0);
  });

  it('scales monotonically with reference count', () => {
    const a = heatmapSizeBoostFor(1);
    const b = heatmapSizeBoostFor(10);
    const c = heatmapSizeBoostFor(100);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('caps the boost so hub nodes do not dwarf the canvas', () => {
    // 12 px ceiling per the helper contract; anything past ~1000 refs hits it.
    expect(heatmapSizeBoostFor(10_000)).toBeLessThanOrEqual(12);
    expect(heatmapSizeBoostFor(1_000_000)).toBeLessThanOrEqual(12);
  });
});
