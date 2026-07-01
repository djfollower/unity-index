<script lang="ts">
  // Day 11 Task 3 — saved views dropdown. Sits next to Presets in the
  // FilterSidebar footer area. Three actions:
  //   • Save — captures current filter / focus / camera via the parent's
  //     `captureCurrent()` callback, wraps in a `SavedView`, upserts through
  //     the store (which persists via the bridge).
  //   • Load — click a row, parent's `onLoad(view)` applies filter/focus/
  //     camera to the live sigma graph.
  //   • Delete — trash button per row, confirms via native confirm().
  //
  // Standalone mode (no host bridge) disables the button — nothing to
  // persist against.

  import type { SavedView, HostBridge } from '@unity-index/graph-core';
  import { savedViewsStore } from './savedViewsStore.svelte';

  interface CaptureResult {
    filter: SavedView['filter'];
    focusStack: SavedView['focusStack'];
    camera: SavedView['camera'];
    positions?: SavedView['positions'];
  }

  interface Props {
    standalone: boolean;
    bridge: HostBridge | null;
    captureCurrent: () => CaptureResult;
    onLoad: (view: SavedView) => void;
  }

  let { standalone, bridge, captureCurrent, onLoad }: Props = $props();

  let open = $state(false);
  let saving = $state(false);
  let nameInput = $state('');
  let localError = $state<string | null>(null);

  function toggle() {
    open = !open;
    if (open) localError = null;
  }

  async function saveCurrent() {
    if (!bridge) return;
    const name = nameInput.trim();
    if (!name) {
      localError = 'Enter a name for this view.';
      return;
    }
    saving = true;
    localError = null;
    try {
      const captured = captureCurrent();
      const view: SavedView = {
        name,
        createdAt: new Date().toISOString(),
        filter: captured.filter,
        focusStack: captured.focusStack,
        camera: captured.camera,
        ...(captured.positions ? { positions: captured.positions } : {}),
      };
      await savedViewsStore.upsert(bridge, view);
      nameInput = '';
    } catch (e) {
      localError = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  async function removeView(name: string) {
    if (!bridge) return;
    // eslint-disable-next-line no-alert
    const ok = confirm(`Delete saved view "${name}"?`);
    if (!ok) return;
    try {
      await savedViewsStore.remove(bridge, name);
    } catch (e) {
      localError = e instanceof Error ? e.message : String(e);
    }
  }

  function loadView(view: SavedView) {
    onLoad(view);
    open = false;
  }
</script>

<section class="views" aria-label="Saved views">
  <header>
    <span>Saved views</span>
    <button
      type="button"
      class="toggle"
      disabled={standalone}
      onclick={toggle}
      title={standalone
        ? 'Saved views need a host bridge (run inside Rider / VS Code).'
        : open
          ? 'Hide saved views'
          : 'Show saved views'}
    >{open ? '▾' : '▸'}</button>
  </header>

  {#if open && !standalone}
    <div class="body">
      <div class="save-row">
        <input
          type="text"
          bind:value={nameInput}
          placeholder="Name this view…"
          disabled={saving}
          onkeydown={(e) => {
            if (e.key === 'Enter') void saveCurrent();
          }}
        />
        <button type="button" disabled={saving || nameInput.trim().length === 0} onclick={() => void saveCurrent()}>
          {saving ? '…' : 'Save'}
        </button>
      </div>

      {#if localError}
        <div class="error" role="alert">{localError}</div>
      {:else if savedViewsStore.error}
        <div class="error" role="alert">{savedViewsStore.error}</div>
      {/if}

      {#if savedViewsStore.views.length === 0}
        <div class="empty">No saved views yet. Save the current filter/focus/camera to bookmark it.</div>
      {:else}
        <ul>
          {#each savedViewsStore.views as v (v.name)}
            <li>
              <button type="button" class="row" onclick={() => loadView(v)} title={`Load "${v.name}"`}>
                <span class="name">{v.name}</span>
                <span class="date">{new Date(v.createdAt).toLocaleDateString()}</span>
              </button>
              <button
                type="button"
                class="delete"
                title={`Delete "${v.name}"`}
                onclick={(e) => { e.stopPropagation(); void removeView(v.name); }}
              >×</button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</section>

<style>
  .views {
    border-top: 1px solid #333;
    padding: 6px 10px 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #aaa;
  }
  .toggle {
    background: transparent;
    color: #aaa;
    border: none;
    cursor: pointer;
    font-size: 11px;
    padding: 0 2px;
  }
  .toggle:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 2px;
  }
  .save-row {
    display: flex;
    gap: 4px;
  }
  .save-row input {
    flex: 1;
    padding: 3px 5px;
    font-size: 11px;
    background: #1e1e1e;
    color: #ddd;
    border: 1px solid #444;
    border-radius: 3px;
  }
  .save-row button {
    padding: 3px 8px;
    font-size: 11px;
    background: #2a2a2a;
    color: #ddd;
    border: 1px solid #444;
    border-radius: 3px;
    cursor: pointer;
  }
  .save-row button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .empty {
    font-size: 10.5px;
    color: #888;
    padding: 4px 2px;
    line-height: 1.3;
  }
  .error {
    font-size: 10.5px;
    color: #f87171;
    padding: 2px 2px;
    line-height: 1.3;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 180px;
    overflow-y: auto;
  }
  li {
    display: flex;
    align-items: stretch;
    gap: 2px;
  }
  .row {
    flex: 1;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    font-size: 11px;
    background: #262626;
    color: #ddd;
    border: 1px solid #3a3a3a;
    border-radius: 3px;
    cursor: pointer;
    text-align: left;
  }
  .row:hover {
    background: #303030;
  }
  .name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .date {
    color: #888;
    font-size: 10px;
    flex-shrink: 0;
  }
  .delete {
    width: 22px;
    background: #262626;
    color: #aaa;
    border: 1px solid #3a3a3a;
    border-radius: 3px;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
  }
  .delete:hover {
    background: #3a2020;
    color: #f87171;
    border-color: #6a3030;
  }
</style>
