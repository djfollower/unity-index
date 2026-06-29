<script lang="ts">
  // Day 6 Task 9: focus breadcrumb pinned top-left of the canvas. Pure
  // presentation — App.svelte owns the focus stack and the mutation handlers.
  //
  // Visual language matches FilterSidebar / SearchBar (dark theme, #1f1f1f
  // bg, #3a3a3a border, #ddd text). No new color tokens.

  import type Graph from 'graphology';
  import type { TraversalDirection } from '@unity-index/graph-core';
  import type { FocusFrame } from './focus';

  interface Props {
    stack: FocusFrame[];
    graph: Graph | null;
    onPop: (index: number) => void;
    onReset: () => void;
    onUpdateHops: (hops: number) => void;
    onUpdateDirection: (direction: TraversalDirection) => void;
  }

  let { stack, graph, onPop, onReset, onUpdateHops, onUpdateDirection }: Props = $props();

  const MAX_HOPS = 4;
  const MIN_HOPS = 1;

  function labelOf(nodeId: string): string {
    if (!graph || !graph.hasNode(nodeId)) return nodeId;
    return (graph.getNodeAttribute(nodeId, 'label') as string) ?? nodeId;
  }

  function kindOf(nodeId: string): string {
    if (!graph || !graph.hasNode(nodeId)) return '';
    return (graph.getNodeAttribute(nodeId, 'kind') as string) ?? '';
  }
</script>

{#if stack.length > 0}
  <div class="breadcrumb" role="navigation" aria-label="Focus breadcrumb">
    <button class="chip anchor" onclick={onReset} title="Show the full graph">Full graph</button>
    {#each stack as frame, i (i + ':' + frame.nodeId)}
      <span class="sep">›</span>
      <span class="chip">
        <button
          class="chip-body"
          onclick={() => onPop(i)}
          title="Pop the stack to this frame"
        >
          {#if kindOf(frame.nodeId)}<span class="kind">{kindOf(frame.nodeId)}</span>{/if}
          <span class="label">{labelOf(frame.nodeId)}</span>
          {#if frame.kind === 'impact'}<span class="meta">impact</span>{/if}
        </button>
        <button class="chip-x" onclick={() => onPop(i)} title="Remove this frame">✕</button>
      </span>
    {/each}
    {#if stack[stack.length - 1] && stack[stack.length - 1]!.kind === 'neighbors'}
      {@const active = stack[stack.length - 1]!}
      <span class="controls">
        <button
          class="step"
          disabled={active.hops <= MIN_HOPS}
          onclick={() => onUpdateHops(Math.max(MIN_HOPS, active.hops - 1))}
          title="Decrease hop count"
        >−</button>
        <span class="hops" aria-label="hop count">{active.hops}</span>
        <button
          class="step"
          disabled={active.hops >= MAX_HOPS}
          onclick={() => onUpdateHops(Math.min(MAX_HOPS, active.hops + 1))}
          title="Increase hop count"
        >+</button>
        <span class="dir-group" role="group" aria-label="direction">
          <button
            class="dir"
            class:active={active.direction === 'in'}
            onclick={() => onUpdateDirection('in')}
            title="Traverse incoming edges only"
          >←</button>
          <button
            class="dir"
            class:active={active.direction === 'both'}
            onclick={() => onUpdateDirection('both')}
            title="Traverse both directions"
          >↔</button>
          <button
            class="dir"
            class:active={active.direction === 'out'}
            onclick={() => onUpdateDirection('out')}
            title="Traverse outgoing edges only"
          >→</button>
        </span>
      </span>
    {/if}
    <button class="reset" onclick={onReset} title="Clear focus and return to the full graph">Reset</button>
  </div>
{/if}

<style>
  .breadcrumb {
    position: absolute;
    top: 10px;
    left: 10px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    background: #1f1f1f;
    border: 1px solid #3a3a3a;
    border-radius: 5px;
    color: #ddd;
    font-size: 12px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    z-index: 5;
    max-width: calc(100% - 20px);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    background: #2a2a2a;
    border: 1px solid #3a3a3a;
    border-radius: 3px;
    overflow: hidden;
  }
  .chip.anchor {
    padding: 3px 8px;
    background: transparent;
    border: 0;
    color: #aaa;
    cursor: pointer;
    font: inherit;
  }
  .chip.anchor:hover {
    color: #ddd;
  }
  .chip-body {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
    font: inherit;
  }
  .chip-body:hover {
    background: #333;
  }
  .chip-x {
    padding: 3px 6px;
    background: transparent;
    border: 0;
    border-left: 1px solid #3a3a3a;
    color: #888;
    cursor: pointer;
    font: inherit;
  }
  .chip-x:hover {
    color: #ff6b6b;
    background: #333;
  }
  .kind {
    color: #888;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .label {
    color: #ddd;
  }
  .meta {
    color: #ff9a3c;
    font-size: 10px;
    text-transform: uppercase;
    margin-left: 4px;
  }
  .sep {
    color: #555;
  }
  .controls {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin-left: 6px;
    padding-left: 6px;
    border-left: 1px solid #3a3a3a;
  }
  .step,
  .dir {
    background: #2a2a2a;
    border: 1px solid #3a3a3a;
    color: #ddd;
    padding: 2px 6px;
    border-radius: 3px;
    cursor: pointer;
    font: inherit;
    min-width: 20px;
  }
  .step:hover:not(:disabled),
  .dir:hover {
    background: #333;
  }
  .step:disabled {
    color: #555;
    cursor: not-allowed;
  }
  .hops {
    min-width: 14px;
    text-align: center;
    color: #ddd;
  }
  .dir-group {
    display: inline-flex;
    gap: 2px;
    margin-left: 4px;
  }
  .dir.active {
    background: #3a4f8a;
    border-color: #4f7cff;
  }
  .reset {
    margin-left: 6px;
    padding: 3px 10px;
    background: #2a2a2a;
    border: 1px solid #3a3a3a;
    border-radius: 3px;
    color: #ddd;
    cursor: pointer;
    font: inherit;
  }
  .reset:hover {
    background: #333;
  }
</style>
