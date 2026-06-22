import * as vscode from "vscode";
import { AbstractMcpTool, severityName } from "../abstractTool";
import { TOOL_NAMES, PARAM_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext, toRelativeUri } from "../../server/projectResolver";
import { Args, optionalBoolean, optionalInt, optionalString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import { DiagnosticsResult, ProblemInfo } from "../../models/toolModels";

export class GetDiagnosticsTool extends AbstractMcpTool {
  // Diagnostics are drained from LSP, so we still want readiness — but they're
  // also useful before full readiness (e.g. to surface partial errors), so we
  // don't strictly require LSP up.
  protected readonly requiresLsp = false;

  readonly name = TOOL_NAMES.DIAGNOSTICS;
  readonly description =
    "Return compiler errors, warnings, and other diagnostics from C# Dev Kit / Roslyn LSP — the same items shown in the VS Code Problems panel. " +
    "Filter by severity if needed.";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .stringProperty(PARAM_NAMES.FILE, "Optional path to limit diagnostics to a single file.")
    .enumProperty(PARAM_NAMES.SEVERITY, "Minimum severity.", ["error", "warning", "info", "hint"])
    .intProperty("maxProblems", "Max items. Default 500.")
    .booleanProperty(PARAM_NAMES.INCLUDE_BUILD_ERRORS, "(Reserved) include build-system errors. Default false.")
    .build();

  protected async doExecute(
    project: ProjectContext,
    args: Args,
  ): Promise<ToolCallResult> {
    const file = optionalString(args, PARAM_NAMES.FILE);
    const minSeverity = (optionalString(args, PARAM_NAMES.SEVERITY) ?? "info").toLowerCase();
    const maxProblems = optionalInt(args, "maxProblems") ?? 500;
    void optionalBoolean(args, PARAM_NAMES.INCLUDE_BUILD_ERRORS);

    const minRank = severityRank(minSeverity);
    const all: [vscode.Uri, readonly vscode.Diagnostic[]][] = [];
    if (file) {
      const path = require("path") as typeof import("path");
      const uri = vscode.Uri.file(
        path.isAbsolute(file) ? file : path.join(project.rootPath, file),
      );
      all.push([uri, vscode.languages.getDiagnostics(uri)]);
    } else {
      for (const [uri, diags] of vscode.languages.getDiagnostics()) {
        if (uri.fsPath.startsWith(project.rootPath)) all.push([uri, diags]);
      }
    }

    const problems: ProblemInfo[] = [];
    for (const [uri, diags] of all) {
      for (const d of diags) {
        if (severityRank(severityName(d.severity)) < minRank) continue;
        if (problems.length >= maxProblems) break;
        problems.push({
          message: d.message,
          severity: severityName(d.severity),
          file: toRelativeUri(project, uri),
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          endLine: d.range.end.line + 1,
          endColumn: d.range.end.character + 1,
        });
      }
    }

    const result: DiagnosticsResult = {
      problems,
      problemCount: problems.length,
      analysisFresh: true,
      analysisMessage: undefined,
    };
    return this.json(result);
  }
}

function severityRank(name: string): number {
  switch (name) {
    case "error":
      return 4;
    case "warning":
      return 3;
    case "info":
      return 2;
    case "hint":
      return 1;
    default:
      return 2;
  }
}
