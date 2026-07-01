package com.github.dungphan.unityindex.util

import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileVisitor

class UnityGuidResolver(projectDir: VirtualFile) {

    private val guidToPath: Map<String, String>
    private val pathToGuid: Map<String, String>

    init {
        val guidMap = mutableMapOf<String, String>()
        val pathMap = mutableMapOf<String, String>()

        // Unity ingests only what lives under Assets/ (user content) and
        // Packages/ (embedded + UPM local packages). Walking the entire project
        // root would pick up Library/, Temp/, ProjectSettings/, Build/ etc.,
        // inflating the meta map with GUIDs Unity never resolves through.
        val roots = listOfNotNull(projectDir.findChild("Assets"), projectDir.findChild("Packages"))
        for (root in roots) {
            VfsUtilCore.visitChildrenRecursively(root, object : VirtualFileVisitor<Unit>() {
                override fun visitFile(file: VirtualFile): Boolean {
                    if (file.isDirectory) {
                        val name = file.name
                        if (name == "node_modules" || name == ".git") return false
                        return true
                    }
                    if (file.extension == "meta") {
                        parseMetaFile(file, guidMap, pathMap)
                    }
                    return true
                }
            })
        }

        guidToPath = guidMap
        pathToGuid = pathMap
    }

    fun getPathForGuid(guid: String): String? = guidToPath[guid]

    fun getGuidForPath(assetPath: String): String? = pathToGuid[assetPath]

    fun getScriptGuid(scriptPath: String): String? {
        return pathToGuid[scriptPath]
    }

    fun getAllScriptGuids(): Map<String, String> {
        return guidToPath.filterValues { it.endsWith(".cs") }
    }

    companion object {
        private val GUID_REGEX = Regex("""^guid:\s*([0-9a-fA-F]{32})\s*$""")

        private fun parseMetaFile(
            metaFile: VirtualFile,
            guidMap: MutableMap<String, String>,
            pathMap: MutableMap<String, String>
        ) {
            val assetPath = metaFile.path.removeSuffix(".meta")
            try {
                val bytes = metaFile.contentsToByteArray()
                val limit = minOf(bytes.size, 512)
                val header = String(bytes, 0, limit, Charsets.UTF_8)
                for (line in header.lineSequence()) {
                    val match = GUID_REGEX.matchEntire(line.trim())
                    if (match != null) {
                        val guid = match.groupValues[1]
                        guidMap[guid] = assetPath
                        pathMap[assetPath] = guid
                        break
                    }
                }
            } catch (_: Exception) {
            }
        }
    }
}
