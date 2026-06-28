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
}

export interface SnapshotResponse extends BaseResponse {
  snapshot: GraphSnapshot;
  page?: PageResponse;
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
