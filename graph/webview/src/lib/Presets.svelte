<script lang="ts">
  // Day 9.3 — single-button preset rail. Today's only entry is "MonoBehaviour
  // subclasses", which fires a transitive-subtypes BFS on the host side and
  // merges the result into the live graph. Sits in the FilterSidebar header
  // area so it's discoverable but doesn't fight the domain toggle for
  // top-centre attention.
  //
  // The button is intentionally inert when no bridge is available
  // (standalone dev mode) — there's no host to walk the hierarchy.

  interface Props {
    standalone: boolean;
    busy: boolean;
    onShowMonoBehaviours: () => void;
  }

  let { standalone, busy, onShowMonoBehaviours }: Props = $props();
</script>

<section class="presets" aria-label="Presets">
  <header>Presets</header>
  <button
    type="button"
    disabled={standalone || busy}
    onclick={onShowMonoBehaviours}
    title={standalone
      ? 'Presets need a host bridge (run inside Rider / VS Code).'
      : 'Walk every MonoBehaviour subclass via the C# Dev Kit / RD type-hierarchy provider and add them to the graph.'}
  >
    {busy ? 'Loading…' : 'Show MonoBehaviour subclasses'}
  </button>
</section>

<style>
  .presets {
    border-top: 1px solid #333;
    padding: 6px 10px 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  header {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #aaa;
  }
  button {
    width: 100%;
    padding: 4px 6px;
    font-size: 11px;
    background: #2a2a2a;
    color: #ddd;
    border: 1px solid #444;
    border-radius: 3px;
    cursor: pointer;
    text-align: left;
  }
  button:hover:not(:disabled) {
    background: #333;
  }
  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>
