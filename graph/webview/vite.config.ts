import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single-file output: inlines JS + CSS into one index.html. Why:
//   - Rider's JCEF loads the bundle via JBCefBrowser.loadHTML(string), which
//     sidesteps custom-scheme registration entirely (no public API to mark
//     a custom scheme as "standard" for ESM CORS purposes in 2025.1).
//   - VS Code's webview can load it as a single string with a strict
//     nonce-based CSP, no asWebviewUri rewrites for external assets.
//   - Trade: ~190 KB inline. Still well under our 500 KB gzipped budget.
//
// `base: './'` is still set for safety; with everything inline there are no
// asset URLs to resolve, but it costs nothing.
export default defineConfig({
  base: './',
  plugins: [svelte(), viteSingleFile()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false, // inlining 1 MB of base64-encoded source maps would dwarf the bundle
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000, // force every asset inline
  },
  server: {
    port: 5173,
  },
});
