import type {
  ContextRequest,
  ContextResponse,
  DiagnosticSummary,
  SnapshotRequest,
} from "@unity-index/graph-core";
import { buildAdjacency, context } from "@unity-index/graph-core";
import { AbstractMcpTool, ToolContext } from "../abstractTool";
import { TOOL_NAMES, PARAM_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext } from "../../server/projectResolver";
import { Args } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import { buildAssetGraph } from "../../utils/unityAssetGraphBuilder";
import { FileStructureTool } from "../navigation/fileStructureTool";
import { GetDiagnosticsTool } from "../intelligence/getDiagnosticsTool";
import type {
  DiagnosticsResult,
  FileStructureItem,
  FileStructureResult,
} from "../../models/toolModels";

const DEFAULT_MAX_NEIGHBORS = 50;

/**
 * Day-6 MCP surface — see graph-mcp-tools.md §3.4.
 * Single node + 1-hop neighborhood, flattened for LLM prompts. For `script`
 * nodes, optionally pulls a code summary (delegates to FileStructureTool)
 * and diagnostics (delegates to GetDiagnosticsTool).
 */
export class UnityGraphContextTool extends AbstractMcpTool {
  protected readonly requiresLsp = false;
  readonly isHeavyScan = true;

  readonly name = TOOL_NAMES.UNITY_GRAPH_CONTEXT;
  readonly description =
    "Return a single graph node plus its 1-hop neighborhood, optimized for LLM prompt construction. " +
    "Optionally enriches script nodes with a code-summary (ide_file_structure) and diagnostics (ide_diagnostics).";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .stringProperty("node_id", "Graph node ID to focus on.", true)
    .booleanProperty(
      "include_code_summary",
      "Default true. For script nodes, attaches a markdown-ish code summary.",
    )
    .booleanProperty(
      "include_diagnostics",
      "Default false. Attach diagnostics for the node's file (if any).",
    )
    .intProperty(
      "max_neighbors",
      `Cap per direction. Default ${DEFAULT_MAX_NEIGHBORS}.`,
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
    const request = args as unknown as ContextRequest;
    const nodeId = request.node_id;
    if (typeof nodeId !== "string" || nodeId.length === 0) {
      return this.structuredError({
        error: { kind: "invalid_id", detail: "node_id is required" },
      });
    }
    const includeCodeSummary = request.include_code_summary ?? true;
    const includeDiagnostics = request.include_diagnostics ?? false;
    const maxNeighbors = clamp(
      request.max_neighbors ?? DEFAULT_MAX_NEIGHBORS,
      1,
      10_000,
    );

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
      const result = context(adj, nodeId, { maxNeighbors });
      if (!result) {
        return this.structuredError({
          error: {
            kind: "invalid_id",
            detail: `node_id '${nodeId}' not present in the current snapshot`,
          },
        });
      }

      const response: ContextResponse = {
        generated_at: new Date().toISOString(),
        node: result.node,
        incoming: result.incoming,
        outgoing: result.outgoing,
      };
      if (result.truncated) response.truncated = true;
      if (request.request_id !== undefined) response.request_id = request.request_id;

      if (
        includeCodeSummary &&
        result.node.kind === "script" &&
        result.node.path
      ) {
        const summary = await tryCodeSummary(project, result.node.path, ctx);
        if (summary) response.code_summary = summary;
      }
      if (includeDiagnostics && result.node.path) {
        const diags = await tryDiagnostics(project, result.node.path, ctx);
        if (diags && diags.length > 0) response.diagnostics = diags;
      }

      return this.json(response);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return this.error(`Failed to compute context: ${message}`);
    }
  }
}

async function tryCodeSummary(
  project: ProjectContext,
  filePath: string,
  ctx: ToolContext,
): Promise<string | undefined> {
  try {
    const tool = new FileStructureTool();
    const res = await tool.execute(
      project,
      { [PARAM_NAMES.FILE]: filePath } as unknown as Args,
      ctx,
    );
    if (res.isError) return undefined;
    const text = res.content?.[0]?.text;
    if (typeof text !== "string") return undefined;
    const parsed = JSON.parse(text) as FileStructureResult;
    if (!parsed.items || parsed.items.length === 0) return undefined;
    return renderStructure(parsed.items, 0);
  } catch {
    return undefined;
  }
}

function renderStructure(items: FileStructureItem[], depth: number): string {
  const out: string[] = [];
  for (const item of items) {
    const indent = "  ".repeat(depth);
    const detail = item.detail ? ` ${item.detail}` : "";
    out.push(`${indent}- ${item.kind} \`${item.name}\`${detail} (L${item.line})`);
    if (item.children && item.children.length > 0) {
      out.push(renderStructure(item.children, depth + 1));
    }
  }
  return out.join("\n");
}

async function tryDiagnostics(
  project: ProjectContext,
  filePath: string,
  ctx: ToolContext,
): Promise<DiagnosticSummary[] | undefined> {
  try {
    const tool = new GetDiagnosticsTool();
    const res = await tool.execute(
      project,
      { [PARAM_NAMES.FILE]: filePath } as unknown as Args,
      ctx,
    );
    if (res.isError) return undefined;
    const text = res.content?.[0]?.text;
    if (typeof text !== "string") return undefined;
    const parsed = JSON.parse(text) as DiagnosticsResult;
    if (!parsed.problems) return undefined;
    return parsed.problems.map((p) => {
      const severity: DiagnosticSummary["severity"] =
        p.severity === "error"
          ? "error"
          : p.severity === "warning"
            ? "warning"
            : "info";
      const entry: DiagnosticSummary = {
        severity,
        message: p.message,
      };
      if (typeof p.line === "number") entry.line = p.line;
      return entry;
    });
  } catch {
    return undefined;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}
