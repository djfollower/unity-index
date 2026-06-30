<script lang="ts">
  // Day 9.1 — assets / code / combined toggle. Three-segment pill anchored
  // top-centre of the canvas. Writes to `filterStore.domain`; reducers in
  // App.svelte read the value via the existing revision-bumped refs.
  //
  // We do NOT recompute `hiddenKinds` when the domain changes — the toggle
  // composes with per-kind checkboxes via AND in the reducer, so a user
  // toggling code-only and then unchecking `class` in the sidebar gets
  // exactly what they asked for (code domain MINUS class nodes).

  import type { FilterDomain } from '@unity-index/graph-core';
  import { filterStore } from './filterStore.svelte';

  const OPTIONS: ReadonlyArray<{ id: FilterDomain; label: string; hint: string }> = [
    { id: 'assets', label: 'Assets', hint: 'Prefabs, scenes, scripts, SOs — hide C# class graph' },
    { id: 'combined', label: 'Combined', hint: 'Show everything (default)' },
    { id: 'code', label: 'Code', hint: 'C# classes, methods, inheritance — hide asset nodes' },
  ] as const;
</script>

<div class="toggle" role="radiogroup" aria-label="Graph domain">
  {#each OPTIONS as option (option.id)}
    {@const active = filterStore.domain === option.id}
    <button
      type="button"
      role="radio"
      aria-checked={active}
      class:active
      title={option.hint}
      onclick={() => filterStore.setDomain(option.id)}
    >
      {option.label}
    </button>
  {/each}
</div>

<style>
  /* Day 9 — wide layout: pill at top-centre. FilterSidebar owns top-left,
     SearchBar top-right; below ~760px those three collide, so the narrow
     @media block below restacks chrome vertically with the toggle on top,
     search beneath it, then the filter sidebar. */
  .toggle {
    position: absolute;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    display: inline-flex;
    background: rgba(28, 28, 28, 0.92);
    border: 1px solid #333;
    border-radius: 999px;
    padding: 2px;
    z-index: 5;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
    max-width: calc(100% - 20px);
  }
  @media (max-width: 760px) {
    .toggle {
      left: 10px;
      right: 10px;
      transform: none;
      justify-content: center;
    }
  }
  button {
    appearance: none;
    border: none;
    background: transparent;
    color: #bbb;
    padding: 3px 12px;
    font-size: 11.5px;
    font-family: inherit;
    cursor: pointer;
    border-radius: 999px;
    transition: background 0.12s, color 0.12s;
    white-space: nowrap;
  }
  button:hover:not(.active) {
    color: #fff;
    background: rgba(255, 255, 255, 0.04);
  }
  button.active {
    background: #4f7cff;
    color: #fff;
    font-weight: 600;
  }
</style>
