import * as fs from "fs";
import * as path from "path";
import { AbstractMcpTool } from "../abstractTool";
import { TOOL_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext, toRelativePath } from "../../server/projectResolver";
import { Args } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";

interface AssemblyDefinition {
  name: string;
  file: string;
  rootNamespace?: string;
  references: string[];
  includePlatforms: string[];
  excludePlatforms: string[];
  allowUnsafeCode: boolean;
  autoReferenced: boolean;
  noEngineReferences: boolean;
  defineConstraints: string[];
  isEditorOnly: boolean;
}

interface AssemblyMapResult {
  assemblies: AssemblyDefinition[];
  totalCount: number;
  projectPath: string;
}

const SKIP_DIRS = new Set(["Library", "Temp", "Logs", "obj", "bin", "node_modules", ".git"]);

export class GetAssemblyMapTool extends AbstractMcpTool {
  protected readonly requiresLsp = false;

  readonly name = TOOL_NAMES.GET_ASSEMBLY_MAP;
  readonly description =
    "Get the Unity project's assembly definition (.asmdef) structure and dependency graph. Returns all .asmdef files with their references, platforms, and constraints. " +
    "Use this to understand how the codebase is partitioned into compilation units.";
  readonly inputSchema = SchemaBuilder.tool().projectPath().build();

  protected async doExecute(
    project: ProjectContext,
    _args: Args,
  ): Promise<ToolCallResult> {
    const asmdefs: AssemblyDefinition[] = [];
    walk(project.rootPath, (entry, isDir) => {
      if (isDir) return !SKIP_DIRS.has(path.basename(entry));
      if (!entry.endsWith(".asmdef")) return true;
      const parsed = parseAsmdef(entry, project);
      if (parsed) asmdefs.push(parsed);
      return true;
    });

    asmdefs.sort((a, b) => a.name.localeCompare(b.name));
    const result: AssemblyMapResult = {
      assemblies: asmdefs,
      totalCount: asmdefs.length,
      projectPath: project.rootPath,
    };
    return this.json(result);
  }
}

function parseAsmdef(
  absPath: string,
  project: ProjectContext,
): AssemblyDefinition | null {
  try {
    const content = fs.readFileSync(absPath, "utf-8");
    const data = JSON.parse(content) as Record<string, unknown>;
    const name = data.name as string | undefined;
    if (!name) return null;

    const relativeFile = toRelativePath(project, absPath);
    const includePlatforms = (data.includePlatforms as string[] | undefined) ?? [];

    return {
      name,
      file: relativeFile,
      rootNamespace: typeof data.rootNamespace === "string" && data.rootNamespace.length > 0
        ? (data.rootNamespace as string)
        : undefined,
      references: (data.references as string[] | undefined) ?? [],
      includePlatforms,
      excludePlatforms: (data.excludePlatforms as string[] | undefined) ?? [],
      allowUnsafeCode: Boolean(data.allowUnsafeCode),
      autoReferenced: data.autoReferenced === undefined ? true : Boolean(data.autoReferenced),
      noEngineReferences: Boolean(data.noEngineReferences),
      defineConstraints: (data.defineConstraints as string[] | undefined) ?? [],
      isEditorOnly:
        (includePlatforms.length === 1 && includePlatforms[0] === "Editor") ||
        relativeFile.toLowerCase().includes("/editor/"),
    };
  } catch {
    return null;
  }
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
