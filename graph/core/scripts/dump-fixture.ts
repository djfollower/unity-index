// One-time dumper for Day 6 Task 11's byte-equivalence fixture. Re-run when
// `graph/core/src/__tests__/traversal.fixtures.ts` changes, and commit the
// resulting JSON in the same commit so the Kotlin side stays in sync.
//
// Usage:
//   npx tsx graph/core/scripts/dump-fixture.ts > src/test/resources/graph/traversal-fixture.json
//
// (Or pass `--write` to write the file directly.)

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  buildAdjacency,
  context,
  impact,
  neighbors,
} from '../src/traversal.js';
import {
  buildFixtureSnapshot,
  ENEMY_PREFAB,
  ENEMY_SCRIPT,
  ICON_ASSET,
  MAIN_SCENE,
  PLAYER_CLASS,
  PLAYER_PREFAB,
  PLAYER_SCRIPT,
  PLAYER_VARIANT,
  STATS_SO,
} from '../src/__tests__/traversal.fixtures.js';

const snapshot = buildFixtureSnapshot();
const adj = buildAdjacency(snapshot);

interface NeighborCase {
  name: string;
  seeds: string[];
  hops: number;
  direction: 'in' | 'out' | 'both';
  maxNodes: number;
}

const neighborCases: NeighborCase[] = [
  { name: 'in_1hop_player_prefab', seeds: [PLAYER_PREFAB], hops: 1, direction: 'in', maxNodes: 100 },
  { name: 'both_2hop_player_script', seeds: [PLAYER_SCRIPT], hops: 2, direction: 'both', maxNodes: 100 },
  { name: 'both_1hop_main_scene', seeds: [MAIN_SCENE], hops: 1, direction: 'both', maxNodes: 100 },
];

const impactCases = [
  { name: 'player_prefab', seeds: [PLAYER_PREFAB] },
  { name: 'icon_asset', seeds: [ICON_ASSET] },
  { name: 'stats_so', seeds: [STATS_SO] },
];

const contextCases = [
  { name: 'player_prefab', nodeId: PLAYER_PREFAB, maxNeighbors: 50 },
  { name: 'player_class', nodeId: PLAYER_CLASS, maxNeighbors: 50 },
];

function dump() {
  const neighborOut = neighborCases.map((c) => ({
    name: c.name,
    request: { seeds: c.seeds, hops: c.hops, direction: c.direction, maxNodes: c.maxNodes },
    result: (() => {
      const r = neighbors(adj, c.seeds, {
        hops: c.hops,
        direction: c.direction,
        maxNodes: c.maxNodes,
      });
      return {
        nodeIds: r.nodes.map((n) => n.id).sort(),
        edges: r.edges
          .map((e) => ({ source: e.source, target: e.target, kind: e.kind }))
          .sort((a, b) =>
            a.source + a.target + a.kind < b.source + b.target + b.kind ? -1 : 1,
          ),
        truncated: r.truncated,
        unresolvedIds: r.unresolvedIds.sort(),
      };
    })(),
  }));

  const impactOut = impactCases.map((c) => ({
    name: c.name,
    request: { seeds: c.seeds },
    result: (() => {
      const r = impact(adj, c.seeds, { classify: true });
      return {
        nodeIds: r.nodes.map((n) => n.id).sort(),
        impacted: r.impacted, // already sorted by (distance asc, id asc)
      };
    })(),
  }));

  const contextOut = contextCases.map((c) => ({
    name: c.name,
    request: { nodeId: c.nodeId, maxNeighbors: c.maxNeighbors },
    result: (() => {
      const r = context(adj, c.nodeId, { maxNeighbors: c.maxNeighbors });
      if (!r) return null;
      return {
        nodeId: r.node.id,
        incoming: r.incoming
          .map((e) => ({
            edge: { source: e.edge.source, target: e.edge.target, kind: e.edge.kind },
            otherId: e.other.id,
          }))
          .sort((a, b) => (a.otherId < b.otherId ? -1 : 1)),
        outgoing: r.outgoing
          .map((e) => ({
            edge: { source: e.edge.source, target: e.edge.target, kind: e.edge.kind },
            otherId: e.other.id,
          }))
          .sort((a, b) => (a.otherId < b.otherId ? -1 : 1)),
        truncated: r.truncated,
      };
    })(),
  }));

  return {
    schema_version: 1,
    snapshot,
    queries: {
      neighbors: neighborOut,
      impact: impactOut,
      context: contextOut,
    },
  };
}

const out = JSON.stringify(dump(), null, 2);
const writeFlag = process.argv.includes('--write');
if (writeFlag) {
  const target = resolve(
    new URL(import.meta.url).pathname,
    '../../../../src/test/resources/graph/traversal-fixture.json',
  );
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, out + '\n', 'utf-8');
  // eslint-disable-next-line no-console
  console.error(`wrote ${target}`);
} else {
  process.stdout.write(out + '\n');
}
