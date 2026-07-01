// Day 11 Task 5: SVG export by walking Graphology + Sigma's display data.
// We hand-roll the SVG rather than relying on a library because:
//   1. no new webview dep (CSP stays tight — see Day 0.A).
//   2. Sigma has no built-in SVG renderer.
//   3. we only need circles, lines, and labels; that's ~40 lines of markup.
//
// Coordinate space: SVG viewport matches Sigma's canvas pixel dimensions.
// `sigma.graphToViewport({x,y})` converts graph coords to on-screen pixels,
// so nodes/edges land where the user sees them. `sigma.scaleSize(size)`
// converts a graph-space radius to on-screen pixels using the current
// camera ratio — exactly what the WebGL renderer does.
//
// Reducer parity: we skip any node whose `hidden` display flag is true
// (the same flag Sigma's reducers set for filtered / focus-excluded
// nodes). That way the SVG matches what's visible on the canvas — a
// user's filter narrowed the view; the export should not blow that up.

import type Sigma from 'sigma';

const SVG_BACKGROUND = '#1e1e1e';
/** Default label font — matches Sigma's default label renderer so text
 *  positions look consistent. If a future style.ts starts overriding the
 *  font we should thread it through here. */
const LABEL_FONT = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
const LABEL_COLOR = '#ddd';

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderViewportSvg(sigma: Sigma): string {
  const { width, height } = sigma.getDimensions();
  const graph = sigma.getGraph();

  const parts: string[] = [];
  parts.push(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  );
  parts.push(
    `<rect width="${width}" height="${height}" fill="${SVG_BACKGROUND}"/>`,
  );

  // Edges first so nodes and labels paint on top — same z-order as the
  // canvas renderer.
  const edgeLines: string[] = [];
  graph.forEachEdge((edge, _attrs, source, target) => {
    const ed = sigma.getEdgeDisplayData(edge);
    if (!ed || ed.hidden) return;
    const sd = sigma.getNodeDisplayData(source);
    const td = sigma.getNodeDisplayData(target);
    if (!sd || !td || sd.hidden || td.hidden) return;
    const p1 = sigma.graphToViewport({ x: sd.x, y: sd.y });
    const p2 = sigma.graphToViewport({ x: td.x, y: td.y });
    const strokeW = Math.max(0.5, sigma.scaleSize(ed.size ?? 1) / 4);
    edgeLines.push(
      `<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" stroke="${escapeXml(ed.color)}" stroke-width="${strokeW.toFixed(2)}" stroke-opacity="0.75"/>`,
    );
  });
  if (edgeLines.length > 0) {
    parts.push(`<g id="edges">${edgeLines.join('')}</g>`);
  }

  const nodeCircles: string[] = [];
  const labels: string[] = [];
  graph.forEachNode((node) => {
    const nd = sigma.getNodeDisplayData(node);
    if (!nd || nd.hidden) return;
    const p = sigma.graphToViewport({ x: nd.x, y: nd.y });
    const r = Math.max(1, sigma.scaleSize(nd.size));
    nodeCircles.push(
      `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${escapeXml(nd.color)}"/>`,
    );
    if (nd.label && (nd.forceLabel || nd.size >= 6)) {
      const textX = p.x + r + 3;
      const textY = p.y + 4;
      labels.push(
        `<text x="${textX.toFixed(1)}" y="${textY.toFixed(1)}" font="${LABEL_FONT}" fill="${LABEL_COLOR}">${escapeXml(nd.label)}</text>`,
      );
    }
  });
  parts.push(`<g id="nodes">${nodeCircles.join('')}</g>`);
  if (labels.length > 0) {
    parts.push(`<g id="labels" font-family="system-ui, sans-serif" font-size="11">${labels.join('')}</g>`);
  }

  parts.push('</svg>');
  return parts.join('');
}
