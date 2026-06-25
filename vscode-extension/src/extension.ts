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

// Batch dispatcher
import { BatchTool } from "./tools/batchTool";

interface RunningServer {
  http: HttpServer;
  readiness: ReadinessGate;
  assetIndex: UnityAssetIndexManager;
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
  const assetIndex = new UnityAssetIndexManager(log);

  const registry = buildRegistry();
  const toolCtx: ToolContext = { readiness, readinessTimeoutMs, log, assetIndex };
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
  );

  const config = vscode.workspace.getConfiguration("unityIndex.mcp");
  if (config.get<boolean>("autoStart", true)) {
    await startServer();
  }
}

export async function deactivate(): Promise<void> {
  await stopServer();
}
