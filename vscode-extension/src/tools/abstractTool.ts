import * as vscode from "vscode";
import { ToolCallResult } from "../models/jsonRpc";
import { ProjectContext } from "../server/projectResolver";
import { Args } from "../utils/args";
import { ReadinessGate } from "../server/readinessGate";
import { UnityAssetIndexManager } from "../utils/unityAssetIndexManager";

export interface ToolContext {
  readiness: ReadinessGate;
  /** Max time to wait for LSP readiness before tools that need it give up. */
  readinessTimeoutMs: number;
  log: (msg: string) => void;
  assetIndex: UnityAssetIndexManager;
  /** Aborts in-flight scans when the HTTP request is dropped or watchdog fires. */
  signal?: AbortSignal;
}

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Tools that walk the whole project (YAML scans, GUID search). BatchTool runs these on a serialized lane so they can't starve LSP entries. */
  readonly isHeavyScan?: boolean;
  execute(
    project: ProjectContext,
    args: Args,
    ctx: ToolContext,
  ): Promise<ToolCallResult>;
}

export abstract class AbstractMcpTool implements McpTool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly inputSchema: Record<string, unknown>;

  /** Override to false for tools that don't need the C# LSP (e.g. file ops, Unity YAML parsing). */
  protected readonly requiresLsp: boolean = true;

  async execute(
    project: ProjectContext,
    args: Args,
    ctx: ToolContext,
  ): Promise<ToolCallResult> {
    if (this.requiresLsp && !ctx.readiness.isReady()) {
      const ok = await ctx.readiness.waitUntilReady(ctx.readinessTimeoutMs);
      if (!ok) {
        return this.error(
          "C# Dev Kit / Roslyn LSP is still loading the solution. " +
            "Call ide_index_status to check when it completes, then retry.",
        );
      }
    }

    try {
      return await this.doExecute(project, args, ctx);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.log(`Tool ${this.name} failed: ${message}`);
      return this.error(message || "Unknown error");
    }
  }

  protected abstract doExecute(
    project: ProjectContext,
    args: Args,
    ctx: ToolContext,
  ): Promise<ToolCallResult>;

  protected success(text: string): ToolCallResult {
    return { content: [{ type: "text", text }], isError: false };
  }

  protected error(text: string): ToolCallResult {
    return { content: [{ type: "text", text }], isError: true };
  }

  protected json<T>(data: T): ToolCallResult {
    return this.success(JSON.stringify(data, null, 2));
  }

  protected structuredError(payload: unknown): ToolCallResult {
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      isError: true,
    };
  }
}

/** 0-based VS Code Position from 1-based MCP line/column. */
export function toPosition(line: number, column: number): vscode.Position {
  return new vscode.Position(Math.max(0, line - 1), Math.max(0, column - 1));
}

/** 1-based MCP line/column from a 0-based VS Code Position. */
export function fromPosition(pos: vscode.Position): { line: number; column: number } {
  return { line: pos.line + 1, column: pos.character + 1 };
}

export function severityName(s: vscode.DiagnosticSeverity): string {
  switch (s) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
    default:
      return "info";
  }
}

export function symbolKindName(k: vscode.SymbolKind): string {
  return vscode.SymbolKind[k] ?? "Unknown";
}
