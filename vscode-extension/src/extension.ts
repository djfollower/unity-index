import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";

import { ToolRegistry } from "./tools/toolRegistry";
import { JsonRpcHandler } from "./server/jsonRpcHandler";
import { HttpServer } from "./server/httpServer";
import { ReadinessGate } from "./server/readinessGate";
import { ToolContext } from "./tools/abstractTool";
import { UnityAssetIndexManager } from "./utils/unityAssetIndexManager";
import { GraphSnapshotCache } from "./utils/graphSnapshotCache";

// Navigation
import { FindReferencesTool } from "./tools/navigation/findReferencesTool";
import { FindDefinitionTool } from "./tools/navigation/findDefinitionTool";
import { FindImplementationsTool } from "./tools/navigation/findImplementationsTool";
import { TypeHierarchyTool } from "./tools/navigation/typeHierarchyTool";
import { CallHierarchyTool } from "./tools/navigation/callHierarchyTool";
import { FindSuperMethodsTool } from "./tools/navigation/findSuperMethodsTool";
import { FindSymbolTool } from "./tools/navigation/findSymbolTool";
import { FindClassTool } from "./tools/navigation/findClassTool";
import { FindFileTool } from "./tools/navigation/findFileTool";
import { FileStructureTool } from "./tools/navigation/fileStructureTool";
import { SearchTextTool } from "./tools/navigation/searchTextTool";
import { ReadFileTool } from "./tools/navigation/readFileTool";
import { GetSymbolBodyTool } from "./tools/navigation/getSymbolBodyTool";

// Intelligence
import { GetDiagnosticsTool } from "./tools/intelligence/getDiagnosticsTool";

// Project
import { GetIndexStatusTool } from "./tools/project/getIndexStatusTool";
import { SyncFilesTool } from "./tools/project/syncFilesTool";
import { BuildProjectTool } from "./tools/project/buildProjectTool";

// Unity
import { GetProjectContextTool } from "./tools/unity/getProjectContextTool";
import { GetAssemblyMapTool } from "./tools/unity/getAssemblyMapTool";
import { GetComponentUsageTool } from "./tools/unity/getComponentUsageTool";
import { GetUnityEventBindingsTool } from "./tools/unity/getUnityEventBindingsTool";
import { GetSerializedFieldValuesTool } from "./tools/unity/getSerializedFieldValuesTool";
import { FindGetComponentPatternsTool } from "./tools/unity/findGetComponentPatternsTool";
import { GetApiUsageTool } from "./tools/unity/getApiUsageTool";
import { FindAssetReferencesTool } from "./tools/unity/findAssetReferencesTool";
import { UnityGraphSnapshotTool } from "./tools/unity/unityGraphSnapshotTool";
import { UnityGraphSnapshotDeltaTool } from "./tools/unity/unityGraphSnapshotDeltaTool";
import { UnityGraphNeighborsTool } from "./tools/unity/unityGraphNeighborsTool";
import { UnityGraphImpactTool } from "./tools/unity/unityGraphImpactTool";
import { UnityGraphContextTool } from "./tools/unity/unityGraphContextTool";
import { UnityGraphCodeEdgesTool } from "./tools/unity/unityGraphCodeEdgesTool";
import { UnityGraphDiagnosticsTool } from "./tools/unity/unityGraphDiagnosticsTool";
import { UnityGraphExportTool } from "./tools/unity/unityGraphExportTool";

// Batch dispatcher
import { BatchTool } from "./tools/batchTool";

// Graph webview
import { GraphPanel } from "./graphHost/graphPanel";
import { assertCompatibleExport, ExportValidationError } from "@unity-index/graph-core";

interface RunningServer {
  http: HttpServer;
  readiness: ReadinessGate;
  assetIndex: UnityAssetIndexManager;
  graphCache: GraphSnapshotCache;
  port: number;
  socketPath?: string;
}

let running: RunningServer | undefined;
let output: vscode.OutputChannel | undefined;

function log(msg: string): void {
  output?.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  // Navigation
  registry.register(new FindReferencesTool());
  registry.register(new FindDefinitionTool());
  registry.register(new FindImplementationsTool());
  registry.register(new TypeHierarchyTool());
  registry.register(new CallHierarchyTool());
  registry.register(new FindSuperMethodsTool());
  registry.register(new FindSymbolTool());
  registry.register(new FindClassTool());
  registry.register(new FindFileTool());
  registry.register(new FileStructureTool());
  registry.register(new SearchTextTool());
  registry.register(new ReadFileTool());
  registry.register(new GetSymbolBodyTool());
  // Intelligence
  registry.register(new GetDiagnosticsTool());
  // Project
  registry.register(new GetIndexStatusTool());
  registry.register(new SyncFilesTool());
  registry.register(new BuildProjectTool());
  // Unity
  registry.register(new GetProjectContextTool());
  registry.register(new GetAssemblyMapTool());
  registry.register(new GetComponentUsageTool());
  registry.register(new GetUnityEventBindingsTool());
  registry.register(new GetSerializedFieldValuesTool());
  registry.register(new FindGetComponentPatternsTool());
  registry.register(new GetApiUsageTool());
  registry.register(new FindAssetReferencesTool());
  registry.register(new UnityGraphSnapshotTool());
  registry.register(new UnityGraphSnapshotDeltaTool());
  registry.register(new UnityGraphNeighborsTool());
  registry.register(new UnityGraphImpactTool());
  registry.register(new UnityGraphContextTool());
  registry.register(new UnityGraphCodeEdgesTool());
  registry.register(new UnityGraphDiagnosticsTool());
  registry.register(new UnityGraphExportTool());
  // Batch dispatcher must be registered last — it holds a reference to the
  // registry so it can dispatch entries to any other registered tool.
  registry.register(new BatchTool(registry));
  return registry;
}

function defaultSocketPath(): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\unity-index-mcp-vscode`;
  }
  return path.join(os.tmpdir(), "unity-index-mcp-vscode.sock");
}

async function startServer(): Promise<void> {
  if (running) {
    log("Server already running.");
    return;
  }

  const config = vscode.workspace.getConfiguration("unityIndex.mcp");
  const host = config.get<string>("host") ?? "127.0.0.1";
  const port = config.get<number>("port") ?? 29270;
  const readinessTimeoutMs = config.get<number>("readinessTimeoutMs") ?? 120_000;
  const useUnixSocket = config.get<boolean>("unixSocketEnabled") ?? true;
  const socketPathSetting = config.get<string>("unixSocketPath") ?? "";
  const socketPath = socketPathSetting.length > 0 ? socketPathSetting : defaultSocketPath();

  const readiness = new ReadinessGate();
  readiness.start();
  const graphCache = new GraphSnapshotCache(log);
  const assetIndex = new UnityAssetIndexManager(log, graphCache);

  const registry = buildRegistry();
  const toolCtx: ToolContext = {
    readiness,
    readinessTimeoutMs,
    log,
    assetIndex,
    graphCache,
  };
  const handler = new JsonRpcHandler(registry, toolCtx);
  const http = new HttpServer(handler, log);

  try {
    await http.start(host, port);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    readiness.stop();
    log(`Failed to start MCP HTTP server: ${msg}`);
    vscode.window.showErrorMessage(`Unity Index MCP: failed to start on ${host}:${port} — ${msg}`);
    return;
  }

  if (useUnixSocket) {
    try {
      // POSIX: stale socket files block bind.
      if (process.platform !== "win32" && fs.existsSync(socketPath)) {
        try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
      }
      await http.startUnixSocket(socketPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Failed to start MCP socket server (${socketPath}): ${msg}`);
    }
  }

  running = {
    http,
    readiness,
    assetIndex,
    graphCache,
    port,
    socketPath: useUnixSocket ? socketPath : undefined,
  };

  vscode.window.setStatusBarMessage(`Unity Index MCP: http://${host}:${port}`, 5000);
}

async function stopServer(): Promise<void> {
  if (!running) {
    log("Server is not running.");
    return;
  }
  log("Stopping MCP server...");
  await running.http.stop();
  running.readiness.stop();
  running.assetIndex.dispose();
  running.graphCache.dispose();
  if (running.socketPath && process.platform !== "win32") {
    try { fs.unlinkSync(running.socketPath); } catch { /* ignore */ }
  }
  running = undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("Unity Index MCP");
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand("unityIndex.startServer", startServer),
    vscode.commands.registerCommand("unityIndex.stopServer", stopServer),
    vscode.commands.registerCommand("unityIndex.restartServer", async () => {
      await stopServer();
      await startServer();
    }),
    vscode.commands.registerCommand("unityIndex.showLogs", () => {
      output?.show();
    }),
    vscode.commands.registerCommand("unityIndex.openGraph", () => {
      GraphPanel.reveal(context.extensionUri, log, {
        getAssetIndex: () => running?.assetIndex,
        getGraphCache: () => running?.graphCache,
        workspaceState: context.workspaceState,
      });
    }),
    vscode.commands.registerCommand("unityIndex.openGraphFromFile", async () => {
      await openGraphFromFile(context);
    }),
  );

  const config = vscode.workspace.getConfiguration("unityIndex.mcp");
  if (config.get<boolean>("autoStart", true)) {
    await startServer();
  }
}

// Day 11 Task 8 — "Open Graph from File…" command. Prompts for a v1
// ExportDocument JSON, validates the major version, and hands it to the
// graph panel for offline browsing. Refuses incompatible majors with a
// clear error so a future v2 dump can't corrupt the webview state.
async function openGraphFromFile(context: vscode.ExtensionContext): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { "Unity graph export": ["json"] },
    openLabel: "Open graph",
  });
  const uri = picked?.[0];
  if (!uri) return;
  let raw: string;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    raw = Buffer.from(bytes).toString("utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void vscode.window.showErrorMessage(`Could not read ${uri.fsPath}: ${msg}`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void vscode.window.showErrorMessage(`Not a valid JSON file: ${msg}`);
    return;
  }
  let doc;
  try {
    doc = assertCompatibleExport(parsed);
  } catch (e) {
    const isValidation = e instanceof ExportValidationError;
    const msg = isValidation
      ? `Unity graph import failed (${e.kind}): ${e.message}`
      : e instanceof Error
        ? e.message
        : String(e);
    void vscode.window.showErrorMessage(msg);
    return;
  }
  GraphPanel.loadStatic(
    context.extensionUri,
    log,
    {
      getAssetIndex: () => running?.assetIndex,
      getGraphCache: () => running?.graphCache,
      workspaceState: context.workspaceState,
    },
    doc,
  );
}

export async function deactivate(): Promise<void> {
  await stopServer();
}
