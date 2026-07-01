// Day 11 Task 2: bridge round-trip for saved views. Mirrors filterSync.ts —
// kept out of the store so the store stays testable without a HostBridge
// stub. Storage lives on the host (VS Code workspaceState / Rider project
// service); this module is just the wire.

import {
  SAVED_VIEWS_DELETE_TYPE,
  SAVED_VIEWS_LIST_TYPE,
  SAVED_VIEWS_SAVE_TYPE,
  request,
  type HostBridge,
  type SavedView,
  type SavedViewsDeleteRequest,
  type SavedViewsDeleteResponse,
  type SavedViewsListRequest,
  type SavedViewsListResponse,
  type SavedViewsSaveRequest,
  type SavedViewsSaveResponse,
} from '@unity-index/graph-core';

const TIMEOUT_MS = 5_000;

export async function listSavedViews(bridge: HostBridge): Promise<SavedView[]> {
  const res = await request<SavedViewsListRequest, SavedViewsListResponse>(
    bridge,
    SAVED_VIEWS_LIST_TYPE,
    {},
    { timeoutMs: TIMEOUT_MS },
  );
  return res.views ?? [];
}

export async function saveSavedView(
  bridge: HostBridge,
  view: SavedView,
): Promise<void> {
  await request<SavedViewsSaveRequest, SavedViewsSaveResponse>(
    bridge,
    SAVED_VIEWS_SAVE_TYPE,
    { view },
    { timeoutMs: TIMEOUT_MS },
  );
}

export async function deleteSavedView(
  bridge: HostBridge,
  name: string,
): Promise<boolean> {
  const res = await request<SavedViewsDeleteRequest, SavedViewsDeleteResponse>(
    bridge,
    SAVED_VIEWS_DELETE_TYPE,
    { name },
    { timeoutMs: TIMEOUT_MS },
  );
  return res.deleted;
}
