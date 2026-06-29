export const SERVER_NAME = "unity-index-mcp";
export const SERVER_VERSION = "0.3.2";
export const SERVER_DESCRIPTION =
  "Code intelligence server for Unity C# projects in VS Code (C# Dev Kit / Roslyn LSP). " +
  "Use this instead of grep/ripgrep for semantic code understanding. " +
  "Capabilities: find usages, go to definition, type/call hierarchies, find implementations, symbol search, diagnostics.";

export const MCP_PROTOCOL_VERSION_STREAMABLE = "2025-03-26";
export const MCP_PROTOCOL_VERSION_LEGACY = "2024-11-05";

export const MCP_ENDPOINT_PATH = "/unity-index-mcp";
export const SSE_ENDPOINT_PATH = `${MCP_ENDPOINT_PATH}/sse`;
export const STREAMABLE_HTTP_ENDPOINT_PATH = `${MCP_ENDPOINT_PATH}/streamable-http`;
export const SESSION_ID_PARAM = "sessionId";

export const JSON_RPC_VERSION = "2.0";

export const TOOL_NAMES = {
  // Navigation
  FIND_REFERENCES: "ide_find_references",
  FIND_DEFINITION: "ide_find_definition",
  FIND_IMPLEMENTATIONS: "ide_find_implementations",
  TYPE_HIERARCHY: "ide_type_hierarchy",
  CALL_HIERARCHY: "ide_call_hierarchy",
  FIND_SUPER_METHODS: "ide_find_super_methods",
  FIND_SYMBOL: "ide_find_symbol",
  FIND_CLASS: "ide_find_class",
  FIND_FILE: "ide_find_file",
  FILE_STRUCTURE: "ide_file_structure",
  SEARCH_TEXT: "ide_search_text",
  READ_FILE: "ide_read_file",
  GET_SYMBOL_BODY: "ide_get_symbol_body",

  // Intelligence
  DIAGNOSTICS: "ide_diagnostics",

  // Project
  INDEX_STATUS: "ide_index_status",
  SYNC_FILES: "ide_sync_files",
  BUILD_PROJECT: "ide_build_project",

  // Batch dispatcher
  BATCH: "ide_batch",

  // Unity
  GET_ASSEMBLY_MAP: "unity_get_assembly_map",
  GET_COMPONENT_USAGE: "unity_get_component_usage",
  GET_UNITY_EVENT_BINDINGS: "unity_get_unity_event_bindings",
  FIND_GETCOMPONENT_PATTERNS: "unity_find_getcomponent_patterns",
  GET_SERIALIZED_FIELD_VALUES: "unity_get_serialized_field_values",
  GET_PROJECT_CONTEXT: "unity_get_project_context",
  GET_API_USAGE: "unity_get_api_usage",
  FIND_ASSET_REFERENCES: "unity_find_asset_references",
  UNITY_GRAPH_SNAPSHOT: "unity_graph_snapshot",
  UNITY_GRAPH_NEIGHBORS: "unity_graph_neighbors",
  UNITY_GRAPH_IMPACT: "unity_graph_impact",
  UNITY_GRAPH_CONTEXT: "unity_graph_context",
} as const;

export const PARAM_NAMES = {
  PROJECT_PATH: "project_path",
  FILE: "file",
  LINE: "line",
  COLUMN: "column",
  NAME: "name",
  ARGUMENTS: "arguments",
  QUERY: "query",
  LIMIT: "limit",
  MAX_RESULTS: "maxResults",
  CASE_SENSITIVE: "caseSensitive",
  REGEX: "regex",
  FILE_PATTERN: "filePattern",
  FULL_ELEMENT_PREVIEW: "fullElementPreview",
  MAX_PREVIEW_LINES: "maxPreviewLines",
  INCLUDE_GENERATED: "includeGenerated",
  INCLUDE_OVERRIDES: "includeOverrides",
  INCLUDE_BUILD_ERRORS: "includeBuildErrors",
  SEVERITY: "severity",
  REBUILD: "rebuild",
  TIMEOUT_SECONDS: "timeoutSeconds",
  INCLUDE_RAW_OUTPUT: "includeRawOutput",
  CLASS_NAME: "className",
  PATH: "path",
  CONTEXT_LINES: "contextLines",
} as const;

export const JSON_RPC_METHODS = {
  INITIALIZE: "initialize",
  NOTIFICATIONS_INITIALIZED: "notifications/initialized",
  TOOLS_LIST: "tools/list",
  TOOLS_CALL: "tools/call",
  PING: "ping",
} as const;

export const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  INDEX_NOT_READY: -32001,
  FILE_NOT_FOUND: -32002,
  SYMBOL_NOT_FOUND: -32003,
} as const;

export const ERROR_KEYS = {
  NO_PROJECT_OPEN: "no_project_open",
  PROJECT_NOT_FOUND: "project_not_found",
  MULTIPLE_PROJECTS: "multiple_projects_open",
} as const;

export const ERROR_MESSAGES = {
  MISSING_TOOL_NAME: "Missing tool name",
  MISSING_PARAMS: "Missing params",
  PARSE_ERROR: "Failed to parse JSON-RPC request",
  UNKNOWN_ERROR: "Unknown error",
  NO_PROJECT_OPEN: "No workspace is currently open in VS Code.",
  MULTIPLE_PROJECTS:
    "Multiple workspace folders are open. Please specify 'project_path' parameter with one of the available project paths.",
  INDEX_NOT_READY:
    "C# Dev Kit / Roslyn LSP is still loading the solution. Call ide_index_status to check when it completes, then retry.",
};
