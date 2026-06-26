# MCP Protocol Reference

Realm exposes 10 MCP tools. This document covers the full protocol: tool call patterns, response envelope fields, and error recovery.

---

## Tools

| Tool                    | Description                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_workflows`        | Returns all registered workflow IDs and names. Call this first to discover what is available.                                                                                                                                                                                                                                                                                        |
| `get_workflow_protocol` | Returns the full agent briefing for a workflow: step list, input schemas, instructions, rules, and quick_start. Read this before `start_run`.                                                                                                                                                                                                                                        |
| `start_run`             | Starts a new run for a workflow. Accepts `workflow_id`, optional `params`, optional `idempotency_key` (if supplied and a run with that key already exists for the workflow, the existing run is returned instead of creating a new one), and optional `on_terminal_match` / `on_live_match` policy params — see [Idempotency re-encounter policy](#idempotency-re-encounter-policy). |
| `start_run_batch`       | Atomically enqueues multiple runs of the same workflow. Accepts a single `workflow_id`, an `items` array (each item has `params` and optional `idempotency_key`), optional `parent_run_id`, and optional `max_items` (default 100). All items are validated before any run is created.                                                                                               |
| `execute_step`          | Submits agent output for the current step. Accepts `run_id`, `command` (step name), and `params`.                                                                                                                                                                                                                                                                                    |
| `submit_human_response` | Submits a human gate response. Accepts `run_id`, `gate_id`, and `choice`.                                                                                                                                                                                                                                                                                                            |
| `get_run_state`         | Returns the current state, evidence chain, and terminal status of a run. When `run_phase` is `aborted`, also returns `abort_context` (guard step ID, evaluated conditions, optional abort message). Also returns `next_actions` + `next_actions_status` (see below).                                                                                                                 |
| `abandon_run`           | Abandons a non-terminal run — marks it terminal with phase `abandoned`. Accepts `run_id` and optional `reason`. Idempotent; refuses already-terminal runs (`STATE_RUN_TERMINAL`) and `gate_waiting` runs (`STATE_TRANSITION_DENIED` — resolve the gate first). See [Operating & recovering runs](operating-runs.md).                                                                 |
| `create_workflow`       | Registers a dynamic workflow from a `steps` array and immediately starts a run. No YAML file or `realm register` required.                                                                                                                                                                                                                                                           |
| `list_runs`             | Lists runs, optionally filtered by `workflow_id` or `status`.                                                                                                                                                                                                                                                                                                                        |

---

## `get_run_state` diagnostics

`get_run_state` is read-only and returns, in addition to the state summary, the run's eligible
agent/handler steps as `next_actions` plus a `next_actions_status` that classifies the run:

| `next_actions_status` | Meaning                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `ok`                  | `next_actions` is authoritative — agent steps to call, or a healthy run with nothing pending now.             |
| `auto_pending`        | Eligible steps exist but are all `auto` — the engine drives them; the run is not awaiting the agent.          |
| `awaiting_human`      | A human gate is open — answer with `submit_human_response`.                                                   |
| `skipped_terminal`    | The run is terminal; nothing to do.                                                                           |
| `workflow_unresolved` | The workflow definition could not be loaded (unregistered / no workflow store) — `next_actions` not computed. |

`auto_pending` vs an empty `ok` distinguishes a genuinely-parked run from one with no pending agent
action. See [Operating & recovering runs](operating-runs.md).

---

## Standard loop

1. Call `list_workflows` — discover registered workflow IDs.
2. Call `get_workflow_protocol` with the matched `workflow_id` — read the briefing.
3. Call `start_run` — the engine auto-chains through initial auto steps and returns at the first agent step.
4. Call `execute_step` with `params` shaped to `next_actions[0].input_schema` — repeat until `status` is `ok` and `next_actions` is empty, or `status` is `confirm_required`.
5. When `status: confirm_required` — present `gate.display` to the user, collect their choice, call `submit_human_response`.

---

## Response envelope

Every tool call returns a `ResponseEnvelope`:

| Field                | Type     | Description                                                                                                             |
| -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `command`            | string   | The step name that was executed.                                                                                        |
| `run_id`             | string   | Stable run identifier.                                                                                                  |
| `run_version`        | number   | Integer version of the run record. Observability only — not required as input to any tool.                              |
| `status`             | string   | `ok`, `error`, `blocked`, or `confirm_required`.                                                                        |
| `data`               | object   | Step output from the handler or adapter.                                                                                |
| `evidence`           | array    | Evidence snapshots produced by this call.                                                                               |
| `warnings`           | string[] | Non-fatal notices (e.g. a recovery path was taken — check `context_hint` for details).                                  |
| `errors`             | string[] | Error messages when `status` is `error` or `blocked`.                                                                   |
| `context_hint`       | string   | Human-readable description of what just happened and the current run state. Present on every response including errors. |
| `next_actions`       | array    | Steps available for execution. Empty on terminal or unrecoverable states. Multiple items signal parallel fan-out.       |
| `agent_action`       | string   | Error recovery instruction. Present only when `status` is `error` or `blocked`.                                         |
| `chained_auto_steps` | array    | Ordered record of auto steps the engine ran silently in this call. Omitted when no auto steps were chained.             |
| `gate`               | object   | Gate data. Present only when `status` is `confirm_required`.                                                            |

---

## `next_actions`

`next_actions` is an array. For linear workflows it contains a single item; for parallel fan-out it contains multiple. Always check the length before deciding how to proceed.

Each item has the following fields:

| Field                   | Description                                                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orientation`           | Forward-looking state description — what state the run is in and what step comes next. Distinct from `context_hint`, which describes what just happened.                                |
| `prompt`                | The resolved task prompt for the current agent step. Read this and act on it.                                                                                                           |
| `instruction.tool`      | The tool to call next (`execute_step` or `submit_human_response`).                                                                                                                      |
| `instruction.call_with` | Ready-to-use argument object. For agent steps, `call_with.params` is a schema skeleton — placeholder strings for enums, zero values for scalars. Fill in your values and call the tool. |
| `input_schema`          | JSON Schema for the `params` this step expects.                                                                                                                                         |

---

## `chained_auto_steps`

When `start_run` or `execute_step` chains through auto steps before returning, `chained_auto_steps` records each one in order:

```json
"chained_auto_steps": [
  { "step": "validate_fields", "run_phase": "running" },
  { "step": "confirm_submission", "run_phase": "gate_waiting" }
]
```

`branched_via` is present when a DAG branch was taken (e.g. a `trigger_rule: one_failed` recovery step was auto-executed).

Guard steps (`execution: guard`) also appear in `chained_auto_steps`. A passing guard has `run_phase: running`; a guard that fires and aborts the run has `run_phase: aborted`, and the outer response will have `next_actions: []`.

---

## Gate response (`status: confirm_required`)

When the engine opens a gate:

1. Read `gate.agent_hint` — if present, it contains instructions on how to present the gate.
2. Present `gate.display` to the user verbatim.
3. Collect the user's choice from `gate.response_spec.choices`.
4. Call `submit_human_response` using `next_actions[0].instruction.call_with` with the choice filled in.

| Field                        | Description                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `gate.display`               | The human-facing content. Resolved from `gate.message` if configured; falls back to `step.prompt` resolved. Present verbatim. |
| `gate.agent_hint`            | Optional presentation instructions from the step's `instructions` field.                                                      |
| `gate.response_spec.choices` | Valid choice values (e.g. `["approve", "reject"]`).                                                                           |
| `gate.preview`               | Full step output at gate opening, for reference and debugging.                                                                |

---

## Error recovery (`agent_action`)

`status: error` and `status: blocked` responses always include `agent_action`. Do not parse error message text to decide recovery — use `agent_action`.

| `agent_action`         | Meaning                                                                      | What to do                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `stop`                 | Terminal failure. Cannot recover.                                            | Report to user. Do not retry.                                                                                                            |
| `report_to_user`       | Engine state inconsistent (e.g. version conflict).                           | Surface to user. Do not retry.                                                                                                           |
| `provide_input`        | Submitted `params` were rejected by schema validation.                       | Fix `params` and retry `execute_step` with the same `command`. Use `next_actions[0].instruction.call_with` for the corrected call shape. |
| `resolve_precondition` | A precondition failed or the step is not eligible for the current run state. | Follow `next_actions[0]` to an eligible step, or read `blocked_reason.eligible_steps` for what can run.                                  |
| `wait_for_human`       | A gate is open and waiting for a choice.                                     | Call `submit_human_response` with the user's choice.                                                                                     |

When `agent_action` is `provide_input` or `resolve_precondition` and `next_actions` is non-empty, follow the first item exactly as after a successful step.

A `provide_input` rejection (the agent's `execute_step` output failed schema validation) is a **pre-claim, write-free** path: nothing is persisted to the run record and `version` is not bumped, so it leaves no run-record trail. The MCP server emits a metadata-only `agent_step_attempt_failed` stderr event for these rejections so operators retain a post-mortem trail — see [Operating & recovering runs → Failed agent attempts](operating-runs.md#failed-agent-attempts-agent_step_attempt_failed-telemetry).

---

## `start_run_batch`

Use `start_run_batch` to enqueue multiple runs of the same workflow atomically. All items are validated before any run is created — if any item fails schema validation, no runs are created and the tool returns a `VALIDATION_BATCH_ITEMS` error with a `failures` array listing each failing item by index.

```json
{
  "workflow_id": "ticket-classifier",
  "parent_run_id": "<orchestrating-run-id>",
  "max_items": 10,
  "items": [
    { "params": { "ticket_id": "T-001", "body": "Login broken" } },
    { "params": { "ticket_id": "T-002", "body": "Billing error" }, "idempotency_key": "T-002" }
  ]
}
```

### Arguments

| Field               | Required | Description                                                                                                                                                                                                               |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow_id`       | Yes      | The workflow to start runs for. All items share the same workflow.                                                                                                                                                        |
| `items`             | Yes      | Array of run inputs. Each item has `params` (required) and an optional `idempotency_key`. If `idempotency_key` is set and a run with that key already exists, it is returned as-is rather than creating a new run.        |
| `parent_run_id`     | No       | Run ID of the orchestrating parent. Stored on each child run record for traceability.                                                                                                                                     |
| `max_items`         | No       | Maximum number of items allowed in a single call. Defaults to `100`. If `items.length` exceeds this cap, the call fails immediately with `VALIDATION_BATCH_TOO_LARGE` before any validation or creation.                  |
| `on_terminal_match` | No       | Idempotency policy when a key matches a **terminal** run, applied to every item. One of `reuse` (default), `reject`, `rerun_if_failed`, `rerun`. See [Idempotency re-encounter policy](#idempotency-re-encounter-policy). |
| `on_live_match`     | No       | Idempotency policy when a key matches a **non-terminal** run, applied to every item. One of `use_existing` (default), `fail`.                                                                                             |

### Response

On success returns `{ started, failed }`:

- `started: Array<{ run_id, params, idempotency_key?, deduped, run_phase, terminal_reason?, warnings }>` — one entry per accepted item. `deduped` is `true` when an existing run matched the key; `run_phase` is the matched/created run's phase; `warnings` carries observational active-match / param-mismatch notes.
- `failed: Array<{ index, idempotency_key?, params, error, error_code? }>` — items rejected by the idempotency policy (`on_terminal_match: 'reject'` or `on_live_match: 'fail'`). `index` correlates back to `items[]`. **A rejected item does not abort the batch** — accepted items still appear in `started[]`.

On failure (before any item is processed) returns a `ResponseEnvelope` with `status: error` and `agent_action: provide_input`.

| Error code                   | Cause                                                                      |
| ---------------------------- | -------------------------------------------------------------------------- |
| `VALIDATION_BATCH_TOO_LARGE` | `items.length` exceeds `max_items`. No runs were created.                  |
| `VALIDATION_BATCH_ITEMS`     | One or more items failed `params_schema` validation. No runs were created. |
| `STATE_WORKFLOW_NOT_FOUND`   | `workflow_id` is not registered.                                           |

---

## Idempotency re-encounter policy

When an `idempotency_key` matches an existing run, the caller decides what happens via two
orthogonal, optional parameters on `start_run` and `start_run_batch`. Both **default to today's
behavior** — omit them and a match returns the existing run unchanged (`deduped: true`).

**`on_terminal_match`** — key matches a **terminal** run (`completed` / `failed` / `aborted` / `abandoned`):

| Value               | Behavior                                                                                                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reuse` _(default)_ | Return the existing run (`deduped: true`). Nothing is re-driven.                                                                                                                                                                    |
| `reject`            | Throw `STATE_IDEMPOTENCY_KEY_USED` — the key was already used and its run is terminal.                                                                                                                                              |
| `rerun_if_failed`   | A `failed` / `aborted` / `abandoned` match is **superseded** by a fresh run (`deduped: false`); a **`completed`** match is **reused** (benign skip — re-running a closed-ticket batch should not error on already-succeeded items). |
| `rerun`             | Always supersede the matched run with a fresh run (`deduped: false`).                                                                                                                                                               |

**`on_live_match`** — key matches a **non-terminal** run (`running` / `gate_waiting`):

| Value                      | Behavior                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `use_existing` _(default)_ | Return the live run (`deduped: true`) plus an observational warning that it is still active.  |
| `fail`                     | Throw `STATE_RUN_ALREADY_ACTIVE` — the key is owned by a still-active run (concurrency-safe). |

**Supersede** repoints the idempotency key to the fresh run via a single atomic pointer overwrite;
the superseded run remains on disk by id (auditable) but no longer owns the key.

**`terminate`** (abort the live run, then restart) is **intentionally unsupported**: a daemonless
file store cannot actually stop a detached `realm agent`, so marking its record aborted while it
keeps writing would be a race. Recovering a genuinely-zombie run is a deliberate operator action,
not an automatic policy.

---

## `create_workflow`

Use `create_workflow` when no registered workflow matches the task. It registers a dynamic workflow and starts a run in one call — do not call `start_run` afterward.

```json
{
  "steps": [
    {
      "id": "research_problem",
      "description": "Audit all JSDoc comments and list files with missing or inaccurate docs."
    },
    {
      "id": "generate_fixes",
      "description": "For each file identified, generate corrected JSDoc.",
      "depends_on": ["research_problem"],
      "input_schema": {
        "type": "object",
        "properties": { "audit_summary": { "type": "string" } },
        "required": ["audit_summary"]
      }
    }
  ],
  "metadata": {
    "name": "jsdoc-audit",
    "task_description": "Audit and fix JSDoc across the codebase."
  }
}
```

### Step fields

| Field             | Required | Description                                                                                                |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `id`              | Yes      | Unique step identifier. Snake_case verb-noun (e.g. `research_problem`). No spaces.                         |
| `description`     | Yes      | Acceptance criterion for the step — what correct output looks like, not how to produce it.                 |
| `depends_on`      | No       | Array with at most one step ID this step depends on. Controls execution order. Omit for the first step.    |
| `input_schema`    | No       | JSON Schema for the fields this step's `params` must include. Used to validate `execute_step` submissions. |
| `timeout_seconds` | No       | Positive integer. If the step is not completed within this time, the run enters an error state.            |

### Metadata fields

| Field              | Required | Description                                           |
| ------------------ | -------- | ----------------------------------------------------- |
| `name`             | No       | Short kebab-case slug used to derive the workflow ID. |
| `task_description` | No       | Human-readable description of the overall task.       |

### Response and continuation

The response has the same shape as a `start_run` response. Check `next_actions[0]` immediately and proceed with `execute_step` — the run is already live when `create_workflow` returns.
