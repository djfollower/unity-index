// Day 11 Task 4: PNG export by compositing Sigma's per-layer canvases into
// one image. Sigma renders across several stacked <canvas> elements (edges
// → nodes → labels → hover overlays); reading any single one misses the
// others. We draw each into a fresh target canvas in the same z-order the
// DOM stacks them.
//
// Layer selection: skip transient overlays (mouse hover halo, drag cursor)
// so the exported PNG matches what the user sees on a still frame. The
// order is documented in sigma's `Sigma#createCanvas`; the four we care
// about are "edges", "nodes", "edgeLabels", "labels", "hoverNodes", plus
// optional "custom-*" layers a caller has added.

import type Sigma from 'sigma';

/** Ordered from bottom to top. `hoverNodes` is included because Day 6
 *  neighbour rings live there — a user exporting mid-focus expects them
 *  to appear. "mouse" is skipped: cursor artifacts don't belong in a still. */
const PNG_LAYER_ORDER = [
  'edges',
  'edgeLabels',
  'nodes',
  'hoverNodes',
  'labels',
] as const;

/** Background painted behind the transparent Sigma layers so the exported
 *  PNG isn't a see-through canvas over whatever the OS previewer defaults
 *  to. Matches the panel background in App.svelte's :global(body). */
const PNG_BACKGROUND = '#1e1e1e';

/** Renders the current Sigma viewport to a PNG-encoded byte array.
 *  Resolves with the raw bytes so the caller can hand them to `saveFile`.
 *  Throws when the browser can't produce a blob (extremely rare — no
 *  memory, or a canvas whose GL context was lost). */
export async function renderViewportPng(sigma: Sigma): Promise<Uint8Array> {
  const canvases = sigma.getCanvases();
  // First canvas defines the pixel dimensions — all layers are same-size.
  const first = Object.values(canvases).find((c): c is HTMLCanvasElement => !!c);
  if (!first) throw new Error('sigma_no_canvas');

  const target = document.createElement('canvas');
  target.width = first.width;
  target.height = first.height;
  const ctx = target.getContext('2d');
  if (!ctx) throw new Error('canvas_2d_unavailable');

  ctx.fillStyle = PNG_BACKGROUND;
  ctx.fillRect(0, 0, target.width, target.height);

  // Composite in z-order. drawImage silently no-ops for missing layers so
  // a future Sigma that drops one of these names doesn't break the export.
  for (const layer of PNG_LAYER_ORDER) {
    const src = canvases[layer];
    if (src) ctx.drawImage(src, 0, 0);
  }
  // Include any custom layers a caller registered but PNG_LAYER_ORDER
  // didn't know about (e.g. future clustering overlay). Drawn on top so
  // they don't get hidden behind labels.
  for (const [name, canvas] of Object.entries(canvases)) {
    if (PNG_LAYER_ORDER.includes(name as (typeof PNG_LAYER_ORDER)[number])) continue;
    if (name === 'mouse') continue;
    if (canvas) ctx.drawImage(canvas, 0, 0);
  }

  const blob: Blob | null = await new Promise((resolve) =>
    target.toBlob((b) => resolve(b), 'image/png'),
  );
  if (!blob) throw new Error('png_encoding_failed');
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}
