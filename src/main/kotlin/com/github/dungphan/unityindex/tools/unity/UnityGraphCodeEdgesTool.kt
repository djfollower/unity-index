package com.github.dungphan.unityindex.tools.unity

import com.github.dungphan.unityindex.constants.ToolNames
import com.github.dungphan.unityindex.handlers.BuiltInSearchScope
import com.github.dungphan.unityindex.handlers.BuiltInSearchScopeResolver
import com.github.dungphan.unityindex.handlers.CallElementData
import com.github.dungphan.unityindex.handlers.LanguageHandlerRegistry
import com.github.dungphan.unityindex.handlers.TypeElementData
import com.github.dungphan.unityindex.server.models.ToolCallResult
import com.github.dungphan.unityindex.tools.AbstractMcpTool
import com.github.dungphan.unityindex.tools.models.CodeEdgesRequest
import com.github.dungphan.unityindex.tools.models.CodeEdgesResponse
import com.github.dungphan.unityindex.tools.models.EdgeKind
import com.github.dungphan.unityindex.tools.models.GraphEdge
import com.github.dungphan.unityindex.tools.models.GraphNode
import com.github.dungphan.unityindex.tools.models.GraphNodeLocation
import com.github.dungphan.unityindex.tools.models.GraphSnapshot
import com.github.dungphan.unityindex.tools.models.GraphSourcePhase
import com.github.dungphan.unityindex.tools.models.GraphStats
import com.github.dungphan.unityindex.tools.models.NodeKind
import com.github.dungphan.unityindex.tools.schema.SchemaBuilder
import com.github.dungphan.unityindex.util.PlatformFallbacks
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiNamedElement
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.psi.search.searches.ReferencesSearch
import com.intellij.util.Processor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Day 8 — batched C# semantic-edge harvest. Wire format documented in
 * `docs/graph-mcp-tools.md` §3.6 and `graph/core/src/code-edges-wire.ts`.
 *
 * Given up to [CODE_EDGES_MAX_SYMBOLS] `unity://csharp/...` symbol IDs,
 * returns the inheritance / call / reference edges that connect them to
 * other C# symbols, plus (by default) the target nodes needed to render
 * the result. Replaces N round-trips on Phase-2 graphs.
 *
 * Per CLAUDE.md §2 / §4 the tool dispatches to the existing
 * [PlatformFallbacks] (and per-language handlers via
 * [LanguageHandlerRegistry]) instead of re-implementing PSI walks; per §4
 * it reuses [CSharpSymbolResolver] / [com.github.dungphan.unityindex.util.ClassResolver]
 * for the RD-proxy-tolerant name lookup chain.
 */
class UnityGraphCodeEdgesTool : AbstractMcpTool() {

    companion object {
        private val LOG = logger<UnityGraphCodeEdgesTool>()
        const val CODE_EDGES_MAX_SYMBOLS = 500

        /** Per-source cap for `class_references_class`. Real Unity codebases
         *  produce thousands of refs for hub types (MonoBehaviour, Object).
         *  We stop after this many hits to keep a single symbol's edges from
         *  drowning the response; consumers can re-query with a tighter set
         *  if they care about long-tail enclosing types. */
        const val CLASS_REFERENCES_HIT_LIMIT = 5000

        /** Day 9.3 — transitive-subtypes preset cap. Must match
         *  CODE_EDGES_MAX_SUBTYPES on the TS wire side. */
        const val CODE_EDGES_MAX_SUBTYPES = 2000

        /** Day 9.3 — default depth for `subtypes_of` BFS. Matches
         *  CODE_EDGES_DEFAULT_SUBTYPES_MAX_DEPTH on the TS side. */
        const val DEFAULT_SUBTYPES_MAX_DEPTH = 8

        /** Day 9.3 — hard ceiling for a client-supplied `subtypes_max_depth`.
         *  Keeps a malicious or buggy request from forcing an unbounded walk
         *  even if [CODE_EDGES_MAX_SUBTYPES] hasn't fired yet. 16 is well
         *  past any realistic Unity / .NET inheritance chain (MonoBehaviour
         *  hierarchies in shipped Asset-Store packages top out around 6). */
        const val MAX_SUBTYPES_DEPTH_CLAMP = 16

        /** Day 8.5 — bridge-friendly synchronous entry point used by the
         *  graph webview's lazy expansion. Caller must already be off the
         *  EDT (we acquire a platform read lock). Throws
         *  [IllegalArgumentException] with a leading `invalid_id` /
         *  `invalid_arguments` token for validation failures so the bridge's
         *  generic error path surfaces a stable string to the webview; any
         *  other failure propagates as-is. The MCP `doExecute` path keeps
         *  its own typed error-envelope handling and does not call this. */
        fun runDirect(project: Project, request: CodeEdgesRequest): CodeEdgesResponse {
            val hasSubtypes = !request.subtypes_of.isNullOrBlank()
            if (request.symbol_ids.isEmpty() && !hasSubtypes) {
                throw IllegalArgumentException("invalid_id: symbol_ids must contain at least one entry (or set subtypes_of)")
            }
            if (request.symbol_ids.size > CODE_EDGES_MAX_SYMBOLS) {
                throw IllegalArgumentException("invalid_arguments: symbol_ids has ${request.symbol_ids.size} entries, max $CODE_EDGES_MAX_SYMBOLS")
            }
            val parsed = request.symbol_ids.map { raw ->
                CSharpSymbolResolver.parse(raw)
                    ?: throw IllegalArgumentException("invalid_id: symbol_id '$raw' must be non-empty and start with '${CSharpSymbolResolver.PREFIX}'")
            }
            val subtypesRoot: CSharpSymbolResolver.ParsedSymbolId? = if (hasSubtypes) {
                val parsedRoot = CSharpSymbolResolver.parse(request.subtypes_of!!)
                    ?: throw IllegalArgumentException("invalid_id: subtypes_of '${request.subtypes_of}' must be non-empty and start with '${CSharpSymbolResolver.PREFIX}'")
                if (parsedRoot.kind != CSharpSymbolResolver.SymbolKind.TYPE) {
                    throw IllegalArgumentException("invalid_id: subtypes_of must be a type id (T:...), got kind=${parsedRoot.kind}")
                }
                parsedRoot
            } else null
            val kindFilter: Set<EdgeKind> = request.edge_kinds
                ?.filter { it in ALLOWED_KINDS }
                ?.toSet()
                ?: ALLOWED_KINDS
            val includeTargets = request.include_targets ?: true
            val maxDepth = clampSubtypesDepth(request.subtypes_max_depth)

            val tool = UnityGraphCodeEdgesTool()
            val (edges, nodes, unresolved, truncation) =
                ReadAction.compute<HarvestResult, Throwable> {
                    tool.harvestAll(project, parsed, subtypesRoot, kindFilter, includeTargets, maxDepth)
                }
            val generatedAt = java.time.Instant.now().toString()
            val snapshot = GraphSnapshot(
                nodes = nodes,
                edges = edges,
                generated_at = generatedAt,
                source_phase = GraphSourcePhase.CODE,
                stats = GraphStats(
                    node_count = nodes.size,
                    edge_count = edges.size,
                    skipped_component_instances = 0,
                    skipped_component_fields = 0,
                ),
            )
            return CodeEdgesResponse(
                request_id = request.request_id,
                generated_at = generatedAt,
                warnings = truncation?.let { listOf(it) },
                snapshot = snapshot,
                unresolved_ids = unresolved.takeIf { it.isNotEmpty() },
            )
        }

        private fun clampSubtypesDepth(raw: Int?): Int {
            val v = raw ?: DEFAULT_SUBTYPES_MAX_DEPTH
            return v.coerceIn(1, MAX_SUBTYPES_DEPTH_CLAMP)
        }

        private val ALLOWED_KINDS = setOf(
            EdgeKind.CLASS_INHERITS_FROM,
            EdgeKind.CLASS_IMPLEMENTS_INTERFACE,
            EdgeKind.METHOD_OVERRIDES_METHOD,
            EdgeKind.METHOD_CALLS_METHOD,
            EdgeKind.CLASS_REFERENCES_CLASS,
        )
    }

    override val requiresPsiSync: Boolean = false

    override val name: String = ToolNames.UNITY_GRAPH_CODE_EDGES

    override val description: String = """
        Batch C# semantic-edge lookup. Given up to $CODE_EDGES_MAX_SYMBOLS `unity://csharp/...` symbol IDs, returns the inheritance / call / reference edges that connect them to other C# symbols, plus (by default) the target nodes needed to render them.

        Edge kinds: class_inherits_from, class_implements_interface, method_overrides_method, method_calls_method, class_references_class. `method_calls_method.metadata.call_sites` is a list of { line, kind: direct|virtual|interface|delegate } entries.

        Parameters:
        - symbol_ids: 1..$CODE_EDGES_MAX_SYMBOLS `unity://csharp/<DocumentationCommentId>` strings. Required unless `subtypes_of` is set.
        - edge_kinds (optional): filter to specific edge kinds.
        - include_targets (optional, default true): when false, `snapshot.nodes` is empty (edges only).
        - subtypes_of (optional): `unity://csharp/T:Ns.Type` id. When set, the tool walks the type-hierarchy provider's subtypes transitively from this root and returns inheritance edges from each subclass back to its immediate parent. Capped at $CODE_EDGES_MAX_SUBTYPES visited nodes; truncation surfaces as a `subtypes_truncated` warning.
        - subtypes_max_depth (optional): depth cap for the `subtypes_of` BFS. Default $DEFAULT_SUBTYPES_MAX_DEPTH, clamped to $MAX_SUBTYPES_DEPTH_CLAMP.
        - project_path (optional): only needed when multiple projects are open.

        Symbols that parse cleanly but don't resolve come back in `unresolved_ids` rather than erroring (partial success).
    """.trimIndent()

    override val inputSchema: JsonObject = SchemaBuilder.tool()
        .projectPath()
        .property("symbol_ids", buildJsonObject {
            put("type", JsonPrimitive("array"))
            put("description", JsonPrimitive("1..$CODE_EDGES_MAX_SYMBOLS `unity://csharp/<DocumentationCommentId>` IDs (e.g. `unity://csharp/T:Foo.Bar`, `unity://csharp/M:Foo.Bar.Baz(System.Int32)`)."))
            put("items", buildJsonObject { put("type", JsonPrimitive("string")) })
        }, required = false)
        .property("edge_kinds", buildJsonObject {
            put("type", JsonPrimitive("array"))
            put("description", JsonPrimitive("Filter — only return edges of these kinds. Omit/empty for all five."))
            put("items", buildJsonObject { put("type", JsonPrimitive("string")) })
        })
        .booleanProperty("include_targets", "Default true. When false, `snapshot.nodes` is empty and edges only are returned.")
        .stringProperty("subtypes_of", "Optional `unity://csharp/T:Ns.Type` root. When set, the tool walks the type-hierarchy provider's subtypes transitively and returns the resulting inheritance edges (capped at $CODE_EDGES_MAX_SUBTYPES nodes / $MAX_SUBTYPES_DEPTH_CLAMP depth).")
        .property("subtypes_max_depth", buildJsonObject {
            put("type", JsonPrimitive("integer"))
            put("description", JsonPrimitive("Depth cap for the `subtypes_of` BFS. Default $DEFAULT_SUBTYPES_MAX_DEPTH, clamped to $MAX_SUBTYPES_DEPTH_CLAMP."))
        })
        .stringProperty("request_id", "Optional; echoed back on the response for client correlation.")
        .build()

    override suspend fun doExecute(project: Project, arguments: JsonObject): ToolCallResult {
        val request = try {
            json.decodeFromJsonElement(CodeEdgesRequest.serializer(), arguments)
        } catch (e: Exception) {
            return createStructuredErrorResult(buildJsonObject {
                put("error", buildJsonObject {
                    put("kind", JsonPrimitive("invalid_arguments"))
                    put("detail", JsonPrimitive(e.message ?: "could not decode CodeEdgesRequest"))
                })
            })
        }

        val hasSubtypes = !request.subtypes_of.isNullOrBlank()
        if (request.symbol_ids.isEmpty() && !hasSubtypes) {
            return invalidIdError("symbol_ids must contain at least one entry (or set subtypes_of)")
        }
        if (request.symbol_ids.size > CODE_EDGES_MAX_SYMBOLS) {
            return createStructuredErrorResult(buildJsonObject {
                put("error", buildJsonObject {
                    put("kind", JsonPrimitive("invalid_arguments"))
                    put("detail", JsonPrimitive("symbol_ids has ${request.symbol_ids.size} entries, max $CODE_EDGES_MAX_SYMBOLS"))
                })
            })
        }

        // Pre-parse: any malformed id is a hard error (matches the wire
        // contract — empty / missing prefix == invalid_id).
        val parsed = mutableListOf<CSharpSymbolResolver.ParsedSymbolId>()
        for (raw in request.symbol_ids) {
            val p = CSharpSymbolResolver.parse(raw)
                ?: return invalidIdError("symbol_id '$raw' must be non-empty and start with '${CSharpSymbolResolver.PREFIX}'")
            parsed.add(p)
        }

        val subtypesRoot: CSharpSymbolResolver.ParsedSymbolId? = if (hasSubtypes) {
            val raw = request.subtypes_of!!
            val parsedRoot = CSharpSymbolResolver.parse(raw)
                ?: return invalidIdError("subtypes_of '$raw' must be non-empty and start with '${CSharpSymbolResolver.PREFIX}'")
            if (parsedRoot.kind != CSharpSymbolResolver.SymbolKind.TYPE) {
                return invalidIdError("subtypes_of must be a type id (T:...), got kind=${parsedRoot.kind}")
            }
            parsedRoot
        } else null

        val kindFilter: Set<EdgeKind> = request.edge_kinds
            ?.filter { it in ALLOWED_KINDS }
            ?.toSet()
            ?: ALLOWED_KINDS
        val includeTargets = request.include_targets ?: true
        val maxDepth = clampSubtypesDepth(request.subtypes_max_depth)

        requireSmartMode(project)

        // Single read action: PSI lookups + hierarchy walks. PlatformFallbacks
        // touches HierarchyProvider / FindUsagesHandler — both require a read
        // lock. Run off the EDT to avoid freezing the UI on large fan-outs.
        val (edges, nodes, unresolved, truncation) = withContext(Dispatchers.IO) {
            ReadAction.compute<HarvestResult, Throwable> {
                harvestAll(project, parsed, subtypesRoot, kindFilter, includeTargets, maxDepth)
            }
        }

        val snapshot = GraphSnapshot(
            nodes = nodes,
            edges = edges,
            generated_at = java.time.Instant.now().toString(),
            source_phase = GraphSourcePhase.CODE,
            stats = GraphStats(
                node_count = nodes.size,
                edge_count = edges.size,
                skipped_component_instances = 0,
                skipped_component_fields = 0,
            ),
        )
        val response = CodeEdgesResponse(
            request_id = request.request_id,
            generated_at = snapshot.generated_at,
            warnings = truncation?.let { listOf(it) },
            snapshot = snapshot,
            unresolved_ids = unresolved.takeIf { it.isNotEmpty() },
        )
        return createJsonResult(response)
    }

    private fun invalidIdError(detail: String): ToolCallResult =
        createStructuredErrorResult(buildJsonObject {
            put("error", buildJsonObject {
                put("kind", JsonPrimitive("invalid_id"))
                put("detail", JsonPrimitive(detail))
            })
        })

    private data class EdgeKey(val source: String, val target: String, val kind: EdgeKind)

    /** Composite return for [harvestAll]. The truncation slot carries the
     *  optional `subtypes_truncated` warning so callers don't have to know
     *  whether the BFS bailed early. */
    internal data class HarvestResult(
        val edges: List<GraphEdge>,
        val nodes: List<GraphNode>,
        val unresolved: List<String>,
        val truncation: com.github.dungphan.unityindex.tools.models.GraphWarning?,
    )

    /** Combined entry point used by both the MCP path and the bridge
     *  `runDirect` path. Runs the existing per-symbol harvest, then
     *  optionally appends a transitive-subtypes BFS rooted at [subtypesRoot]
     *  (Day 9.3). All accumulators are shared so a single response carries
     *  both flavours of result. */
    internal fun harvestAll(
        project: Project,
        ids: List<CSharpSymbolResolver.ParsedSymbolId>,
        subtypesRoot: CSharpSymbolResolver.ParsedSymbolId?,
        kindFilter: Set<EdgeKind>,
        includeTargets: Boolean,
        subtypesMaxDepth: Int,
    ): HarvestResult {
        val edges = linkedMapOf<EdgeKey, GraphEdge>()
        val nodes = linkedMapOf<String, GraphNode>()
        val unresolved = mutableListOf<String>()

        for (id in ids) {
            val resolved = CSharpSymbolResolver.resolve(project, id)
            if (resolved == null) {
                unresolved.add(id.raw)
                continue
            }
            try {
                when (id.kind) {
                    CSharpSymbolResolver.SymbolKind.TYPE -> handleType(project, id, resolved, kindFilter, edges, nodes, includeTargets)
                    CSharpSymbolResolver.SymbolKind.METHOD -> handleMethod(project, id, resolved, kindFilter, edges, nodes, includeTargets)
                    CSharpSymbolResolver.SymbolKind.OTHER -> unresolved.add(id.raw)
                }
            } catch (e: Throwable) {
                LOG.debug("code-edges harvest failed for ${id.raw}: ${e.message}", e)
                unresolved.add(id.raw)
            }
        }

        var truncation: com.github.dungphan.unityindex.tools.models.GraphWarning? = null
        if (subtypesRoot != null) {
            val resolvedRoot = CSharpSymbolResolver.resolve(project, subtypesRoot)
            if (resolvedRoot == null) {
                unresolved.add(subtypesRoot.raw)
            } else {
                try {
                    truncation = collectSubtypes(
                        project = project,
                        rootElement = resolvedRoot.element,
                        rootTypeName = subtypesRoot.typeName,
                        maxDepth = subtypesMaxDepth,
                        kindFilter = kindFilter,
                        edges = edges,
                        nodes = nodes,
                        includeTargets = includeTargets,
                    )
                } catch (e: Throwable) {
                    LOG.debug("subtypes BFS failed for ${subtypesRoot.raw}: ${e.message}", e)
                    unresolved.add(subtypesRoot.raw)
                }
            }
        }

        return HarvestResult(
            edges = edges.values.toList(),
            nodes = if (includeTargets) nodes.values.toList() else emptyList(),
            unresolved = unresolved,
            truncation = truncation,
        )
    }

    /** Day 9.3 — BFS the type-hierarchy provider's subtypes from
     *  [rootElement], emitting `class_inherits_from` (or
     *  `class_implements_interface` when the parent at that edge is an
     *  interface) edges directed from each subclass back toward its
     *  *immediate* parent. The graph is the actual tree, not a star around
     *  the root.
     *
     *  Termination: bounded by [maxDepth] levels and
     *  [CODE_EDGES_MAX_SUBTYPES] visited nodes (the root counts). When
     *  either fires before the hierarchy is exhausted, the call returns a
     *  `subtypes_truncated` warning instead of throwing — partial results
     *  are still useful to the caller.
     *
     *  Returns the truncation warning if hit, null otherwise. */
    private fun collectSubtypes(
        project: Project,
        rootElement: com.intellij.psi.PsiElement,
        rootTypeName: String,
        maxDepth: Int,
        kindFilter: Set<EdgeKind>,
        edges: MutableMap<EdgeKey, GraphEdge>,
        nodes: MutableMap<String, GraphNode>,
        includeTargets: Boolean,
    ): com.github.dungphan.unityindex.tools.models.GraphWarning? {
        val edgeKindNeeded = EdgeKind.CLASS_INHERITS_FROM in kindFilter ||
            EdgeKind.CLASS_IMPLEMENTS_INTERFACE in kindFilter
        if (!edgeKindNeeded) return null

        val rootId = CSharpSymbolResolver.typeId(rootTypeName)
        // First hierarchy lookup also tells us whether the root is an
        // interface; that decides the edge kind for child→root edges.
        val rootHierarchy = LanguageHandlerRegistry.getTypeHierarchyHandler(rootElement)
            ?.getTypeHierarchy(rootElement, project, BuiltInSearchScope.PROJECT_FILES, false)
            ?: PlatformFallbacks.getTypeHierarchy(rootElement, project, BuiltInSearchScope.PROJECT_FILES, false)
            ?: return null
        if (includeTargets) {
            val rootNodeKind = nodeKindFor(rootHierarchy.element.kind)
            nodes.putIfAbsent(rootId, typeNode(rootId, rootTypeName, rootNodeKind))
        }

        // Queue carries the parent type + its PSI element + the depth at
        // which we visit it. We BFS so depth limits hit the broadest level
        // first; truncation cuts the deepest tier, never an arbitrary
        // subset of one level.
        data class Frame(
            val element: com.intellij.psi.PsiElement,
            val typeName: String,
            val typeKind: String,
            val depth: Int,
        )
        val queue: ArrayDeque<Frame> = ArrayDeque()
        queue.addLast(Frame(rootElement, rootTypeName, rootHierarchy.element.kind, 0))

        // Visit set tracks both directions: keeps us from cycling and from
        // re-issuing hierarchy lookups for a class that's already been
        // expanded through a different parent (diamond inheritance via
        // interfaces).
        val visited = mutableSetOf(rootTypeName)
        var truncated = false
        var truncatedReason = ""

        while (queue.isNotEmpty() && !truncated) {
            ProgressManager.checkCanceled()
            val frame = queue.removeFirst()
            if (frame.depth >= maxDepth) {
                // We never expand past maxDepth — but we don't truncate
                // unless there's more to expand. Mark only if at least one
                // node at the cap had unexpanded subtypes; for simplicity
                // we mark on any frame skipped past the cap.
                if (rootElement !== frame.element) truncated = true.also { truncatedReason = "max_depth" }
                continue
            }
            val hierarchy = if (frame.element === rootElement) rootHierarchy
                else (LanguageHandlerRegistry.getTypeHierarchyHandler(frame.element)
                    ?.getTypeHierarchy(frame.element, project, BuiltInSearchScope.PROJECT_FILES, false)
                    ?: PlatformFallbacks.getTypeHierarchy(frame.element, project, BuiltInSearchScope.PROJECT_FILES, false))
                ?: continue

            val parentIsInterface = frame.typeKind.equals("interface", ignoreCase = true)
            val edgeKind = if (parentIsInterface) EdgeKind.CLASS_IMPLEMENTS_INTERFACE
                else EdgeKind.CLASS_INHERITS_FROM
            if (edgeKind !in kindFilter) continue

            val parentId = CSharpSymbolResolver.typeId(frame.typeName)
            for (sub in hierarchy.subtypes) {
                val subName = sub.qualifiedName ?: sub.name
                if (subName.isBlank()) continue
                val subId = CSharpSymbolResolver.typeId(subName)
                if (!visited.add(subName)) {
                    // Already queued through a different parent. Still
                    // emit the edge — it carries the inheritance link we'd
                    // otherwise lose.
                    addEdge(edges, subId, parentId, edgeKind, emptyMetadata())
                    continue
                }
                if (visited.size > CODE_EDGES_MAX_SUBTYPES) {
                    truncated = true
                    truncatedReason = "max_nodes"
                    visited.remove(subName) // keep visited count accurate
                    break
                }
                addEdge(edges, subId, parentId, edgeKind, emptyMetadata())
                if (includeTargets) {
                    nodes.putIfAbsent(subId, typeDataToNode(subId, sub))
                }
                // Re-resolve the subtype's PSI element so the next BFS
                // level can fetch its hierarchy. Done lazily — most leaves
                // won't be touched again, and resolution can be expensive.
                if (frame.depth + 1 < maxDepth) {
                    val subParsed = CSharpSymbolResolver.parse(
                        "${CSharpSymbolResolver.PREFIX}T:$subName"
                    )
                    val subResolved = subParsed?.let { CSharpSymbolResolver.resolve(project, it) }
                    if (subResolved != null) {
                        queue.addLast(Frame(subResolved.element, subName, sub.kind, frame.depth + 1))
                    }
                }
            }
        }

        if (!truncated) return null
        return com.github.dungphan.unityindex.tools.models.GraphWarning(
            code = "subtypes_truncated",
            message = "subtypes BFS truncated: $truncatedReason (visited=${visited.size})",
            context = buildJsonObject {
                put("root", JsonPrimitive(rootTypeName))
                put("visited", JsonPrimitive(visited.size))
                put("max_depth", JsonPrimitive(maxDepth))
                put("reason", JsonPrimitive(truncatedReason))
            },
        )
    }

    private fun nodeKindFor(kind: String): NodeKind = when (kind.lowercase()) {
        "interface" -> NodeKind.INTERFACE
        "struct" -> NodeKind.STRUCT
        "enum" -> NodeKind.ENUM
        else -> NodeKind.CLASS
    }

    private fun handleType(
        project: Project,
        id: CSharpSymbolResolver.ParsedSymbolId,
        resolved: CSharpSymbolResolver.ResolvedSymbol,
        kindFilter: Set<EdgeKind>,
        edges: MutableMap<EdgeKey, GraphEdge>,
        nodes: MutableMap<String, GraphNode>,
        includeTargets: Boolean,
    ) {
        val sourceId = CSharpSymbolResolver.typeId(id.typeName)
        if (includeTargets) {
            nodes.putIfAbsent(sourceId, typeNode(sourceId, id.typeName, kindHint(resolved.element)))
        }

        val needInheritance = EdgeKind.CLASS_INHERITS_FROM in kindFilter
        val needInterfaces = EdgeKind.CLASS_IMPLEMENTS_INTERFACE in kindFilter
        if (needInheritance || needInterfaces) {
            val hierarchy = LanguageHandlerRegistry.getTypeHierarchyHandler(resolved.element)
                ?.getTypeHierarchy(resolved.element, project, BuiltInSearchScope.PROJECT_FILES, false)
                ?: PlatformFallbacks.getTypeHierarchy(resolved.element, project, BuiltInSearchScope.PROJECT_FILES, false)
            if (hierarchy != null) {
                for (supertype in hierarchy.supertypes) {
                    val targetName = supertype.qualifiedName ?: supertype.name
                    val targetId = CSharpSymbolResolver.typeId(targetName)
                    val kind = if (supertype.kind.equals("interface", ignoreCase = true)) EdgeKind.CLASS_IMPLEMENTS_INTERFACE else EdgeKind.CLASS_INHERITS_FROM
                    if (kind !in kindFilter) continue
                    addEdge(edges, sourceId, targetId, kind, emptyMetadata())
                    if (includeTargets) {
                        nodes.putIfAbsent(targetId, typeDataToNode(targetId, supertype))
                    }
                }
            }
        }

        if (EdgeKind.CLASS_REFERENCES_CLASS in kindFilter) {
            collectClassReferences(project, id.typeName, resolved.element, edges, nodes, includeTargets)
        }
    }

    /** Day 8.2b — fan a [ReferencesSearch] over the resolved type and emit
     *  `class_references_class` edges keyed by the enclosing type of each
     *  reference site. Self-references (a hit whose enclosing type is the
     *  source itself) are dropped so we don't pollute the graph with self
     *  loops from declaration / partial-class hits. */
    private fun collectClassReferences(
        project: Project,
        sourceTypeName: String,
        typeElement: com.intellij.psi.PsiElement,
        edges: MutableMap<EdgeKey, GraphEdge>,
        nodes: MutableMap<String, GraphNode>,
        includeTargets: Boolean,
    ) {
        val sourceId = CSharpSymbolResolver.typeId(sourceTypeName)
        val scope = GlobalSearchScope.projectScope(project)
        val seenEnclosing = linkedMapOf<String, Pair<String, GraphNode?>>()
        var hitCount = 0
        try {
            ReferencesSearch.search(typeElement, scope).forEach(Processor { reference ->
                ProgressManager.checkCanceled()
                hitCount++
                if (hitCount > CLASS_REFERENCES_HIT_LIMIT) return@Processor false
                val refElement = reference.element
                val refFile = refElement.containingFile?.virtualFile ?: return@Processor true
                if (!scope.contains(refFile)) return@Processor true
                val enclosing = CSharpSymbolResolver.findEnclosingType(refElement) ?: return@Processor true
                if (enclosing.name == sourceTypeName || enclosing.name.substringAfterLast('.') == sourceTypeName.substringAfterLast('.')) {
                    // Self-reference (same type, possibly under a partial-class
                    // declaration in a different file). Skip — emitting it
                    // would inflate the graph with `T:Foo → T:Foo` self loops.
                    return@Processor true
                }
                val node = if (includeTargets) {
                    GraphNode(
                        id = CSharpSymbolResolver.typeId(enclosing.name),
                        kind = when (enclosing.kind.lowercase()) {
                            "interface" -> NodeKind.INTERFACE
                            "struct" -> NodeKind.STRUCT
                            "enum" -> NodeKind.ENUM
                            else -> NodeKind.CLASS
                        },
                        label = enclosing.name,
                        path = refFile.path.takeIf { it.isNotBlank() },
                        guid = null,
                        location = null,
                        metadata = buildJsonObject {
                            put("inferred_from", JsonPrimitive("reference_enclosing_type"))
                        },
                    )
                } else null
                seenEnclosing.putIfAbsent(enclosing.name, enclosing.kind to node)
                true
            })
        } catch (e: LinkageError) {
            // Mirrors FindUsagesTool: ReferencesSearch can throw LinkageError
            // on plugin classpath drift. Treat as "no references found" and
            // log; the caller still gets the inheritance edges.
            LOG.warn("ReferencesSearch failed for $sourceTypeName", e)
        } catch (e: Throwable) {
            LOG.debug("class_references_class harvest failed for $sourceTypeName: ${e.message}", e)
        }

        for ((enclosingName, kindAndNode) in seenEnclosing) {
            val targetId = CSharpSymbolResolver.typeId(enclosingName)
            addEdge(edges, targetId, sourceId, EdgeKind.CLASS_REFERENCES_CLASS, emptyMetadata())
            kindAndNode.second?.let { nodes.putIfAbsent(targetId, it) }
        }
    }

    private fun handleMethod(
        project: Project,
        id: CSharpSymbolResolver.ParsedSymbolId,
        resolved: CSharpSymbolResolver.ResolvedSymbol,
        kindFilter: Set<EdgeKind>,
        edges: MutableMap<EdgeKey, GraphEdge>,
        nodes: MutableMap<String, GraphNode>,
        includeTargets: Boolean,
    ) {
        val methodName = id.methodName ?: return
        val sourceId = CSharpSymbolResolver.methodId(id.typeName, methodName)
        if (includeTargets) {
            nodes.putIfAbsent(sourceId, methodNode(sourceId, methodName, owner = id.typeName))
        }

        if (EdgeKind.METHOD_OVERRIDES_METHOD in kindFilter) {
            val superMethods = LanguageHandlerRegistry.getSuperMethodsHandler(resolved.element)
                ?.findSuperMethods(resolved.element, project)
                ?: PlatformFallbacks.findSuperMethods(resolved.element, project)
            if (superMethods != null) {
                for (sm in superMethods.hierarchy) {
                    val ownerType = sm.containingClass
                    val targetId = CSharpSymbolResolver.methodId(ownerType, sm.name)
                    addEdge(edges, sourceId, targetId, EdgeKind.METHOD_OVERRIDES_METHOD, buildJsonObject {
                        put("depth", JsonPrimitive(sm.depth))
                        put("is_interface", JsonPrimitive(sm.isInterface))
                    })
                    if (includeTargets) {
                        nodes.putIfAbsent(targetId, GraphNode(
                            id = targetId,
                            kind = NodeKind.METHOD,
                            label = "${ownerType}.${sm.name}",
                            path = sm.file,
                            guid = null,
                            location = sm.line?.let { GraphNodeLocation(line = it, column = sm.column) },
                            metadata = buildJsonObject {
                                put("language", JsonPrimitive(sm.language))
                                put("container", JsonPrimitive(ownerType))
                            },
                        ))
                    }
                }
            }
        }

        if (EdgeKind.METHOD_CALLS_METHOD in kindFilter) {
            val calls = LanguageHandlerRegistry.getCallHierarchyHandler(resolved.element)
                ?.getCallHierarchy(resolved.element, project, "callees", 1, BuiltInSearchScope.PROJECT_FILES, false)
                ?: PlatformFallbacks.getCallHierarchy(resolved.element, project, "callees", 1, BuiltInSearchScope.PROJECT_FILES, false)
            if (calls != null) {
                // Group calls by target (owner+name); each target carries the
                // distinct call-site lines we saw.
                val callsByTarget = linkedMapOf<Pair<String, String>, MutableList<CallElementData>>()
                for (c in calls.calls) {
                    val owner = extractCallOwner(c) ?: continue
                    callsByTarget.getOrPut(owner to c.name) { mutableListOf() }.add(c)
                }
                for ((key, hits) in callsByTarget) {
                    val (ownerType, calleeName) = key
                    val targetId = CSharpSymbolResolver.methodId(ownerType, calleeName)
                    val callSitesJson = buildJsonArray {
                        for (h in hits) {
                            add(buildJsonObject {
                                put("line", JsonPrimitive(h.line))
                                // PlatformFallbacks doesn't surface dispatch kind;
                                // default to "direct". TODO(day-8.6): tighten via
                                // PSI inspection of the call expression.
                                put("kind", JsonPrimitive("direct"))
                            })
                        }
                    }
                    addEdge(edges, sourceId, targetId, EdgeKind.METHOD_CALLS_METHOD, buildJsonObject {
                        put("call_sites", callSitesJson)
                    })
                    if (includeTargets) {
                        val first = hits.first()
                        nodes.putIfAbsent(targetId, GraphNode(
                            id = targetId,
                            kind = NodeKind.METHOD,
                            label = "${ownerType}.${calleeName}",
                            path = first.file.ifBlank { null },
                            guid = null,
                            location = GraphNodeLocation(line = first.line, column = first.column),
                            metadata = buildJsonObject {
                                put("language", JsonPrimitive(first.language))
                                put("container", JsonPrimitive(ownerType))
                            },
                        ))
                    }
                }
            }
        }
    }

    /** Best-effort extraction of the call-target's owning type name. The
     *  CallElementData shape only carries `name` / `file` / `line` / column /
     *  language, so we infer the owner from the file basename — Unity-
     *  idiomatic, since CLAUDE.md §4 calls out that Unity codebases follow
     *  one-class-per-file. */
    private fun extractCallOwner(c: CallElementData): String? {
        if (c.file.isBlank()) return null
        val base = c.file.substringAfterLast('/').substringAfterLast('\\').substringBeforeLast('.')
        return base.takeIf { it.isNotBlank() }
    }

    private fun addEdge(
        edges: MutableMap<EdgeKey, GraphEdge>,
        source: String,
        target: String,
        kind: EdgeKind,
        metadata: JsonObject,
    ) {
        val key = EdgeKey(source, target, kind)
        val existing = edges[key]
        if (existing == null) {
            edges[key] = GraphEdge(source = source, target = target, kind = kind, metadata = metadata)
        } else if (kind == EdgeKind.METHOD_CALLS_METHOD) {
            // Merge call-site lists across multiple harvests of the same pair.
            val merged = mergeCallSites(existing.metadata, metadata)
            edges[key] = existing.copy(metadata = merged)
        }
    }

    private fun mergeCallSites(a: JsonObject, b: JsonObject): JsonObject {
        val aSites = a["call_sites"] as? JsonArray ?: JsonArray(emptyList())
        val bSites = b["call_sites"] as? JsonArray ?: JsonArray(emptyList())
        val combined = buildJsonArray {
            for (e in aSites) add(e)
            for (e in bSites) add(e)
        }
        return buildJsonObject {
            for ((k, v) in a) if (k != "call_sites") put(k, v)
            put("call_sites", combined)
        }
    }

    private fun emptyMetadata(): JsonObject = buildJsonObject { }

    private fun kindHint(element: com.intellij.psi.PsiElement): NodeKind {
        // PSI proxies (Rider RD) frequently lie about element class. We default
        // to CLASS — call_kind discrimination isn't load-bearing at the snapshot
        // layer (consumers re-key by node id anyway).
        return NodeKind.CLASS
    }

    private fun typeNode(id: String, qualifiedName: String, kind: NodeKind): GraphNode = GraphNode(
        id = id,
        kind = kind,
        label = qualifiedName,
        path = null,
        guid = null,
        location = null,
        metadata = buildJsonObject {
            put("qualified_name", JsonPrimitive(qualifiedName))
        },
    )

    private fun typeDataToNode(id: String, data: TypeElementData): GraphNode {
        val nodeKind = when (data.kind.lowercase()) {
            "interface" -> NodeKind.INTERFACE
            "struct" -> NodeKind.STRUCT
            "enum" -> NodeKind.ENUM
            else -> NodeKind.CLASS
        }
        return GraphNode(
            id = id,
            kind = nodeKind,
            label = data.qualifiedName ?: data.name,
            path = data.file,
            guid = null,
            location = data.line?.let { GraphNodeLocation(line = it) },
            metadata = buildJsonObject {
                data.qualifiedName?.let { put("qualified_name", JsonPrimitive(it)) }
                put("language", JsonPrimitive(data.language))
            },
        )
    }

    private fun methodNode(id: String, methodName: String, owner: String): GraphNode = GraphNode(
        id = id,
        kind = NodeKind.METHOD,
        label = "$owner.$methodName",
        path = null,
        guid = null,
        location = null,
        metadata = buildJsonObject {
            put("container", JsonPrimitive(owner))
        },
    )

    @Suppress("UNUSED_PARAMETER")
    private fun unused(element: PsiNamedElement) {
        // Reserved for future signature-aware lookup; PsiNamedElement is
        // imported here so a downstream tightening doesn't have to re-add it.
    }
}
