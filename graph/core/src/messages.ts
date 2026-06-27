// Typed message payloads carried over the host-bridge envelope. Keep one
// `<NAME>_TYPE` string constant per message so both sides reference the same
// literal — drift is caught at compile time on the TS side and at runtime in
// the host's dispatch table (Kotlin / TS host).
//
// Day 1 only defines the hello round-trip. Day 2+ add snapshot / impact /
// context / open-file / etc.

// ---------------------------------------------------------------------------
// hello — Day 1 round-trip probe. Webview sends a name, host echoes a
// greeting. Used to prove the bridge end-to-end before any real data flows.
// ---------------------------------------------------------------------------

export const HELLO_GRAPH_TYPE = 'unity_graph_hello' as const;

export interface HelloGraphRequest {
  name: string;
}

export interface HelloGraphResponse {
  greeting: string;
  host: 'vscode' | 'rider';
}
