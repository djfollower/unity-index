<script lang="ts">
  // Day 5 Task 3: left-rail kind filter. One row per NodeKind present in the
  // current snapshot, with a color swatch + count + toggle. Collapses to a
  // narrow strip when not needed so it doesn't eat canvas real estate.
  //
  // The component is pure presentation: it reads `presentKinds` from props
  // and writes back via `filterStore`. No graph access, no host calls. That
  // keeps the wiring side of Day 5 (Task 7 — load/save round-trip) trivial.

  import { filterStore } from './filterStore.svelte';
  import { nodeStyleFor } from './style';
  import Presets from './Presets.svelte';

  interface Props {
    /** Map of kind → node count, derived from the current Graphology graph
     *  by `collectPresentKinds`. Recomputed by App.svelte on snapshot load. */
    presentKinds: Map<string, number>;
    /** Day 9.3 — true when no host bridge is present (standalone dev mode).
     *  Disables presets that need to round-trip to the LSP/RD. */
    standalone: boolean;
    /** Day 9.3 — true while a preset fetch is in flight; disables the
     *  preset buttons and shows a loading label. */
    presetBusy: boolean;
    onShowMonoBehaviours: () => void;
  }

  let {
    presentKinds,
    standalone,
    presetBusy,
    onShowMonoBehaviours,
  }: Props = $props();
  let collapsed = $state(false);

  // Stable display order: assets first (most common), then code kinds. Within
  // each bucket, alphabetical. Sub-file kinds are never rendered as nodes so
  // they shouldn't appear in `presentKinds`, but we filter them defensively.
  const SUBFILE = new Set(['component_instance', 'component_field']);
  const ASSET_ORDER = ['scene', 'prefab', 'prefab_variant', 'script', 'so', 'asset', 'addressable_group'];

  const rows = $derived.by(() => {
    const entries = Array.from(presentKinds.entries()).filter(([k]) => !SUBFILE.has(k));
    const indexOf = (k: string) => {
      const i = ASSET_ORDER.indexOf(k);
      return i === -1 ? ASSET_ORDER.length + k.charCodeAt(0) : i;
    };
    entries.sort((a, b) => indexOf(a[0]) - indexOf(b[0]) || a[0].localeCompare(b[0]));
    return entries.map(([kind, count]) => ({
      kind,
      count,
      color: nodeStyleFor(kind).color,
      hidden: filterStore.hiddenKinds.has(kind),
    }));
  });

  const anyHidden = $derived(filterStore.hiddenKinds.size > 0);

  function showAll() {
    filterStore.showAllKinds();
  }
  function hideAll() {
    filterStore.hideAllKinds(rows.map((r) => r.kind));
  }
</script>

{#if rows.length > 0}
  <aside class="sidebar" class:collapsed>
    {#if collapsed}
      <!-- Strip-mode: a single tall button so any click on the 24px strip
           re-expands the sidebar; vertical "Filter" hint makes the affordance
           obvious without an icon glossary. -->
      <button class="strip" onclick={() => (collapsed = false)} title="Show filters">
        <span class="strip-label">▸ Filter</span>
      </button>
    {:else}
      <header>
        <span class="title">Filter</span>
        <div class="bulk">
          <button onclick={showAll} disabled={!anyHidden}>Show all</button>
          <button onclick={hideAll} disabled={rows.length === 0}>Hide all</button>
          <button
            class="hide-toggle"
            onclick={() => (collapsed = true)}
            title="Collapse filter panel"
            aria-label="Collapse filter panel"
          >–</button>
        </div>
      </header>
      <Presets {standalone} busy={presetBusy} {onShowMonoBehaviours} />
      <ul>
        {#each rows as row (row.kind)}
          <li>
            <label>
              <input
                type="checkbox"
                checked={!row.hidden}
                onchange={() => filterStore.toggleKind(row.kind)}
              />
              <span class="swatch" style="background:{row.color}"></span>
              <span class="kind">{row.kind}</span>
              <span class="count">{row.count.toLocaleString()}</span>
            </label>
          </li>
        {/each}
      </ul>
    {/if}
  </aside>
{/if}

<style>
  .sidebar {
    position: absolute;
    top: 10px;
    left: 10px;
    width: 200px;
    max-height: calc(100% - 20px);
    background: rgba(28, 28, 28, 0.92);
    color: #ddd;
    border: 1px solid #333;
    border-radius: 6px;
    font-size: 12px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    z-index: 5;
  }
  .sidebar.collapsed {
    width: 24px;
  }
  /* Day 9 — narrow mode: slot below toggle (top:10, ~34h) + search
     (top:50, ~32h) + gap → top: 92. Take the full canvas width. */
  @media (max-width: 760px) {
    .sidebar {
      top: 92px;
      left: 10px;
      right: 10px;
      width: auto;
      max-height: calc(100% - 102px);
    }
    .sidebar.collapsed {
      width: 24px;
      right: auto;
    }
  }
  .strip {
    /* Whole-strip button when collapsed — easier hit target than the old
       18px icon. Vertical "Filter" label so the affordance is unambiguous. */
    width: 100%;
    height: 100%;
    border: none;
    background: transparent;
    color: #ddd;
    cursor: pointer;
    padding: 8px 0;
    display: flex;
    align-items: flex-start;
    justify-content: center;
  }
  .strip:hover {
    background: rgba(255, 255, 255, 0.05);
  }
  .strip-label {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #aaa;
    font-weight: 600;
  }
  .hide-toggle {
    /* Compact "–" button inline with Show all / Hide all so users find the
       collapse action by looking at the same row as the bulk actions. */
    flex: 0 0 22px !important;
    padding: 0 !important;
    font-size: 14px;
    line-height: 1;
  }
  header {
    padding: 8px 10px;
    border-bottom: 1px solid #333;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .title {
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-size: 11px;
    color: #aaa;
  }
  .bulk {
    display: flex;
    gap: 6px;
  }
  .bulk button {
    flex: 1;
    padding: 3px 6px;
    font-size: 11px;
    background: #2a2a2a;
    color: #ddd;
    border: 1px solid #444;
    border-radius: 3px;
    cursor: pointer;
  }
  .bulk button:hover:not(:disabled) {
    background: #333;
  }
  .bulk button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    overflow-y: auto;
    flex: 1 1 auto;
  }
  li label {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    cursor: pointer;
    user-select: none;
  }
  li label:hover {
    background: rgba(255, 255, 255, 0.04);
  }
  input[type='checkbox'] {
    accent-color: #4f7cff;
    cursor: pointer;
  }
  .swatch {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    flex-shrink: 0;
  }
  .kind {
    flex: 1 1 auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11.5px;
  }
  .count {
    color: #888;
    font-variant-numeric: tabular-nums;
    font-size: 11px;
  }
</style>
