# Getting Started with Realm

This guide walks through building, running, and testing a Realm workflow from scratch.

**Time to complete:** ~10 minutes  
**Prerequisites:** Node.js 22+, npm 10+

---

## 1. Install the CLI

```bash
npm install -g @sensigo/realm-cli
```

Verify the install:

```bash
realm --version
```

---

## 2. Scaffold a Workflow

```bash
realm workflow init extraction-demo
cd extraction-demo
```

This creates:

```
extraction-demo/
  workflow.yaml    # workflow definition
  schema.json      # optional shared params schema
  .env.example     # secrets template
  README.md        # project readme
```

---

## 3. Understand the Workflow Definition

Open `workflow.yaml`. The key fields are:

```yaml
id: extraction-demo # unique identifier used in all CLI commands
name: 'Extraction Demo'
version: 1

steps:
  step_one:
    description: '...'
    execution: agent # the AI agent executes this step
    depends_on: [] # no dependencies — starts immediately
    input_schema: # the engine validates agent output against this schema
      type: object
      additionalProperties: false
      required: [result]
      properties:
        result:
          type: string

  finalize:
    description: '...'
    execution: auto # engine executes this automatically
    depends_on: [step_one]
```

`execution: agent` — the step waits for the AI agent (or `realm workflow run` in dev mode) to call `execute_step`.  
`execution: auto` — the engine runs this step immediately, optionally calling a registered `handler`.  
`trust: human_confirmed` — the engine pauses and waits for `submit_human_response` before advancing.

For a complete reference of all step fields, execution modes, transitions, and agent profiles, see [YAML Schema Reference](reference/yaml-schema.md).

---

## 4. Validate and Register

```bash
realm workflow validate ./                # parse and validate the YAML
realm workflow register ./                # store the workflow definition locally
```

`realm workflow validate` catches schema errors, duplicate step IDs, and invalid `depends_on` references before you run anything.

**Development tip — auto-register on save:** instead of running `realm workflow register` after every edit, use `realm workflow watch`:

```bash
realm workflow watch ./   # registers immediately, then re-registers on every file change
```

Make edits to `workflow.yaml` freely — each save triggers a re-registration. Invalid YAML is logged but does not stop the watcher; fix the file and save again to recover. Press `Ctrl+C` to stop.

---

## 5. Run Interactively

```bash
realm workflow run ./
```

`realm workflow run` is a development driver. For each agent step it prompts you to type the JSON output. For human gates it prompts for approval. This lets you exercise the full workflow without an AI agent.

Example session:

```
Step: step_one — Collect the required information
Enter agent output (JSON): {"result": "the document text"}

Step: finalize — Human reviews and approves
Approve? [y/n]: y

Run completed. Phase: completed
Run ID: abc123
```

---

## 6. Run with `realm agent`

`realm workflow run` (section 5) manually drives each step by prompting you to type JSON — useful for learning the state machine without setting up an LLM. `realm agent` does the same thing end-to-end with a real LLM, in a single terminal command, with no MCP client or IDE required:

```bash
realm agent \
  --workflow ./extraction-demo \
  --params '{"path":"input.txt"}'
```

Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` before running. Use `--provider anthropic` to switch providers.

`realm agent` registers the workflow temporarily, starts a run, and drives every `execution: agent` step. Auto steps run without any LLM call. Schema validation applies exactly as in the interactive run — if the LLM returns invalid output, the engine rejects it, the agent retries, and the run only advances when the schema passes.

If the workflow contains a human gate, `realm agent` pauses and prints the gate message. When no Slack bot integration is configured, it also prints a `realm run respond` command for each choice — run it in a second terminal to submit your response. When a `notifiers.slack_gate` block with `bot_token` + `channel_id` is configured in your deployment manifest ([realm.yaml](reference/deployment-manifest.md)), the terminal commands are suppressed — resolve the gate directly in Slack. `realm agent` detects the resolved gate in either case and continues automatically.

**Slack gate notifications:** instead of responding in the terminal, you can have `realm agent` post the gate message to Slack. Configure `notifiers.slack_gate` in your deployment manifest ([realm.yaml](reference/deployment-manifest.md)): `webhook_url` alone gives one-way notification (terminal command still required); `bot_token` + `channel_id` give full bidirectional resolution — reply in the Slack thread and the gate resolves automatically. A third mode using the Slack Events API gives real-time push delivery for production deployments. For setup instructions, see [Slack Gate Modes](reference/realm-agent-slack.md).

When the run completes, `realm agent` prints the last agent step's output directly to the terminal:

```
Run complete: dc8b8c11-48db-4613-85b8-9c4dff1681f8

Result (step_one):
{
  "result": "the document text"
}
```

To also persist the workflow definition so `realm run inspect` and `realm run list` resolve it by ID, pass `--register`:

```bash
realm agent \
  --workflow ./extraction-demo \
  --params '{"path":"input.txt"}' \
  --register
```

**`realm agent` vs MCP:** use `realm agent` for standalone runs — CI pipelines, quick local testing with a real LLM, scripts that must complete without an IDE. Use MCP (section 12) when an AI agent embedded in an IDE should drive workflows as part of a broader interactive session.

---

## 7. Inspect the Evidence Chain

After a run completes (or fails), inspect the full evidence chain:

```bash
realm run inspect abc123
```

The output shows every step in execution order:

```
Run: abc123
Workflow: my-workflow v1
State: completed  ✓
Created: 2026-01-15T10:30:00.000Z
Updated: 2026-01-15T10:30:42.000Z

Evidence (2 steps):

  1. gather_input              [profile: default] success   4231ms   hash: a1b2c3d4
     Input:  {"topic":"quarterly earnings"}
     Output: {"summary":"Revenue grew 12% YoY...","sources":3}
     Diagnostics: ~900 tokens | no preconditions

  2. write_report              [profile: default] success   6104ms   hash: e5f6a7b8
     Input:  {"summary":"Revenue grew 12% YoY...","sources":3}
     Output: {"report":"# Q4 Earnings Report\n## Summary\nRevenue grew 12% YoY...","word_count":412}
     Diagnostics: ~1600 tokens | preconditions: gather_input.result.summary != "" → true (Revenue gr…)
```

Each evidence entry records:

- **Input / Output** — what the step received and what it returned, truncated to 120 characters.
- **Hash** — first 8 characters of the SHA-256 chain hash. The hash changes if any prior step's
  output changes, making the chain tamper-evident.
- **Diagnostics** — token estimate (context window size) and the precondition trace (each
  precondition expression, pass/fail, and the resolved value).

**Debugging with inspect:**

If a step fails, its `Output` field contains the error or the unexpected value. If a
precondition blocked a step, the `precondition_trace` shows the exact expression and the
value that caused it to fail. See the [CLI reference](./reference/cli-commands.md#realm-run-inspect-run-id)
for the full field guide and diagnostic patterns.

---

## 8. Adding a Service

Services let the engine fetch, create, or update data in external systems.

### Built-in: FileSystemAdapter

`@sensigo/realm` ships `FileSystemAdapter`, which reads a local file and returns
`{ content, path, line_count, size_bytes }`. When using `createRealmMcpServer()` with no
custom registry, it is pre-registered automatically under the name `filesystem` — no
TypeScript required. Declare it only in your workflow YAML. For the full operations and
response reference, see [Built-in Service Adapters](reference/adapters.md).

```yaml
services:
  filesystem:
    adapter: filesystem
    trust: engine_delivered

steps:
  read_file:
    description: Read the input file
    execution: auto
    depends_on: []
    uses_service: filesystem
    operation: read
```

The file path is taken from the run's `params` — declare it in `params_schema` and pass it when
calling `start_run`. The step result is injected directly into the evidence; the agent cannot see
or alter it. See `examples/03-incident-response/` and `examples/02-ticket-classifier/` for working examples.

**When you provide a custom registry** (e.g. to register a handler), auto-registration does not
apply — start from `createDefaultRegistry()` from `@sensigo/realm-mcp` and add your extensions
on top, so built-in adapters remain available:

```typescript
import { createDefaultRegistry } from '@sensigo/realm-mcp';

const registry = createDefaultRegistry();
registry.register('handler', 'my_handler', myHandler);

const server = createRealmMcpServer({ workflowStore, registry });
```

### GitHubAdapter

`@sensigo/realm` also ships `GitHubAdapter`, which speaks to the GitHub REST API (and GitHub
Enterprise Server). It is not pre-registered — declare it under `adapters:` in your deployment manifest with `config: { auth: { token: "${secret:GITHUB_TOKEN}" } }`
in your environment and the CLI registers it automatically. For the full operation list
(`get_pr_diff`, `get_issue`, `post_comment`, `apply_labels`, and more), auth token scope
requirements, GitHub Enterprise setup, and the MCP server registration pattern, see
[Built-in Service Adapters — GitHubAdapter](reference/adapters.md#githubackapter).

### Custom adapters

To fetch from any other source — an API, a database, a cloud service — implement `ServiceAdapter`
and register it the same way. `GenericHttpAdapter` (also in `@sensigo/realm`) covers most REST
APIs without any custom code — see the [adapter reference](reference/adapters.md#generichttpadapter).
For fully custom logic, add the service declaration to `workflow.yaml`:

```yaml
services:
  source:
    adapter: google_docs
    trust: engine_delivered

steps:
  fetch_document:
    description: Fetch the document from Google Docs
    execution: auto
    depends_on: []
    uses_service: source
```

When `trust: engine_delivered` is set, the agent cannot see or alter the service response — the engine injects it directly into the step's evidence.

Implement the adapter in TypeScript and register it with `ExtensionRegistry`:

```typescript
import type { ServiceAdapter, ServiceResponse } from '@sensigo/realm';
import { ExtensionRegistry } from '@sensigo/realm';

const googleDocsAdapter: ServiceAdapter = {
  id: 'google_docs',
  async fetch(_operation, _params, config): Promise<ServiceResponse> {
    const token = config['token'] as string;
    // call the Google Docs API …
    return { status: 200, data: { text: '…' } };
  },
  async create(_op, _p, _c) {
    return { status: 501, data: {} };
  },
  async update(_op, _p, _c) {
    return { status: 501, data: {} };
  },
};

const registry = new ExtensionRegistry();
registry.register('adapter', 'google_docs', googleDocsAdapter);
```

---

## 9. Adding a Human Gate

A human gate pauses a run and requires explicit approval before the engine advances to the next step. Add one to `workflow.yaml`:

```yaml
steps:
  review_findings:
    description: 'Security team reviews the identified findings.'
    execution: auto
    trust: human_confirmed
    depends_on: [analyze_findings]
    gate:
      choices:
        - approve
        - reject
      message: |
        {{ context.resources.analyze_findings.finding_count }} findings identified.
        Severity: {{ context.resources.analyze_findings.highest_severity }}.
        Reply 'approve' to accept or 'reject' to flag for re-review.
      resolution_messages:
        approve: 'Approved — run continuing.'
        reject: 'Rejected — run stopped.'
```

**Choosing your gate choices:** keep them short, unambiguous, and domain-relevant. Common patterns:

- `approve` / `reject` — clear for most approval flows
- `yes` / `no` — minimal and obvious
- `send` / `discard` — for outbound content flows
- `approve` / `reject` / `postpone` — three-way with a deferral path

Each choice routes independently: use `when: "gate_step.choice == 'reject'"` on downstream steps to branch based on the outcome. Choices must be typed **exactly** when resolving the gate — the engine does not interpret synonyms or partial matches.

`gate.message` is optional. When set, it is resolved at gate-open using the step's output for template substitution — including self-reference (`{{ context.resources.review_findings.field }}` reads the gate step's own output). If any `{{ }}` placeholder cannot be resolved, the engine returns an error and the gate does not open. The resolved message is stored permanently in the evidence chain as a verbatim record of what the human saw.

`gate.resolution_messages` is optional. When set, the value for the chosen key is displayed as a confirmation after the gate resolves, instead of the default `✅ Gate resolved: \`choice\` — run continuing.`.

When the engine reaches a step with `trust: human_confirmed`, it pauses the run and returns `status: confirm_required`. The run will not advance until a human responds.

**To resume a paused run from the CLI:**

```bash
realm run respond <run-id>
```

**To resume via the MCP tool:** call `submit_human_response` with the `run_id`, `gate_id`, and `choice` from the `confirm_required` response.

### Gate response fields

When the engine opens a gate, the `confirm_required` response includes a `gate` object:

- `gate.display` — the human-facing content. Resolved from `gate.message` if configured; otherwise falls back to `step.prompt` resolved. Present this to the user verbatim before asking for their choice.
- `gate.agent_hint` — optional agent protocol instruction resolved from `step.instructions`. If present, the agent follows this to determine how to present the gate.
- `gate.response_spec.choices` — the valid choice values (e.g. `["approve", "reject"]`). The human must reply with one of these values exactly. Pass the chosen value as `choice` when calling `submit_human_response`.
- `gate.preview` — the full step output at point of gate opening, for reference and debugging.

**Authoring constraint:** keep `step.prompt` content bounded and human-readable — a concise summary, a count, or a short excerpt. Do not surface unbounded payloads (full document text, large JSON objects) as the gate display. Workflow authors are responsible for ensuring gate content remains manageable.

---

## 10. Adding a Step Handler

A step handler contains business logic for an `execution: auto` step — validation,
transformation, enrichment, or any computation the engine should run automatically.

```yaml
steps:
  extract_fields:
    description: 'Extract structured fields from the input.'
    execution: agent
    depends_on: []

  validate_output:
    description: 'Validate that required fields are present.'
    execution: auto
    handler: check_required_fields
    depends_on: [extract_fields]
    config:
      required_keys: [name, date, summary]

  handle_validation_error:
    description: 'Recovery step — invoked only when validation fails.'
    execution: agent
    depends_on: [validate_output]
    trigger_rule: one_failed
```

The `handler:` value is the name string. The `config:` block is a freeform key-value object
delivered to the handler as `context.config`. Add any static configuration your handler needs
here. Recovery on handler failure is declared on a downstream step using `trigger_rule: one_failed`
or `all_failed` — there is no inline `transitions:` block.

### Writing a handler

Import and implement the `StepHandler` interface from `@sensigo/realm`:

```typescript
import type {
  StepHandler,
  StepHandlerInputs,
  StepContext,
  StepHandlerResult,
} from '@sensigo/realm';

const checkRequiredFields: StepHandler = {
  id: 'check_required_fields',

  async execute(inputs: StepHandlerInputs, context: StepContext): Promise<StepHandlerResult> {
    const keys = (context.config['required_keys'] as string[] | undefined) ?? [];
    const fields = inputs.params as Record<string, unknown>;
    const missing = keys.filter((k) => !(k in fields) || fields[k] === null || fields[k] === '');
    if (missing.length > 0) {
      throw new Error(`Missing required fields: ${missing.join(', ')}`);
    }
    return { data: { validated: true, field_count: keys.length } };
  },
};
```

**Key rules:**

- Throw a plain `Error` — the engine wraps it as `ENGINE_HANDLER_FAILED`. Do not import engine internals.
- Return `{ data: { ... } }` for business-logic outcomes (e.g. "no matches found"). Only throw for genuine errors the workflow cannot proceed from.
- Read `context.config` for step-level configuration, `context.resources['step_name']['field']` for prior step outputs, and `inputs.params` for the agent's submitted input from the previous step.
- If your handler does async I/O, check `signal?.aborted` between operations and throw if true.

### Accessing prior step outputs

```typescript
import { resolveResource } from '@sensigo/realm';

// Reads context.resources['fetch_document']['text'], returns undefined if missing
const text = resolveResource(context.resources, 'fetch_document', 'text');
if (typeof text !== 'string') {
  throw new Error('source text missing');
}
```

### Registering a handler

```typescript
import { ExtensionRegistry } from '@sensigo/realm';
import { createRealmMcpServer } from '@sensigo/realm-mcp';

const registry = new ExtensionRegistry();
registry.register('handler', 'check_required_fields', checkRequiredFields);

const server = createRealmMcpServer({ registry });
```

### Available primitives

`@sensigo/realm` exports five utility functions you can compose inside handlers:

| Function                                                   | Purpose                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `resolveResource(resources, stepId, field)`                | Read a field from a prior step's output. Returns `undefined` on missing.        |
| `walkField(data, fieldName)`                               | Recursively collect all objects containing `fieldName` from a nested structure. |
| `partitionBySubstring(candidates, quoteField, sourceText)` | Split candidates into `accepted`/`rejected` by verbatim substring presence.     |
| `countResults(accepted, rejected)`                         | Compute `{ accepted_count, rejected_count, candidates_found }`.                 |
| `compareStrings(a, b, mode)`                               | Compare strings with `"exact"`, `"prefix"`, or `"regex"` mode.                  |

### Built-in handlers

Two handlers are available without registration:

- **`validate_verbatim_quotes`** — verifies AI-extracted quotes appear verbatim in a source document. Detects hallucinations.
- **`validate_field_match`** — reads a field from a prior step and compares it to a pattern. Guards that a fetched resource belongs to the expected entity.

For full interface documentation, context field reference, handler composition patterns, built-in handler config/output tables, and testing utilities, see the [Handler Authoring Reference](reference/handlers.md).

````

---

## 11. Adding Agent Profiles

An agent profile is a Markdown file that defines a persona for an `execution: agent` step. The profile content is delivered to the AI agent verbatim as `agent_profile_instructions` when the step is reached, before it submits any output.

### Create a profile file

Add a `profiles/` directory next to your `workflow.yaml`:

```
extraction-demo/
  workflow.yaml
  profiles/
    extractor.md
```

Write the persona in plain Markdown — no special syntax required:

```markdown
You are a precise document extraction specialist.

Your output must be structured exactly as defined in the step schema.
Do not paraphrase. Do not add context. Quote verbatim or omit entirely.
```

### Reference the profile in a step

```yaml
steps:
  step_one:
    description: Extract key facts from the document
    execution: agent
    depends_on: []
    agent_profile: extractor   # loads profiles/extractor.md
```

The `profiles_dir` top-level field defaults to `profiles/` relative to the workflow YAML. Set it explicitly if your profiles live elsewhere:

```yaml
profiles_dir: ./shared/personas  # relative to workflow.yaml
```

### Register to apply changes

Profile content is read from disk at **registration time** and baked into the stored workflow definition. The AI agent receives the content over MCP at runtime — no file system access is needed on the server.

```bash
realm workflow register ./extraction-demo
# ✓ Registered: extraction-demo v2 (2 steps)
```

If any referenced profile file is missing, registration fails immediately with the expected path in the error message.

> **Re-registration required for profile updates.** If you edit a profile file after registering, run `realm workflow register` again. The server continues serving the previously baked content until you do.

Multiple steps can share the same profile name — Realm reads the file once and records a single hash.

For the complete field reference, see [Agent profiles](reference/yaml-schema.md#agent-profiles) in the YAML Schema Reference.

---

## 12. Connect an AI Agent via MCP

The MCP server is built into the `realm` CLI — no extra install needed if you already have
`@sensigo/realm-cli` installed globally. Start it with:

```bash
realm mcp
```

Configure your AI client. **Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

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

**Cursor** (`~/.cursor/mcp.json`):

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

For hosted platforms that cannot spawn a local subprocess, use `realm serve` instead. See the
[CLI Reference](reference/cli-commands.md#realm-serve) for details.

The agent has access to 10 MCP tools:

| Tool                    | Description                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| `list_workflows`        | List all registered workflows                                      |
| `get_workflow_protocol` | Get step-by-step instructions for a workflow                       |
| `start_run`             | Start a new run                                                    |
| `start_run_batch`       | Start many runs of one workflow in a single call                   |
| `execute_step`          | Submit output for the current agent step                           |
| `submit_human_response` | Approve or reject a human gate                                     |
| `get_run_state`         | Inspect the current state of a run                                 |
| `abandon_run`           | End a non-terminal run without completing it                       |
| `create_workflow`       | Register a dynamic workflow at runtime and immediately start a run |
| `append_trace`          | Add trace entries during a step, before submitting it              |

The agent should call `list_workflows` first to discover what is registered, then
`get_workflow_protocol` for the matched workflow before calling `start_run`. The protocol is
embedded in each workflow definition and provides exact instructions for what to do at each step.

### Mode 2: self-directed execution with `create_workflow`

When no pre-registered workflow matches the task, an agent can define its own multi-step plan at runtime:

```
create_workflow
  steps:
    - id: research_problem
      description: "Audit all JSDoc comments in the repository and list files with missing or inaccurate docs."
    - id: generate_fixes
      description: "For each file identified in the previous step, generate corrected JSDoc."
      input_schema:
        type: object
        additionalProperties: false
        properties:
          audit_summary: { type: string }
        required: [audit_summary]
  metadata:
    name: jsdoc-audit
    task_description: "Audit and fix JSDoc across the codebase."
```

`create_workflow` registers the workflow and starts a run in one call — no YAML file, no `realm workflow register`. The response includes `data.workflow_id` and `next_actions` pointing at the first eligible step. The agent then uses `execute_step` exactly as it would for a YAML workflow.

Runs created by `create_workflow` carry the same evidence chain and `next_actions` guidance as YAML-registered runs. See [`.github/instructions/realm-create-workflow.instructions.md`](../.github/instructions/realm-create-workflow.instructions.md) for the full protocol.

### Using multiple workflows

Realm supports any number of registered workflows in one store. To add more workflows:

```bash
realm workflow register ./my-other-workflow
```

When the agent calls `list_workflows`, it receives the full list of registered IDs and names. It
matches the user's request to the right workflow ID, calls `get_workflow_protocol` to retrieve
that workflow's step-by-step briefing, then proceeds with `start_run`.

For VS Code, place a generic `.github/instructions/realm.instructions.md` in your repository
(see [examples/03-incident-response/](../examples/03-incident-response/)) — it teaches any connected agent the
full discovery-and-execute loop without being tied to a specific workflow.

For workflow-specific agent behaviour (custom trigger phrases, UX instructions, step-level
schemas), add a `skill.md` file alongside the workflow. The generic instructions and per-workflow
skill files compose cleanly: an agent trained on both knows both the Realm protocol and the
workflow-specific details.

For the full protocol — `next_actions`, `chained_auto_steps`, `context_hint`, and error recovery — see [MCP Protocol Reference](reference/mcp-protocol.md).

---

## 13. Testing Workflows

Write a fixture file in `extraction-demo/fixtures/happy-path.yaml`:

```yaml
workflow: extraction-demo
description: 'Complete happy-path run'
params: {}
steps:
  step_one:
    output:
      result: 'the document text'
  finalize:
    gate_response:
      approved: true
expected_final_state: completed
```

Run the tests:

```bash
realm workflow test ./ --fixtures ./fixtures/
```

For programmatic tests, use `@sensigo/realm-testing`. The `runFixtureTests` runner drives a
workflow to completion for every fixture file in a directory and returns one result per file:

```typescript
import { describe, it, expect } from 'vitest';
import { runFixtureTests } from '@sensigo/realm-testing';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('extraction-demo fixtures', async () => {
  const results = await runFixtureTests({
    workflowPath: path.join(__dirname, '../extraction-demo'),
    fixturesPath: path.join(__dirname, '../extraction-demo/fixtures'),
  });

  for (const result of results) {
    it(result.name, () => {
      expect(result.passed, result.error).toBe(true);
    });
  }
});
```

For the full testing API — `InMemoryStore`, `createAgentDispatcher`, `createGateResponder`,
`MockServiceRecorder`, all assertion helpers, `startGitHubMockServer`, and the programmatic
step-by-step walkthrough — see the [Testing Reference](reference/testing.md).

---

---

## Next Steps

- Browse the [`examples/03-incident-response/`](../examples/03-incident-response/workflow.yaml) workflow for a realistic 4-step pattern with a filesystem adapter, two agent steps with personas, and a human gate.
- Read the [YAML Schema Reference](reference/yaml-schema.md) for all step fields, execution modes, and DAG dependencies.
- Read the [MCP Protocol Reference](reference/mcp-protocol.md) for full tool and response envelope documentation.
- Read the [Testing Reference](reference/testing.md) for the full `@sensigo/realm-testing` API.
- Read the [`@sensigo/realm` source](../packages/core/src/index.ts) for the full public API.
````
