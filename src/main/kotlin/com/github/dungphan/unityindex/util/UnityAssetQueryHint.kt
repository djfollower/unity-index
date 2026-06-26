package com.github.dungphan.unityindex.util

/**
 * Detects symbol/class queries that look like Unity asset filenames
 * (e.g. "Coin.asset", "Player.prefab") so callers can be steered to
 * `unity_find_asset_references` instead of receiving an empty result.
 */
object UnityAssetQueryHint {
    private val UNITY_ASSET_EXTENSIONS = setOf(
        "asset", "prefab", "unity", "mat", "anim", "controller", "overridecontroller",
        "fbx", "obj", "blend",
        "png", "jpg", "jpeg", "tga", "psd", "bmp", "tif", "tiff", "exr", "hdr",
        "shader", "shadergraph", "compute", "raytrace",
        "physicmaterial", "physicsmaterial2d",
        "rendertexture", "cubemap",
        "mixer", "playable", "mask", "preset", "lighting", "terrainlayer",
        "spriteatlas", "spriteatlasv2", "guiskin", "fontsettings", "ttf", "otf",
        "wav", "mp3", "ogg", "aif", "aiff",
        "mp4", "mov", "webm"
    )

    fun extensionOf(query: String): String? {
        val trimmed = query.trim()
        val dot = trimmed.lastIndexOf('.')
        if (dot <= 0 || dot == trimmed.length - 1) return null
        val ext = trimmed.substring(dot + 1).lowercase()
        return ext.takeIf { it in UNITY_ASSET_EXTENSIONS }
    }

    fun looksLikeAssetFile(query: String): Boolean = extensionOf(query) != null

    fun forEmptyResult(query: String): String? {
        val ext = extensionOf(query) ?: return null
        return "Query \"$query\" looks like a Unity asset filename (.$ext), not a code symbol. " +
            "Asset files are not indexed as symbols. To find which prefabs/scenes/assets reference it, " +
            "use unity_find_asset_references with `assetPath` (or its GUID)."
    }
}
