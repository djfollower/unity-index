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
}
