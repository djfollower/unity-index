import * as fs from "fs";
import * as path from "path";
import { AbstractMcpTool } from "../abstractTool";
import { TOOL_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext } from "../../server/projectResolver";
import { Args } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";

interface PackageInfo {
  name: string;
  version: string;
}

interface ProjectContextResult {
  unityVersion: string | null;
  renderPipeline: string;
  companyName: string | null;
  productName: string | null;
  targetPlatforms: string[];
  scriptingBackend: string | null;
  apiCompatibilityLevel: string | null;
  packages: PackageInfo[];
  projectPath: string;
}

export class GetProjectContextTool extends AbstractMcpTool {
  protected readonly requiresLsp = false;

  readonly name = TOOL_NAMES.GET_PROJECT_CONTEXT;
  readonly description =
    "Get Unity project context: Unity version, render pipeline, target platforms, company/product name, and installed packages. " +
    "Essential for any AI agent working with a Unity project — answers \"what kind of project is this?\" without opening the Editor.";
  readonly inputSchema = SchemaBuilder.tool().projectPath().build();

  protected async doExecute(
    project: ProjectContext,
    _args: Args,
  ): Promise<ToolCallResult> {
    const result: ProjectContextResult = {
      unityVersion: readUnityVersion(project.rootPath),
      renderPipeline: "Built-in",
      companyName: null,
      productName: null,
      targetPlatforms: [],
      scriptingBackend: null,
      apiCompatibilityLevel: null,
      packages: readPackageManifest(project.rootPath),
      projectPath: project.rootPath,
    };
    Object.assign(result, readProjectSettings(project.rootPath));
    result.renderPipeline = detectRenderPipeline(result.packages);
    return this.json(result);
  }
}

const VERSION_RE = /m_EditorVersion:\s*(.+)/;
const COMPANY_RE = /companyName:\s*(.+)/;
const PRODUCT_RE = /productName:\s*(.+)/;
const PLATFORM_RE = /enabledNativePlatforms\w*?(\w+):\s*(\d)/g;
const SCRIPTING_BACKEND_RE = /scriptingBackend:\s*\{[^}]*Standalone:\s*(\d)/;
const API_COMPAT_RE = /apiCompatibilityLevelPerPlatform:\s*\{[^}]*Standalone:\s*(\d)/;

function readUnityVersion(root: string): string | null {
  const f = path.join(root, "ProjectSettings", "ProjectVersion.txt");
  try {
    const content = fs.readFileSync(f, "utf-8");
    const m = VERSION_RE.exec(content);
    return m?.[1].trim() ?? null;
  } catch {
    return null;
  }
}

function readProjectSettings(root: string): Partial<ProjectContextResult> {
  const f = path.join(root, "ProjectSettings", "ProjectSettings.asset");
  try {
    const content = fs.readFileSync(f, "utf-8");
    const result: Partial<ProjectContextResult> = {};
    const company = COMPANY_RE.exec(content);
    if (company) result.companyName = company[1].trim();
    const product = PRODUCT_RE.exec(content);
    if (product) result.productName = product[1].trim();

    const platforms: string[] = [];
    let m: RegExpExecArray | null;
    PLATFORM_RE.lastIndex = 0;
    while ((m = PLATFORM_RE.exec(content)) !== null) {
      if (m[2] === "1") platforms.push(m[1]);
    }
    result.targetPlatforms = platforms;

    const scripting = SCRIPTING_BACKEND_RE.exec(content);
    if (scripting) {
      result.scriptingBackend = scripting[1] === "1" ? "IL2CPP" : "Mono";
    }

    const api = API_COMPAT_RE.exec(content);
    if (api) {
      result.apiCompatibilityLevel =
        api[1] === "3" ? ".NET Standard 2.1" : api[1] === "6" ? ".NET Framework" : api[1];
    }
    return result;
  } catch {
    return {};
  }
}

function readPackageManifest(root: string): PackageInfo[] {
  const f = path.join(root, "Packages", "manifest.json");
  try {
    const content = fs.readFileSync(f, "utf-8");
    const parsed = JSON.parse(content) as { dependencies?: Record<string, string> };
    const deps = parsed.dependencies ?? {};
    return Object.entries(deps)
      .map(([name, version]) => ({ name, version: String(version).replace(/^"|"$/g, "") }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function detectRenderPipeline(packages: PackageInfo[]): string {
  const names = new Set(packages.map((p) => p.name));
  if (names.has("com.unity.render-pipelines.universal")) return "URP";
  if (names.has("com.unity.render-pipelines.high-definition")) return "HDRP";
  if (names.has("com.unity.render-pipelines.core")) return "SRP (custom)";
  return "Built-in";
}
