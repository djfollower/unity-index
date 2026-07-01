import type { ExportDocument, SnapshotRequest, SnapshotResponse } from "@unity-index/graph-core";
import {
  EXPORT_SCHEMA_VERSION,
  materializeClassAnchors,
} from "@unity-index/graph-core";
import { AbstractMcpTool, ToolContext } from "../abstractTool";
import { TOOL_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext } from "../../server/projectResolver";
import { Args } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";

/**
 * Day 11 Task 7 — `unity_graph_export`.
 *
 * Returns a v1 `ExportDocument` (see graph/core/src/export-wire.ts). Same
 * name / schema / response as the Kotlin `UnityGraphExportTool` so a single
 * MCP client config drives either host.
 *
 * Scope: asset snapshot + meta. Saved views and code-edge slices are
 * workflow concerns and stay lazy — call `unity_graph_code_edges`
 * separately and merge into a `codeEdges` block if you need one.
 */
export class UnityGraphExportTool extends AbstractMcpTool {
  protected readonly requiresLsp = false;
  readonly isHeavyScan = true;

  readonly name = TOOL_NAMES.UNITY_GRAPH_EXPORT;
  readonly description =
    "Return a self-contained JSON export of the current Unity graph — asset snapshot + producer meta — wrapped in the v1 ExportDocument envelope so the same file can be re-loaded via the 'Open Graph from File…' extension command. " +
    "Saved views and code-edge slices are not attached; call unity_graph_code_edges separately if your workflow needs them.";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .booleanProperty(
      "include_class_anchors",
      "Default false. When true, materialize `class` anchors for `script_declares_class` targets before serialising.",
    )
    .stringProperty("note", "Free-form note embedded in `meta.note`.")
    .stringProperty(
      "request_id",
      "Optional; echoed back on the response for client correlation.",
    )
    .build();

  /** Mirrors gradle.properties#pluginVersion / package.json#version.
   *  Bumped in lockstep per CLAUDE.md rule 3. */
  private static readonly PRODUCER_VERSION = "0.5.11";

  protected async doExecute(
    project: ProjectContext,
    args: Args,
    ctx: ToolContext,
  ): Promise<ToolCallResult> {
    const includeAnchors = args.include_class_anchors === true;
    const note = typeof args.note === "string" && args.note.length > 0 ? args.note : undefined;
    const requestId =
      typeof args.request_id === "string" && args.request_id.length > 0
        ? args.request_id
        : undefined;

    try {
      const req: SnapshotRequest = {
        project_path: project.rootPath,
        include_class_anchors: includeAnchors,
      };
      const index = await ctx.assetIndex.get(project);
      let response: SnapshotResponse = await ctx.graphCache.getSnapshot(
        project,
        index,
        req,
        ctx.signal,
      );
      if (includeAnchors) {
        const projection = materializeClassAnchors(response.snapshot, {
          warnings: response.warnings,
        });
        if (projection.anchorsAdded > 0) {
          response = {
            ...response,
            snapshot: projection.snapshot,
            warnings: projection.warnings,
          };
        }
      }

      const doc: ExportDocument = {
        schemaVersion: EXPORT_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        meta: {
          producer: "mcp",
          producerVersion: UnityGraphExportTool.PRODUCER_VERSION,
          sourceProject: project.name,
          sourceProjectPath: project.rootPath,
          ...(note ? { note } : {}),
        },
        snapshot: response.snapshot,
      };
      const payload: Record<string, unknown> = { ...doc };
      if (requestId) payload.request_id = requestId;
      return this.json(payload);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return this.error(`Failed to export graph: ${message}`);
    }
  }
}
