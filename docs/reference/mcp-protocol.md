# MCP Protocol Reference

Realm exposes 7 MCP tools. This document covers the full protocol: tool call patterns, response envelope fields, and error recovery.

---

## Tools

| Tool                    | Description                                                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_workflows`        | Returns all registered workflow IDs and names. Call this first to discover what is available.                                                                                                       |
| `get_workflow_protocol` | Returns the full agent briefing for a workflow: step list, input schemas, instructions, rules, and quick_start. Read this before `start_run`.                                                       |
| `start_run`             | Starts a new run for a workflow. Accepts `workflow_id` and optional `params`.                                                                                                                       |
| `execute_step`          | Submits agent output for the current step. Accepts `run_id`, `command` (step name), and `params`.                                                                                                   |
| `submit_human_response` | Submits a human gate response. Accepts `run_id`, `gate_id`, and `choice`.                                                                                                                           |
| `get_run_state`         | Returns the current state, evidence chain, and terminal status of a run. When `run_phase` is `aborted`, also returns `abort_context` (guard step ID, evaluated conditions, optional abort message). |
| `create_workflow`       | Registers a dynamic workflow from a `steps` array and immediately starts a run. No YAML file or `realm register` required.                                                                          |

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
