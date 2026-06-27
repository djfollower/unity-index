import * as fs from "fs";
import * as vscode from "vscode";

import type {
  BridgeEnvelope,
  RequestEnvelope,
  ResponseEnvelope,
} from "@unity-index/graph-core";

import { transformHtml } from "./htmlTransformer";
import { dispatchRequest } from "./hostHandlers";

// Editor-area webview panel hosting the unity-index-graph Vite bundle. We use
// a panel (not a sidebar WebviewView) because a node graph wants the editor
// real estate, not a 200px-wide sidebar pane. Sidebar can be added later if
// useful.
export class GraphPanel {
  private static current: GraphPanel | undefined;
  private static readonly viewType = "unityIndex.graphPanel";

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly log: (msg: string) => void,
  ) {
    this.setHtml();
    this.panel.webview.onDidReceiveMessage((env: BridgeEnvelope) =>
      this.handleMessage(env),
    );
    this.panel.onDidDispose(() => {
      if (GraphPanel.current === this) {
        GraphPanel.current = undefined;
      }
    });
  }

  static reveal(extensionUri: vscode.Uri, log: (msg: string) => void): void {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      GraphPanel.viewType,
      "Unity Index Graph",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "dist", "graph"),
        ],
        retainContextWhenHidden: true,
      },
    );
    GraphPanel.current = new GraphPanel(panel, extensionUri, log);
  }

  private setHtml(): void {
    const distRoot = vscode.Uri.joinPath(this.extensionUri, "dist", "graph");
    const indexHtml = vscode.Uri.joinPath(distRoot, "index.html");
    let html: string;
    try {
      html = fs.readFileSync(indexHtml.fsPath, "utf8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`graph: failed to read bundle at ${indexHtml.fsPath}: ${msg}`);
      this.panel.webview.html = `<!doctype html><body style="font-family:monospace;padding:16px;color:#ddd;background:#181818;">
        <h3>Unity Index Graph — bundle missing</h3>
        <p>Expected at: <code>${indexHtml.fsPath}</code></p>
        <p>Build it with <code>npm -w @unity-index/graph-webview run build</code> then repackage the extension.</p>
        <pre>${msg}</pre>
      </body>`;
      return;
    }
    this.panel.webview.html = transformHtml(html, this.panel.webview);
  }

  private async handleMessage(env: BridgeEnvelope): Promise<void> {
    if (
      !env ||
      typeof env !== "object" ||
      typeof (env as { kind?: unknown }).kind !== "string"
    ) {
      return;
    }
    if (env.kind !== "request") return;

    const req = env as RequestEnvelope;
    let response: ResponseEnvelope;
    try {
      const payload = await dispatchRequest(req.type, req.payload);
      response = {
        kind: "response",
        id: req.id,
        type: req.type,
        payload,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`graph: request '${req.type}' failed: ${message}`);
      response = {
        kind: "response",
        id: req.id,
        type: req.type,
        error: { message },
      };
    }
    this.panel.webview.postMessage(response);
  }
}
