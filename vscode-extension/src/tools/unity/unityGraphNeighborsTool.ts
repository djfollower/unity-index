import type {
  EdgeKind,
  NeighborsRequest,
  NeighborsResponse,
  SnapshotRequest,
  TraversalDirection,
  Warning,
} from "@unity-index/graph-core";
import {
  buildAdjacency,
  neighbors,
  WARNING_ID_UNRESOLVED,
  WARNING_NEIGHBORS_TRUNCATED,
} from "@unity-index/graph-core";
import { AbstractMcpTool, ToolContext } from "../abstractTool";
import { TOOL_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext } from "../../server/projectResolver";
import { Args } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import {
  buildAssetGraph,
  subgraphResponse,
} from "../../utils/unityAssetGraphBuilder";

const DEFAULT_HOPS = 1;
const MAX_HOPS = 4;
const DEFAULT_MAX_NODES = 2000;
const HARD_MAX_NODES = 20000;
const MAX_SEEDS = 100;

/**
 * Day-6 MCP surface for the Unity asset graph — see graph-mcp-tools.md §3.2.
 * BFS from each seed (union), capped by hop count + max_nodes.
 */
export class UnityGraphNeighborsTool extends AbstractMcpTool {
  protected readonly requiresLsp = false;
  readonly isHeavyScan = true;

  readonly name = TOOL_NAMES.UNITY_GRAPH_NEIGHBORS;
  readonly description =
    "Return the N-hop neighborhood around one or more graph nodes as a GraphSnapshot. " +
    "BFS unions per seed; unresolved seed IDs are dropped (with an id_unresolved warning) and traversal continues for the rest. " +
    "Pair with unity_graph_snapshot to discover IDs first, then use this for focused subgraph queries.";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .property(
      "node_ids",
      {
        type: "array",
        description: "1..100 graph node IDs to seed the BFS.",
        items: { type: "string" },
      },
      true,
    )
    .intProperty("hops", `BFS depth, 1..${MAX_HOPS}. Default ${DEFAULT_HOPS}.`)
    .enumProperty(
      "direction",
      "Edge direction to traverse. Default 'both'.",
      ["in", "out", "both"],
    )
    .property("edge_kinds", {
      type: "array",
      description:
        "Restrict traversal to these EdgeKinds. Excluded kinds don't count toward the hop budget.",
      items: { type: "string" },
    })
    .intProperty(
      "max_nodes",
      `Hard cap on returned nodes. Default ${DEFAULT_MAX_NODES}, max ${HARD_MAX_NODES}.`,
    )
    .stringProperty(
      "request_id",
      "Optional; echoed back on the response for client correlation.",
    )
    .build();

  protected async doExecute(
    project: ProjectContext,
    args: Args,
    ctx: ToolContext,
  ): Promise<ToolCallResult> {
    const request = args as unknown as NeighborsRequest;
    const seeds = Array.isArray(request.node_ids) ? request.node_ids : [];
    if (seeds.length < 1 || seeds.length > MAX_SEEDS) {
      return this.error(
        `node_ids must contain between 1 and ${MAX_SEEDS} entries (got ${seeds.length}).`,
      );
    }
    const hops = clamp(request.hops ?? DEFAULT_HOPS, 1, MAX_HOPS);
    const direction: TraversalDirection = request.direction ?? "both";
    const maxNodes = clamp(
      request.max_nodes ?? DEFAULT_MAX_NODES,
      1,
      HARD_MAX_NODES,
    );
    const edgeKinds = request.edge_kinds
      ? new Set<EdgeKind>(request.edge_kinds)
      : undefined;

    try {
      const index = await ctx.assetIndex.get(project);
      const snapshotReq: SnapshotRequest = { project_path: project.rootPath };
      const fullResponse = await buildAssetGraph(
        project.rootPath,
        index,
        snapshotReq,
        ctx.signal,
      );
      const adj = buildAdjacency(fullResponse.snapshot);
      const result = neighbors(adj, seeds, {
        hops,
        direction,
        maxNodes,
        edgeKinds,
      });

      const warnings: Warning[] = [];
      for (const id of result.unresolvedIds) {
        warnings.push({
          code: WARNING_ID_UNRESOLVED,
          message: `Seed node id '${id}' not present in the current snapshot.`,
          context: { id },
        });
      }
      if (result.truncated) {
        warnings.push({
          code: WARNING_NEIGHBORS_TRUNCATED,
          message: `BFS hit max_nodes=${maxNodes} during expansion.`,
          context: { max_nodes: maxNodes },
        });
      }

      const subgraph = subgraphResponse(
        result.nodes,
        result.edges,
        fullResponse.snapshot.source_phase,
      );
      const response: NeighborsResponse = {
        generated_at: subgraph.generated_at,
        snapshot: subgraph,
      };
      if (result.truncated) response.truncated = true;
      if (request.request_id !== undefined) response.request_id = request.request_id;
      if (warnings.length > 0) response.warnings = warnings;
      return this.json(response);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return this.error(`Failed to compute neighbors: ${message}`);
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}
