import * as vscode from "vscode";
import { AbstractMcpTool, toPosition } from "../abstractTool";
import { TOOL_NAMES, PARAM_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext, resolveFilePath, toRelativePath } from "../../server/projectResolver";
import { Args, optionalInt, optionalString, requireString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import {
  callHierarchyIncoming,
  callHierarchyOutgoing,
  prepareCallHierarchy,
} from "../../utils/lspBridge";
import { CallElement, CallHierarchyResult } from "../../models/toolModels";

type Direction = "incoming" | "outgoing";

export class CallHierarchyTool extends AbstractMcpTool {
  readonly name = TOOL_NAMES.CALL_HIERARCHY;
  readonly description =
    "Show incoming or outgoing call hierarchy for a method at a position. " +
    "Target: file + line + column on a method name.";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .file(true)
    .lineAndColumn(true)
    .enumProperty("direction", "Direction of calls.", ["incoming", "outgoing"])
    .intProperty("depth", "How many levels to expand. Default 1.")
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
    const direction = (optionalString(args, "direction") ?? "incoming") as Direction;
    const depth = Math.max(1, Math.min(5, optionalInt(args, "depth") ?? 1));

    const uri = vscode.Uri.file(resolveFilePath(project, file));
    const items = await prepareCallHierarchy(uri, toPosition(line, column));
    if (items.length === 0) {
      return this.error("No method at the given position");
    }
    const root = items[0];

    const calls = await expand(root, direction, depth, project);
    const result: CallHierarchyResult = {
      element: toCallElement(root, project),
      calls,
    };
    return this.json(result);
  }
}

async function expand(
  item: vscode.CallHierarchyItem,
  direction: Direction,
  depth: number,
  project: ProjectContext,
): Promise<CallElement[]> {
  if (depth <= 0) return [];
  if (direction === "incoming") {
    const calls = await callHierarchyIncoming(item);
    const out: CallElement[] = [];
    for (const c of calls) {
      const node = toCallElement(c.from, project);
      if (depth > 1) node.children = await expand(c.from, direction, depth - 1, project);
      out.push(node);
    }
    return out;
  }
  const calls = await callHierarchyOutgoing(item);
  const out: CallElement[] = [];
  for (const c of calls) {
    const node = toCallElement(c.to, project);
    if (depth > 1) node.children = await expand(c.to, direction, depth - 1, project);
    out.push(node);
  }
  return out;
}

function toCallElement(
  item: vscode.CallHierarchyItem,
  project: ProjectContext,
): CallElement {
  return {
    name: item.name,
    file: toRelativePath(project, item.uri.fsPath),
    line: item.selectionRange.start.line + 1,
    column: item.selectionRange.start.character + 1,
  };
}
