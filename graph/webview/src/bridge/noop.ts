import type { HostBridge } from '@unity-index/graph-core';

// Used when the webview runs in a plain browser (vite dev) with no host.
// Lets the UI render so we can iterate on layout/styling outside the IDEs.
export function makeNoopBridge(): HostBridge {
  return {
    postToHost: (env) => {
      console.info('[unity-index-graph] noop bridge: would post', env);
    },
    onFromHost: () => () => {},
  };
}
