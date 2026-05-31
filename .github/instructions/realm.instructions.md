---
applyTo: '**'
---

# Realm Workflows

Realm is a workflow execution engine accessible via MCP. When a user asks you to run a Realm
workflow — or triggers one by name — follow this protocol.

## Setup Check

Before starting, confirm the Realm MCP server is connected:

- Open the Chat view and verify the Realm tools appear in the tool list.
- If not, run **MCP: List Servers** from the Command Palette, start the server, then open a new
  chat session.

## Protocol

### 1. Discover registered workflows

Call `list_workflows` to see all registered workflows and their IDs. Match the user's request to
a workflow ID from the results. If two workflows could fit, ask the user which one they want.

### 2. Get the workflow protocol

Call `get_workflow_protocol` with the matched `workflow_id`. This returns a full briefing: what
each step does, what you must execute, what the engine handles automatically, and the input schema
for each agent step. Read it before calling `start_run`.

### 3. Start the run

Call `start_run` with `workflow_id` and any required `params` (check `params_schema` in the
protocol). The engine may auto-chain through initial auto steps and return the first agent step
immediately.

### 4. Execute agent steps

`next_actions` is an array. For linear workflows it contains a single item; for parallel
batches it contains multiple. Always check the length before deciding how to proceed.

For **each item** in `next_actions`:

Read `prompt` first — that is your complete task for this step. It is resolved from the
workflow's step definition at runtime and supersedes any static instructions you may have
about this workflow. `prompt` is optional; when absent, use `human_readable` instead — it is
always present and gives an equivalent agent-facing task description. `context_hint` describes
what just happened and the current run state — read it on every response, including errors.

Call the tool named in `instruction.tool` using `instruction.call_with` as the ready-to-use
argument template. For ordinary agent steps this is `execute_step`, but for handler steps it
will be the handler's own tool name — always use the value from the response, never hardcode
`execute_step`.

The `call_with` object is pre-populated with placeholders:

- When `input_schema` is present, `call_with.params` is already a skeleton object with the correct
  field names and type-appropriate defaults — fill in the values, do not reconstruct the shape.
- Enum fields appear as `<value1|value2|value3>` — replace with one of the listed values.
- Scalar fields appear as `0` or `""` — replace with your actual value.
- Arrays appear as `[]` — populate with your items.

`orientation` describes the current state and what step comes next (distinct from `context_hint`,
which describes what just happened).

If `expected_timeout` is set, the step has a declared timeout — complete within the indicated
time (e.g. `"30s"`).

### 4a. Parallel execution strategy

When `next_actions` contains multiple items, choose a strategy based on step complexity:

- **Inline sequential:** execute all eligible steps yourself, one after another in this session.
  Use for lightweight steps — no `agent_profile`, no `prompt`, short expected output, no declared
  `expected_timeout`. Fast and avoids subagent overhead.

- **Subagent fan-out:** spawn one subagent per eligible step for steps that have an `agent_profile`,
  a substantial `prompt`, or a declared `expected_timeout`. True parallelism. Collect all subagent
  results before proceeding.

- **Mixed:** execute lightweight steps inline, spawn subagents for heavyweight steps. Valid within
  the same batch.

### 4b. Gate escalation from subagent

If `execute_step` returns `status: confirm_required` inside a subagent session, do not attempt to
resolve the gate. Stop execution of your branch. Return the full gate object (`gate_id`, `display`,
`preview`, `choices`) to the orchestrating agent as your result. The orchestrating agent presents
`gate.display` to the human, collects their choice from `gate.response_spec.choices`, and calls
`submit_human_response`. After that resolves, the orchestrating agent determines whether to resume
the original subagent session or spawn a new one for the remaining steps in that branch.

### 5. Repeat until done

Repeat from step 4 until:

- `status` is `confirm_required` — a human gate is open; handle it in step 6, then continue.
- `status` is `ok` and `next_actions` is empty — the workflow has finished. No further steps exist.

### 5a. Reading `chained_auto_steps`

When `start_run`, `execute_step`, or `submit_human_response` triggers auto steps before returning,
`chained_auto_steps` records each one in order. The field is omitted entirely when no auto steps
ran — only present when the array would be non-empty:

```json
"chained_auto_steps": [
  { "step": "validate_fields", "run_phase": "running" },
  { "step": "route_result", "run_phase": "running", "branched_via": "one_failed" }
]
```

`branched_via` is present when a DAG transition fired (e.g. the engine selected a particular
trigger-rule branch). Use it to understand which path the engine took before returning to you.

### 5b. `status: ok` with warnings — recovery step executed

**`status: ok` does not guarantee the original step succeeded.** When a step fails and a recovery
step runs via `trigger_rule: one_failed`, the engine demotes the failure to a `warnings[]` entry
and returns `status: ok`. Always check `warnings` on `ok` responses — a non-empty array means a
recovery path was taken, and `context_hint` will describe what happened.

### 6. Human gate (`status: confirm_required`)

1. Read `gate.agent_hint` for instructions on how to present the gate (if set).
2. Present `gate.display` to the user verbatim. `gate.display` is resolved from `gate.message`
   if the workflow configured one; otherwise it falls back to the step's `prompt`. If `gate.display`
   is absent, construct a prompt from `gate.preview` — the step output awaiting human review.
3. Collect the user's choice from `gate.response_spec.choices`.
4. Call `submit_human_response` using `next_actions[0].instruction.call_with` with:
   - `gate_id` from `gate.gate_id` (required — distinct from `run_id`)
   - `choice` set to the user's selected value from `gate.response_spec.choices`
5. After `submit_human_response` returns, check `chained_auto_steps` — the gate response may
   chain through additional auto steps before returning the next agent step. The final state is
   always reflected in `next_actions`.

## Checking Run State

If you lose track of a run's current state (e.g. after an error or session gap), call
`get_run_state` with the `run_id`. It returns the current state name, whether the run is
terminal, the pending gate if any, and how many evidence entries exist. Use it to orient
yourself before deciding the next tool call — do not guess the state.

## Error and Blocked Responses

Every `status: 'error'` and `status: 'blocked'` response carries `agent_action` that tells you
what to do next. Do not parse the `errors` text to decide recovery strategy — use `agent_action`.

| `agent_action`         | Meaning                                                                                                                                                                                                                                         | What to do                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stop`                 | The run is terminal or has failed unrecoverably.                                                                                                                                                                                                | Do not retry. Report to user.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `report_to_user`       | Engine state is inconsistent (e.g. version conflict).                                                                                                                                                                                           | Surface to user. Do not retry autonomously.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `provide_input`        | The params you submitted were invalid.                                                                                                                                                                                                          | Fix the params and retry `execute_step` with the same command. `next_actions[0]` shows the correct tool call.                                                                                                                                                                                                                                                                                                                                                                     |
| `resolve_precondition` | Step not eligible for the current run state.                                                                                                                                                                                                    | Follow `next_actions[0]` if non-empty to call an eligible step instead.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `wait_for_human`       | An external service is unavailable (network down, upstream 5xx). The run cannot continue until the dependency recovers.                                                                                                                         | Show the error to the user and wait for them to confirm the issue is resolved before retrying.                                                                                                                                                                                                                                                                                                                                                                                    |
| `wait_and_proceed`     | The step was rate-limited by an upstream service. `retry_after` in the response gives the delay in seconds. This action appears only when the step has no engine-level `retry` config; when retry is configured, the engine retries internally. | Wait `retry_after` seconds, then follow `next_actions` without human involvement. The step has already failed — do not call `execute_step` for the same command again; follow `next_actions` instead. When a step with `retry` config exhausts all attempts due to rate limiting, the action is `report_to_user` (`STEP_RETRY_EXHAUSTED`); `details.retry_after` carries the last observed Retry-After value for scheduling purposes but does not drive automatic wait behaviour. |

When `agent_action` is `provide_input` or `resolve_precondition` and `next_actions` is non-empty,
follow the first item exactly as you would after a successful step. When `next_actions` is empty,
surface `blocked_reason.suggestion` to the user — it names the failed precondition or explains why
no valid next step exists.

### Precondition failures

When a step's preconditions are not met, the response is `status: blocked`, `agent_action: stop`,
`next_actions` is empty. The `blocked_reason.suggestion` field names which precondition expression
failed and its resolved value. You cannot recover autonomously — report to the user.
