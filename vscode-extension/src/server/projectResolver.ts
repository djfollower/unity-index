import * as vscode from "vscode";
import * as path from "path";
import { ERROR_KEYS, ERROR_MESSAGES } from "../constants";
import { ToolCallResult } from "../models/jsonRpc";

export interface ProjectContext {
  /** Workspace folder URI on disk. */
  rootUri: vscode.Uri;
  /** Display name (folder name). */
  name: string;
  /** Absolute path for filesystem operations. */
  rootPath: string;
}

export interface ResolveResult {
  project?: ProjectContext;
  errorResult?: ToolCallResult;
}

function normalize(p: string): string {
  return p.replace(/[\\/]+$/, "").replace(/\\/g, "/");
}

function asContext(folder: vscode.WorkspaceFolder): ProjectContext {
  return {
    rootUri: folder.uri,
    name: folder.name,
    rootPath: folder.uri.fsPath,
  };
}

function structuredError(payload: Record<string, unknown>): ToolCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

function buildAvailableProjects(
  folders: readonly vscode.WorkspaceFolder[],
): Array<Record<string, string>> {
  return folders.map((f) => ({ name: f.name, path: f.uri.fsPath }));
}

export function resolveProject(projectPath: string | undefined): ResolveResult {
  const folders = vscode.workspace.workspaceFolders ?? [];

  if (folders.length === 0) {
    return {
      errorResult: structuredError({
        error: ERROR_KEYS.NO_PROJECT_OPEN,
        message: ERROR_MESSAGES.NO_PROJECT_OPEN,
      }),
    };
  }

  if (projectPath) {
    const target = normalize(projectPath);

    const exact = folders.find((f) => normalize(f.uri.fsPath) === target);
    if (exact) return { project: asContext(exact) };

    // Parent path match: target is inside a workspace folder.
    const parent = folders.find((f) => {
      const base = normalize(f.uri.fsPath);
      return base.length > 0 && target.startsWith(base + "/");
    });
    if (parent) return { project: asContext(parent) };

    return {
      errorResult: structuredError({
        error: ERROR_KEYS.PROJECT_NOT_FOUND,
        message: `No open workspace folder matches the specified path: ${projectPath}`,
        hint: diagnosePath(target),
        available_projects: buildAvailableProjects(folders),
      }),
    };
  }

  if (folders.length === 1) {
    return { project: asContext(folders[0]) };
  }

  return {
    errorResult: structuredError({
      error: ERROR_KEYS.MULTIPLE_PROJECTS,
      message: ERROR_MESSAGES.MULTIPLE_PROJECTS,
      available_projects: buildAvailableProjects(folders),
    }),
  };
}

function diagnosePath(target: string): string {
  try {
    const fs = require("fs") as typeof import("fs");
    if (!fs.existsSync(target)) return "Path does not exist on disk.";
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) {
      return "Path is a file, not a directory — project_path must be a directory.";
    }
    return "Path exists but is not part of any open workspace folder.";
  } catch {
    return "Path exists but is not part of any open workspace folder.";
  }
}

/**
 * Resolves a file argument to an absolute fs path within the project.
 * Accepts project-relative or absolute paths.
 */
export function resolveFilePath(
  project: ProjectContext,
  fileArg: string,
): string {
  if (path.isAbsolute(fileArg)) return fileArg;
  return path.join(project.rootPath, fileArg);
}

export function toRelativePath(
  project: ProjectContext,
  absPath: string,
): string {
  const rel = path.relative(project.rootPath, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return absPath;
  return rel.split(path.sep).join("/");
}

export function toRelativeUri(
  project: ProjectContext,
  uri: vscode.Uri,
): string {
  return toRelativePath(project, uri.fsPath);
}
