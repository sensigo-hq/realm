---
applyTo: '**'
---

# Realm: Using create_workflow

This file teaches you how to define and track autonomous multi-step plans through
Realm's execution engine using the `create_workflow` MCP tool.

If you have read `realm.instructions.md`, you already know the step loop: `execute_step`
advances a run, each response has `next_actions`, and `agent_action` tells you how to recover
from errors. This file covers the `create_workflow` entry point, which replaces `start_run`
when no registered workflow matches your task.

If you have not read `realm.instructions.md`, the essential context is: Realm is a workflow
execution engine. Runs proceed step-by-step. Each step response carries `next_actions`, which
gives you the exact tool call for the next step. Read `realm.instructions.md` alongside this
file for the full step-loop protocol.

## When to Use create_workflow

Use `create_workflow` when:

- The user asks you to perform an autonomous multi-step task.
- `list_workflows` returns no registered workflow that matches the task.
- You need structured step-by-step tracking and want intermediate outputs recorded.

Do **not** use `create_workflow` when a registered workflow already exists — use `start_run`
instead.

## How to Call create_workflow

`create_workflow` registers the workflow and starts a run in a single call. Do **not** call
`start_run` afterward — the run is already live when `create_workflow` returns.

Minimal call:

```json
{
  "steps": [
    {
      "id": "research_company",
      "description": "Find the company's recent news, product offerings, and known engineering challenges."
    },
    {
      "id": "draft_proposal",
      "description": "Write a one-page proposal addressing the challenges found in the research step.",
      "input_schema": {
        "type": "object",
        "properties": {
          "company_summary": { "type": "string" }
        },
        "required": ["company_summary"]
      }
    }
  ],
  "metadata": {
    "name": "acme-proposal",
    "task_description": "Research Acme Corp and draft a proposal for them."
  }
}
```

**Parameters:**

| Field                       | Required | Description                                                |
| --------------------------- | -------- | ---------------------------------------------------------- |
| `steps`                     | Yes      | Array of step objects. At least one step required.         |
| `metadata.name`             | No       | Short slug used to derive the workflow ID. Use kebab-case. |
| `metadata.task_description` | No       | Human-readable description of the overall task.            |

Each step:

| Field             | Required | Description                                                                                                     |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `id`              | Yes      | Unique identifier. Snake_case verb-noun. No spaces.                                                             |
| `description`     | Yes      | What a correct output looks like (acceptance criterion).                                                        |
| `input_schema`    | No       | JSON Schema for the fields this step's output must include.                                                     |
| `depends_on`      | No       | Array of step IDs this step depends on. Controls execution ordering.                                            |
| `trigger_rule`    | No       | When to evaluate dependency satisfaction. Default: `all_success`. See `realm.instructions.md` for all variants. |
| `timeout_seconds` | No       | Positive integer. If omitted, no timeout is enforced.                                                           |

## Step Design Guidelines

### 1. One concrete deliverable per step

Each step should produce exactly one output that a downstream step or the user can act on
directly. If you would describe a step as "do X and then Y", split it into two steps.

### 2. `id` is verb-noun snake_case

Name steps as actions: `research_company`, `draft_proposal`, `review_output`. Not `step_1`,
`task_a`, or the bare noun `research`. IDs are recorded permanently once the run starts.

### 3. `description` is the acceptance criterion, not the method

Write what a correct output looks like. "Find the company's recent news, product offerings, and
known engineering challenges" is an acceptance criterion. "Use the web search tool to look up the
company" is a method — avoid it.

### 4. `input_schema` captures only downstream dependencies

Define fields only for data that later steps or the user will consume. Do not schema every
intermediate thought. One or two fields is normal. More than five suggests the step is doing
too much.

### 5. `depends_on` controls execution ordering

Setting `depends_on` declares which earlier steps must complete before this step becomes
eligible. The engine evaluates `trigger_rule` against the listed dependencies at eligibility
check time — the default rule `all_success` requires all deps to be in `completed_steps`.

Omit `depends_on` when a step can start immediately at run creation (first tier of the DAG).
For simple sequential workflows, each step lists the previous step as its single dependency.

The referenced IDs must refer to steps that appear **earlier** in the `steps` array (no
forward references). Violating this causes `agent_action: 'provide_input'` at `create_workflow`
call time — fix the array order or remove the invalid reference.

## Efficiency Guidelines

These rules prevent the most common performance problems when orchestrating Realm workflows.
Every minute of wall time in a Realm run is agent time — the engine itself is instant. Waste
comes from unnecessary subagent invocations, large step params, and avoidable I/O round-trips.

### 1. Never use a subagent for read-only work

Reading files, extracting fields, and summarising document content do not require LLM judgment.
Do this work yourself using `read_file`, `grep_search`, or `semantic_search` before calling
`create_workflow`. Pass the extracted data as initial workflow params or inline it in the first
step's `execute_step` call.

**Anti-pattern:** `read_strategy` step → Explore subagent reads the file → returns 2000-token
summary as step output → next step receives it as input.

**Correct pattern:** Read both files in parallel with `read_file` before starting the workflow.
Extract the fields you need. Pass them into the step that actually requires reasoning.

### 2. Parallelize inputs before the workflow, not inside it

Realm's execution is linear by design. If two documents need to be read before comparison can
begin, read them in parallel before calling `create_workflow` — not as two sequential workflow
steps. Two `read_file` calls in parallel take ~100ms. Two sequential Explore subagent steps
take 4-6 minutes.

Reserve workflow steps for work that is genuinely sequential: the output of step N is required
as input to step N+1.

### 3. Step params are audit records, not document mirrors

Step `params` become evidence chain entries. They should record **decisions, diffs, and
structured summaries** — not full document content. If a step's output exceeds a few hundred
tokens, the step is doing too much or returning too much. Common signs:

- The step param contains full file content or multi-paragraph quotes
- The token count in `realm run inspect` diagnostics is in the thousands
- A downstream step simply re-reads the same data from the prior step's output

Keep step outputs to the fields that the next step or the user actually needs. Everything
else belongs in the files on disk, which are the real record.

### 4. Use subagents only when LLM judgment is genuinely required

A subagent invocation is a full independent LLM session. It takes 2-4 minutes, initialises its
own context, and adds substantial overhead. Use subagents only for steps that require reasoning,
writing, or analysis — not for data collection.

Good reasons to spawn a subagent: writing a section of a document, comparing two sets of
requirements, generating a structured report.

Bad reasons: reading a file, listing directory contents, searching for a string, checking
whether a value exists.

If a step can be done with a single tool call, do it directly. Don't delegate it.

### 5. Never write data to a file just to read it back

If data returned from a subagent or tool call needs to be passed to `execute_step`, format it
directly into `params` from the in-memory result. Writing to an intermediate file and then
reading it back adds two file I/O operations and burns tokens. The data is already in memory.

The only valid reason to write intermediate output to disk is if the data would exceed what
can reasonably be represented in a `params` field — in which case, store the file path in
`params` (not the content) and let the next step read it if needed.

## After Calling create_workflow

The response is a `ResponseEnvelope` in the same shape as a `start_run` response. The run has
already started — check `next_actions` immediately and proceed to `execute_step`:

```json
{
  "status": "ok",
  "run_id": "<assigned-run-id>",
  "data": { "workflow_id": "acme-proposal-a1b2c3" },
  "next_actions": [
    {
      "prompt": "Your task for the first step...",
      "instruction": {
        "tool": "execute_step",
        "call_with": {
          "run_id": "<assigned-run-id>",
          "command": "research_company",
          "params": {}
        }
      }
    }
  ]
}
```

Call `execute_step` using `instruction.call_with` as the template — fill in your step output
in `params` (shaped to `next_actions[0].input_schema` if present). The engine does not require
a `run_version` argument — it reads the current version from the store automatically.

The step loop from this point is identical to Mode 1: read `next_actions[0].prompt`, do the
work, call `execute_step` with your output in `params`, and repeat. Stop when `status` is
`confirm_required` (human gate — see `realm.instructions.md` step 6) or when `status` is `ok`
and `next_actions` is empty (workflow finished). Error responses carry `agent_action` — handle
them as described in `realm.instructions.md`.

## Constraints

- `agent_profile` is not supported on dynamically-created workflows. If a step includes it,
  `create_workflow` returns `agent_action: 'provide_input'`. Remove the field and retry.
- Step IDs must be unique, non-empty, and contain no spaces.
- Step descriptions must be non-empty.
- `timeout_seconds` must be a positive integer if set.
- All steps in a dynamic workflow are `execution: agent` — the engine always returns them to
  you for execution. `handler:` and `uses_service:` are not available on dynamic steps; use
  a YAML-registered workflow if you need auto steps, service adapters, or handlers.
- `depends_on` references must point to steps earlier in the `steps` array. Forward references
  cause a `provide_input` error at `create_workflow` call time.
- `workflow_context` is not supported on dynamically-created workflows. It is a YAML-loader
  feature resolved at registration time — file paths are resolved and validated when
  `realm workflow register` processes the workflow directory. Dynamic workflows have no
  directory, so no static context files can be attached. Use a YAML-registered workflow if
  your steps need static reference files injected into prompts via `{{ workflow.context.NAME }}`.
