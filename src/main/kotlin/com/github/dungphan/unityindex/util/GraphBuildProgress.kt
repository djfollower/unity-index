package com.github.dungphan.unityindex.util

/**
 * Progress reporter passed into `UnityAssetGraphBuilder.build` so long-running
 * asset scans can surface real per-file counters to the graph webview.
 *
 * The reporter is invoked frequently — implementations MUST throttle before
 * forwarding to the wire (see `GraphHostBridge.ProgressEmitter`). Passing
 * `null` disables reporting; that's the default for MCP tool callers where
 * the caller has no channel back to a UI.
 *
 * `total` is optional because the Rider builder walks the VFS lazily and
 * doesn't know the file count up front — the webview renders `current` alone
 * as an indeterminate progress line when `total` is null.
 */
fun interface GraphBuildProgress {
    fun report(phase: String, current: Int, total: Int?, message: String?)
}
