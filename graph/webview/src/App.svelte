<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Graph from 'graphology';
  import Sigma from 'sigma';
  import type { SnapshotResponse } from '@unity-index/graph-core';
  import { pickBridge } from './bridge/pick';
  import { fetchSnapshot, friendlyErrorMessage } from './lib/snapshot';
  import { buildGraphologyGraph } from './lib/snapshotToGraph';
  import {
    HARD_RENDER_CAP,
    SOFT_LAYOUT_CAP,
    layoutCircular,
    layoutForceAtlas2,
  } from './lib/layout';
  import { edgeStyleFor, nodeStyleFor } from './lib/style';
  import { attachDragBehavior } from './lib/drag';
  import SelectionPanel from './lib/SelectionPanel.svelte';
  import ContextMenu from './lib/ContextMenu.svelte';
  import type { ActionId } from './lib/eligibility';
  import {
    findUsages,
    friendlyActionError,
    openFile,
    revealInExplorer,
  } from './lib/actions';

  type ViewState = 'loading' | 'empty' | 'ready' | 'error';

  let container: HTMLDivElement;
  let sigma: Sigma | null = null;
  let detachDrag: (() => void) | null = null;
  let selectedNode: string | null = $state(null);
  let viewState: ViewState = $state('loading');
  let status = $state('initialising…');
  let errorCopy = $state('');
  let lastSnapshot: SnapshotResponse | null = null;
  let bridgeRef: ReturnType<typeof pickBridge> | null = null;
  // Mirror of the active Graphology graph, exposed reactively so the
  // SelectionPanel can read node attrs + neighbor degrees without reaching
  // into Sigma. Set in renderSnapshot / renderPlaceholderGraph, cleared on
  // destroy and error paths.
  let currentGraph: Graph | null = $state(null);
  // Open context menu state — null when hidden. Coordinates are viewport-
  // relative (event.clientX/Y), so the menu uses position:fixed.
  let menuState: { nodeId: string; x: number; y: number } | null = $state(null);

  // Mirror Svelte's reactive selectedNode into a plain ref the Sigma
  // reducers can read each frame without going through the reactivity system.
  let selectedRef: string | null = null;

  function renderPlaceholderGraph(label: string): void {
    // Day-1 hardcoded 3-node graph. Used in standalone (no host) mode as a
    // dev smoke test, and as a holding pattern in Task 4 — Task 5 builds the
    // real Graphology graph from the snapshot.
    const graph = new Graph({ type: 'directed', multi: false });
    graph.addNode('prefab:Player', {
      label: 'Player.prefab',
      color: '#4f7cff',
      x: 0,
      y: 0,
      size: 14,
    });
    graph.addNode('script:PlayerController', {
      label: 'PlayerController.cs',
      color: '#ffaa00',
      x: 2,
      y: 0,
      size: 14,
    });
    graph.addNode('scene:Main', {
      label: 'Main.unity',
      color: '#22cc88',
      x: 1,
      y: 1.5,
      size: 14,
    });
    graph.addEdgeWithKey('e1', 'prefab:Player', 'script:PlayerController', {
      label: 'uses',
      size: 2,
      color: '#888',
    });
    graph.addEdgeWithKey('e2', 'scene:Main', 'prefab:Player', {
      label: 'contains',
      size: 2,
      color: '#888',
    });
    sigma?.kill();
    sigma = new Sigma(graph, container, {
      renderEdgeLabels: true,
      labelColor: { color: '#ddd' },
      edgeLabelColor: { color: '#999' },
    });
    currentGraph = graph;
    status = label;
  }

  function renderSnapshot(res: SnapshotResponse): void {
    const { graph, droppedEdges } = buildGraphologyGraph(res.snapshot);
    // Soft cap: above SOFT_LAYOUT_CAP, main-thread ForceAtlas2 freezes the
    // UI long enough to be annoying. Fall back to a circular ring (O(n))
    // until Day 7's worker layout ships. Track the choice for the status bar.
    const overSoftCap = graph.order > SOFT_LAYOUT_CAP;
    if (overSoftCap) {
      layoutCircular(graph);
    } else {
      layoutForceAtlas2(graph);
    }
    detachDrag?.();
    sigma?.kill();
    sigma = new Sigma(graph, container, {
      labelColor: { color: '#ddd' },
      edgeLabelColor: { color: '#999' },
      defaultEdgeType: 'arrow',
      // Per-kind styling lives in lib/style.ts. Reducers run per frame and
      // are the right hook for Day 4 (context menu) and Day 5 (filter fade)
      // to layer on top of without touching graph attrs. Day 3 itself uses
      // them for selection: bright the selected node, dim the rest.
      nodeReducer: (node, attrs) => {
        const style = nodeStyleFor(attrs.kind as string);
        const dimmed = selectedRef !== null && selectedRef !== node;
        return {
          ...attrs,
          color: style.color,
          size: style.size,
          label: attrs.label,
          highlighted: selectedRef === node || !!attrs.highlighted,
          zIndex: selectedRef === node ? 1 : 0,
          ...(dimmed ? { color: fade(style.color, 0.4) } : {}),
        };
      },
      edgeReducer: (edge, attrs) => {
        const style = edgeStyleFor(attrs.kind as string);
        const source = sigma?.getGraph().source(edge);
        const target = sigma?.getGraph().target(edge);
        const dimmed =
          selectedRef !== null && source !== selectedRef && target !== selectedRef;
        return {
          ...attrs,
          color: dimmed ? fade(style.color, 0.25) : style.color,
          size: style.size,
          type: style.type,
        };
      },
    });

    // Selection: click a node to focus it, click the stage to deselect.
    // Day 4 hangs context-menu + open-file off the same selectedNode.
    sigma.on('clickNode', ({ node }) => {
      selectedNode = node;
      selectedRef = node;
      sigma?.refresh();
    });
    sigma.on('clickStage', () => {
      selectedNode = null;
      selectedRef = null;
      sigma?.refresh();
    });

    // Day 4 Task 4: double-click → open the underlying file in the host IDE.
    // Sigma fires clickNode BEFORE doubleClickNode, so the selection panel
    // updates first and then the editor opens — felt as a single gesture.
    // Nodes without `path` (e.g. csharp dangling targets) are a silent no-op
    // since they have nothing meaningful to open; the panel still surfaces
    // the node so users can copy the id.
    sigma.on('doubleClickNode', ({ node, event }) => {
      // Suppress Sigma's default double-click zoom — it competes with the
      // open-file gesture and feels jarring when a file pops open in the
      // background.
      event.preventSigmaDefault?.();
      void dispatchOpenForNode(node);
    });

    // Day 4 Task 7: right-click a node to open the action menu. Sigma fires
    // `rightClickNode` with a synthetic event that exposes preventSigmaDefault
    // (suppresses the built-in pan/zoom hook) and clientX/clientY (relative
    // to the viewport — what the position:fixed menu wants).
    sigma.on('rightClickNode', ({ node, event }) => {
      event.preventSigmaDefault?.();
      // Reuse the selection state so the panel rides along — the menu's
      // actions operate on the node the user just right-clicked, and showing
      // its details simultaneously matches IDE conventions.
      selectedNode = node;
      selectedRef = node;
      sigma?.refresh();
      // Sigma's node event exposes `event.x/y` in container-relative space,
      // and `event.original` is the underlying DOM event (MouseEvent for
      // right-click). We prefer the DOM event's viewport-relative coords
      // because the menu uses position:fixed; fall back to (event.x, event.y)
      // offset by the container's bounding rect when `original` is a
      // synthetic TouchEvent without clientX/Y.
      const orig = event.original as MouseEvent | TouchEvent | undefined;
      const fromMouse = (orig as MouseEvent | undefined)?.clientX !== undefined
        ? { x: (orig as MouseEvent).clientX, y: (orig as MouseEvent).clientY }
        : null;
      const rect = container.getBoundingClientRect();
      const fallback = {
        x: rect.left + ((event as unknown as { x: number }).x ?? 0),
        y: rect.top + ((event as unknown as { y: number }).y ?? 0),
      };
      menuState = { nodeId: node, x: fromMouse?.x ?? fallback.x, y: fromMouse?.y ?? fallback.y };
    });
    // Empty-stage right-click: dismiss any open menu. We don't fall through
    // to the browser's contextmenu because the IDE webviews suppress it
    // anyway and a half-working browser menu is worse than no menu.
    sigma.on('rightClickStage', ({ event }) => {
      event.preventSigmaDefault?.();
      menuState = null;
    });

    detachDrag = attachDragBehavior(sigma, graph);
    currentGraph = graph;

    const droppedTail = droppedEdges > 0
      ? ` · ${droppedEdges} dangling edge${droppedEdges === 1 ? '' : 's'} (csharp targets land Day 8)`
      : '';
    const layoutTail = overSoftCap
      ? ` · graph too large for default layout (${graph.order.toLocaleString()} nodes) — Day 7 will fix`
      : '';
    status = `${snapshotSummary(res)}${droppedTail}${layoutTail}`;
  }

  // Apply an alpha to a #RRGGBB string. Used to fade non-selected items;
  // Sigma's render path accepts rgba so a stringified rgba works without
  // touching the per-frame allocation budget meaningfully.
  function fade(hex: string, alpha: number): string {
    if (!hex.startsWith('#') || hex.length !== 7) return hex;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function snapshotSummary(snap: SnapshotResponse): string {
    const s = snap.snapshot.stats;
    const w = snap.warnings?.length ?? 0;
    const wTail = w > 0 ? ` · ${w} warning${w === 1 ? '' : 's'}` : '';
    const skip = s.skipped_component_instances + s.skipped_component_fields;
    const skipTail = skip > 0 ? ` · ${skip.toLocaleString()} sub-file items skipped` : '';
    return `${s.node_count.toLocaleString()} nodes · ${s.edge_count.toLocaleString()} edges${skipTail}${wTail}`;
  }

  async function loadSnapshot(): Promise<void> {
    if (!bridgeRef || bridgeRef.host === 'standalone') return;
    viewState = 'loading';
    status = 'loading project graph…';
    errorCopy = '';
    try {
      const res = await fetchSnapshot(bridgeRef.bridge);
      lastSnapshot = res;
      if (res.snapshot.nodes.length === 0) {
        viewState = 'empty';
        status = 'no Unity assets found';
      } else if (res.snapshot.nodes.length > HARD_RENDER_CAP) {
        // Above the hard cap, Sigma + main-thread layout can take 30s+ and
        // risk crashing the webview. Refuse to render until Day 7's worker
        // pipeline lands; surface the count so the user knows the data
        // arrived intact.
        viewState = 'empty';
        errorCopy = `Graph has ${res.snapshot.nodes.length.toLocaleString()} nodes — pagination + worker layout land in Day 7. Render disabled for now.`;
        status = errorCopy;
      } else {
        viewState = 'ready';
        renderSnapshot(res);
      }
      console.log('[unity-index-graph] snapshot:', res);
    } catch (e) {
      const raw = (e as Error).message;
      viewState = 'error';
      errorCopy = friendlyErrorMessage(raw);
      status = `error: ${errorCopy}`;
      console.warn('[unity-index-graph] snapshot failed:', e);
    }
  }

  onMount(async () => {
    bridgeRef = pickBridge();
    if (bridgeRef.host === 'standalone') {
      viewState = 'ready';
      renderPlaceholderGraph('standalone (no host) — 3 nodes hardcoded');
      return;
    }
    await loadSnapshot();
  });

  onDestroy(() => {
    detachDrag?.();
    detachDrag = null;
    sigma?.kill();
    sigma = null;
    currentGraph = null;
  });

  function clearSelection(): void {
    selectedNode = null;
    selectedRef = null;
    sigma?.refresh();
  }

  // Day 4 Task 8: dispatcher for context-menu actions. Centralises the
  // bridge calls + status bar surfacing so the menu component itself stays
  // pure presentation. `copy_guid` is the only synchronous path (clipboard
  // access stays in the webview); the rest hop through the host bridge.
  async function dispatchMenuAction(action: ActionId, nodeId: string): Promise<void> {
    if (!currentGraph || !currentGraph.hasNode(nodeId)) return;
    const attrs = currentGraph.getNodeAttributes(nodeId) as Record<string, unknown>;
    const filePath = typeof attrs.path === 'string' ? attrs.path : undefined;
    const guid = typeof attrs.guid === 'string' ? attrs.guid : undefined;
    const location = (attrs.location ?? null) as { line?: number; column?: number } | null;

    switch (action) {
      case 'copy_guid': {
        if (!guid) return;
        try {
          await navigator.clipboard.writeText(guid);
          status = `copied GUID ${guid.slice(0, 8)}…`;
        } catch (e) {
          status = `copy failed: ${(e as Error).message}`;
        }
        return;
      }
      case 'open_file':
        await dispatchOpenForNode(nodeId);
        return;
      case 'reveal_in_explorer': {
        if (!bridgeRef || bridgeRef.host === 'standalone' || !filePath) return;
        try {
          await revealInExplorer(bridgeRef.bridge, { path: filePath });
          status = `revealed ${filePath}`;
        } catch (e) {
          status = `could not reveal: ${friendlyActionError((e as Error).message)}`;
        }
        return;
      }
      case 'find_usages': {
        if (!bridgeRef || bridgeRef.host === 'standalone' || !filePath) return;
        try {
          const req: import('@unity-index/graph-core').FindUsagesRequest = {
            node_id: nodeId,
            path: filePath,
          };
          if (typeof location?.line === 'number') req.line = location.line;
          if (typeof location?.column === 'number') req.column = location.column;
          await findUsages(bridgeRef.bridge, req);
          status = `find usages: ${filePath}`;
        } catch (e) {
          status = `find usages failed: ${friendlyActionError((e as Error).message)}`;
        }
        return;
      }
    }
  }

  // Shared dispatcher for double-click + context-menu "Open file". Reads the
  // path / line straight off the node attrs (same shape `buildGraphologyGraph`
  // copies from the snapshot). Surfaces success and failure via the status
  // bar — no toast system yet, the status line is the only visible channel.
  async function dispatchOpenForNode(nodeId: string): Promise<void> {
    if (!bridgeRef || bridgeRef.host === 'standalone' || !currentGraph) return;
    if (!currentGraph.hasNode(nodeId)) return;
    const attrs = currentGraph.getNodeAttributes(nodeId) as Record<string, unknown>;
    const filePath = typeof attrs.path === 'string' ? attrs.path : undefined;
    if (!filePath) {
      status = 'nothing to open: this node has no file path';
      return;
    }
    const location = (attrs.location ?? null) as { line?: number; column?: number } | null;
    try {
      // Build the request without including optional keys when undefined —
      // exactOptionalPropertyTypes refuses `line: undefined` against `line?:
      // number`. (The host treats missing/undefined identically.)
      const req: import('@unity-index/graph-core').OpenFileRequest = { path: filePath };
      if (typeof location?.line === 'number') req.line = location.line;
      if (typeof location?.column === 'number') req.column = location.column;
      await openFile(bridgeRef.bridge, req);
      status = `opened ${filePath}`;
    } catch (e) {
      const msg = friendlyActionError((e as Error).message);
      status = `could not open file: ${msg}`;
      console.warn('[unity-index-graph] open_file failed:', e);
    }
  }
</script>

<div class="root">
  <div class="status" class:status-error={viewState === 'error'}>{status}</div>
  <!-- Suppress the browser's native context menu over the graph area so it
       doesn't overlap our own ContextMenu. Rider's JCEF webview shows the
       default menu (back/forward/view source) by default; VS Code webviews
       block it via host config, so this is a no-op there. We scope it to
       the canvas wrap rather than the whole document so the status bar at
       the top can still receive inspect-element during dev. -->
  <div
    class="canvas-wrap"
    role="presentation"
    oncontextmenu={(e) => e.preventDefault()}
  >
    <div class="canvas" bind:this={container}></div>
    {#if viewState === 'ready'}
      <SelectionPanel nodeId={selectedNode} graph={currentGraph} onClose={clearSelection} />
      <ContextMenu
        menu={menuState}
        graph={currentGraph}
        onAction={(action, nodeId) => { void dispatchMenuAction(action, nodeId); }}
        onClose={() => { menuState = null; }}
      />
    {/if}
    {#if viewState === 'loading'}
      <div class="overlay">
        <div class="spinner"></div>
        <div>loading project graph…</div>
      </div>
    {:else if viewState === 'empty'}
      <div class="overlay">
        <div class="empty-title">{errorCopy ? 'Graph too large to render' : 'No Unity assets found'}</div>
        <div class="empty-sub">{errorCopy || 'This workspace contains no scripts, prefabs, scenes, or assets the indexer recognises.'}</div>
        <button onclick={loadSnapshot}>Retry</button>
      </div>
    {:else if viewState === 'error'}
      <div class="overlay">
        <div class="error-title">Could not load graph</div>
        <div class="error-sub">{errorCopy}</div>
        <button onclick={loadSnapshot}>Retry</button>
      </div>
    {/if}
  </div>
</div>

<style>
  :global(body) {
    margin: 0;
  }
  .root {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    font-family: system-ui, -apple-system, sans-serif;
  }
  .status {
    padding: 6px 10px;
    font-size: 12px;
    background: #1e1e1e;
    color: #ccc;
    border-bottom: 1px solid #333;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .status-error {
    color: #ff6b6b;
  }
  .canvas-wrap {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
  }
  .canvas {
    position: absolute;
    inset: 0;
    background: #181818;
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    background: rgba(24, 24, 24, 0.88);
    color: #ddd;
    text-align: center;
    padding: 24px;
  }
  .empty-title,
  .error-title {
    font-size: 16px;
    font-weight: 600;
  }
  .error-title {
    color: #ff6b6b;
  }
  .empty-sub,
  .error-sub {
    font-size: 13px;
    color: #aaa;
    max-width: 420px;
    line-height: 1.4;
  }
  button {
    padding: 6px 14px;
    font-size: 13px;
    background: #2a2a2a;
    color: #ddd;
    border: 1px solid #444;
    border-radius: 4px;
    cursor: pointer;
  }
  button:hover {
    background: #333;
  }
  .spinner {
    width: 24px;
    height: 24px;
    border: 3px solid #333;
    border-top-color: #4f7cff;
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
