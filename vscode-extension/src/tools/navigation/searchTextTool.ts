import * as path from "path";
import * as vscode from "vscode";
import { AbstractMcpTool, ToolContext } from "../abstractTool";
import { TOOL_NAMES, PARAM_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext, toRelativePath, toRelativeUri } from "../../server/projectResolver";
import {
  Args,
  optionalBoolean,
  optionalInt,
  optionalString,
  requireString,
} from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import { SearchTextResult, TextMatch } from "../../models/toolModels";
import { findRipgrep, runRipgrep } from "../../utils/ripgrep";

const DEFAULT_LIMIT = 200;
const EXCLUDE_GLOB = "**/{node_modules,Library,Temp,obj,bin,.git}/**";

export class SearchTextTool extends AbstractMcpTool {
  // Plain-text search doesn't need C# LSP.
  protected readonly requiresLsp = false;

  readonly name = TOOL_NAMES.SEARCH_TEXT;
  readonly description =
    "Plain-text search across project files. Use only when a semantic search (find_references, find_symbol) isn't applicable — e.g. matching strings inside comments or asset metadata.";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .stringProperty(PARAM_NAMES.QUERY, "Text or regex pattern to search for.", true)
    .booleanProperty(PARAM_NAMES.REGEX, "Treat query as a regex. Default false.")
    .booleanProperty(PARAM_NAMES.CASE_SENSITIVE, "Case-sensitive match. Default false.")
    .stringProperty(PARAM_NAMES.FILE_PATTERN, "Glob restricting files (e.g. '**/*.cs').")
    .intProperty(PARAM_NAMES.LIMIT, `Max matches. Default ${DEFAULT_LIMIT}.`)
    .build();

  protected async doExecute(
    project: ProjectContext,
    args: Args,
    ctx: ToolContext,
  ): Promise<ToolCallResult> {
    const query = requireString(args, PARAM_NAMES.QUERY);
    const isRegex = optionalBoolean(args, PARAM_NAMES.REGEX) ?? false;
    const caseSensitive = optionalBoolean(args, PARAM_NAMES.CASE_SENSITIVE) ?? false;
    const filePattern = optionalString(args, PARAM_NAMES.FILE_PATTERN);
    const limit = optionalInt(args, PARAM_NAMES.LIMIT) ?? DEFAULT_LIMIT;

    const rg = findRipgrep();
    const matches: TextMatch[] = rg
      ? await this.runRipgrep(project, rg, query, isRegex, caseSensitive, filePattern, limit, ctx)
      : await this.runVscodeFallback(project, query, isRegex, caseSensitive, filePattern, limit);

    const result: SearchTextResult = {
      matches,
      totalCount: matches.length,
      query,
      hint: computeEmptyResultHint(filePattern, matches.length) ?? undefined,
    };
    return this.json(result);
  }

  private async runRipgrep(
    project: ProjectContext,
    rgPath: string,
    pattern: string,
    isRegex: boolean,
    caseSensitive: boolean,
    filePattern: string | undefined,
    limit: number,
    ctx: ToolContext,
  ): Promise<TextMatch[]> {
    try {
      const hits = await runRipgrep({
        rgPath,
        cwd: project.rootPath,
        pattern,
        isRegex,
        caseSensitive,
        filePattern,
        limit,
        signal: ctx.signal,
      });
      return hits.map((h) => ({
        file: toRelativePath(project, path.resolve(project.rootPath, h.file)),
        line: h.line,
        column: h.column,
        context: h.text.trim(),
        contextType: "CODE",
      }));
    } catch (e) {
      ctx.log(
        `ripgrep failed (${e instanceof Error ? e.message : String(e)}); falling back to VS Code search`,
      );
      return this.runVscodeFallback(
        project,
        pattern,
        isRegex,
        caseSensitive,
        filePattern,
        limit,
      );
    }
  }

  private async runVscodeFallback(
    project: ProjectContext,
    query: string,
    isRegex: boolean,
    caseSensitive: boolean,
    filePattern: string | undefined,
    limit: number,
  ): Promise<TextMatch[]> {
    const re = buildRegex(query, isRegex, caseSensitive);
    if (!re) throw new Error("Invalid regex");

    const include = new vscode.RelativePattern(
      project.rootUri,
      filePattern && filePattern.length > 0 ? filePattern : "**/*",
    );
    const uris = await vscode.workspace.findFiles(include, EXCLUDE_GLOB, 5000);

    const matches: TextMatch[] = [];
    for (const uri of uris) {
      if (matches.length >= limit) break;
      let doc: vscode.TextDocument;
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch {
        continue;
      }
      for (let i = 0; i < doc.lineCount && matches.length < limit; i++) {
        const lineText = doc.lineAt(i).text;
        re.lastIndex = 0;
        const m = re.exec(lineText);
        if (!m) continue;
        matches.push({
          file: toRelativeUri(project, uri),
          line: i + 1,
          column: m.index + 1,
          context: lineText.trim(),
          contextType: "CODE",
        });
      }
    }
    return matches;
  }
}

const UNITY_ASSET_EXTS = new Set([
  "asset",
  "prefab",
  "unity",
  "meta",
  "mat",
  "anim",
  "controller",
  "asmdef",
]);

function isUnityAssetMask(filePattern: string | undefined): boolean {
  if (!filePattern) return false;
  return filePattern.split(",").some((token) => {
    const trimmed = token.trim();
    const dot = trimmed.lastIndexOf(".");
    if (dot < 0) return false;
    return UNITY_ASSET_EXTS.has(trimmed.slice(dot + 1).toLowerCase());
  });
}

function computeEmptyResultHint(
  filePattern: string | undefined,
  totalMatches: number,
): string | null {
  if (totalMatches > 0) return null;
  if (isUnityAssetMask(filePattern)) {
    return "No matches. To find references to a ScriptableObject, Component, or prefab/scene usages inside Unity assets, prefer unity_get_component_usage — it parses Unity YAML and resolves GUID/fileID links instead of plain text matching.";
  }
  if (filePattern && filePattern.length > 0) {
    return `No matches found within files matching filePattern='${filePattern}'. Verify the glob (e.g. '**/*.cs') and that those files are not under an excluded directory.`;
  }
  return null;
}

function buildRegex(
  pattern: string,
  isRegex: boolean,
  caseSensitive: boolean,
): RegExp | null {
  const flags = caseSensitive ? "g" : "gi";
  const source = isRegex ? pattern : escapeRegex(pattern);
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
