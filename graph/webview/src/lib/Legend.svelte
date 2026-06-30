<script lang="ts">
  // Day 9.2 — code-edge legend. The FilterSidebar doubles as the node-kind
  // legend (it carries colour swatches per kind); edges have no comparable
  // surface, so an inheritance arrow and a call arrow that share screen
  // space were previously indistinguishable. This component is the edge
  // companion.
  //
  // Visibility rules:
  //  - Hidden when the domain toggle is `assets` (no code edges to explain).
  //  - Hidden when the current snapshot has no code edges (avoids legend
  //    clutter on a pure-asset project). Caller passes `present` so we
  //    don't traverse the graph ourselves.

  import type { EdgeKind } from '@unity-index/graph-core';
  import { filterStore } from './filterStore.svelte';
  import { edgeStyleFor } from './style';

  interface Props {
    /** Set of code edge kinds actually present in the current graph. */
    present: Set<EdgeKind>;
  }

  let { present }: Props = $props();
  let collapsed = $state(false);

  // Order chosen to match the conceptual hierarchy (is-a → replaces →
  // calls → references) so the legend reads top-down from "strong" to
  // "weak" relationships.
  const CODE_EDGES: ReadonlyArray<{ kind: EdgeKind; label: string }> = [
    { kind: 'class_inherits_from', label: 'inherits' },
    { kind: 'class_implements_interface', label: 'implements' },
    { kind: 'method_overrides_method', label: 'overrides' },
    { kind: 'method_calls_method', label: 'calls' },
    { kind: 'class_references_class', label: 'references' },
  ] as const;

  const rows = $derived(
    CODE_EDGES
      .filter((row) => present.has(row.kind))
      .map((row) => ({ ...row, style: edgeStyleFor(row.kind) })),
  );

  const visible = $derived(filterStore.domain !== 'assets' && rows.length > 0);
</script>

{#if visible}
  <aside class="legend" class:collapsed>
    <button class="collapse" onclick={() => (collapsed = !collapsed)} title={collapsed ? 'Show legend' : 'Hide legend'}>
      {collapsed ? '‹' : '›'}
    </button>
    {#if !collapsed}
      <header>Code edges</header>
      <ul>
        {#each rows as row (row.kind)}
          <li>
            <svg width="28" height="10" viewBox="0 0 28 10" aria-hidden="true">
              <line
                x1="2"
                y1="5"
                x2="22"
                y2="5"
                stroke={row.style.color}
                stroke-width={Math.max(row.style.size, 1)}
              />
              <polygon
                points="22,2 28,5 22,8"
                fill={row.style.color}
              />
            </svg>
            <span class="label">{row.label}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </aside>
{/if}

<style>
  .legend {
    position: absolute;
    bottom: 10px;
    right: 10px;
    background: rgba(28, 28, 28, 0.92);
    color: #ddd;
    border: 1px solid #333;
    border-radius: 6px;
    font-size: 11px;
    padding: 6px 0 6px 0;
    z-index: 5;
    min-width: 130px;
  }
  .legend.collapsed {
    min-width: 24px;
    width: 24px;
    padding: 0;
  }
  .collapse {
    position: absolute;
    top: 4px;
    left: 4px;
    width: 18px;
    height: 18px;
    border: none;
    background: transparent;
    color: #aaa;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0;
  }
  .collapse:hover {
    color: #fff;
  }
  header {
    padding: 2px 10px 6px 26px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-size: 10px;
    color: #aaa;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 10px;
  }
  .label {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
  }
</style>
