# MCP tools

Realm's MCP server has 10 tools. An AI assistant calls them to find a workflow, start a run, do its steps and read its state. This page gives each tool's parameters and its reply. The tools and their parameters were read from the server's own `tools/list` reply, and every reply shown came from a call.

| Tool                                              | What it does                                                  |
| ------------------------------------------------- | ------------------------------------------------------------- |
| [`list_workflows`](#list_workflows)               | Lists the registered workflows.                               |
| [`get_workflow_protocol`](#get_workflow_protocol) | Describes one workflow's steps and the rules for running it.  |
| [`start_run`](#start_run)                         | Starts a run.                                                 |
| [`start_run_batch`](#start_run_batch)             | Starts several runs of one workflow.                          |
| [`execute_step`](#execute_step)                   | Does one step, with the assistant's answer.                   |
| [`submit_human_response`](#submit_human_response) | Passes on a person's choice at a gate.                        |
| [`get_run_state`](#get_run_state)                 | Returns where a run stands.                                   |
| [`abandon_run`](#abandon_run)                     | Ends an open run.                                             |
| [`create_workflow`](#create_workflow)             | Makes a workflow from a list of steps and starts a run of it. |
| [`append_trace`](#append_trace)                   | Records notes about a step before the step is done.           |

To connect an assistant, see [Connect an MCP client](../../guides/connect-an-mcp-client.md).

## Calling a tool

- **A required parameter that is missing, or a value of the wrong type, is refused by the MCP layer.** The call is marked as an error and its text is, for example, `MCP error -32602: Input validation error: Invalid arguments for tool execute_step: Required at command`.
- **A parameter the tool does not have is ignored, without a warning.** A `start_run` call with `idempotencyKey` in place of `idempotency_key` started a run with no key. `create_workflow` is the exception: it names what it ignored.
- **Every other refusal is an ordinary reply** with `status: "error"`, described next.

## The reply

`start_run`, `execute_step`, `submit_human_response` and `create_workflow` reply with one JSON object of the same shape. The other tools use that shape when they refuse a call. The examples on this page leave out fields that are empty, and show a long `next_actions` list as `"…"`.

| Field                                                   | Always present                                                                     | Holds                                                                                                                        |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `command`                                               | Yes                                                                                | The tool, or for `execute_step` and `submit_human_response` the step.                                                        |
| `run_id`                                                | Yes                                                                                | The run. Empty when no run exists.                                                                                           |
| `run_version`                                           | Yes                                                                                | A number that rises each time the run is changed.                                                                            |
| `status`                                                | Yes                                                                                | `ok`, `error`, `blocked` or `confirm_required`. See below.                                                                   |
| `context_hint`                                          | Yes                                                                                | One sentence about what has just happened.                                                                                   |
| `next_actions`                                          | Yes                                                                                | The calls that can be made next. Empty when the run has ended, is waiting, or cannot go on.                                  |
| `warnings`, `errors`                                    | Yes                                                                                | Lists of messages.                                                                                                           |
| `data`, `evidence`                                      | Yes                                                                                | Empty in MCP replies, except that `create_workflow` puts the new `workflow_id` in `data`. Read the run with `get_run_state`. |
| `run_phase`                                             | With a run                                                                         | The run's phase after the call.                                                                                              |
| `error_code`                                            | On an error                                                                        | A code such as `VALIDATION_INPUT_SCHEMA`. See [Error codes](../error-codes.md).                                              |
| `error_details`                                         | On some errors                                                                     | Details that depend on the code, such as the schema rules that were broken.                                                  |
| `agent_action`                                          | On an error or a block                                                             | What the caller should do. See below.                                                                                        |
| `retry_after`                                           | With `wait_and_proceed`                                                            | How many seconds to wait.                                                                                                    |
| `blocked_reason`                                        | With `blocked`                                                                     | `eligible_steps`, the steps that can be called, and a `suggestion`.                                                          |
| `gate`                                                  | With `confirm_required`                                                            | The open gate: `gate_id`, `step_name`, `preview`, `choices`, and when set `display`, `agent_hint`, `expires_at`.             |
| `deduped`                                               | From `start_run` and `create_workflow`                                             | `true` if an existing run was returned in place of a new one.                                                                |
| `chained_auto_steps`                                    | When `auto` or `guard` steps ran in the call                                       | Each such step and the run's phase after it. From `start_run` and `execute_step` only.                                       |
| `guards`                                                | When the call's write decided guard steps                                          | Each guard and its `outcome`: `pass`, `abort` or `resolution_error`. See [Guards in a reply](#guards-in-a-reply).            |
| `ended_by`                                              | When one of those guards ended the run                                             | `arm`, the guard's `step`, and a `reason` when there is one.                                                                 |
| `answer_recorded`                                       | From `submit_human_response`, for an answer that came after the gate's time was up | `false`. It is never `true`: an answer that was recorded leaves the field out.                                               |
| `adopted_own`, `adopted_anonymous`, `preserved_foreign` | From `execute_step` on an agent step                                               | How many trace entries sent with `append_trace` were attached to the step.                                                   |
| `settled_by_default`, `defaulted_steps`                 | When a step was given its default output                                           | See [Agent-step controls](../workflow/agent-step-controls.md#validation_exhaustion).                                         |
| `diagnostics`                                           | From `create_workflow`                                                             | What was ignored in the request, as a list.                                                                                  |

### Guards in a reply

A guard step is never called. It is decided inside the write that makes it ready, and the reply to that call says what it did:

- `guards` lists each guard the write decided, in order, with its `outcome`.
- From `start_run` and `execute_step`, each of those guards is also in `chained_auto_steps`. From `submit_human_response` they are in `guards` only.
- When a guard ended the run, `ended_by` holds its `arm` (`guard_abort`, `guard_resolution_error` or `guard_pass_complete`) and its `step`, and `context_hint` is one of `Guard step '<step>' aborted the run.`, `Guard step '<step>' failed with a resolution error. Run is terminated.` and `Guard step '<step>' passed and completed the run.`
- `ended_by.reason` is the guard's `abort_message` when it aborted, and is left out when the guard has none. For a resolution error it is the error recorded for the guard. For a guard that passed and completed the run there is none.

A step that fails can also leave a guard ready. Its reply keeps its own `status`, errors and sentence, and adds `guards` and `ended_by`.

A reply from `execute_step`, for an agent step whose answer made a guard abort the run:

```json
{
  "command": "assess",
  "run_id": "df89a4e4-7a4b-4ff9-aaf0-657f70ae1723",
  "run_version": 2,
  "status": "ok",
  "context_hint": "Guard step 'only_low_risk' aborted the run.",
  "run_phase": "aborted",
  "guards": [{ "step": "only_low_risk", "outcome": "abort" }],
  "ended_by": {
    "arm": "guard_abort",
    "step": "only_low_risk",
    "reason": "High-risk refunds are not paid automatically."
  },
  "chained_auto_steps": [{ "step": "only_low_risk", "run_phase": "aborted" }]
}
```

### `status`

| Value              | Means                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `ok`               | The call moved the run forward, or found nothing to do. Follow `next_actions`.              |
| `error`            | The call was refused or the step failed. `agent_action` says what to do.                    |
| `blocked`          | The step cannot be called now. `next_actions` and `blocked_reason` name the steps that can. |
| `confirm_required` | A human gate is open. `gate` holds what to show the person.                                 |

### `agent_action`

| Value                  | The caller should                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `provide_input`        | Correct the input and call the step again. `error_details` says what was wrong.    |
| `resolve_precondition` | Call the step named in `next_actions` first.                                       |
| `report_to_user`       | Show the error to the person and wait for guidance.                                |
| `wait_for_human`       | Show the error to the person and wait until they say the outside problem is fixed. |
| `wait_and_proceed`     | Wait `retry_after` seconds, then follow `next_actions`.                            |
| `stop`                 | Make no further calls for this run.                                                |

### An entry of `next_actions`

```json
{
  "instruction": {
    "tool": "execute_step",
    "params": { "run_id": "7da561ee-5987-497d-83a5-1eded6dc9b63", "command": "classify" },
    "call_with": {
      "run_id": "7da561ee-5987-497d-83a5-1eded6dc9b63",
      "command": "classify",
      "params": { "category": "<billing|bug|other>", "confidence": 0 }
    }
  },
  "input_schema": { "type": "object", "required": ["category", "confidence"], "…": "…" },
  "human_readable": "Execute step 'classify': Classify the ticket.",
  "orientation": "Run is active. Next step ready: 'classify'."
}
```

| Field                   | Holds                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `instruction.tool`      | The tool to call.                                                                        |
| `instruction.call_with` | The arguments for that call, with a placeholder wherever the caller must supply a value. |
| `instruction.params`    | The same arguments without the caller's part.                                            |
| `input_schema`          | The schema the step's answer must fit, if the step has one.                              |
| `prompt`                | The step's prompt with its values filled in, if the step has one.                        |
| `human_readable`        | The instruction as a sentence.                                                           |
| `orientation`           | Where the run stands.                                                                    |

## `list_workflows`

Takes no parameters.

```json
{
  "status": "ok",
  "workflows": [{ "id": "triage", "name": "Ticket triage", "version": 1 }],
  "unreadable": [],
  "warnings": [],
  "hint": "Call get_workflow_protocol with a workflow_id before calling start_run. If no workflow matches your task, use create_workflow to define and start your own plan."
}
```

`unreadable` lists registered copies that could not be read, each with the reason.

## `get_workflow_protocol`

| Parameter     | Type | Required | Holds              |
| ------------- | ---- | -------- | ------------------ |
| `workflow_id` | text | Yes      | The workflow's ID. |

The reply describes the workflow for the assistant:

| Field                 | Holds                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workflow_id`, `name` | The workflow.                                                                                                                                                |
| `quick_start`         | How to begin. The workflow's `protocol.quick_start`, or a standard sentence.                                                                                 |
| `rules`               | The rules to follow. The workflow's `protocol.rules`, or six standard rules.                                                                                 |
| `steps`               | Each step: `id`, `description`, `execution`, `agent_involvement`, and where set `input_schema`, `depends_on`, `possible_gate`, `agent_profile_instructions`. |
| `agent_steps_summary` | How many steps the assistant does, as a sentence.                                                                                                            |
| `error_handling`      | What each `agent_action` value means.                                                                                                                        |

An unknown ID is an MCP error with the text `Error: Workflow not found: nope`.

## `start_run`

| Parameter           | Type   | Required | Holds                                                                                                        |
| ------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------ |
| `workflow_id`       | text   | Yes      | The workflow to run.                                                                                         |
| `params`            | object | No       | The run's parameters. Checked against the workflow's `params_schema`. Default `{}`.                          |
| `idempotency_key`   | text   | No       | A key that makes a repeat of the call return the first run.                                                  |
| `on_live_match`     | text   | No       | What a repeat does while the first run is open: `use_existing` (default) or `fail`.                          |
| `on_terminal_match` | text   | No       | What a repeat does after the first run has ended: `reuse` (default), `reject`, `rerun_if_failed` or `rerun`. |

It creates the run, then runs every `auto` step that is ready, and replies when the run reaches a step for the assistant, a gate, or its end.

```json
{
  "command": "start_run",
  "run_id": "7da561ee-5987-497d-83a5-1eded6dc9b63",
  "run_version": 0,
  "status": "ok",
  "data": {},
  "evidence": [],
  "warnings": [],
  "errors": [],
  "context_hint": "Run '7da561ee-5987-497d-83a5-1eded6dc9b63' created for workflow 'triage'.",
  "run_phase": "running",
  "deduped": false,
  "next_actions": ["…"]
}
```

A repeat with the same key returns the first run, with `"deduped": true` and the warning `Idempotency key matched a run still in phase 'running'.` See [Idempotency and batches](../../guides/idempotency-and-batches.md).

An unknown workflow gets `error_code: "STATE_WORKFLOW_NOT_FOUND"`, with `run_id` empty.

## `start_run_batch`

| Parameter           | Type         | Required | Holds                                                                         |
| ------------------- | ------------ | -------- | ----------------------------------------------------------------------------- |
| `workflow_id`       | text         | Yes      | The workflow to run.                                                          |
| `items`             | list         | Yes      | One entry for each run: `params` (required) and `idempotency_key` (optional). |
| `max_items`         | whole number | No       | The largest batch accepted. Default 100.                                      |
| `parent_run_id`     | text         | No       | Recorded on each new run as the run that started it.                          |
| `on_live_match`     | text         | No       | As for `start_run`, applied to every item.                                    |
| `on_terminal_match` | text         | No       | As for `start_run`, applied to every item.                                    |

Every item is checked before any run is created. It creates the runs and runs no step, not even an `auto` step that is ready: each run waits for its first `execute_step` call or for a driver.

```json
{
  "started": [
    {
      "run_id": "591a77a7-4b92-4d88-8c92-bef75745eb38",
      "idempotency_key": "ticket-201",
      "params": { "ticket": 201 },
      "deduped": false,
      "run_phase": "running",
      "warnings": []
    },
    {
      "run_id": "4cf5addf-c079-4b67-9bce-8d6031205189",
      "params": { "ticket": 202 },
      "deduped": false,
      "run_phase": "running",
      "warnings": []
    }
  ],
  "failed": []
}
```

| Refusal                              | `error_code`                 | `error_details`                                                          |
| ------------------------------------ | ---------------------------- | ------------------------------------------------------------------------ |
| An item does not fit `params_schema` | `VALIDATION_BATCH_ITEMS`     | `failures`: each failing item's `index` and `reason`. No run is created. |
| More items than `max_items`          | `VALIDATION_BATCH_TOO_LARGE` | `count` and `max_items`.                                                 |

## `execute_step`

| Parameter      | Type   | Required | Holds                                                                                       |
| -------------- | ------ | -------- | ------------------------------------------------------------------------------------------- |
| `run_id`       | text   | Yes      | The run.                                                                                    |
| `command`      | text   | Yes      | The step's name.                                                                            |
| `params`       | object | No       | For an agent step, the assistant's answer. Default `{}`.                                    |
| `trace`        | list   | No       | Trace entries to record with the step. See [`append_trace`](#append_trace) for their shape. |
| `writer_nonce` | text   | No       | An identifier for this attempt, the same one given to `append_trace` for the attempt.       |

It checks the answer, records the step, runs every `auto` step that becomes ready, and replies.

| Outcome                                   | `status`           | Also in the reply                                                                                                                                |
| ----------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| The step completed                        | `ok`               | `next_actions` for the next step, or none if the run has ended.                                                                                  |
| The answer does not fit the step's schema | `error`            | `error_code: "VALIDATION_INPUT_SCHEMA"`, `agent_action: "provide_input"`, and in `error_details` the rules broken, `rejections` and `threshold`. |
| The step cannot be called now             | `blocked`          | `agent_action: "resolve_precondition"`, `blocked_reason`.                                                                                        |
| The step has a human gate                 | `confirm_required` | `gate`, and a `next_actions` entry for `submit_human_response`.                                                                                  |
| The run has already ended                 | `ok`               | `agent_action: "stop"`, and `context_hint` says no step was executed.                                                                            |

A refused answer:

```json
{
  "command": "classify",
  "run_id": "7da561ee-5987-497d-83a5-1eded6dc9b63",
  "run_version": 0,
  "status": "error",
  "errors": ["Invalid input for step 'classify'"],
  "error_code": "VALIDATION_INPUT_SCHEMA",
  "error_details": {
    "errors": [
      {
        "instancePath": "/category",
        "schemaPath": "#/properties/category/enum",
        "keyword": "enum",
        "params": { "allowedValues": ["billing", "bug", "other"] },
        "message": "must be equal to one of the allowed values"
      }
    ],
    "rejections": 1,
    "threshold": 6
  },
  "agent_action": "provide_input",
  "context_hint": "Error during 'classify'. Run phase: 'running'.",
  "run_phase": "running",
  "next_actions": ["…"]
}
```

A step with a gate:

```json
{
  "command": "draft",
  "status": "confirm_required",
  "context_hint": "Run is paused at gate '00bb04f5-1bb7-4f38-91c5-14cdb17b3f0e'. Available choices: send, discard.",
  "run_phase": "gate_waiting",
  "next_actions": ["…"],
  "gate": {
    "gate_id": "00bb04f5-1bb7-4f38-91c5-14cdb17b3f0e",
    "step_name": "draft",
    "preview": { "reply": "We have refunded the charge." },
    "choices": ["send", "discard"],
    "response_spec": { "choices": ["send", "discard"] }
  }
}
```

## `submit_human_response`

| Parameter      | Type | Required | Holds                                          |
| -------------- | ---- | -------- | ---------------------------------------------- |
| `run_id`       | text | Yes      | The run.                                       |
| `gate_id`      | text | Yes      | The open gate's ID, from `gate.gate_id`.       |
| `choice`       | text | Yes      | One of the gate's choices.                     |
| `responded_by` | text | No       | Who made the choice. Recorded with the answer. |

```json
{
  "command": "draft",
  "run_id": "7da561ee-5987-497d-83a5-1eded6dc9b63",
  "run_version": 6,
  "status": "ok",
  "context_hint": "Gate 'draft' resolved with choice 'send'. 1 step(s) now available.",
  "run_phase": "running",
  "next_actions": ["…"]
}
```

| Refusal                          | `error_code`              | Message                                                              |
| -------------------------------- | ------------------------- | -------------------------------------------------------------------- |
| The choice is not offered        | `VALIDATION_INPUT_SCHEMA` | `Choice 'maybe' is not valid. Expected one of: send, discard`        |
| The gate ID is not the open gate | `STATE_BLOCKED`           | `Gate 'x' is not the open gate and matches no committed resolution.` |

A guard step that the answer makes ready is decided in the same write. The reply names it in `guards`. It has no `chained_auto_steps`. When the guard ended the run, `status` is still `ok`, because the answer was recorded:

```json
{
  "command": "approve",
  "run_id": "c35030b6-0e8c-44c6-98a8-c0b5093b8c5b",
  "run_version": 3,
  "status": "ok",
  "context_hint": "Guard step 'only_if_shipping' aborted the run.",
  "run_phase": "aborted",
  "guards": [{ "step": "only_if_shipping", "outcome": "abort" }],
  "ended_by": { "arm": "guard_abort", "step": "only_if_shipping", "reason": "The order was held." }
}
```

**An answer after the gate's time is up** is not recorded. The call carries out the expiry first. For a gate that settles its default choice, the reply has `answer_recorded: false`, the guards that the expiry's write decided, and a `context_hint` that is the expiry's sentence followed by the guard's. An answer that names the settled choice gets `status: ok`:

```json
{
  "command": "approve",
  "run_id": "05a14e39-f39f-45be-856b-4795dc0fddeb",
  "run_version": 3,
  "status": "ok",
  "warnings": [
    "gate '1a42b4b0-1fa1-42c9-b9ca-099c040b43f2' expired 0m ago and was enacted (settle_default: 'hold') before this response arrived — enacted_via: submit."
  ],
  "context_hint": "the outcome matches your choice, but it was settled by timeout; your response was not recorded. Guard step 'only_if_shipping' aborted the run.",
  "run_phase": "aborted",
  "guards": [{ "step": "only_if_shipping", "outcome": "abort" }],
  "ended_by": { "arm": "guard_abort", "step": "only_if_shipping", "reason": "The order was held." },
  "answer_recorded": false
}
```

An answer that names another choice is refused, with the same three fields:

```json
{
  "command": "approve",
  "run_id": "4bac1f61-7142-4105-bbf0-1a25b02ba994",
  "run_version": 3,
  "status": "error",
  "warnings": [
    "gate 'ea7015be-9ce0-4937-a5ab-81045add8871' expired 0m ago and was enacted (settle_default: 'hold') before this response arrived — enacted_via: submit."
  ],
  "errors": [
    "Gate 'ea7015be-9ce0-4937-a5ab-81045add8871' was settled by timeout with choice 'hold' — your choice 'ship' was not recorded."
  ],
  "error_code": "STATE_BLOCKED",
  "error_details": {
    "runId": "4bac1f61-7142-4105-bbf0-1a25b02ba994",
    "gateId": "ea7015be-9ce0-4937-a5ab-81045add8871",
    "winning_choice": "hold",
    "resolved_by": "timeout"
  },
  "agent_action": "report_to_user",
  "context_hint": "Gate 'ea7015be-9ce0-4937-a5ab-81045add8871' was settled by timeout with choice 'hold' — your choice 'ship' was not recorded. Guard step 'only_if_shipping' aborted the run.",
  "run_phase": "aborted",
  "guards": [{ "step": "only_if_shipping", "outcome": "abort" }],
  "ended_by": { "arm": "guard_abort", "step": "only_if_shipping", "reason": "The order was held." },
  "answer_recorded": false
}
```

Which replies carry `answer_recorded: false`:

| The gate declared           | The expiry was carried out by | `answer_recorded: false`                            | `guards`                              |
| --------------------------- | ----------------------------- | --------------------------------------------------- | ------------------------------------- |
| `on_expiry: settle_default` | This answer                   | Yes                                                 | Those the expiry's write decided      |
| `on_expiry: settle_default` | An earlier call               | Yes                                                 | None. The earlier call reported them. |
| `on_expiry: abort`          | This answer                   | Yes                                                 | None                                  |
| `on_expiry: abort`          | An earlier call               | No. The reply is the refusal every ended run gives. | None                                  |

A person's own answer sent a second time never carries the field.

## `get_run_state`

| Parameter       | Type    | Required | Holds                                                                                |
| --------------- | ------- | -------- | ------------------------------------------------------------------------------------ |
| `run_id`        | text    | Yes      | The run.                                                                             |
| `include_steps` | boolean | No       | Adds each step's attempts and what the model calls cost. Added after version 0.45.0. |

The reply has its own shape. See [Run state and health findings](run-state-and-health.md).

## `abandon_run`

| Parameter | Type | Required | Holds                                                             |
| --------- | ---- | -------- | ----------------------------------------------------------------- |
| `run_id`  | text | Yes      | The run.                                                          |
| `reason`  | text | No       | Recorded as the run's cause. Default `Abandoned via abandon_run`. |

```json
{
  "run_id": "ea72cd83-3bbe-4da9-a71b-1ccfe0ab950d",
  "run_phase": "abandoned",
  "terminal_state": true,
  "terminal_reason": "Ticket withdrawn.",
  "note": "abandon is a kill — declared finalizers (if any) did NOT run and will not for this run. The graceful path is the workflow's own guard step (abort_unless), which runs them; there is no operator abort command."
}
```

Called again on the same run, it replies in the same way, and `note` begins `already abandoned (no change this call).`

A run that is waiting at a gate is refused with `error_code: "STATE_TRANSITION_DENIED"`:

```text
Run '7da561ee-…' is waiting on human gate 'draft' (gate '00bb04f5-…'); answer it before abandoning. Answer it: submit_human_response {run_id: '7da561ee-…', gate_id: '00bb04f5-…', choice: <one of: send, discard>}.
```

## `create_workflow`

| Parameter  | Type   | Required | Holds                                                        |
| ---------- | ------ | -------- | ------------------------------------------------------------ |
| `steps`    | list   | Yes      | The steps, at least one.                                     |
| `metadata` | object | No       | `name`, `description`, `task_description`, `model`, `agent`. |

Each step takes:

| Field                 | Type   | Required | Holds                                  |
| --------------------- | ------ | -------- | -------------------------------------- |
| `id`                  | text   | Yes      | The step's name.                       |
| `description`         | text   | Yes      | What the step is for.                  |
| `depends_on`          | list   | No       | The steps that must complete first.    |
| `input_schema`        | object | No       | The schema the step's answer must fit. |
| `llm_timeout_seconds` | number | No       | As in a workflow file.                 |
| `structured_output`   | text   | No       | As in a workflow file.                 |

It registers the workflow under an ID it makes up, starts a run, and replies as `start_run` does, with the new ID in `data`:

```json
{
  "command": "create_workflow",
  "run_id": "05ae1756-2fe6-4152-91d1-e1ce1c381083",
  "status": "ok",
  "data": { "workflow_id": "release-notes-88c897726fbda006" },
  "context_hint": "Run '05ae1756-2fe6-4152-91d1-e1ce1c381083' created for workflow 'release-notes-88c897726fbda006'.",
  "run_phase": "running",
  "deduped": false,
  "next_actions": ["…"],
  "diagnostics": []
}
```

Fields it does not take are left out, and named in `warnings` and `diagnostics`. See [Workflows an assistant creates](../../guides/agent-created-workflows.md).

## `append_trace`

| Parameter      | Type | Required | Holds                                                               |
| -------------- | ---- | -------- | ------------------------------------------------------------------- |
| `run_id`       | text | Yes      | The run.                                                            |
| `step_id`      | text | Yes      | The agent step the notes are about. It must not yet have been done. |
| `entries`      | list | Yes      | The trace entries.                                                  |
| `writer_nonce` | text | No       | An identifier for this attempt of the step.                         |

Each entry takes:

| Field       | Type   | Required | Holds                                                             |
| ----------- | ------ | -------- | ----------------------------------------------------------------- |
| `event`     | text   | Yes      | A name for what happened.                                         |
| `timestamp` | text   | No       | When.                                                             |
| `data`      | object | No       | Details. Each value is text, a number, `true`, `false` or `null`. |

Any other field of an entry is dropped.

The entries are kept until `execute_step` is called for the step, and are then recorded with it. The reply counts what is being kept, against the limits:

```json
{
  "status": "ok",
  "buffer_count": 1,
  "buffer_bytes": 57,
  "limit_count": 200,
  "limit_bytes": 102400,
  "final_limit_entries": 100,
  "final_limit_bytes": 51200,
  "file_count": 1,
  "file_bytes": 57,
  "file_limit_count": 400,
  "file_limit_bytes": 204800
}
```

| Refusal                       | `error_code`              | Message                                       |
| ----------------------------- | ------------------------- | --------------------------------------------- |
| The step has been done        | `STATE_STEP_NOT_ELIGIBLE` | `Step 'classify' has already completed.`      |
| The workflow has no such step | `STEP_NOT_FOUND`          | `Step 'nope' not found in workflow 'triage'.` |

## See also

- [Run state and health findings](run-state-and-health.md)
- [Error codes](../error-codes.md)
- [Connect an MCP client](../../guides/connect-an-mcp-client.md)
- [`realm mcp` and `realm serve`](../cli/realm-mcp-and-serve.md)
