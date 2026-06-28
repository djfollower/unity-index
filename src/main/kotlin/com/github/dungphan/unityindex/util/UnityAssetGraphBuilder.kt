package com.github.dungphan.unityindex.util

import com.github.dungphan.unityindex.tools.models.EdgeKind
import com.github.dungphan.unityindex.tools.models.GraphEdge
import com.github.dungphan.unityindex.tools.models.GraphNode
import com.github.dungphan.unityindex.tools.models.GraphPageRequest
import com.github.dungphan.unityindex.tools.models.GraphPageResponse
import com.github.dungphan.unityindex.tools.models.GraphSnapshot
import com.github.dungphan.unityindex.tools.models.GraphSnapshotRequest
import com.github.dungphan.unityindex.tools.models.GraphSnapshotResponse
import com.github.dungphan.unityindex.tools.models.GraphSourcePhase
import com.github.dungphan.unityindex.tools.models.GraphStats
import com.github.dungphan.unityindex.tools.models.GraphWarning
import com.github.dungphan.unityindex.tools.models.NodeKind
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileVisitor
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.Base64
import kotlin.math.min

/**
 * Builds a Day-2 `GraphSnapshot` from the on-disk Unity asset YAML.
 *
 * Reuses `UnityGuidResolver` (the .meta map) and `UnityYamlParser` (the asset
 * YAML parser). The directory walk is local — `UnityAssetIndex` keeps its
 * iterator private and the snapshot is a one-shot full sweep.
 *
 * Edge taxonomy follows `docs/graph-schema.md` §3.1 / §3.3:
 *   script_used_by_prefab, script_used_by_scene, scene_contains_prefab,
 *   prefab_variant_of, serialized_binding, script_declares_class.
 *
 * `component_instance` and `component_field` are never emitted as top-level
 * nodes; their counts go into `GraphStats.skipped_component_*`.
 */
object UnityAssetGraphBuilder {
    private val LOG = logger<UnityAssetGraphBuilder>()

    private val ASSET_EXTENSIONS = setOf(
        "prefab", "unity", "asset",
        "mat", "anim", "controller", "playable", "spriteatlas", "lighting",
        "shader", "physicMaterial", "physicsMaterial2D"
    )
    private val SKIP_DIRS = setOf("Library", "Temp", "Logs", "obj", "bin", "node_modules", ".git")

    private const val CLASS_ID_MONOBEHAVIOUR = 114
    private const val CLASS_ID_PREFAB_INSTANCE = 1001

    private val EMPTY_METADATA = JsonObject(emptyMap())

    /**
     * Public entry point. Synchronous + read-only — caller is responsible for
     * read-action wrapping if needed (we touch VFS, not PSI).
     */
    fun build(project: Project, request: GraphSnapshotRequest): GraphSnapshotResponse {
        val basePath = project.basePath
            ?: throw IllegalStateException("Cannot resolve project basePath")
        val projectDir = LocalFileSystem.getInstance().findFileByPath(basePath)
            ?: throw IllegalStateException("Project basePath not on disk: $basePath")
        val guidResolver = UnityGuidResolver(projectDir)

        val warnings = mutableListOf<GraphWarning>()

        // --- Pass 0: script nodes from .meta GUID map.
        val nodes = LinkedHashMap<String, GraphNode>()
        val guidToNodeId = HashMap<String, String>()
        val scriptIdByGuid = HashMap<String, String>()

        for ((guid, absPath) in guidResolver.getAllScriptGuids()) {
            val rel = relativize(absPath, basePath)
            val nodeId = GraphIds.scriptId(rel)
            val classNameFromFile = absPath.substringAfterLast('/').removeSuffix(".cs")
            val csharpId = GraphIds.csharpClassId(classNameFromFile)
            nodes[nodeId] = GraphNode(
                id = nodeId,
                kind = NodeKind.SCRIPT,
                label = "$classNameFromFile.cs",
                path = rel,
                guid = guid,
                metadata = buildJsonObject {
                    put("guid", JsonPrimitive(guid))
                    put("primary_class_id", JsonPrimitive(csharpId))
                }
            )
            guidToNodeId[guid] = nodeId
            scriptIdByGuid[guid] = nodeId
        }

        // --- Pass 1: scan asset files; emit asset-domain nodes; collect pending edges.
        val pending = mutableListOf<PendingEdge>()
        var skippedComponentInstances = 0
        var skippedComponentFields = 0
        val danglingCsharpEdges = mutableListOf<GraphEdge>()

        // Emit script_declares_class edges (Day 2: target nodes are dangling).
        for ((guid, absPath) in guidResolver.getAllScriptGuids()) {
            val rel = relativize(absPath, basePath)
            val sourceId = GraphIds.scriptId(rel)
            val className = absPath.substringAfterLast('/').removeSuffix(".cs")
            val targetId = GraphIds.csharpClassId(className)
            danglingCsharpEdges.add(
                GraphEdge(
                    source = sourceId,
                    target = targetId,
                    kind = EdgeKind.SCRIPT_DECLARES_CLASS,
                    metadata = EMPTY_METADATA
                )
            )
            // suppress unused warning
            @Suppress("UNUSED_VARIABLE") val _g = guid
        }

        VfsUtilCore.visitChildrenRecursively(projectDir, object : VirtualFileVisitor<Unit>() {
            override fun visitFile(file: VirtualFile): Boolean {
                if (file.isDirectory) return file.name !in SKIP_DIRS
                val ext = file.extension?.lowercase() ?: return true
                if (ext !in ASSET_EXTENSIONS) return true

                try {
                    val rel = relativize(file.path, basePath)
                    val ownerGuid = guidResolver.getGuidForPath(file.path) ?: return true
                    val docs = UnityYamlParser.parse(file)

                    // Decide node kind from file extension + YAML content.
                    val (nodeKind, isVariant) = classify(ext, docs)
                    val ownerId = when (nodeKind) {
                        NodeKind.PREFAB, NodeKind.PREFAB_VARIANT -> GraphIds.prefabId(ownerGuid)
                        NodeKind.SCENE -> GraphIds.sceneId(ownerGuid)
                        NodeKind.SO -> GraphIds.soId(ownerGuid)
                        else -> GraphIds.assetId(ownerGuid)
                    }
                    val label = file.nameWithoutExtension
                    val nodeMetadata = buildJsonObject {
                        put("guid", JsonPrimitive(ownerGuid))
                        if (nodeKind == NodeKind.ASSET) {
                            put("asset_type", JsonPrimitive(ext))
                        }
                    }
                    nodes[ownerId] = GraphNode(
                        id = ownerId,
                        kind = nodeKind,
                        label = label,
                        path = rel,
                        guid = ownerGuid,
                        metadata = nodeMetadata
                    )
                    guidToNodeId[ownerGuid] = ownerId

                    if (nodeKind == NodeKind.ASSET) return true

                    // Walk docs and harvest edges.
                    val scriptUsageAgg = HashMap<String, MutableList<String>>()

                    for (doc in docs) {
                        when (doc.classId) {
                            CLASS_ID_MONOBEHAVIOUR -> {
                                skippedComponentInstances += 1
                                val componentInstanceId = GraphIds.componentInstanceId(ownerGuid, doc.fileId)
                                val scriptGuid = doc.getScriptGuid()
                                if (scriptGuid != null && nodeKind != NodeKind.SO) {
                                    scriptUsageAgg.getOrPut(scriptGuid) { mutableListOf() }
                                        .add(componentInstanceId)
                                }
                                // Serialized bindings: any `*.guid` other than m_Script.guid.
                                for ((key, value) in doc.properties) {
                                    if (!key.endsWith(".guid")) continue
                                    if (key == "m_Script.guid") continue
                                    val targetGuid = normalizeGuid(value) ?: continue
                                    if (targetGuid == ownerGuid) continue
                                    val fieldName = key.removeSuffix(".guid")
                                        .substringBefore('[')
                                        .takeIf { it.isNotEmpty() } ?: continue
                                    skippedComponentFields += 1
                                    pending.add(
                                        PendingEdge.SerializedBinding(
                                            ownerId = ownerId,
                                            targetGuid = targetGuid,
                                            fieldName = fieldName,
                                            componentInstanceId = componentInstanceId
                                        )
                                    )
                                }
                            }
                            CLASS_ID_PREFAB_INSTANCE -> {
                                val sourceGuid = doc.getNestedProperty("m_SourcePrefab", "guid")
                                    ?.let { normalizeGuid(it) } ?: continue
                                when (nodeKind) {
                                    NodeKind.SCENE -> pending.add(
                                        PendingEdge.SceneContainsPrefab(ownerId, sourceGuid)
                                    )
                                    NodeKind.PREFAB, NodeKind.PREFAB_VARIANT -> {
                                        if (isVariant) {
                                            pending.add(PendingEdge.PrefabVariantOf(ownerId, sourceGuid))
                                        }
                                    }
                                    else -> {}
                                }
                            }
                        }
                    }

                    // Emit script_used_by_{prefab,scene} edges (one per (script, owner) pair).
                    for ((scriptGuid, componentIds) in scriptUsageAgg) {
                        val scriptNodeId = scriptIdByGuid[scriptGuid] ?: continue
                        val edgeKind = when (nodeKind) {
                            NodeKind.SCENE -> EdgeKind.SCRIPT_USED_BY_SCENE
                            NodeKind.PREFAB, NodeKind.PREFAB_VARIANT -> EdgeKind.SCRIPT_USED_BY_PREFAB
                            else -> continue
                        }
                        pending.add(
                            PendingEdge.ScriptUsage(
                                source = scriptNodeId,
                                target = ownerId,
                                kind = edgeKind,
                                componentInstanceIds = componentIds.toList()
                            )
                        )
                    }
                } catch (e: Exception) {
                    LOG.warn("Failed to harvest graph from ${file.path}: ${e.message}")
                }
                return true
            }
        })

        // --- Pass 2: resolve deferred edge targets via the now-complete GUID→node map.
        val edges = mutableListOf<GraphEdge>()
        edges.addAll(danglingCsharpEdges)

        // serialized_binding: aggregate by (owner, target).
        val bindingsAgg = LinkedHashMap<Pair<String, String>, MutableList<JsonObject>>()
        var unresolvedSerializedBindingTargets = 0
        var unresolvedScenePrefabTargets = 0
        var unresolvedVariantTargets = 0

        for (edge in pending) {
            when (edge) {
                is PendingEdge.ScriptUsage -> {
                    edges.add(
                        GraphEdge(
                            source = edge.source,
                            target = edge.target,
                            kind = edge.kind,
                            metadata = buildJsonObject {
                                put("component_instance_ids", buildJsonArray {
                                    for (cid in edge.componentInstanceIds) add(cid)
                                })
                            }
                        )
                    )
                }
                is PendingEdge.SerializedBinding -> {
                    val targetId = guidToNodeId[edge.targetGuid]
                    if (targetId == null) {
                        unresolvedSerializedBindingTargets += 1
                        continue
                    }
                    val key = edge.ownerId to targetId
                    bindingsAgg.getOrPut(key) { mutableListOf() }.add(
                        buildJsonObject {
                            put("field_name", JsonPrimitive(edge.fieldName))
                            put("component_instance_id", JsonPrimitive(edge.componentInstanceId))
                        }
                    )
                }
                is PendingEdge.SceneContainsPrefab -> {
                    val targetId = guidToNodeId[edge.sourceGuid]
                    if (targetId == null) {
                        unresolvedScenePrefabTargets += 1
                        continue
                    }
                    // Aggregate as instance_count.
                    val existingIdx = edges.indexOfFirst {
                        it.source == edge.sceneId && it.target == targetId && it.kind == EdgeKind.SCENE_CONTAINS_PREFAB
                    }
                    if (existingIdx >= 0) {
                        val existing = edges[existingIdx]
                        val prevCount = (existing.metadata["instance_count"] as? JsonPrimitive)
                            ?.content?.toIntOrNull() ?: 1
                        edges[existingIdx] = existing.copy(
                            metadata = buildJsonObject {
                                put("instance_count", JsonPrimitive(prevCount + 1))
                            }
                        )
                    } else {
                        edges.add(
                            GraphEdge(
                                source = edge.sceneId,
                                target = targetId,
                                kind = EdgeKind.SCENE_CONTAINS_PREFAB,
                                metadata = buildJsonObject {
                                    put("instance_count", JsonPrimitive(1))
                                }
                            )
                        )
                    }
                }
                is PendingEdge.PrefabVariantOf -> {
                    val targetId = guidToNodeId[edge.sourceGuid]
                    if (targetId == null) {
                        unresolvedVariantTargets += 1
                        continue
                    }
                    edges.add(
                        GraphEdge(
                            source = edge.prefabId,
                            target = targetId,
                            kind = EdgeKind.PREFAB_VARIANT_OF,
                            metadata = EMPTY_METADATA
                        )
                    )
                }
            }
        }

        for ((pair, bindings) in bindingsAgg) {
            edges.add(
                GraphEdge(
                    source = pair.first,
                    target = pair.second,
                    kind = EdgeKind.SERIALIZED_BINDING,
                    metadata = buildJsonObject {
                        put("bindings", buildJsonArray {
                            for (b in bindings) add(b)
                        })
                    }
                )
            )
        }

        // --- Apply filters from the request.
        val includeKinds = request.include_kinds?.toSet()
        val excludeKinds = request.exclude_kinds?.toSet().orEmpty()
        val pathGlobs = request.path_globs?.map(::compileGlob)
        val includeOrphans = request.include_orphans ?: true

        // Sub-file kinds are never emitted as top-level — warn if asked.
        if (includeKinds != null &&
            (NodeKind.COMPONENT_INSTANCE in includeKinds || NodeKind.COMPONENT_FIELD in includeKinds)
        ) {
            warnings.add(
                GraphWarning(
                    code = "subfile_kind_ignored",
                    message = "component_instance and component_field are never emitted as top-level nodes; see graph-schema.md §2.3.",
                    context = null
                )
            )
        }

        var filteredNodes: List<GraphNode> = nodes.values.toList()
        if (includeKinds != null) {
            filteredNodes = filteredNodes.filter { it.kind in includeKinds }
        }
        if (excludeKinds.isNotEmpty()) {
            filteredNodes = filteredNodes.filter { it.kind !in excludeKinds }
        }
        if (pathGlobs != null) {
            filteredNodes = filteredNodes.filter { node ->
                val p = node.path ?: return@filter false
                pathGlobs.any { it.matches(p) }
            }
        }

        var keptIds = filteredNodes.mapTo(HashSet()) { it.id }
        // script_declares_class deliberately dangles toward csharp:// nodes
        // that Day 8 emits — keep those edges as long as the source survived.
        fun edgeSurvives(e: GraphEdge): Boolean {
            if (e.source !in keptIds) return false
            if (e.kind == EdgeKind.SCRIPT_DECLARES_CLASS) return true
            return e.target in keptIds
        }
        var filteredEdges = edges.filter(::edgeSurvives)

        if (!includeOrphans) {
            val connected = HashSet<String>()
            for (e in filteredEdges) {
                connected.add(e.source)
                if (e.kind != EdgeKind.SCRIPT_DECLARES_CLASS) connected.add(e.target)
            }
            filteredNodes = filteredNodes.filter { it.id in connected }
            keptIds = filteredNodes.mapTo(HashSet()) { it.id }
            filteredEdges = filteredEdges.filter(::edgeSurvives)
        }

        // --- Dangling csharp warning (single summary, per breakdown doc).
        if (filteredEdges.any { it.kind == EdgeKind.SCRIPT_DECLARES_CLASS }) {
            warnings.add(
                GraphWarning(
                    code = "dangling_csharp_targets",
                    message = "script_declares_class edges point to csharp nodes that Day 2 does not emit; Day 8's code-edges harvest will materialize them.",
                    context = null
                )
            )
        }

        if (unresolvedSerializedBindingTargets +
            unresolvedScenePrefabTargets +
            unresolvedVariantTargets > 0
        ) {
            warnings.add(
                GraphWarning(
                    code = "unresolved_targets",
                    message = "Some edges referenced GUIDs not present in the project's .meta map (likely Unity built-ins or missing assets).",
                    context = buildJsonObject {
                        put("serialized_binding", JsonPrimitive(unresolvedSerializedBindingTargets))
                        put("scene_contains_prefab", JsonPrimitive(unresolvedScenePrefabTargets))
                        put("prefab_variant_of", JsonPrimitive(unresolvedVariantTargets))
                    }
                )
            )
        }

        // --- Pagination (slice nodes; drop edges crossing the window).
        val totalNodes = filteredNodes.size
        val (offset, pageSize) = decodePagination(request.pagination)
        val effectivePageSize = pageSize ?: totalNodes
        val sliceEnd = min(offset + effectivePageSize, totalNodes)
        val pageNodes = if (offset == 0 && sliceEnd == totalNodes) {
            filteredNodes
        } else {
            filteredNodes.subList(offset.coerceAtMost(totalNodes), sliceEnd)
        }
        val pageIds = pageNodes.mapTo(HashSet()) { it.id }
        val pageEdges = if (offset == 0 && sliceEnd == totalNodes) {
            filteredEdges
        } else {
            filteredEdges.filter { it.source in pageIds && it.target in pageIds }
        }

        val nextCursor = if (sliceEnd < totalNodes) encodeCursor(sliceEnd) else null

        val generatedAt = Instant.now().toString()
        val snapshot = GraphSnapshot(
            nodes = pageNodes,
            edges = pageEdges,
            generated_at = generatedAt,
            source_phase = GraphSourcePhase.ASSET,
            stats = GraphStats(
                node_count = pageNodes.size,
                edge_count = pageEdges.size,
                skipped_component_instances = skippedComponentInstances,
                skipped_component_fields = skippedComponentFields
            )
        )

        return GraphSnapshotResponse(
            request_id = request.request_id,
            generated_at = generatedAt,
            warnings = warnings.takeIf { it.isNotEmpty() },
            snapshot = snapshot,
            page = GraphPageResponse(
                next_cursor = nextCursor,
                total_estimated = totalNodes
            )
        )
    }

    private fun classify(extension: String, docs: List<com.github.dungphan.unityindex.util.UnityYamlDocument>): Pair<NodeKind, Boolean> {
        return when (extension) {
            "prefab" -> {
                val hasPrefabInstance = docs.any { it.classId == CLASS_ID_PREFAB_INSTANCE }
                if (hasPrefabInstance) NodeKind.PREFAB_VARIANT to true
                else NodeKind.PREFAB to false
            }
            "unity" -> NodeKind.SCENE to false
            "asset" -> if (docs.any { it.classId == CLASS_ID_MONOBEHAVIOUR }) NodeKind.SO to false
            else NodeKind.ASSET to false
            else -> NodeKind.ASSET to false
        }
    }

    private fun normalizeGuid(raw: String): String? {
        val trimmed = raw.trim().trim(',', ' ', '}')
        if (trimmed.length != 32) return null
        for (ch in trimmed) {
            if (!(ch in '0'..'9' || ch in 'a'..'f' || ch in 'A'..'F')) return null
        }
        val lower = trimmed.lowercase()
        // Unity uses all-zero GUIDs as "none."
        if (lower.all { it == '0' }) return null
        return lower
    }

    private fun relativize(absolutePath: String, basePath: String): String =
        absolutePath.removePrefix(basePath).removePrefix("/")

    // Compile a Unity-style glob (e.g. Assets/Foo/<doublestar>).
    // Supports ** (any depth), * (single segment), ? (single char).
    private fun compileGlob(glob: String): Regex {
        val sb = StringBuilder()
        var i = 0
        while (i < glob.length) {
            val c = glob[i]
            when {
                c == '*' && i + 1 < glob.length && glob[i + 1] == '*' -> {
                    sb.append(".*"); i += 2
                }
                c == '*' -> {
                    sb.append("[^/]*"); i += 1
                }
                c == '?' -> {
                    sb.append("[^/]"); i += 1
                }
                c == '.' || c == '(' || c == ')' || c == '+' || c == '|' || c == '^' ||
                        c == '$' || c == '{' || c == '}' || c == '[' || c == ']' || c == '\\' -> {
                    sb.append('\\').append(c); i += 1
                }
                else -> {
                    sb.append(c); i += 1
                }
            }
        }
        return Regex("^${sb}$")
    }

    private data class CursorState(val offset: Int)

    private fun decodePagination(pagination: GraphPageRequest?): Pair<Int, Int?> {
        if (pagination == null) return 0 to null
        val pageSize = pagination.page_size
        val cursor = pagination.cursor ?: return 0 to pageSize
        val decoded = try {
            val raw = Base64.getUrlDecoder().decode(cursor)
            val text = String(raw, StandardCharsets.UTF_8)
            val match = Regex("""^\{"sv":\d+,"offset":(\d+)\}$""").matchEntire(text)
                ?: return 0 to pageSize
            CursorState(match.groupValues[1].toInt())
        } catch (_: Exception) {
            return 0 to pageSize
        }
        return decoded.offset to pageSize
    }

    private fun encodeCursor(offset: Int): String {
        val payload = """{"sv":0,"offset":$offset}"""
        return Base64.getUrlEncoder().withoutPadding()
            .encodeToString(payload.toByteArray(StandardCharsets.UTF_8))
    }

    private sealed class PendingEdge {
        data class ScriptUsage(
            val source: String,
            val target: String,
            val kind: EdgeKind,
            val componentInstanceIds: List<String>
        ) : PendingEdge()

        data class SerializedBinding(
            val ownerId: String,
            val targetGuid: String,
            val fieldName: String,
            val componentInstanceId: String
        ) : PendingEdge()

        data class SceneContainsPrefab(
            val sceneId: String,
            val sourceGuid: String
        ) : PendingEdge()

        data class PrefabVariantOf(
            val prefabId: String,
            val sourceGuid: String
        ) : PendingEdge()
    }
}
