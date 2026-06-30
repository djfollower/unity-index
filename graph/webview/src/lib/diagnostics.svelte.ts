// Day 10 — webview side of the diagnostics overlay.
//
// One reactive store fed by the `unity_graph_diagnostics` bridge tool;
// the Sigma `nodeReducer` reads it on every frame to layer three
// independent features on top of the existing palette:
//
//   1. badges         — `byNode.get(id)` exposed to the renderer / a DOM
//                       overlay; a node with `errors > 0` shows a red dot
//   2. heatmap mode   — when `heatmap === true`, recolor + scale nodes by
//                       diagnostic max_severity and reference count
//   3. errors-only    — when `errorsOnly === true`, the reducer hides
//                       every node whose entry has `errors === 0`
//
// Refresh policy: we batch-fetch on snapshot load and after every
// incremental delta. The set of nodes we ask about is the same
// `script` / class / interface / struct / enum / method set the user is
// looking at — sub-file kinds (`field`, `component_field`) never map to
// a diagnostics-bearing file and would waste a slot. Caller decides
// which IDs to pass; this module just owns the cache + RPC.

import {
  DIAGNOSTICS_GRAPH_TYPE,
  DIAGNOSTICS_MAX_NODES,
  request,
  type DiagnosticsBatchRequest,
  type DiagnosticsBatchResponse,
  type HostBridge,
  type NodeDiagnostics,
} from '@unity-index/graph-core';

export {
  collectDiagnosticsTargets,
  heatmapColorFor,
  heatmapSizeBoostFor,
  isDiagnosticsRelevant,
} from './diagnostics';

// Match the codeEdges timeout — both tools talk to the same diagnostics
// cache on the Rider side and the same LSP store on the VS Code side, so
// the cold-start envelope is comparable.
const DIAGNOSTICS_TIMEOUT_MS = 20_000;

/** Reactive store. Class with `$state` fields so Svelte 5 picks up the
 *  changes without per-field subscription; mirrors `FilterStore`. */
class DiagnosticsStore {
  /** Per-node aggregates keyed by graph node id. Absent entries mean
   *  "not yet fetched" (treat as clean, but don't render a "clean" badge
   *  — that's reserved for confirmed-clean nodes only). */
  byNode = $state<Map<string, NodeDiagnostics>>(new Map());
  /** Node ids we *did* ask about. Used by the renderer to distinguish
   *  "no data" from "confirmed clean" — only confirmed-clean nodes get
   *  the `'none'` palette entry; unknown nodes draw with the kind
   *  palette. */
  resolved = $state<Set<string>>(new Set());
  /** When true, badges render and heatmap / errors-only filters become
   *  available. The toggle lives in the legend / filter sidebar; if the
   *  user has it off we don't even fire the RPC. */
  enabled = $state<boolean>(false);
  /** Day 10 — heatmap mode. Composes with `enabled` (heatmap implies
   *  enabled). When set, the nodeReducer recolors by max_severity and
   *  scales size by reference count. */
  heatmap = $state<boolean>(false);
  /** Day 10 — "show only nodes with errors" filter. When set, the
   *  reducer hides any resolved node with `errors === 0`. Unresolved
   *  nodes pass through untouched (no data = don't pretend to know). */
  errorsOnly = $state<boolean>(false);
  /** Bumps on every state change. Same pattern as filterStore — lets the
   *  caller debounce a `sigma.refresh()` without subscribing per field. */
  revision = $state<number>(0);
  /** Most recent generated_at timestamp, surfaced in the legend so the
   *  user can spot a stale overlay after a long build. */
  lastFetchedAt = $state<string | undefined>(undefined);
  /** Most recent error message from a failed fetch — surfaced inline so
   *  a wedged refresh isn't silent. Cleared on the next successful
   *  fetch. */
  lastError = $state<string | undefined>(undefined);

  private inFlight: AbortController | undefined = undefined;

  setEnabled(v: boolean): void {
    if (this.enabled === v) return;
    this.enabled = v;
    if (!v) {
      // Turning the overlay off implicitly disables the dependent modes.
      this.heatmap = false;
      this.errorsOnly = false;
    }
    this.revision++;
  }

  setHeatmap(v: boolean): void {
    if (this.heatmap === v) return;
    this.heatmap = v;
    if (v) this.enabled = true;
    this.revision++;
  }

  setErrorsOnly(v: boolean): void {
    if (this.errorsOnly === v) return;
    this.errorsOnly = v;
    if (v) this.enabled = true;
    this.revision++;
  }

  /** Clear the cache. Called on full-snapshot reload so a stale entry
   *  from the previous graph doesn't survive. */
  reset(): void {
    if (this.byNode.size === 0 && this.resolved.size === 0) return;
    this.byNode = new Map();
    this.resolved = new Set();
    this.lastError = undefined;
    this.revision++;
  }

  /** Merge a batch response into the cache. Resolved-but-empty entries
   *  ARE recorded — that's how the renderer knows a node is confirmed
   *  clean. */
  ingest(response: DiagnosticsBatchResponse): void {
    const next = new Map(this.byNode);
    const resolved = new Set(this.resolved);
    for (const d of response.diagnostics) {
      next.set(d.node_id, d);
      resolved.add(d.node_id);
    }
    this.byNode = next;
    this.resolved = resolved;
    this.lastFetchedAt = response.generated_at;
    this.lastError = undefined;
    this.revision++;
  }

  /** Fetch diagnostics for `nodeIds`. Splits into pages of
   *  `DIAGNOSTICS_MAX_NODES` so the host's request validation doesn't
   *  reject a big batch; pages run sequentially because the host's read
   *  lock would serialise them anyway. Aborts any in-flight refresh
   *  before starting a new one — the caller usually wants the freshest
   *  visible-node set, not whatever was visible 5 seconds ago. */
  async refresh(bridge: HostBridge, nodeIds: Iterable<string>): Promise<void> {
    if (!this.enabled) return;
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    const ids = Array.from(new Set(nodeIds));
    if (ids.length === 0) return;
    try {
      for (let i = 0; i < ids.length; i += DIAGNOSTICS_MAX_NODES) {
        if (controller.signal.aborted) return;
        const page = ids.slice(i, i + DIAGNOSTICS_MAX_NODES);
        const req: DiagnosticsBatchRequest = {
          project_path: '',
          node_ids: page,
          // Heatmap / errors-only need counts only; we still pull a few
          // top messages so the badge tooltip has something to show on
          // hover. Wire default (3) is fine for that.
          include_messages: true,
        };
        const res = await request<DiagnosticsBatchRequest, DiagnosticsBatchResponse>(
          bridge,
          DIAGNOSTICS_GRAPH_TYPE,
          req,
          { timeoutMs: DIAGNOSTICS_TIMEOUT_MS },
        );
        if (controller.signal.aborted) return;
        this.ingest(res);
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      this.lastError = e instanceof Error ? e.message : String(e);
      this.revision++;
    } finally {
      if (this.inFlight === controller) this.inFlight = undefined;
    }
  }
}

export const diagnosticsStore = new DiagnosticsStore();
export { DiagnosticsStore };
