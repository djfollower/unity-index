package com.github.dungphan.unityindex.util

/**
 * URI builders for graph node IDs. Mirrors `vscode-extension/src/utils/graphIds.ts`.
 * The `unity://<kind>/<key>` shape is the contract from `docs/graph-schema.md` §1.
 */
object GraphIds {
    fun scriptId(workspaceRelativePath: String): String =
        "unity://script/${workspaceRelativePath.removePrefix("/")}"

    fun prefabId(guid: String): String = "unity://prefab/$guid"

    fun sceneId(guid: String): String = "unity://scene/$guid"

    fun soId(guid: String): String = "unity://so/$guid"

    fun assetId(guid: String): String = "unity://asset/$guid"

    fun componentInstanceId(ownerGuid: String, fileId: Long): String =
        "unity://component/$ownerGuid/$fileId"

    /**
     * Day 2 dangling target — Day 8's code-edges harvest will fill in the
     * `csharp` nodes. Namespace inference is deferred; we synthesize on the
     * filename-derived class name per schema §1.3.
     */
    fun csharpClassId(className: String): String = "unity://csharp/T:$className"
}
