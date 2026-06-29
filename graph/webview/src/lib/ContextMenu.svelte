<script lang="ts">
  // Day 4 Task 7: cursor-anchored popover for right-clicks on graph nodes.
  // Pure presentation — eligibility lives in `eligibility.ts`, dispatch lives
  // in `actions.ts`. The component takes a node id + screen coordinates +
  // a callback that runs the chosen action, and dismisses itself on outside
  // click / Escape / action chosen.
  //
  // We intentionally bypass the browser's default contextmenu — both VS Code
  // and Rider webviews suppress it anyway in production, and a mixed menu
  // (browser inspect-element on the canvas, ours on a node) would feel
  // jarring. The empty-stage right-click is owned by App.svelte.

  import { onDestroy, onMount } from 'svelte';
  import type Graph from 'graphology';
  import {
    type ActionDescriptor,
    type ActionId,
    actionsForNode,
  } from './eligibility';

  interface Props {
    /** Currently open menu, or `null` when hidden. */
    menu: { nodeId: string; x: number; y: number } | null;
    graph: Graph | null;
    onAction: (action: ActionId, nodeId: string) => void;
    onClose: () => void;
  }

  let { menu, graph, onAction, onClose }: Props = $props();

  // Derived: which actions to render for the current selection. Empty array
  // hides the menu entirely so we never show an empty popover (which would
  // look broken).
  const actions = $derived.by((): ActionDescriptor[] => {
    if (!menu || !graph || !graph.hasNode(menu.nodeId)) return [];
    const attrs = graph.getNodeAttributes(menu.nodeId) as Record<string, unknown>;
    const kind = typeof attrs.kind === 'string' ? attrs.kind : 'asset';
    const hasPath = typeof attrs.path === 'string' && attrs.path.length > 0;
    const hasGuid = typeof attrs.guid === 'string' && attrs.guid.length > 0;
    const hasIncomingEdges = graph.inDegree(menu.nodeId) > 0;
    return actionsForNode({ kind: kind as never, hasPath, hasGuid, hasIncomingEdges });
  });

  // Pin the menu inside the viewport. Without this, right-clicks near the
  // right/bottom edge of the panel render off-screen.
  let menuEl: HTMLDivElement | undefined = $state(undefined);
  const position = $derived.by(() => {
    if (!menu) return { left: 0, top: 0 };
    const margin = 8;
    const w = menuEl?.offsetWidth ?? 200;
    const h = menuEl?.offsetHeight ?? 40 * actions.length + 16;
    const left = Math.min(menu.x, window.innerWidth - w - margin);
    const top = Math.min(menu.y, window.innerHeight - h - margin);
    return { left: Math.max(margin, left), top: Math.max(margin, top) };
  });

  function handleClick(action: ActionDescriptor): void {
    if (!menu) return;
    const id = menu.nodeId;
    onAction(action.id, id);
    onClose();
  }

  function handleKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && menu) {
      e.stopPropagation();
      onClose();
    }
  }

  function handleOutsideClick(e: MouseEvent): void {
    if (!menu || !menuEl) return;
    if (e.target instanceof Node && menuEl.contains(e.target)) return;
    onClose();
  }

  onMount(() => {
    // Listen on `mousedown` rather than `click` so a single physical action
    // (mousedown outside → mouseup outside) dismisses without waiting for
    // the click to land, matching native context-menu behavior.
    window.addEventListener('mousedown', handleOutsideClick, true);
    window.addEventListener('keydown', handleKey, true);
  });
  onDestroy(() => {
    window.removeEventListener('mousedown', handleOutsideClick, true);
    window.removeEventListener('keydown', handleKey, true);
  });
</script>

{#if menu && actions.length > 0}
  <div
    class="menu"
    bind:this={menuEl}
    style:left="{position.left}px"
    style:top="{position.top}px"
    role="menu"
  >
    {#each actions as action (action.id)}
      <button class="item" role="menuitem" onclick={() => handleClick(action)}>
        {action.label}
      </button>
    {/each}
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    min-width: 200px;
    background: #1f1f1f;
    border: 1px solid #3a3a3a;
    border-radius: 5px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
    padding: 4px;
    z-index: 10;
    font-size: 12px;
    color: #ddd;
  }
  .item {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    border: 0;
    color: inherit;
    padding: 6px 10px;
    border-radius: 3px;
    cursor: pointer;
    font: inherit;
  }
  .item:hover {
    background: #2c2c2c;
  }
  .item:focus {
    outline: 1px solid #4f7cff;
    outline-offset: -1px;
  }
</style>
