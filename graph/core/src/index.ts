export type {
  BridgeEnvelope,
  EventEnvelope,
  HostBridge,
  ProgressEnvelope,
  ProgressPayload,
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
  FilterDomain,
  FilterState,
  GetFilterStateRequest,
  GetFilterStateResponse,
  SetFilterStateRequest,
  SetFilterStateResponse,
  SavedViewsListRequest,
  SavedViewsListResponse,
  SavedViewsSaveRequest,
  SavedViewsSaveResponse,
  SavedViewsDeleteRequest,
  SavedViewsDeleteResponse,
  SaveFileKind,
  SaveFileRequest,
  SaveFileResponse,
  SnapshotLoadStaticEvent,
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
  CODE_EDGES_GRAPH_TYPE,
  DIAGNOSTICS_GRAPH_TYPE,
  SAVED_VIEWS_LIST_TYPE,
  SAVED_VIEWS_SAVE_TYPE,
  SAVED_VIEWS_DELETE_TYPE,
  SAVE_FILE_TYPE,
  SNAPSHOT_LOAD_STATIC_TYPE,
} from './messages.js';

export type {
  DiagnosticMessage,
  DiagnosticSeverity,
  DiagnosticsBatchRequest,
  DiagnosticsBatchResponse,
  MaxDiagnosticSeverity,
  NodeDiagnostics,
} from './diagnostics-wire.js';
export {
  DIAGNOSTICS_DEFAULT_MAX_MESSAGES,
  DIAGNOSTICS_MAX_MESSAGES_PER_NODE,
  DIAGNOSTICS_MAX_NODES,
} from './diagnostics-wire.js';

export type {
  CodeEdgeKind,
  CodeEdgesRequest,
  CodeEdgesResponse,
  MethodCallKind,
  MethodCallSite,
} from './code-edges-wire.js';
export {
  CODE_EDGES_DEFAULT_SUBTYPES_MAX_DEPTH,
  CODE_EDGES_MAX_SUBTYPES,
  CODE_EDGES_MAX_SYMBOLS,
} from './code-edges-wire.js';

export type {
  MaterializeOptions,
  MaterializeResult,
} from './class-anchors.js';
export { materializeClassAnchors } from './class-anchors.js';

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
  WARNING_SUBTYPES_TRUNCATED,
} from './snapshot-wire.js';

export type {
  EdgeKey,
  SnapshotDelta,
  SnapshotDeltaRequest,
  SnapshotDeltaResponse,
} from './snapshot-delta-wire.js';

export type { DiffSnapshotsOptions } from './snapshot-diff.js';
export { diffSnapshots, isEmptyDelta } from './snapshot-diff.js';

export type {
  ExportCodeEdges,
  ExportDocument,
  ExportMeta,
  ExportProducer,
  ExportValidationErrorKind,
  SavedView,
  SavedViewCamera,
  SavedViewFilter,
  SavedViewFocusFrame,
  SavedViewPositions,
} from './export-wire.js';
export {
  EXPORT_SCHEMA_MAJOR,
  EXPORT_SCHEMA_MINOR,
  EXPORT_SCHEMA_VERSION,
  ExportValidationError,
  assertCompatibleExport,
  createExportEnvelope,
  parseSchemaVersion,
} from './export-wire.js';
export {
  edgeKey,
  isApplicableDelta,
  EDGE_KEY_SEPARATOR,
  SNAPSHOT_DELTA_MAX_HISTORY,
  SNAPSHOT_DELTA_AFFECTED_PATHS_CAP,
  WARNING_DELTA_RESET,
  WARNING_DELTA_AFFECTED_PATHS_TRUNCATED,
} from './snapshot-delta-wire.js';
