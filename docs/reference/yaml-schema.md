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

| Field             | Type                                        | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`     | string                                      | Yes      | Human-readable step description. Appears in the agent protocol.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `execution`       | `agent` \| `auto` \| `guard`                | Yes      | Who executes this step. See [Execution modes](#execution-modes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `depends_on`      | string[]                                    | No       | Step IDs this step waits for. Empty array or omitted means eligible from run start.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `trigger_rule`    | string                                      | No       | When to evaluate dependency satisfaction. Default: `all_success`. See [`trigger_rule`](#trigger_rule).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `when`            | string \| string[]                          | No       | Condition controlling step eligibility — a step is ineligible until truthy. A `string[]` is the implicit AND of its leaves. See [`when` condition](#when-condition).                                                                                                                                                                                                                                                                                                                                                                                                         |
| `uses_service`    | string                                      | No       | Name of a service declared in `services`. Only valid on `execution: auto` steps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `service_method`  | `fetch` \| `create` \| `update` \| `delete` | No       | Adapter method to call. Defaults to `fetch`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `operation`       | string                                      | No       | Operation name passed to the adapter. Defaults to the step name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `handler`         | string                                      | No       | Name of a registered `StepHandler` to invoke. Only valid on `execution: auto` steps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `config`          | object                                      | No       | Static key-value configuration passed to the handler via `context.config`, or merged into the adapter config for `uses_service` steps. Values may be any JSON value — scalars, arrays, **and nested objects**. For `uses_service` steps the adapter's `config_schema` is the validator. Only meaningful on `execution: auto` steps with a `handler` or `uses_service`.                                                                                                                                                                                                       |
| `input_schema`    | object                                      | No       | JSON Schema validated against the agent's submitted `params` before execution. Also drives the `call_with.params` skeleton returned to the agent in `next_actions`.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `output_schema`   | object                                      | No       | JSON Schema validated against the agent's submitted `params` before the engine claims the step. Only valid on `execution: agent` steps — declaring it on `execution: auto` steps is a loader error. Failed validation returns `agent_action: provide_input` and leaves the step unclaimed — immediately re-submittable without side effects.                                                                                                                                                                                                                                 |
| `preconditions`   | string[]                                    | No       | Boolean expressions evaluated before the step runs. See [Preconditions](#preconditions).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `trust`           | string                                      | No       | Human oversight level. See [Trust levels](#trust-levels).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `timeout_seconds` | integer                                     | No       | Step execution timeout in seconds. On expiry the run fails with `STEP_TIMEOUT`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `retry`           | object                                      | No       | Retry configuration. See [Retry](#retry).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `instructions`    | string                                      | No       | Agent-facing instructions. Delivered as `gate.agent_hint` when a gate is open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `prompt`          | string                                      | No       | Template-resolved task prompt delivered via `next_actions[].prompt`. On human gate steps, delivered as `gate.display`. Supports `{{ context.resources.STEP.FIELD }}` and `{{ run.params.FIELD }}`.                                                                                                                                                                                                                                                                                                                                                                           |
| `gate`            | object                                      | No       | Gate configuration. `gate.choices` lists the valid human response values. `gate.message` is a developer-authored template string shown to the human reviewer. See [Gate message](#gate-message).                                                                                                                                                                                                                                                                                                                                                                             |
| `input_map`       | `Record<string, InputMapNode>`              | No       | Maps param names to values from the run context. Valid on `execution: auto` steps with either `uses_service` or `handler`. Each value is a dot-path string (`run.params.<key>` or `context.resources.<step>.<field>`), a nested object whose leaves are dot-path strings, or a `{ $literal: <value> }` node holding a constant. See [input_map values and `$literal`](#input_map-values-and-literal). Maximum nesting depth is 10. The resolved params are recorded in the evidence chain as `resolved_params` and are visible in `realm run inspect` as a `Resolved:` line. |
| `agent_profile`   | string                                      | No       | Agent profile name. Only valid on `execution: agent` steps. Must match a file in `profiles_dir`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tools`           | `string[]`                                  | No       | Tool names this step may call, in `server_id:tool_name` format. Only valid on `execution: agent` steps with an `input_schema`. References entries in `mcp_servers`. All declared names must exist in the connected server — if any name is not found after `listTools()`, the step fails immediately with `MCP_TOOL_NOT_FOUND` before any LLM call is made. If two connected servers expose the same bare tool name within a single step, the step fails immediately with `MCP_TOOL_NAME_COLLISION`.                                                                         |
| `max_tool_calls`  | integer                                     | No       | Maximum number of tool calls the agent may make in a single step execution. Must be a positive integer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `max_fan_out`     | integer                                     | No       | Maximum number of `start_run` or `start_run_batch` MCP tool calls the agent may make in a single step execution. Once this limit is reached the agent enters final-extraction mode (same as `max_tool_calls` exhaustion) — no further fan-out calls are executed, but the response is returned cleanly. Must be a positive integer.                                                                                                                                                                                                                                          |
| `tool_timeout`    | integer                                     | No       | Timeout in seconds for each individual MCP tool call. Must be a positive integer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `abort_unless`    | string \| string[]                          | No       | One or more condition expressions evaluated against prior step evidence. If any condition is false, the run is aborted with `run_phase: 'aborted'`. Only valid on `execution: guard` steps. Absent path → `GUARD_RESOLUTION_ERROR` (`run_phase: 'failed'`, not `'aborted'`). See [execution: guard](#execution-guard).                                                                                                                                                                                                                                                       |
| `abort_message`   | string                                      | No       | Human-readable message recorded in the guard step's evidence entry and in `aborted_at.abort_message` when the run aborts. Only valid on `execution: guard` steps.                                                                                                                                                                                                                                                                                                                                                                                                            |

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

**Limitations:** `when:` supports a single expression only. A step that needs both a shadow guard and a data condition cannot express both in one `when:` clause — use `depends_on` with `trigger_rule` or a preceding guard step instead. The step name `run` is reserved and cannot be used as a step identifier.

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
