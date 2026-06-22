import * as vscode from "vscode";
import { AbstractMcpTool, symbolKindName, toPosition } from "../abstractTool";
import { TOOL_NAMES, PARAM_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext, resolveFilePath, toRelativePath } from "../../server/projectResolver";
import { Args, optionalInt, requireString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import {
  executeDefinition,
  executeDocumentSymbols,
  prepareTypeHierarchy,
  typeHierarchySupertypes,
} from "../../utils/lspBridge";
import {
  MethodInfo,
  SuperMethodInfo,
  SuperMethodsResult,
} from "../../models/toolModels";

export class FindSuperMethodsTool extends AbstractMcpTool {
  readonly name = TOOL_NAMES.FIND_SUPER_METHODS;
  readonly description =
    "For a method at a position, find the methods it overrides in supertypes (base classes / interfaces). " +
    "Useful for understanding override chains in MonoBehaviour subclasses (e.g. Update, OnEnable). " +
    "Target: file + line + column on the method name.";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .file(true)
    .lineAndColumn(true)
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

    const uri = vscode.Uri.file(resolveFilePath(project, file));
    const doc = await vscode.workspace.openTextDocument(uri);
    const position = toPosition(line, column);

    // Find the enclosing method and its containing type.
    const symbols = await executeDocumentSymbols(uri);
    const method = findEnclosing(symbols, position, [
      vscode.SymbolKind.Method,
      vscode.SymbolKind.Function,
      vscode.SymbolKind.Constructor,
    ]);
    if (!method) return this.error("No method at the given position");

    const containingType = findEnclosing(symbols, position, [
      vscode.SymbolKind.Class,
      vscode.SymbolKind.Struct,
      vscode.SymbolKind.Interface,
    ]);

    const methodInfo: MethodInfo = {
      name: method.name,
      signature: method.detail || method.name,
      containingClass: containingType?.name ?? "",
      file: toRelativePath(project, uri.fsPath),
      line: method.selectionRange.start.line + 1,
      column: method.selectionRange.start.character + 1,
    };

    if (!containingType) {
      return this.json({ method: methodInfo, hierarchy: [], totalCount: 0 } as SuperMethodsResult);
    }

    // Walk supertypes; for each, look for a method with the same name.
    const supertypes = await collectSupertypes(uri, containingType.selectionRange.start);
    const hierarchy: SuperMethodInfo[] = [];
    let depth = 0;
    for (const t of supertypes) {
      depth++;
      const match = await findMethodOnType(t, method.name);
      if (match) {
        hierarchy.push({
          name: match.name,
          signature: match.detail || match.name,
          containingClass: t.name,
          containingClassKind: symbolKindName(t.kind),
          file: t.uri ? toRelativePath(project, t.uri.fsPath) : null,
          line: match.selectionRange.start.line + 1,
          column: match.selectionRange.start.character + 1,
          isInterface: t.kind === vscode.SymbolKind.Interface,
          depth,
        });
      }
    }

    // Fallback: ask LSP for definition of the method name itself.
    if (hierarchy.length === 0) {
      const defs = await executeDefinition(uri, method.selectionRange.start);
      for (const def of defs) {
        if (def.uri.toString() === uri.toString() && def.range.intersection(method.selectionRange)) {
          continue;
        }
        hierarchy.push({
          name: method.name,
          signature: method.name,
          containingClass: "",
          containingClassKind: "Unknown",
          file: toRelativePath(project, def.uri.fsPath),
          line: def.range.start.line + 1,
          column: def.range.start.character + 1,
          isInterface: false,
          depth: 1,
        });
      }
    }

    void doc;
    const result: SuperMethodsResult = {
      method: methodInfo,
      hierarchy,
      totalCount: hierarchy.length,
    };
    return this.json(result);
  }
}

async function collectSupertypes(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<vscode.TypeHierarchyItem[]> {
  const items = await prepareTypeHierarchy(uri, position);
  if (items.length === 0) return [];
  const visited = new Set<string>();
  const queue: vscode.TypeHierarchyItem[] = [];
  const expand = async (item: vscode.TypeHierarchyItem) => {
    const supers = await typeHierarchySupertypes(item);
    for (const s of supers) {
      const key = `${s.uri.toString()}|${s.name}|${s.selectionRange.start.line}`;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push(s);
      await expand(s);
    }
  };
  await expand(items[0]);
  return queue;
}

async function findMethodOnType(
  type: vscode.TypeHierarchyItem,
  methodName: string,
): Promise<vscode.DocumentSymbol | undefined> {
  try {
    const symbols = await executeDocumentSymbols(type.uri);
    return walkFind(symbols, type.range, methodName);
  } catch {
    return undefined;
  }
}

function walkFind(
  symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[],
  withinTypeRange: vscode.Range,
  methodName: string,
): vscode.DocumentSymbol | undefined {
  for (const s of symbols) {
    if (!("children" in s)) continue;
    if (!s.range.intersection(withinTypeRange)) continue;
    if (s.kind === vscode.SymbolKind.Method && s.name === methodName) return s;
    const child = walkFind(s.children, withinTypeRange, methodName);
    if (child) return child;
  }
  return undefined;
}

function findEnclosing(
  symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[],
  position: vscode.Position,
  kinds: vscode.SymbolKind[],
): vscode.DocumentSymbol | undefined {
  let found: vscode.DocumentSymbol | undefined;
  const visit = (list: vscode.DocumentSymbol[] | vscode.SymbolInformation[]) => {
    for (const s of list) {
      if (!("children" in s)) continue;
      if (!s.range.contains(position)) continue;
      if (kinds.includes(s.kind)) found = s;
      visit(s.children);
    }
  };
  visit(symbols);
  return found;
}
