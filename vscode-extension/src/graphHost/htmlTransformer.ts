import * as crypto from "crypto";
import * as vscode from "vscode";

// Prepares the vite-plugin-singlefile output for a VS Code webview.
//
// The bundle is a single self-contained HTML file (one inline
// <script type="module"> + one inline <style>), so the transform only:
//   1. attaches a nonce to every <script> and <style>;
//   2. injects a strict CSP <meta> whitelisting exactly that nonce.
//
// No asset-URL rewriting — there are no external src=/href= for scripts or
// styles. data: / blob: are still allowed for Sigma's canvas sprite atlas
// and the (forthcoming Day 7) layout worker.
export function transformHtml(html: string, _webview: vscode.Webview): string {
  const nonce = crypto.randomBytes(16).toString("base64");

  const csp = [
    `default-src 'none'`,
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    `img-src 'self' data: blob:`, // Sigma canvas sprites
    `font-src 'self' data:`,
    `connect-src 'self'`,
    `worker-src 'self' blob:`, // pre-emptive for Day 7 layout worker
  ].join("; ");
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;

  let out = html.replace(
    /<script(\b[^>]*)>/gi,
    (_m, attrs: string) => `<script${attrs} nonce="${nonce}">`,
  );
  out = out.replace(
    /<style(\b[^>]*)>/gi,
    (_m, attrs: string) => `<style${attrs} nonce="${nonce}">`,
  );

  if (/<head[^>]*>/i.test(out)) {
    return out.replace(/<head([^>]*)>/i, `<head$1>\n  ${cspMeta}`);
  }
  return `${cspMeta}\n${out}`;
}
