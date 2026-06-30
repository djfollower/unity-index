// Day 5 Task 2: reactive filter state. Holds the user's kind toggles + the
// active fuzzy search query, plus the derived `matched` set so the Sigma
// reducers can read it without recomputing per frame.
//
// Why a class with $state fields (vs a plain module of let-bindings): Svelte
// 5 only treats $state as reactive when it's on a class field or inside a
// `.svelte` component. Putting it on a class also lets us export a singleton
// AND construct a fresh one in Vitest without DOM/runtime ceremony.
//
// The store is intentionally dumb — it just stores state and emits change
// notifications. Computing the matched set on search change is the caller's
// job (App.svelte runs computeMatches and feeds it back via setMatched).
// Keeps Graphology out of this module so it stays tree-shakeable in tests.

import type { FilterDomain } from '@unity-index/graph-core';
import { isFilterDomain } from './domain';

class FilterStore {
  hiddenKinds = $state<Set<string>>(new Set());
  search = $state<string>('');
  matched = $state<Set<string>>(new Set());
  // Day 9 — bulk domain macro. Composes with `hiddenKinds` via AND in the
  // reducers (both must allow a kind for it to render).
  domain = $state<FilterDomain>('combined');
  /** Bumps on every state change. Callers can use this in $effect to trigger
   *  side effects (sigma.refresh, debounced persist) without subscribing to
   *  each field individually. */
  revision = $state<number>(0);

  setHiddenKinds(kinds: Iterable<string>): void {
    this.hiddenKinds = new Set(kinds);
    this.revision++;
  }

  toggleKind(kind: string): void {
    const next = new Set(this.hiddenKinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    this.hiddenKinds = next;
    this.revision++;
  }

  showAllKinds(): void {
    if (this.hiddenKinds.size === 0) return;
    this.hiddenKinds = new Set();
    this.revision++;
  }

  hideAllKinds(kinds: Iterable<string>): void {
    this.hiddenKinds = new Set(kinds);
    this.revision++;
  }

  setDomain(domain: FilterDomain): void {
    if (this.domain === domain) return;
    this.domain = domain;
    this.revision++;
  }

  setSearch(query: string): void {
    if (this.search === query) return;
    this.search = query;
    this.revision++;
  }

  setMatched(ids: Set<string>): void {
    this.matched = ids;
    // matched is a derived view of search; don't bump revision (avoids a
    // double-fire when App.svelte recomputes matches in response to a
    // search change).
  }

  isHidden(kind: string): boolean {
    return this.hiddenKinds.has(kind);
  }

  isSearchActive(): boolean {
    return this.search.trim().length > 0;
  }

  snapshot(): { hiddenKinds: string[]; search: string; domain: FilterDomain } {
    return {
      hiddenKinds: Array.from(this.hiddenKinds),
      search: this.search,
      domain: this.domain,
    };
  }

  /** Coerces a wire `FilterState.domain` (which may be undefined or an
   *  unknown string from a future host) into a valid value. */
  static coerceDomain(raw: unknown): FilterDomain {
    return isFilterDomain(raw) ? raw : 'combined';
  }
}

export const filterStore = new FilterStore();
export { FilterStore };
