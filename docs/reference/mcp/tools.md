# MCP tools

<!-- description: The tools of Realm's MCP server, which an AI assistant calls to find a workflow, start a run, do its steps and read its state, with parameters and replies. -->

Realm's MCP server has 11 tools. An AI assistant calls them to find a workflow, start a run, do its steps and read its state. This page gives each tool's parameters and its reply. The tools and their parameters were read from the server's own `tools/list` reply, and every reply shown came from a call.

| Tool                                              | What it does                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`list_workflows`](#list_workflows)               | Lists the registered workflows.                                              |
| [`get_workflow_protocol`](#get_workflow_protocol) | Describes one workflow's steps and the rules for running it.                 |
| [`start_run`](#start_run)                         | Starts a run.                                                                |
| [`start_run_batch`](#start_run_batch)             | Starts several runs of one workflow.                                         |
| [`execute_step`](#execute_step)                   | Does one step, with the assistant's answer.                                  |
| [`submit_human_response`](#submit_human_response) | Passes on a person's choice at a gate.                                       |
| [`advance_run`](#advance_run)                     | Runs the guards and automatic steps a run owes (added after version 0.46.0). |
| [`get_run_state`](#get_run_state)                 | Returns where a run stands.                                                  |
| [`abandon_run`](#abandon_run)                     | Ends an open run.                                                            |
| [`create_workflow`](#create_workflow)             | Makes a workflow from a list of steps and starts a run of it.                |
| [`append_trace`](#append_trace)                   | Records notes about a step before the step is done.                          |

To connect an assistant, see [Connect an MCP client](../../guides/connect-an-mcp-client.md).

## Calling a tool

- **A required parameter that is missing, or a value of the wrong type, is refused by the MCP layer.** The call is marked as an error and its text is, for example, `MCP error -32602: Input validation error: Invalid arguments for tool execute_step: Required at command`.
- **A parameter the tool does not have is ignored, without a warning.** A `start_run` call with `idempotencyKey` in place of `idempotency_key` started a run with no key. `create_workflow` is the exception: it names what it ignored.
- **Every other refusal is an ordinary reply** with `status: "error"`, described next.

## The reply

`start_run`, `execute_step`, `submit_human_response` and `create_workflow` reply with one JSON object of the same shape. The other tools use that shape when they refuse a call. The examples on this page leave out fields that are empty, and show a long `next_actions` list as `"…"`.

| Field                                                   | Always present                                                                                                                                                    | Holds                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`                                               | Yes                                                                                                                                                               | The tool, or for `execute_step` and `submit_human_response` the step.                                                                                                                                                      |
| `run_id`                                                | Yes                                                                                                                                                               | The run. Empty when no run exists.                                                                                                                                                                                         |
| `run_version`                                           | Yes                                                                                                                                                               | A number that rises each time the run is changed.                                                                                                                                                                          |
| `status`                                                | Yes                                                                                                                                                               | `ok`, `error`, `blocked` or `confirm_required`. See below.                                                                                                                                                                 |
| `context_hint`                                          | Yes                                                                                                                                                               | One sentence about what has just happened.                                                                                                                                                                                 |
| `next_actions`                                          | Yes                                                                                                                                                               | The calls that can be made next. Empty when the run has ended, is waiting, or cannot go on.                                                                                                                                |
| `warnings`, `errors`                                    | Yes                                                                                                                                                               | Lists of messages.                                                                                                                                                                                                         |
| `data`, `evidence`                                      | Yes                                                                                                                                                               | Empty in MCP replies, except that `create_workflow` puts the new `workflow_id` in `data`. Read the run with `get_run_state`.                                                                                               |
| `run_phase`                                             | With a run                                                                                                                                                        | The run's phase after the call.                                                                                                                                                                                            |
| `error_code`                                            | On an error                                                                                                                                                       | A code such as `VALIDATION_INPUT_SCHEMA`. See [Error codes](../error-codes.md).                                                                                                                                            |
| `error_details`                                         | On some errors                                                                                                                                                    | Details that depend on the code, such as the schema rules that were broken.                                                                                                                                                |
| `agent_action`                                          | On an error or a block                                                                                                                                            | What the caller should do. See below.                                                                                                                                                                                      |
| `retry_after`                                           | With `wait_and_proceed`                                                                                                                                           | How many seconds to wait.                                                                                                                                                                                                  |
| `blocked_reason`                                        | With `blocked`                                                                                                                                                    | `eligible_steps`, the steps that can be called, and a `suggestion`.                                                                                                                                                        |
| `gate`                                                  | With `confirm_required`                                                                                                                                           | The open gate: `gate_id`, `step_name`, `preview`, `choices`, and when set `display`, `agent_hint`, `expires_at`, and `claim_token` when the store gave one. See [The claim token](#the-claim-token).                       |
| `deduped`                                               | From `start_run` and `create_workflow`                                                                                                                            | `true` if an existing run was returned in place of a new one.                                                                                                                                                              |
| `chained_auto_steps`                                    | When `auto` or `guard` steps ran in the call                                                                                                                      | Each such step that finished, and the run's phase after it. A step that stopped the call is not listed: it is in `stopped_step`. From `start_run`, `execute_step` and `advance_run` (added after version 0.46.0).          |
| `stopped_step`                                          | From `execute_step`, `start_run` and `advance_run` (added after version 0.46.0), on an `error`, `blocked` or `confirm_required` reply that a step's call produced | The step the call stopped at. When it is not the step you called, the step you called finished and the engine then went on to this one. From `start_run`, the `auto` step the call stopped at. Added after version 0.45.0. |
| `guards`                                                | When the call's write decided guard steps                                                                                                                         | Each guard and its `outcome`: `pass`, `abort` or `resolution_error`. See [Guards in a reply](#guards-in-a-reply).                                                                                                          |
| `ended_by`                                              | When one of those guards ended the run                                                                                                                            | `arm`, the guard's `step`, and a `reason` when there is one.                                                                                                                                                               |
| `answer_recorded`                                       | From `submit_human_response`, for an answer that came after the gate's time was up                                                                                | `false`. It is never `true`: an answer that was recorded leaves the field out.                                                                                                                                             |
| `gate_claim`                                            | From `submit_human_response`, on every `ok` reply                                                                                                                 | Whether the answer came from the conversation that opened the question: `proof`, a `cause` for two of its values, and `opened_by`. See [The claim token](#the-claim-token).                                                |
| `adopted_own`, `adopted_anonymous`, `preserved_foreign` | From `execute_step` on an agent step                                                                                                                              | How many trace entries sent with `append_trace` were attached to the step.                                                                                                                                                 |
| `settled_by_default`, `defaulted_steps`                 | When a step was given its default output                                                                                                                          | See [Agent-step controls](../workflow/agent-step-controls.md#validation_exhaustion).                                                                                                                                       |
| `diagnostics`                                           | From `create_workflow`                                                                                                                                            | What was ignored in the request, as a list.                                                                                                                                                                                |

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

It creates the run, then runs every `auto` step that is ready, and replies when the run reaches a step for the assistant, a gate, or its end. When no step ran, the reply's `context_hint` says what comes next after `Run '<id>' created for workflow '<workflow>'.`: the steps ready for the assistant, the work owed to the engine, and each step that cannot run (`'<step>' cannot run (<check>): <why>.`) — an `auto` step, or an agent step refused before its claim for a failed precondition or an invalid `trust`, which is never offered in `next_actions` (agent steps added after version 0.46.0). When the new run cannot go on until its workflow is corrected — its only owed steps are refused before their claim and nothing else is ready — the hint ends with the way out: `Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.` When the step it attempts needs a handler or adapter this server lacks, the reply is still the one that created the run (`status: ok`): its `context_hint` names the step (`'<step>' cannot run here (capability): handler '<name>' is not registered here — load the missing extension, or run the step on a runner that has it.`), and the block's own message (`Step '<step>' is blocked: …`) is in `warnings`, in place of that step's pre-flight warning (`… If reached it will block …`): the step was reached. A pre-flight warning for a step not reached stays. A step that fails is returned as the error it is. A repeat matched by `idempotency_key` runs nothing: its `context_hint` opens `Matched existing run '<id>' (idempotent) in phase '<phase>'; no new run created.` and then says what comes next for that run in the same words, the way out included. The sentences after the first in this paragraph were added after version 0.46.0, whose hint ends at `created for workflow '<workflow>'.` and which replies `status: error` for a step this server lacks the code for.

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
  "context_hint": "Run '7da561ee-5987-497d-83a5-1eded6dc9b63' created for workflow 'triage'. Ready for the agent: 'classify'.",
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

Every item is checked before any run is created. It creates the runs and runs no step, not even an `auto` step that is ready: each run waits for its first `execute_step` call or for a driver. Each entry's `next_actions` names its run's first call, and its `context_hint` is the sentence `start_run`'s reply carries for a run on which nothing ran: `Run '<id>' created for workflow '<workflow>'.` (or `Matched existing run …` for a repeat), then what comes next — the steps ready for the assistant, the work owed to the engine, each `auto` step that cannot run and, when the run cannot go on until its workflow is corrected, the way out (`Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.`). Added after version 0.46.0.

```json
{
  "started": [
    {
      "run_id": "2f22727f-1709-4a9d-8f04-a325cbee6c59",
      "idempotency_key": "ticket-201",
      "params": { "ticket": 201 },
      "deduped": false,
      "run_phase": "running",
      "warnings": [],
      "next_actions": ["…"],
      "context_hint": "Run '2f22727f-1709-4a9d-8f04-a325cbee6c59' created for workflow 'triage'. Ready for the agent: 'classify'."
    },
    {
      "run_id": "98d5e6f1-e0f7-4609-8907-de70a11b3e62",
      "params": { "ticket": 202 },
      "deduped": false,
      "run_phase": "running",
      "warnings": [],
      "next_actions": ["…"],
      "context_hint": "Run '98d5e6f1-e0f7-4609-8907-de70a11b3e62' created for workflow 'triage'. Ready for the agent: 'classify'."
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

When the reply's `stopped_step` names a step other than the one you called, the reply's `status`, `errors`, `error_code` and `agent_action` are that step's, while `command` still names the step you called. The step you called finished and its answer was recorded, so do not send it again.

A step called by name that the engine refuses before its claim, for a failed precondition or an invalid `trust` — an `auto` step, or an agent step (added after version 0.46.0) — returns that refusal; when nothing else can run, its `context_hint` ends with the way out: `Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.` An input its schema refuses is the caller's own input, and that reply is unchanged. Added after version 0.46.0.

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

| Parameter      | Type | Required | Holds                                                                                                                                |
| -------------- | ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `run_id`       | text | Yes      | The run.                                                                                                                             |
| `gate_id`      | text | Yes      | The open gate's ID, from `gate.gate_id`.                                                                                             |
| `choice`       | text | Yes      | One of the gate's choices.                                                                                                           |
| `responded_by` | text | No       | Who made the choice, as the caller states it. Not verified. At most 200 characters, no control characters. Recorded with the answer. |
| `claim_token`  | text | No       | The value from `gate.claim_token` on the reply that opened this question. Never required.                                            |

```json
{
  "command": "draft",
  "run_id": "7da561ee-5987-497d-83a5-1eded6dc9b63",
  "run_version": 6,
  "status": "ok",
  "context_hint": "Gate 'draft' resolved with choice 'send'. Owed to the engine: 'send' — call advance_run.",
  "run_phase": "running",
  "next_actions": ["…"]
}
```

`Owed to the engine: …` was added after version 0.46.0, which says `0 step(s) now available.` there.

| Refusal                                                                         | `error_code`               | Message                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The choice is not offered                                                       | `VALIDATION_INPUT_SCHEMA`  | `Choice 'maybe' is not valid. Expected one of: send, discard`                                                                                                                                                               |
| The gate ID is not the open gate                                                | `STATE_BLOCKED`            | `Gate 'x' is not the open gate and matches no committed resolution.`                                                                                                                                                        |
| `responded_by` is empty, longer than 200 characters, or has a control character | `VALIDATION_ACTOR_INVALID` | `responded_by: empty; nothing was recorded. Give a name of at most 200 characters with no control characters, or leave it out.` The middle word is `empty`, `longer than 200 characters` or `contains a control character`. |

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

**An answer after the gate's time is up** is not recorded. The call carries out the expiry first. For a gate that settles its default choice, the reply has `answer_recorded: false`, the guards that the expiry's write decided, and a `context_hint` that is the expiry's sentence. When one of those guards ended the run, the guard's sentence follows it. An answer that names the settled choice gets `status: ok`:

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

The examples above leave out `gate_claim` and the `warnings` that go with it. [The claim token](#the-claim-token) describes both.

An argument that this tool does not take is named in `warnings`, with the nearest argument it has when there is one: `claimToken` and `token` are answered with `did you mean 'claim_token'?`. Up to version 0.45.0 such an argument was dropped without a word, and an answer that sent `claimToken` read as one with no token. The other tools still drop unknown arguments without saying so.

### The claim token

`claim_token`, `gate_claim` and the argument warning were added after version 0.45.0.

The reply that opens a gate carries `gate.claim_token`: the token of the claim that the opening call made on the gate's step. The same value is in both forms of the answer instruction, `instruction.params.claim_token` and `instruction.call_with.claim_token`, and the instruction's `human_readable` text says to pass it back. When the store gave no token, the field and the sentence are left out. That reply is the only one that carries it. `get_run_state`, `realm run inspect` and every refusal leave it out. A bundle made by `realm run export` is a copy of the run's record, and it carries the claim's token.

Pass it back as `claim_token` when you answer. It shows that the answer comes from the conversation that opened the question. It is not a secret: anyone who can read the run store can read it, and Realm cannot tell callers apart. It guards against mistakes and races, not against a caller who means harm. It is never required, and it never decides whether the answer is recorded. The answer is decided by the gate ID alone. An empty `claim_token` is accepted, and counts as a wrong one.

Every `ok` reply to `submit_human_response` has `gate_claim`, including a reply with `answer_recorded: false`. A refused answer has none. `gate_claim` says only what the token showed; whether the answer was recorded is `answer_recorded`.

```json
"gate_claim": {
  "proof": "matched",
  "opened_by": { "by": "ops@server-1", "by_source": "derived", "channel": "mcp-stdio" }
}
```

| `proof`        | Means                                                                             | `cause`                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `matched`      | The `claim_token` passed is the one that was handed out when the question opened. |                                                                                                                                                                    |
| `absent`       | No `claim_token` was passed.                                                      |                                                                                                                                                                    |
| `mismatch`     | One was passed, and it is not this question's.                                    |                                                                                                                                                                    |
| `unverifiable` | There was nothing to check it against.                                            | `no_claim` (the gate's step has no claim on the record), `claim_has_no_token` (its claim has no token) or `store_keeps_no_claims` (the run store keeps no claims). |
| `spent`        | The question had already been settled before this call.                           | `answered` (by an earlier answer) or `expired` (by its time running out).                                                                                          |

The same word is stored on the answer's entry in the run's record as `claim_proof`. The reply and the record carry the same verdict. It is decided once, inside the write that records the answer.

`opened_by` names the program through which the question was opened, not anyone who is working on it now. It holds `by` (the name), `by_source` (how the name is known: `stated`, `ambient` for the `REALM_OPERATOR` variable, or `derived` for the OS user and host name) and `channel` (the door: `mcp-stdio`, `mcp-http`, `agent`, `run`). When there is no name it is `{ "by": null, "absent_cause": … }`, with the word saying why: `holder_not_recorded` (the claim has no name), `pre_lease_claim` (the claim has neither a name nor `since`: it was made before those fields existed), `no_claim`, `store_keeps_no_claims`, `driver_not_recorded` (the step's entry has no name) or `name_unreadable` (a name is stored, and it is not one that can be shown).

Unless the proof is `matched`, or is `spent` with no token passed, the reply also has one sentence in `warnings` about it. For `absent`: `No claim_token was passed; the answer was recorded. Only the conversation that opened the question has one to pass.` On a reply with `answer_recorded: false` the sentence is the token fact alone (for `absent`: `No claim_token was passed.`): the expiry's own sentence and `answer_recorded` already say that the answer was not recorded.

## `get_run_state`

| Parameter       | Type    | Required | Holds                                                                                |
| --------------- | ------- | -------- | ------------------------------------------------------------------------------------ |
| `run_id`        | text    | Yes      | The run.                                                                             |
| `include_steps` | boolean | No       | Adds each step's attempts and what the model calls cost. Added after version 0.45.0. |

The reply has its own shape. See [Run state and health findings](run-state-and-health.md). An agent step the run refuses before its claim (a failed precondition, an invalid `trust`) is listed in `agent_refused`, never in `next_actions` (added after version 0.46.0).

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
  "context_hint": "Run '05ae1756-2fe6-4152-91d1-e1ce1c381083' created for workflow 'release-notes-88c897726fbda006'. Ready for the agent: 'collect'.",
  "run_phase": "running",
  "deduped": false,
  "next_actions": ["…"],
  "diagnostics": []
}
```

`Ready for the agent: …` was added after version 0.46.0, whose hint ends at `created for workflow '<workflow>'.`

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

## advance_run

Added after version 0.46.0. Runs the guards and `auto` steps a run owes, in the environment of the server that receives the call (its extensions, its environment variables). Call it when `next_actions` names it: every reply and `get_run_state` end `next_actions` with this act whenever engine work is owed and nobody is running it — after a gate is answered, after an expiry settles a default, after `resume`, and for a run `start_run_batch` created.

| Parameter | Type   | Required | Meaning  |
| --------- | ------ | -------- | -------- |
| `run_id`  | string | yes      | The run. |

The reply has the same shape as a step's: `chained_auto_steps` lists what ran, `guards` and `ended_by` what a guard settled, and when a step opens a question the reply is `confirm_required` with the gate. It also carries `continued_by`: the name of the program that ran the steps (`{ by: null, absent_cause: 'driver_not_recorded' }` when the host passed none). A call with nothing owed runs nothing and returns the run's view — never an error. Its `context_hint` says why: `Run '<id>': nothing ran.`, then the agent steps that are ready, the work still owed, and each step that cannot run (`'<step>' cannot run (<check>): <why>.`, or `cannot run here (capability)` for a handler or adapter this server lacks, ending `— load the missing extension, or run the step on a runner that has it` — or `could not run (capability)`, in the past tense, from a caller that passes no extensions, which judges by the run's record); `No step is ready.` only when none of these holds. When the run cannot go on until its workflow is corrected — every owed step is refused before its claim (an invalid `trust`, a failed precondition, an input its schema refuses) and nothing else is ready — the hint ends with the way out: `Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.` Every reply that says what comes next ends with the same way out under the same condition: a step's reply, an answer's reply, `start_run`'s creation reply and this one. A step another process holds when this call tries to claim it is not run here, and the reply's `context_hint` ends with `'<step>' was claimed by another process, so it did not run here.` A step that cannot run (an invalid `trust`, a failed precondition, an input its schema refuses — the refusal names the field and what it must be, or the property the schema does not allow: `'<property>' is not allowed`) or cannot run here (a handler or adapter this server lacks) is not run; `get_run_state`'s `engine_runnable` names it and why, and the act is no longer offered for it. A handler or adapter that is not registered is attempted once, after every other owed step, so the run records which one is missing; that reply is an error, and its `next_actions` no longer offer the act for that step. An unknown argument is named in `warnings` (`advance_run: unknown argument 'x' was ignored.`).

The act in `next_actions` reads:

```json
{
  "instruction": {
    "tool": "advance_run",
    "params": { "run_id": "<run>" },
    "call_with": { "run_id": "<run>" }
  },
  "human_readable": "Call advance_run to run the step the engine owes: 'post_approval'. It runs it with this server's extensions and environment.",
  "orientation": "Run is active. Engine work is owed: 'post_approval'."
}
```

It is always LAST: `next_actions[0]` stays the agent step when one is ready.

## See also

- [Run state and health findings](run-state-and-health.md)
- [Error codes](../error-codes.md)
- [Connect an MCP client](../../guides/connect-an-mcp-client.md)
- [`realm mcp` and `realm serve`](../cli/realm-mcp-and-serve.md)
