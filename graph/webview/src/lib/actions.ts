// Day 4: thin RPC wrappers for the three click-through actions. Centralising
// here so the double-click handler (App.svelte) and the right-click menu
// (ContextMenu.svelte) share dispatch logic — eligibility decisions live in
// `eligibility.ts`; this file is "given a node, talk to the host".
//
// Each function throws on failure. Callers (App.svelte / ContextMenu) surface
// the error message in the status bar; no UI is owned here.

import {
  request,
  OPEN_FILE_TYPE,
  FIND_USAGES_TYPE,
  REVEAL_IN_EXPLORER_TYPE,
  type FindUsagesRequest,
  type FindUsagesResponse,
  type HostBridge,
  type OpenFileRequest,
  type OpenFileResponse,
  type RevealInExplorerRequest,
  type RevealInExplorerResponse,
} from '@unity-index/graph-core';

// Open-file lands the user in the editor; 10s is plenty for any IDE that
// isn't completely wedged. Find-usages takes the same budget because Rider's
// FindUsages indexer can take a moment to wake up on cold workspaces.
const ACTION_TIMEOUT_MS = 10_000;

export function openFile(
  bridge: HostBridge,
  req: OpenFileRequest,
): Promise<OpenFileResponse> {
  return request<OpenFileRequest, OpenFileResponse>(
    bridge,
    OPEN_FILE_TYPE,
    req,
    { timeoutMs: ACTION_TIMEOUT_MS },
  );
}

export function findUsages(
  bridge: HostBridge,
  req: FindUsagesRequest,
): Promise<FindUsagesResponse> {
  return request<FindUsagesRequest, FindUsagesResponse>(
    bridge,
    FIND_USAGES_TYPE,
    req,
    { timeoutMs: ACTION_TIMEOUT_MS },
  );
}

export function revealInExplorer(
  bridge: HostBridge,
  req: RevealInExplorerRequest,
): Promise<RevealInExplorerResponse> {
  return request<RevealInExplorerRequest, RevealInExplorerResponse>(
    bridge,
    REVEAL_IN_EXPLORER_TYPE,
    req,
    { timeoutMs: ACTION_TIMEOUT_MS },
  );
}

// Translate the host's stable error keys (see graph/core messages.ts) into
// copy fit for the status bar. Anything unknown passes through verbatim.
export function friendlyActionError(raw: string): string {
  switch (raw) {
    case 'file_not_found':
      return 'File not found on disk.';
    case 'path_outside_project':
      return 'Path is outside the current workspace.';
    case 'no_project_open':
      return 'No project bound to the graph panel.';
    case 'unsupported_kind':
      return 'This node has nothing to open.';
    default:
      return raw;
  }
}
