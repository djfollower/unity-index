<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Graph from 'graphology';
  import Sigma from 'sigma';
  import type { SnapshotResponse } from '@unity-index/graph-core';
  import { pickBridge } from './bridge/pick';
  import { fetchSnapshot, friendlyErrorMessage } from './lib/snapshot';
  import { anchorIdFor, fetchCodeEdges, fetchSubtypes } from './lib/codeEdges';
  import { fetchSnapshotDelta } from './lib/delta';
  import { applyDeltaToGraph } from './lib/applyDelta';
  import { buildGraphologyGraph } from './lib/snapshotToGraph';
  import {
    HARD_RENDER_CAP,
    LayoutSupervisor,
    isWorkerSupported,
    layoutCircular,
    layoutForceAtlas2,
  } from './lib/layout';
  import {
    buildClustering,
    emptyClustering,
    LOD_THRESHOLD,
    type Clustering,
  } from './lib/clustering';
  import { edgeStyleFor, nodeStyleFor } from './lib/style';
  import { attachDragBehavior } from './lib/drag';
  import SelectionPanel from './lib/SelectionPanel.svelte';
  import ContextMenu from './lib/ContextMenu.svelte';
  import FilterSidebar from './lib/FilterSidebar.svelte';
  import SearchBar from './lib/SearchBar.svelte';
  import DomainToggle from './lib/DomainToggle.svelte';
  import Legend from './lib/Legend.svelte';
  import { edgeHiddenByDomain, nodeHiddenByDomain } from './lib/domain';
  import { computeCrossDomainChain } from './lib/crossDomain';
  import type { EdgeKind, FilterDomain } from '@unity-index/graph-core';
  import type { ActionId } from './lib/eligibility';
  import {
    findUsages,
    friendlyActionError,
    openFile,
    revealInExplorer,
  } from './lib/actions';
  import { filterStore, FilterStore } from './lib/filterStore.svelte';
  import {
    collectDiagnosticsTargets,
    diagnosticsStore,
    heatmapColorFor,
    heatmapSizeBoostFor,
  } from './lib/diagnostics.svelte';
  import type { NodeDiagnostics } from '@unity-index/graph-core';
  import {
    collectPresentEdgeKinds,
    collectPresentKinds,
    computeMatches,
    reconcileHiddenKinds,
  } from './lib/filter';
  import { getFilterState, setFilterState } from './lib/filterSync';
  import Breadcrumb from './lib/Breadcrumb.svelte';
  import type { ImpactClassification } from '@unity-index/graph-core';
  import {
    computeVisibility,
    resetFocusCache,
    type FocusFrame,
  } from './lib/focus';

  type ViewState = 'loading' | 'empty' | 'ready' | 'error';

  let container: HTMLDivElement;
  let sigma: Sigma | null = null;
  let detachDrag: (() => void) | null = null;
  let selectedNode: string | null = $state(null);
  let viewState: ViewState = $state('loading');
  let status = $state('initialising…');
  let errorCopy = $state('');
  // Reactive — the Day 6 focus effect depends on this. Plain `let` here used
  // to silently break focus: the effect's first run with lastSnapshot=null
  // took the early-return path before touching focusStack, so focusStack
  // never became a tracked dep and later mutations didn't re-run the effect.
  let lastSnapshot: SnapshotResponse | null = $state(null);
  let bridgeRef: ReturnType<typeof pickBridge> | null = null;
  // Mirror of the active Graphology graph, exposed reactively so the
  // SelectionPanel can read node attrs + neighbor degrees without reaching
  // into Sigma. Set in renderSnapshot / renderPlaceholderGraph, cleared on
  // destroy and error paths.
  let currentGraph: Graph | null = $state(null);
  // Open context menu state — null when hidden. Coordinates are viewport-
  // relative (event.clientX/Y), so the menu uses position:fixed.
  let menuState: { nodeId: string; x: number; y: number } | null = $state(null);

  // Day 8.5 — set of `unity://csharp/T:...` anchor IDs whose code-edge
  // expansion has already landed in `currentGraph`. We use this to hide
  // "Expand code edges" on a node the user already expanded so a second
  // right-click doesn't refetch identical data. Reset on snapshot reload.
  let expandedCodeAnchors: Set<string> = $state(new Set());
  // Coalesces in-flight expansions so a fast double-click on the same
  // anchor only hits the bridge once.
  const codeEdgeInflight = new Set<string>();

  // Day 9.3 — true while a preset fetch is in flight. Surfaces in the
  // FilterSidebar's preset button so the user can't double-fire.
  let presetBusy = $state(false);

  /** Anchor id for the MonoBehaviour subclasses preset. UnityEngine ships
   *  in a referenced assembly, not the project, so we rely on the host's
   *  workspace-symbol lookup to find it. */
  const MONOBEHAVIOUR_ID = 'unity://csharp/T:UnityEngine.MonoBehaviour';

  // Day 9.4 — cross-domain chain highlight. Sigma's `enterNode` /
  // `leaveNode` events drive `hoveredNode`; a 50ms debounce (cheap on
  // human timescales, plenty for chain recompute) collapses rapid
  // re-enters into a single computeCrossDomainChain call. The reducer
  // reads `chainNodesRef` / `chainEdgesRef` per frame.
  let chainNodesRef: Set<string> = new Set();
  let chainEdgesRef: Set<string> = new Set();
  let hoverDebounce: ReturnType<typeof setTimeout> | null = null;
  /** Accent color for cross-domain chains. Pink/magenta — distinct from
   *  every per-domain palette colour so the chain reads as "annotation
   *  layer" rather than "another edge kind". */
  const CHAIN_ACCENT = '#ff7eb6';

  // Day 5: kinds actually present in the current snapshot, with counts.
  // Drives the FilterSidebar rows. Recomputed after every renderSnapshot.
  let presentKinds: Map<string, number> = $state(new Map());
  // Day 9.2: edge kinds actually present. Drives Legend visibility.
  let presentEdgeKinds: Set<EdgeKind> = $state(new Set());

  // Day 5: persist guards. `hydrated` flips true after the initial host fetch
  // applies any stored state to the store — only then do we start saving
  // local changes back, otherwise the first effect run would clobber the
  // stored state with the empty defaults. `saveTimer` debounces typing/
  // toggling into a single round-trip.
  let hydrated = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  // Day 7 Task 6 — delta polling. Polls every DELTA_POLL_MS while the panel
  // is open and the host advertises a `revision`. On a delta response we
  // apply in place to currentGraph (preserving camera/layout/selection); on
  // a reset response we re-render via the carried snapshot. `currentRevision`
  // is null when delta support is unavailable (pre-Day-7 host).
  const DELTA_POLL_MS = 1500;
  let currentRevision: number | null = null;
  let deltaPollTimer: ReturnType<typeof setInterval> | null = null;
  let deltaInFlight = false;

  // Day 7 Task 7 — worker-backed FA2 supervisor. One instance per active
  // Graphology graph; killed when the graph is replaced or the panel closes.
  // Null while standalone/placeholder or when Worker is unsupported.
  let layoutSupervisor: LayoutSupervisor | null = null;
  // How long to let the worker iterate on each (re)kick. The initial bake
  // gets a longer budget; delta-driven kicks just need enough to settle the
  // handful of newly-added nodes.
  const INITIAL_LAYOUT_MS = 5000;
  const DELTA_LAYOUT_KICK_MS = 1500;

  // Mirror Svelte's reactive selectedNode into a plain ref the Sigma
  // reducers can read each frame without going through the reactivity system.
  let selectedRef: string | null = null;

  // Day 7 Task 8 — folder LOD clustering. `clusteringRef` is recomputed
  // after every snapshot load / delta apply; `inLodRef` flips true once
  // the camera zooms past LOD_THRESHOLD, driving reducer-side collapse.
  let clusteringRef: Clustering = emptyClustering();
  let inLodRef = false;

  // Same pattern for filter store: per-frame reducer reads must not go
  // through the reactivity system or every redraw triggers an update cycle.
  // $effect below keeps these in sync and triggers sigma.refresh on change.
  let hiddenKindsRef: Set<string> = new Set();
  // Day 10 — reducer refs for the diagnostics overlay. Pulled out of the
  // reactive store into plain locals so the per-frame nodeReducer doesn't
  // trigger Svelte's dependency tracking on every paint.
  let diagBadgesRef: Map<string, NodeDiagnostics> = new Map();
  let diagResolvedRef: Set<string> = new Set();
  let diagHeatmapRef = false;
  let diagErrorsOnlyRef = false;
  let domainRef: FilterDomain = 'combined';
  let matchedRef: Set<string> = new Set();
  // Union of matched ∪ 1-hop neighbors. Search hides anything outside this
  // set; the union itself is what we draw. Recomputed alongside matches.
  let relatedRef: Set<string> = new Set();
  let searchActiveRef = false;

  // Day 6 Task 7: focus subgraph stack. Last frame is the active focus; earlier
  // frames are breadcrumb history. Empty stack = unfocused (show everything).
  let focusStack: FocusFrame[] = $state([]);
  // Reducer-side mirrors. visibleNodesRef/visibleEdgesRef are the AND mask we
  // intersect with kind filters + search; impactClassRef colours rings on
  // impact frames (Task 10).
  let visibleNodesRef: Set<string> = new Set();
  let visibleEdgesRef: Set<string> = new Set();
  let impactClassRef: Map<string, ImpactClassification | undefined> = new Map();

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
    // Day 7 Task 7 — layout runs in a Web Worker when available. The
    // supervisor seeds positions synchronously (so the first Sigma frame
    // already shows a meaningful layout) and then iterates off-thread for
    // INITIAL_LAYOUT_MS. Falls back to the sync FA2 pass when Worker is
    // unavailable (tests, restrictive hosts).
    layoutSupervisor?.kill();
    layoutSupervisor = null;
    const useWorker = isWorkerSupported();
    if (!useWorker) {
      if (graph.order > 0) layoutForceAtlas2(graph);
    } else if (graph.order === 0) {
      // No-op: empty graph.
    } else {
      // Hand off to the supervisor (which performs its own seed pass).
      // Created here, started after Sigma is built so the worker's per-tick
      // graph mutations drive the renderer that's about to attach.
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
        // Day 7 Task 8 — folder LOD. When zoomed out past LOD_THRESHOLD,
        // hide every node that isn't its cluster's representative; the
        // representatives get a folder-aggregate label + scaled size. We
        // run this BEFORE the focus / kind / search gates because the
        // collapse should win over those — at far zoom the user can't see
        // individual filtered nodes anyway, and we want the cluster shape.
        if (inLodRef && clusteringRef.clusterCount > 0) {
          const repAttrs = clusteringRef.repAttrs.get(node);
          if (!repAttrs) {
            return { ...attrs, hidden: true };
          }
          return {
            ...attrs,
            label: repAttrs.label,
            size: repAttrs.size,
            color: style.color,
            zIndex: 1,
          };
        }
        // Day 6 Task 8 — focus × filter composition (AND):
        //   visible iff focus(if active) AND kind filter AND search(if active).
        if (focusStack.length > 0 && !visibleNodesRef.has(node)) {
          return { ...attrs, hidden: true };
        }
        // Kind filter: hidden nodes drop out of layout interactions entirely.
        // Sigma's `hidden: true` skips drawing the node AND its labels.
        if (hiddenKindsRef.has(kind)) {
          return { ...attrs, hidden: true };
        }
        // Day 9 — domain toggle composes with per-kind filter via AND. Both
        // must allow the kind for the node to render.
        if (nodeHiddenByDomain(domainRef, kind)) {
          return { ...attrs, hidden: true };
        }
        // Day 10 — "errors only" gate. We only hide nodes the host has
        // confirmed clean (errors === 0). Nodes we haven't asked about
        // yet (or that failed to resolve to a file) pass through — better
        // to show a possibly-clean node than to silently drop something
        // we don't know about.
        if (diagErrorsOnlyRef) {
          const d = diagBadgesRef.get(node);
          if (d && d.errors === 0) return { ...attrs, hidden: true };
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
        // Day 6 Task 10 — impact classification rings via Sigma's borderColor
        // settings (no custom node program needed).
        const classification = impactClassRef.get(node);
        const ringColor = classification === 'direct'
          ? '#ff6b6b'
          : classification === 'transitive'
            ? '#ffaa33'
            : classification === 'weak'
              ? 'rgba(180,180,180,0.7)'
              : undefined;
        const next: Record<string, unknown> = {
          ...attrs,
          color: dimmed ? fade(style.color, dimAlpha) : style.color,
          size: style.size,
          label: attrs.label,
          highlighted: selectedRef === node || isMatch,
          zIndex: selectedRef === node ? 2 : (isMatch ? 1 : 0),
        };
        if (ringColor) {
          next.borderColor = ringColor;
          next.borderSize = 2;
        }
        // Day 10 — diagnostic badges + heatmap. Badges always render a
        // border ring on dirty nodes (red for errors, amber for
        // warnings); heatmap additionally recolors the body and scales
        // by reference count so hub files pop. Both layers are subordinate
        // to the chain accent below (gesture-driven, must win).
        const diag = diagBadgesRef.get(node);
        if (diag && diag.max_severity !== 'none') {
          const badgeColor =
            diag.max_severity === 'error'
              ? '#ff5555'
              : diag.max_severity === 'warning'
                ? '#ffaa33'
                : '#5fb3ff';
          next.borderColor = badgeColor;
          next.borderSize = Math.max(2, (next.borderSize as number | undefined) ?? 0);
        }
        if (diagHeatmapRef && diag) {
          const heatColor = heatmapColorFor(diag);
          if (heatColor) {
            next.color = dimmed ? fade(heatColor, dimAlpha) : heatColor;
          }
          // Reference count proxy: graphology degree. Cheap and matches
          // what the user perceives as "this thing is used a lot".
          const g = sigma?.getGraph();
          const refCount = g ? g.degree(node) : 0;
          const boost = heatmapSizeBoostFor(refCount);
          next.size = (next.size as number) + boost;
        }
        // Day 9.4 — chain accent overrides classification rings; if the
        // user is hovering a chain we want the chain story to win over
        // the impact story (they aren't comparable, and chain is the
        // gesture-driven layer).
        if (chainNodesRef.has(node)) {
          next.borderColor = CHAIN_ACCENT;
          next.borderSize = 3;
          next.zIndex = 3;
        }
        return next;
      },
      edgeReducer: (edge, attrs) => {
        const style = edgeStyleFor(attrs.kind as string);
        const g = sigma?.getGraph();
        const source = g?.source(edge);
        const target = g?.target(edge);
        // Day 7 Task 8 — folder LOD. In cluster mode only the per-pair
        // representative edges are drawn; everything else (including
        // intra-cluster edges) is hidden so the screen reads as folder ↔
        // folder rather than a tangle.
        if (inLodRef && clusteringRef.clusterCount > 0) {
          if (!clusteringRef.representativeEdges.has(edge)) {
            return { ...attrs, hidden: true };
          }
          return {
            ...attrs,
            color: style.color,
            size: Math.max(style.size, 1.5),
            type: style.type,
          };
        }
        // Day 6 Task 8 — edge visibility under focus.
        if (focusStack.length > 0 && !visibleEdgesRef.has(edge)) {
          return { ...attrs, hidden: true };
        }
        // Edge hidden iff either endpoint is kind-filtered. Reading the
        // endpoints' kinds back off the graph is O(1) and avoids stashing
        // them on the edge attrs.
        if (source !== undefined && target !== undefined && g) {
          const sKind = g.getNodeAttribute(source, 'kind') as string | undefined;
          const tKind = g.getNodeAttribute(target, 'kind') as string | undefined;
          if ((sKind && hiddenKindsRef.has(sKind)) || (tKind && hiddenKindsRef.has(tKind))) {
            return { ...attrs, hidden: true };
          }
          // Day 9 — domain toggle hides edges by their own kind AND by
          // endpoint domain. The endpoint check catches the bridging
          // `script_declares_class` edge automatically (its target is a
          // code-kind node, so it disappears in assets-only).
          if (
            edgeHiddenByDomain(domainRef, attrs.kind as string) ||
            (sKind && nodeHiddenByDomain(domainRef, sKind)) ||
            (tKind && nodeHiddenByDomain(domainRef, tKind))
          ) {
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
        // Day 9.4 — cross-domain chain accent. Two tiers:
        //  - Hover chain edges paint in CHAIN_ACCENT at 1.6× their styled
        //    size so the whole prefab→script→class→base highlight reads
        //    as one connected ribbon.
        //  - The bridging `script_declares_class` edge gets a softer
        //    always-on accent (50% alpha) so the asset/code boundary is
        //    legible even without hover.
        const inChain = chainEdgesRef.has(edge);
        const isBridge = attrs.kind === 'script_declares_class';
        let color = selectionMiss ? fade(style.color, 0.15) : style.color;
        let size = style.size;
        if (inChain) {
          color = CHAIN_ACCENT;
          size = style.size * 1.6;
        } else if (isBridge) {
          color = fade(CHAIN_ACCENT, 0.55);
        }
        return {
          ...attrs,
          color,
          size,
          type: style.type,
          zIndex: inChain ? 3 : 0,
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

    // Day 9.4 — hover-tracking for the cross-domain chain accent. We
    // debounce the chain compute on enter (so a fast cursor sweep across
    // 200 nodes doesn't fire 200 BFSes); leave clears immediately because
    // a delay there would leave stale highlight ghosts behind the cursor.
    sigma.on('enterNode', ({ node }) => {
      if (hoverDebounce) clearTimeout(hoverDebounce);
      hoverDebounce = setTimeout(() => {
        hoverDebounce = null;
        if (!currentGraph) return;
        const chain = computeCrossDomainChain(currentGraph, node);
        chainNodesRef = chain.nodes;
        chainEdgesRef = chain.edges;
        sigma?.refresh();
      }, 50);
    });
    sigma.on('leaveNode', () => {
      if (hoverDebounce) {
        clearTimeout(hoverDebounce);
        hoverDebounce = null;
      }
      if (chainNodesRef.size === 0 && chainEdgesRef.size === 0) return;
      chainNodesRef = new Set();
      chainEdgesRef = new Set();
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
    // Day 7 — start the worker after Sigma exists so per-tick graph mutations
    // immediately drive a repaint via the existing change listeners.
    if (useWorker && graph.order > 0) {
      layoutSupervisor = new LayoutSupervisor(graph);
      layoutSupervisor.start(INITIAL_LAYOUT_MS);
    }
    // Day 7 Task 8 — fresh clustering for the new graph; subscribe to the
    // camera so we know when to flip into / out of LOD mode.
    clusteringRef = buildClustering(graph);
    inLodRef = false;
    const camera = sigma.getCamera();
    camera.on('updated', () => {
      if (!sigma) return;
      const ratio = camera.ratio;
      const next = ratio > LOD_THRESHOLD;
      if (next !== inLodRef) {
        inLodRef = next;
        sigma.refresh();
      }
    });
    presentKinds = collectPresentKinds(graph);
    presentEdgeKinds = collectPresentEdgeKinds(graph) as Set<EdgeKind>;
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
    const layoutTail = useWorker
      ? ''
      : ` · layout running on main thread (Worker unavailable)`;
    baseStatus = `${snapshotSummary(res)}${droppedTail}${layoutTail}`;
    status = baseStatus;
  }
  // Day 6 Task 8: the active focus appends to the snapshot/filter status copy.
  // Keep the snapshot-derived prefix here so the focus-effect can re-render it
  // each time the user steps hops up/down without re-running renderSnapshot.
  let baseStatus = $state('');

  $effect(() => {
    const active = focusStack[focusStack.length - 1];
    if (!active || !currentGraph) {
      status = baseStatus || status;
      return;
    }
    const label = currentGraph.hasNode(active.nodeId)
      ? (currentGraph.getNodeAttribute(active.nodeId, 'label') as string) ?? active.nodeId
      : active.nodeId;
    const total = currentGraph.order;
    const visible = visibleNodesRef.size;
    const kindTail = active.kind === 'impact' ? ', impact' : `${active.hops} hop${active.hops === 1 ? '' : 's'}, ${active.direction}`;
    status = `${baseStatus} · focused on ${label} (${kindTail}) — ${visible}/${total} nodes visible`;
  });

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

  // Day 6: reset focus when a new snapshot loads (IDs may not be in the new
  // graph). The breadcrumb chips become meaningless across snapshots.
  function resetFocus(): void {
    focusStack = [];
    resetFocusCache();
  }

  async function loadSnapshot(): Promise<void> {
    if (!bridgeRef || bridgeRef.host === 'standalone') return;
    viewState = 'loading';
    status = 'loading project graph…';
    errorCopy = '';
    try {
      // Day 8.5 — opt in to class anchors so Day 8 code-edge expansion has
      // stable IDs to hang results on. The host applies the projection
      // after its cache lookup (Day 8.4), so this stays cheap.
      const res = await fetchSnapshot(bridgeRef.bridge, { include_class_anchors: true });
      expandedCodeAnchors = new Set();
      codeEdgeInflight.clear();
      lastSnapshot = res;
      currentRevision = res.revision ?? null;
      resetFocus();
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
        startDeltaPolling();
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

  function startDeltaPolling(): void {
    // Pre-Day-7 hosts omit `revision`; in that case stay on full-snapshot
    // semantics and never poll. Also skip when the panel is showing a
    // placeholder (standalone) or when already polling.
    if (currentRevision === null) return;
    if (!bridgeRef || bridgeRef.host === 'standalone') return;
    if (deltaPollTimer) return;
    deltaPollTimer = setInterval(() => void pollDelta(), DELTA_POLL_MS);
  }

  function stopDeltaPolling(): void {
    if (deltaPollTimer) {
      clearInterval(deltaPollTimer);
      deltaPollTimer = null;
    }
  }

  async function pollDelta(): Promise<void> {
    if (deltaInFlight) return;
    if (currentRevision === null) return;
    if (!bridgeRef || bridgeRef.host === 'standalone') return;
    if (!currentGraph) return;
    deltaInFlight = true;
    try {
      const res = await fetchSnapshotDelta(bridgeRef.bridge, currentRevision);
      if (res.reset) {
        // Cache cold / history exhausted / phase changed — re-render from
        // the carried full snapshot rather than refetching.
        if (!res.snapshot) {
          console.warn('[unity-index-graph] delta reset without snapshot payload');
          return;
        }
        const synthetic: SnapshotResponse = {
          generated_at: res.generated_at,
          snapshot: res.snapshot,
          revision: res.new_revision,
        };
        if (res.request_id !== undefined) synthetic.request_id = res.request_id;
        if (res.warnings !== undefined) synthetic.warnings = res.warnings;
        lastSnapshot = synthetic;
        currentRevision = res.new_revision;
        resetFocus();
        renderSnapshot(synthetic);
        return;
      }
      if (!res.delta) return;
      // Same revision → no-op; the host had nothing new for us.
      if (res.delta.new_revision === currentRevision) {
        return;
      }
      const result = applyDeltaToGraph(currentGraph, res.delta);
      currentRevision = res.new_revision;
      if (lastSnapshot) {
        // Stay reactive so the focus / status effects pick up the new revision.
        lastSnapshot = { ...lastSnapshot, revision: res.new_revision };
      }
      if (result.hadChanges) {
        // Filter set and visible-kinds row counts depend on what's currently
        // in the graph; recompute. The search effect also re-runs on
        // currentGraph identity, but the same Graph reference here means we
        // need to bump matched/related explicitly. Cheapest path: bump the
        // filter store revision so dependent effects re-fire.
        presentKinds = collectPresentKinds(currentGraph);
        presentEdgeKinds = collectPresentEdgeKinds(currentGraph) as Set<EdgeKind>;
        // Re-kick the worker so newly-added nodes (which start at random
        // [-1, 1]) settle next to their neighbours instead of sitting at
        // the origin. Short burst — most deltas touch a handful of nodes.
        layoutSupervisor?.kick(DELTA_LAYOUT_KICK_MS);
        // Cluster membership may have shifted (added/removed nodes change
        // which cluster owns each rep / which inter-cluster pairs exist).
        clusteringRef = buildClustering(currentGraph);
        sigma?.refresh();
      }
    } catch (e) {
      console.warn('[unity-index-graph] delta poll failed:', e);
    } finally {
      deltaInFlight = false;
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

  // Day 6 Task 7/8: recompute focus visibility whenever the stack or snapshot
  // changes. Pure local traversal — no bridge round-trip. We DO NOT re-run
  // ForceAtlas2 on focus (positions stay; visibility flips). See focus.ts for
  // the rationale and Day-7 caveats.
  $effect(() => {
    // Touch BOTH reactive deps before any early-return so they're tracked on
    // the first run, even when the snapshot hasn't arrived yet. Svelte 5
    // does per-run dependency tracking — without this, a first run with
    // lastSnapshot=null silently skips registering focusStack and later
    // focus mutations don't re-fire the effect.
    const stack = focusStack;
    const snap = lastSnapshot;
    if (!snap || stack.length === 0) {
      visibleNodesRef = new Set();
      visibleEdgesRef = new Set();
      impactClassRef = new Map();
      sigma?.refresh();
      return;
    }
    const v = computeVisibility(snap.snapshot, stack);
    visibleNodesRef = v.nodes;
    visibleEdgesRef = v.edges;
    impactClassRef = v.impactClass;
    sigma?.refresh();
  });

  // Day 6 Task 9: Esc clears the top focus frame — but only when no input is
  // focused, so typing Esc in the search bar still clears the search rather
  // than collapsing focus.
  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    if (focusStack.length === 0) return;
    const active = document.activeElement;
    if (active && active.tagName === 'INPUT') return;
    focusStack = focusStack.slice(0, -1);
  }

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
    domainRef = filterStore.domain;
    matchedRef = filterStore.matched;
    searchActiveRef = filterStore.isSearchActive();
    sigma?.refresh();
  });

  // Day 10 — diagnostics store mirror. Same shape as the filter effect: pull
  // into plain locals so the per-frame nodeReducer doesn't bounce off Svelte
  // tracking, and force-refresh sigma when any of the three modes flip.
  $effect(() => {
    void diagnosticsStore.revision;
    diagBadgesRef = diagnosticsStore.byNode;
    diagResolvedRef = diagnosticsStore.resolved;
    diagHeatmapRef = diagnosticsStore.heatmap;
    diagErrorsOnlyRef = diagnosticsStore.errorsOnly;
    sigma?.refresh();
  });

  // Day 10 — auto-refresh diagnostics when the overlay is enabled and the
  // underlying graph changes (full snapshot OR delta). We don't poll on a
  // timer: the host pushes new diagnostics into its cache as builds /
  // analyses complete, and the user can hit the Legend's "refresh" button
  // for an on-demand pull.
  $effect(() => {
    void diagnosticsStore.revision; // re-fire when enabled flips
    if (!diagnosticsStore.enabled) {
      diagnosticsStore.reset();
      return;
    }
    if (!bridgeRef || bridgeRef.host === 'standalone') return;
    if (!currentGraph) return;
    const targets = collectDiagnosticsTargets(currentGraph);
    void diagnosticsStore.refresh(bridgeRef.bridge, targets);
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
    stopDeltaPolling();
    layoutSupervisor?.kill();
    layoutSupervisor = null;
    detachDrag?.();
    detachDrag = null;
    sigma?.kill();
    sigma = null;
    currentGraph = null;
    clusteringRef = emptyClustering();
    inLodRef = false;
    resetFocusCache();
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (hoverDebounce) {
      clearTimeout(hoverDebounce);
      hoverDebounce = null;
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
      // Day 9 — domain may be missing on a pre-Day-9 host; coerce to default.
      filterStore.setDomain(FilterStore.coerceDomain(stored.domain));
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
      case 'focus_neighborhood': {
        // Day 6 Task 10 — local mutation, no bridge round-trip.
        focusStack = [...focusStack, { nodeId, hops: 1, direction: 'both', kind: 'neighbors' }];
        return;
      }
      case 'show_impact': {
        // Day 6 Task 10 — impact view = direction:'in' with deep hops so the
        // user sees the full reverse-reachable set. The traversal classifies
        // each impacted node and the reducer paints colored rings.
        focusStack = [...focusStack, { nodeId, hops: 4, direction: 'in', kind: 'impact' }];
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
      case 'expand_code_edges': {
        await expandCodeEdgesFor(nodeId);
        return;
      }
    }
  }

  // Day 9.3 — preset: fetch every transitive MonoBehaviour subclass from
  // the host and merge into the live graph. Reuses the delta-apply path so
  // layout / clustering / focus pick the new nodes up automatically.
  async function showMonoBehaviourSubclasses(): Promise<void> {
    if (!bridgeRef || bridgeRef.host === 'standalone' || !currentGraph) return;
    if (presetBusy) return;
    presetBusy = true;
    status = 'walking MonoBehaviour subclasses…';
    try {
      const res = await fetchSubtypes(bridgeRef.bridge, MONOBEHAVIOUR_ID);
      const result = applyDeltaToGraph(currentGraph, {
        base_revision: -1,
        new_revision: -1,
        generated_at: res.generated_at,
        source_phase: 'code',
        nodes_added: res.snapshot.nodes,
        nodes_removed: [],
        nodes_updated: [],
        edges_added: res.snapshot.edges,
        edges_removed: [],
        stats: res.snapshot.stats,
      });
      const added = res.snapshot.nodes.length;
      const edges = res.snapshot.edges.length;
      const truncated = res.warnings?.some((w) => w.code === 'subtypes_truncated') ?? false;
      const truncatedNote = truncated ? ' · truncated (raise subtypes_max_depth or shrink the scope)' : '';
      const droppedNote = result.droppedEdges > 0 ? `, ${result.droppedEdges} dropped` : '';
      status = `MonoBehaviours: +${added} nodes, +${edges} edges${droppedNote}${truncatedNote}`;
      presentKinds = collectPresentKinds(currentGraph);
      presentEdgeKinds = collectPresentEdgeKinds(currentGraph) as Set<EdgeKind>;
      // Push a focus frame anchored on MonoBehaviour so the camera trims
      // back to the inheritance subgraph the user just summoned. Direction
      // 'in' keeps to the upstream tree (subclasses → MonoBehaviour edges
      // are class_inherits_from with parent as target, so the inbound
      // closure is exactly the set we want to see).
      if (currentGraph.hasNode(MONOBEHAVIOUR_ID)) {
        focusStack = [
          ...focusStack,
          { nodeId: MONOBEHAVIOUR_ID, hops: 8, direction: 'in', kind: 'neighbors' },
        ];
      }
      // The host may not actually flag MonoBehaviour as a code-domain
      // anchor that user already-expanded — track it so the right-click
      // menu's "Expand code edges" stays consistent.
      expandedCodeAnchors = new Set([...expandedCodeAnchors, MONOBEHAVIOUR_ID]);
    } catch (e) {
      status = `MonoBehaviour preset failed: ${friendlyActionError((e as Error).message)}`;
    } finally {
      presetBusy = false;
    }
  }

  // Day 8.5 — fetch this node's C# semantic edges (inheritance, calls,
  // references) and merge them into the live graph. Idempotent: a node
  // that's already in `expandedCodeAnchors` short-circuits. Layout is left
  // to the existing supervisor — the new nodes get seeded positions by
  // `applyDeltaToGraph` and the next FA2 tick will pull them into place.
  async function expandCodeEdgesFor(nodeId: string): Promise<void> {
    if (!bridgeRef || bridgeRef.host === 'standalone') return;
    if (!currentGraph) return;
    const anchor = anchorIdFor(currentGraph, nodeId);
    if (!anchor) {
      status = 'no code anchor for this node';
      return;
    }
    if (expandedCodeAnchors.has(anchor)) {
      status = 'code edges already loaded for this node';
      return;
    }
    if (codeEdgeInflight.has(anchor)) {
      return; // dedup concurrent click
    }
    codeEdgeInflight.add(anchor);
    status = `loading code edges for ${anchor.replace('unity://csharp/T:', '')}…`;
    try {
      const res = await fetchCodeEdges(bridgeRef.bridge, anchor);
      // Reuse the delta-merge path so the renderer / layout / focus reducers
      // get the same code path they'd see from a real incremental update.
      const result = applyDeltaToGraph(currentGraph, {
        base_revision: -1,
        new_revision: -1,
        generated_at: res.generated_at,
        source_phase: 'code',
        nodes_added: res.snapshot.nodes,
        nodes_removed: [],
        nodes_updated: [],
        edges_added: res.snapshot.edges,
        edges_removed: [],
        stats: res.snapshot.stats,
      });
      expandedCodeAnchors = new Set([...expandedCodeAnchors, anchor]);
      const added = res.snapshot.nodes.length;
      const edges = res.snapshot.edges.length;
      const unresolved = res.unresolved_ids?.length ?? 0;
      const dropped = result.droppedEdges;
      const droppedNote = dropped > 0 ? `, ${dropped} dropped` : '';
      const unresolvedNote = unresolved > 0 ? `, ${unresolved} unresolved` : '';
      status = `+${added} nodes, +${edges} code edges${droppedNote}${unresolvedNote}`;
      // Recompute kind palette so any new code kinds (interface, method, …)
      // show up in the filter sidebar without a full snapshot reload.
      presentKinds = collectPresentKinds(currentGraph);
      presentEdgeKinds = collectPresentEdgeKinds(currentGraph) as Set<EdgeKind>;
    } catch (e) {
      status = `code edges failed: ${friendlyActionError((e as Error).message)}`;
    } finally {
      codeEdgeInflight.delete(anchor);
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

<svelte:window onkeydown={handleKeyDown} />

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
      <FilterSidebar
        {presentKinds}
        standalone={bridgeRef?.host === 'standalone'}
        {presetBusy}
        onShowMonoBehaviours={() => { void showMonoBehaviourSubclasses(); }}
      />
      <DomainToggle />
      <Legend present={presentEdgeKinds} />
      <SearchBar totalNodes={currentGraph?.order ?? 0} />
      <Breadcrumb
        stack={focusStack}
        graph={currentGraph}
        onPop={(index) => { focusStack = focusStack.slice(0, index); }}
        onReset={() => { focusStack = []; }}
        onUpdateHops={(hops) => {
          const last = focusStack[focusStack.length - 1];
          if (!last) return;
          focusStack = [...focusStack.slice(0, -1), { ...last, hops }];
        }}
        onUpdateDirection={(direction) => {
          const last = focusStack[focusStack.length - 1];
          if (!last) return;
          focusStack = [...focusStack.slice(0, -1), { ...last, direction }];
        }}
      />
      <SelectionPanel nodeId={selectedNode} graph={currentGraph} onClose={clearSelection} />
      <ContextMenu
        menu={menuState}
        graph={currentGraph}
        expandedCodeAnchors={expandedCodeAnchors}
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
