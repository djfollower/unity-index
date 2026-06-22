# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Unity Index MCP Server — exposes IDE code intelligence for Unity C# projects to AI agents via the Model Context Protocol (MCP). The repo ships **two parallel implementations** of the same MCP surface:

- **JetBrains Rider plugin** (Kotlin, under `src/`) — sources intelligence from Rider's PSI/RD Protocol. Default port `29170`.
- **VS Code extension** (TypeScript, under `vscode-extension/`) — sources intelligence from the C# Dev Kit / Roslyn LSP via VS Code's `executeXProvider` commands. Default port `29270`.

Based on [jetbrains-index-mcp-plugin](https://github.com/hechtcarmel/jetbrains-index-mcp-plugin).

## Critical Design Principles

1. **C# / Unity first.** Both variants exist to serve Unity C# projects. All features, tools, and handlers MUST prioritize C# and Unity support. Other languages can be skipped entirely.

2. **Exploit the host IDE's index, never reimplement it.** The plugin's value is exposing the host IDE's existing code intelligence to AI agents via MCP. In Rider, leverage PSI / RD Protocol / inspections / navigation. In VS Code, route through `vscode.executeXProvider` commands so C# Dev Kit / Roslyn LSP answers the query. NEVER implement custom parsers, analyzers, or tools that re-parse script files when the IDE already knows.

3. **Both variants must stay in lockstep.** Any further update or implementation MUST reflect both the Rider plugin AND the VS Code extension:
   - New MCP tool → add it in both `src/main/kotlin/.../tools/` AND `vscode-extension/src/tools/`, with matching `name`, schema, and response shape so a single MCP client config works against either.
   - Changed tool name, schema, or response field → update both sides; the JSON wire format is the contract.
   - New transport route, JSON-RPC method, or error envelope → mirror in `KtorMcpServer.kt` / `JsonRpcHandler.kt` AND `vscode-extension/src/server/httpServer.ts` / `jsonRpcHandler.ts`.
   - Shared assets (bridge scripts under `tools/`, README, MCP wire docs) → update once, ensure they cover both variants.
   - If a feature genuinely cannot be ported (e.g. a Rider-only API), document the gap in `vscode-extension/README.md` instead of silently diverging.
   - When in doubt, port the Kotlin behavior literally to TypeScript (or vice versa). Same tool names, same parameter names, same JSON field names.

## Build Commands

Both variants ship from the same `build/distributions/` folder and MUST share the same version number:

- **Version source of truth**: `gradle.properties` → `pluginVersion`
- **Mirror it** in `vscode-extension/package.json` → `version`. Bump them together — never let them drift.

### Rider plugin (Kotlin)

```bash
# Set JDK (required — project needs JDK 21)
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export PATH="$JAVA_HOME/bin:$PATH"

./gradlew compileKotlin       # quick syntax check
./gradlew buildPlugin          # → build/distributions/unity-index-rider-<version>.zip
```

The archive base name `unity-index-rider` is set in `build.gradle.kts` via `tasks.buildPlugin { archiveBaseName }`.

### VS Code extension (TypeScript)

```bash
cd vscode-extension
npm install
npm run compile               # tsc → dist/extension.js
npm run package               # → ../build/distributions/unity-index-vscode-<version>.vsix
npm run package:install       # build + install into local VS Code
```

Packaging is driven by `vscode-extension/scripts/package.js`, which reads `package.json#version` and writes the VSIX to the shared `build/distributions/` folder so both artifacts sit side by side.

## Architecture

**MCP Server stack** (all under `com.github.dungphan.unityindex`):
- `server/transport/KtorMcpServer.kt` — Embedded Ktor CIO HTTP server, supports Streamable HTTP (2025-03-26) and Legacy SSE (2024-11-05) transports
- `server/JsonRpcHandler.kt` — Routes JSON-RPC 2.0 requests to tools
- `server/ProjectResolver.kt` — Resolves `project_path` argument to open IntelliJ `Project` instances
- `server/McpServerService.kt` — Application-level service managing server lifecycle, tool registry, watchdog restart

**Tools** (under `tools/`):
- Each tool extends `AbstractMcpTool` which provides PSI synchronization, dumb mode checking, read/write actions, file resolution
- Navigation: `FindUsagesTool`, `FindDefinitionTool`, `FindSymbolTool`, `FindClassTool`, `FindFileTool`, `SearchTextTool`, `ReadFileTool`, `TypeHierarchyTool`, `CallHierarchyTool`, `FindImplementationsTool`, `FindSuperMethodsTool`, `FileStructureTool`
- Intelligence: `GetDiagnosticsTool`, `DiagnosticsAnalysisService`
- Project: `GetIndexStatusTool`, `SyncFilesTool`, `BuildProjectTool`
- Tool registration happens in `ToolRegistry.registerBuiltInTools()`

**Language handlers** (`handlers/`):
- `LanguageHandlerRegistry` — discovers available language support at startup
- `OptimizedSymbolSearch` / `PopupFaithfulSymbolSearch` — headless Go-to-Symbol search
- Language-specific handlers register via reflection; none are bundled yet (Phase 2+)

**Key patterns**:
- Tools use `SchemaBuilder` for JSON Schema input definitions
- Results use `@Serializable` data classes in `tools/models/`
- `PsiUtils` handles position→element resolution, reference following, navigation
- Server listens on `127.0.0.1:29170` by default, configurable in settings

## Plugin Configuration

- `plugin.xml` at `src/main/resources/META-INF/plugin.xml`
- No Rider incompatibility marker (unlike the reference plugin)
- Depends only on `com.intellij.modules.platform`
- Builds against IntelliJ IDEA (not Rider SDK) for easier development

## VS Code Extension Architecture

Mirrors the Kotlin side file-for-file where practical (under `vscode-extension/src/`):

- `extension.ts` — activation, lifecycle, server start/stop on Unity workspaces
- `server/httpServer.ts` — Streamable HTTP + Legacy SSE + Unix socket / named pipe (same routes as `KtorMcpServer.kt`)
- `server/jsonRpcHandler.ts` — JSON-RPC routing (mirrors `JsonRpcHandler.kt`)
- `server/projectResolver.ts` — workspace folder ↔ `project_path` resolution (mirrors `ProjectResolver.kt`)
- `server/readinessGate.ts` — probes C# Dev Kit / Roslyn LSP via `executeWorkspaceSymbolProvider("MonoBehaviour")` to know when LSP is ready
- `tools/abstractTool.ts` — base class, success/error helpers (mirrors `AbstractMcpTool.kt`)
- `tools/{navigation,intelligence,project,unity}/` — one file per MCP tool, names match the Kotlin equivalents
- `utils/lspBridge.ts` — wrappers over `vscode.commands.executeCommand("vscode.executeXProvider", ...)`
- `utils/unityYaml.ts` + `utils/unityAssetIndex.ts` — TS ports of `UnityYamlParser.kt` and `UnityAssetIndex.kt`
- `utils/schema.ts` — JSON Schema builder (mirrors `SchemaBuilder.kt`)

When porting:
- Same tool names (`ide_*`, `unity_*`), same parameter names, same JSON response field names
- LSP-bridging commands replace PSI/RD calls (`executeReferenceProvider` ↔ Rider's `FindUsagesModel`, etc.)
- Pure file/YAML parsing tools (Unity asset tools) port literally — no IDE dependency
- Build output: `vscode-extension/dist/extension.js` + `vscode-extension/unity-index-mcp.vsix`
