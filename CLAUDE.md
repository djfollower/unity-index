# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Unity Index MCP Server — a JetBrains Rider plugin that exposes IDE code intelligence for Unity C# projects to AI agents via the Model Context Protocol (MCP). Based on [jetbrains-index-mcp-plugin](https://github.com/hechtcarmel/jetbrains-index-mcp-plugin).

## Build Commands

```bash
# Set JDK (required — project needs JDK 21)
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export PATH="$JAVA_HOME/bin:$PATH"

# Compile
./gradlew compileKotlin

# Build plugin ZIP
./gradlew buildPlugin

# Output: build/distributions/unity-index-*.zip
```

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
