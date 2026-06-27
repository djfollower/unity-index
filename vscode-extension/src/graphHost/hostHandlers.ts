// Dispatch table for bridge requests coming from the webview. Each branch
// handles one `type` string and returns the response payload (or throws).
//
// Day 1 only implements the hello round-trip — proves the bridge end-to-end
// before any real data flows. Day 2+ add snapshot / impact / context, sourced
// from the same MCP tool registry that serves HTTP clients.
//
// The wire strings ('unity_graph_hello' etc.) MUST stay in sync with
// graph/core/src/messages.ts — drift will surface as a webview timeout.
// Types are imported (type-only) from graph-core; constants are inlined
// because graph-core ships ESM and this extension is CJS.

import type { HelloGraphRequest, HelloGraphResponse } from "@unity-index/graph-core";

const HELLO_GRAPH_TYPE = "unity_graph_hello"; // mirror of graph/core HELLO_GRAPH_TYPE

export async function dispatchRequest(
  type: string,
  payload: unknown,
): Promise<unknown> {
  switch (type) {
    case HELLO_GRAPH_TYPE: {
      const req = (payload ?? {}) as Partial<HelloGraphRequest>;
      const name = typeof req.name === "string" ? req.name : "webview";
      const res: HelloGraphResponse = {
        greeting: `hello, ${name}`,
        host: "vscode",
      };
      return res;
    }
    default:
      throw new Error(`unity_graph: unknown request type '${type}'`);
  }
}
