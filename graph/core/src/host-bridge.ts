// Wire contract between the webview (graph/webview) and its host (VS Code
// extension or Rider plugin). The webview never imports a host SDK directly —
// it only sees this interface. Two implementations live in graph/webview/src/
// bridge/{vscode,rider}.ts, picked at boot by sniffing the window object.
//
// Envelope shape is deliberately small (request / response / event) and the
// transport is fire-and-forget; correlation is done via `id`. Higher-level
// RPC helpers (see `request` below) wrap that so callers can `await` a reply.
//
// Day 1 only uses `HelloGraphRequest` to prove the round-trip. Later days add
// snapshot / impact / context message types alongside it without changing the
// envelope shape.

export type RequestId = string;

export interface RequestEnvelope<T = unknown> {
  kind: 'request';
  id: RequestId;
  type: string;
  payload: T;
}

export interface ResponseEnvelope<T = unknown> {
  kind: 'response';
  id: RequestId;
  type: string;
  payload?: T;
  error?: { message: string };
}

export interface EventEnvelope<T = unknown> {
  kind: 'event';
  type: string;
  payload: T;
}

export type BridgeEnvelope =
  | RequestEnvelope
  | ResponseEnvelope
  | EventEnvelope;

export interface HostBridge {
  postToHost(envelope: BridgeEnvelope): void;
  onFromHost(handler: (envelope: BridgeEnvelope) => void): () => void;
}

// ---------------------------------------------------------------------------
// RPC helper: send a request, await a typed response.
// ---------------------------------------------------------------------------

let nextRequestId = 0;
const newRequestId = (): RequestId => {
  nextRequestId += 1;
  return `req-${Date.now().toString(36)}-${nextRequestId.toString(36)}`;
};

export interface RequestOptions {
  // Reject the returned promise if no response arrives within this many ms.
  // Defaults to 30s, long enough for cold-start MCP calls but short enough
  // that a wedged host doesn't hang the UI forever.
  timeoutMs?: number;
}

export function request<TReq, TRes>(
  bridge: HostBridge,
  type: string,
  payload: TReq,
  options: RequestOptions = {},
): Promise<TRes> {
  const id = newRequestId();
  const timeoutMs = options.timeoutMs ?? 30_000;

  return new Promise<TRes>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`bridge request '${type}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const unsubscribe = bridge.onFromHost((env) => {
      if (env.kind !== 'response' || env.id !== id) return;
      clearTimeout(timer);
      unsubscribe();
      if (env.error) {
        reject(new Error(env.error.message));
        return;
      }
      resolve(env.payload as TRes);
    });

    bridge.postToHost({ kind: 'request', id, type, payload });
  });
}
