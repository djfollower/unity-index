// URI builders for graph node IDs. Mirrors
// `src/main/kotlin/com/github/dungphan/unityindex/util/GraphIds.kt`.
// The `unity://<kind>/<key>` shape is the contract from docs/graph-schema.md §1.

export function scriptId(workspaceRelativePath: string): string {
  const trimmed = workspaceRelativePath.replace(/^\/+/, "");
  return `unity://script/${trimmed}`;
}

export function prefabId(guid: string): string {
  return `unity://prefab/${guid}`;
}

export function sceneId(guid: string): string {
  return `unity://scene/${guid}`;
}

export function soId(guid: string): string {
  return `unity://so/${guid}`;
}

export function assetId(guid: string): string {
  return `unity://asset/${guid}`;
}

export function componentInstanceId(ownerGuid: string, fileId: number): string {
  return `unity://component/${ownerGuid}/${fileId}`;
}

/**
 * Day 2 dangling target — Day 8's code-edges harvest will fill in the
 * `csharp` nodes. Namespace inference is deferred; we synthesize on the
 * filename-derived class name per schema §1.3.
 */
export function csharpClassId(className: string): string {
  return `unity://csharp/T:${className}`;
}
