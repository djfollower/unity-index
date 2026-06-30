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
    // Kotlin → JS: chunked variant. CEF's executeJavaScript can't carry
    // multi-MB payloads in one shot (renderer crashes on big-project
    // snapshots), so the host splits the JSON into ordered fragments and
    // the webview reassembles them by messageId before invoking fromHost.
    fromHostChunk?: (messageId: string, index: number, total: number, chunk: string) => void;
    // JS → Kotlin: injected at startup by the Rider plugin (wraps a
    // JBCefJSQuery). Takes a JSON-stringified BridgeEnvelope.
    postToHost(envJson: string): void;
  }

  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
    unityIndex?: UnityIndexHostBridge;
  }
}
