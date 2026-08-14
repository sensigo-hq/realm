# YAML Schema Reference

Complete reference for `workflow.yaml` fields. Every field documented here is validated at `realm workflow register` time — errors include the field name and expected type.

An unrecognized top-level or step key (a typo, or a field from a removed feature) is never a hard
error — it's dropped and a warning is printed, e.g. `⚠ step 'sync_data': unknown key 'dependson' —
ignored (did you mean 'depends_on'?)`, with the **did-you-mean** suggestion appearing only when
the key is a close match of a real one. `realm workflow validate --strict` (or `register --strict`)
turns these warnings into a failure, for CI. A future major version will hard-reject unrecognized
keys outright (tracked in [issue #170](https://github.com/sensigo-hq/realm/issues/170)) — until
then, leaving one in place while you fix it is safe.

---

## Top-level fields

| Field              | Type               | Required | Description                                                                                                                                                                                                                                                                                                          |
| ------------------ | ------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | string             | Yes      | Unique workflow identifier. Used in all CLI commands and MCP tool calls.                                                                                                                                                                                                                                             |
| `name`             | string             | Yes      | Human-readable workflow name.                                                                                                                                                                                                                                                                                        |
| `description`      | string             | No       | Declarative statement of what this workflow is for / when to use it — distinct from `protocol.quick_start` (imperative "how to begin"). Surfaced in the agent protocol (`get_workflow_protocol`) and echoed by `realm workflow validate`/`register`. No synthesized default: absent means omitted, never fabricated. |
| `version`          | integer            | Yes      | Workflow version number. Incremented on each `realm workflow register`.                                                                                                                                                                                                                                              |
| `params_schema`    | object             | No       | JSON Schema for the params accepted by `start_run`. The agent's `call_with.params` skeleton is derived from this at runtime.                                                                                                                                                                                         |
| `services`         | object             | No       | Named service definitions. Referenced by steps via `uses_service`.                                                                                                                                                                                                                                                   |
| `steps`            | object             | Yes      | Map of step name → step definition.                                                                                                                                                                                                                                                                                  |
| `protocol`         | object             | No       | Optional protocol customisations. See [Protocol](#protocol-customisation).                                                                                                                                                                                                                                           |
| `profiles_dir`     | string             | No       | Path to agent profile files, relative to the workflow YAML. Defaults to `profiles/` in the same directory.                                                                                                                                                                                                           |
| `workflow_context` | object             | No       | Named file entries loaded once at run start and available in all step prompts. See [Workflow context](#workflow-context).                                                                                                                                                                                            |
| `context_wrapper`  | string             | No       | Wrapper format applied to `{{ workflow.context.NAME }}` references. One of `xml` (default), `brackets`, `none`.                                                                                                                                                                                                      |
| `mcp_servers`      | array              | No       | External MCP server definitions. Steps reference these via `tools`. See [MCP servers](#mcp-servers).                                                                                                                                                                                                                 |
| `trigger`          | object             | No       | Webhook trigger. When set, `realm listen` routes inbound webhooks to this workflow. See [Webhook trigger](#webhook-trigger).                                                                                                                                                                                         |
| `extensions`       | string \| string[] | No       | Project extension module path(s), **relative to the workflow directory**. See [Project extensions](#project-extensions).                                                                                                                                                                                             |

---

## Step fields

| Field               | Type                                        | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`       | string                                      | Yes      | Human-readable step description. Appears in the agent protocol.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `execution`         | `agent` \| `auto` \| `guard` \| `finalizer` | Yes      | Who executes this step. See [Execution modes](#execution-modes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `depends_on`        | string[]                                    | No       | Step IDs this step waits for. Empty array or omitted means eligible from run start.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `trigger_rule`      | string                                      | No       | When to evaluate dependency satisfaction. Default: `all_success`. See [`trigger_rule`](#trigger_rule).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `when`              | string \| string[]                          | No       | Condition controlling step eligibility — a step is ineligible until truthy. A `string[]` is the implicit AND of its leaves. See [`when` condition](#when-condition).                                                                                                                                                                                                                                                                                                                                                                                                         |
| `uses_service`      | string                                      | No       | Name of a service declared in `services`. Only valid on `execution: auto` steps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `service_method`    | `fetch` \| `create` \| `update` \| `delete` | No       | Adapter method to call. Defaults to `fetch`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `operation`         | string                                      | No       | Operation name passed to the adapter. Defaults to the step name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `handler`           | string                                      | No       | Name of a registered `StepHandler` to invoke. Only valid on `execution: auto` steps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `config`            | object                                      | No       | Static key-value configuration passed to the handler via `context.config`, or merged into the adapter config for `uses_service` steps. Values may be any JSON value — scalars, arrays, **and nested objects**. For `uses_service` steps the adapter's `config_schema` is the validator. Only meaningful on `execution: auto` steps with a `handler` or `uses_service`.                                                                                                                                                                                                       |
| `input_schema`      | object                                      | No       | JSON Schema validated against the agent's submitted `params` before execution. Also drives the `call_with.params` skeleton returned to the agent in `next_actions`.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `output_schema`     | object                                      | No       | JSON Schema validated against the agent's submitted `params` before the engine claims the step. Only valid on `execution: agent` steps — declaring it on `execution: auto` steps is a loader error. Failed validation returns `agent_action: provide_input` and leaves the step unclaimed — immediately re-submittable without side effects.                                                                                                                                                                                                                                 |
| `structured_output` | `'strict'`                                  | No       | Opts this step into Anthropic grammar-constrained ("strict") decoding for its submit tool. Only valid on `execution: agent` steps. Rejected at load time if the step's effective schema (`output_schema ?? input_schema`) is ineligible. See [`structured_output`](#structured_output-anthropic-strict-decoding).                                                                                                                                                                                                                                                            |
| `preconditions`     | string[]                                    | No       | Boolean expressions evaluated before the step runs. See [Preconditions](#preconditions).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `trust`             | string                                      | No       | Human oversight level. See [Trust levels](#trust-levels).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `timeout_seconds`   | integer                                     | No       | Step execution timeout in seconds. On expiry the run fails with `STEP_TIMEOUT`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `retry`             | object                                      | No       | Retry configuration. See [Retry](#retry).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `instructions`      | string                                      | No       | Agent-facing instructions. Delivered as `gate.agent_hint` when a gate is open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `prompt`            | string                                      | No       | Template-resolved task prompt delivered via `next_actions[].prompt`. On human gate steps, delivered as `gate.display`. Supports `{{ context.resources.STEP.FIELD }}` and `{{ run.params.FIELD }}`.                                                                                                                                                                                                                                                                                                                                                                           |
| `gate`              | object                                      | No       | Gate configuration. `gate.choices` lists the valid human response values. `gate.message` is a developer-authored template string shown to the human reviewer. See [Gate message](#gate-message).                                                                                                                                                                                                                                                                                                                                                                             |
| `input_map`         | `Record<string, InputMapNode>`              | No       | Maps param names to values from the run context. Valid on `execution: auto` steps with either `uses_service` or `handler`. Each value is a dot-path string (`run.params.<key>` or `context.resources.<step>.<field>`), a nested object whose leaves are dot-path strings, or a `{ $literal: <value> }` node holding a constant. See [input_map values and `$literal`](#input_map-values-and-literal). Maximum nesting depth is 10. The resolved params are recorded in the evidence chain as `resolved_params` and are visible in `realm run inspect` as a `Resolved:` line. |
| `agent_profile`     | string                                      | No       | Agent profile name. Only valid on `execution: agent` steps. Must match a file in `profiles_dir`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tools`             | `string[]`                                  | No       | Tool names this step may call, in `server_id:tool_name` format. Only valid on `execution: agent` steps with an `input_schema`. References entries in `mcp_servers`. All declared names must exist in the connected server — if any name is not found after `listTools()`, the step fails immediately with `MCP_TOOL_NOT_FOUND` before any LLM call is made. If two connected servers expose the same bare tool name within a single step, the step fails immediately with `MCP_TOOL_NAME_COLLISION`.                                                                         |
| `max_tool_calls`    | integer                                     | No       | Maximum number of tool calls the agent may make in a single step execution. Must be a positive integer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `max_fan_out`       | integer                                     | No       | Maximum number of `start_run` or `start_run_batch` MCP tool calls the agent may make in a single step execution. Once this limit is reached the agent enters final-extraction mode (same as `max_tool_calls` exhaustion) — no further fan-out calls are executed, but the response is returned cleanly. Must be a positive integer.                                                                                                                                                                                                                                          |
| `tool_timeout`      | integer                                     | No       | Timeout in seconds for each individual MCP tool call. Must be a positive integer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `abort_unless`      | string \| string[]                          | No       | One or more condition expressions evaluated against prior step evidence. If any condition is false, the run is aborted with `run_phase: 'aborted'`. Only valid on `execution: guard` steps. Absent path → `GUARD_RESOLUTION_ERROR` (`run_phase: 'failed'`, not `'aborted'`). See [execution: guard](#execution-guard).                                                                                                                                                                                                                                                       |
| `abort_message`     | string                                      | No       | Human-readable message recorded in the guard step's evidence entry and in `aborted_at.abort_message` when the run aborts. Only valid on `execution: guard` steps.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `on_outcome`        | `FinalizerTrigger` \| `FinalizerTrigger[]`  | Yes\*    | Terminal trigger(s) this finalizer fires on: `complete` \| `fail` \| `abort` \| `always` \| `completed_with_failed_steps`. An array is OR-membership. Required and non-empty on `execution: finalizer` steps (\*not applicable to other execution modes). See [execution: finalizer](#execution-finalizer).                                                                                                                                                                                                                                                                  |

---

## input_map values and `$literal`

Each `input_map` value is one of:

- **A dot-path string** — resolved against run state (`run.params.<key>`, `context.resources.<step>.<field>`).
- **A nested object** — recursed into; its string leaves are resolved as dot-paths, so you can assemble a structured param from prior step evidence.
- **A `$literal` node** — `{ $literal: <value> }` passes `<value>` through **verbatim**, with no path resolution. The value may be **any JSON value**: a string, number, boolean, null, **array, or object**. `$literal` is the escape hatch for constants — including a string that happens to look like a dot-path.

```yaml
input_map:
  # Constant scalars
  table: { $literal: 'CS_Macros' }
  limit: { $literal: 30 }
  # Constant array (passed through verbatim)
  tags: { $literal: ['urgent', 'billing'] }
  # Constant object — leaves are NOT path-resolved, even if they look like paths
  options:
    $literal:
      recursive: true
      exclude: ['tmp']
      note: 'run.params.x' # stays the literal string "run.params.x"
  # Templated path resolved against run state, alongside the literals above
  ticket_id: run.params.ticket_id
```

A `$literal` node must have exactly one key (`$literal`); sibling keys are a loader error. A whole `$literal` subtree is literal — the loader does not recurse into it and the runtime returns it as-is.

**One constraint:** a **bare array** as an `input_map` node value is not allowed — wrap it in `$literal` (`tags: { $literal: ['a', 'b'] }`, not `tags: ['a', 'b']`). A bare array is ambiguous between a literal and a future templated-array feature, so it is rejected at load time.

---

## Execution modes

### `execution: agent`

The engine pauses and returns `next_actions` containing this step. The AI agent (or `realm run` in dev mode) calls `execute_step` with the step's `command` and `params`. The engine validates `params` against `input_schema` (if declared) and `output_schema` (if declared) before proceeding.

### `execution: auto`

The engine executes this step immediately without returning to the caller. If the step declares `uses_service`, the engine calls the registered adapter. If it declares `handler`, the engine calls the registered `StepHandler`. Auto steps chain automatically: after any step completes, if the next step is `auto`, the engine runs it immediately and repeats until it reaches an agent step, a human gate, or a terminal state.

#### The bare `auto` step

An `execution: auto` step may declare **none** of `uses_service`, `handler`, or a human `trust` gate. This is valid — not a loader error — and is an intentional pattern for a step whose role is purely structural: a place in the DAG, typically the run's last step, that requires no adapter/handler computation and no human review.

**What it is.** With none of `uses_service` / `handler` / `trust` set, the engine has nothing to compute for this step: no adapter is called, no handler runs, no gate opens. It is still sequenced by `depends_on` / `trigger_rule` / `when` like any other step, and it still produces an evidence entry and moves to `completed_steps` when it settles.

**What its output actually is.** Whatever value is already in flight on the underlying `execute_step` / auto-chain call becomes this step's recorded output — an empty object if it's the first thing a fresh call reaches, or, when it is auto-chained immediately after another step within the same call, **a copy of that other step's own submitted output** (one dispatcher serves an entire auto-chain hop; the engine does not solicit separate input per bare step). **Treat a bare `auto` step's own output as inconsequential — never reference it (`context.resources.<step>.*`) from a downstream step.** Its value is a byproduct of chaining, not an authored result; what matters is that the step — and with it, the run — completed.

**When to use it.** A terminal "record/checkpoint" step: the last node of the DAG, whose completion is what marks the run done, not whatever data lands in its evidence. Give it a correct `depends_on` naming its real predecessor(s) so it cannot become eligible — and therefore run — before the actual work finishes.

```yaml
steps:
  do_the_work:
    description: Perform the real work
    execution: agent
    depends_on: []

  finalize:
    description: Terminal checkpoint — no output of its own
    execution: auto
    depends_on: [do_the_work]
```

**How it differs:**

- From a **handler/adapter** step (`handler` / `uses_service` set): those have the engine compute a real, meaningful output.
- From a **gate** (`trust: human_confirmed` / `human_reviewed`): a gate pauses the run for an explicit human decision; a bare step never pauses — it settles the instant it's reached.
- From `execution: agent`: an agent step is surfaced in `next_actions` and requires an explicit `execute_step` call carrying agent-authored params; a bare `auto` step is never surfaced in `next_actions` and settles automatically as part of the auto-chain.

This is intentional, not an authoring error.

### `execution: guard`

The engine evaluates one or more boolean expressions declared in `abort_unless` against the run's current evidence. The evaluation happens inline, as part of the auto-chain — the guard is never returned to the agent as a step to execute.

- If **all** conditions are true: the guard passes, goes into `completed_steps`, and the run continues.
- If **any** condition is false: the run is aborted immediately. The guard goes into `skipped_steps`, `run_phase` becomes `'aborted'`, and `get_run_state` includes `abort_context` with the evaluated conditions. No further steps execute.
- If a path in `abort_unless` cannot be resolved (absent evidence field): the guard fails with `GUARD_RESOLUTION_ERROR`, `run_phase` becomes `'failed'`. This is an authoring error — fix the path.

All conditions are always evaluated regardless of intermediate outcomes — the evidence record is complete whether the guard passes or aborts.

Guard steps are incompatible with: `uses_service`, `handler`, `input_schema`, `output_schema`, `trust`, `agent_profile`, `trigger_rule`, `timeout_seconds`, `service_method`, `operation`, `input_map`, `tools`.

```yaml
steps:
  classify_ticket:
    description: Classify the support ticket
    execution: agent
    depends_on: []

  guard_must_be_open:
    description: Abort if the ticket is not open
    execution: guard
    depends_on: [classify_ticket]
    abort_unless:
      - "classify_ticket.status == 'open'"
    abort_message: 'Ticket is not open — aborting run.'

  route_ticket:
    description: Route the open ticket to the correct team
    execution: agent
    depends_on: [guard_must_be_open]
```

**Run phase after abort:** `'aborted'`. This is a terminal phase — aborted runs cannot be resumed. The `aborted_at` field on the run record (and `abort_context` in `get_run_state`) contains the guard step ID, all evaluated conditions, and the optional `abort_message`.

---

### `execution: finalizer`

A finalizer step runs at the run's terminal transition — a workflow-level try/catch/finally. It is never returned to the agent as work to execute; the engine dispatches it directly to a registered handler once the run seals. Declare one or more `on_outcome` triggers (below); every finalizer whose triggers match the sealing outcome runs, in declaration order, drain-ranked (a finalizer declared for BOTH a specific outcome and `always` runs once, via the specific-outcome group — never twice). Each finalizer runs **at most once per run** — a resumed/re-driven run never re-fires one that already settled. A finalizer handler's own failure (a thrown error, a timeout, or a handler returning `{ abort }`) is recorded as a **non-fatal** failure — it never mutates `aborted_at`, `terminal_reason`, `terminal_state`, or `skipped_steps`; the run's own already-sealed terminal outcome stands. An undrained finalizer (e.g. the process crashed between the terminal commit and delivery) is recoverable via `realm run drain`.

**v1 loader constraints:**

- `handler` is **required** — v1 is handler-only (no `uses_service`, no agent dispatch).
- `trust` must be absent or `'auto'` — a finalizer must not gate.
- `on_outcome` is **required and non-empty** — every value must be one of the five triggers below.

```yaml
steps:
  # ... domain steps ...

  notify_on_failure:
    description: Send an internal alert when the run doesn't complete cleanly
    execution: finalizer
    handler: slack-notify
    on_outcome: [fail, completed_with_failed_steps]
```

| `on_outcome` value            | Fires when...                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `complete`                    | The run seals `completed` (`terminal_reason: 'Workflow completed.'`) — regardless of whether any step along the way failed and was recovered around.                                                                                                                                                                                                                                                                                                                                                      |
| `fail`                        | The run seals `failed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `abort`                       | The run seals `aborted` — a guard's `abort_unless` condition was false, or a step handler returned `{ abort }`.                                                                                                                                                                                                                                                                                                                                                                                           |
| `always`                      | Any of the three seals above — a "finally" arm. A finalizer that also declares a specific outcome runs once (via that outcome's own group), never twice.                                                                                                                                                                                                                                                                                                                                                  |
| `completed_with_failed_steps` | The run seals `completed` **AND** `failed_steps` is non-empty at that seal (a designed-recovery completion — the SAME class `realm run inspect`'s `completed_with_failed_steps` run-health finding surfaces). **Fires ONLY on that specific mixed-complete shape — it does NOT fire on a clean complete, and it does not substitute for `fail`.** To cover both a pure fail seal and a mixed-complete seal with one finalizer, declare the array form: `on_outcome: [fail, completed_with_failed_steps]`. |

> **Note (mixed-complete, Airflow-style):** a workflow that recovers around a step failure via `trigger_rule` (the way Airflow's own trigger-rule DAGs route around a failed task) still reaches a `complete` seal — `fail`-triggered finalizers do NOT run for it (the run didn't fail). If you need a safety-net finalizer that also covers this recovered-but-scarred case, opt into `completed_with_failed_steps` explicitly; it is never implied by `fail` or by `complete` alone.
>
> **Second-epoch runs:** the `completed_with_failed_steps` predicate is `failed_steps.length > 0` at the seal, uniformly — it does not distinguish a failure from THIS epoch from a failure left over from an earlier one. A run that fails, has its `fail`-triggered finalizer itself fail (an unresumable step, so it stays in `failed_steps` forever), gets resumed, and then completes on its second epoch still fires `completed_with_failed_steps` — the prior epoch's scar counts. This mirrors the same uniform predicate the `completed_with_failed_steps` run-health finding already uses at read time; there is deliberately no separate mint-time rule.
>
> **`realm run abandon` never runs finalizers, in any epoch.** `abort` is the graceful terminal path and runs finalizers normally; `abandon` is an operator kill switch for a run that cannot be aborted normally, and stays a kill — declared finalizers (if any) do not run. Both the `abandon_run` MCP tool and `realm run abandon` disclose this on every successful abandon.

---

## Trust levels

| Value             | Description                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto`            | No human involvement. The engine executes and advances. Default.                                                                                     |
| `human_notified`  | The human is informed but not required to act.                                                                                                       |
| `human_confirmed` | The engine pauses and returns `status: confirm_required`. The run will not advance until `submit_human_response` is called with a valid gate choice. |
| `human_reviewed`  | The human must demonstrate review via challenge before the gate can close.                                                                           |

`trust` is only meaningful on `execution: auto` steps — an agent step already requires an explicit `execute_step` call.

---

## Step dependencies (`depends_on`)

Every step declares which steps must settle before it becomes eligible. Steps with an empty or omitted `depends_on` are eligible as soon as the run starts.

```yaml
steps:
  read_data:
    description: Load data from disk
    execution: auto
    depends_on: [] # eligible immediately
    uses_service: source
    operation: read

  analyze:
    description: Analyze the loaded data
    execution: agent
    depends_on: [read_data] # waits for read_data to complete
```

The engine evaluates `depends_on` after every step settles. A step becomes eligible when its `trigger_rule` is satisfied given the current state of its dependencies.

---

## `trigger_rule`

Controls when a step becomes eligible based on how its dependencies settled. Default: `all_success`.

| Value         | Eligible when…                                                           |
| ------------- | ------------------------------------------------------------------------ |
| `all_success` | All deps completed successfully. Skipped if any dep fails. **(default)** |
| `all_failed`  | All deps failed. Use for recovery steps.                                 |
| `all_done`    | All deps settled (completed, failed, or skipped in any combination).     |
| `one_failed`  | At least one dep failed. Use for fallback steps.                         |
| `one_success` | At least one dep completed successfully.                                 |
| `none_failed` | All deps completed or were skipped — none failed.                        |

### Recovery pattern

Use `trigger_rule: one_failed` or `all_failed` to implement error recovery:

```yaml
steps:
  extract_fields:
    description: Extract structured fields from the input
    execution: auto
    handler: extract_fields_handler
    depends_on: []

  validate_fields:
    description: Validate the extracted fields
    execution: auto
    handler: validate_fields_handler
    depends_on: [extract_fields] # runs only when extraction succeeds

  handle_extraction_error:
    description: Notify team — extraction failed
    execution: agent
    depends_on: [extract_fields]
    trigger_rule: one_failed # runs only when extraction fails
```

### Skip propagation

When a step fails (or is skipped), all downstream steps whose `trigger_rule` can no longer be satisfied are automatically moved to `skipped_steps`. For example, if `extract_fields` fails, any step with `depends_on: [extract_fields]` and the default `trigger_rule: all_success` is skipped immediately. The run terminates cleanly with `run_phase: failed` when no eligible or in-progress steps remain.

`when`-condition branches are skipped the same way: once all of a step's dependencies are settled, if the step's `when` expression evaluates to false, the engine moves it to `skipped_steps` immediately. In a mutual-exclusion pattern (two branches with opposite `when` conditions), the inactive branch is skipped as soon as the shared upstream step completes — the run closes cleanly without any finalizer step.

`skipped_steps` is included in `realm run inspect` and the `get_run_state` MCP response.

---

## `when` condition

An optional expression evaluated against prior step evidence. A step is eligible only when both its `trigger_rule` is satisfied _and_ its `when` expression is truthy:

```yaml
steps:
  classify_ticket:
    description: Classify the support ticket
    execution: agent
    depends_on: []

  handle_billing:
    description: Route billing tickets to the billing team
    execution: agent
    depends_on: [classify_ticket]
    when: "classify_ticket.category == 'billing'"

  handle_technical:
    description: Route technical tickets to engineering
    execution: agent
    depends_on: [classify_ticket]
    when: "classify_ticket.category == 'technical'"
```

`when` is `string | string[]`. A single string is one leaf; **an array is the implicit AND of its leaves** (every leaf must hold). An empty array is a load error.

```yaml
when:
  - 'extract_order.order_number_found == true'
  - 'resolve_store.store_key != null'
```

**Leaf grammar:** `<path> <op> <literal>` or a bare `<path>` (truthy test). **Supported operators:** `==`, `!=`, `>`, `<`, `>=`, `<=`. The left side is a dot-path (`step_name.field_name`, or `run.params.field`). The right side is a quoted string, an unquoted number, `true`, `false`, or `null`. The split is quote-aware — an operator inside a quoted RHS (e.g. `subject == 'a >= b'`) does not mis-split.

**Compound `and`/`or` inside a single string is rejected at load** — use the list form. The load error echoes the suggested list:

```
Step 'fetch_order': 'when' uses unsupported 'and' — write it as a list:
  when:
    - "extract_order.order_number_found == true"
    - "resolve_store.store_key != null"
```

**Reference rule (load-time):** a `when` leaf's `step.field` must reference either `run.params.*` or a step in this step's **direct `depends_on`** (one-hop). Referencing a step not in `depends_on` is a load error (add it to `depends_on` or use `run.params.*`). Field names are not checked.

**Comparison semantics.** A resolved LHS uses strict equality (`==`/`!=`; `"1"` does not equal `1`) and numeric-guarded relational comparison (`>` `<` `>=` `<=` require both operands to be numbers). When the LHS is **unresolved** (absent path):

- `== null` / `!= null` are **presence tests** (loose null) — `== null` is true for a missing or present-`null` value; `!= null` is true only for a present non-null value.
- relational ops (`> < >= <=`) → **false** (no `null → 0` coercion).
- any other operator on an absent LHS → **false** (symmetric: a `!=` against a non-null literal does **not** fire when the path is absent).

> **Field-name typo fire-direction (accepted residual).** Field names in a leaf are not statically checkable (agent-step outputs aren't declared). A typo'd field resolves as absent in **both** directions: `x.tcuont >= 0.8` → false → the step **skips**; but `x.tcuont == null` → "absent" → true → the step **fires**. This is consistent with Realm's lenient path resolution everywhere. The high-value typo (a mistyped **step name**) is caught loudly by the reference rule above; only field-name typos within a correctly-named dependency slip through.

Once all of a step's dependencies are settled, the engine evaluates the `when` condition. If it is false at that point, the step is moved to `skipped_steps` immediately. In a mutual-exclusion pattern (two branches with opposite `when` conditions), the inactive branch is skipped as soon as the shared upstream step completes. No finalizer step is needed to close the run.

### Shadow mode via `run.params`

To run a workflow in shadow mode — executing analysis steps but skipping side-effect steps — declare a `mode` param and annotate side-effect steps:

```yaml
params_schema:
  type: object
  additionalProperties: false
  properties:
    mode:
      type: string
      enum: [live, shadow]
      default: live

steps:
  classify_ticket:
    description: Classify the ticket
    execution: agent

  post_to_zendesk:
    description: Post result to Zendesk
    execution: auto
    handler: zendesk_post
    depends_on: [classify_ticket]
    when: "run.params.mode == 'live'"
```

Start a shadow run with `params: { mode: "shadow" }`. Steps annotated with `when: "run.params.mode == 'live'"` are skipped. The run reaches terminal state cleanly — `propagateSkips` handles skip propagation once their dependencies settle.

**Limitations:** `when:` supports a single expression only. A step that needs both a shadow guard and a data condition cannot express both in one `when:` clause — use `depends_on` with `trigger_rule` or a preceding guard step instead. The step names `run`, `context`, and `$settlement` are reserved and cannot be used as step identifiers (`$settlement` reserved as of issue #220, ahead of a future namespace mint under that name — reserving it now closes the gap where an inter-release workflow could register a step that would become load-refused the instant the mint ships).

---

## Preconditions

Boolean expressions evaluated against prior step evidence before the step runs. If any precondition is false, the engine returns `status: blocked` with `agent_action: resolve_precondition`.

```yaml
write_to_target:
  execution: auto
  preconditions:
    - 'validate_fields.result.accepted_count > 0'
```

Supported operators: `>`, `<`, `>=`, `<=`, `==`, `!=`. The left side is a dot-path into the evidence of a prior step (`step.result.field`). The right side is a literal value.

---

## Gate message

`gate.message` is a developer-authored template string shown to the human reviewer when a gate opens. It is distinct from `prompt` — `prompt` is the LLM's task directive, while `gate.message` is a human-readable decision summary.

**Primary use case — self-reference:** the gate step's own output is available via `context.resources.STEP_NAME.FIELD`, where `STEP_NAME` is this step's own name:

```yaml
confirm_update:
  execution: agent
  trust: human_confirmed
  gate:
    choices: [confirm, reject]
    message: |
      *Update Request*
      Fields found: {{ context.resources.confirm_update.fields_found }} / {{ context.resources.confirm_update.total_fields }}
      Missing: {{ context.resources.confirm_update.missing_fields }}
      Confirm to proceed or reject to cancel.
  prompt: |
    Validate the incoming fields. Return JSON: { fields_found, total_fields, missing_fields }.
```

Cross-step references also work: `{{ context.resources.prior_step.field }}`.

**Fail-fast behavior:** if any `{{ ... }}` reference is unresolvable when the gate opens, the step returns a stop error immediately. The gate does not open with broken placeholder text. Fix the template or the step's output schema.

**gate.display fallback chain (MCP path):**

1. `gate.message` resolved → used as `gate.display`
2. `step.prompt` resolved → used as `gate.display` (existing behavior, unchanged)
3. Neither present → `gate.display` absent (existing behavior, unchanged)

**Audit guarantee:** the resolved message is stored verbatim in the run's evidence chain. `realm run inspect` surfaces it in the `gate_response` entry under `Message:`, so the exact text the human read when they made their choice is preserved permanently.

**Slack path:** when `gate.message` is present, the resolved text is used in the Slack notification in place of the raw JSON preview. When absent, the existing `formatGatePreviewForSlack(preview)` fallback applies.

### Authoring guidelines

`gate.message` is a **decision card** — the minimal set of facts an operator needs to make their choice confidently. It is not a status report, not a content preview, and not a dump of the step's output.

**Structure pattern:**

```
LINE 1     — Identity + the most important signal (severity, risk, category)
LINES 2–N  — 2–4 scannable key facts (label: value format)
[blank line]
[action line — only when choices are not self-evident]
```

- **Target: 3–5 lines. Maximum: 8 lines.** Beyond this, operators skim to the choices and miss the context.
- Line 1 must uniquely identify what is being reviewed and surface its urgency signal. In Slack it renders as bold when wrapped in `*...*`.
- Lines 2–N are for impact scope, confidence level, counts, or the one-line summary of the pending action.
- The runtime appends the response instructions (`realm run respond ...`) automatically — do **not** include them.

**What to include:**

| Include                                              | Reason                                            |
| ---------------------------------------------------- | ------------------------------------------------- |
| Identity — what specific thing this is               | Without this, every gate looks the same           |
| Severity, risk, or confidence signal                 | Tells the operator how carefully to review        |
| Impact scope — services, users, count                | Tells the operator how much they're committing to |
| The pending action in one clause                     | What will happen if they approve                  |
| Breaking constraints or flags that affect the choice | Things they'd want to know before saying yes      |

**What to omit:**

| Omit                                            | Reason                                                    |
| ----------------------------------------------- | --------------------------------------------------------- |
| Response instructions (`Reply 'approve' to...`) | The runtime appends these automatically                   |
| Full document or report body                    | Put that content in `prompt`; `gate.message` is a summary |
| Raw JSON arrays or objects                      | Use `\| join`, `\| bullets`, or `\| count` instead        |
| Long strings without truncation                 | Bind with `\| truncate: N` to prevent layout blowout      |
| Confidence notes when confidence is obvious     | Don't clutter high-signal messages with noise             |

**Anti-patterns:**

```yaml
# BAD: omits identity — impossible to tell what's being approved
message: |
  Review this? Confirm to proceed or reject to cancel.

# BAD: dumps the content body — gate.message is a summary, not the content
message: |
  Summary: {{ context.resources.write_summary.full_summary }}

# BAD: includes response instructions — the runtime appends these
message: |
  PR #{{ run.params.pr_number }} detected.
  Reply 'approve' to merge or 'reject' to discard.

# BAD: raw array value — renders as ["src/index.ts","src/utils.ts",...]
message: |
  Changed files: {{ context.resources.scan.changed_files }}

# GOOD: shaped for reading
message: |
  Changed files ({{ context.resources.scan.changed_files | count }}):
  {{ context.resources.scan.changed_files | bullets }}
```

**Channel rendering:** the terminal renders `gate.message` as plain text — `*bold*` and other mrkdwn syntax appear literally. Keep messages plain text unless Slack is the primary surface. When Slack rendering matters, bold the headline only: `*{{ context.resources.step.title }}*`.

**Checklist before shipping a gate:**

- [ ] Line 1 uniquely identifies what is being reviewed
- [ ] Severity, risk, or confidence signal is on line 1 or 2 — not buried
- [ ] All array fields are formatted with `| join`, `| bullets`, or `| count`
- [ ] All long strings are bounded with `| truncate: N`
- [ ] Optional fields use `| default:` or are guaranteed present by the step's `input_schema`
- [ ] No response instructions included
- [ ] Total length is ≤ 8 lines
- [ ] If content is truncated or capped (`| limit:`, `| truncate:`), the reviewer can either consult a primary source (URL, PR number, ticket) or — once bidirectional gate messaging is available — ask the agent for more detail in the same thread. Do not hide information that exists nowhere else and has no reachable primary source.
- [ ] Tested in terminal rendering, not only previewed as Slack Markdown

### resolution_messages

`gate.resolution_messages` is an optional per-choice confirmation map displayed after the gate
resolves. Each key is a valid gate choice; the value is shown in the terminal and posted as a
Slack thread reply to the gate notification.

```yaml
gate:
  choices: [send, reject]
  message: |
    {{ context.resources.analyze_cause.severity | upper }} — {{ context.resources.analyze_cause.root_cause }}
    Draft: {{ context.resources.draft_response.headline | truncate: 80 }}
  resolution_messages:
    send: 'Draft approved — posted to the incident channel.'
    reject: 'Draft rejected — run cancelled.'
```

Values are **plain text** — no template substitution. Keep entries to one line. Every choice in
`gate.choices` should have a corresponding entry; missing choices resolve silently (no message).

---

## Gate timeout (authorable enforce + notify clocks)

```yaml
approve_deploy:
  execution: auto
  trust: human_confirmed
  gate:
    choices: [approve, reject]
    timeout_seconds: 3600 # enforce clock: 1 hour
    on_expiry: settle_default
    default_choice: reject # safe default — never deploy unattended
    reminder_seconds: 900 # notify clock: nudge every 15 minutes
    reminder_max: 3 # up to 3 nudges (default when reminder_seconds is set)
```

Issue #291. Five `gate:` sub-keys, all optional and independent of each other except where noted:

| Key                | Type                          | Rule                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `timeout_seconds`  | positive integer              | The **enforce clock**: seconds after gate-open after which the gate is eligible for enactment.                                                                                                                                                                                                                                                         |
| `on_expiry`        | `'settle_default' \| 'abort'` | The disposition enacted once `timeout_seconds` elapses unanswered. Absent = **finding-only mode** (see below) — LEGAL.                                                                                                                                                                                                                                 |
| `default_choice`   | string                        | The choice enacted when `on_expiry: settle_default`. **REQUIRED iff `on_expiry: settle_default`** (a load-time hard error otherwise); validated against the step's own effective choice set (`gate.choices ?? input_schema.properties.choice.enum ?? ['approve','reject']`) at load time — a load-time-legal default can never fail at enactment time. |
| `reminder_seconds` | positive integer              | The **notify clock**: seconds between reminder nudges while the gate is unresolved. Standalone-legal — does NOT require `timeout_seconds` (a pure-notify gate) — LEGAL.                                                                                                                                                                                |
| `reminder_max`     | positive integer, default `3` | Repetition cap on the reminder cycle (only meaningful when `reminder_seconds` is set).                                                                                                                                                                                                                                                                 |

**Two documented distinct concepts, never confused:**

- The **enforce clock** (`timeout_seconds`/`on_expiry`/`default_choice`) is part of the workflow's contract — it can settle or abort the run. Canon analogue: Camunda's interrupting boundary timer / AWS Step Functions `TimeoutSeconds`.
- The **notify clock** (`reminder_seconds`/`reminder_max`, plus the CLI operator's own `reminderIntervalMs`/`escalationThresholdMs` config) has **ZERO settlement authority** — it can only send a message. A reminder being overdue is never a run-health finding (see the negative pin below); it never enacts anything. Canon analogue: Camunda's non-interrupting boundary timer / `dueDate` / the C7 timeout task listener.

**Dead-config warns** (never rejects): `on_expiry` declared without `timeout_seconds` (nothing will ever trigger it); `default_choice` declared with `on_expiry: 'abort'` or with no `on_expiry` at all (inert); `reminder_seconds >= timeout_seconds` (the first reminder would never fire before expiry). All are `DEAD_GATE_CONFIG` loader warnings. An unrecognized `gate:` sub-key (a typo) is a separate `UNKNOWN_GATE_KEY` warning — the FIRST gate sub-key validation the loader has ever had.

**Finding-only mode** — `timeout_seconds` with NO `on_expiry` — is legal and distinct from a fully-enforced gate: the gate never auto-resolves (there is nothing to enact), but a `gate_expired_awaiting_drive` run-health finding still fires once it passes its deadline (disposition `'finding_only'` in the finding's own evidence), `realm run drain --expired` lists it as "expired — finding-only" and never touches it, no enactment timer is scheduled for it, and the final reminder occurrence (if `reminder_seconds` is also set) uses a wording variant that never claims "will enact". A human response to a finding-only gate is **never refused**, however overdue.

### Mint-freeze semantics

Every one of the five fields above is **frozen into the run record at the exact moment the gate opens** (never re-read from the workflow definition afterward — the `ClaimRecord.deadline`/issue #302 uniform-epoch-freeze precedent, generalized). Consequences:

- Editing a workflow's `gate:` block after a gate has already opened **never applies to that already-open gate** — only to the NEXT gate a re-registered definition opens. This is deliberate: it kills a definition-drift class where a changed `default_choice` could make an enactment attempt fail forever.
- A gate opened by an **old binary** that predates issue #291 (or one whose `gate:` sub-keys the loader silently ignored under an even older binary) carries **NONE** of these fields — it is **grandfathered**: finding-silent (no `gate_expired_awaiting_drive` finding, since there is no `expires_at` to compare against), reminder-silent (the operator's own `reminderIntervalMs` config is its only notify path), and **never automatically enacted**. This population never resolves itself; a human response is its only path forward. Mixed-fleet advisory: a workflow deployed with `gate.timeout_seconds` but driven by a binary older than issue #291 has that key **silently ignored** — the gate behaves as if untimed.

### The fallback ladder (never a strand)

The enactment mechanism is a single pure arm-set (`applyExpireGate`) reused identically by every enactment point below — refusing a premature attempt (`now < expires_at`, verified server-side, never trusted from a caller's own clock) and idempotently NOOPing a replay (two enactment points racing each other never double-apply). **Expiry-WINS**: once the enforce clock has genuinely passed, a late human response is refused with an honest, disposition-specific explanation rather than silently recorded as if it arrived in time — see the disclosure section below for the exact wording per cell.

**Enactment points** (any of these may observe and enact an expired gate — level-triggered, not a single dedicated daemon):

| Point                                          | When it enacts                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submit_human_response`                        | A late response to an already-expired gate triggers enactment first, then composes the honest refusal/NOOP.                                                                                                                                                                                   |
| `execute_step`                                 | Attempting any step while a sibling gate has expired enacts it first — may un-block the very step being attempted.                                                                                                                                                                            |
| `realm run reclaim`                            | Never enacts — DEFERS, with an advisory pointing at `drain --expired` (reclaim has no drain plumbing of its own).                                                                                                                                                                             |
| `realm run drain --expired`                    | **Opt-in flag** — bare `drain` (including batch `--force`) is byte-stable, terminal-only, and never touches a gate. With the flag: reports/enacts expired-and-enactable gates; an abort disposition's terminalization flows into the same drain pass.                                         |
| The attending process's timer                  | The CLI process holding a gate open (interactively, via `realm agent`, or via the Slack notifier) schedules ONE enactment attempt at the frozen `expires_at`.                                                                                                                                 |
| `realm listen --sweep-expired-gates <seconds>` | **Opt-in flag**, default OFF — a coarse, store-wide sweep; the only enactor that doesn't require an attending process to be waiting on that specific run. Never drains finalizers itself (no extension registry for a workflow it hasn't mounted) — logs the same `drain --expired` advisory. |

**Late-response disclosure** — every enactment carries an honest, per-cell envelope: a same-choice late response to a `settle_default` gate is told "the outcome matches your choice, but it was settled by timeout; your response was not recorded" (never implying the human's own answer was recorded); a conflicting choice is told which choice actually won and that theirs was not recorded; a response to an aborted gate gets a third, distinct terminal-run variant ("the gate expired and the run aborted per the workflow's declared on_expiry — your choice was NOT recorded") — never the misleading "cancelled when &lt;another step&gt; aborted the run" wording a genuinely-cancelled gate gets. `realm run inspect`/`get_run_state` both disclose `enacted_via` (`submit`/`execute_step`/`drain`/`timer`/`listen`) and the overdue duration on the triggering call's own response.

### Realm ↔ canon vocabulary

| Realm                                            | Canon analogue                                                                                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gate.timeout_seconds`                           | Camunda interrupting boundary timer / AWS Step Functions `TimeoutSeconds`                                                                           |
| `on_expiry: abort`                               | Interrupting timer → terminate                                                                                                                      |
| `on_expiry: settle_default`                      | Interrupting timer → default branch                                                                                                                 |
| `gate.reminder_seconds`/`reminder_max`           | Camunda non-interrupting boundary timer / `dueDate` / the C7 timeout listener                                                                       |
| CLI `reminderIntervalMs`/`escalationThresholdMs` | Operator-configured notify — Temporal/external alerting                                                                                             |
| `gate_expired_awaiting_drive` (run-health)       | No canon analogue — daemonless-specific: canon's daemon enacts synchronously; realm discloses the window between expiry and the next drive instead. |

**Dead-notification advisory:** the CLI warns once, at notifier wiring, when the OPERATOR's own `reminderIntervalMs`/`escalationThresholdMs` could never fire before the gate's frozen `timeout_seconds` elapses (the AWS Step Functions `HeartbeatSeconds < TimeoutSeconds` cross-validation, extended cross-domain). An AUTHORED `reminder_seconds >= timeout_seconds` gets the SAME check at LOAD time instead (the `DEAD_GATE_CONFIG` warning above) — the loader can't see the operator's CLI config, so this is genuinely two checks for two config sources, not a duplicate.

**Fallback asymmetry (stated, not a bug):** the AUTHORED reminder cycle repeats (up to `reminder_max`); the OPERATOR fallback (`reminderIntervalMs`, used only when the author declared no `reminder_seconds` — record-keyed precedence) stays **single-shot**, unchanged from before issue #291 — repeating it would silently change an existing deployment's Slack volume under an unchanged config. The **webhook-only** Slack topology (no bot token) runs **no timers at all** — an authored reminder is silently inert there; the escalation one-shot itself is completely untouched by any of this.

**`create_workflow` cannot author a gate at all** (its step schema has no `gate:`/`trust:` block) — gates, including every field on this page, are YAML-only.

---

## Step display

The `display:` field produces a formatted terminal summary printed after the step completes.
Without `display:`, the CLI prints the raw JSON output. With `display:`, it renders the
developer-authored template.

```yaml
write_review:
  execution: agent
  depends_on: [fetch_pr]
  display: |
    Risk: {{ risk }}

    {{ review_comment }}
```

### Short-path syntax

`display:` uses a **short-path renderer** — `{{ field }}` resolves against the step's own
output object. It does **not** support:

- `{{ context.resources.STEP.field }}` — cross-step references
- `{{ run.params.field }}` — run params
- Liquid filters (`| upper`, `| bullets`, `| truncate`)

Unrecognised paths pass through as literal text. This is the most common authoring mistake
— if you see `{{ context.resources.write_review.risk }}` in the terminal instead of a value,
you are using context paths in `display:` where you should be using `gate.message`.

### Gate fallback

On `execution: auto` steps with `trust: human_confirmed`, `display:` is used as the
`gate.display` fallback when `gate.message` is absent:

```
1. gate.message resolved  → used as gate.display (Liquid filters supported)
2. display: resolved      → used as gate.display (short paths only, no filters)
3. step.prompt resolved   → used as gate.display (existing fallback)
4. none present           → gate.display is absent
```

For gate steps that need filters or cross-step references in the decision card, use
`gate.message` — not `display:`.

---

## Template filters

Template expressions support an optional pipe-filter chain: `{{ path | filter1 | filter2: arg }}`.

The path is resolved first. Each filter in the chain receives the current value and produces a new value. If any filter produces a type mismatch the placeholder is left intact (`{{ path | ... }}`). Unknown filters in `gate.message` templates cause a `FILTER_UNKNOWN` stop error.

### Tier 1 filters

| Filter       | Arg                           | Input      | Output                                                                                    |
| ------------ | ----------------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| `bullets`    | —                             | `string[]` | `• item\n• item\n…` — empty array → placeholder                                           |
| `join`       | separator (default `", "`)    | `string[]` | items joined by separator                                                                 |
| `default`    | fallback value (default `""`) | any        | fallback when value is `null` or `undefined`; passes through `""`, `0`, `false` unchanged |
| `upper`      | —                             | `string`   | uppercased string                                                                         |
| `lower`      | —                             | `string`   | lowercased string                                                                         |
| `capitalize` | —                             | `string`   | first character uppercased, remaining characters unchanged                                |
| `truncate`   | max length (integer)          | `string`   | string cut at word boundary ≤ N + `…`; unchanged if already short enough                  |

`truncate` does not auto-stringify numbers; ensure the value is a string in the step's output if truncation is needed.

> `capitalize` uppercases only the first character; remaining characters are not modified.
> `"DATABASE_UNAVAILABLE" | capitalize` → `"DATABASE_UNAVAILABLE"`, not `"Database_unavailable"`.

**Arg quoting and multi-arg syntax:** Filter arguments follow the filter name after a colon. Multiple arguments are separated by commas. String arguments containing spaces or commas must be quoted with double or single quotes; the outer quotes are stripped. Unquoted arguments are trimmed. Examples: `join: " / "` (one quoted arg, passes `/`); `replace: ",", " / "` (two quoted args); `truncate: 80` (one unquoted integer arg); `yesno: "Active", "Inactive"` (two quoted args).

**`default:` fires on `null` or `undefined` only — not on filter errors.** A short-circuit from a prior `ok: false` result (type mismatch or unknown filter in lenient mode) leaves the placeholder intact; `default:` is not reached. For example, `{{ items | pluck: "name" | default: "none" }}` where `pluck` produces a type mismatch short-circuits before `default:` — the result is the placeholder, not `"none"`.

**Filter chain example:**

```yaml
gate:
  message: |
    Issues found:
    {{ context.resources.scan.issues | bullets }}

    Summary: {{ context.resources.scan.summary | truncate: 200 }}
    Repo: {{ run.params.repo | upper }}
    Tags: {{ context.resources.scan.tags | join: ", " }}
    Status: {{ context.resources.scan.status | default: unknown }}
```

**Strict mode:** `gate.message` is rendered in strict mode — an unknown filter name returns a `FILTER_UNKNOWN` stop error rather than leaving the placeholder intact. All other template call sites (`prompt`, `instructions`, `gate.display` fallback) are lenient: unknown filters leave the placeholder as-is.

**Author note:** If you need a fallback for optional fields that may also be the wrong type, ensure the step always outputs the field as a string or omits it — don't rely on `| default:` to cover upstream type errors.

### Tier 2 filters

| Filter          | Arg                                                                   | Input                   | Output                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pluck`         | key (string)                                                          | `object[]`              | array of values for key; absent keys and non-object items omitted                                                                                                                       |
| `count`         | —                                                                     | `array`                 | array length as string; empty array → `"0"`                                                                                                                                             |
| `limit`         | max items (integer)                                                   | `array`                 | first N items; `limit: 0` → `[]`                                                                                                                                                        |
| `compact`       | —                                                                     | `array`                 | array with `null`/`undefined` entries removed                                                                                                                                           |
| `replace`       | search, replacement (both required)                                   | `string`                | replaces all occurrences of search with replacement; case-sensitive; empty search → placeholder                                                                                         |
| `round`         | decimals (integer, default `0`)                                       | `number`                | rounded string                                                                                                                                                                          |
| `floor`         | —                                                                     | `number`                | largest integer ≤ input, as string                                                                                                                                                      |
| `ceil`          | —                                                                     | `number`                | smallest integer ≥ input, as string                                                                                                                                                     |
| `abs`           | —                                                                     | `number`                | absolute value as string                                                                                                                                                                |
| `number_format` | decimals (integer, default `0`)                                       | `number`                | locale-formatted string with thousands separator; locale is `en-US`                                                                                                                     |
| `percent`       | decimals (integer, default `0`)                                       | `number` [0, 1]         | e.g. `"85.7%"` — input is a fraction, multiplied by 100                                                                                                                                 |
| `yesno`         | yes label, no label (both optional)                                   | `boolean`               | `"yes"` / `"no"` by default; custom labels when two args provided; one arg falls back to defaults                                                                                       |
| `and_join`      | —                                                                     | `unknown[]`             | Oxford comma join; empty array → placeholder                                                                                                                                            |
| `trim`          | —                                                                     | `string`                | leading and trailing whitespace removed                                                                                                                                                 |
| `first`         | —                                                                     | `array`                 | first element; empty array → placeholder                                                                                                                                                |
| `last`          | —                                                                     | `array`                 | last element; empty array → placeholder                                                                                                                                                 |
| `sum`           | —                                                                     | `number[]`              | sum of elements as string; empty array → `"0"`; non-number element → placeholder                                                                                                        |
| `flatten`       | —                                                                     | `array`                 | one level deep flatten; does not recurse                                                                                                                                                |
| `split`         | delimiter (required)                                                  | `string`                | splits on delimiter string (any non-empty string); produces `string[]`; empty delimiter → placeholder                                                                                   |
| `sort`          | —                                                                     | `array`                 | lexicographically sorted copy; elements coerced via `String()` for comparison; stable sort                                                                                              |
| `unique`        | —                                                                     | `array`                 | deduplicated array; equality by `JSON.stringify`; property order in objects matters                                                                                                     |
| `title`         | —                                                                     | `string`                | first character of each whitespace-separated word uppercased; remaining characters unchanged; hyphens are not word boundaries                                                           |
| `code`          | —                                                                     | `string`                | wraps value in single backticks for Markdown/Slack inline code; inner backticks not escaped — values containing backticks may produce malformed output; intended for single-line values |
| `indent`        | spaces (integer, required)                                            | `string`                | prefixes each non-empty line with N spaces; empty lines not indented                                                                                                                    |
| `date`          | preset (`short`, `long`, `iso`, `time`, `datetime`) — default `short` | `string` (ISO 8601)     | formatted date in UTC; `short` → `"Jan 28, 2026"`; unparseable string → placeholder                                                                                                     |
| `from_now`      | —                                                                     | `string` (ISO 8601)     | relative time string, e.g. `"3 minutes ago"` or `"in 5 minutes"`; uses `Intl.RelativeTimeFormat`                                                                                        |
| `duration`      | —                                                                     | `number` (milliseconds) | duration string, e.g. `"1m 23s"` or `"45s"`; negative → placeholder                                                                                                                     |

> All `date` output is in UTC. `timeZone: 'UTC'` is used in every `Intl.DateTimeFormat`
> call — output is deterministic regardless of server timezone.

> `split` is the only Tier 2 filter that changes the value type from `string` to `string[]`.
> It enables chains like `{{ run.params.csv | split: "," | compact | and_join }}`.

**Tier 2 filter example:**

```yaml
gate:
  message: |
    Review required for {{ run.params.repo | upper }}.
    {{ context.resources.scan.findings | pluck: "title" | limit: 5 | bullets }}

    Issues found: {{ context.resources.scan.findings | count }}
    Confidence: {{ context.resources.scan.confidence | percent: 1 }}
    Auto-fixable: {{ context.resources.scan.auto_fixable | yesno }}
    Affected modules: {{ context.resources.scan.modules | compact | and_join }}
```

---

## Retry

```yaml
fetch_document:
  execution: auto
  uses_service: source
  idempotent: true
  timeout_seconds: 30
  retry:
    max_attempts: 3
    backoff: exponential
    base_delay_ms: 1000
    on_timeout: true
    total_timeout_seconds: 120
```

| Field                   | Type                                 | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `max_attempts`          | integer                              | Total attempts including the first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `backoff`               | `linear` \| `exponential` \| `fixed` | Delay growth strategy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `base_delay_ms`         | integer                              | Base delay in milliseconds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `max_delay_ms`          | integer                              | Cap on the computed backoff delay.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `on_timeout`            | boolean                              | **(issue #140)** Opt in to retrying this step's own `STEP_TIMEOUT` in place, consuming a normal attempt. Requires the step to also declare `idempotent: true` — a hard error at load otherwise, since a timeout-retry can run concurrently with the still-in-flight original attempt. Only meaningful on `execution: auto` steps. Absent/false: a timeout stays terminal (unchanged from pre-#140 behavior).                                                                                                                                                                                                                                                                                       |
| `total_timeout_seconds` | integer                              | **(issue #140)** Total wall-clock budget, in seconds, across every attempt (a Temporal-`ScheduleToClose`-style cap). Standalone-legal — does not require `on_timeout`. **When absent, every retry-configured `execution: auto` step is capped by DEFAULT at `max_attempts × its own per-attempt timeout + the declared backoffs between attempts`** — so the default cap equals the step's own declared schedule and only binds when a runtime wait (e.g. a rate-limit `retry_after`) pushes an attempt materially past it. When the cap is reached, the step settles as `STEP_RETRY_EXHAUSTED` (`exhausted_by: 'total_timeout'`) instead of sleeping past it. Inert (warns) on a non-`auto` step. |

> **Timeout-retry concurrency contract:** `on_timeout: true` is an attestation that the step's
> handler/adapter is safe to execute concurrently with itself — including a PARTIAL prior
> application (a committed prefix left by the aborted-but-still-possibly-in-flight original
> attempt). This is a stronger claim than `idempotent` alone, which only guarantees safe
> SEQUENTIAL re-application; declare both explicitly, the engine never infers one from the other.

> **Version skew:** on an engine older than #140, `on_timeout` and `total_timeout_seconds` are
> unrecognized retry sub-keys and are silently ignored, so a declared cap goes unenforced — this
> fails safe: retry semantics are otherwise unchanged, only the bound is missing.

> **Non-auto steps (issue #218):** any `retry:` sub-key on an `agent`/`guard` step draws an
> advisory (`RETRY_INERT_NON_AUTO`), since the built-in dispatch path never throws for those steps
> and so never consumes the block.

---

## `validation_exhaustion` (bounded schema-rejection exhaustion)

```yaml
draft:
  execution: agent
  output_schema:
    {
      type: object,
      additionalProperties: false,
      required: [category],
      properties: { category: { type: string } },
    }
  validation_exhaustion:
    threshold: 3
```

Every `execution: 'agent'` step whose submitted output/input is rejected against `output_schema`/
`input_schema` (`VALIDATION_OUTPUT_SCHEMA`/`VALIDATION_INPUT_SCHEMA`) accrues a persistent,
per-step rejection count on the run record (`RunRecord.validation_rejections`, pooled across
concurrent writers, never reset). Once the count reaches a threshold — `6` by default
(`DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD`, exported), or the value declared here — the step
terminalizes with a real `VALIDATION_EXHAUSTED` failure: it claims, fails, and seals exactly like
any other dispatch failure. Finalizer triggers key on the RUN's own sealing outcome, never on this
one step's failure in isolation — `complete` seal ⇒ `on_outcome: complete` + `always` finalizers
fire; `fail` seal ⇒ `fail` + `always`; `abort` seal ⇒ `abort` + `always`. A run that recovers around
this step's exhaustion (via `trigger_rule`) and still reaches a `complete` seal fires `complete` +
`always` finalizers only — `fail`-triggered finalizers do NOT also run just because this one step
failed along the way, **unless the mixed-complete trigger is declared; see
[execution: finalizer](#execution-finalizer)**. This is deliberate (issue #220): a persistently-rejected agent step is otherwise an unbounded,
write-free wedge — `run_phase` never reaches `failed` and finalizer machinery never fires. **Every
countable agent step is auto-enrolled at the default threshold — there is no way to disable
exhaustion in PR-1**, only to retune it.

| Field       | Type    | Description                                                                                                                                                                                                                           |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `threshold` | integer | Overrides the default threshold (6) for this step. Must be a positive integer. `1` is legal and documented as disabling in-drive schema-repair (`realm agent`'s `--schema-retries`), since the very first rejection already meets it. |

Only valid on `execution: 'agent'` steps — the countable rejection classes are agent-only by
construction.

`mode` (`'fail'` | `'default'`) and `default_output` (issue #220 PR-2) let a step declare a
**bounded, validated, disclosed fallback** instead of failing on exhaustion: `mode: 'default'`
requires `default_output` and requires the step to declare `output_schema` (against which
`default_output` is AJV-validated **at load time**, using the exact same validator the runtime
uses — a fallback that would itself fail runtime validation is refused before the workflow ever
registers). On exhaustion the engine settles the step SUCCESSFULLY with `default_output` instead
of failing the run. See `$settlement` below for how a downstream step can branch on whether this
happened.

```yaml
draft:
  execution: agent
  output_schema:
    {
      type: object,
      additionalProperties: false,
      required: [category],
      properties: { category: { type: string } },
    }
  validation_exhaustion:
    mode: default
    default_output: { category: 'uncategorized', source: 'fallback' }
```

> **`realm agent` coherence warning:** when `--schema-retries`'s own in-drive repair budget
> (`schemaRetries + 1` attempts) exceeds a step's effective exhaustion threshold, the drive prints
> one warning at that step's first attempt — the repair loop would otherwise keep retrying past
> the point the engine has already terminalized the step.

> **`create_workflow` (dynamic workflows):** `validation_exhaustion` is register-time only — a
> dynamically-created workflow cannot declare it, and draws a targeted warning naming the
> disposition if submitted. Every dynamic agent step with a countable schema is still auto-enrolled
> at the default threshold; there is no reachable override or opt-out for a dynamic workflow.

---

## `structured_output` (Anthropic strict decoding)

```yaml
classify:
  execution: agent
  structured_output: strict
  output_schema:
    type: object
    additionalProperties: false
    required: [category]
    properties:
      category: { type: string, enum: [billing, technical, other] }
```

Issue #236. `structured_output: strict` opts an `execution: agent` step into Anthropic's
**grammar-constrained ("strict") tool use** — the model's token sampling is constrained so its
submit-tool call matches the step's effective schema (`output_schema ?? input_schema`) by
construction. This is an **L0 prevention layer**: it narrows the class of malformed submissions
that ever reach realm's own (L1) Ajv validation + reask loop. **L1 is not subsumed** — three
documented escape hatches (a `refusal` stop reason, `max_tokens` truncation, and enum-value
casing drift) still produce schema-nonconforming output even under strict, so Ajv + reask remain
the safety net regardless of whether this key is declared.

**Default is OFF.** Nothing changes for a step that omits this key — declaring it is the only way
to engage any of the machinery below.

### The eligibility gate

The API provably **rejects** some legal-per-Ajv schemas (a `400`, "with details") and **silently
weakens** others — an unsupported keyword is neither honored nor rejected, it is simply dropped
from the grammar with no error, so the model can violate it and realm's own Ajv only catches that
after the fact. Because two failure classes (internal grammar-size limits and a 180-second compile
timeout) are documented as unpredictable from the schema alone, realm's own static gate can never
be complete — it narrows the surface, it does not eliminate live 400/503s. `assessStructuredOutputEligibility`
(the same pure function both authoring time and runtime call) classifies the effective schema
against this table:

| Row     | Rule                                                                                                                                                                                                                                                                                                                                                                                           | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G0**  | No effective schema at all, or the root is not `type: 'object'`                                                                                                                                                                                                                                                                                                                                | `ineligible` (two distinct remediations: "add output_schema/input_schema" vs "declare `type: 'object'` at the schema root")                                                                                                                                                                                                                                                                                                                             |
| **G1**  | Every object (root **and** nested) must carry EXPLICIT `additionalProperties: false` — never injected by realm (injection would permanently split what the grammar allows from what Ajv allows)                                                                                                                                                                                                | missing ⇒ `ineligible`                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **G2**  | Keyword allowlist (snapshot-dated from Anthropic's own docs). **Hard class:** `minimum`/`maximum`/`multipleOf` · recursive schemas (including a root `$ref: '#'` — the API neither cleanly enforces nor cleanly rejects this specific edge: it silently prunes an optional recursive arm, or 503s when the arm is required) · external `$ref` · an `enum` with a complex (object/array) member | hard class ⇒ `ineligible`; any OTHER off-allowlist keyword (e.g. `minLength`, `pattern`) ⇒ **caveat** — "silently ignored or rejected by the API — either way enforced post-hoc by realm"                                                                                                                                                                                                                                                               |
| **G3**  | More than 24 optional properties, or more than 16 union-typed properties (`anyOf` or a multi-type `type` array), across the schema                                                                                                                                                                                                                                                             | `ineligible`                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **G4**  | `format` outside the 10 documented values (`date-time`, `time`, `date`, `duration`, `email`, `hostname`, `uri`, `ipv4`, `ipv6`, `uuid`)                                                                                                                                                                                                                                                        | caveat                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **G5**  | `pattern` present at all                                                                                                                                                                                                                                                                                                                                                                       | caveat                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **G6**  | The step declares `tools`                                                                                                                                                                                                                                                                                                                                                                      | `ineligible` — v1 does not support strict on a tools-bearing step                                                                                                                                                                                                                                                                                                                                                                                       |
| **G7'** | ANY optional property on an otherwise-eligible schema                                                                                                                                                                                                                                                                                                                                          | caveat `optional_emission` — **measured**: on a real cs1 production schema, strict emitted an optional field in **4 of 24** runs vs **24 of 24** unconstrained (same benchmark, same inputs) — grammar-constrained sampling measurably suppresses optional-field emission on some schema shapes. The remedy: make any field your consumers actually rely on `required` (a `required` field is grammar-forced — the model must emit _something_ for it). |

**Post-hoc-only, not silent:** every caveat above still gets realm's normal Ajv enforcement after
the fact (a `pattern`/`format`/`minLength` violation is still caught and reaskable) — "caveat"
means the GRAMMAR itself can't guarantee it, not that nothing guarantees it.

**Authoring vs runtime — an intentional asymmetry:** a `--file`-loaded workflow (`validate`,
`register`, a plain `loadWorkflowFromFile`) **REJECTS** an ineligible `structured_output: strict`
declaration at load time — a typed loader error naming every remediation. A **registered**
workflow driven at runtime (including one registered via `create_workflow`'s own raw-JSON path,
which never re-runs the YAML loader) instead **DEGRADES LOUDLY**: strict is never sent, and the
attempt's evidence discloses why (`downgrade_reason: 'gate_ineligible'`) — a run is never silently
stranded because a registered definition drifted out of eligibility. This is deliberate, not a
gap: authoring-time is where a human can fix the schema; runtime's job is to keep the run moving.

### The fallback ladder (live API failures the static gate could not predict)

Even an eligible schema can 400 or 503 on a live request (the two undocumented-from-schema classes
above). Any `400` on a request that carried `strict: true` — or a `503` — drops strict, discloses,
and retries **once** (never a message-text match; the arm keys on HTTP status and whether strict
was actually sent). A **503** additionally gets a label: if its message matches Anthropic's own
captured grammar-compilation-unavailable text, the disclosure reads `grammar_unavailable`;
otherwise it reads the generic `service_unavailable` (fail-safe — a non-matching message never
silently degrades to a false-specific label). The full downgrade-reason vocabulary an
attempt's evidence (`diagnostics.structured_output.downgrade_reason`) can carry:

| `downgrade_reason`          | Meaning                                                                                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gate_ineligible`           | The runtime (Phase B) verdict was `ineligible` — strict was never attempted at all.                                                                                                                                                                                            |
| `api_rejected_schema`       | A live `400` on a strict-carrying request.                                                                                                                                                                                                                                     |
| `grammar_unavailable`       | A live `503` whose message matched the captured grammar-compilation text.                                                                                                                                                                                                      |
| `service_unavailable`       | A live `503` that did not match — the generic fallback label.                                                                                                                                                                                                                  |
| `provider_unsupported`      | The configured LLM provider doesn't implement the strict-aware call path (a third-party `--provider-module` that only implements the base `callStep`).                                                                                                                         |
| `unsupported_context_tools` | The step declares `tools` (G6).                                                                                                                                                                                                                                                |
| `external_agent`            | The step declared `structured_output: strict` but was driven by something other than `realm agent` — e.g. an external agent calling `execute_step` over MCP directly. realm cannot know whether strict was honored on that path at all; it says so rather than staying silent. |

**Sticky within a drive:** once a step's strict attempt downgrades (a live 400/503), `realm agent`
remembers it for that step for the rest of the drive session — every later attempt (a retried LLM
call, an issue #217 schema-repair iteration) goes out without strict too, never re-attempting it.
A non-grammar `503` therefore disables strict for that step for the whole session; the
`service_unavailable` label makes this auditable rather than silent.

**The observables-only vocabulary, and why there is no `applied` field.** Every disclosed field
describes what realm did, never what the API did: `sent` means **"realm placed `strict: true` on
the request handed to the SDK"** — nothing more. Whether the API (or a proxy in between) actually
_enforced_ it is not witnessable from realm's side. A REJECTING proxy is covered by the same `400`
arm as the API itself; a **silently-stripping** proxy is exactly why the vocabulary never claims
"applied" — `sent` is honest under any SDK/proxy, `applied` would not be.

### Operational notes

- **SDK floor unchanged:** `@anthropic-ai/sdk >= 0.20.0` (the existing peer-dependency floor).
  Because the SDK is a consumer-supplied peer dependency, realm can never rely on SDK-version-
  specific behavior — the fallback ladder is what carries an old or new SDK equally; wire-level
  `strict` pass-through under the CURRENT SDK is pinned by test, older versions are expected to
  behave identically (a stale SDK that rejects `strict` at all simply routes through the same `400`
  ladder arm).
- **Grammar-compile latency:** the first request against a NEW schema (or a schema/tool-set that
  changed) pays a one-time grammar-compilation cost; compiled grammars are cached for 24 hours from
  last use. A workflow's repeated runs of the same step schema benefit from this cache. The
  documented compile timeout is 180 seconds — a compile that exceeds it 400s (a class the static
  gate cannot predict; the fallback ladder is what carries it).
- **Token cost:** structured outputs inject an additional system prompt explaining the expected
  format — a real, if usually small, per-request token cost. `required` fields are grammar-forced
  (the model must emit something for each), which is a REAL cost too: each required field
  measurably grows the grammar's state space. This is the flip side of the G7' remedy above — making
  a field `required` trades an emission-reliability problem for a small, bounded token cost, which
  is realm's own recommended trade, not a free lunch.
- **Reasoning-position note (thinking models):** with DEFAULT THINKING enabled, the benchmark that
  measured the G7' numbers above found **no regression** on stored-agreement quality between strict
  and unconstrained generation, and an optional reasoning-shaped field was emitted identically in
  both arms — the model's actual reasoning lives in thinking blocks, ahead of the constrained
  submit-tool call, so constrained decoding does not truncate it. On a **non-thinking** (or
  thinking-disabled) configuration this composition witness does not apply — prefer declaring a
  reasoning-shaped field `required` AND ordering it FIRST among the schema's properties (the API's
  own documented contract: required properties are emitted first, in schema order), so it is
  produced before the answer fields even under constrained decoding.
- **Cloud/self-hosted note:** the grammar-compilation latency and 24-hour cache above are
  Anthropic-side costs, not realm-side — a realm deployment fanning out many DISTINCT schemas
  (e.g. one per tenant) pays the compile cost more often than one reusing a small, stable schema
  set; this is a scaling/cost consideration for a cloud operator, not a correctness concern.

### Disclosure

An opted-in step's attempt is disclosed in its evidence entry's `diagnostics.structured_output`
(`realm run inspect`); `get_run_state` (MCP) does not carry per-step evidence at all by design, so
an MCP consumer combines the run's own `terminal_reason` + `failed_steps` + derived `run_phase`
instead (the same posture issue #304's `completed_with_failed_steps` finding already established).
`realm validate` additionally prints a per-step adoption NUDGE on its own informational channel —
the migration delta for a step that hasn't opted in yet, and the caveat text for one that has —
never a bare "eligible" (see `realm validate --strict` in [cli-commands.md](cli-commands.md); the
nudge never affects the exit code).

**Run-health disclosure (issue #316).** A run-health `structured_output_downgraded` finding
aggregates every step whose disclosed `downgrade_reason` is present — surfacing on live runs via
`get_run_state`'s `run_health`/`warnings`, and on terminal runs via `realm run inspect` (see
[mcp-protocol.md](mcp-protocol.md)). `external_agent` is deliberately **excluded**: it names an
MCP-driven attempt realm never made a request for at all, not a degraded one realm itself chose to
send unconstrained — reporting it as a finding would fire on every declared step of every
non-`realm agent`-driven run, regardless of whether strict was ever actually attempted. The
finding is always informational: even when it fires, the step's output was still validated
post-hoc by realm's own L1 Ajv + reask loop above — a downgrade narrows the prevention layer, it
never removes the safety net.

### A tools-bearing step is a G6 reject, not a degrade

`examples/09-webhook-pr-review/workflow.yaml`'s agent steps declare `tools` — `structured_output`
is deliberately NOT declared there. If it were, Phase A (authoring) would reject it at load time
with the `unsupported_context_tools` remediation; this is the documented G6 case, not a live demo.

---

## `$settlement` namespace (fallback-provenance branching)

Issue #220 PR-3. `$settlement` is a reserved, engine-minted evaluation-root namespace exposing —
for every step that has SETTLED (completed or failed) — whether it settled via its own submission
or via a declared `validation_exhaustion.mode: 'default'` fallback:

```
$settlement.<step>.settled_by_default   →  boolean
$settlement.<step>.validation_rejections →  integer (count of schema rejections before settling)
```

An entry exists **only** for a step in `completed_steps ∪ failed_steps` — a skipped step, a
still-in-progress step, or a step whose only evidence is a non-settling snapshot (e.g. an
in-flight gate preview) has **no** `$settlement` entry at all; absence is never a third status.
For a settled step that never used `mode: 'default'`, `settled_by_default` is explicitly `false`
(never merely absent) and `validation_rejections` is `0` if it never accrued any.

### Per-root spelling

`$settlement` is available on every evaluation surface, but the ROOT it hangs off differs, exactly
like every other evidence reference on that surface:

| Surface                                          | Spelling                                                  |
| ------------------------------------------------ | --------------------------------------------------------- |
| `when`                                           | `$settlement.<step>.settled_by_default`                   |
| `abort_unless` (guard steps)                     | `$settlement.<step>.settled_by_default`                   |
| `preconditions`                                  | `$settlement.<step>.settled_by_default`                   |
| `input_map`                                      | `context.resources.$settlement.<step>.settled_by_default` |
| Template filters (`{{ }}`, incl. `gate.message`) | `context.resources.$settlement.<step>.settled_by_default` |

```yaml
route:
  execution: auto
  depends_on: [classify]
  when: ['$settlement.classify.settled_by_default == false']

approve:
  execution: guard
  depends_on: [classify]
  abort_unless: ['$settlement.classify.settled_by_default == false']

notify:
  execution: agent
  depends_on: [classify]
  input_map:
    was_fallback: 'context.resources.$settlement.classify.settled_by_default'
```

### One-hop rule (load-time enforced on `when`/`abort_unless`/`preconditions`)

`<step>` in a `$settlement.<step>.…` reference must be a **direct** dependency of the referencing
step (the same one-hop rule `when` already enforces for ordinary step references) — a
`$settlement.<step>` where `<step>` is not in `depends_on` is **load-refused**, on all three of
`when`/`abort_unless`/`preconditions`. `input_map` and template filters do **not** get this
check — see the residual below.

### Per-surface consequence disparity (a bad FIELD name, e.g. a typo'd `settled_by_defalut`)

Only the `<step>` segment is load-time-validated (the one-hop rule above); a typo in the FIELD
segment is never load-refused anywhere, and its RUNTIME consequence differs by surface:

| Surface                 | Consequence of an unresolvable field                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `when`                  | The leaf resolves `undefined` → traced as `lhs_present: false` in `skip_details` (visible) |
| `abort_unless` (guard)  | Unresolvable path → `resolution_error` → the guard step FAILS the run                      |
| `preconditions`         | Unresolvable path → the precondition never passes → the step blocks forever                |
| `input_map` / templates | Resolves to `undefined` **silently** — no trace, no refusal                                |

**Named residual:** `input_map` has no load-time reference validation at all (this predates
`$settlement` and is unchanged by it) — a typo'd `$settlement` path there is indistinguishable,
at load time, from a correctly-spelled one that simply hasn't settled yet. This is a known,
accepted gap, not a bug; do not expect `input_map` to catch a `$settlement` typo the way `when`
does.

---

## Services

> **v0.14:** each `services:` entry is validated against a strict schema — the key set is
> closed (`adapter`, `trust`, `rate_limit`). **`auth.token_from` was removed**: credentials
> bind at adapter CONSTRUCTION time in the deployment manifest
> ([realm.yaml](deployment-manifest.md)), never in workflow YAML.

```yaml
services:
  source:
    adapter: google_docs
    trust: engine_delivered
```

| Field     | Type   | Description                                                               |
| --------- | ------ | ------------------------------------------------------------------------- |
| `adapter` | string | Name of a registered `ServiceAdapter` (built-in, extension, or manifest). |
| `trust`   | string | Service trust level. See below.                                           |

> **Current limitation — content injection:** The adapter response is injected in full into
> `context.resources.<step_name>` and flows into every subsequent agent step's prompt context.
> For large files (logs, lengthy documents, large JSON) this consumes significant context budget.
> A `content_strategy: reference` option is planned for Release 2: in reference mode the engine
> injects only metadata and exposes a `read_resource` MCP tool the agent calls on demand.
> For Release 1, keep service-read files small (under ~10KB).

### Service trust levels

| Value              | Description                                                                            |
| ------------------ | -------------------------------------------------------------------------------------- |
| `engine_delivered` | Service response is injected directly into evidence. The agent cannot see or alter it. |
| `engine_managed`   | The engine manages the service call; the agent provides input parameters.              |
| `agent_provided`   | The agent is responsible for the service interaction.                                  |

For full configuration reference, supported operations, and response shapes for the
built-in adapters (`FileSystemAdapter`, `GitHubAdapter`, `GenericHttpAdapter`), see the
[Built-in Service Adapters Reference](adapters.md).

---

## Step Templates

Step templates are reusable named step groups declared in a top-level `templates:` block.
They are resolved at load time — there is zero runtime overhead and no new files on disk.
Templates eliminate copy-paste in workflows that repeat the same step pattern with different
service names, prefixes, or agent descriptions.

### Declaring a template

```yaml
templates:
  extract_and_record:
    params:
      service_name:
        required: true
      agent_description:
        default: 'Review the extracted content.'
    steps:
      extract:
        description: 'Extract content from {{ service_name }}'
        execution: auto
        depends_on: []
        uses_service: '{{ service_name }}'
        operation: read
      review:
        description: '{{ agent_description }}'
        execution: agent
        depends_on: ['{{ prefix }}_extract']
```

### Using a template

```yaml
steps:
  invoice_check:
    use_template: extract_and_record
    prefix: invoice
    params:
      service_name: invoices
      agent_description: 'Review the extracted invoice for anomalies.'
```

`prefix` is mandatory when `use_template` is present. It is used both for step ID generation
(`invoice_extract`, `invoice_review`) and as the `{{ prefix }}` placeholder in all template
step strings. The parent key (`invoice_check`) is discarded after expansion.

### Param declaration reference

| Field      | Type    | Description                                                         |
| ---------- | ------- | ------------------------------------------------------------------- |
| `required` | boolean | If `true`, the caller must supply this param. Missing → load error. |
| `default`  | string  | Used when the caller does not supply the param.                     |

Unknown params passed at the call site are silently ignored (forward compatibility).

### Complete end-to-end example

```yaml
id: document-pipeline
name: Document Pipeline
version: 1

services:
  documents:
    adapter: filesystem
    trust: engine_delivered

templates:
  fetch_and_review:
    params:
      service_name:
        required: true
      agent_description:
        default: 'Review the document.'
    steps:
      fetch:
        description: 'Fetch from {{ service_name }}'
        execution: auto
        depends_on: []
        uses_service: '{{ service_name }}'
        operation: read
        input_map:
          path: run.params.path
      review:
        description: '{{ agent_description }}'
        execution: agent
        depends_on: ['{{ prefix }}_fetch']

steps:
  doc_pipeline:
    use_template: fetch_and_review
    prefix: doc
    params:
      service_name: documents
      agent_description: 'Review the fetched document for completeness.'
```

This expands to two concrete steps: `doc_fetch` and `doc_review`.

---

## Agent profiles

An `execution: agent` step can declare a reusable persona via the `agent_profile` field. The persona is defined in a Markdown file and delivered verbatim to the agent at step entry.

```yaml
profiles_dir: profiles # relative to workflow YAML; defaults to profiles/

steps:
  review_security:
    execution: agent
    agent_profile: security-reviewer # reads profiles/security-reviewer.md
```

### Registration lifecycle

Profile content is resolved at **registration time**, not at runtime. When you run `realm workflow register`, the loader reads every referenced `.md` file from `profiles_dir`, computes a SHA-256 hash, and bakes both the content and hash into the stored workflow definition at `~/.realm/workflows/<id>.json`. After registration the `profiles/` directory on disk is not consulted again.

Consequences of this model:

- **Editing a profile file has no effect until you re-run `realm workflow register`.**
- Multiple steps referencing the same profile name are resolved once — the file is read and hashed a single time.
- If any referenced file is missing at registration time, the command fails immediately and includes the expected file path in the error message.

### Runtime delivery

When a consumer calls `get_workflow_protocol`, the full profile content is included in the step's `agent_profile_instructions` field. No file system access is needed at runtime — the content is served from the stored definition over MCP.

The profile name and its SHA-256 hash are recorded in the evidence snapshot for every step that ran with a profile. `realm run inspect` displays them as `[profile: <name>]` annotations.

---

## Prompt templates

The `prompt` field supports template references resolved at runtime:

| Syntax                               | Resolves to                                                                |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `{{ context.resources.STEP.FIELD }}` | Value of `FIELD` in the evidence output of `STEP`                          |
| `{{ run.params.FIELD }}`             | Value of `FIELD` in the run's `params`                                     |
| `{{ workflow.context.NAME }}`        | Content of the named workflow context entry, wrapped per `context_wrapper` |
| `{{ workflow.context.NAME.raw }}`    | Raw content of the named workflow context entry, no wrapping               |

Unresolved references are left as literal strings.

---

## Workflow context

The `workflow_context` section declares named files that are loaded once at run start
and made available in every step prompt. This is the correct place for standing workflow
configuration — canonical schemas, output format rules, domain glossaries, brand guidelines
— anything that applies to multiple steps without being specific to one run.

```yaml
workflow_context:
  canonical_schema:
    source:
      path: ./schema.json # relative to the workflow YAML file
    description: 'Field definitions and output rules' # optional

  brand_guidelines:
    source:
      path: ./guidelines.md

context_wrapper: xml # optional; default is xml
```

In a step prompt:

```yaml
steps:
  extract_fields:
    execution: agent
    depends_on: []
    prompt: |
      Extract the required fields using the schema below.

      {{ workflow.context.canonical_schema }}

      Source document: {{ context.resources.fetch_doc.text }}
```

With `context_wrapper: xml` (the default), `{{ workflow.context.canonical_schema }}` resolves to:

```
<canonical_schema>
{file content}
</canonical_schema>
```

For inline references where block-level wrapping would be awkward, use `.raw`:

```yaml
prompt: |
  The allowed output format is {{ workflow.context.output_format.raw }}.
  Apply it to every field you extract.
```

### Entry fields

| Field         | Type   | Required | Description                                                                         |
| ------------- | ------ | -------- | ----------------------------------------------------------------------------------- |
| `source.path` | string | Yes      | File path relative to the workflow YAML. Resolved to absolute at registration time. |
| `description` | string | No       | Human-readable description of what the file contains.                               |

### `context_wrapper` values

| Value      | Result for `{{ workflow.context.NAME }}`   |
| ---------- | ------------------------------------------ |
| `xml`      | `<NAME>\n{content}\n</NAME>` **(default)** |
| `brackets` | `[NAME]\n{content}\n[/NAME]`               |
| `none`     | Raw content, same as `.raw`                |

`{{ workflow.context.NAME.raw }}` always returns raw content regardless of `context_wrapper`.

### Naming constraints

Entry names must match `[\w.]+` (letters, digits, underscores, and dots — no hyphens). Names
ending in `.raw` are rejected because `.raw` is the reserved accessor suffix.

### How context is loaded

Files are read on the first `execute_step` call for each run — not at registration time. The
content is snapshotted into the run record under `workflow_context_snapshots`, separate from
step evidence. The snapshot is reused for all subsequent steps in the same run. Editing a
file on disk takes effect at the next run start without re-registration.

If a file cannot be read (missing path, permission error), an error snapshot is recorded and
execution continues. The template reference is left unresolved in the delivered prompt.

### `schema.json` auto-registration

If `schema.json` is present in the workflow directory and no `workflow_context.schema` entry
is explicitly declared, the loader automatically registers it as `workflow.context.schema`.
This makes it possible to place a JSON Schema next to `workflow.yaml` with zero extra
configuration.

### Lint warning

`realm workflow register` prints a warning when the same context entry is referenced in more
than half of the agent step prompts in the workflow. This is advisory — registration succeeds
regardless.

---

## Protocol customisation

```yaml
protocol:
  quick_start: "Call start_run with workflow_id 'my-workflow'..."
  rules:
    - 'Always confirm with the user before writing to the target system.'
```

`quick_start` overrides the generated instructions paragraph in `get_workflow_protocol`. `rules` replaces the default rule set entirely — include the defaults if you still want them.

---

## Built-in handlers

Two handlers are available in every Realm instance without registration. Declare them with
`handler:` on any `execution: auto` step, and configure them with a `config:` block.

### `validate_verbatim_quotes`

Verifies that AI-extracted quotes appear verbatim in a source document.

| Config key     | Required | Default            | Description                                                 |
| -------------- | -------- | ------------------ | ----------------------------------------------------------- |
| `source_step`  | Yes      | —                  | Name of the prior step that produced the source text.       |
| `source_field` | No       | `"text"`           | Field in the source step's output holding the source text.  |
| `quote_field`  | No       | `"verbatim_quote"` | Field in each candidate object holding the quote to verify. |

**Inputs:** `candidates` — array of objects, each containing a `quote_field` value.

**Output:** `{ accepted, rejected, accepted_count, rejected_count, candidates_found }`

`candidates_found` (`accepted_count + rejected_count`) is the key diagnostic: it
distinguishes "nothing was extracted" from "all extracted were invalid".

```yaml
validate_quotes:
  description: 'Verify extracted quotes appear verbatim in the source document.'
  execution: auto
  handler: validate_verbatim_quotes
  depends_on: [extract_quotes]
  config:
    source_step: fetch_document
    source_field: text
```

### `validate_field_match`

Reads a field from a prior step's output and compares it against a pattern. Use this as a
guard to verify that a fetched resource belongs to the expected entity.

| Config key     | Required | Default   | Description                                     |
| -------------- | -------- | --------- | ----------------------------------------------- |
| `source_step`  | Yes      | —         | Name of the prior step that produced the value. |
| `source_field` | Yes      | —         | Field in that step's output to read.            |
| `pattern`      | Yes      | —         | Value or pattern to compare against.            |
| `mode`         | No       | `"exact"` | `"exact"`, `"prefix"`, or `"regex"`.            |

**Output:** `{ matched, value, pattern, mode }`

This handler **never throws on mismatch** — `matched: false` is a valid outcome that the
workflow handles via preconditions on downstream steps.

```yaml
verify_repo:
  description: 'Verify the fetched diff belongs to the expected repository.'
  execution: auto
  handler: validate_field_match
  depends_on: [fetch_diff]
  config:
    source_step: fetch_diff
    source_field: repo_full_name
    pattern: 'myorg/.*'
    mode: regex
```

For handler authoring details, interface signatures, primitives, and registration patterns, see
[Handler Authoring Reference](handlers.md).

---

## MCP servers

Defines external MCP servers that steps may call tools on. Each server has a unique `id`.
Step tool declarations reference server entries via `server_id:tool_name` in the `tools` field.

```yaml
mcp_servers:
  - id: github # required; unique within this workflow
    transport: stdio # required; only 'stdio' is supported
    command: npx # required for stdio transport
    args:
      - -y
      - '@modelcontextprotocol/server-github'
    env:
      GITHUB_TOKEN: '${GITHUB_TOKEN}' # ${VAR} is expanded from process.env at connect time
```

| Field       | Required | Description                                                                      |
| ----------- | -------- | -------------------------------------------------------------------------------- |
| `id`        | Yes      | Unique server identifier within this workflow. Used in `tools` field references. |
| `transport` | Yes      | Transport type. Currently only `stdio` is supported.                             |
| `command`   | Yes      | Executable to launch (e.g. `npx`, `node`, absolute path).                        |
| `args`      | No       | Arguments passed to `command`.                                                   |
| `env`       | No       | Environment variables for the server process. Values support `${VAR}` expansion. |

`env` values support `${VAR}` substitution resolved from `process.env` at connect time.
An unresolved variable causes the run to fail with `MCP_CONNECTION_FAILED` at the point
where the first tool call for that server is attempted.

---

## Webhook trigger

The optional top-level `trigger` block makes a workflow reachable over HTTP: [`realm listen`](cli-commands.md#realm-listen)
loads every workflow with a `trigger` block, builds a route table, and turns each verified inbound
webhook into a run. The whole block is validated at register time (fail-closed — unknown/typo'd keys
are rejected, every `auth` mode is a closed field set).

```yaml
# A Gorgias-style shared_secret trigger.
trigger:
  type: webhook
  path: /gorgias-tickets # optional; defaults to /<workflow-id>
  auth:
    mode: shared_secret
    header: Authorization # request header carrying the token (matched case-insensitively)
    secret_from: GORGIAS_WEBHOOK_TOKEN # env var holding the EXACT expected header value
  filter:
    all:
      - { path: body.type, value: [ticket-created, ticket-message-created] }
  dedup:
    id_from: body.id # dot-path; root is { headers, body }
  params_map:
    ticket_id: body.id
```

| Field        | Type              | Required | Description                                                                                                                 |
| ------------ | ----------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `type`       | `webhook`         | Yes      | Only `webhook` is supported.                                                                                                |
| `path`       | string            | No       | URL path `realm listen` mounts this workflow at. Default `/<workflow-id>`. A collision across workflows is a startup error. |
| `auth`       | object            | Yes      | Verification config, discriminated on `mode` (see below).                                                                   |
| `filter`     | object            | No       | Optional pre-dispatch match. See [filter](#filter).                                                                         |
| `dedup`      | object \| `false` | No       | Duplicate-delivery suppression (default on). See [dedup](#dedup).                                                           |
| `params_map` | object            | No       | Maps run params from the payload. See [params_map](#params_map).                                                            |

### `auth`

`auth.mode` selects the verification model. Each mode is a **closed** field set — a field belonging to
another mode (e.g. `algorithm` on a `github` auth) is rejected at load. Verification runs before
filtering and dedup; a failure returns `403`.

| Mode            | Required fields         | Optional fields                                                                                                     | Verification                                                                                              |
| --------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `shared_secret` | `header`, `secret_from` | —                                                                                                                   | The request header `header` must equal `env[secret_from]` (exact, timing-safe). The Gorgias model.        |
| `github`        | `secret_from`           | —                                                                                                                   | `X-Hub-Signature-256` HMAC-SHA256 of the raw body against `env[secret_from]`.                             |
| `stripe`        | `secret_from`           | `max_age_seconds` (integer ≥ 1)                                                                                     | `Stripe-Signature` timestamped HMAC; `max_age_seconds` bounds the replay window.                          |
| `hmac`          | `secret_from`, `header` | `algorithm` (`sha1`\|`sha256`\|`sha512`), `encoding` (`hex`\|`base64`), `timestamp_header`, `max_age_seconds` (≥ 1) | Generic HMAC of the raw body in `header`; `algorithm` defaults `sha256`, `encoding` defaults `hex`.       |
| `none`          | —                       | —                                                                                                                   | **Verification disabled.** Trusted-network/localhost only (discouraged); `realm listen` warns at startup. |

All string fields (`header`, `secret_from`, `timestamp_header`) must be non-empty. `secret_from` is the
**name of an environment variable**, resolved at `realm listen` startup (a missing var is a startup
error, not a per-request failure).

### `filter`

Optional. `{ all: [ … ] }` — 1 to 8 conditions combined with AND; the request is dispatched only if
every condition matches, otherwise `realm listen` responds `200 { status: "ignored" }`. A shorthand
single condition (a bare `{ header|path, value }`) is normalised to `{ all: [ … ] }` at load.

Each condition has **exactly one** of:

- `header` — a request header name (matched against the lowercased header map), or
- `path` — a dot-path resolved against `{ headers, body }`,

plus `value` — a non-empty string, or a non-empty array of non-empty strings (matches if the resolved
value equals the string, or is one of the array entries).

### `dedup`

Optional, **on by default**. Set `dedup: false` to disable. Otherwise an object:

| Field           | Type               | Required | Description                                                                                       |
| --------------- | ------------------ | -------- | ------------------------------------------------------------------------------------------------- |
| `id_from`       | string (dot-path)  | Yes      | Non-empty dot-path to the unique event ID, resolved against `{ headers, body }` (e.g. `body.id`). |
| `ttl_minutes`   | integer            | No       | Dedup window, `1`–`10080` (7 days). Default `60`.                                                 |
| `on_missing_id` | `skip` \| `reject` | No       | When `id_from` resolves to nothing: `skip` (default — proceed without dedup) or `reject` (`400`). |

A duplicate within the window returns `200 { status: "deduplicated" }`. Dedup is at-least-once
(best-effort in-flight store + the run store's idempotency key as the cross-restart backstop).

### `params_map`

Optional `Record<string, string>` — run-param name → dot-path into `{ headers, body }`. Values must be
non-empty strings. The dot-path root key is **`headers`** (plural) and **`body`**; a singular `header.…`
silently resolves to nothing. Extracted params are validated against the workflow's `params_schema`
before the run is created (invalid → `400`).

> **Note:** the `trigger` block configures _how a webhook reaches the workflow_; it does not change the
> workflow's steps. It has no effect unless the workflow is served by `realm listen`.

---

## Project extensions

```yaml
# workflow.yaml
extensions: ../../dist/registry.js # string | string[] — RELATIVE paths only
```

Declares the ES module(s) providing this workflow's custom adapters, step handlers, and
processors. Every step-executing or config-validating entry point (`run`, `agent`, `listen`
children, `serve`, `mcp`, `test`, `validate`, `register`, `watch`) resolves the same declaration
identically — no bespoke MCP wrappers or per-command wiring.

**Contract:**

- `string | string[]` — one or more module paths. Empty strings and empty arrays are rejected.
- Paths are **relative to the workflow directory** — absolute paths are rejected at load time.
- Requires **file-based loading**: registering the same YAML from a string (or via the MCP
  `create_workflow` tool) is a hard error — there is no directory context to resolve against.
- Each module's **default export** is a declarative object (see
  [Project extensions guide](project-extensions.md) for the full contract):

```js
// registry.js
export default {
  adapters: { gorgias: new GorgiasAdapter('gorgias', { ... }) },
  handlers: { check_offer_phrase_handler: myHandler },
  processors: { normalize_offer: myProcessor },
};
```

**Trust-root containment:** at registration time the loader records the workflow directory
(`source_dir`) and its **trust root** — the nearest ancestor directory containing `package.json`
or `.git` (falling back to the workflow directory itself). Declared paths resolve against the
workflow directory and must land (realpath-resolved, symlinks included) **inside the trust
root**; anything escaping it is refused. This keeps declarations like `../../dist/registry.js`
working in a normal project layout while making the workflow store unusable as a
load-arbitrary-code vector.

**TypeScript:** compiled JS is the default. A declared `.ts`/`.mts` path loads through
[`jiti`](https://github.com/unjs/jiti) **resolved from your project's own `node_modules`** —
install it there (`npm install --save-dev jiti`) or compile to JS. jiti is never resolved from
the Realm CLI install.

See the full [Project extensions guide](project-extensions.md) for the module contract,
collision/precedence rules, and the trust model.
