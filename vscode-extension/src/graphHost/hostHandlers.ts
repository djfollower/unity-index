// Dispatch table for bridge requests coming from the webview. Each branch
// handles one `type` string and returns the response payload (or throws).
//
// Day 1 only implements the hello round-trip — proves the bridge end-to-end
// before any real data flows. Day 3 adds `unity_graph_snapshot`, calling the
// same in-process builder the MCP tool path uses (no HTTP hop).
//
// The wire strings ('unity_graph_hello' etc.) MUST stay in sync with
// graph/core/src/messages.ts — drift will surface as a webview timeout.
// Types are imported (type-only) from graph-core; constants are inlined
// because graph-core ships ESM and this extension is CJS.

import type {
  HelloGraphRequest,
  HelloGraphResponse,
  SnapshotRequest,
  SnapshotResponse,
} from "@unity-index/graph-core";
import { resolveProject } from "../server/projectResolver";
import { UnityAssetIndexManager } from "../utils/unityAssetIndexManager";
import { buildAssetGraph } from "../utils/unityAssetGraphBuilder";

const HELLO_GRAPH_TYPE = "unity_graph_hello"; // mirror of graph/core HELLO_GRAPH_TYPE
const SNAPSHOT_GRAPH_TYPE = "unity_graph_snapshot"; // mirror of graph/core SNAPSHOT_GRAPH_TYPE

export interface HostHandlerContext {
  /**
   * Returns the live UnityAssetIndexManager owned by the MCP server, or
   * `undefined` if the server isn't running. Lazy so the panel can outlive
   * a stop/start cycle.
   */
  getAssetIndex: () => UnityAssetIndexManager | undefined;
}

export async function dispatchRequest(
  type: string,
  payload: unknown,
  ctx: HostHandlerContext,
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
    case SNAPSHOT_GRAPH_TYPE: {
      return handleSnapshot(payload, ctx);
    }
    default:
      throw new Error(`unity_graph: unknown request type '${type}'`);
  }
}

async function handleSnapshot(
  payload: unknown,
  ctx: HostHandlerContext,
): Promise<SnapshotResponse> {
  const assetIndex = ctx.getAssetIndex();
  if (!assetIndex) {
    // MCP server not started yet. AutoStart usually covers this; surface a
    // stable string the webview can translate into a "start server" CTA.
    throw new Error("server_not_started");
  }

  const req = (payload ?? {}) as Partial<SnapshotRequest>;
  const projectPath = typeof req.project_path === "string" ? req.project_path : undefined;
  const resolved = resolveProject(projectPath);
  if (resolved.errorResult || !resolved.project) {
    // Translate the resolver's ToolCallResult shape into a thrown Error whose
    // message is the JSON the webview can parse for the `error` key. Day 3's
    // webview (App.svelte error state) renders the raw message; the two
    // stable error keys (`no_project_open`, `multiple_projects_open`) get
    // friendlier copy there.
    const text = resolved.errorResult?.content?.[0]?.text ?? "unknown_project_error";
    throw new Error(text);
  }

  const index = await assetIndex.get(resolved.project);
  // buildAssetGraph already returns a fully-shaped SnapshotResponse
  // (generated_at, stats, warnings, etc.) — same call the MCP tool makes.
  const request: SnapshotRequest = {
    ...req,
    project_path: resolved.project.rootPath,
  };
  return buildAssetGraph(resolved.project.rootPath, index, request);
}
