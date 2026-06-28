export type NodeKind =
  | 'script'
  | 'prefab'
  | 'prefab_variant'
  | 'scene'
  | 'so'
  | 'asset'
  | 'addressable_group'
  | 'namespace'
  | 'class'
  | 'interface'
  | 'struct'
  | 'enum'
  | 'method'
  | 'property'
  | 'field'
  | 'component_instance'
  | 'component_field';

export type EdgeKind =
  | 'script_used_by_prefab'
  | 'script_used_by_scene'
  | 'scene_contains_prefab'
  | 'prefab_variant_of'
  | 'serialized_binding'
  | 'guid_resolves_to'
  | 'addressable_group_contains'
  | 'class_inherits_from'
  | 'class_implements_interface'
  | 'method_overrides_method'
  | 'method_calls_method'
  | 'class_references_class'
  | 'script_declares_class';

export interface GraphNodeLocation {
  line: number;
  column?: number;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  path?: string;
  guid?: string;
  location?: GraphNodeLocation;
  metadata: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  metadata: Record<string, unknown>;
}

export interface GraphStats {
  node_count: number;
  edge_count: number;
  skipped_component_instances: number;
  skipped_component_fields: number;
}

export type GraphSourcePhase = 'asset' | 'code' | 'combined';

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  generated_at: string;
  source_phase: GraphSourcePhase;
  stats: GraphStats;
}
