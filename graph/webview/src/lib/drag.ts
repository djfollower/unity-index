// Day 3 Task 8: node drag. Canonical Sigma 3 pattern — downNode disables
// the camera and captures the node, mousemovebody projects viewport→graph
// coords, mouseup releases and re-enables the camera.
//
// Lives in its own module so Day 7 can swap in a worker-backed layout
// without touching App.svelte. Returns a teardown function for symmetry
// with the rest of the lifecycle (onDestroy in App.svelte).

import type Graph from 'graphology';
import type Sigma from 'sigma';
import type { MouseCoords } from 'sigma/types';

export function attachDragBehavior(sigma: Sigma, graph: Graph): () => void {
  let draggedNode: string | null = null;
  const mouse = sigma.getMouseCaptor();
  const camera = sigma.getCamera();

  const onDownNode = ({ node }: { node: string }) => {
    draggedNode = node;
    graph.setNodeAttribute(node, 'highlighted', true);
    // Pin the camera while we drag a node so the drag doesn't double as a pan.
    camera.disable();
  };

  const onMouseMoveBody = (e: MouseCoords) => {
    if (!draggedNode) return;
    const pos = sigma.viewportToGraph(e);
    graph.setNodeAttribute(draggedNode, 'x', pos.x);
    graph.setNodeAttribute(draggedNode, 'y', pos.y);
    e.preventSigmaDefault();
    e.original.preventDefault();
    e.original.stopPropagation();
  };

  const onMouseUp = () => {
    if (!draggedNode) return;
    graph.removeNodeAttribute(draggedNode, 'highlighted');
    draggedNode = null;
    camera.enable();
  };

  sigma.on('downNode', onDownNode);
  mouse.on('mousemovebody', onMouseMoveBody);
  mouse.on('mouseup', onMouseUp);

  return () => {
    sigma.off('downNode', onDownNode);
    mouse.off('mousemovebody', onMouseMoveBody);
    mouse.off('mouseup', onMouseUp);
  };
}
