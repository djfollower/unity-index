// Day 5 pure helpers: compute the matched-node set for a given query, and
// validate a stored FilterState against the kinds actually present in the
// current snapshot. Kept dependency-free so Vitest can exercise them without
// loading Sigma or Svelte.

import type Graph from 'graphology';
import { fuzzyScore } from './fuzzy';

export interface MatchResult {
  matched: Set<string>;
  /** Node ids ordered by descending score — useful if the SearchBar wants to
   *  surface a "first match" jump-to affordance later. */
  ranked: string[];
}

export function computeMatches(graph: Graph, query: string): MatchResult {
  const q = query.trim();
  if (q.length === 0) return { matched: new Set(), ranked: [] };

  const scored: Array<{ id: string; score: number }> = [];
  graph.forEachNode((id, attrs) => {
    const label = typeof attrs.label === 'string' ? attrs.label : '';
    const path = typeof attrs.path === 'string' ? attrs.path : '';
    const labelScore = fuzzyScore(q, label);
    const pathScore = fuzzyScore(q, path) * 0.6; // path matches rank lower
    const best = Math.max(labelScore, pathScore);
    if (best > 0) scored.push({ id, score: best });
  });
  scored.sort((a, b) => b.score - a.score);

  return {
    matched: new Set(scored.map((s) => s.id)),
    ranked: scored.map((s) => s.id),
  };
}

/** Drop kinds from `stored` that no longer appear in the snapshot. Keeps the
 *  persisted state from accumulating stale entries across schema bumps. */
export function reconcileHiddenKinds(stored: string[], presentKinds: Set<string>): string[] {
  return stored.filter((k) => presentKinds.has(k));
}

export function collectPresentKinds(graph: Graph): Map<string, number> {
  const counts = new Map<string, number>();
  graph.forEachNode((_id, attrs) => {
    const kind = typeof attrs.kind === 'string' ? attrs.kind : 'unknown';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  });
  return counts;
}

/** Day 9.2 — set of edge kinds currently in the graph. Drives the Legend's
 *  "only show rows for what's actually there" behaviour so a pure-asset
 *  project doesn't carry a dead code-edge legend. Cheap: one pass over
 *  edges, no allocation per edge beyond the Set itself. */
export function collectPresentEdgeKinds(graph: Graph): Set<string> {
  const kinds = new Set<string>();
  graph.forEachEdge((_id, attrs) => {
    const kind = typeof attrs.kind === 'string' ? attrs.kind : undefined;
    if (kind) kinds.add(kind);
  });
  return kinds;
}
