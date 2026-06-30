// Day 7 Task 6 — thin wrapper around the host bridge for the
// `unity_graph_snapshot_delta` MCP tool. Mirrors lib/snapshot.ts (which
// wraps the full-snapshot tool).
//
// The cache on the host side either returns a SnapshotDelta or a reset
// payload with a full snapshot — callers branch on `response.reset`.

import {
  request,
  SNAPSHOT_DELTA_GRAPH_TYPE,
  type HostBridge,
  type SnapshotDeltaRequest,
  type SnapshotDeltaResponse,
} from '@unity-index/graph-core';

const DELTA_TIMEOUT_MS = 30_000;

export async function fetchSnapshotDelta(
  bridge: HostBridge,
  sinceRevision: number,
  req: Partial<SnapshotDeltaRequest> = {},
): Promise<SnapshotDeltaResponse> {
  return request<Partial<SnapshotDeltaRequest>, SnapshotDeltaResponse>(
    bridge,
    SNAPSHOT_DELTA_GRAPH_TYPE,
    { ...req, since_revision: sinceRevision },
    { timeoutMs: DELTA_TIMEOUT_MS },
  );
}
