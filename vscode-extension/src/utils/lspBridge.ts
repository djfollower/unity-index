import * as vscode from "vscode";

/**
 * Helpers around vscode.commands.executeCommand for LSP-bridging commands.
 * VS Code's built-in `vscode.executeXProvider` commands dispatch to the
 * language server that owns the file (C# Dev Kit / Roslyn for .cs).
 */

export type LocationLike = vscode.Location | vscode.LocationLink;

export function locationOf(item: LocationLike): vscode.Location {
  if ("targetUri" in item) {
    return new vscode.Location(item.targetUri, item.targetRange);
  }
  return item;
}

export async function executeReferences(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<vscode.Location[]> {
  const result = await vscode.commands.executeCommand<vscode.Location[]>(
    "vscode.executeReferenceProvider",
    uri,
    position,
  );
  return result ?? [];
}

export async function executeDefinition(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<vscode.Location[]> {
  const raw = await vscode.commands.executeCommand<LocationLike[]>(
    "vscode.executeDefinitionProvider",
    uri,
    position,
  );
  return (raw ?? []).map(locationOf);
}

export async function executeImplementation(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<vscode.Location[]> {
  const raw = await vscode.commands.executeCommand<LocationLike[]>(
    "vscode.executeImplementationProvider",
    uri,
    position,
  );
  return (raw ?? []).map(locationOf);
}

export async function executeWorkspaceSymbols(
  query: string,
): Promise<vscode.SymbolInformation[]> {
  const result = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    "vscode.executeWorkspaceSymbolProvider",
    query,
  );
  return result ?? [];
}

export async function executeDocumentSymbols(
  uri: vscode.Uri,
): Promise<vscode.DocumentSymbol[] | vscode.SymbolInformation[]> {
  const result = await vscode.commands.executeCommand<
    vscode.DocumentSymbol[] | vscode.SymbolInformation[]
  >("vscode.executeDocumentSymbolProvider", uri);
  return result ?? [];
}

export async function prepareTypeHierarchy(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<vscode.TypeHierarchyItem[]> {
  const result = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
    "vscode.prepareTypeHierarchy",
    uri,
    position,
  );
  return result ?? [];
}

export async function typeHierarchySupertypes(
  item: vscode.TypeHierarchyItem,
): Promise<vscode.TypeHierarchyItem[]> {
  const result = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
    "vscode.provideSupertypes",
    item,
  );
  return result ?? [];
}

export async function typeHierarchySubtypes(
  item: vscode.TypeHierarchyItem,
): Promise<vscode.TypeHierarchyItem[]> {
  const result = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
    "vscode.provideSubtypes",
    item,
  );
  return result ?? [];
}

export async function prepareCallHierarchy(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<vscode.CallHierarchyItem[]> {
  const result = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
    "vscode.prepareCallHierarchy",
    uri,
    position,
  );
  return result ?? [];
}

export async function callHierarchyIncoming(
  item: vscode.CallHierarchyItem,
): Promise<vscode.CallHierarchyIncomingCall[]> {
  const result = await vscode.commands.executeCommand<
    vscode.CallHierarchyIncomingCall[]
  >("vscode.provideIncomingCalls", item);
  return result ?? [];
}

export async function callHierarchyOutgoing(
  item: vscode.CallHierarchyItem,
): Promise<vscode.CallHierarchyOutgoingCall[]> {
  const result = await vscode.commands.executeCommand<
    vscode.CallHierarchyOutgoingCall[]
  >("vscode.provideOutgoingCalls", item);
  return result ?? [];
}
