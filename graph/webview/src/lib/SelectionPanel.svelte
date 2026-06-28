<script lang="ts">
  // Day 4 Task 3: side panel that mirrors the currently selected graph node.
  // Pure read on Graphology + node-style palette — no host hop. Day 4 Tasks 5
  // and 8 hang "open file" / "copy GUID" / "find usages" off the same data.
  //
  // The panel is rendered alongside the canvas (absolutely positioned overlay
  // on the right edge) and stays visible until the user clicks the stage,
  // clicks the close affordance, or picks a context-menu action that hides it.
  //
  // Props are deliberately raw (Graph instance + node id) rather than a
  // pre-built view model so this component can stay in lockstep with whatever
  // attrs the snapshot builder happens to attach to the node. Day 8's code
  // nodes will land here automatically once they carry path/guid metadata.

  import type Graph from 'graphology';
  import { nodeStyleFor } from './style';

  interface Props {
    nodeId: string | null;
    graph: Graph | null;
    onClose: () => void;
  }

  let { nodeId, graph, onClose }: Props = $props();

  // Re-derive everything from (nodeId, graph) so a selection change rebinds
  // the panel without us having to mirror state. `graph` is the same instance
  // Sigma is rendering, so attrs read here are the same the user sees.
  const details = $derived.by(() => {
    if (!nodeId || !graph) return null;
    if (!graph.hasNode(nodeId)) return null;
    const attrs = graph.getNodeAttributes(nodeId) as Record<string, unknown>;
    const kind = typeof attrs.kind === 'string' ? attrs.kind : 'unknown';
    const label = typeof attrs.label === 'string' ? attrs.label : nodeId;
    const path = typeof attrs.path === 'string' ? attrs.path : undefined;
    const guid = typeof attrs.guid === 'string' ? attrs.guid : undefined;
    return {
      kind,
      label,
      path,
      guid,
      color: nodeStyleFor(kind).color,
      inDegree: graph.inDegree(nodeId),
      outDegree: graph.outDegree(nodeId),
      degree: graph.degree(nodeId),
    };
  });

  let copyHint = $state<string | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  async function copyToClipboard(value: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      copyHint = `Copied ${label}`;
    } catch {
      copyHint = `Copy failed — ${label}`;
    }
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyHint = null;
    }, 1500);
  }
</script>

{#if details}
  <aside class="panel" aria-label="Node details">
    <header class="head">
      <span class="kind-chip" style:background-color={details.color} title={details.kind}>
        {details.kind}
      </span>
      <button class="close" onclick={onClose} aria-label="Close panel" title="Close (or click empty stage)">×</button>
    </header>
    <h2 class="label" title={details.label}>{details.label}</h2>

    {#if details.path}
      <section class="row">
        <div class="row-label">Path</div>
        <div class="row-value path" title={details.path}>{details.path}</div>
        <button class="ghost" onclick={() => copyToClipboard(details.path!, 'path')}>Copy</button>
      </section>
    {/if}

    {#if details.guid}
      <section class="row">
        <div class="row-label">GUID</div>
        <div class="row-value guid" title={details.guid}>{details.guid}</div>
        <button class="ghost" onclick={() => copyToClipboard(details.guid!, 'GUID')}>Copy</button>
      </section>
    {/if}

    <section class="row">
      <div class="row-label">Neighbors</div>
      <div class="row-value muted">
        <span title="Incoming edges">← {details.inDegree}</span>
        <span class="sep">·</span>
        <span title="Outgoing edges">{details.outDegree} →</span>
        <span class="sep">·</span>
        <span title="Total degree">total {details.degree}</span>
      </div>
    </section>

    <footer class="hint">
      <span>Double-click node to open · right-click for more</span>
      {#if copyHint}
        <span class="toast">{copyHint}</span>
      {/if}
    </footer>
  </aside>
{/if}

<style>
  .panel {
    position: absolute;
    top: 12px;
    right: 12px;
    width: 280px;
    max-height: calc(100% - 24px);
    overflow: auto;
    background: rgba(28, 28, 28, 0.96);
    border: 1px solid #333;
    border-radius: 6px;
    color: #ddd;
    padding: 12px 14px;
    font-size: 12px;
    line-height: 1.45;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    z-index: 2;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .kind-chip {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #111;
    padding: 2px 8px;
    border-radius: 999px;
  }
  .close {
    background: transparent;
    border: 0;
    color: #888;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
  }
  .close:hover {
    color: #ddd;
  }
  .label {
    margin: 0 0 10px 0;
    font-size: 14px;
    font-weight: 600;
    color: #fff;
    word-break: break-all;
  }
  .row {
    display: grid;
    grid-template-columns: 64px 1fr auto;
    gap: 6px 8px;
    align-items: baseline;
    margin: 6px 0;
  }
  .row-label {
    color: #888;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .row-value {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    word-break: break-all;
  }
  .row-value.muted {
    color: #aaa;
    font-family: system-ui, -apple-system, sans-serif;
  }
  .sep {
    margin: 0 6px;
    color: #555;
  }
  .ghost {
    background: transparent;
    border: 1px solid #444;
    color: #bbb;
    border-radius: 3px;
    padding: 2px 8px;
    font-size: 11px;
    cursor: pointer;
  }
  .ghost:hover {
    background: #2a2a2a;
    color: #fff;
  }
  .hint {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid #2a2a2a;
    color: #777;
    font-size: 11px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .toast {
    color: #88c;
    font-style: italic;
  }
</style>
