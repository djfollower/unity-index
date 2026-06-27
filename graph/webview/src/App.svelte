<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Graph from 'graphology';
  import Sigma from 'sigma';
  import {
    HELLO_GRAPH_TYPE,
    request,
    type HelloGraphRequest,
    type HelloGraphResponse,
  } from '@unity-index/graph-core';
  import { pickBridge } from './bridge/pick';

  let container: HTMLDivElement;
  let sigma: Sigma | null = null;
  let status = $state('initialising…');

  onMount(async () => {
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

    sigma = new Sigma(graph, container, {
      renderEdgeLabels: true,
      labelColor: { color: '#ddd' },
      edgeLabelColor: { color: '#999' },
    });

    const { bridge, host } = pickBridge();
    if (host === 'standalone') {
      status = 'standalone (no host) — 3 nodes hardcoded';
      return;
    }
    try {
      const res = await request<HelloGraphRequest, HelloGraphResponse>(
        bridge,
        HELLO_GRAPH_TYPE,
        { name: 'webview' },
        { timeoutMs: 5000 },
      );
      status = `bridge ok — ${res.host}: ${res.greeting}`;
      console.log('[unity-index-graph] hello round-trip:', res);
    } catch (e) {
      status = `bridge error: ${(e as Error).message}`;
      console.warn('[unity-index-graph] hello failed:', e);
    }
  });

  onDestroy(() => {
    sigma?.kill();
    sigma = null;
  });
</script>

<div class="root">
  <div class="status">{status}</div>
  <div class="canvas" bind:this={container}></div>
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
  .canvas {
    flex: 1 1 auto;
    min-height: 0;
    background: #181818;
  }
</style>
