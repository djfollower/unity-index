package com.github.dungphan.unityindex.util

import com.intellij.openapi.vfs.VirtualFile

data class UnityYamlDocument(
    val classId: Int,
    val fileId: Long,
    val typeName: String,
    val properties: Map<String, String>,
    val rawLines: List<String>,
    val sourceFile: String
) {
    fun getProperty(key: String): String? = properties[key]

    fun getNestedProperty(vararg keys: String): String? {
        if (keys.isEmpty()) return null
        if (keys.size == 1) return properties[keys[0]]
        val prefix = keys.dropLast(1).joinToString(".")
        val lastKey = keys.last()
        return properties["$prefix.$lastKey"]
    }

    fun getScriptGuid(): String? {
        return properties["m_Script.guid"]
    }

    fun getGameObjectFileId(): Long? {
        return properties["m_GameObject.fileID"]?.toLongOrNull()
    }

    fun getPersistentCalls(): List<PersistentCall> {
        val calls = mutableListOf<PersistentCall>()
        var i = 0
        while (true) {
            val methodName = properties["m_PersistentCalls.m_Calls[$i].m_MethodName"] ?: break
            calls.add(PersistentCall(
                targetFileId = properties["m_PersistentCalls.m_Calls[$i].m_Target.fileID"]?.toLongOrNull(),
                targetGuid = properties["m_PersistentCalls.m_Calls[$i].m_Target.guid"],
                targetAssemblyTypeName = properties["m_PersistentCalls.m_Calls[$i].m_TargetAssemblyTypeName"],
                methodName = methodName,
                mode = properties["m_PersistentCalls.m_Calls[$i].m_Mode"]?.toIntOrNull() ?: 0,
                callState = properties["m_PersistentCalls.m_Calls[$i].m_CallState"]?.toIntOrNull() ?: 0
            ))
            i++
        }
        return calls
    }

    fun getSerializedFieldValue(fieldName: String): String? {
        return properties[fieldName]
    }

    fun getCustomFields(): Map<String, String> {
        val builtinPrefixes = setOf(
            "m_ObjectHideFlags", "m_CorrespondingSourceObject", "m_PrefabInstance",
            "m_PrefabAsset", "m_GameObject", "m_Enabled", "m_EditorHideFlags",
            "m_Script", "m_Name", "m_EditorClassIdentifier"
        )
        return properties.filterKeys { key ->
            builtinPrefixes.none { prefix -> key == prefix || key.startsWith("$prefix.") }
        }
    }
}

data class PersistentCall(
    val targetFileId: Long?,
    val targetGuid: String?,
    val targetAssemblyTypeName: String?,
    val methodName: String,
    val mode: Int,
    val callState: Int
)

object UnityYamlParser {

    private val DOCUMENT_HEADER = Regex("""^---\s+!u!(\d+)\s+&(\d+)""")
    private val INLINE_MAP = Regex("""\{([^}]*)}""")
    private val KEY_VALUE = Regex("""^(\s*)(\S+?):\s*(.*)$""")

    private val CLASS_ID_NAMES = mapOf(
        1 to "GameObject",
        4 to "Transform",
        114 to "MonoBehaviour",
        224 to "RectTransform",
        1001 to "PrefabInstance"
    )

    fun parse(file: VirtualFile): List<UnityYamlDocument> {
        val content = try {
            String(file.contentsToByteArray(), Charsets.UTF_8)
        } catch (_: Exception) {
            return emptyList()
        }
        return parse(content, file.path)
    }

    fun parse(content: String, sourcePath: String): List<UnityYamlDocument> {
        val documents = mutableListOf<UnityYamlDocument>()
        val lines = content.lines()

        var currentClassId = -1
        var currentFileId = -1L
        var currentLines = mutableListOf<String>()
        var inDocument = false

        for (line in lines) {
            val headerMatch = DOCUMENT_HEADER.matchEntire(line)
            if (headerMatch != null) {
                if (inDocument) {
                    parseDocument(currentClassId, currentFileId, currentLines, sourcePath)?.let {
                        documents.add(it)
                    }
                }
                currentClassId = headerMatch.groupValues[1].toInt()
                currentFileId = headerMatch.groupValues[2].toLong()
                currentLines = mutableListOf()
                inDocument = true
                continue
            }
            if (inDocument) {
                currentLines.add(line)
            }
        }

        if (inDocument) {
            parseDocument(currentClassId, currentFileId, currentLines, sourcePath)?.let {
                documents.add(it)
            }
        }

        return documents
    }

    fun parseMonoBehaviours(file: VirtualFile): List<UnityYamlDocument> {
        return parse(file).filter { it.classId == 114 }
    }

    fun parseGameObjects(file: VirtualFile): List<UnityYamlDocument> {
        return parse(file).filter { it.classId == 1 }
    }

    private fun parseDocument(
        classId: Int,
        fileId: Long,
        lines: List<String>,
        sourcePath: String
    ): UnityYamlDocument? {
        if (lines.isEmpty()) return null

        val typeName = lines.firstOrNull()?.trim()?.removeSuffix(":")
            ?: CLASS_ID_NAMES[classId]
            ?: "Unknown"

        val properties = mutableMapOf<String, String>()
        val pathStack = mutableListOf<Pair<String, Int>>()
        var arrayIndex = -1
        var lastArrayKey = ""

        for (line in lines.drop(1)) {
            if (line.isBlank()) continue

            val kvMatch = KEY_VALUE.matchEntire(line) ?: continue
            val indent = kvMatch.groupValues[1].length
            val key = kvMatch.groupValues[2]
            val rawValue = kvMatch.groupValues[3].trim()

            while (pathStack.isNotEmpty() && pathStack.last().second >= indent) {
                pathStack.removeAt(pathStack.size - 1)
            }

            if (key == "-") {
                arrayIndex++
                val inlineValue = rawValue
                if (inlineValue.isNotEmpty()) {
                    val flatKey = buildFlatKey(pathStack, "[$arrayIndex]")
                    parseInlineMap(inlineValue)?.forEach { (mk, mv) ->
                        properties["$flatKey.$mk"] = mv
                    } ?: run {
                        properties[flatKey] = inlineValue
                    }
                }
                continue
            }

            if (key.startsWith("- ")) {
                val actualKey = key.removePrefix("- ")
                arrayIndex++
                val flatKey = buildFlatKey(pathStack, "[$arrayIndex].$actualKey")
                properties[flatKey] = rawValue
                continue
            }

            if (rawValue.isEmpty()) {
                pathStack.add(key to indent)
                if (pathStack.size >= 2) {
                    val parentKey = pathStack.dropLast(1).lastOrNull()?.first ?: ""
                    if (parentKey == "m_Calls") {
                        arrayIndex = -1
                        lastArrayKey = key
                    }
                }
                continue
            }

            val flatKey = buildFlatKey(pathStack, key)

            val inlineMap = parseInlineMap(rawValue)
            if (inlineMap != null) {
                for ((mk, mv) in inlineMap) {
                    properties["$flatKey.$mk"] = mv
                }
            } else {
                properties[flatKey] = rawValue
            }
        }

        return UnityYamlDocument(
            classId = classId,
            fileId = fileId,
            typeName = typeName,
            properties = properties,
            rawLines = lines,
            sourceFile = sourcePath
        )
    }

    private fun buildFlatKey(pathStack: List<Pair<String, Int>>, suffix: String): String {
        val prefix = pathStack.joinToString(".") { it.first }
        return if (prefix.isEmpty()) suffix else "$prefix.$suffix"
    }

    private fun parseInlineMap(value: String): Map<String, String>? {
        val match = INLINE_MAP.find(value) ?: return null
        val inner = match.groupValues[1].trim()
        if (inner.isEmpty()) return emptyMap()

        val result = mutableMapOf<String, String>()
        for (pair in inner.split(",")) {
            val parts = pair.trim().split(":", limit = 2)
            if (parts.size == 2) {
                result[parts[0].trim()] = parts[1].trim()
            }
        }
        return result
    }
}
