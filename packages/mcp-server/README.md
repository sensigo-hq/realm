# @sensigo/realm-mcp

`@sensigo/realm-mcp` — the Realm MCP server. Exposes 10 workflow tools over stdio or HTTP for AI agent connections (VS Code Copilot, Cursor, Claude, and any MCP-compatible agent).

## Installation

```
# Standalone binary (for AI agent MCP config)
npm install -g @sensigo/realm-mcp

# Embedded library (for custom application integration)
npm install @sensigo/realm-mcp
```

## Usage — Standalone MCP server

Add `realm-mcp` to your MCP client configuration (VS Code, Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "realm": {
      "command": "realm-mcp"
    }
  }
}
```

Requires workflows to be registered first via `realm workflow register`.

## Usage — Embedded MCP server

Create and connect a Realm MCP server inside your own application using any MCP-compatible transport.

```ts
import { createRealmMcpServer } from '@sensigo/realm-mcp';
// StdioServerTransport comes from the MCP SDK, not from @sensigo/realm-mcp
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = createRealmMcpServer(); // options?: RealmMcpServerOptions
const transport = new StdioServerTransport();
await server.connect(transport);
```

## API Reference

| Symbol                             | Description                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `createRealmMcpServer(options?)`   | Creates the MCP server with all 10 tools pre-registered. Returns `McpServer`.   |
| `createDefaultRegistry()`          | Returns an `ExtensionRegistry` pre-populated with built-in adapters.            |
| `generateProtocol(workflow)`       | Generates a structured protocol description for a workflow.                     |
| `RealmMcpServerOptions`            | Type — optional config: `registry?`, `secrets?`, `workflowStore?`, `runStore?`. |
| `WorkflowProtocol`, `ProtocolStep` | Types — output shape of `generateProtocol`.                                     |

## MCP tools exposed

- `list_workflows` — list registered workflows
- `get_workflow_protocol` — get step-by-step protocol for a workflow
- `start_run` — start a new workflow run
- `start_run_batch` — start many runs of one workflow in a single call
- `execute_step` — submit agent output for a step and advance the run
- `submit_human_response` — resolve a human gate
- `get_run_state` — check current run state
- `abandon_run` — end a non-terminal run without completing it
- `create_workflow` — dynamically register and start a workflow in one call
- `append_trace` — add trace entries during a step, before submitting it

## Full documentation

Full documentation: https://github.com/sensigo-hq/realm
