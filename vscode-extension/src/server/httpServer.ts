import * as http from "http";
import * as net from "net";
import {
  MCP_ENDPOINT_PATH,
  STREAMABLE_HTTP_ENDPOINT_PATH,
  SSE_ENDPOINT_PATH,
  MCP_PROTOCOL_VERSION_STREAMABLE,
  MCP_PROTOCOL_VERSION_LEGACY,
  SESSION_ID_PARAM,
} from "../constants";
import { JsonRpcHandler } from "./jsonRpcHandler";
import { JsonRpcResponse } from "../models/jsonRpc";

interface SseSession {
  id: string;
  res: http.ServerResponse;
  protocolVersion: string;
}

export class HttpServer {
  private server?: http.Server;
  private socketServer?: net.Server;
  private sseSessions = new Map<string, SseSession>();

  constructor(
    private readonly handler: JsonRpcHandler,
    private readonly log: (msg: string) => void,
  ) {}

  async start(host: string, port: number): Promise<void> {
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    this.log(`MCP HTTP server listening on http://${host}:${port}${MCP_ENDPOINT_PATH}`);
  }

  async startUnixSocket(socketPath: string): Promise<void> {
    this.socketServer = net.createServer();
    // Reuse the same HTTP request handling pipeline by attaching to an http.Server
    // bound to the unix socket.
    const httpOnSocket = http.createServer((req, res) =>
      this.handleHttp(req, res),
    );
    await new Promise<void>((resolve, reject) => {
      httpOnSocket.once("error", reject);
      httpOnSocket.listen(socketPath, () => {
        httpOnSocket.off("error", reject);
        resolve();
      });
    });
    this.socketServer = httpOnSocket as unknown as net.Server;
    this.log(`MCP server also listening on socket ${socketPath}`);
  }

  async stop(): Promise<void> {
    for (const session of this.sseSessions.values()) {
      try {
        session.res.end();
      } catch {
        /* ignore */
      }
    }
    this.sseSessions.clear();

    await closeServer(this.server);
    this.server = undefined;
    await closeServer(this.socketServer as unknown as http.Server | undefined);
    this.socketServer = undefined;
  }

  private originAllowed(origin: string | undefined): boolean {
    if (!origin) return true;
    try {
      const url = new URL(origin);
      return url.hostname === "127.0.0.1" || url.hostname === "localhost";
    } catch {
      return false;
    }
  }

  private writeCors(res: http.ServerResponse, origin?: string): void {
    res.setHeader(
      "Access-Control-Allow-Origin",
      origin && this.originAllowed(origin) ? origin : "*",
    );
    res.setHeader(
      "Access-Control-Allow-Methods",
      "POST, GET, OPTIONS, DELETE",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, mcp-protocol-version, MCP-Protocol-Version",
    );
  }

  private async handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const origin = req.headers.origin;
    if (!this.originAllowed(origin)) {
      res.writeHead(403).end("Origin not allowed");
      return;
    }
    this.writeCors(res, origin);

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    try {
      if (req.method === "POST" && pathname === STREAMABLE_HTTP_ENDPOINT_PATH) {
        return await this.handleStreamablePost(req, res);
      }
      if (req.method === "POST" && pathname === MCP_ENDPOINT_PATH) {
        const sessionId = url.searchParams.get(SESSION_ID_PARAM);
        if (sessionId) {
          return await this.handleSsePost(req, res, sessionId);
        }
        return await this.handleStatelessPost(req, res);
      }
      if (req.method === "GET" && pathname === SSE_ENDPOINT_PATH) {
        return this.handleSseOpen(req, res);
      }
      if (req.method === "GET" && pathname === MCP_ENDPOINT_PATH) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", server: "unity-index-mcp" }));
        return;
      }
      res.writeHead(404).end("Not found");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`HTTP handler error: ${message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end(`Internal error: ${message}`);
    }
  }

  private async readBody(req: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) {
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  private async handleStreamablePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await this.readBody(req);
    const result = await this.handler.handle(body, MCP_PROTOCOL_VERSION_STREAMABLE);
    if (result === null) {
      // Notification — empty response.
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  }

  private async handleStatelessPost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await this.readBody(req);
    const result = await this.handler.handle(body, MCP_PROTOCOL_VERSION_LEGACY);
    if (result === null) {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  }

  private handleSseOpen(_req: http.IncomingMessage, res: http.ServerResponse): void {
    const sessionId = randomId();
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(
      `event: endpoint\ndata: ${MCP_ENDPOINT_PATH}?${SESSION_ID_PARAM}=${sessionId}\n\n`,
    );
    const session: SseSession = {
      id: sessionId,
      res,
      protocolVersion: MCP_PROTOCOL_VERSION_LEGACY,
    };
    this.sseSessions.set(sessionId, session);
    res.on("close", () => this.sseSessions.delete(sessionId));
  }

  private async handleSsePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    sessionId: string,
  ): Promise<void> {
    const session = this.sseSessions.get(sessionId);
    if (!session) {
      res.writeHead(404).end("Unknown session");
      return;
    }
    const body = await this.readBody(req);
    const result = await this.handler.handle(body, session.protocolVersion);
    // Acknowledge the POST quickly; SSE stream carries the response.
    res.writeHead(202).end();
    if (result === null) return;
    const payload = Array.isArray(result) ? result : [result];
    for (const r of payload as JsonRpcResponse[]) {
      session.res.write(`event: message\ndata: ${JSON.stringify(r)}\n\n`);
    }
  }
}

function closeServer(server?: http.Server): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    // Force-close keep-alive connections.
    (server as unknown as { closeAllConnections?: () => void })
      .closeAllConnections?.();
  });
}

function randomId(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  );
}
