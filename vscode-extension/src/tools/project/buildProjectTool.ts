import * as vscode from "vscode";
import * as child_process from "child_process";
import * as path from "path";
import { AbstractMcpTool } from "../abstractTool";
import { TOOL_NAMES, PARAM_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext } from "../../server/projectResolver";
import {
  Args,
  optionalBoolean,
  optionalInt,
  optionalString,
} from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import { BuildMessage, BuildProjectResult } from "../../models/toolModels";

const DEFAULT_TIMEOUT_SECONDS = 180;
const MAX_OUTPUT_BYTES = 256 * 1024;

export class BuildProjectTool extends AbstractMcpTool {
  protected readonly requiresLsp = false;

  readonly name = TOOL_NAMES.BUILD_PROJECT;
  readonly description =
    "Build the project via `dotnet build`. Returns parsed errors/warnings with file/line/column. " +
    "For Unity projects, this validates the same C# code Unity compiles, but does not invoke the Unity Editor.";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .booleanProperty(PARAM_NAMES.REBUILD, "Pass --no-incremental to force a full rebuild.")
    .stringProperty("solution", "Optional path to a .sln or .csproj. Default: auto-detected in project root.")
    .intProperty(PARAM_NAMES.TIMEOUT_SECONDS, `Build timeout in seconds. Default ${DEFAULT_TIMEOUT_SECONDS}.`)
    .booleanProperty(PARAM_NAMES.INCLUDE_RAW_OUTPUT, "Include full stdout/stderr in the response.")
    .build();

  protected async doExecute(
    project: ProjectContext,
    args: Args,
  ): Promise<ToolCallResult> {
    const rebuild = optionalBoolean(args, PARAM_NAMES.REBUILD) ?? false;
    const solutionArg = optionalString(args, "solution");
    const timeoutSeconds = optionalInt(args, PARAM_NAMES.TIMEOUT_SECONDS) ?? DEFAULT_TIMEOUT_SECONDS;
    const includeRaw = optionalBoolean(args, PARAM_NAMES.INCLUDE_RAW_OUTPUT) ?? false;

    const target = solutionArg
      ? (path.isAbsolute(solutionArg) ? solutionArg : path.join(project.rootPath, solutionArg))
      : await findSolution(project.rootPath);
    if (!target) {
      return this.error("No .sln or .csproj found in project root. Pass 'solution' explicitly.");
    }

    const dotnetArgs = ["build", target, "-nologo"];
    if (rebuild) dotnetArgs.push("--no-incremental");

    const started = Date.now();
    let raw = "";
    let aborted = false;
    try {
      raw = await runDotnet(dotnetArgs, project.rootPath, timeoutSeconds * 1000);
    } catch (e) {
      if (e instanceof Error && e.message === "TIMEOUT") {
        aborted = true;
      } else if (e instanceof Error && e.message === "MISSING_DOTNET") {
        return this.error("`dotnet` CLI not found on PATH. Install .NET SDK to use this tool.");
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        return this.error(`Build failed to start: ${msg}`);
      }
    }
    const durationMs = Date.now() - started;

    const messages = parseBuildOutput(raw, project.rootPath);
    const errors = messages.filter((m) => m.category === "error").length;
    const warnings = messages.filter((m) => m.category === "warning").length;

    const truncated = raw.length > MAX_OUTPUT_BYTES;
    const result: BuildProjectResult = {
      success: !aborted && errors === 0,
      aborted,
      errors,
      warnings,
      buildMessages: messages,
      truncated,
      rawOutput: includeRaw ? (truncated ? raw.slice(0, MAX_OUTPUT_BYTES) : raw) : undefined,
      durationMs,
    };
    return this.json(result);
  }
}

async function findSolution(root: string): Promise<string | null> {
  const fs = require("fs") as typeof import("fs");
  const entries = fs.readdirSync(root);
  const sln = entries.find((e) => e.endsWith(".sln"));
  if (sln) return path.join(root, sln);
  const csproj = entries.find((e) => e.endsWith(".csproj"));
  if (csproj) return path.join(root, csproj);
  return null;
}

function runDotnet(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let killed = false;
    let proc: child_process.ChildProcess;
    try {
      proc = child_process.spawn("dotnet", args, { cwd });
    } catch (e) {
      reject(new Error("MISSING_DOTNET"));
      return;
    }
    proc.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") reject(new Error("MISSING_DOTNET"));
      else reject(err);
    });
    proc.stdout?.on("data", (d) => {
      output += d.toString();
      if (output.length > MAX_OUTPUT_BYTES * 2) output = output.slice(-MAX_OUTPUT_BYTES * 2);
    });
    proc.stderr?.on("data", (d) => {
      output += d.toString();
    });
    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
    }, timeoutMs);
    proc.on("close", () => {
      clearTimeout(timer);
      if (killed) reject(new Error("TIMEOUT"));
      else resolve(output);
    });
  });
}

// Parse lines like: /path/File.cs(12,5): error CS1234: message
const BUILD_LINE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(\w+):\s+(.+?)(?:\s+\[.+\])?$/;

function parseBuildOutput(raw: string, projectRoot: string): BuildMessage[] {
  const msgs: BuildMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = BUILD_LINE.exec(line.trim());
    if (!m) continue;
    let filePath = m[1];
    if (path.isAbsolute(filePath) && filePath.startsWith(projectRoot)) {
      filePath = path.relative(projectRoot, filePath).split(path.sep).join("/");
    }
    msgs.push({
      category: m[4],
      message: `${m[5]}: ${m[6]}`,
      file: filePath,
      line: parseInt(m[2], 10),
      column: parseInt(m[3], 10),
    });
  }
  return msgs;
}
