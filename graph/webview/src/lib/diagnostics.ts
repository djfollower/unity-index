// Day 10 — pure helpers for the diagnostics overlay. Split from the
// reactive store (`diagnostics.svelte.ts`) so Vitest can import these
// without dragging in Svelte's `$state` runtime — same pattern as
// `filter.ts` vs `filterStore.svelte.ts`.

import type Graph from 'graphology';
import type { NodeDiagnostics } from '@unity-index/graph-core';

/** Kinds we bother asking diagnostics for. Everything else (component
 *  instances, sub-file fields, addressable groups, raw assets) doesn't
 *  resolve to a code file and would just inflate `unresolved_ids`. */
const DIAGNOSTICS_RELEVANT_KINDS = new Set<string>([
  'script',
  'class',
  'interface',
  'struct',
  'enum',
  'method',
]);

export function isDiagnosticsRelevant(kind: string): boolean {
  return DIAGNOSTICS_RELEVANT_KINDS.has(kind);
}

/** Pick all node ids worth asking diagnostics for. Sub-file kinds and
 *  asset-only kinds are skipped — see `DIAGNOSTICS_RELEVANT_KINDS`. */
export function collectDiagnosticsTargets(graph: Graph): string[] {
  const out: string[] = [];
  graph.forEachNode((id, attrs) => {
    const kind = typeof attrs.kind === 'string' ? attrs.kind : '';
    if (isDiagnosticsRelevant(kind)) out.push(id);
  });
  return out;
}

/** Heatmap palette: severity → color. `'none'` resolves to undefined so
 *  the caller falls back to the kind palette — the heatmap should
 *  brighten dirty nodes, not flatten clean ones into a single colour. */
export function heatmapColorFor(d: NodeDiagnostics): string | undefined {
  switch (d.max_severity) {
    case 'error':
      return '#ff5555';
    case 'warning':
      return '#ffaa33';
    case 'info':
      return '#5fb3ff';
    case 'none':
      return undefined;
  }
}

/** Heatmap size scale: extra pixels added on top of the kind's default
 *  size. Capped at +12 px so hub nodes don't dwarf everything else.
 *
 *  We use log2 because reference distributions in Unity codebases are
 *  long-tailed (one MonoBehaviour gets used in 50 prefabs, the rest in
 *  one each) and a linear scale would make the tail invisible. */
export function heatmapSizeBoostFor(referenceCount: number): number {
  if (referenceCount <= 0) return 0;
  const raw = Math.log2(referenceCount + 1) * 2;
  return Math.min(12, raw);
}
