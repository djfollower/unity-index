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
  import FilterSidebar from './lib/FilterSidebar.svelte';
  import SearchBar from './lib/SearchBar.svelte';
  import type { ActionId } from './lib/eligibility';
  import {
    findUsages,
    friendlyActionError,
    openFile,
    revealInExplorer,
  } from './lib/actions';
  import { filterStore } from './lib/filterStore.svelte';
  import { collectPresentKinds, computeMatches, reconcileHiddenKinds } from './lib/filter';
  import { getFilterState, setFilterState } from './lib/filterSync';

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

  // Day 5: kinds actually present in the current snapshot, with counts.
  // Drives the FilterSidebar rows. Recomputed after every renderSnapshot.
  let presentKinds: Map<string, number> = $state(new Map());

  // Day 5: persist guards. `hydrated` flips true after the initial host fetch
  // applies any stored state to the store — only then do we start saving
  // local changes back, otherwise the first effect run would clobber the
  // stored state with the empty defaults. `saveTimer` debounces typing/
  // toggling into a single round-trip.
  let hydrated = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  // Mirror Svelte's reactive selectedNode into a plain ref the Sigma
  // reducers can read each frame without going through the reactivity system.
  let selectedRef: string | null = null;

  // Same pattern for filter store: per-frame reducer reads must not go
  // through the reactivity system or every redraw triggers an update cycle.
  // $effect below keeps these in sync and triggers sigma.refresh on change.
  let hiddenKindsRef: Set<string> = new Set();
  let matchedRef: Set<string> = new Set();
  // Union of matched ∪ 1-hop neighbors. Search hides anything outside this
  // set; the union itself is what we draw. Recomputed alongside matches.
  let relatedRef: Set<string> = new Set();
  let searchActiveRef = false;

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
        const kind = attrs.kind as string;
        const style = nodeStyleFor(kind);
        // Kind filter: hidden nodes drop out of layout interactions entirely.
        // Sigma's `hidden: true` skips drawing the node AND its labels.
        if (hiddenKindsRef.has(kind)) {
          return { ...attrs, hidden: true };
        }
        // Search active: hide anything that isn't a match or a 1-hop
        // neighbor of a match. Matches draw bright, neighbors draw faded
        // (so the user can see what the match connects to without losing
        // them in the noise). When search is inactive, all nodes draw.
        if (searchActiveRef && !relatedRef.has(node)) {
          return { ...attrs, hidden: true };
        }
        const isMatch = searchActiveRef && matchedRef.has(node);
        const neighborOfMatch = searchActiveRef && !isMatch; // implied by relatedRef gate above
        const selectionMiss = selectedRef !== null && selectedRef !== node;
        const dimmed = neighborOfMatch || selectionMiss;
        const dimAlpha = neighborOfMatch ? 0.45 : 0.4;
        return {
          ...attrs,
          color: dimmed ? fade(style.color, dimAlpha) : style.color,
          size: style.size,
          label: attrs.label,
          highlighted: selectedRef === node || isMatch,
          zIndex: selectedRef === node ? 2 : (isMatch ? 1 : 0),
        };
      },
      edgeReducer: (edge, attrs) => {
        const style = edgeStyleFor(attrs.kind as string);
        const g = sigma?.getGraph();
        const source = g?.source(edge);
        const target = g?.target(edge);
        // Edge hidden iff either endpoint is kind-filtered. Reading the
        // endpoints' kinds back off the graph is O(1) and avoids stashing
        // them on the edge attrs.
        if (source !== undefined && target !== undefined && g) {
          const sKind = g.getNodeAttribute(source, 'kind') as string | undefined;
          const tKind = g.getNodeAttribute(target, 'kind') as string | undefined;
          if ((sKind && hiddenKindsRef.has(sKind)) || (tKind && hiddenKindsRef.has(tKind))) {
            return { ...attrs, hidden: true };
          }
        }
        // Search active: only draw edges that touch at least one matched
        // node. Edges between two neighbors (neither matched) aren't part
        // of the result the user asked about. Sigma also auto-hides edges
        // when an endpoint is hidden, but being explicit here keeps the
        // intent obvious.
        if (
          searchActiveRef &&
          source !== undefined &&
          target !== undefined &&
          !matchedRef.has(source) &&
          !matchedRef.has(target)
        ) {
          return { ...attrs, hidden: true };
        }
        const selectionMiss =
          selectedRef !== null && source !== selectedRef && target !== selectedRef;
        return {
          ...attrs,
          color: selectionMiss ? fade(style.color, 0.15) : style.color,
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
    presentKinds = collectPresentKinds(graph);
    // Reconcile any previously-stored hidden kinds against what's actually in
    // this snapshot. If a project no longer has, say, `addressable_group`
    // nodes, drop the toggle so the sidebar doesn't show a phantom row.
    const stored = Array.from(filterStore.hiddenKinds);
    if (stored.length > 0) {
      const present = new Set(presentKinds.keys());
      const reconciled = reconcileHiddenKinds(stored, present);
      if (reconciled.length !== stored.length) {
        filterStore.setHiddenKinds(reconciled);
      }
    }

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
        // Hydrate from the host AFTER the graph exists so reconcile can drop
        // stored kinds the snapshot doesn't carry anymore. Failures here are
        // not fatal — the panel still works with a fresh in-memory store.
        await hydrateFilterState();
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

  // Day 5 Task 2: keep the reducer refs in lockstep with the reactive store
  // and re-render on any change. Sigma can no-op a refresh that doesn't need
  // one, so calling it unconditionally is safe and keeps this effect simple.
  //
  // We touch `filterStore.revision` to force the effect to re-run on any
  // store mutation (Svelte 5 tracks field access; revision is the cheapest
  // single trigger). The other fields are still read so we always pull the
  // latest values, not a stale closure.
  $effect(() => {
    void filterStore.revision;
    hiddenKindsRef = filterStore.hiddenKinds;
    matchedRef = filterStore.matched;
    searchActiveRef = filterStore.isSearchActive();
    sigma?.refresh();
  });

  // Recompute matches whenever the search query OR the underlying graph
  // changes. Kept separate from the refresh effect so an unrelated kind
  // toggle doesn't rerun the (potentially expensive) fuzzy scan.
  $effect(() => {
    const query = filterStore.search;
    if (!currentGraph) return;
    if (query.trim().length === 0) {
      filterStore.setMatched(new Set());
      relatedRef = new Set();
      sigma?.refresh();
      return;
    }
    const { matched } = computeMatches(currentGraph, query);
    filterStore.setMatched(matched);
    // Build the "related" set: matches plus every 1-hop neighbor. The
    // reducers gate visibility on this so unrelated nodes vanish entirely.
    // O(matches × avg-degree); fine for the worst-case 13k-node project.
    const related = new Set<string>(matched);
    const g = currentGraph;
    matched.forEach((id) => {
      g.forEachNeighbor(id, (n) => related.add(n));
    });
    relatedRef = related;
    sigma?.refresh();
  });

  onDestroy(() => {
    detachDrag?.();
    detachDrag = null;
    sigma?.kill();
    sigma = null;
    currentGraph = null;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  });

  // Day 5 Task 7: pull stored filter state from the host, reconcile against
  // the kinds actually in this snapshot, then apply. Runs once per snapshot
  // load (after renderSnapshot). hydrated=true unlocks the save effect.
  async function hydrateFilterState(): Promise<void> {
    if (!bridgeRef || bridgeRef.host === 'standalone') {
      hydrated = true;
      return;
    }
    try {
      const stored = await getFilterState(bridgeRef.bridge);
      const present = new Set(presentKinds.keys());
      const validKinds = reconcileHiddenKinds(stored.hiddenKinds, present);
      filterStore.setHiddenKinds(validKinds);
      filterStore.setSearch(stored.search ?? '');
    } catch (e) {
      console.warn('[unity-index-graph] filter hydrate failed:', e);
    } finally {
      hydrated = true;
    }
  }

  // Day 5 Task 7: debounced persistence. Bumps on every store mutation
  // (via `revision`); waits ~400ms of quiet before posting to the host so
  // a burst of keystrokes or toggles becomes one round-trip. Skipped until
  // hydration finishes (otherwise we'd overwrite stored state with empty).
  $effect(() => {
    void filterStore.revision; // dependency
    if (!hydrated) return;
    if (!bridgeRef || bridgeRef.host === 'standalone') return;
    const bridge = bridgeRef.bridge;
    const snap = filterStore.snapshot();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      setFilterState(bridge, snap).catch((e) => {
        console.warn('[unity-index-graph] filter persist failed:', e);
      });
    }, 400);
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
      <FilterSidebar {presentKinds} />
      <SearchBar totalNodes={currentGraph?.order ?? 0} />
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
