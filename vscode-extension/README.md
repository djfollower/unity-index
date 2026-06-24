# Unity Index MCP — VS Code Extension

A VS Code extension that hosts the same MCP server as the Rider plugin variant
of [Unity Index](https://github.com/dungphan/unity-index), exposing C# /
Roslyn code intelligence to AI agents over the Model Context Protocol.

The extension activates on workspaces that contain
`ProjectSettings/ProjectVersion.txt` (Unity projects) and routes navigation
queries through whichever C# language server VS Code already has running —
typically [C# Dev Kit](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csdevkit)
or the standalone C# extension.

## Tools

The extension provides full parity with the Rider plugin (24 tools):

**Navigation** (powered by VS Code's LSP-bridging commands)

| Tool                       | VS Code provider                  |
|----------------------------|-----------------------------------|
| `ide_find_references`      | `executeReferenceProvider`        |
| `ide_find_definition`      | `executeDefinitionProvider`       |
| `ide_find_implementations` | `executeImplementationProvider`   |
| `ide_type_hierarchy`       | `prepareTypeHierarchy` + sub/super|
| `ide_call_hierarchy`       | `prepareCallHierarchy` + in/out   |
| `ide_find_super_methods`   | type hierarchy + document symbols |
| `ide_find_symbol`          | `executeWorkspaceSymbolProvider`  |
| `ide_find_class`           | workspace symbol filtered to types|
| `ide_find_file`            | `vscode.workspace.findFiles`      |
| `ide_file_structure`       | `executeDocumentSymbolProvider`   |
| `ide_search_text`          | line-by-line scan over workspace  |
| `ide_read_file`            | `vscode.workspace.fs`             |

**Intelligence**: `ide_diagnostics` (drains LSP `publishDiagnostics`).

**Project**: `ide_index_status`, `ide_sync_files`, `ide_build_project`
(`dotnet build`).

**Unity** (file/YAML parsing — same logic as the Rider plugin):
`unity_get_project_context`, `unity_get_assembly_map`,
`unity_get_component_usage`, `unity_get_unity_event_bindings`,
`unity_get_serialized_field_values`, `unity_find_getcomponent_patterns`,
`unity_get_api_usage`.

**Batch dispatcher**: `ide_batch` runs up to 256 tool calls in a single MCP
request, with one shared LSP readiness probe and bounded concurrency
(default 8, max 16). Same name, schema, and response envelope as the Rider
plugin — see the main repo README for the full wire format.

## Transport

Identical to the Rider plugin:

- **Streamable HTTP** (2025-03-26): `POST /unity-index-mcp/streamable-http`
- **Legacy SSE** (2024-11-05): `GET /unity-index-mcp/sse` + `POST /unity-index-mcp?sessionId=…`
- **Stateless POST**: `POST /unity-index-mcp`

Default port is **29270** so it does not collide with the Rider plugin
(29170). Both can run at the same time.

A Unix domain socket (or named pipe on Windows) is also opened at
`/tmp/unity-index-mcp-vscode.sock` (or `\\.\pipe\unity-index-mcp-vscode`),
for use with the stdio bridge.

## Settings

| Setting                                  | Default                                 | Notes                                  |
|------------------------------------------|-----------------------------------------|----------------------------------------|
| `unityIndex.mcp.port`                    | `29270`                                 | HTTP port.                             |
| `unityIndex.mcp.host`                    | `127.0.0.1`                             | Bind address.                          |
| `unityIndex.mcp.autoStart`               | `true`                                  | Start on activation.                   |
| `unityIndex.mcp.unixSocketEnabled`       | `true`                                  | Also listen on UDS / named pipe.       |
| `unityIndex.mcp.unixSocketPath`          | OS default                              | Override socket path.                  |
| `unityIndex.mcp.readinessTimeoutMs`      | `120000`                                | Max wait for C# Dev Kit ready.         |

## Commands

- **Unity Index: Start MCP Server**
- **Unity Index: Stop MCP Server**
- **Unity Index: Restart MCP Server**
- **Unity Index: Show Logs**

## Connecting an MCP client

For stdio MCP clients (Claude Desktop, Unity AI Assistant), point at the
existing bridge scripts in the repo's `tools/` directory:

```jsonc
{
  "mcpServers": {
    "unity-index": {
      "command": "python3",
      "args": ["/path/to/unity-index/tools/unity-mcp-bridge-vscode.py"]
    }
  }
}
```

Or use the HTTP-based bridge that works for both Rider and VS Code:

```jsonc
{
  "mcpServers": {
    "unity-index": {
      "command": "python3",
      "args": [
        "/path/to/unity-index/tools/unity-mcp-bridge-http.py",
        "--port", "29270"
      ]
    }
  }
}
```

For clients that speak Streamable HTTP directly, point them at
`http://127.0.0.1:29270/unity-index-mcp/streamable-http`.

## Building

```bash
cd vscode-extension
npm install
npm run compile           # tsc → dist/extension.js
```

Run the extension under the Extension Development Host with **F5**
(after opening `vscode-extension/` in VS Code).

### Packaging to a `.vsix`

```bash
npm run package           # → ../build/distributions/unity-index-vscode-<version>.vsix
```

The VSIX is written to the repo-shared `build/distributions/` folder so it
sits next to the Rider plugin's `unity-index-rider-<version>.zip` with
matching naming. Both artifacts use the same version number.

`package:install` builds and installs into your local VS Code in one step:

```bash
npm run package:install
```

Or install a pre-built VSIX manually:

```bash
code --install-extension build/distributions/unity-index-vscode-0.3.2.vsix
# or, in VS Code: command palette → "Extensions: Install from VSIX..."
```

After install, reload VS Code; the MCP server starts automatically when a
Unity workspace is open (`unityIndex.mcp.autoStart` setting controls this).

## Readiness

Most navigation tools require the C# Dev Kit / Roslyn LSP to finish
loading the solution. The extension probes a workspace-symbol query
against `MonoBehaviour` to detect readiness, and tools wait up to
`readinessTimeoutMs` before failing. Call `ide_index_status` to check
the current state without blocking.
