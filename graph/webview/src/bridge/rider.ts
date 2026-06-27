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
  u.fromHost = (envJson: string) => {
    let env: BridgeEnvelope;
    try {
      env = JSON.parse(envJson) as BridgeEnvelope;
    } catch (e) {
      console.warn('[unity-index-graph] rider bridge: bad JSON from host', e);
      return;
    }
    for (const l of listeners) l(env);
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
