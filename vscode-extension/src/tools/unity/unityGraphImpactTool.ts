import type {
  ImpactRequest,
  ImpactResponse,
  SnapshotRequest,
  Warning,
} from "@unity-index/graph-core";
import {
  buildAdjacency,
  impact,
  WARNING_ID_UNRESOLVED,
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

const MAX_SEEDS = 50;

/**
 * Day-6 MCP surface — see graph-mcp-tools.md §3.3.
 * Reverse-reachable closure: "what breaks if I delete this." Direction is
 * fixed to incoming; clients use unity_graph_neighbors for forward queries.
 */
export class UnityGraphImpactTool extends AbstractMcpTool {
  protected readonly requiresLsp = false;
  readonly isHeavyScan = true;

  readonly name = TOOL_NAMES.UNITY_GRAPH_IMPACT;
  readonly description =
    "Compute the reverse-reachable closure of one or more graph nodes — i.e. everything that breaks if those nodes are deleted. " +
    "Each impacted node carries a distance (BFS depth) and a classification: 'direct' (compile/run break), 'transitive' (depends via another break), or 'weak' (only referenced via serialized fields — survives as a missing-reference warning).";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .property(
      "node_ids",
      {
        type: "array",
        description: `1..${MAX_SEEDS} graph node IDs to seed the reverse-BFS.`,
        items: { type: "string" },
      },
      true,
    )
    .intProperty("max_depth", "Optional BFS depth cap. Default unbounded.")
    .booleanProperty(
      "classify",
      "Default true. Tags each impacted node with directness (direct/transitive/weak).",
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
    const request = args as unknown as ImpactRequest;
    const seeds = Array.isArray(request.node_ids) ? request.node_ids : [];
    if (seeds.length < 1 || seeds.length > MAX_SEEDS) {
      return this.error(
        `node_ids must contain between 1 and ${MAX_SEEDS} entries (got ${seeds.length}).`,
      );
    }
    const classify = request.classify ?? true;
    const maxDepth = request.max_depth;

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

      const unresolved = seeds.filter((id) => !adj.nodesById.has(id));
      const resolved = seeds.filter((id) => adj.nodesById.has(id));

      const result = impact(adj, resolved, { maxDepth, classify });

      const warnings: Warning[] = [];
      for (const id of unresolved) {
        warnings.push({
          code: WARNING_ID_UNRESOLVED,
          message: `Seed node id '${id}' not present in the current snapshot.`,
          context: { id },
        });
      }

      const subgraph = subgraphResponse(
        result.nodes,
        result.edges,
        fullResponse.snapshot.source_phase,
      );
      const response: ImpactResponse = {
        generated_at: subgraph.generated_at,
        snapshot: subgraph,
        impact: result.impacted,
      };
      if (request.request_id !== undefined) response.request_id = request.request_id;
      if (warnings.length > 0) response.warnings = warnings;
      return this.json(response);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return this.error(`Failed to compute impact: ${message}`);
    }
  }
}
