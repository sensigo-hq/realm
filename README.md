# Realm

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/sensigo-hq/realm/badge)](https://scorecard.dev/viewer/?uri=github.com/sensigo-hq/realm)

Website and documentation: [realmengine.dev](https://realmengine.dev)

**The agent calls Realm. Every other tool calls the agent.**

Most AI workflow platforms orchestrate LLMs as services: the platform decides when to call the model, what to send, and what to do with the result. Realm inverts this. The agent calls `execute_step` via MCP. Realm's state machine responds with the current step's task and schema. The agent executes. It cannot skip steps, hand in an answer that breaks the step's schema, or move past a human gate before the gate is answered — not because of instructions it might ignore, but because the state cannot change until valid output is submitted.

If your skill file has grown a list of "Do NOT" rules, each one is a scar from a failure the agent invented. Realm replaces those rules with structure: wrong behaviour becomes impossible rather than prohibited.

You define workflows in YAML. The engine enforces step order, checks each agent answer against the JSON schema its step declares, records each step's output with a SHA-256 hash, and pauses the run at human gates until they are answered. The result is not just a log of what ran — it is a step-by-step record of what Realm accepted, when, and which choice was made at each gate, that you can inspect, export and compare across runs. For developers building AI workflows for clients, that record is the deliverable. The record is not signed: see [what it proves, and what it does not](docs/concepts/evidence.md#what-the-record-proves-and-what-it-does-not).

## Packages

| Package                  | npm                                                                                                                 | Description                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `@sensigo/realm`         | [![npm](https://img.shields.io/npm/v/@sensigo/realm)](https://www.npmjs.com/package/@sensigo/realm)                 | Core engine — state guard, execution loop, evidence capture |
| `@sensigo/realm-cli`     | [![npm](https://img.shields.io/npm/v/@sensigo/realm-cli)](https://www.npmjs.com/package/@sensigo/realm-cli)         | `realm` CLI for building, operating, and serving workflows  |
| `@sensigo/realm-mcp`     | [![npm](https://img.shields.io/npm/v/@sensigo/realm-mcp)](https://www.npmjs.com/package/@sensigo/realm-mcp)         | `realm-mcp` MCP server — 11 tools for AI agent connections  |
| `@sensigo/realm-testing` | [![npm](https://img.shields.io/npm/v/@sensigo/realm-testing)](https://www.npmjs.com/package/@sensigo/realm-testing) | Testing utilities — fixtures, assertions, in-memory store   |

## Installation

**CLI (global)**

```bash
npm install -g @sensigo/realm-cli
```

**MCP server (standalone bin)**

```bash
npm install -g @sensigo/realm-mcp
```

The agent config below uses `realm mcp` from the CLI, which needs no second install. Reach for
`@sensigo/realm-mcp` when you are embedding the server programmatically, or want the standalone
`realm-mcp` bin — it runs the same server and the same eleven tools, but resolves neither
workflow-declared project extensions nor the `realm.yaml` deployment manifest.

**Programmatic use**

```bash
npm install @sensigo/realm
```

If your project installs `@sensigo/realm` for its own handlers or adapters, install
`@sensigo/realm-cli` at the same version in the project too and run it as `npx realm`, so the
command and your code share one copy of realm. A global `realm` of a different version warns
where it loads your project's code, and its `--strict` checks fail.

**Testing utilities**

```bash
npm install --save-dev @sensigo/realm-testing
```

## Quick Start

### 1. Scaffold a workflow

```bash
realm workflow init my-workflow
```

This creates `my-workflow/` with six files: `workflow.yaml`, `schema.json`, `realm.yaml`, `registry.sample.js`, `.env.example` and a `README.md`.

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

Once connected the agent has access to 11 tools: `list_workflows`, `get_workflow_protocol`, `start_run`, `start_run_batch`, `execute_step`, `advance_run`, `submit_human_response`, `get_run_state`, `abandon_run`, `create_workflow`, and `append_trace` (`advance_run` was added after version 0.46.0).

The agent calls `list_workflows` to discover registered workflows, then `get_workflow_protocol` for the matched workflow to receive explicit step-by-step instructions. It cannot execute a step out of order or submit output that fails schema validation.

When no registered workflow matches the task, the agent calls `create_workflow` with a `steps` array to register a dynamic workflow and immediately start a run — no YAML file or `realm workflow register` required. The run proceeds identically to a YAML workflow from that point.

**Multiple workflows:** register as many as you need with `realm workflow register`. The agent discovers them all via `list_workflows` and picks the right one by ID.

## Project extensions

Workflows can declare their own custom adapters and step handlers — no wrapper servers, no per-command wiring. (A workflow can also declare processors; realm registers them, but no step runs them yet: issue #642.)

```yaml
# workflow.yaml
extensions: ./registry.js # relative module path(s); the default export declares { adapters, handlers, processors }
```

The `realm` commands that check or run a workflow (`workflow validate`, `register`, `watch`, `test`, `workflow run`, `agent`, `listen`, `mcp`, `serve`, `run respond`, `run drain`) load the declared code the same way, with fail-fast loading and an enforced trust boundary; the commands that only read runs (`run list`, `inspect`, `attempts`, `diff`, `replay`, `export`) never load it. See [when each command loads the code](docs/reference/project-extensions.md#when-each-command-loads-the-code).

## CLI Reference

| Command                                   | Description                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `realm workflow init <name>`              | Scaffold a new workflow project directory                                               |
| `realm workflow list`                     | List registered workflow definitions                                                    |
| `realm workflow validate [path]`          | Validate a workflow YAML without registering it                                         |
| `realm workflow register <path>`          | Register a workflow in the local store                                                  |
| `realm workflow watch <path>`             | Watch a workflow YAML and re-register on every change                                   |
| `realm workflow run <path>`               | Run a workflow interactively (development mode)                                         |
| `realm agent`                             | Run a workflow autonomously with an LLM — no MCP client or IDE required                 |
| `realm workflow test <path>`              | Run fixture-based tests against a workflow                                              |
| `realm run list`                          | List all runs; filter by `--workflow <id>` or `--status <phase>`                        |
| `realm run resume <run-id> --from <step>` | Let a failed step run again, so the run can go on                                       |
| `realm run respond <run-id>`              | Submit a response to a human gate                                                       |
| `realm run inspect <run-id>`              | Print the full evidence chain for a run                                                 |
| `realm run replay <run-id>`               | Re-evaluate preconditions with modified step outputs                                    |
| `realm run diff <run-a> <run-b>`          | Compare evidence chains of two runs side by side                                        |
| `realm run cleanup`                       | Mark idle non-terminal runs as abandoned                                                |
| `realm workflow migrate`                  | Back-fill provenance fields on local workflow definitions from earlier versions         |
| `realm mcp`                               | Start the MCP server over stdio (for local AI agents)                                   |
| `realm serve`                             | Start the MCP server over HTTP with Bearer token auth (for hosted platforms)            |
| `realm listen`                            | Start a webhook server that routes inbound webhooks to workflows (per `trigger:` block) |

Run `realm <command> --help` for full options on any command.

> The GitHub-only `realm webhook` command was removed in favour of `realm listen` (a workflow `trigger:` block with `auth.mode: github` replaces it). Running `realm webhook` now prints a migration message and exits non-zero.

## Documentation

Start at the [documentation index](docs/README.md), or read the same pages at [realmengine.dev/docs](https://realmengine.dev/docs/). The main entry points:

- [What is Realm, and when to use it?](docs/start/what-is-realm.md) and [Install and first run](docs/start/install-and-first-run.md)
- [Concepts](docs/concepts/workflows-steps-and-runs.md) — workflows, steps, gates, evidence, and who drives a run
- [Guides](docs/guides/first-workflow.md) — one task each, from a first workflow to deploying a project
- [Workflow file reference](docs/reference/workflow/top-level-fields.md) — every field of `workflow.yaml`
- [Command-line reference](docs/reference/cli/realm-workflow.md) — every `realm` command
- [MCP reference](docs/reference/mcp/tools.md) — the 11 tools and their replies
- [Adapters](docs/reference/adapters.md), [Handlers](docs/reference/handlers.md), [Deployment manifest](docs/reference/deployment-manifest.md) and [Project extensions](docs/reference/project-extensions.md)
- [Testing package](docs/reference/testing-package.md) and [Core library](docs/reference/core-library.md)
- [Error codes](docs/reference/error-codes.md), [Run record and export bundle format](docs/reference/run-record-and-export.md), [Environment variables and files on disk](docs/reference/environment-and-files.md), [Glossary](docs/reference/glossary.md)
- [Examples](examples/) — working workflow examples

## Development

**Prerequisites:** Node.js 22+, npm 10+

**Requirements for contributors:** the dev toolchain (specifically eslint 10, which declares
`engines: ^20.19 || ^22.13 || >=24`) effectively requires **Node ≥22.13** to run `npm run lint`
locally — an older Node 22 patch will fail there. CI runs Node 24, and that's the recommended local
version too; see [`.nvmrc`](.nvmrc) (`nvm use` / `fnm use` / `volta run` will pick it up
automatically). This is a _development-only_ requirement — it does not change the _published_
runtime floor, which stays `>=22.0.0` for every consumer of `@sensigo/*`.

```bash
npm install          # install all workspace dependencies
npm run build        # compile all packages
npm run test         # run all tests
npm run lint         # lint all packages
```

## Security

See [`SECURITY.md`](SECURITY.md) for how to report a vulnerability (GitHub private vulnerability
reporting — do not open a public issue or PR) and for how dependency advisories are triaged.

Every `@sensigo/*` package is published from CI via npm **trusted publishing**, with **SLSA build
provenance** attached to every release. Verify the provenance of an installed package with:

```bash
npm audit signatures
```

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/sensigo-hq/realm/badge)](https://scorecard.dev/viewer/?uri=github.com/sensigo-hq/realm)

## License

Apache 2.0

## Trademarks

Realm and the Realm logo are trademarks of Sensigo Software. The Apache-2.0 license covers the source
code in this repository; it does not grant permission to use the Realm name or logo (see section 6 of
the license).

You may use them to refer to Realm, to say that your project works with Realm, or in an article or
talk. Please do not use them in a way that suggests your product is made or endorsed by Sensigo
Software, and do not use them as the name or logo of a fork or derivative product. If you are not sure
whether a use is allowed, open an issue.

The logo files and the rules for using them are in [`brand-kit/`](brand-kit/).
