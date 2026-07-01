<script lang="ts">
  // Day 11 — export toolbar. Sits above the Legend in the top-right area.
  // Task 4 ships the PNG button; Task 5 adds SVG, Task 6 adds JSON. Kept
  // as a single component so the three buttons share one style and one
  // "busy" indicator without three separate absolute-positioned widgets.

  interface Props {
    standalone: boolean;
    /** Fires when the user clicks the PNG button. App.svelte owns the
     *  sigma instance and the save dispatch; this component is presentation
     *  only. */
    onExportPng: () => Promise<void>;
    onExportSvg: () => Promise<void>;
    onExportJson: () => Promise<void>;
  }

  let { standalone, onExportPng, onExportSvg, onExportJson }: Props = $props();

  let busy = $state(false);
  let lastStatus = $state<string | null>(null);

  async function run(kind: 'PNG' | 'SVG' | 'JSON', fn: () => Promise<void>) {
    if (busy || standalone) return;
    busy = true;
    lastStatus = null;
    try {
      await fn();
      lastStatus = `${kind} saved`;
    } catch (e) {
      lastStatus = e instanceof Error ? e.message : 'export failed';
    } finally {
      busy = false;
      setTimeout(() => (lastStatus = null), 3000);
    }
  }
</script>

<div class="export-bar" role="toolbar" aria-label="Export">
  <button
    type="button"
    disabled={busy || standalone}
    onclick={() => void run('PNG', onExportPng)}
    title={standalone
      ? 'Exports need a host bridge (run inside Rider / VS Code).'
      : 'Export the current viewport as a PNG image.'}
  >
    {busy ? '…' : 'PNG'}
  </button>
  <button
    type="button"
    disabled={busy || standalone}
    onclick={() => void run('SVG', onExportSvg)}
    title={standalone
      ? 'Exports need a host bridge (run inside Rider / VS Code).'
      : 'Export the current viewport as SVG (vector, editable).'}
  >
    {busy ? '…' : 'SVG'}
  </button>
  <button
    type="button"
    disabled={busy || standalone}
    onclick={() => void run('JSON', onExportJson)}
    title={standalone
      ? 'Exports need a host bridge (run inside Rider / VS Code).'
      : 'Export the full graph (nodes, edges, saved views) as JSON — shareable and re-importable.'}
  >
    {busy ? '…' : 'JSON'}
  </button>
  {#if lastStatus}
    <span class="status">{lastStatus}</span>
  {/if}
</div>

<style>
  .export-bar {
    /* Sit to the left of the 280px SearchBar (top:10 right:10) — 280 + 10
       gap = 300. In narrow mode SearchBar drops to the second row, so we
       shift too (below the DomainToggle banner). */
    position: absolute;
    top: 10px;
    right: 300px;
    display: flex;
    align-items: center;
    gap: 6px;
    background: rgba(28, 28, 28, 0.92);
    border: 1px solid #333;
    border-radius: 6px;
    padding: 4px 6px;
    z-index: 6;
  }
  @media (max-width: 760px) {
    .export-bar {
      top: 92px;
      right: 10px;
    }
  }
  button {
    padding: 3px 10px;
    font-size: 11px;
    background: #2a2a2a;
    color: #ddd;
    border: 1px solid #444;
    border-radius: 3px;
    cursor: pointer;
    font-weight: 600;
    letter-spacing: 0.03em;
  }
  button:hover:not(:disabled) {
    background: #333;
  }
  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .status {
    font-size: 10.5px;
    color: #aaa;
    padding: 0 4px;
    max-width: 200px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
