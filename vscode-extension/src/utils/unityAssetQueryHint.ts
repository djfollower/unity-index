// Mirrors src/main/kotlin/.../util/UnityAssetQueryHint.kt — keep the
// extension set and message in sync between the two implementations.

const UNITY_ASSET_EXTENSIONS = new Set<string>([
  "asset", "prefab", "unity", "mat", "anim", "controller", "overridecontroller",
  "fbx", "obj", "blend",
  "png", "jpg", "jpeg", "tga", "psd", "bmp", "tif", "tiff", "exr", "hdr",
  "shader", "shadergraph", "compute", "raytrace",
  "physicmaterial", "physicsmaterial2d",
  "rendertexture", "cubemap",
  "mixer", "playable", "mask", "preset", "lighting", "terrainlayer",
  "spriteatlas", "spriteatlasv2", "guiskin", "fontsettings", "ttf", "otf",
  "wav", "mp3", "ogg", "aif", "aiff",
  "mp4", "mov", "webm",
]);

export function unityAssetExtensionOf(query: string): string | null {
  const trimmed = query.trim();
  const dot = trimmed.lastIndexOf(".");
  if (dot <= 0 || dot === trimmed.length - 1) return null;
  const ext = trimmed.substring(dot + 1).toLowerCase();
  return UNITY_ASSET_EXTENSIONS.has(ext) ? ext : null;
}

export function looksLikeUnityAssetFile(query: string): boolean {
  return unityAssetExtensionOf(query) !== null;
}

export function unityAssetHintForEmptyResult(query: string): string | undefined {
  const ext = unityAssetExtensionOf(query);
  if (!ext) return undefined;
  return (
    `Query "${query}" looks like a Unity asset filename (.${ext}), not a code symbol. ` +
    `Asset files are not indexed as symbols. To find which prefabs/scenes/assets reference it, ` +
    `use unity_find_asset_references with \`assetPath\` (or its GUID).`
  );
}
