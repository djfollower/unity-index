<script lang="ts">
  // Day 5 Task 4: fuzzy search bar. Top-right overlay, debounces input into
  // the filter store. The actual matching runs in App.svelte's $effect so
  // recomputation also fires when the graph itself changes (post-snapshot
  // reload), not just on keystrokes.

  import { untrack } from 'svelte';
  import { filterStore } from './filterStore.svelte';

  interface Props {
    /** Total number of nodes (for the "X of N" hint). */
    totalNodes: number;
  }

  let { totalNodes }: Props = $props();

  let inputEl: HTMLInputElement | undefined = $state();
  let local = $state(filterStore.search);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Keep the local input value in sync if the store changes from elsewhere
  // (e.g. hydration on snapshot load). Without this, a stored "player" query
  // would apply to the graph but the input box would be blank.
  //
  // CRITICAL: `local` is read via `untrack` so the effect only fires when the
  // store changes — otherwise typing into the input bumps `local`, the effect
  // re-runs before the 120ms debounce has updated the store, sees a
  // mismatch, and resets `local` back to the empty store value (swallowing
  // the keystroke).
  $effect(() => {
    const next = filterStore.search;
    if (untrack(() => local) !== next) {
      local = next;
    }
  });

  function onInput(e: Event) {
    local = (e.target as HTMLInputElement).value;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      filterStore.setSearch(local);
    }, 120);
  }

  function clear() {
    local = '';
    if (debounceTimer) clearTimeout(debounceTimer);
    filterStore.setSearch('');
    inputEl?.focus();
  }

  const active = $derived(filterStore.isSearchActive());
  const matchCount = $derived(filterStore.matched.size);
</script>

<div class="searchbar" class:active>
  <svg class="icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M11.7 11A5.5 5.5 0 1 0 11 11.7l3.15 3.15a.5.5 0 0 0 .7-.7L11.7 11ZM7 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Z" />
  </svg>
  <input
    bind:this={inputEl}
    type="text"
    placeholder="Search nodes…"
    value={local}
    oninput={onInput}
    spellcheck="false"
    autocomplete="off"
  />
  {#if active}
    <span class="count">{matchCount.toLocaleString()} / {totalNodes.toLocaleString()}</span>
    <button class="clear" onclick={clear} title="Clear search">×</button>
  {/if}
</div>

<style>
  .searchbar {
    position: absolute;
    top: 10px;
    right: 10px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: rgba(28, 28, 28, 0.92);
    border: 1px solid #333;
    border-radius: 6px;
    width: 280px;
    font-size: 12px;
    z-index: 5;
  }
  /* Day 9 — narrow mode: slot below the DomainToggle banner. Toggle is
     ~34px tall (padding 2 + button padding 3 + 11.5px font + line). 10px
     for top margin + 34 for toggle + 6px gap → top: 50px. */
  @media (max-width: 760px) {
    .searchbar {
      top: 50px;
      left: 10px;
      right: 10px;
      width: auto;
    }
  }
  .searchbar.active {
    border-color: #4f7cff;
  }
  .icon {
    width: 13px;
    height: 13px;
    color: #888;
    flex-shrink: 0;
  }
  input {
    flex: 1 1 auto;
    background: transparent;
    border: none;
    outline: none;
    color: #ddd;
    font-size: 12px;
    font-family: inherit;
    min-width: 0;
  }
  input::placeholder {
    color: #666;
  }
  .count {
    color: #888;
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    flex-shrink: 0;
  }
  .clear {
    background: transparent;
    border: none;
    color: #888;
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0 2px;
    flex-shrink: 0;
  }
  .clear:hover {
    color: #fff;
  }
</style>
