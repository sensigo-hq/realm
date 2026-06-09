# YAML Schema Reference

Complete reference for `workflow.yaml` fields. Every field documented here is validated at `realm workflow register` time — errors include the field name and expected type.

---

## Top-level fields

| Field              | Type    | Required | Description                                                                                                                  |
| ------------------ | ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `id`               | string  | Yes      | Unique workflow identifier. Used in all CLI commands and MCP tool calls.                                                     |
| `name`             | string  | Yes      | Human-readable workflow name.                                                                                                |
| `version`          | integer | Yes      | Workflow version number. Incremented on each `realm workflow register`.                                                      |
| `params_schema`    | object  | No       | JSON Schema for the params accepted by `start_run`. The agent's `call_with.params` skeleton is derived from this at runtime. |
| `services`         | object  | No       | Named service definitions. Referenced by steps via `uses_service`.                                                           |
| `steps`            | object  | Yes      | Map of step name → step definition.                                                                                          |
| `protocol`         | object  | No       | Optional protocol customisations. See [Protocol](#protocol-customisation).                                                   |
| `profiles_dir`     | string  | No       | Path to agent profile files, relative to the workflow YAML. Defaults to `profiles/` in the same directory.                   |
| `workflow_context` | object  | No       | Named file entries loaded once at run start and available in all step prompts. See [Workflow context](#workflow-context).    |
| `context_wrapper`  | string  | No       | Wrapper format applied to `{{ workflow.context.NAME }}` references. One of `xml` (default), `brackets`, `none`.              |

---

## Step fields

| Field             | Type                            | Required | Description                                                                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`     | string                          | Yes      | Human-readable step description. Appears in the agent protocol.                                                                                                                                                                                                                                                |
| `execution`       | `agent` \| `auto`               | Yes      | Who executes this step.                                                                                                                                                                                                                                                                                        |
| `depends_on`      | string[]                        | No       | Step IDs this step waits for. Empty array or omitted means eligible from run start.                                                                                                                                                                                                                            |
| `trigger_rule`    | string                          | No       | When to evaluate dependency satisfaction. Default: `all_success`. See [`trigger_rule`](#trigger_rule).                                                                                                                                                                                                         |
| `when`            | string                          | No       | Expression evaluated against prior step evidence. A step is ineligible until this is truthy. See [`when` condition](#when-condition).                                                                                                                                                                          |
| `uses_service`    | string                          | No       | Name of a service declared in `services`. Only valid on `execution: auto` steps.                                                                                                                                                                                                                               |
| `service_method`  | `fetch` \| `create` \| `update` | No       | Adapter method to call. Defaults to `fetch`.                                                                                                                                                                                                                                                                   |
| `operation`       | string                          | No       | Operation name passed to the adapter. Defaults to the step name.                                                                                                                                                                                                                                               |
| `handler`         | string                          | No       | Name of a registered `StepHandler` to invoke. Only valid on `execution: auto` steps.                                                                                                                                                                                                                           |
| `config`          | object                          | No       | Static key-value configuration passed to the handler via `context.config`. Only meaningful on `execution: auto` steps with a `handler`.                                                                                                                                                                        |
| `input_schema`    | object                          | No       | JSON Schema validated against the agent's submitted `params` before execution.                                                                                                                                                                                                                                 |
| `preconditions`   | string[]                        | No       | Boolean expressions evaluated before the step runs. See [Preconditions](#preconditions).                                                                                                                                                                                                                       |
| `trust`           | string                          | No       | Human oversight level. See [Trust levels](#trust-levels).                                                                                                                                                                                                                                                      |
| `timeout_seconds` | integer                         | No       | Step execution timeout in seconds. On expiry the run fails with `STEP_TIMEOUT`.                                                                                                                                                                                                                                |
| `retry`           | object                          | No       | Retry configuration. See [Retry](#retry).                                                                                                                                                                                                                                                                      |
| `instructions`    | string                          | No       | Agent-facing instructions. Delivered as `gate.agent_hint` when a gate is open.                                                                                                                                                                                                                                 |
| `prompt`          | string                          | No       | Template-resolved task prompt delivered via `next_actions[].prompt`. On human gate steps, delivered as `gate.display`. Supports `{{ context.resources.STEP.FIELD }}` and `{{ run.params.FIELD }}`.                                                                                                             |
| `gate`            | object                          | No       | Gate configuration. `gate.choices` lists the valid human response values.                                                                                                                                                                                                                                      |
| `input_map`       | `Record<string, string>`        | No       | Maps param names the service adapter receives to dot-path values from the run context. Only valid on `execution: auto` steps with `uses_service`. Each value is a dot-path: `run.params.<key>` reads from the run's start params; `context.resources.<step>.<field>` reads a field from a prior step's output. |
| `agent_profile`   | string                          | No       | Agent profile name. Only valid on `execution: agent` steps. Must match a file in `profiles_dir`.                                                                                                                                                                                                               |

---

## Execution modes

### `execution: agent`

The engine pauses and returns `next_actions` containing this step. The AI agent (or `realm run` in dev mode) calls `execute_step` with the step's `command` and `params`. The engine validates `params` against `input_schema` before proceeding.

### `execution: auto`

The engine executes this step immediately without returning to the caller. If the step declares `uses_service`, the engine calls the registered adapter. If it declares `handler`, the engine calls the registered `StepHandler`. Auto steps chain automatically: after any step completes, if the next step is `auto`, the engine runs it immediately and repeats until it reaches an agent step, a human gate, or a terminal state.

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

**Supported operators:** `==`, `!=`, `>`, `<`, `>=`, `<=`. The left side is a dot-path into prior step evidence (`step_name.field_name`). The right side is a quoted string, an unquoted number, `true`, `false`, or `null`.

`when` conditions are evaluated against each step's recorded `output_summary`. Comparison is strict — types must match (`"1"` does not equal `1`).

A step whose `when` condition is permanently false is not automatically moved to `skipped_steps` — it stays ineligible. Only `trigger_rule` impossibility triggers automatic skipping.

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

## Retry

```yaml
fetch_document:
  execution: auto
  uses_service: source
  retry:
    max_attempts: 3
    backoff: exponential
    base_delay_ms: 1000
```

| Field           | Type                                 | Description                         |
| --------------- | ------------------------------------ | ----------------------------------- |
| `max_attempts`  | integer                              | Total attempts including the first. |
| `backoff`       | `linear` \| `exponential` \| `fixed` | Delay growth strategy.              |
| `base_delay_ms` | integer                              | Base delay in milliseconds.         |

---

## Services

```yaml
services:
  source:
    adapter: google_docs
    auth:
      token_from: secrets.GDOCS_TOKEN
    trust: engine_delivered
```

| Field             | Type   | Description                                                   |
| ----------------- | ------ | ------------------------------------------------------------- |
| `adapter`         | string | Name of a registered `ServiceAdapter`.                        |
| `auth.token_from` | string | Secret key path. Resolved at runtime from the loaded secrets. |
| `trust`           | string | Service trust level. See below.                               |

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
