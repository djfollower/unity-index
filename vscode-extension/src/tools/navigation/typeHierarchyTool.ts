import * as vscode from "vscode";
import { AbstractMcpTool, symbolKindName, toPosition } from "../abstractTool";
import { TOOL_NAMES, PARAM_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext, resolveFilePath, toRelativePath } from "../../server/projectResolver";
import { Args, optionalInt, requireString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import {
  prepareTypeHierarchy,
  typeHierarchySubtypes,
  typeHierarchySupertypes,
} from "../../utils/lspBridge";
import { TypeElement, TypeHierarchyResult } from "../../models/toolModels";

export class TypeHierarchyTool extends AbstractMcpTool {
  readonly name = TOOL_NAMES.TYPE_HIERARCHY;
  readonly description =
    "Show the type hierarchy (supertypes + subtypes) for a class or interface at a position. " +
    "Target: file + line + column on a type name.";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .file(true)
    .lineAndColumn(true)
    .intProperty("depth", "Hierarchy depth in each direction. Default 2.")
    .build();

  protected async doExecute(
    project: ProjectContext,
    args: Args,
  ): Promise<ToolCallResult> {
    const file = requireString(args, PARAM_NAMES.FILE);
    const line = optionalInt(args, PARAM_NAMES.LINE);
    const column = optionalInt(args, PARAM_NAMES.COLUMN);
    if (line === undefined || column === undefined) {
      return this.error("Missing line or column");
    }
    const depth = Math.max(1, Math.min(5, optionalInt(args, "depth") ?? 2));

    const uri = vscode.Uri.file(resolveFilePath(project, file));
    const items = await prepareTypeHierarchy(uri, toPosition(line, column));
    if (items.length === 0) {
      return this.error("No type at the given position");
    }
    const root = items[0];

    const supertypes = await expand(
      root,
      depth,
      typeHierarchySupertypes,
      project,
    );
    const subtypes = await expand(
      root,
      depth,
      typeHierarchySubtypes,
      project,
    );

    const result: TypeHierarchyResult = {
      element: toTypeElement(root, project),
      supertypes,
      subtypes,
    };
    return this.json(result);
  }
}

async function expand(
  start: vscode.TypeHierarchyItem,
  depth: number,
  fetch: (item: vscode.TypeHierarchyItem) => Promise<vscode.TypeHierarchyItem[]>,
  project: ProjectContext,
): Promise<TypeElement[]> {
  if (depth <= 0) return [];
  const items = await fetch(start);
  const result: TypeElement[] = [];
  for (const item of items) {
    const node = toTypeElement(item, project);
    if (depth > 1) {
      node.supertypes = await expand(item, depth - 1, fetch, project);
    }
    result.push(node);
  }
  return result;
}

function toTypeElement(
  item: vscode.TypeHierarchyItem,
  project: ProjectContext,
): TypeElement {
  return {
    name: item.name,
    file: item.uri ? toRelativePath(project, item.uri.fsPath) : null,
    kind: symbolKindName(item.kind),
  };
}
