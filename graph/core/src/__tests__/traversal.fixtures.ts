// Shared fixture for Day 6 byte-equivalence (TS + Kotlin run the same
// queries against this snapshot and must produce identical results).
//
// Composition: 14 nodes / 18 edges covering every Day-6 edge kind and every
// asset-domain node kind plus a csharp class for hierarchy edges.
//
// Layout (asset side):
//   Player.cs        ←──script_used_by_prefab──   Player.prefab
//                                                 ↑ prefab_variant_of
//                                                 PlayerVariant.prefab
//   Enemy.cs         ←──script_used_by_prefab──   Enemy.prefab
//   Enemy.cs         ←──script_used_by_scene ──   Main.scene
//   Main.scene       ──scene_contains_prefab──→   Player.prefab
//   Main.scene       ──scene_contains_prefab──→   Enemy.prefab
//   Enemy.prefab     ──serialized_binding   ──→   Stats.asset (so)
//   Player.prefab    ──serialized_binding   ──→   Icon.png (asset)
//   Stats.asset      ──serialized_binding   ──→   Icon.png (chained weak)
//   Player.cs        ──script_declares_class──→   Player class
//   Player class     ──class_inherits_from  ──→   MonoBehaviour class
//   Player class     ──class_implements_interface──→ IDamageable interface

import type { GraphEdge, GraphNode, GraphSnapshot } from '../graph-types.js';

function node(
  id: string,
  kind: GraphNode['kind'],
  label: string,
  extras: Partial<GraphNode> = {},
): GraphNode {
  return {
    id,
    kind,
    label,
    metadata: {},
    ...extras,
  };
}

function edge(
  source: string,
  target: string,
  kind: GraphEdge['kind'],
): GraphEdge {
  return { source, target, kind, metadata: {} };
}

export const PLAYER_SCRIPT = 'unity://script/Assets/Scripts/Player.cs';
export const ENEMY_SCRIPT = 'unity://script/Assets/Scripts/Enemy.cs';
export const PLAYER_PREFAB = 'unity://prefab/0000000000000000000000000000aaaa';
export const PLAYER_VARIANT = 'unity://prefab/0000000000000000000000000000aabb';
export const ENEMY_PREFAB = 'unity://prefab/0000000000000000000000000000bbbb';
export const MAIN_SCENE = 'unity://scene/0000000000000000000000000000cccc';
export const STATS_SO = 'unity://so/0000000000000000000000000000dddd';
export const ICON_ASSET = 'unity://asset/0000000000000000000000000000eeee';
export const PLAYER_CLASS = 'unity://csharp/T:Player';
export const ENEMY_CLASS = 'unity://csharp/T:Enemy';
export const MONO_CLASS = 'unity://csharp/T:MonoBehaviour';
export const IDAMAGEABLE = 'unity://csharp/T:IDamageable';
export const ORPHAN_ASSET = 'unity://asset/0000000000000000000000000000ffff';

export function buildFixtureSnapshot(): GraphSnapshot {
  const nodes: GraphNode[] = [
    node(PLAYER_SCRIPT, 'script', 'Player.cs', { path: 'Assets/Scripts/Player.cs' }),
    node(ENEMY_SCRIPT, 'script', 'Enemy.cs', { path: 'Assets/Scripts/Enemy.cs' }),
    node(PLAYER_PREFAB, 'prefab', 'Player', { path: 'Assets/Prefabs/Player.prefab' }),
    node(PLAYER_VARIANT, 'prefab_variant', 'PlayerVariant', {
      path: 'Assets/Prefabs/PlayerVariant.prefab',
    }),
    node(ENEMY_PREFAB, 'prefab', 'Enemy', { path: 'Assets/Prefabs/Enemy.prefab' }),
    node(MAIN_SCENE, 'scene', 'Main', { path: 'Assets/Scenes/Main.unity' }),
    node(STATS_SO, 'so', 'Stats', { path: 'Assets/Data/Stats.asset' }),
    node(ICON_ASSET, 'asset', 'Icon', { path: 'Assets/Art/Icon.png' }),
    node(PLAYER_CLASS, 'class', 'Player'),
    node(ENEMY_CLASS, 'class', 'Enemy'),
    node(MONO_CLASS, 'class', 'MonoBehaviour'),
    node(IDAMAGEABLE, 'interface', 'IDamageable'),
    node(ORPHAN_ASSET, 'asset', 'Orphan', { path: 'Assets/Art/Orphan.png' }),
  ];
  const edges: GraphEdge[] = [
    edge(PLAYER_SCRIPT, PLAYER_PREFAB, 'script_used_by_prefab'),
    edge(ENEMY_SCRIPT, ENEMY_PREFAB, 'script_used_by_prefab'),
    edge(ENEMY_SCRIPT, MAIN_SCENE, 'script_used_by_scene'),
    edge(MAIN_SCENE, PLAYER_PREFAB, 'scene_contains_prefab'),
    edge(MAIN_SCENE, ENEMY_PREFAB, 'scene_contains_prefab'),
    edge(PLAYER_VARIANT, PLAYER_PREFAB, 'prefab_variant_of'),
    edge(ENEMY_PREFAB, STATS_SO, 'serialized_binding'),
    edge(PLAYER_PREFAB, ICON_ASSET, 'serialized_binding'),
    edge(STATS_SO, ICON_ASSET, 'serialized_binding'),
    edge(PLAYER_SCRIPT, PLAYER_CLASS, 'script_declares_class'),
    edge(ENEMY_SCRIPT, ENEMY_CLASS, 'script_declares_class'),
    edge(PLAYER_CLASS, MONO_CLASS, 'class_inherits_from'),
    edge(ENEMY_CLASS, MONO_CLASS, 'class_inherits_from'),
    edge(PLAYER_CLASS, IDAMAGEABLE, 'class_implements_interface'),
  ];
  return {
    nodes,
    edges,
    generated_at: '2026-06-29T00:00:00.000Z',
    source_phase: 'combined',
    stats: {
      node_count: nodes.length,
      edge_count: edges.length,
      skipped_component_instances: 0,
      skipped_component_fields: 0,
    },
  };
}
