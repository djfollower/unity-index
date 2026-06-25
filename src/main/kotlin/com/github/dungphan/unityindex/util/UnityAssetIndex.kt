package com.github.dungphan.unityindex.util

import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileVisitor
import com.intellij.psi.PsiManager
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

@Serializable
data class AssetReferenceResult(
    val asset: AssetReferenceTarget,
    val references: List<AssetReference>,
    val totalCount: Int,
    val truncated: Boolean
)

@Serializable
data class AssetReferenceTarget(
    val path: String?,
    val guid: String
)

@Serializable
data class AssetReference(
    val assetFile: String,
    val line: Int,
    val column: Int,
    /** Best-effort enclosing YAML key (e.g. "m_Sprite"). */
    val fieldHint: String?,
    /** Parsed from `fileID: N` on the same line, when present. */
    val fileID: Long?,
    val context: String,
    /**
     * `true` when the hit sits inside a MonoBehaviour doc whose script class
     * no longer declares a serialized field named [fieldHint] — i.e. a dangling
     * YAML reference left behind after the field was removed from the script.
     * `null` when no determination could be made (not under a MonoBehaviour,
     * no field hint, m_Script unresolved, or class not found in the index).
     */
    val shadowed: Boolean? = null
)

class UnityAssetIndex private constructor(
    private val project: Project,
    private val guidResolver: UnityGuidResolver,
    private val projectDir: VirtualFile,
    private val basePath: String
) {
    companion object {
        private val LOG = logger<UnityAssetIndex>()
        private val ASSET_EXTENSIONS = setOf("prefab", "unity", "asset")
        private val MB_HEADER_REGEX = Regex("""^---\s+!u!(\d+)\s+&(\d+)""")
        private val M_SCRIPT_GUID_REGEX = Regex("""m_Script:\s*\{[^}]*guid:\s*([0-9a-fA-F]{32})""")

        /**
         * YAML keys that live on every MonoBehaviour regardless of the user
         * script. They never indicate a shadowed user-field, so we ignore
         * them when classifying refs.
         */
        private val MONOBEHAVIOUR_BUILTIN_KEYS = setOf(
            "m_ObjectHideFlags",
            "m_CorrespondingSourceObject",
            "m_PrefabInstance",
            "m_PrefabAsset",
            "m_GameObject",
            "m_Enabled",
            "m_EditorHideFlags",
            "m_Script",
            "m_Name",
            "m_EditorClassIdentifier"
        )

        fun create(project: Project): UnityAssetIndex? {
            val basePath = project.basePath ?: return null
            val projectDir = LocalFileSystem.getInstance().findFileByPath(basePath) ?: return null
            val guidResolver = UnityGuidResolver(projectDir)
            return UnityAssetIndex(project, guidResolver, projectDir, basePath)
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

    /**
     * Mirror of the TS UnityAssetIndex.findAssetReferences. Iterates asset
     * files, applies a substring fast-path on the GUID, and pulls light
     * context (enclosing field key + fileID on the same line) without a full
     * YAML parse. Use for "which assets reference X" questions; the GUID is
     * unique so false positives are essentially zero.
     */
    fun findAssetReferences(guid: String, maxResults: Int): AssetReferenceResult {
        val ownPath = guidResolver.getPathForGuid(guid)
        val references = mutableListOf<AssetReference>()
        var truncated = false
        val detector = ShadowedFieldDetector(project, guidResolver)

        forEachAssetFile { file ->
            if (truncated) return@forEachAssetFile
            if (ownPath != null && file.path == ownPath) return@forEachAssetFile
            val content = try {
                String(file.contentsToByteArray(), Charsets.UTF_8)
            } catch (_: Exception) {
                return@forEachAssetFile
            }
            if (!content.contains(guid)) return@forEachAssetFile

            val lines = content.split('\n')
            val monoBehaviourRanges = collectMonoBehaviourRanges(lines)
            for ((i, raw) in lines.withIndex()) {
                val line = raw.trimEnd('\r')
                val col = line.indexOf(guid)
                if (col < 0) continue
                val fieldHint = enclosingKey(lines, i)
                val shadowed = classifyShadowed(detector, monoBehaviourRanges, i, fieldHint)
                references.add(
                    AssetReference(
                        assetFile = relativePath(file.path),
                        line = i + 1,
                        column = col + 1,
                        fieldHint = fieldHint,
                        fileID = parseFileIDOnLine(line),
                        context = line.trim(),
                        shadowed = shadowed
                    )
                )
                if (references.size >= maxResults) {
                    truncated = true
                    break
                }
            }
        }

        return AssetReferenceResult(
            asset = AssetReferenceTarget(
                path = ownPath?.let { relativePath(it) },
                guid = guid
            ),
            references = references,
            totalCount = references.size,
            truncated = truncated
        )
    }

    /**
     * Build line ranges for each MonoBehaviour (classId 114) document in the
     * file, capturing each doc's m_Script GUID. Used to attribute a GUID hit
     * to the user script whose field owns it, so we can decide if the field
     * still exists on the class.
     */
    private fun collectMonoBehaviourRanges(lines: List<String>): List<MonoBehaviourRange> {
        val ranges = mutableListOf<MonoBehaviourRange>()
        var currentStart = -1
        var currentIsMb = false
        var currentScriptGuid: String? = null

        fun close(endExclusive: Int) {
            if (currentStart >= 0 && currentIsMb) {
                ranges.add(MonoBehaviourRange(currentStart, endExclusive, currentScriptGuid))
            }
        }

        for ((i, raw) in lines.withIndex()) {
            val line = raw.trimEnd('\r')
            val header = MB_HEADER_REGEX.matchEntire(line)
            if (header != null) {
                close(i)
                currentStart = i
                currentIsMb = header.groupValues[1] == "114"
                currentScriptGuid = null
                continue
            }
            if (currentIsMb && currentScriptGuid == null) {
                val m = M_SCRIPT_GUID_REGEX.find(line)
                if (m != null) currentScriptGuid = m.groupValues[1].lowercase()
            }
        }
        close(lines.size)
        return ranges
    }

    private fun classifyShadowed(
        detector: ShadowedFieldDetector,
        ranges: List<MonoBehaviourRange>,
        lineIdx: Int,
        fieldHint: String?
    ): Boolean? {
        if (fieldHint == null) return null
        if (fieldHint in MONOBEHAVIOUR_BUILTIN_KEYS) return null
        val range = ranges.firstOrNull { lineIdx in it.startLine until it.endLineExclusive } ?: return null
        val scriptGuid = range.scriptGuid ?: return null
        return detector.isShadowed(scriptGuid, fieldHint)
    }

    private data class MonoBehaviourRange(
        val startLine: Int,
        val endLineExclusive: Int,
        val scriptGuid: String?
    )

    private fun enclosingKey(lines: List<String>, lineIdx: Int): String? {
        val guidLine = lines[lineIdx]
        val guidIndent = guidLine.length - guidLine.trimStart().length
        val keyRe = Regex("""^(\s*)([A-Za-z_]\w*):\s*(.*)$""")
        val start = lineIdx - 1
        val end = maxOf(0, lineIdx - 200)
        for (i in start downTo end) {
            val m = keyRe.matchEntire(lines[i].trimEnd('\r')) ?: continue
            val indent = m.groupValues[1].length
            if (indent >= guidIndent) continue
            if (m.groupValues[2] == "m_Script" && m.groupValues[3].isNotEmpty()) continue
            return m.groupValues[2]
        }
        return null
    }

    private fun parseFileIDOnLine(line: String): Long? {
        val m = Regex("""fileID:\s*(-?\d+)""").find(line) ?: return null
        return m.groupValues[1].toLongOrNull()
    }

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

/**
 * Decides whether a `<scriptGuid, fieldName>` pair corresponds to a serialized
 * field that still exists on the script's class. Backed by the IDE Structure
 * View, so it reflects whatever Roslyn / the C# language plugin sees — never
 * a text scan of the .cs source.
 *
 * Returns:
 * - `true` — class resolved AND `fieldName` is NOT among its serialized members.
 * - `false` — class resolved AND `fieldName` IS among them.
 * - `null` — class couldn't be resolved (no .meta, file gone, no structure
 *   view, etc.). Callers should treat this as "unknown, don't flag."
 *
 * Per-call cache keeps the structure-view walk to one read per script.
 */
internal class ShadowedFieldDetector(
    private val project: Project,
    private val guidResolver: UnityGuidResolver
) {
    private val cache = mutableMapOf<String, Set<String>?>()

    fun isShadowed(scriptGuid: String, fieldName: String): Boolean? {
        val fields = fieldsFor(scriptGuid) ?: return null
        return fieldName !in fields
    }

    private fun fieldsFor(scriptGuid: String): Set<String>? {
        if (cache.containsKey(scriptGuid)) return cache[scriptGuid]
        val resolved = resolve(scriptGuid)
        cache[scriptGuid] = resolved
        return resolved
    }

    private fun resolve(scriptGuid: String): Set<String>? {
        val scriptPath = guidResolver.getPathForGuid(scriptGuid) ?: return null
        if (!scriptPath.endsWith(".cs")) return null
        val virtualFile = LocalFileSystem.getInstance().findFileByPath(scriptPath) ?: return null

        return try {
            ReadAction.compute<Set<String>?, RuntimeException> {
                val psiFile = PsiManager.getInstance(project).findFile(virtualFile) ?: return@compute null
                val nodes = IdeStructureViewExtractor.extract(psiFile, project, fieldClassifier())
                val names = mutableSetOf<String>()
                collectMemberNames(nodes, names)
                names
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun collectMemberNames(
        nodes: List<com.github.dungphan.unityindex.tools.models.StructureNode>,
        out: MutableSet<String>
    ) {
        for (node in nodes) {
            when (node.kind) {
                com.github.dungphan.unityindex.tools.models.StructureKind.FIELD,
                com.github.dungphan.unityindex.tools.models.StructureKind.PROPERTY,
                com.github.dungphan.unityindex.tools.models.StructureKind.CONSTANT -> out.add(node.name)
                else -> {}
            }
            if (node.children.isNotEmpty()) collectMemberNames(node.children, out)
        }
    }

    /**
     * Generic classifier — we only need the kind + name. Matches the heuristic
     * used by [com.github.dungphan.unityindex.tools.navigation.FileStructureTool].
     */
    private fun fieldClassifier(): IdeStructureViewExtractor.Classifier {
        return IdeStructureViewExtractor.Classifier { value, presentation ->
            val rawName = presentation.presentableText ?: return@Classifier null
            val name = rawName.substringBefore(':').substringBefore('(').trim()
            if (name.isEmpty()) return@Classifier null
            val className = value?.javaClass?.simpleName?.lowercase() ?: ""
            val kind = when {
                className.contains("field") -> com.github.dungphan.unityindex.tools.models.StructureKind.FIELD
                className.contains("property") -> com.github.dungphan.unityindex.tools.models.StructureKind.PROPERTY
                className.contains("constant") -> com.github.dungphan.unityindex.tools.models.StructureKind.CONSTANT
                className.contains("method") || className.contains("function") -> com.github.dungphan.unityindex.tools.models.StructureKind.METHOD
                className.contains("interface") -> com.github.dungphan.unityindex.tools.models.StructureKind.INTERFACE
                className.contains("enum") -> com.github.dungphan.unityindex.tools.models.StructureKind.ENUM
                className.contains("class") -> com.github.dungphan.unityindex.tools.models.StructureKind.CLASS
                className.contains("namespace") -> com.github.dungphan.unityindex.tools.models.StructureKind.NAMESPACE
                else -> com.github.dungphan.unityindex.tools.models.StructureKind.UNKNOWN
            }
            IdeStructureViewExtractor.StructureElementInfo(name = name, kind = kind)
        }
    }
}
