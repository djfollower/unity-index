# `graph/webview`

The Vite + Svelte application that renders the graph. Builds to a static bundle (`dist/`) that is copied into both the VSIX and the Rider plugin zip at package time.

## What lives here

- **Svelte components** — panel chrome (sidebar, filter UI, search bar, context menus, metadata panels).
- **Sigma rendering** — canvas setup, layouts, node/edge styling, viewport controls.
- **Graphology integration** — pulls the data model from `core/`; Sigma reads from the Graphology instance.
- **`vite.config.ts`** — output target ES2022, Svelte plugin, dev-mode console piping.

## What does NOT live here

- Host APIs. Components import the `HostBridge` interface from `core/`, never `vscode.*` or JCEF directly.
- Graph algorithms or schema types — those live in `core/`.

## Bundle contract

Output: `dist/index.html` + assets. Both bridges load `index.html` into a webview/JCEF browser. The bundle ships with no network dependencies — everything inline or relative.

Budget: ≤500KB gzipped initial, 1MB hard ceiling (see [`docs/graph-decisions.md`](../../docs/graph-decisions.md) §13).
