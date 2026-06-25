import * as vscode from "vscode";
import { AbstractMcpTool, symbolKindName, toPosition } from "../abstractTool";
import { TOOL_NAMES, PARAM_NAMES } from "../../constants";
import { ToolCallResult } from "../../models/jsonRpc";
import { ProjectContext, resolveFilePath, toRelativePath } from "../../server/projectResolver";
import { Args, clamp, optionalInt, requireString } from "../../utils/args";
import { SchemaBuilder } from "../../utils/schema";
import { executeDocumentSymbols } from "../../utils/lspBridge";
import { SymbolBodyResult } from "../../models/toolModels";

const DEFAULT_MAX_LINES = 500;
const MAX_MAX_LINES = 2000;

/**
 * Returns the full text of the enclosing symbol (method/property/class/field)
 * at a given position. Replaces the common "find_definition → Read with
 * guessed offset/limit" round-trip that agents otherwise do to inspect a
 * method body.
 *
 * Uses the same DocumentSymbol provider as ide_file_structure, so the
 * returned range is exactly the symbol's declared span — no line-count
 * heuristics, no overshooting into the next member.
 */
export class GetSymbolBodyTool extends AbstractMcpTool {
  readonly name = TOOL_NAMES.GET_SYMBOL_BODY;
  readonly description =
    "Return the full source text of the enclosing symbol (method, property, class, field, etc.) at a given position. " +
    "Use this after ide_find_definition / ide_find_symbol / ide_find_references when you want to read the actual body — it replaces the manual ide_read_file with a guessed line range, since the symbol's precise span is taken straight from the IDE's document-symbol provider. " +
    "Target: file + line + column. Example: {\"file\": \"Assets/Scripts/HomeHeader.cs\", \"line\": 94, \"column\": 18}";
  readonly inputSchema = SchemaBuilder.tool()
    .projectPath()
    .file(true)
    .lineAndColumn(true)
    .intProperty(
      "maxLines",
      `Cap the returned body at this many lines. Default ${DEFAULT_MAX_LINES}, max ${MAX_MAX_LINES}. Hits set truncated=true.`,
    )
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
    const maxLines = clamp(
      optionalInt(args, "maxLines") ?? DEFAULT_MAX_LINES,
      1,
      MAX_MAX_LINES,
    );

    const uri = vscode.Uri.file(resolveFilePath(project, file));
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      return this.error(`File not found: ${file}`);
    }

    const position = toPosition(line, column);
    const symbols = await executeDocumentSymbols(uri);
    const enclosing = findEnclosingSymbol(symbols, position);
    if (!enclosing) {
      return this.error(
        "No enclosing symbol at this position. " +
          "Pass a position inside a declared method/property/class/field — not a blank line, comment, or using directive.",
      );
    }

    const startLine = enclosing.range.start.line;
    const declaredEnd = enclosing.range.end.line;
    const cappedEnd = Math.min(declaredEnd, startLine + maxLines - 1);
    const truncated = cappedEnd < declaredEnd;
    const endChar = doc.lineAt(cappedEnd).text.length;
    const text = doc.getText(new vscode.Range(startLine, 0, cappedEnd, endChar));

    const result: SymbolBodyResult = {
      file: toRelativePath(project, uri.fsPath),
      symbolKind: enclosing.kind,
      symbolName: enclosing.name,
      qualifiedName: enclosing.qualifiedName,
      startLine: startLine + 1,
      endLine: cappedEnd + 1,
      text,
      truncated,
    };
    return this.json(result);
  }
}

interface EnclosingHit {
  name: string;
  qualifiedName: string;
  kind: string;
  range: vscode.Range;
}

function findEnclosingSymbol(
  symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[],
  position: vscode.Position,
): EnclosingHit | null {
  // VS Code returns either DocumentSymbol[] (hierarchical, has children +
  // ranges) or SymbolInformation[] (flat, only location). Roslyn/C# Dev Kit
  // returns DocumentSymbol — fall back generically just in case.
  if (symbols.length === 0) return null;
  if ("children" in symbols[0]) {
    return walkDocumentSymbols(
      symbols as vscode.DocumentSymbol[],
      position,
      [],
    );
  }
  return findFlatSymbol(symbols as vscode.SymbolInformation[], position);
}

function walkDocumentSymbols(
  symbols: vscode.DocumentSymbol[],
  position: vscode.Position,
  parentPath: string[],
): EnclosingHit | null {
  let best: EnclosingHit | null = null;
  for (const sym of symbols) {
    if (!sym.range.contains(position)) continue;
    const path = [...parentPath, sym.name];
    best = {
      name: sym.name,
      qualifiedName: path.join("."),
      kind: symbolKindName(sym.kind),
      range: sym.range,
    };
    const deeper = walkDocumentSymbols(sym.children ?? [], position, path);
    if (deeper) best = deeper;
  }
  return best;
}

function findFlatSymbol(
  symbols: vscode.SymbolInformation[],
  position: vscode.Position,
): EnclosingHit | null {
  let best: EnclosingHit | null = null;
  let bestSize = Infinity;
  for (const sym of symbols) {
    const range = sym.location.range;
    if (!range.contains(position)) continue;
    const size = (range.end.line - range.start.line) * 10000 +
      (range.end.character - range.start.character);
    if (size < bestSize) {
      bestSize = size;
      best = {
        name: sym.name,
        qualifiedName: sym.containerName
          ? `${sym.containerName}.${sym.name}`
          : sym.name,
        kind: symbolKindName(sym.kind),
        range,
      };
    }
  }
  return best;
}
