import type { SnapshotDeltaRequest } from "@unity-index/graph-core";
import { AbstractMcpTool, ToolContext } from "../abstractTool";
import { TOOL_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext } from "../../server/projectResolver";
import { Args } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";

/**
 * Day 7 MCP surface for incremental Unity asset graph updates. Wire format
 * documented in graph/core/src/snapshot-delta-wire.ts.
 *
 * Routes through {@link GraphSnapshotCache} which holds the unfiltered
 * snapshot, listens to the workspace file-system watcher, and serves a
 * one-step delta when a client is exactly one revision behind. Clients more
 * than one revision behind, or requesting a filtered delta, receive a
 * `reset: true` response carrying the current full snapshot.
 *
 * Rider parity for this tool lands in Day-7 Task 4.
 */
export class UnityGraphSnapshotDeltaTool extends AbstractMcpTool {
  protected readonly requiresLsp = false;
  readonly isHeavyScan = true;

  readonly name = TOOL_NAMES.UNITY_GRAPH_SNAPSHOT_DELTA;
  readonly description =
    "Return the changes to the Unity asset graph since a previously-cached revision. " +
    "Response is either a SnapshotDelta (when the host can serve incremental changes) or a full reset payload (when the cache is cold, history is exhausted, or filters mismatched). " +
    "Pass since_revision=0 to bootstrap. Filtered delta requests (include_kinds/exclude_kinds/path_globs/include_orphans=false) currently always reset with a full filtered snapshot.";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .property("since_revision", {
      type: "integer",
      description:
        "Revision the client last applied. Pass 0 to force the reset code path.",
    })
    .property("include_kinds", {
      type: "array",
      description: "Restrict the delta to nodes of these NodeKinds.",
      items: { type: "string" },
    })
    .property("exclude_kinds", {
      type: "array",
      description:
        "Drop nodes of these NodeKinds. Applied after include_kinds.",
      items: { type: "string" },
    })
    .property("path_globs", {
      type: "array",
      description: "Project-relative globs that nodes must match.",
      items: { type: "string" },
    })
    .booleanProperty(
      "include_orphans",
      "Default true. When false, nodes with degree 0 are dropped.",
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
    const request = args as unknown as SnapshotDeltaRequest;
    try {
      const index = await ctx.assetIndex.get(project);
      const response = await ctx.graphCache.getDelta(
        project,
        index,
        request,
        ctx.signal,
      );
      return this.json(response);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return this.error(`Failed to build asset graph: ${message}`);
    }
  }
}
