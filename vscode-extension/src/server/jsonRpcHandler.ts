import {
  JsonRpcRequest,
  JsonRpcResponse,
  ToolCallResult,
  InitializeResult,
  jsonError,
  jsonResponse,
} from "../models/jsonRpc";
import {
  JSON_RPC_METHODS,
  JSON_RPC_ERROR_CODES,
  MCP_PROTOCOL_VERSION_STREAMABLE,
  SERVER_NAME,
  SERVER_VERSION,
  SERVER_DESCRIPTION,
  PARAM_NAMES,
  ERROR_MESSAGES,
} from "../constants";
import { ToolRegistry } from "../tools/toolRegistry";
import { resolveProject } from "./projectResolver";
import { ToolContext } from "../tools/abstractTool";

export class JsonRpcHandler {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly toolCtx: ToolContext,
  ) {}

  async handle(
    body: string,
    protocolVersion: string = MCP_PROTOCOL_VERSION_STREAMABLE,
    signal?: AbortSignal,
  ): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return jsonError(
        null,
        JSON_RPC_ERROR_CODES.PARSE_ERROR,
        ERROR_MESSAGES.PARSE_ERROR,
      );
    }

    if (Array.isArray(parsed)) {
      const responses: JsonRpcResponse[] = [];
      for (const item of parsed) {
        const r = await this.handleSingle(item as JsonRpcRequest, protocolVersion, signal);
        if (r) responses.push(r);
      }
      return responses.length > 0 ? responses : null;
    }

    return this.handleSingle(parsed as JsonRpcRequest, protocolVersion, signal);
  }

  private async handleSingle(
    request: JsonRpcRequest,
    protocolVersion: string,
    signal?: AbortSignal,
  ): Promise<JsonRpcResponse | null> {
    if (!request || request.jsonrpc !== "2.0") {
      return jsonError(
        request?.id ?? null,
        JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        `Invalid JSON-RPC version: ${request?.jsonrpc}. Expected "2.0".`,
      );
    }

    try {
      switch (request.method) {
        case JSON_RPC_METHODS.INITIALIZE:
          return this.initialize(request, protocolVersion);
        case JSON_RPC_METHODS.NOTIFICATIONS_INITIALIZED:
          return null;
        case JSON_RPC_METHODS.TOOLS_LIST:
          return this.toolsList(request);
        case JSON_RPC_METHODS.TOOLS_CALL:
          return await this.toolsCall(request, signal);
        case JSON_RPC_METHODS.PING:
          return jsonResponse(request.id, {});
        default:
          return jsonError(
            request.id,
            JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
            `Method not found: ${request.method}`,
          );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return jsonError(
        request.id,
        JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message || ERROR_MESSAGES.UNKNOWN_ERROR,
      );
    }
  }

  private initialize(
    request: JsonRpcRequest,
    protocolVersion: string,
  ): JsonRpcResponse {
    const result: InitializeResult = {
      protocolVersion,
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        description: SERVER_DESCRIPTION,
      },
      capabilities: {
        tools: { listChanged: false },
      },
    };
    return jsonResponse(request.id, result);
  }

  private toolsList(request: JsonRpcRequest): JsonRpcResponse {
    return jsonResponse(request.id, { tools: this.registry.getDefinitions() });
  }

  private async toolsCall(
    request: JsonRpcRequest,
    signal?: AbortSignal,
  ): Promise<JsonRpcResponse> {
    const params = request.params;
    if (!params) {
      return jsonError(
        request.id,
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        ERROR_MESSAGES.MISSING_PARAMS,
      );
    }
    const toolName = params[PARAM_NAMES.NAME];
    if (typeof toolName !== "string") {
      return jsonError(
        request.id,
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        ERROR_MESSAGES.MISSING_TOOL_NAME,
      );
    }

    const args = (params[PARAM_NAMES.ARGUMENTS] ?? {}) as Record<string, unknown>;

    const tool = this.registry.getTool(toolName);
    if (!tool) {
      return jsonError(
        request.id,
        JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
        `Tool not found: ${toolName}`,
      );
    }

    const projectPath = typeof args[PARAM_NAMES.PROJECT_PATH] === "string"
      ? (args[PARAM_NAMES.PROJECT_PATH] as string)
      : undefined;

    const resolved = resolveProject(projectPath);
    if (resolved.errorResult) {
      return jsonResponse(request.id, resolved.errorResult);
    }

    const ctx = signal ? { ...this.toolCtx, signal } : this.toolCtx;
    const result: ToolCallResult = await tool.execute(
      resolved.project!,
      args,
      ctx,
    );
    return jsonResponse(request.id, result);
  }
}
