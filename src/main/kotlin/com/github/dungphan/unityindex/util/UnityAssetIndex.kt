package com.github.dungphan.unityindex.util

import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileVisitor
import kotlinx.serialization.Serializable

@Serializable
data class ComponentUsageResult(
    val typeName: String,
    val scriptGuid: String?,
    val usages: List<ComponentUsage>,
    val totalCount: Int
)

@Serializable
data class ComponentUsage(
    val assetFile: String,
    val gameObjectName: String?,
    val gameObjectFileId: Long?,
    val fileId: Long
)

@Serializable
data class EventBindingResult(
    val methodName: String,
    val bindings: List<EventBinding>,
    val totalCount: Int
)

@Serializable
data class EventBinding(
    val assetFile: String,
    val eventFieldPath: String,
    val targetTypeName: String?,
    val methodName: String,
    val gameObjectName: String?,
    val callState: Int
)

@Serializable
data class SerializedFieldResult(
    val typeName: String,
    val fieldName: String,
    val scriptGuid: String?,
    val values: List<SerializedFieldValue>,
    val totalCount: Int
)

@Serializable
data class SerializedFieldValue(
    val assetFile: String,
    val gameObjectName: String?,
    val value: String,
    val fileId: Long
)

class UnityAssetIndex private constructor(
    private val guidResolver: UnityGuidResolver,
    private val projectDir: VirtualFile,
    private val basePath: String
) {
    companion object {
        private val LOG = logger<UnityAssetIndex>()
        private val ASSET_EXTENSIONS = setOf("prefab", "unity", "asset")

        fun create(project: Project): UnityAssetIndex? {
            val basePath = project.basePath ?: return null
            val projectDir = LocalFileSystem.getInstance().findFileByPath(basePath) ?: return null
            val guidResolver = UnityGuidResolver(projectDir)
            return UnityAssetIndex(guidResolver, projectDir, basePath)
        }
    }

    fun findComponentUsages(typeName: String): ComponentUsageResult {
        val scriptGuid = findScriptGuid(typeName)
            ?: return ComponentUsageResult(typeName, null, emptyList(), 0)

        val usages = mutableListOf<ComponentUsage>()

        forEachAssetFile { file ->
            val documents = UnityYamlParser.parse(file)
            val gameObjects = documents.filter { it.classId == 1 }
                .associateBy { it.fileId }

            for (doc in documents) {
                if (doc.classId != 114) continue
                val docGuid = doc.getScriptGuid() ?: continue
                if (docGuid != scriptGuid) continue

                val goFileId = doc.getGameObjectFileId()
                val goName = goFileId?.let { id ->
                    gameObjects[id]?.getProperty("m_Name")
                }

                usages.add(ComponentUsage(
                    assetFile = relativePath(file.path),
                    gameObjectName = goName,
                    gameObjectFileId = goFileId,
                    fileId = doc.fileId
                ))
            }
        }

        return ComponentUsageResult(typeName, scriptGuid, usages, usages.size)
    }

    fun findEventBindings(methodName: String): EventBindingResult {
        val bindings = mutableListOf<EventBinding>()

        forEachAssetFile { file ->
            val documents = UnityYamlParser.parse(file)
            val gameObjects = documents.filter { it.classId == 1 }
                .associateBy { it.fileId }

            for (doc in documents) {
                if (doc.classId != 114) continue
                val calls = doc.getPersistentCalls()

                for (call in calls) {
                    if (call.methodName != methodName) continue

                    val goFileId = doc.getGameObjectFileId()
                    val goName = goFileId?.let { id ->
                        gameObjects[id]?.getProperty("m_Name")
                    }

                    val eventField = findEventFieldName(doc, call.methodName)

                    bindings.add(EventBinding(
                        assetFile = relativePath(file.path),
                        eventFieldPath = eventField ?: "unknown",
                        targetTypeName = call.targetAssemblyTypeName?.substringBefore(",")?.trim(),
                        methodName = call.methodName,
                        gameObjectName = goName,
                        callState = call.callState
                    ))
                }
            }
        }

        return EventBindingResult(methodName, bindings, bindings.size)
    }

    fun findSerializedFieldValues(typeName: String, fieldName: String): SerializedFieldResult {
        val scriptGuid = findScriptGuid(typeName)
            ?: return SerializedFieldResult(typeName, fieldName, null, emptyList(), 0)

        val values = mutableListOf<SerializedFieldValue>()

        forEachAssetFile { file ->
            val documents = UnityYamlParser.parse(file)
            val gameObjects = documents.filter { it.classId == 1 }
                .associateBy { it.fileId }

            for (doc in documents) {
                if (doc.classId != 114) continue
                val docGuid = doc.getScriptGuid() ?: continue
                if (docGuid != scriptGuid) continue

                val fieldValue = doc.getSerializedFieldValue(fieldName) ?: continue

                val goFileId = doc.getGameObjectFileId()
                val goName = goFileId?.let { id ->
                    gameObjects[id]?.getProperty("m_Name")
                }

                values.add(SerializedFieldValue(
                    assetFile = relativePath(file.path),
                    gameObjectName = goName,
                    value = fieldValue,
                    fileId = doc.fileId
                ))
            }
        }

        return SerializedFieldResult(typeName, fieldName, scriptGuid, values, values.size)
    }

    fun getGuidResolver(): UnityGuidResolver = guidResolver

    private fun findScriptGuid(typeName: String): String? {
        val allScripts = guidResolver.getAllScriptGuids()
        for ((guid, path) in allScripts) {
            val fileName = path.substringAfterLast("/").removeSuffix(".cs")
            if (fileName == typeName) return guid
        }
        for ((guid, path) in allScripts) {
            val fileName = path.substringAfterLast("/").removeSuffix(".cs")
            if (fileName.equals(typeName, ignoreCase = true)) return guid
        }
        return null
    }

    private fun findEventFieldName(doc: UnityYamlDocument, methodName: String): String? {
        for ((key, value) in doc.properties) {
            if (key.contains("m_PersistentCalls") && key.endsWith(".m_MethodName") && value == methodName) {
                val eventPath = key.substringBefore(".m_PersistentCalls")
                if (eventPath.isNotEmpty() && eventPath != key) return eventPath
            }
        }
        return null
    }

    private fun forEachAssetFile(action: (VirtualFile) -> Unit) {
        VfsUtilCore.visitChildrenRecursively(projectDir, object : VirtualFileVisitor<Unit>() {
            override fun visitFile(file: VirtualFile): Boolean {
                if (file.isDirectory) {
                    val name = file.name
                    if (name == "Library" || name == "Temp" || name == "Logs" || name == "obj") return false
                    return true
                }
                if (file.extension in ASSET_EXTENSIONS) {
                    try {
                        action(file)
                    } catch (e: Exception) {
                        LOG.warn("Failed to process asset file ${file.path}: ${e.message}")
                    }
                }
                return true
            }
        })
    }

    private fun relativePath(absolutePath: String): String {
        return absolutePath.removePrefix(basePath).removePrefix("/")
    }
}
