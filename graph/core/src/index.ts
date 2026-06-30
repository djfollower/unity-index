export type {
  BridgeEnvelope,
  EventEnvelope,
  HostBridge,
  RequestEnvelope,
  RequestId,
  RequestOptions,
  ResponseEnvelope,
} from './host-bridge.js';
export { request } from './host-bridge.js';

export type {
  HelloGraphRequest,
  HelloGraphResponse,
  OpenFileRequest,
  OpenFileResponse,
  FindUsagesRequest,
  FindUsagesResponse,
  RevealInExplorerRequest,
  RevealInExplorerResponse,
  FilterState,
  GetFilterStateRequest,
  GetFilterStateResponse,
  SetFilterStateRequest,
  SetFilterStateResponse,
} from './messages.js';
export {
  HELLO_GRAPH_TYPE,
  SNAPSHOT_GRAPH_TYPE,
  SNAPSHOT_DELTA_GRAPH_TYPE,
  OPEN_FILE_TYPE,
  FIND_USAGES_TYPE,
  REVEAL_IN_EXPLORER_TYPE,
  GET_FILTER_STATE_TYPE,
  SET_FILTER_STATE_TYPE,
  NEIGHBORS_GRAPH_TYPE,
  IMPACT_GRAPH_TYPE,
  CONTEXT_GRAPH_TYPE,
} from './messages.js';

export type {
  AdjacencyIndex,
  NeighborsOptions,
  NeighborsResult,
  ImpactOptions,
  ImpactResult,
  ContextOptions,
  ContextResult,
} from './traversal.js';
export {
  buildAdjacency,
  neighbors,
  impact,
  context,
} from './traversal.js';

export type {
  TraversalDirection,
  NeighborsRequest,
  NeighborsResponse,
  ImpactRequest,
  ImpactResponse,
  ImpactedNode,
  ImpactClassification,
  ContextRequest,
  ContextResponse,
  EdgeWithEndpoint,
  DiagnosticSummary,
} from './neighbors-wire.js';

export type {
  EdgeKind,
  GraphEdge,
  GraphNode,
  GraphNodeLocation,
  GraphSnapshot,
  GraphSourcePhase,
  GraphStats,
  NodeKind,
} from './graph-types.js';

export type {
  BaseRequest,
  BaseResponse,
  PageRequest,
  PageResponse,
  RpcError,
  RpcErrorKind,
  SnapshotRequest,
  SnapshotResponse,
  Warning,
} from './snapshot-wire.js';
export {
  SNAPSHOT_DEFAULT_PAGE_SIZE,
  SNAPSHOT_MAX_PAGE_SIZE,
  WARNING_DANGLING_CSHARP_TARGETS,
  WARNING_SUBFILE_KIND_IGNORED,
  WARNING_UNRESOLVED_TARGETS,
  WARNING_ID_UNRESOLVED,
  WARNING_NEIGHBORS_TRUNCATED,
} from './snapshot-wire.js';

export type {
  EdgeKey,
  SnapshotDelta,
  SnapshotDeltaRequest,
  SnapshotDeltaResponse,
} from './snapshot-delta-wire.js';

export type { DiffSnapshotsOptions } from './snapshot-diff.js';
export { diffSnapshots, isEmptyDelta } from './snapshot-diff.js';
export {
  edgeKey,
  isApplicableDelta,
  EDGE_KEY_SEPARATOR,
  SNAPSHOT_DELTA_MAX_HISTORY,
  SNAPSHOT_DELTA_AFFECTED_PATHS_CAP,
  WARNING_DELTA_RESET,
  WARNING_DELTA_AFFECTED_PATHS_TRUNCATED,
} from './snapshot-delta-wire.js';
