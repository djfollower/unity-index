// Day 3: thin wrapper that fetches a GraphSnapshot from the host bridge.
// The host (VS Code or Rider) handles the actual unity_graph_snapshot call
// in-process — see hostHandlers.ts / GraphHostHandlers.kt.
//
// 0.5.10 — inter-message timeout: the host emits `progress` heartbeats every
// ~15s while building; each heartbeat resets this timer. A very big Unity
// project's cold-start scan can take minutes, but we still catch a wedged
// host (no heartbeat, no response) within 60s. Callers may pass `onProgress`
// to render an "indexing…" UI.

import {
  request,
  SNAPSHOT_GRAPH_TYPE,
  type HostBridge,
  type ProgressPayload,
  type SnapshotRequest,
  type SnapshotResponse,
} from '@unity-index/graph-core';

const SNAPSHOT_TIMEOUT_MS = 60_000;

export async function fetchSnapshot(
  bridge: HostBridge,
  req: Partial<SnapshotRequest> = {},
  options: { onProgress?: (payload: ProgressPayload | undefined) => void } = {},
): Promise<SnapshotResponse> {
  return request<Partial<SnapshotRequest>, SnapshotResponse>(
    bridge,
    SNAPSHOT_GRAPH_TYPE,
    req,
    {
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    },
  );
}

// Two stable error strings the host throws that deserve human-friendly copy
// in the webview. Anything else renders verbatim — host errors are short
// enough to display as-is and we don't want to silently swallow them.
export function friendlyErrorMessage(raw: string): string {
  // VS Code's projectResolver throws a JSON blob from its ToolCallResult;
  // try to parse `error:` out of it. On failure, fall through to raw.
  let key = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: string; message?: string };
    if (typeof parsed.error === 'string') key = parsed.error;
  } catch {
    // not JSON — treat the raw string as the key
  }

  switch (key) {
    case 'no_project_open':
      return 'No workspace is open. Open a Unity project folder and retry.';
    case 'multiple_projects_open':
      return 'Multiple workspace folders are open. Day 3 picks the first Unity project — multi-project picker lands in Day 13.';
    case 'project_not_found':
      return 'The specified project path is not part of any open workspace folder.';
    case 'server_not_started':
      return 'Unity Index MCP server is not running. Run "Unity Index: Start Server" and retry.';
    default:
      return raw;
  }
}
