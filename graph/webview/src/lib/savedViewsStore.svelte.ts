// Day 11 Task 2: reactive store for saved views. Mirrors filterStore's
// class-with-$state shape so the same pattern works in Svelte 5 components
// and in Vitest (no DOM ceremony).
//
// Persistence: the store DOES NOT touch the bridge directly. Callers pass
// in a HostBridge when they want to hydrate / persist — same split as
// filterStore ↔ filterSync. That keeps the store unit-testable.
//
// Deduplication: `upsert` is name-keyed (last-write-wins). Names are
// user-supplied, so uniqueness is a UX invariant, not a schema one.

import type { SavedView, HostBridge } from '@unity-index/graph-core';
import { deleteSavedView, listSavedViews, saveSavedView } from './savedViewsSync';

class SavedViewsStore {
  /** Snapshot of the host-side list. Sorted by createdAt descending on
   *  hydrate; upsert keeps the newest write at the top so the dropdown
   *  shows most-recently-saved first. */
  views = $state<SavedView[]>([]);
  /** true while a bridge round-trip is in flight. UI can disable the
   *  dropdown or show a spinner while this is true. */
  loading = $state<boolean>(false);
  /** Last error message from a bridge call; null when the last call
   *  succeeded. UI surfaces this in the dropdown. */
  error = $state<string | null>(null);

  /** Fetch the list from the host and replace `views`. Idempotent — safe
   *  to call on panel focus / after import / etc. */
  async hydrate(bridge: HostBridge): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const fetched = await listSavedViews(bridge);
      this.views = [...fetched].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      );
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  /** Insert or replace a view by name and persist it via the bridge.
   *  Local state updates on success — a failed round-trip leaves the
   *  previous list intact so a save that never reached storage doesn't
   *  falsely appear in the dropdown. */
  async upsert(bridge: HostBridge, view: SavedView): Promise<void> {
    this.error = null;
    try {
      await saveSavedView(bridge, view);
      const rest = this.views.filter((v) => v.name !== view.name);
      this.views = [view, ...rest];
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  async remove(bridge: HostBridge, name: string): Promise<void> {
    this.error = null;
    try {
      const deleted = await deleteSavedView(bridge, name);
      if (deleted) {
        this.views = this.views.filter((v) => v.name !== name);
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  find(name: string): SavedView | undefined {
    return this.views.find((v) => v.name === name);
  }

  /** Test-only reset. Vitest constructs a fresh instance via `new
   *  SavedViewsStore()`, so this is only for callers that already hold
   *  the singleton. */
  clear(): void {
    this.views = [];
    this.error = null;
    this.loading = false;
  }
}

export const savedViewsStore = new SavedViewsStore();
export { SavedViewsStore };
