package com.github.dungphan.unityindex.util

/**
 * Canonical warning codes emitted by the graph pipeline. String literals MUST
 * match the TS constants in `graph/core/src/snapshot-wire.ts` —
 * lockstep is enforced by the cross-impl byte-equivalence test (Day 6 Task 11).
 *
 * Day-1..Day-5 warnings were emitted as inline string literals scattered
 * through `UnityAssetGraphBuilder.kt`; Day 6 consolidates them here so neither
 * side can drift without a compile-time touch on this file.
 */
object GraphWarningCodes {
    const val SUBFILE_KIND_IGNORED = "subfile_kind_ignored"
    const val DANGLING_CSHARP_TARGETS = "dangling_csharp_targets"
    const val UNRESOLVED_TARGETS = "unresolved_targets"
    const val ID_UNRESOLVED = "id_unresolved"
    const val NEIGHBORS_TRUNCATED = "neighbors_truncated"

    // Day 7 — incremental snapshot updates.
    const val DELTA_RESET = "delta_reset"
    const val DELTA_AFFECTED_PATHS_TRUNCATED = "delta_affected_paths_truncated"
}

/**
 * Day 7 — budgets for `unity_graph_snapshot_delta`. Mirrors the constants in
 * `graph/core/src/snapshot-delta-wire.ts`. Drift here would let one host serve
 * a delta the other refuses to apply.
 */
object GraphDeltaBudgets {
    /** How many past revisions to keep so a client that fell behind can still
     *  be served a delta. Beyond that we reset. */
    const val MAX_HISTORY = 64

    /** Soft cap on `affected_paths` in the wire payload. Bulk operations
     *  (folder rename, asset re-import) can touch thousands of files; we
     *  truncate and emit `DELTA_AFFECTED_PATHS_TRUNCATED`. */
    const val AFFECTED_PATHS_CAP = 256
}
