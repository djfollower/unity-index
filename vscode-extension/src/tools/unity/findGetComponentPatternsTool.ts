import * as fs from "fs";
import * as path from "path";
import { AbstractMcpTool } from "../abstractTool";
import { TOOL_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext, toRelativePath } from "../../server/projectResolver";
import { Args, requireString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";

interface GetComponentMatch {
  file: string;
  line: number;
  column: number;
  context: string;
  variant: string;
}

interface GetComponentPatternsResult {
  typeName: string;
  matches: GetComponentMatch[];
  totalCount: number;
}

const SKIP_DIRS = new Set(["Library", "Temp", "Logs", "obj", "bin", "node_modules", ".git"]);

const METHOD_NAMES = [
  "GetComponent",
  "GetComponents",
  "GetComponentInChildren",
  "GetComponentsInChildren",
  "GetComponentInParent",
  "GetComponentsInParent",
  "AddComponent",
  "TryGetComponent",
];

export class FindGetComponentPatternsTool extends AbstractMcpTool {
  protected readonly requiresLsp = false;

  readonly name = TOOL_NAMES.FIND_GETCOMPONENT_PATTERNS;
  readonly description =
    "Find all GetComponent<T>() usage patterns for a given type. Detects GetComponent / AddComponent / TryGetComponent and their array/list variants. " +
    "These reveal implicit coupling between components that's invisible to find_references — Unity's de facto DI.";
  readonly inputSchema = SchemaBuilder.tool()
    .stringProperty("typeName", "The component type to search for", true)
    .projectPath()
    .build();

  protected async doExecute(
    project: ProjectContext,
    args: Args,
  ): Promise<ToolCallResult> {
    const typeName = requireString(args, "typeName");
    const patterns = buildPatterns(typeName);
    const matches: GetComponentMatch[] = [];

    walk(project.rootPath, (entry, isDir) => {
      if (isDir) return !SKIP_DIRS.has(path.basename(entry));
      if (!entry.endsWith(".cs")) return true;
      scanFile(entry, patterns, project, matches);
      return true;
    });

    matches.sort((a, b) => a.file.localeCompare(b.file));
    const result: GetComponentPatternsResult = {
      typeName,
      matches,
      totalCount: matches.length,
    };
    return this.json(result);
  }
}

interface PatternDef {
  re: RegExp;
  variant: string;
}

function buildPatterns(typeName: string): PatternDef[] {
  const esc = escapeRegex(typeName);
  const out: PatternDef[] = [];
  for (const m of METHOD_NAMES) {
    out.push({
      re: new RegExp(`${m}\\s*<\\s*${esc}\\s*>\\s*\\(`),
      variant: `${m}<${typeName}>()`,
    });
    out.push({
      re: new RegExp(`${m}\\s*\\(\\s*typeof\\s*\\(\\s*${esc}\\s*\\)`),
      variant: `${m}(typeof(${typeName}))`,
    });
  }
  return out;
}

function scanFile(
  absPath: string,
  patterns: PatternDef[],
  project: ProjectContext,
  matches: GetComponentMatch[],
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
    for (const p of patterns) {
      p.re.lastIndex = 0;
      const m = p.re.exec(line);
      if (!m) continue;
      matches.push({
        file: rel,
        line: i + 1,
        column: m.index + 1,
        context: line.trim(),
        variant: p.variant,
      });
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
