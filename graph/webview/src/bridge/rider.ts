import type { BridgeEnvelope, HostBridge } from '@unity-index/graph-core';

// The Rider plugin injects window.unityIndex at JCEF browser init time:
//   - unityIndex.postToHost(json)  wraps a JBCefJSQuery (JS → Kotlin)
//   - we set unityIndex.fromHost = (json) => ...   so Kotlin can call us
// JSON-stringify the envelope so the Kotlin side can deserialize it with
// kotlinx.serialization without dealing with JCEF's loose JS↔JVM marshalling.
export function makeRiderBridge(): HostBridge {
  const u = window.unityIndex;
  if (!u) throw new Error('makeRiderBridge() called but window.unityIndex is missing');

  const listeners = new Set<(env: BridgeEnvelope) => void>();
  const dispatch = (envJson: string) => {
    let env: BridgeEnvelope;
    try {
      env = JSON.parse(envJson) as BridgeEnvelope;
    } catch (e) {
      console.warn('[unity-index-graph] rider bridge: bad JSON from host', e);
      return;
    }
    for (const l of listeners) l(env);
  };
  u.fromHost = dispatch;

  // Chunked reassembly buffer. The host emits one fragment per
  // executeJavaScript call to stay under CEF's source-size cliff; we
  // concatenate them in order and dispatch once the last arrives. Map keyed
  // by host-assigned messageId. Out-of-order chunks are stored sparsely and
  // only flushed when every slot is filled, so a dropped chunk leaves the
  // partial buffer in place rather than dispatching garbage.
  const pending = new Map<string, { total: number; chunks: (string | undefined)[]; filled: number }>();
  u.fromHostChunk = (messageId, index, total, chunk) => {
    if (total <= 1) {
      dispatch(chunk);
      return;
    }
    let entry = pending.get(messageId);
    if (!entry) {
      entry = { total, chunks: new Array(total), filled: 0 };
      pending.set(messageId, entry);
    }
    if (entry.chunks[index] !== undefined) return; // duplicate — ignore
    entry.chunks[index] = chunk;
    entry.filled++;
    if (entry.filled < entry.total) return;
    pending.delete(messageId);
    dispatch(entry.chunks.join(''));
  };

  return {
    postToHost: (env) => u.postToHost(JSON.stringify(env)),
    onFromHost: (h) => {
      listeners.add(h);
      return () => {
        listeners.delete(h);
      };
    },
  };
}
