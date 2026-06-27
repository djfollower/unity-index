import type { BridgeEnvelope, HostBridge } from '@unity-index/graph-core';

// `acquireVsCodeApi()` may only be called ONCE per webview lifecycle — VS Code
// throws on the second call. Cache it.
let cachedApi: VsCodeApi | null = null;
function api(): VsCodeApi {
  if (!cachedApi) {
    if (typeof window.acquireVsCodeApi !== 'function') {
      throw new Error('makeVsCodeBridge() called outside a VS Code webview');
    }
    cachedApi = window.acquireVsCodeApi();
  }
  return cachedApi;
}

export function makeVsCodeBridge(): HostBridge {
  const listeners = new Set<(env: BridgeEnvelope) => void>();
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as BridgeEnvelope | undefined;
    if (!data || typeof (data as { kind?: unknown }).kind !== 'string') return;
    for (const l of listeners) l(data);
  });
  return {
    postToHost: (env) => api().postMessage(env),
    onFromHost: (h) => {
      listeners.add(h);
      return () => {
        listeners.delete(h);
      };
    },
  };
}
