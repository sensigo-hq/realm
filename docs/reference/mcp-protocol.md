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

**`structured_output` note (issue #236):** a step declaring `structured_output: strict` that is
driven via `execute_step` by anything other than `realm agent` (an external agent calling the MCP
tool directly, for instance) never receives Anthropic grammar-constrained decoding — that
mechanism is `realm agent`'s own provider layer, not part of the MCP protocol surface. The
attempt's evidence still discloses this honestly (`downgrade_reason: 'external_agent'`, visible
via `realm run inspect`) — but `get_run_state` does not carry per-step evidence at all, so an
MCP-only consumer combines the run's `terminal_reason` + `failed_steps` + derived `run_phase`
instead of reading a per-attempt field. See
[`structured_output`](yaml-schema.md#structured_output-anthropic-strict-decoding).

**`structured_output_downgraded` run-health finding (issue #316):** the remedy for the
per-step-evidence gap above, for the OTHER downgrade causes (a live API rejection, a gate
ineligibility, an unsupported provider — anything except the `external_agent` case, which is
excluded by design since it is never realm's own doing to report on). `get_run_state`'s
`run_health` array carries a `structured_output_downgraded` finding, and its `warnings` array
gains a summary line, whenever a live run has one or more steps that requested strict but ran
without it — no per-step evidence access required. **Residual, stated honestly:** a downgrade on
a run's FINAL step can seal before a watchdog's next poll notices it, and `get_run_state` zeroes
`run_health` entirely on a terminal run (the frozen #279-R3 guard — see
[operating-runs.md](operating-runs.md)) — so a pure-MCP poller that only ever calls `get_run_state`
can miss a last-window downgrade. The evidence itself retains the disclosure permanently
regardless (it is never deleted on seal), and `realm run inspect` always shows it — the finding is
a live-visibility improvement, not a replacement for inspecting a terminal run's evidence when
that matters.

**Strict tool-call arguments (issue #311):** a step declaring both `structured_output: strict` and
`tools` gets strict on its TOOL-CALL ARGUMENTS (per tool, assessed at runtime), while its own
output stays unconstrained. Two consequences for an MCP consumer:

- That step fires `structured_output_downgraded` with `unsupported_context_tools` on EVERY run, by
  design — the output dimension genuinely is unconstrained. Treat it as a baseline; alert on the
  reason list rather than on the finding being present.
- The tool-arguments dimension contributes exactly ONE marked literal,
  `tool_args:api_rejected_schema`, and only when the API rejected a tool schema realm had assessed
  as eligible. The full per-tool block (`diagnostics.structured_output.tool_args` — which tools
  carried strict, which were skipped and why, and any mid-attempt drop) is evidence-only and
  therefore reachable via `realm run inspect`/`realm run export`, not `get_run_state`. This is the
  same per-step-evidence gap described above, and the narrow finding is the deliberate remedy: the
  per-tool detail would drown a poller in routine outcomes.

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

| Field                | Type     | Description                                                                                                                                                                                                                                                                                                           |
| -------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`            | string   | The step name that was executed.                                                                                                                                                                                                                                                                                      |
| `run_id`             | string   | Stable run identifier.                                                                                                                                                                                                                                                                                                |
| `run_version`        | number   | Integer version of the run record. Observability only — not required as input to any tool.                                                                                                                                                                                                                            |
| `status`             | string   | `ok`, `error`, `blocked`, or `confirm_required`.                                                                                                                                                                                                                                                                      |
| `data`               | object   | Step output from the handler or adapter.                                                                                                                                                                                                                                                                              |
| `evidence`           | array    | Evidence snapshots produced by this call.                                                                                                                                                                                                                                                                             |
| `warnings`           | string[] | Non-fatal notices (e.g. a recovery path was taken — check `context_hint` for details).                                                                                                                                                                                                                                |
| `diagnostics`        | array    | Structured, code-tagged counterpart to `warnings` — `{ code, severity, message, scope, key?, did_you_mean? }` per entry. Additive-optional; only `create_workflow` populates it today (see below), every other tool omits it. Lets an agent branch on `code`/`key`/`did_you_mean` instead of parsing `warnings` text. |
| `errors`             | string[] | Error messages when `status` is `error` or `blocked`.                                                                                                                                                                                                                                                                 |
| `context_hint`       | string   | Human-readable description of what just happened and the current run state. Present on every response including errors.                                                                                                                                                                                               |
| `next_actions`       | array    | Steps available for execution. Empty on terminal or unrecoverable states. Multiple items signal parallel fan-out.                                                                                                                                                                                                     |
| `agent_action`       | string   | Error recovery instruction. Present only when `status` is `error` or `blocked`.                                                                                                                                                                                                                                       |
| `chained_auto_steps` | array    | Ordered record of auto steps the engine ran silently in this call. Omitted when no auto steps were chained.                                                                                                                                                                                                           |
| `gate`               | object   | Gate data. Present only when `status` is `confirm_required`.                                                                                                                                                                                                                                                          |

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

A duplicate `submit_human_response` call with the SAME `gate_id` and the SAME choice (e.g. a
retried tool call) is an idempotent no-op — it returns the same `ok` outcome the original
submission committed, not an error. Submitting a DIFFERENT choice against a gate that another
attempt already resolved is refused (`STATE_BLOCKED`) with the winning choice named, so a racing
caller learns what was actually recorded rather than silently overwriting it.

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

An unrecognized step key (e.g. a typo like `dependson`) is never rejected — the field is dropped
and the workflow is still created. It's surfaced both in `warnings` (the rendered text, e.g.
`⚠ step 'x': unknown key 'dependson' — ignored (did you mean 'depends_on'?)`) and as a structured
entry (`code: "UNKNOWN_CREATE_WORKFLOW_KEY"`) in `diagnostics` — an authoring agent can self-correct
on the next call instead of repeating the same typo.

### Metadata fields

| Field              | Required | Description                                                                                                                                                                                                                                                                                                    |
| ------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | No       | Short kebab-case slug used to derive the workflow ID.                                                                                                                                                                                                                                                          |
| `description`      | No       | **Declarative** — what this workflow is for / when to use it. Becomes the workflow's `description`, surfaced in the agent protocol (`get_workflow_protocol`) and echoed by `realm workflow validate`/`register`. No synthesized default: omit it (or submit only whitespace) and the workflow simply has none. |
| `task_description` | No       | **Imperative** — how to begin driving this run (the quick-start instruction). Becomes `protocol.quick_start`. Distinct from `description` above — one says what the workflow is, this says how to start it.                                                                                                    |

`description` and `task_description` map to different places and are never blurred: `description` is
the declarative "what it's for," `task_description` is the imperative "how to begin."

### Response and continuation

The response has the same shape as a `start_run` response. Check `next_actions[0]` immediately and proceed with `execute_step` — the run is already live when `create_workflow` returns.
