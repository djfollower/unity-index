import type { GraphSnapshot, NodeKind } from './graph-types.js';

export interface BaseRequest {
  project_path: string;
  request_id?: string;
}

export interface Warning {
  code: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface BaseResponse {
  request_id?: string;
  generated_at: string;
  warnings?: Warning[];
}

export interface PageRequest {
  page_size?: number;
  cursor?: string;
}

export interface PageResponse {
  next_cursor?: string;
  total_estimated?: number;
}

export interface SnapshotRequest extends BaseRequest {
  include_kinds?: NodeKind[];
  exclude_kinds?: NodeKind[];
  path_globs?: string[];
  include_orphans?: boolean;
  pagination?: PageRequest;
  /** Day 8.4 — when true, materialize one `class` node per
   *  `script_declares_class` edge target so the UI has stable anchors to
   *  hang Day 8 `unity_graph_code_edges` results on. Default false. The
   *  anchor node carries `metadata.anchor = true` plus
   *  `metadata.declaring_script` (the script node id) and inherits the
   *  script's path so click-through keeps working. Setting this flag also
   *  suppresses the `dangling_csharp_targets` warning. Pagination,
   *  `include_kinds`, and `include_orphans` are applied AFTER anchors are
   *  materialized — set `include_kinds: ['script', 'class', ...]` if you
   *  want to keep them when filtering. */
  include_class_anchors?: boolean;
}

export interface SnapshotResponse extends BaseResponse {
  snapshot: GraphSnapshot;
  page?: PageResponse;
  /** Day 7 — revision number at which the host minted this snapshot.
   *  Clients pass this back as `since_revision` on a subsequent
   *  `unity_graph_snapshot_delta` call. Omitted by hosts that pre-date
   *  delta support; the client should treat its absence as "delta updates
   *  are unavailable, keep polling full snapshots." */
  revision?: number;
}

export type RpcErrorKind =
  | 'project_not_found'
  | 'project_not_ready'
  | 'invalid_id'
  | 'invalid_query'
  | 'budget_exceeded'
  | 'internal';

export interface RpcError {
  code: number;
  message: string;
  data?: {
    kind: RpcErrorKind;
    detail?: string;
    retryable?: boolean;
  };
}

export const SNAPSHOT_DEFAULT_PAGE_SIZE = 5000;
export const SNAPSHOT_MAX_PAGE_SIZE = 20000;

export const WARNING_SUBFILE_KIND_IGNORED = 'subfile_kind_ignored';
export const WARNING_DANGLING_CSHARP_TARGETS = 'dangling_csharp_targets';
export const WARNING_UNRESOLVED_TARGETS = 'unresolved_targets';
export const WARNING_ID_UNRESOLVED = 'id_unresolved';
export const WARNING_NEIGHBORS_TRUNCATED = 'neighbors_truncated';
/** Day 9.3 — emitted by `unity_graph_code_edges` when a `subtypes_of`
 *  preset walk hits the `CODE_EDGES_MAX_SUBTYPES` cap or the depth limit
 *  before exhausting the hierarchy. The response still contains everything
 *  that fit; the warning's `context` carries `{ root, visited, depth }`. */
export const WARNING_SUBTYPES_TRUNCATED = 'subtypes_truncated';
