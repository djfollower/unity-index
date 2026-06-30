// Day 3 Task 7: per-kind palette for nodes and edges. Locked here so Days
// 4+ don't bikeshed colours; the `satisfies` clauses below make the build
// fail loudly if a new NodeKind / EdgeKind is added without a palette entry.
//
// Day 3 ships color + size only. Per-shape rendering (squares for scripts,
// circles for assets) needs a custom Sigma node program and is deferred to
// Day 14 polish. Icons sit in the same bucket.

import type { EdgeKind, NodeKind } from '@unity-index/graph-core';

export interface NodeStyle {
  color: string;
  size: number;
}

export interface EdgeStyle {
  color: string;
  type: 'arrow' | 'line';
  size: number;
}

export const NODE_STYLE = {
  // Asset domain — Day 2 emits these.
  script: { color: '#ffaa00', size: 8 },
  prefab: { color: '#4f7cff', size: 10 },
  prefab_variant: { color: '#7aa0ff', size: 10 },
  scene: { color: '#22cc88', size: 12 },
  so: { color: '#cc66ff', size: 8 },
  asset: { color: '#888888', size: 6 },
  addressable_group: { color: '#dd5577', size: 10 },

  // Code domain — Day 9 palette. Picked to read against the dark `#181818`
  // canvas and to keep the asset palette (warm orange scripts, blue prefabs,
  // green scenes, purple SOs) visually distinct from the code palette
  // (cool blues and accents).
  namespace: { color: '#999999', size: 5 },
  class: { color: '#88ccff', size: 8 },
  interface: { color: '#c4a3ff', size: 7 },
  struct: { color: '#66b8c2', size: 6 },
  enum: { color: '#ddaa55', size: 6 },
  method: { color: '#ffb86b', size: 4 },
  property: { color: '#a3d977', size: 4 },
  field: { color: '#7a8aa8', size: 3 },

  // Sub-file kinds — never rendered as top-level nodes (schema rule).
  // Mapping exists only so an accidental emit doesn't throw at lookup time.
  component_instance: { color: '#cccccc', size: 2 },
  component_field: { color: '#cccccc', size: 2 },
} as const satisfies Record<NodeKind, NodeStyle>;

export const EDGE_STYLE = {
  // Asset domain.
  script_used_by_prefab: { color: '#4f7cff', type: 'arrow', size: 1.5 },
  script_used_by_scene: { color: '#4f7cff', type: 'arrow', size: 1.5 },
  scene_contains_prefab: { color: '#22cc88', type: 'arrow', size: 1.5 },
  prefab_variant_of: { color: '#7aa0ff', type: 'arrow', size: 1.0 },
  serialized_binding: { color: '#888888', type: 'arrow', size: 1.0 },
  // Declaration, not a reference — softer line, no arrow.
  script_declares_class: { color: '#aaaaaa', type: 'line', size: 0.5 },

  // Code domain — Day 9 palette. Inheritance / implements / overrides share
  // a cool-blue family (they're all "is-a / replaces" relationships); calls
  // are warm amber (the noisiest edge kind, so kept thin and slightly
  // muted); generic references fall back to grey at the lowest weight so
  // they don't dominate the canvas.
  //
  // NOTE: Sigma's default edge program doesn't render dashed lines. The
  // plan called for dashed `class_implements_interface`; we use a lighter
  // blue tint instead and defer custom edge programs to Day 14 polish.
  class_inherits_from: { color: '#6aa3ff', type: 'arrow', size: 1.4 },
  class_implements_interface: { color: '#a3c4ff', type: 'arrow', size: 1.2 },
  method_overrides_method: { color: '#4fd1c5', type: 'arrow', size: 1.2 },
  method_calls_method: { color: '#ffb86b', type: 'arrow', size: 0.8 },
  class_references_class: { color: '#7a7a7a', type: 'arrow', size: 0.6 },

  // Mostly-internal edges (schema §3.1).
  guid_resolves_to: { color: '#666666', type: 'arrow', size: 0.8 },
  addressable_group_contains: { color: '#666666', type: 'arrow', size: 0.8 },
} as const satisfies Record<EdgeKind, EdgeStyle>;

const FALLBACK_NODE: NodeStyle = { color: '#cccccc', size: 4 };
const FALLBACK_EDGE: EdgeStyle = { color: '#555555', type: 'arrow', size: 0.8 };

// Lookup helpers that tolerate an unknown kind string (e.g. if the host emits
// a future kind the webview wasn't compiled against). Returning a fallback
// keeps the renderer alive; the kind is just drawn in the default grey.
export function nodeStyleFor(kind: string): NodeStyle {
  return (NODE_STYLE as Record<string, NodeStyle>)[kind] ?? FALLBACK_NODE;
}

export function edgeStyleFor(kind: string): EdgeStyle {
  return (EDGE_STYLE as Record<string, EdgeStyle>)[kind] ?? FALLBACK_EDGE;
}
