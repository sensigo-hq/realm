# Workflow file: step fields

This page lists every field a step can have. There are 36, taken from the list the loader checks steps against. For each one it says which kinds of step can use it, its type and default, and what it does. One example file that uses all of them is at the end.

For the fields at the top of the file, see [Top-level fields](top-level-fields.md).

## Which field goes on which kind of step

`yes` means the field is used. `no` means the file is refused when it is loaded. `–` means the field is accepted and has no effect on that kind of step; for some of these the loader prints a warning. `n/a` marks `use_template`, whose entry is replaced by a template's steps before the kind of step is looked at.

| Field                   | `auto` | `agent` | `guard` | `finalizer` |
| ----------------------- | ------ | ------- | ------- | ----------- |
| `description`           | yes    | yes     | yes     | yes         |
| `execution`             | yes    | yes     | yes     | yes         |
| `use_template`          | n/a    | n/a     | n/a     | n/a         |
| `depends_on`            | yes    | yes     | yes     | no          |
| `trigger_rule`          | yes    | yes     | no      | no          |
| `when`                  | yes    | yes     | yes     | no          |
| `preconditions`         | yes    | yes     | no      | –           |
| `uses_service`          | yes    | –       | no      | no          |
| `service_method`        | yes    | –       | no      | no          |
| `operation`             | yes    | –       | no      | no          |
| `input_map`             | yes    | no      | no      | no          |
| `handler`               | yes    | yes     | no      | yes         |
| `config`                | yes    | –       | –       | yes         |
| `timeout_seconds`       | yes    | no      | no      | yes         |
| `retry`                 | yes    | –       | –       | no          |
| `idempotent`            | yes    | no      | no      | no          |
| `prompt`                | yes    | yes     | –       | –           |
| `instructions`          | yes    | yes     | –       | –           |
| `agent_profile`         | no     | yes     | no      | no          |
| `input_schema`          | yes    | yes     | no      | –           |
| `output_schema`         | no     | yes     | no      | no          |
| `structured_output`     | no     | yes     | no      | no          |
| `validation_exhaustion` | no     | yes     | no      | no          |
| `llm_timeout_seconds`   | no     | yes     | no      | no          |
| `tools`                 | no     | yes     | no      | no          |
| `max_tool_calls`        | –      | yes     | –       | –           |
| `max_fan_out`           | –      | yes     | –       | –           |
| `tool_timeout`          | no     | yes     | no      | no          |
| `trace_schema`          | no     | yes     | no      | no          |
| `trace_validation_mode` | no     | yes     | no      | no          |
| `trust`                 | yes    | yes     | no      | no          |
| `gate`                  | yes    | yes     | –       | –           |
| `display`               | yes    | yes     | –       | –           |
| `abort_unless`          | no     | no      | yes     | no          |
| `abort_message`         | no     | no      | yes     | no          |
| `on_outcome`            | no     | no      | no      | yes         |

Three fields have a further condition:

- `tools` needs `input_schema` on the same step, and `mcp_servers` at the top of the file.
- `tool_timeout` needs `tools` on the same step.
- `structured_output` needs an `input_schema` or `output_schema` that the model provider can enforce.

## What the step is

| Field          | Type                                    | Default  | What it does                                                                                                                                                                             |
| -------------- | --------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`  | string                                  | Required | What the step is for. Shown to assistants and in the record.                                                                                                                             |
| `execution`    | `auto`, `agent`, `guard` or `finalizer` | Required | The kind of step. See [Step kinds](../../concepts/step-kinds.md).                                                                                                                        |
| `use_template` | string                                  | None     | Replaces this entry with the steps of a template. The entry then takes `prefix` and `params` and no other field. See [Services, profiles and context](services-profiles-and-context.md). |

## When the step runs

| Field           | Type                                                                                  | Default       | What it does                                                                                         |
| --------------- | ------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `depends_on`    | list of step names                                                                    | None          | Steps that must be settled before this one can run.                                                  |
| `trigger_rule`  | `all_success`, `all_failed`, `all_done`, `one_failed`, `one_success` or `none_failed` | `all_success` | Which results of the `depends_on` steps let this step run.                                           |
| `when`          | condition, or list of conditions                                                      | None          | The step runs only if every condition is true; otherwise it is skipped.                              |
| `preconditions` | list of conditions                                                                    | None          | Checked when the step is called. If one is false, the step is blocked and can be called again later. |

See [Conditions](conditions.md) for how conditions are written, and [Order and routing](../../concepts/order-and-routing.md) for how these four fields work together.

## What an auto step does

| Field             | Type                                    | Default              | What it does                                                                                                |
| ----------------- | --------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `uses_service`    | string                                  | None                 | The name of a service from the top-level `services` block to call.                                          |
| `service_method`  | `fetch`, `create`, `update` or `delete` | `fetch`              | Which method of the adapter is called.                                                                      |
| `operation`       | string                                  | The step name        | The operation name passed to the adapter.                                                                   |
| `input_map`       | map                                     | None                 | Builds the step input from run parameters and earlier outputs.                                              |
| `handler`         | string                                  | None                 | The name of a handler to run.                                                                               |
| `config`          | map                                     | None                 | Fixed settings passed to the handler, or merged into the adapter settings.                                  |
| `timeout_seconds` | whole number                            | 3600 on `auto` steps | The longest one attempt may take, in seconds.                                                               |
| `retry`           | map                                     | None                 | Tries the step again after an error marked as retryable.                                                    |
| `idempotent`      | true or false                           | false                | States that the step is safe to run again. Needed for `retry.on_timeout` and for `realm run reclaim --all`. |

See [Input maps, template expressions and filters](input-map-and-templates.md) and [Retry and timeouts](retry-and-timeouts.md).

## What an agent step is given and must return

| Field                   | Type                              | Default     | What it does                                                                                                        |
| ----------------------- | --------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `prompt`                | string, with `{{ … }}` references | None        | The task, sent with the step when it becomes the next action.                                                       |
| `instructions`          | string                            | None        | Standing instructions for the step, returned by `get_workflow_protocol`.                                            |
| `agent_profile`         | string                            | None        | The name of a profile file whose text is given to the agent.                                                        |
| `input_schema`          | JSON Schema                       | None        | On an agent step, the shape the answer must have. On an auto step, the shape the step's input must have.            |
| `output_schema`         | JSON Schema                       | None        | Also checks the answer. If both schemas are declared, the answer must fit both, and the loader advises keeping one. |
| `structured_output`     | `strict`                          | None        | Asks the model provider to hold answers to the schema, under `realm agent`.                                         |
| `validation_exhaustion` | map                               | threshold 6 | How many refused answers end the step, and what happens then.                                                       |
| `llm_timeout_seconds`   | whole number                      | None        | The longest one model request may take, under `realm agent`.                                                        |
| `tools`                 | list of `server:tool`             | None        | The tools the model may call, under `realm agent`.                                                                  |
| `max_tool_calls`        | whole number                      | 20          | The most tool calls in one run of the step.                                                                         |
| `max_fan_out`           | whole number                      | No limit    | The most `start_run` and `start_run_batch` tool calls.                                                              |
| `tool_timeout`          | whole number                      | 30          | The longest one tool call may take, in seconds. Requires `tools`.                                                   |
| `trace_schema`          | JSON Schema                       | None        | The shape of the trace entries an assistant records for the step.                                                   |
| `trace_validation_mode` | `warn` or `enforce`               | `warn`      | Whether a trace that does not fit is reported or refused.                                                           |

See [Agent-step controls](agent-step-controls.md) and [JSON Schema blocks](json-schema-blocks.md).

## Human gates and display

| Field     | Type                                          | Default | What it does                                                            |
| --------- | --------------------------------------------- | ------- | ----------------------------------------------------------------------- |
| `trust`   | `auto`, `human_confirmed` or `human_reviewed` | `auto`  | `human_confirmed` and `human_reviewed` make the step stop for a person. |
| `gate`    | map                                           | None    | The choices, message, time limit and reminders of the gate.             |
| `display` | string, with `{{ field }}` references         | None    | How `realm agent` prints the step's result and its gate preview.        |

See [Gates](gates.md).

## Guards

| Field           | Type                             | Default             | What it does                                        |
| --------------- | -------------------------------- | ------------------- | --------------------------------------------------- |
| `abort_unless`  | condition, or list of conditions | Required on a guard | The run is aborted if any condition is false.       |
| `abort_message` | string                           | None                | The message recorded when the guard aborts the run. |

A guard is never called. It is decided inside the write that makes it ready: a step that finishes, an answer to a gate, or a gate whose time runs out. The reply to that call says what the guard did. See [The reply](../mcp/tools.md#the-reply).

A guard that is already ready when a run is created or resumed is not decided by that act. It is decided by the run's next such write. A workflow whose only first step is a guard has no such write, so that guard is never decided. The run then carries the finding [`guard_awaiting_settlement`](../mcp/run-state-and-health.md#the-14-findings).

If a condition refers to a value that does not exist, the run fails, and is not recorded as aborted. The same holds for a guard whose `when` or `abort_unless` cannot be evaluated at all: the guard is recorded as failed, and the write that made it ready still succeeds.

## Finalizers

| Field        | Type                                                                                    | Default                 | What it does                           |
| ------------ | --------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------- |
| `on_outcome` | `complete`, `fail`, `abort`, `always`, `completed_with_failed_steps`, or a list of them | Required on a finalizer | The endings after which the step runs. |

A finalizer needs a `handler`. See [Handle failure](../../guides/handle-failure.md#clean-up-when-a-run-ends).

## Fields that are required

Every step needs `description` and `execution`. A guard needs `abort_unless`. A finalizer needs `handler` and `on_outcome`. The loader names what is missing:

```text
Invalid workflow: Step 'a': missing required field 'description' (step at line 5)
Invalid workflow: Step 'a': invalid execution value 'manual'; must be 'auto', 'agent', 'guard', or 'finalizer' (step at line 5)
Invalid workflow: Step 'g': execution: guard requires 'abort_unless' (step at line 8)
Invalid workflow: Step 'f': execution: finalizer requires 'on_outcome' (step at line 8)
Invalid workflow: Step 'f': execution: finalizer requires 'handler' (handler-only in v1) (step at line 8)
```

## Any other field

A field that is not in the table makes `realm workflow validate` and `realm workflow register` fail:

```text
⚠ step 'a': unknown key 'colour' (line 8) — ignored (not a recognized step field).
Invalid: 1 warning, 1 escalated to an error by policy: UNKNOWN_STEP_KEY 'colour'
```

Fields that start with `x-` are for the top of the file only. On a step they are refused too.

## A field on the wrong kind of step

A `no` in the first table is a refusal that says why. For example, `timeout_seconds` on an agent step:

```text
Invalid workflow: Step 's': 'timeout_seconds' is not valid on execution: agent steps — the engine never enforces it there (agent dispatch is never wrapped in a timeout), so the step would LOOK time-bounded while nothing enforced the bound. In realm's own drive the model request is bounded by 'llm_timeout_seconds' (or --llm-timeout) and tool calls by 'tool_timeout'. (line 21)
```

A `–` is accepted. Where the loader can tell that the field will do nothing, it says so and still accepts the file. For example, `retry` on an agent step:

```text
⚠ Step 's': 'retry' is inert on execution: 'agent' steps — the built-in dispatch path never throws for agent steps, so this block can never mint a second attempt here (for schema-repair budgets, use the CLI drive's '--schema-retries' flag instead). An embedder-supplied throwing dispatcher may still consume this config — a deliberate public-API capability, not an invalid one.
```

## A file that uses every field

This file uses the 35 fields that a step itself can carry; `use_template` is shown in [Top-level fields](top-level-fields.md#templates). The file was validated, registered and run to completion.

```yaml
id: every-step-field
name: Every step field
version: 1
extensions: ./registry.mjs

params_schema:
  type: object
  additionalProperties: false
  required: [path]
  properties:
    path:
      type: string

services:
  files:
    adapter: filesystem
    trust: engine_delivered

mcp_servers:
  - id: notes
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-filesystem', './notes']

steps:
  read_note:
    description: Read the note from disk.
    execution: auto
    uses_service: files
    service_method: fetch
    operation: read
    input_map:
      path: run.params.path
    timeout_seconds: 10
    idempotent: true
    retry:
      max_attempts: 2
      backoff: fixed
      base_delay_ms: 100

  not_empty:
    description: Stop if the note is empty.
    execution: guard
    depends_on: [read_note]
    abort_unless: "read_note.content != ''"
    abort_message: The note is empty.

  summarise:
    description: Summarise the note in one sentence.
    execution: agent
    depends_on: [not_empty]
    agent_profile: editor
    instructions: Use British spelling.
    prompt: |
      Summarise this note in one sentence:

      {{ context.resources.read_note.content }}
    display: 'Summary: {{ summary }}'
    tools:
      - notes:read_text_file
    max_tool_calls: 3
    max_fan_out: 1
    tool_timeout: 10
    llm_timeout_seconds: 60
    structured_output: strict
    validation_exhaustion:
      threshold: 3
    input_schema:
      type: object
      additionalProperties: false
      required: [summary]
      properties:
        summary:
          type: string
    output_schema:
      type: object
      additionalProperties: false
      required: [summary]
      properties:
        summary:
          type: string
    trace_schema:
      type: object
    trace_validation_mode: warn

  approve:
    description: A person decides whether the summary is published.
    execution: auto
    depends_on: [summarise]
    preconditions: ["summarise.summary != ''"]
    trust: human_confirmed
    gate:
      choices: [publish, discard]
      message: 'Publish this summary? {{ context.resources.summarise.summary }}'

  publish:
    description: Publish the summary.
    execution: auto
    depends_on: [approve]
    when: "approve.choice == 'publish'"
    trigger_rule: all_success
    handler: publish_note
    config:
      channel: news

  tidy:
    description: Remove temporary files, however the run ended.
    execution: finalizer
    handler: tidy_up
    on_outcome: always
```

`realm workflow validate ./` prints two advisories, then:

```text
Valid: every-step-field v1 (6 steps)
Extensions: ./registry.mjs (adapters: 0, handlers: 2, processors: 0)
```

The two advisories are about choices this example makes in order to show every field: `idempotent` beside a finalizer, and both schemas on one step.
