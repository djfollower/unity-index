package com.github.dungphan.unityindex.graph

import com.github.dungphan.unityindex.tools.models.GraphSnapshot
import com.github.dungphan.unityindex.tools.models.GraphSnapshotDelta
import com.github.dungphan.unityindex.tools.models.GraphSnapshotDeltaRequest
import com.github.dungphan.unityindex.tools.models.GraphSnapshotDeltaResponse
import com.github.dungphan.unityindex.tools.models.GraphSnapshotRequest
import com.github.dungphan.unityindex.tools.models.GraphSnapshotResponse
import com.github.dungphan.unityindex.tools.models.GraphWarning
import com.github.dungphan.unityindex.util.BurstCoalescerTiming
import com.github.dungphan.unityindex.util.GraphSnapshotDiff
import com.github.dungphan.unityindex.util.GraphWarningCodes
import com.github.dungphan.unityindex.util.UnityAssetGraphBuilder
import com.github.dungphan.unityindex.util.WATCHER_DEBOUNCE_MS
import com.github.dungphan.unityindex.util.WATCHER_MAX_WAIT_MS
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileContentChangeEvent
import com.intellij.openapi.vfs.newvfs.events.VFileCopyEvent
import com.intellij.openapi.vfs.newvfs.events.VFileCreateEvent
import com.intellij.openapi.vfs.newvfs.events.VFileDeleteEvent
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.openapi.vfs.newvfs.events.VFileMoveEvent
import com.intellij.openapi.vfs.newvfs.events.VFilePropertyChangeEvent
import com.intellij.util.Alarm
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Day 7 — project-scoped snapshot cache for `unity_graph_snapshot{,_delta}`.
 * Mirror of `vscode-extension/src/utils/graphSnapshotCache.ts`.
 *
 * Holds the current unfiltered asset graph plus one step of history so a
 * client exactly one revision behind can be served a real diff. Anything
 * older forces a reset. Filter projection through deltas is deferred — a
 * filtered delta request always resets with a full filtered snapshot.
 *
 * ## VFS integration
 *
 * The cache subscribes to {@link VirtualFileManager.VFS_CHANGES} on the
 * project message bus at construction time. Asset-relevant events
 * (`*.prefab`, `*.unity`, `*.asset`, `*.meta`, plus the long tail of asset
 * extensions accepted by [UnityAssetGraphBuilder]) collect into a pending
 * path set; an [Alarm] coalesces bursts and fires a single rebuild +
 * diff + revision bump.
 *
 * Tests can pass `installVfsListener = false` to construct the cache
 * stand-alone and drive [notifyChanged] directly. Production callers
 * always go through the project service.
 */
@Service(Service.Level.PROJECT)
class GraphSnapshotCache(private val project: Project) : Disposable {

    companion object {
        private val LOG = logger<GraphSnapshotCache>()

        // Extensions that count as graph-relevant. Mirrors the set in
        // UnityAssetGraphBuilder.ASSET_EXTENSIONS plus `.meta` (which we
        // don't ingest directly but which signals a GUID change).
        private val WATCHED_EXTENSIONS = setOf(
            "prefab", "unity", "asset",
            "mat", "anim", "controller", "playable", "spriteatlas", "lighting",
            "shader", "physicMaterial", "physicsMaterial2D",
            "meta",
        )

        fun get(project: Project): GraphSnapshotCache = project.service()
    }

    private data class CachedRevision(
        val revision: Int,
        val snapshot: GraphSnapshot,
    )

    private val lock = ReentrantLock()
    private var current: CachedRevision? = null
    private var previous: CachedRevision? = null
    private val pendingPaths = LinkedHashSet<String>()

    private val invalidateAlarm = Alarm(Alarm.ThreadToUse.POOLED_THREAD, this)

    /**
     * Day 7 — burst coalescer state for the VFS listener. Trailing debounce
     * extended by [WATCHER_DEBOUNCE_MS] on every event; hard ceiling at
     * [WATCHER_MAX_WAIT_MS] so sustained bursts (Reimport All) still result
     * in a rebuild within ~1s. Guarded by [lock] alongside [pendingPaths].
     */
    private val coalescerTiming = BurstCoalescerTiming.State()

    init {
        // Skip VFS wiring under unit tests; tests drive notifyChanged() directly.
        if (!ApplicationManager.getApplication().isUnitTestMode) {
            project.messageBus.connect(this).subscribe(
                VirtualFileManager.VFS_CHANGES,
                VfsListener(),
            )
        }
    }

    /**
     * Build (or reuse) the unfiltered snapshot, then echo through the
     * builder's filter pipeline if the request carries filters. Filtered
     * requests do NOT update the cache state — only the cold-start path does.
     */
    fun snapshot(request: GraphSnapshotRequest): GraphSnapshotResponse {
        val unfiltered = ensureBase()
        val revision = current!!.revision

        val isUnfiltered = request.include_kinds.isNullOrEmpty() &&
            request.exclude_kinds.isNullOrEmpty() &&
            request.path_globs.isNullOrEmpty() &&
            request.include_orphans != false &&
            request.pagination == null

        if (isUnfiltered) {
            return GraphSnapshotResponse(
                request_id = request.request_id,
                generated_at = unfiltered.generated_at,
                snapshot = unfiltered,
                revision = revision,
            )
        }

        // Filter / pagination path — delegate to the builder for now.
        val response = UnityAssetGraphBuilder.build(project, request)
        return response.copy(revision = revision)
    }

    /**
     * Serve a one-step delta or a reset. Filtered delta requests always reset
     * because the cache does not project deltas through filters yet (see
     * class-level docstring).
     */
    fun delta(request: GraphSnapshotDeltaRequest): GraphSnapshotDeltaResponse {
        val unfiltered = ensureBase()
        val currentRevision = current!!.revision

        val filtered = !request.include_kinds.isNullOrEmpty() ||
            !request.exclude_kinds.isNullOrEmpty() ||
            !request.path_globs.isNullOrEmpty() ||
            request.include_orphans == false

        if (filtered) {
            return resetResponse(
                request,
                unfiltered,
                currentRevision,
                reason = "filter_mismatch",
                message = "Filtered delta requests are not yet supported by the cache; returning full snapshot.",
            )
        }

        if (request.since_revision == currentRevision) {
            val empty = GraphSnapshotDelta(
                base_revision = currentRevision,
                new_revision = currentRevision,
                generated_at = unfiltered.generated_at,
                source_phase = unfiltered.source_phase,
                nodes_added = emptyList(),
                nodes_removed = emptyList(),
                nodes_updated = emptyList(),
                edges_added = emptyList(),
                edges_removed = emptyList(),
                stats = unfiltered.stats,
            )
            return GraphSnapshotDeltaResponse(
                request_id = request.request_id,
                generated_at = unfiltered.generated_at,
                reset = false,
                new_revision = currentRevision,
                delta = empty,
                snapshot = null,
            )
        }

        val prevSnap = previous
        if (prevSnap != null && request.since_revision == prevSnap.revision) {
            val delta = GraphSnapshotDiff.diff(
                prev = prevSnap.snapshot,
                next = current!!.snapshot,
                opts = GraphSnapshotDiff.Options(
                    baseRevision = prevSnap.revision,
                    newRevision = currentRevision,
                ),
            )
            return GraphSnapshotDeltaResponse(
                request_id = request.request_id,
                generated_at = current!!.snapshot.generated_at,
                reset = false,
                new_revision = currentRevision,
                delta = delta,
                snapshot = null,
            )
        }

        val reason = if (request.since_revision > currentRevision)
            "server_restart" else "history_exhausted"
        val message = if (reason == "server_restart")
            "Server has no record of this revision (probably a restart); resetting."
        else
            "Client is more than one revision behind; cache history exhausted."
        return resetResponse(request, unfiltered, currentRevision, reason, message)
    }

    /**
     * Called by the VFS listener (or tests) with project-relative paths that
     * changed. Rebuilds the unfiltered snapshot, diffs against the cached
     * one, and bumps the revision iff anything actually changed.
     *
     * Safe to call from any thread. Internally serialises via [lock] so two
     * notifications cannot both bump the revision concurrently. The actual
     * snapshot build runs on the calling thread — callers must already be
     * off the EDT (the VFS listener path posts via [Alarm] / pooled thread).
     */
    fun notifyChanged(affectedPaths: Collection<String>) {
        val drained: List<String> = lock.withLock {
            pendingPaths.addAll(affectedPaths)
            // Cold cache — first read seeds; nothing to diff.
            if (current == null) return
            val snapshot = pendingPaths.toList()
            pendingPaths.clear()
            snapshot
        }

        val next = try {
            UnityAssetGraphBuilder.build(project, GraphSnapshotRequest()).snapshot
        } catch (e: Exception) {
            // Re-queue paths so the next notify retries them.
            lock.withLock { pendingPaths.addAll(drained) }
            LOG.warn("GraphSnapshotCache(${project.name}) rebuild failed", e)
            return
        }

        lock.withLock {
            val curr = current ?: return
            val tentative = GraphSnapshotDiff.diff(
                prev = curr.snapshot,
                next = next,
                opts = GraphSnapshotDiff.Options(
                    baseRevision = curr.revision,
                    newRevision = curr.revision + 1,
                    affectedPaths = drained,
                ),
            )
            if (GraphSnapshotDiff.isEmpty(tentative)) return
            previous = curr
            current = CachedRevision(curr.revision + 1, next)
            LOG.info(
                "GraphSnapshotCache(${project.name}) bumped to revision ${curr.revision + 1} " +
                    "(+${tentative.nodes_added.size}n -${tentative.nodes_removed.size}n " +
                    "~${tentative.nodes_updated.size}n / +${tentative.edges_added.size}e " +
                    "-${tentative.edges_removed.size}e)"
            )
        }
    }

    /** Drop all cached state. Next call rebuilds cold and clients with stale
     *  revisions get reset. Primarily for tests; production resets happen on
     *  project close via [Disposable.dispose]. */
    fun invalidate() {
        lock.withLock {
            current = null
            previous = null
            pendingPaths.clear()
        }
    }

    override fun dispose() {
        invalidateAlarm.cancelAllRequests()
        invalidate()
    }

    // ------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------

    private fun ensureBase(): GraphSnapshot {
        lock.withLock { current?.let { return it.snapshot } }
        // Build outside the lock — UnityAssetGraphBuilder walks the VFS and
        // can take seconds on a large project; holding the lock would serialise
        // all snapshot calls.
        val built = UnityAssetGraphBuilder.build(project, GraphSnapshotRequest()).snapshot
        lock.withLock {
            // Another caller may have raced to seed; respect whoever wrote first.
            current?.let { return it.snapshot }
            current = CachedRevision(revision = 0, snapshot = built)
            LOG.info(
                "GraphSnapshotCache(${project.name}) seeded at revision 0 — " +
                    "${built.nodes.size} nodes, ${built.edges.size} edges"
            )
            return built
        }
    }

    private fun resetResponse(
        request: GraphSnapshotDeltaRequest,
        snapshot: GraphSnapshot,
        revision: Int,
        reason: String,
        message: String,
    ): GraphSnapshotDeltaResponse {
        val warning = GraphWarning(
            code = GraphWarningCodes.DELTA_RESET,
            message = message,
            context = buildJsonObject {
                put("reason", JsonPrimitive(reason))
            } as JsonObject,
        )
        return GraphSnapshotDeltaResponse(
            request_id = request.request_id,
            generated_at = snapshot.generated_at,
            warnings = listOf(warning),
            reset = true,
            new_revision = revision,
            delta = null,
            snapshot = snapshot,
        )
    }

    private fun isWatched(path: String): Boolean {
        val dot = path.lastIndexOf('.')
        if (dot < 0) return false
        val ext = path.substring(dot + 1).lowercase()
        return ext in WATCHED_EXTENSIONS
    }

    private fun isUnderProject(absPath: String): Boolean {
        val base = project.basePath ?: return false
        return absPath.startsWith(base)
    }

    private fun relativize(absPath: String): String {
        val base = project.basePath ?: return absPath
        return if (absPath.length > base.length && absPath.startsWith(base)) {
            absPath.substring(base.length).trimStart('/', '\\')
        } else absPath
    }

    private inner class VfsListener : BulkFileListener {
        override fun after(events: MutableList<out VFileEvent>) {
            val collected = ArrayList<String>()
            for (event in events) {
                val path = when (event) {
                    is VFileContentChangeEvent -> event.file.path
                    is VFileCreateEvent -> event.path
                    is VFileDeleteEvent -> event.file.path
                    is VFileMoveEvent -> event.file.path
                    is VFileCopyEvent -> event.file.path + "/" + event.newChildName
                    is VFilePropertyChangeEvent -> event.file.path
                    else -> continue
                }
                if (!isUnderProject(path)) continue
                if (!isWatched(path)) continue
                collected.add(relativize(path))
            }
            if (collected.isEmpty()) return
            val delay = lock.withLock {
                pendingPaths.addAll(collected)
                coalescerTiming.scheduleAndNextDelay(
                    now = System.currentTimeMillis(),
                    debounceMs = WATCHER_DEBOUNCE_MS,
                    maxWaitMs = WATCHER_MAX_WAIT_MS,
                )
            }
            invalidateAlarm.cancelAllRequests()
            invalidateAlarm.addRequest({
                val toDrain = lock.withLock {
                    coalescerTiming.fired()
                    if (pendingPaths.isEmpty()) return@addRequest
                    val snapshot = pendingPaths.toList()
                    pendingPaths.clear()
                    snapshot
                }
                try {
                    notifyChanged(toDrain)
                } catch (e: Exception) {
                    LOG.warn("GraphSnapshotCache(${project.name}) notify failed", e)
                }
            }, delay)
        }
    }
}
