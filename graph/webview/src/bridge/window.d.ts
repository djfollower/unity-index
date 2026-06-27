// Globals injected by each host. The webview must NOT assume any of these
// exist — `pickBridge` sniffs and falls back to a noop when running in a
// plain browser (vite dev).

export {};

declare global {
  interface VsCodeApi {
    postMessage(msg: unknown): void;
    setState?(state: unknown): void;
    getState?(): unknown;
  }

  interface UnityIndexHostBridge {
    // Kotlin → JS: the host calls this with a JSON-stringified BridgeEnvelope.
    fromHost?: (envJson: string) => void;
    // JS → Kotlin: injected at startup by the Rider plugin (wraps a
    // JBCefJSQuery). Takes a JSON-stringified BridgeEnvelope.
    postToHost(envJson: string): void;
  }

  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
    unityIndex?: UnityIndexHostBridge;
  }
}
