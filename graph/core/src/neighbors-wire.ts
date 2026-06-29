import type {
  EdgeKind,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
} from './graph-types.js';
import type { BaseRequest, BaseResponse } from './snapshot-wire.js';

// ---------------------------------------------------------------------------
// unity_graph_neighbors — see graph-mcp-tools.md §3.2.
// Subgraph centered on one or more node IDs, out to N hops.
// ---------------------------------------------------------------------------

export type TraversalDirection = 'in' | 'out' | 'both';

export interface NeighborsRequest extends BaseRequest {
  node_ids: string[]; // 1..100
  hops?: number; // default 1, max 4
  direction?: TraversalDirection; // default 'both'
  edge_kinds?: EdgeKind[]; // filter during traversal
  max_nodes?: number; // hard cap, default 2000
}

export interface NeighborsResponse extends BaseResponse {
  snapshot: GraphSnapshot;
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// unity_graph_impact — see graph-mcp-tools.md §3.3.
// "What breaks if I delete this." Reverse-reachable closure with classification.
// ---------------------------------------------------------------------------

export type ImpactClassification = 'direct' | 'transitive' | 'weak';

export interface ImpactRequest extends BaseRequest {
  node_ids: string[]; // 1..50
  max_depth?: number;
  classify?: boolean; // default true
}

export interface ImpactedNode {
  id: string;
  distance: number;
  classification?: ImpactClassification;
  reason: string;
}

export interface ImpactResponse extends BaseResponse {
  snapshot: GraphSnapshot;
  impact: ImpactedNode[];
}

// ---------------------------------------------------------------------------
// unity_graph_context — see graph-mcp-tools.md §3.4.
// Single node + 1-hop neighborhood, flattened for LLM prompts.
// ---------------------------------------------------------------------------

export interface ContextRequest extends BaseRequest {
  node_id: string;
  include_code_summary?: boolean; // default true
  include_diagnostics?: boolean; // default false
  max_neighbors?: number; // default 50
}

export interface EdgeWithEndpoint {
  edge: GraphEdge;
  other: GraphNode;
}

// TODO(day-10): replace with the real diagnostic shape from the Day 10
// ide_diagnostics rework. The placeholder lets context tools compile now.
export interface DiagnosticSummary {
  severity: 'error' | 'warning' | 'info';
  message: string;
  line?: number;
}

export interface ContextResponse extends BaseResponse {
  node: GraphNode;
  incoming: EdgeWithEndpoint[];
  outgoing: EdgeWithEndpoint[];
  code_summary?: string;
  diagnostics?: DiagnosticSummary[];
  truncated?: boolean;
}
