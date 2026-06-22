export interface JsonRpcRequest {
  jsonrpc: string;
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface ContentBlockText {
  type: "text";
  text: string;
}

export type ContentBlock = ContentBlockText;

export interface ToolCallResult {
  content: ContentBlock[];
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ServerInfo {
  name: string;
  version: string;
  description?: string;
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: { listChanged: boolean };
  };
  serverInfo: ServerInfo;
}

export function jsonResponse(
  id: number | string | null | undefined,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function jsonError(
  id: number | string | null | undefined,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}
