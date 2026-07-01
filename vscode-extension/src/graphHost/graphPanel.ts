import * as fs from "fs";
import * as vscode from "vscode";

import type {
  BridgeEnvelope,
  EventEnvelope,
  ExportDocument,
  ProgressEnvelope,
  ProgressPayload,
  RequestEnvelope,
  ResponseEnvelope,
  SnapshotLoadStaticEvent,
} from "@unity-index/graph-core";
import { SNAPSHOT_LOAD_STATIC_TYPE } from "@unity-index/graph-core";

import { transformHtml } from "./htmlTransformer";
import { dispatchRequest, HostHandlerContext } from "./hostHandlers";

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
    private readonly hostCtx: HostHandlerContext,
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

  static reveal(
    extensionUri: vscode.Uri,
    log: (msg: string) => void,
    hostCtx: HostHandlerContext,
  ): void {
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
    GraphPanel.current = new GraphPanel(panel, extensionUri, log, hostCtx);
  }

  /** Day 11 Task 8 — hand the webview a pre-parsed ExportDocument to view
   *  offline. Called by the "Open Graph from File…" command. Reveals the
   *  panel first so users don't have to click twice, then fires the event. */
  static loadStatic(
    extensionUri: vscode.Uri,
    log: (msg: string) => void,
    hostCtx: HostHandlerContext,
    document: ExportDocument,
  ): void {
    GraphPanel.reveal(extensionUri, log, hostCtx);
    const panel = GraphPanel.current;
    if (!panel) return;
    const payload: SnapshotLoadStaticEvent = { document };
    const env: EventEnvelope = {
      kind: "event",
      type: SNAPSHOT_LOAD_STATIC_TYPE,
      payload,
    };
    // Race: the webview may not have mounted its message listener yet on a
    // cold reveal. Retry once after a beat so the first-import UX doesn't
    // require the user to click "Open from file" twice.
    panel.panel.webview.postMessage(env);
    setTimeout(() => {
      panel.panel.webview.postMessage(env);
    }, 400);
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
    // Progress emitter for this in-flight request. Any long-running handler
    // (unity_graph_snapshot on a very big project) can call it to reset the
    // webview's inter-message timeout. Stops posting after the final response
    // to avoid stray heartbeats leaking into future requests.
    let stopped = false;
    const emit = (payload: ProgressPayload | undefined): void => {
      if (stopped) return;
      const env: ProgressEnvelope = {
        kind: "progress",
        id: req.id,
        type: req.type,
        payload,
      };
      this.panel.webview.postMessage(env);
    };
    let response: ResponseEnvelope;
    try {
      const payload = await dispatchRequest(req.type, req.payload, this.hostCtx, {
        onProgress: emit,
      });
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
    } finally {
      stopped = true;
    }
    this.panel.webview.postMessage(response);
  }
}
