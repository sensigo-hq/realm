# Realm

**The agent calls Realm. Every other tool calls the agent.**

Most AI workflow platforms orchestrate LLMs as services: the platform decides when to call the model, what to send, and what to do with the result. Realm inverts this. The agent calls `execute_step` via MCP. Realm's state machine responds with the current step's task and schema. The agent executes. It cannot skip steps, produce malformed output, or proceed past a human gate — not because of instructions it might ignore, but because the state cannot change until valid output is submitted.

If your skill file has grown a list of "Do NOT" rules, each one is a scar from a failure the agent invented. Realm replaces those rules with structure: wrong behaviour becomes impossible rather than prohibited.

You define workflows in YAML. The engine enforces step order, validates every agent output against a JSON schema, captures tamper-evident evidence at each step, and pauses at human gates until a person approves. The result is not just a log of what ran — it is a cryptographically verifiable record that every step ran correctly. For developers building AI workflows for clients, that record is the deliverable.

## Packages

| Package                  | npm                                                                                                                 | Description                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `@sensigo/realm`         | [![npm](https://img.shields.io/npm/v/@sensigo/realm)](https://www.npmjs.com/package/@sensigo/realm)                 | Core engine — state guard, execution loop, evidence capture              |
| `@sensigo/realm-cli`     | [![npm](https://img.shields.io/npm/v/@sensigo/realm-cli)](https://www.npmjs.com/package/@sensigo/realm-cli)         | `realm` CLI — 18 commands for building, operating, and serving workflows |
| `@sensigo/realm-mcp`     | [![npm](https://img.shields.io/npm/v/@sensigo/realm-mcp)](https://www.npmjs.com/package/@sensigo/realm-mcp)         | `realm-mcp` MCP server — 7 tools for AI agent connections                |
| `@sensigo/realm-testing` | [![npm](https://img.shields.io/npm/v/@sensigo/realm-testing)](https://www.npmjs.com/package/@sensigo/realm-testing) | Testing utilities — fixtures, assertions, in-memory store                |

## Installation

**CLI (global)**

```bash
npm install -g @sensigo/realm-cli
```

**MCP server (global, for AI agent connections)**

```bash
npm install -g @sensigo/realm-mcp
```

**Programmatic use**

```bash
npm install @sensigo/realm
```

**Testing utilities**

```bash
npm install --save-dev @sensigo/realm-testing
```

## Quick Start

### 1. Scaffold a workflow

```bash
realm workflow init my-workflow
```

This creates `my-workflow/` with `workflow.yaml`, `schema.json`, `.env.example`, and a `README.md`.

### 2. Edit `my-workflow/workflow.yaml`

```yaml
id: my-workflow
name: 'My Workflow'
version: 1

steps:
  gather_input:
    description: 'Agent collects the required information'
    execution: agent
    depends_on: []
    input_schema:
      type: object
      required: [summary]
      properties:
        summary:
          type: string

  finalize:
    description: 'Human reviews and approves the submitted summary'
    execution: auto
    depends_on: [gather_input]
    trust: human_confirmed
```

### 3. Validate, register, and run

```bash
realm workflow validate ./my-workflow   # check the YAML
realm workflow register ./my-workflow   # register with the local store
realm workflow run ./my-workflow        # run interactively (development mode)
```

`realm workflow run` drives the workflow step by step, prompting you for simulated agent output and pausing at human gates.

## Connect an AI Agent via MCP

Start the MCP server (built into the CLI — no extra install needed):

```bash
realm mcp
```

**Claude Desktop — `claude_desktop_config.json`**

```json
{
  "mcpServers": {
    "realm": {
      "command": "realm",
      "args": ["mcp"]
    }
  }
}
```

**Cursor — `~/.cursor/mcp.json`**

```json
{
  "mcpServers": {
    "realm": {
      "command": "realm",
      "args": ["mcp"]
    }
  }
}
```

**Hosted agent platforms** (OpenClaw, Claude.ai, custom backends) that cannot spawn a local subprocess use `realm serve` instead:

```bash
REALM_SERVE_TOKEN=<secret> realm serve --port 3001
```

This starts an HTTP MCP server protected by Bearer token authentication. Use `--dev` to skip auth during local development.

Once connected the agent has access to 7 tools: `list_workflows`, `get_workflow_protocol`, `start_run`, `execute_step`, `submit_human_response`, `get_run_state`, and `create_workflow`.

The agent calls `list_workflows` to discover registered workflows, then `get_workflow_protocol` for the matched workflow to receive explicit step-by-step instructions. It cannot execute a step out of order or submit output that fails schema validation.

When no registered workflow matches the task, the agent calls `create_workflow` with a `steps` array to register a dynamic workflow and immediately start a run — no YAML file or `realm workflow register` required. The run proceeds identically to a YAML workflow from that point.

**Multiple workflows:** register as many as you need with `realm workflow register`. The agent discovers them all via `list_workflows` and picks the right one by ID. Add a `skill.md` alongside each workflow for workflow-specific agent behaviour.

## CLI Reference

| Command                          | Description                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `realm workflow init <name>`     | Scaffold a new workflow project directory                                       |
| `realm workflow validate <path>` | Validate a workflow YAML without registering it                                 |
| `realm workflow register <path>` | Register a workflow in the local store                                          |
| `realm workflow watch <path>`    | Watch a workflow YAML and re-register on every change                           |
| `realm workflow run <path>`      | Run a workflow interactively (development mode)                                 |
| `realm agent`                    | Run a workflow autonomously with an LLM — no MCP client or IDE required         |
| `realm workflow test <path>`     | Run fixture-based tests against a workflow                                      |
| `realm run list`                 | List all runs; filter by `--workflow <id>` or `--status <phase>`                |
| `realm run resume <run-id>`      | Resume a paused run                                                             |
| `realm run respond <run-id>`     | Submit a response to a human gate                                               |
| `realm run inspect <run-id>`     | Print the full evidence chain for a run                                         |
| `realm run replay <run-id>`      | Re-evaluate preconditions with modified step outputs                            |
| `realm run diff <run-a> <run-b>` | Compare evidence chains of two runs side by side                                |
| `realm run cleanup`              | Mark idle non-terminal runs as abandoned                                        |
| `realm workflow migrate`         | Back-fill provenance fields on local workflow definitions from earlier versions |
| `realm mcp`                      | Start the MCP server over stdio (for local AI agents)                           |
| `realm serve`                    | Start the MCP server over HTTP with Bearer token auth (for hosted platforms)    |

Run `realm <command> --help` for full options on any command.

## Documentation

- [Getting Started](docs/getting-started.md) — end-to-end walkthrough including service adapters, human gates, and step handlers
- [YAML Schema Reference](docs/reference/yaml-schema.md) — all step fields, execution modes, transitions, trust levels, agent profiles
- [Handler Authoring Reference](docs/reference/handlers.md) — `StepHandler` interface, `StepContext` fields, primitives catalogue, built-in handlers, registration
- [MCP Protocol Reference](docs/reference/mcp-protocol.md) — tools, response envelope, next_action, agent_action
- [CLI Reference](docs/reference/cli-commands.md) — all commands with options
- [Built-in Service Adapters](docs/reference/adapters.md) — `FileSystemAdapter`, `GitHubAdapter`, `GenericHttpAdapter` — config, operations, response shapes
- [Testing Reference](docs/reference/testing.md) — `@sensigo/realm-testing` full API: fixture runner, mocks, assertions, GitHub mock server
- [Examples](examples/) — working workflow examples

## Development

**Prerequisites:** Node.js 22+, npm 10+

```bash
npm install          # install all workspace dependencies
npm run build        # compile all packages
npm run test         # run all tests
npm run lint         # lint all packages
```

## License

Apache 2.0
