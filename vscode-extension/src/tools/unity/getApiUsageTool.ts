import * as fs from "fs";
import * as path from "path";
import { AbstractMcpTool } from "../abstractTool";
import { TOOL_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext, toRelativePath } from "../../server/projectResolver";
import { Args, requireString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";

interface ApiUsageMatch {
  file: string;
  line: number;
  column: number;
  context: string;
}

interface ApiUsageResult {
  apiName: string;
  matches: ApiUsageMatch[];
  totalCount: number;
}

const SKIP_DIRS = new Set(["Library", "Temp", "Logs", "obj", "bin", "node_modules", ".git"]);

export class GetApiUsageTool extends AbstractMcpTool {
  protected readonly requiresLsp = false;

  readonly name = TOOL_NAMES.GET_API_USAGE;
  readonly description =
    "Find all uses of a specific Unity API (e.g. \"Physics.Raycast\", \"Instantiate\", \"Resources.Load\"). " +
    "Use to audit API usage, find deprecated calls, or trace usage of a Unity feature.";
  readonly inputSchema = SchemaBuilder.tool()
    .stringProperty("apiName", "The Unity API name to search for (e.g. 'Physics.Raycast', 'Instantiate')", true)
    .projectPath()
    .build();

  protected async doExecute(
    project: ProjectContext,
    args: Args,
  ): Promise<ToolCallResult> {
    const apiName = requireString(args, "apiName");
    const pattern = new RegExp(escapeRegex(apiName), "g");
    const matches: ApiUsageMatch[] = [];

    walk(project.rootPath, (entry, isDir) => {
      if (isDir) return !SKIP_DIRS.has(path.basename(entry));
      if (!entry.endsWith(".cs")) return true;
      scanFile(entry, pattern, project, matches);
      return true;
    });

    matches.sort((a, b) => a.file.localeCompare(b.file));
    const result: ApiUsageResult = { apiName, matches, totalCount: matches.length };
    return this.json(result);
  }
}

function scanFile(
  absPath: string,
  pattern: RegExp,
  project: ProjectContext,
  matches: ApiUsageMatch[],
): void {
  let content: string;
  try {
    content = fs.readFileSync(absPath, "utf-8");
  } catch {
    return;
  }
  const rel = toRelativePath(project, absPath);
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("///")) continue;
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(line)) !== null) {
      matches.push({
        file: rel,
        line: i + 1,
        column: m.index + 1,
        context: trimmed,
      });
      if (m.index === pattern.lastIndex) pattern.lastIndex++;
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function walk(
  root: string,
  visit: (path: string, isDir: boolean) => boolean,
): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(root, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (visit(full, true)) walk(full, visit);
    } else {
      visit(full, false);
    }
  }
}
