import * as vscode from "vscode";
import {
  executeDocumentSymbols,
  executeWorkspaceSymbols,
  prepareTypeHierarchy,
  typeHierarchySubtypes,
  typeHierarchySupertypes,
} from "./lspBridge";
import { ResolvedFrom, SymbolMatch } from "../models/toolModels";
import { ProjectContext, toRelativePath } from "../server/projectResolver";
import { symbolKindName } from "../tools/abstractTool";

/**
 * Resolves `Type.Member` queries when workspace-symbol search returns nothing — typically because
 * `Member` is inherited from a base class. Mirrors handlers/QualifiedMemberResolver.kt.
 *
 * Strategy:
 *   1. Split the query at the last `.` into requestedType / requestedMember.
 *   2. Find the type via workspace-symbol search; gather its supertype chain via the LSP type
 *      hierarchy.
 *   3. Search for the member alone; keep candidates whose containerName matches the type or any
 *      reachable supertype.
 *   4. Return the closest match — direct on Type, else nearest base — annotated with ResolvedFrom.
 *
 * Known structural risks (unimplemented by design, but here's where the next maintainer adds them
 * if Roslyn LSP starts misbehaving):
 *
 *   - `containerName` null/empty → candidate dropped silently (see `if (!container) continue` in
 *     resolveInheritedMember). The Kotlin sibling falls back to `virtualFile.nameWithoutExtension`
 *     (Unity one-class-per-file convention). If C# Dev Kit ever returns workspace symbols without
 *     `containerName`, add the same filename-basename fallback here using `sym.location.uri`.
 *
 *   - `prepareTypeHierarchy` returns empty → `ancestorNames` collapses to `[shortType]` only and
 *     no inherited member can match. Kotlin sibling falls back to textually scanning the type's
 *     containing file for `class Name : Base1, Base2`. If this gap surfaces (early C# Dev Kit
 *     load, language servers without type hierarchy), port the textual scan from
 *     QualifiedMemberResolver.kt#addTextualSupertypes / parseDeclaredBases.
 */

const CLASS_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
]);

const SUPERTYPE_WALK_LIMIT = 32;

export interface QualifiedParts {
  type: string;
  member: string;
}

export function parseQualifiedQuery(query: string): QualifiedParts | null {
  const dot = query.lastIndexOf(".");
  if (dot <= 0 || dot >= query.length - 1) return null;
  const type = query.slice(0, dot).trim();
  const member = query.slice(dot + 1).trim();
  if (!type || !member) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(type)) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(member)) return null;
  return { type, member };
}

export interface InheritedResolution {
  symbolMatch: SymbolMatch;
  resolvedFrom: ResolvedFrom;
}

/**
 * Try to resolve [query] as Type.Member through the inheritance chain. Returns null when the type
 * can't be found, when no supertype is available, or when the member isn't declared on Type or any
 * supertype.
 */
export async function resolveInheritedMember(
  project: ProjectContext,
  query: string,
): Promise<InheritedResolution | null> {
  const parts = parseQualifiedQuery(query);
  if (!parts) return null;
  const { type: typeName, member: memberName } = parts;
  const shortType = typeName.includes(".") ? typeName.slice(typeName.lastIndexOf(".") + 1) : typeName;

  const typeSymbols = (await executeWorkspaceSymbols(shortType)).filter(
    (s) =>
      CLASS_KINDS.has(s.kind) &&
      s.name === shortType &&
      s.location.uri.fsPath.startsWith(project.rootPath),
  );
  const typeSymbol = typeSymbols[0];
  if (!typeSymbol) return null;

  const ancestorNames = await collectAncestorNames(typeSymbol);
  if (ancestorNames.length === 0) return null;

  const memberSymbols = (await executeWorkspaceSymbols(memberName)).filter(
    (s) =>
      s.name === memberName &&
      s.location.uri.fsPath.startsWith(project.rootPath),
  );

  type Candidate = { symbol: vscode.SymbolInformation; depth: number };
  const matches: Candidate[] = [];
  for (const sym of memberSymbols) {
    const container = sym.containerName;
    if (!container) continue;
    const containerSimple = container.includes(".")
      ? container.slice(container.lastIndexOf(".") + 1)
      : container;
    const depth = ancestorNames.indexOf(containerSimple);
    if (depth < 0) continue;
    matches.push({ symbol: sym, depth });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.depth - b.depth);
  const best = matches[0];

  const declaringSimple = best.symbol.containerName.includes(".")
    ? best.symbol.containerName.slice(best.symbol.containerName.lastIndexOf(".") + 1)
    : best.symbol.containerName;

  const resolvedFrom: ResolvedFrom = {
    requestedType: typeName,
    requestedMember: memberName,
    declaringType: declaringSimple,
    kind: best.depth === 0 ? "DIRECT" : "BASE_CLASS_FALLBACK",
  };

  const symbolMatch: SymbolMatch = {
    name: best.symbol.name,
    qualifiedName: `${best.symbol.containerName}.${best.symbol.name}`,
    kind: symbolKindName(best.symbol.kind),
    file: toRelativePath(project, best.symbol.location.uri.fsPath),
    line: best.symbol.location.range.start.line + 1,
    column: best.symbol.location.range.start.character + 1,
    containerName: declaringSimple,
    resolvedFrom,
  };

  return { symbolMatch, resolvedFrom };
}

export interface OverrideMember {
  typeName: string;
  uri: vscode.Uri;
  position: vscode.Position;
}

/**
 * Given a base member (e.g. Item.UniqueID at file/line/column), find same-named members declared
 * on subtypes (Product.UniqueID, etc.) so callers can run executeReferenceProvider on each.
 * Mirrors handlers/QualifiedMemberResolver.kt#findOverrideMembers.
 */
export async function findOverrideMembers(
  project: ProjectContext,
  baseUri: vscode.Uri,
  basePosition: vscode.Position,
  memberName: string,
  limit = 64,
): Promise<OverrideMember[]> {
  const items = await prepareTypeHierarchy(baseUri, basePosition);
  if (items.length === 0) return [];

  const seenTypes = new Set<string>();
  const subtypes: vscode.TypeHierarchyItem[] = [];
  const queue: vscode.TypeHierarchyItem[] = [...items];
  while (queue.length > 0 && subtypes.length < limit) {
    const current = queue.shift()!;
    let children: vscode.TypeHierarchyItem[] = [];
    try {
      children = await typeHierarchySubtypes(current);
    } catch {
      continue;
    }
    for (const child of children) {
      const key = `${child.uri.toString()}#${child.name}`;
      if (seenTypes.has(key)) continue;
      seenTypes.add(key);
      if (!child.uri.fsPath.startsWith(project.rootPath)) continue;
      subtypes.push(child);
      queue.push(child);
      if (subtypes.length >= limit) break;
    }
  }

  const overrides: OverrideMember[] = [];
  for (const subtype of subtypes) {
    try {
      const doc = await vscode.workspace.openTextDocument(subtype.uri);
      const symbols = await executeDocumentSymbols(subtype.uri);
      const match = findMemberInSymbols(symbols, memberName, subtype.range);
      if (match) {
        overrides.push({
          typeName: subtype.name,
          uri: subtype.uri,
          position: match.start,
        });
        continue;
      }
      // Fallback: scan the type's declaration range for the identifier so we still report the
      // override even when document symbols are sparse.
      const fallback = findIdentifierInRange(doc, subtype.range, memberName);
      if (fallback) {
        overrides.push({ typeName: subtype.name, uri: subtype.uri, position: fallback });
      }
    } catch {
      // skip
    }
  }
  return overrides;
}

function findMemberInSymbols(
  symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[],
  memberName: string,
  containerRange: vscode.Range,
): vscode.Range | null {
  if (symbols.length === 0) return null;
  if ("range" in symbols[0]) {
    const docSymbols = symbols as vscode.DocumentSymbol[];
    for (const top of docSymbols) {
      if (!top.range.contains(containerRange.start) && !containerRange.contains(top.range.start)) continue;
      for (const child of top.children) {
        if (child.name === memberName) return child.selectionRange;
      }
    }
  } else {
    const infos = symbols as vscode.SymbolInformation[];
    for (const info of infos) {
      if (info.name === memberName && containerRange.contains(info.location.range.start)) {
        return info.location.range;
      }
    }
  }
  return null;
}

function findIdentifierInRange(
  doc: vscode.TextDocument,
  range: vscode.Range,
  identifier: string,
): vscode.Position | null {
  const pattern = new RegExp(`\\b${identifier}\\b`);
  for (let line = range.start.line; line <= range.end.line && line < doc.lineCount; line++) {
    const text = doc.lineAt(line).text;
    const m = pattern.exec(text);
    if (m) return new vscode.Position(line, m.index);
  }
  return null;
}

async function collectAncestorNames(
  typeSymbol: vscode.SymbolInformation,
): Promise<string[]> {
  const ordered: string[] = [typeSymbol.name];
  const seen = new Set<string>([typeSymbol.name]);

  let items: vscode.TypeHierarchyItem[] = [];
  try {
    items = await prepareTypeHierarchy(
      typeSymbol.location.uri,
      typeSymbol.location.range.start,
    );
  } catch {
    return ordered;
  }
  if (items.length === 0) return ordered;

  const queue: vscode.TypeHierarchyItem[] = [...items];
  while (queue.length > 0 && ordered.length <= SUPERTYPE_WALK_LIMIT) {
    const current = queue.shift()!;
    let supers: vscode.TypeHierarchyItem[] = [];
    try {
      supers = await typeHierarchySupertypes(current);
    } catch {
      continue;
    }
    for (const sup of supers) {
      const simple = sup.name.includes(".")
        ? sup.name.slice(sup.name.lastIndexOf(".") + 1)
        : sup.name;
      if (seen.has(simple)) continue;
      seen.add(simple);
      ordered.push(simple);
      queue.push(sup);
      if (ordered.length > SUPERTYPE_WALK_LIMIT) break;
    }
  }
  return ordered;
}
