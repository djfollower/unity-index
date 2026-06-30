import type { SnapshotRequest, SnapshotResponse } from "@unity-index/graph-core";
import { materializeClassAnchors } from "@unity-index/graph-core";
import { AbstractMcpTool, ToolContext } from "../abstractTool";
import { TOOL_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext } from "../../server/projectResolver";
import { Args } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";

/**
 * Day 2 MCP surface for the Unity asset graph. Wire format documented in
 * docs/graph-mcp-tools.md §3.1 and docs/graph-schema.md.
 *
 * Asset-domain only. Code edges (csharp nodes) arrive in Day 8.
 */
export class UnityGraphSnapshotTool extends AbstractMcpTool {
  protected readonly requiresLsp = false;
  readonly isHeavyScan = true;

  readonly name = TOOL_NAMES.UNITY_GRAPH_SNAPSHOT;
  readonly description =
    "Return the full Unity asset graph as a GraphSnapshot — every script, prefab, scene, ScriptableObject, and asset under the project, plus the edges between them (script_used_by_prefab/scene, scene_contains_prefab, prefab_variant_of, serialized_binding, script_declares_class). " +
    "Sub-file kinds (component_instance, component_field) are never returned as top-level nodes; their counts go into stats.skipped_component_* and the underlying IDs ride along as edge metadata. Use unity_graph_expand (Phase 1, ships Day 6 or 7) to materialize them for a single container. " +
    "script_declares_class edges point to unity://csharp/T:<ClassName> IDs that Day 8 (unity_graph_code_edges) will materialize. A single dangling_csharp_targets warning is emitted when any such edges are present (set include_class_anchors=true to suppress).";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .property("include_kinds", {
      type: "array",
      description:
        "Restrict the snapshot to these NodeKinds (e.g. script, prefab, scene, so, asset).",
      items: { type: "string" },
    })
    .property("exclude_kinds", {
      type: "array",
      description: "Drop nodes of these NodeKinds. Applied after include_kinds.",
      items: { type: "string" },
    })
    .property("path_globs", {
      type: "array",
      description:
        "Project-relative globs that nodes must match; edges crossing the boundary are dropped.",
      items: { type: "string" },
    })
    .booleanProperty(
      "include_orphans",
      "Default true. When false, nodes with degree 0 are dropped.",
    )
    .booleanProperty(
      "include_class_anchors",
      "Default false. When true, materialize one `class` node per `script_declares_class` edge target (anchor=true) so the UI has stable IDs to attach Day 8 code edges to. Suppresses the dangling_csharp_targets warning.",
    )
    .property("pagination", {
      type: "object",
      description:
        "Opaque pagination cursor. Slices nodes; edges crossing the page boundary are dropped.",
      properties: {
        page_size: {
          type: "integer",
          description: "Default 5000, max 20000.",
        },
        cursor: {
          type: "string",
          description: "Opaque cursor from the previous response.",
        },
      },
    })
    .stringProperty(
      "request_id",
      "Optional; echoed back on the response for client correlation.",
    )
    .build();

  /** Day 8.4 — opt-in projection applied AFTER the cache so the cached
   *  unfiltered snapshot stays anchor-free and we don't bloat cold reads
   *  that don't ask for them. Pure function: `response` is not mutated. */
  private applyClassAnchors(
    response: SnapshotResponse,
    request: SnapshotRequest,
  ): SnapshotResponse {
    if (!request.include_class_anchors) return response;
    const result = materializeClassAnchors(response.snapshot, {
      warnings: response.warnings,
    });
    if (result.anchorsAdded === 0) return response;
    return {
      ...response,
      snapshot: result.snapshot,
      warnings: result.warnings,
    };
  }

  protected async doExecute(
    project: ProjectContext,
    args: Args,
    ctx: ToolContext,
  ): Promise<ToolCallResult> {
    const request = args as unknown as SnapshotRequest;
    try {
      const index = await ctx.assetIndex.get(project);
      const response = await ctx.graphCache.getSnapshot(
        project,
        index,
        request,
        ctx.signal,
      );
      return this.json(this.applyClassAnchors(response, request));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return this.error(`Failed to build asset graph: ${message}`);
    }
  }
}
