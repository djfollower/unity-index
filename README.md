# Unity Index MCP Server

A JetBrains Rider plugin (and matching VS Code extension) that exposes IDE code intelligence for Unity C# projects to AI agents via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io).

Use semantic code navigation (find references, go to definition, type hierarchy, diagnostics) instead of raw text grep — dramatically reducing token usage and improving AI agent accuracy.

> **Two editors, one wire protocol.** Both variants expose the same MCP tools over the same JSON-RPC schema, so a single MCP client config can target either:
>
> - **JetBrains Rider** — see installation below; default port `29170`.
> - **Visual Studio Code** — `vscode-extension/` directory in this repo, backed by C# Dev Kit / Roslyn LSP; default port `29270`. See [`vscode-extension/README.md`](vscode-extension/README.md).

## Features

### Navigation Tools

| Tool | Description |
|------|-------------|
| `ide_find_references` | Find all references to a symbol across the project |
| `ide_find_definition` | Go to where a symbol is defined |
| `ide_find_implementations` | Find all implementations of an interface or abstract class |
| `ide_type_hierarchy` | Get the complete inheritance hierarchy for a class |
| `ide_call_hierarchy` | Build a call hierarchy tree (callers or callees) |
| `ide_find_super_methods` | Find parent methods that a method overrides or implements |
| `ide_find_symbol` | Search for symbols by name (Go to Symbol) |
| `ide_find_class` | Search for classes and interfaces by name (Go to Class) |
| `ide_find_file` | Search for files by name |
| `ide_file_structure` | Get the hierarchical structure of a source file |
| `ide_search_text` | Full-text search across the project |
| `ide_read_file` | Read file contents by path or qualified name |

### Intelligence Tools

| Tool | Description |
|------|-------------|
| `ide_diagnostics` | Get errors, warnings, and available quick fixes |

### Project Tools

| Tool | Description |
|------|-------------|
| `ide_index_status` | Check IDE indexing status |
| `ide_sync_files` | Sync external file changes with the IDE |
| `ide_build_project` | Build the project and return results |

### Batch Dispatcher

| Tool | Description |
|------|-------------|
| `ide_batch` | Run up to 256 tool calls in one MCP request with shared PSI sync and bounded concurrency |

For large sweeps over a Unity project (e.g. resolving 100+ symbols), `ide_batch` is far
faster than issuing per-call requests: PSI synchronization and project resolution run
once for the whole batch, and entries execute concurrently (default 8, max 16). See
[MCP wire format](#mcp-wire-format) below for the request and response shape.

### Unity-Specific Tools

| Tool | Description |
|------|-------------|
| `unity_get_project_context` | Get Unity version, render pipeline, target platforms, and installed packages |
| `unity_get_assembly_map` | Get assembly definition (.asmdef) structure and dependency graph |
| `unity_get_component_usage` | Find where a MonoBehaviour is attached in scenes and prefabs |
| `unity_find_getcomponent_patterns` | Find all GetComponent/AddComponent usage patterns for a type |
| `unity_get_serialized_field_values` | Read serialized field values across prefabs and scenes |
| `unity_get_unity_event_bindings` | Find UnityEvent bindings (Button.onClick, etc.) that call a method |
| `unity_get_api_usage` | Find all uses of a specific Unity API (e.g., Physics.Raycast) |

## Requirements

For the Rider plugin:

- **JetBrains Rider** 2025.1.3 or later
- **JDK 21** (for building from source)

For the VS Code extension (in `vscode-extension/`):

- **VS Code** 1.85 or later
- **C# Dev Kit** (or the standalone C# extension)
- **Node 18+** (only needed to build from source)

## Installation

### From ZIP

1. Download the latest `unity-index-*.zip` from [Releases](https://github.com/dungphan/unity-index/releases)
2. In Rider: **Settings** > **Plugins** > **⚙️** > **Install Plugin from Disk...**
3. Select the ZIP file and restart Rider

### From Source

```bash
# Set JDK 21
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export PATH="$JAVA_HOME/bin:$PATH"

# Build plugin ZIP
./gradlew buildPlugin

# Output: build/distributions/unity-index-*.zip
```

## Configuration

After installation, configure the plugin in **Settings** > **Unity Index MCP Server**:

| Setting | Default | Description |
|---------|---------|-------------|
| Server Host | `127.0.0.1` | Host address to bind the MCP server to |
| Server Port | `29170` | Port number for the MCP server |
| Sync external changes | Off | Refresh VFS before every operation (performance impact) |
| Unix socket | Off | Enable Unix domain socket transport |
| Tool toggles | All on | Enable/disable individual tools |

## Connecting an AI Agent

The plugin starts an MCP server automatically when Rider opens a project. Connect your AI agent using one of the supported transports:

### Streamable HTTP (recommended)

```
POST http://127.0.0.1:29170/unity-index-mcp/streamable-http
```

### Legacy SSE

```
GET  http://127.0.0.1:29170/unity-index-mcp/sse          # Opens SSE stream
POST http://127.0.0.1:29170/unity-index-mcp?sessionId=xxx # Send JSON-RPC
```

### Unix Domain Socket

Enable in settings, then connect to the socket path (default: `/tmp/unity-index-mcp.sock`).

### MCP Client Configuration

**Streamable HTTP (recommended):**

Add to your MCP client config (e.g., `claude_desktop_config.json`, `.cursor/mcp.json`, `.claude/settings.json`):

```json
{
  "mcpServers": {
    "unity-index": {
      "url": "http://127.0.0.1:29170/unity-index-mcp/streamable-http"
    }
  }
}
```

**Unix Domain Socket (via stdio bridge):**

For MCP clients that don't support Unix sockets natively (e.g., Claude Desktop), a Python bridge script is included that translates stdio to the plugin's Unix domain socket.

1. Enable Unix socket in Rider: **Settings** > **Unity Index MCP Server** > **Enable Unix domain socket transport**
2. Note the socket path shown in settings (you can find it in the Rider notification when the server starts)
3. Add to your MCP client config:

```json
{
  "mcpServers": {
    "unity-index": {
      "type": "stdio",
      "command": "python3",
      "args": [
        "/path/to/unity-index/tools/unity-mcp-bridge.py"
      ],
      "env": {
        "UNITY_INDEX_SOCKET": "/tmp/unity-index-mcp.sock"
      }
    }
  }
}
```

Replace `/path/to/unity-index` with the actual path where you cloned this repository, and update `UNITY_INDEX_SOCKET` to match the socket path shown in Rider settings.

> The Unix socket bypasses TCP entirely, so corporate firewalls and localhost restrictions don't apply. The socket path is configurable in settings (default: `/tmp/unity-index-mcp.sock`).

## MCP wire format

Both variants speak JSON-RPC 2.0. Every tool call follows the standard MCP `tools/call` shape:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "ide_find_symbol",
    "arguments": { "name": "PlayerController", "project_path": "/path/to/project" }
  }
}
```

### Transport-level batching (JSON-RPC arrays)

Clients may POST a JSON array of requests; the server returns an array of responses.
Entries run **sequentially**; notifications (no `id`) are stripped from the reply. This
is JSON-RPC 2.0 batching as-spec — useful for grouping a handful of unrelated calls,
not for performance sweeps.

### Tool-level batching: `ide_batch`

For large sweeps where the per-call PSI / VFS sync, project resolution, and HTTP framing
would dominate wall clock, use the `ide_batch` tool. It dispatches up to 256 inner calls
inside one MCP request, runs them concurrently (default 8, max 16), and amortizes shared
setup across the batch.

**Request:**

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "ide_batch",
    "arguments": {
      "project_path": "/path/to/project",
      "calls": [
        { "id": "q1", "tool": "ide_find_symbol", "arguments": { "name": "PlayerController" } },
        { "id": "q2", "tool": "ide_find_class",  "arguments": { "name": "Enemy" } },
        { "id": "q3", "tool": "ide_read_file",   "arguments": { "file": "Assets/Scripts/Foo.cs" } }
      ],
      "stopOnError": false,
      "maxConcurrency": 8,
      "timeoutMs": 120000
    }
  }
}
```

| Parameter        | Required | Default  | Notes |
|------------------|----------|----------|-------|
| `calls`          | yes      | —        | 1..256 entries; each is `{id, tool, arguments}`. `id` must be unique within the batch. `tool` is any registered MCP tool name except `ide_batch` (no nesting). |
| `project_path`   | no       | —        | Inherited into each entry's `arguments` unless the entry sets its own. |
| `stopOnError`    | no       | `false`  | If `true`, abort on the first dispatch error; remaining entries return `status="skipped"`. |
| `maxConcurrency` | no       | `8`      | Clamped to `[1, 16]`. |
| `timeoutMs`      | no       | `120000` | Whole-batch wall clock budget; clamped to `[1000, 300000]`. |

**Response** (wrapped in the standard `ToolCallResult` envelope):

```json
{
  "results": [
    { "id": "q1", "status": "ok",      "result": { "content": [...], "isError": false } },
    { "id": "q2", "status": "error",   "error": "Tool not found: ide_find_class" },
    { "id": "q3", "status": "skipped", "reason": "stopOnError" }
  ],
  "syncMs": 42,
  "totalMs": 1180,
  "concurrency": 8
}
```

- `status="ok"` carries the **exact `ToolCallResult` shape** the underlying tool would have returned over a single call, so clients can reuse parsing. Tool-level errors (`result.isError=true`) remain `status="ok"`.
- `status="error"` is reserved for dispatch failures: unknown tool name, malformed entry, nested `ide_batch`.
- `status="skipped"` carries a `reason` of `"stopOnError"` or `"batchTimeout"`.

The 256-entry limit and 300s outer cap are deliberate starting points sized for typical
Unity-project sweeps; they live in `BatchTool.MAX_ENTRIES` / `BatchTool.MAX_BATCH_TIMEOUT_MS`
on both variants and should be revisited with real timing data before being raised.

## Architecture

```
com.github.dungphan.unityindex
├── server/
│   ├── transport/        # Ktor HTTP server (Streamable HTTP + Legacy SSE + Unix socket)
│   ├── JsonRpcHandler    # JSON-RPC 2.0 routing
│   ├── ProjectResolver   # Maps project_path to open IntelliJ Project instances
│   └── McpServerService  # Application-level server lifecycle and tool registry
├── tools/
│   ├── navigation/       # Code navigation tools (find refs, go to def, etc.)
│   ├── intelligence/     # Diagnostics and analysis
│   ├── project/          # Build, sync, index status
│   ├── unity/            # Unity-specific tools (asset parsing, component usage)
│   └── BatchTool.kt      # ide_batch: amortized multi-call dispatcher
├── handlers/             # Symbol search, scope resolution
└── util/                 # PSI utilities, Rider protocol bridge, Unity YAML parsing
```

The plugin leverages Rider's built-in code intelligence via:
- **Rider RD Protocol** — direct access to Rider's C# backend for definition, references, type hierarchy, call hierarchy, and implementations
- **Platform PSI APIs** — find usages, reference search, structure view, and navigation as fallbacks
- **Unity YAML parsing** — reads `.unity`, `.prefab`, `.asmdef`, and `ProjectSettings` files to surface asset-level relationships invisible to code analysis

## License

See [LICENSE](LICENSE).
