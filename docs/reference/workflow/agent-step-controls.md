# Agent-step controls

This page covers the settings that limit and shape what a model does on an `agent` step: how many wrong answers are allowed, whether the model provider is asked to hold answers to the schema, how long a model request may take, and how many tools the model may call. Each setting is shown with a result from a run.

| Setting                                           | Controls                                                      | Applies when                  |
| ------------------------------------------------- | ------------------------------------------------------------- | ----------------------------- |
| [`validation_exhaustion`](#validation_exhaustion) | How many refused answers end the step, and what happens then. | Always                        |
| [`structured_output`](#structured_output)         | Whether the provider holds answers to the step's schema.      | `realm agent` drives the step |
| [`llm_timeout_seconds`](#llm_timeout_seconds)     | How long one model request may take.                          | `realm agent` drives the step |
| [`tools`](#tools-and-the-tool-limits)             | Which tools the model may call.                               | `realm agent` drives the step |
| [`max_tool_calls`](#tools-and-the-tool-limits)    | How many tool calls the model may make.                       | `realm agent` drives the step |
| [`max_fan_out`](#tools-and-the-tool-limits)       | How many other runs the model may start.                      | `realm agent` drives the step |
| [`tool_timeout`](#tools-and-the-tool-limits)      | How long one tool call may take.                              | `realm agent` drives the step |

All of them are allowed on `agent` steps only. "`realm agent` drives the step" means the setting has no effect when an assistant connected over MCP does the step.

## `validation_exhaustion`

Every answer that Realm refuses against a step's `input_schema` or `output_schema` is counted. When the count reaches a limit, the step is ended.

| Key              | Type                              | Default | What it does                                                         |
| ---------------- | --------------------------------- | ------- | -------------------------------------------------------------------- |
| `threshold`      | whole number above 0              | 6       | The number of refused answers that ends the step.                    |
| `mode`           | `fail` or `default`               | `fail`  | `fail` fails the step. `default` completes it with `default_output`. |
| `default_output` | a value that fits `output_schema` | None    | The answer recorded for the step in `default` mode.                  |

Every agent step with a schema has the limit of 6, whether or not it has this block.

### `mode: fail`

With `threshold: 2`, the first refusal is an ordinary one:

```text
VALIDATION_INPUT_SCHEMA: /summary must NOT have fewer than 10 characters
agent_action: provide_input
```

Its `error_details` carry the count so far and the limit: `"rejections": 1, "threshold": 2`.

The second ends the step, and the run with it unless another step handles the failure:

```text
Step 'summarise' failed. Run is terminated.
VALIDATION_EXHAUSTED: Step 'summarise' exhausted its validation-rejection budget (2/2)
```

### `mode: default`

The step is completed with an answer you chose in advance, and the run carries on:

```yaml
classify:
  description: Classify the ticket.
  execution: agent
  output_schema:
    type: object
    additionalProperties: false
    required: [category]
    properties:
      category:
        type: string
        enum: [billing, technical, other]
  validation_exhaustion:
    threshold: 2
    mode: default
    default_output:
      category: other
```

After two refused answers, the reply to the second was `status: ok` with this warning:

```text
Step 'classify' settled with its declared default_output after 2 schema rejection(s) (validation_exhaustion.mode: 'default')
```

The record shows what was sent and what was recorded, and names the step as defaulted:

```text
Defaulted (settled by default): classify
…
  1. classify               success   0ms   hash: aefc126d
     Input:  {"category":"refunds"}
     Output: {"category":"other"}
```

`get_run_state` lists the step under `defaulted_steps`. A later step can tell the two cases apart with `$settlement.classify.settled_by_default`. See [Conditions](conditions.md#settlement).

### Rules

- `mode: default` needs `default_output`, and the step needs an `output_schema`. `default_output` is checked against that schema when the file is loaded:

  ```text
  Invalid workflow: Step 'a': 'validation_exhaustion.mode: default' requires 'default_output' (nothing to substitute on exhaustion) (step at line 5)
  Invalid workflow: Step 'a': 'validation_exhaustion.default_output' requires the step to declare 'output_schema' (an undeclared schema makes the default unvalidatable) (step at line 5)
  Invalid workflow: Step 'a': 'validation_exhaustion.default_output' does not validate against the step's own 'output_schema': … "message":"must be string" … (step at line 5)
  ```

- `threshold` must be a whole number above 0. With `threshold: 1` the first refused answer ends the step.
- `default_output` without `mode: default` is accepted with a warning that it is ignored.

## `structured_output`

```yaml
structured_output: strict
```

`strict` is the only value. It asks the model provider to restrict the model's answer to the step's schema while the answer is being produced, so that an answer of the wrong shape is not produced in the first place. The schema used is `output_schema` if the step has one, and `input_schema` otherwise. Realm still checks every answer itself.

It is off unless you set it.

### Which schemas can be used

Providers accept only some schemas for this. Realm checks the schema when the file is loaded, using Anthropic's rules, and refuses the file if the schema cannot be used:

```text
Invalid workflow: Step 'a': 'structured_output: strict' is not eligible for this step's schema — add 'additionalProperties: false' at 'the schema root'
```

When `realm agent` runs the step, the schema is checked again with the rules of the provider in use. These are the results of that check for 14 schemas, under both sets of rules:

| The schema has                                    | Anthropic rules                           | OpenAI rules                              |
| ------------------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| All required, plain types                         | used                                      | used                                      |
| No schema at all                                  | refused (`no_schema`)                     | refused (`no_schema`)                     |
| Root is not an object                             | refused (`no_schema`)                     | refused (`no_schema`)                     |
| Object without additionalProperties: false        | refused (`missing_additional_properties`) | refused (`missing_additional_properties`) |
| Nested object without additionalProperties: false | refused (`missing_additional_properties`) | refused (`missing_additional_properties`) |
| One optional property                             | used, with a note (`optional_emission`)   | refused (`not_all_required`)              |
| Optional written as a null union, all required    | used                                      | used, with a note (`null_union_emission`) |
| 25 optional properties                            | refused (`too_many_optionals`)            | refused (`not_all_required`)              |
| Minimum / maximum                                 | refused (`unsupported_keyword`)           | used                                      |
| MinLength                                         | used, with a note (`unenforced_keyword`)  | used                                      |
| Pattern                                           | used, with a note (`unenforced_pattern`)  | used                                      |
| Recursive ($ref to the root)                      | refused (`unsupported_keyword`)           | refused (`not_all_required`)              |
| 17 optional properties whose type is a union      | refused (`too_many_unions`)               | refused (`not_all_required`)              |
| Objects nested 11 deep                            | used                                      | refused (`exceeds_provider_limit`)        |

"Used, with a note" means strict mode is used and the named part of the schema is not enforced by the provider. Realm's own check still enforces it. The codes mean:

| Code                                       | Meaning                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `no_schema`                                | The step has no schema, or its top level is not `type: object`.                                                                                |
| `missing_additional_properties`            | An object in the schema does not say `additionalProperties: false`.                                                                            |
| `unsupported_keyword`                      | The schema uses a keyword that the provider rejects.                                                                                           |
| `too_many_optionals`                       | More than 24 properties are optional.                                                                                                          |
| `too_many_unions`                          | More than 16 optional properties have a union type.                                                                                            |
| `not_all_required`                         | A property is not listed in `required`. OpenAI requires every property to be listed.                                                           |
| `exceeds_provider_limit`                   | The schema is larger than one of OpenAI's limits, such as 10 levels of nesting.                                                                |
| `unsupported_context_tools`                | The step has `tools`. Its answer is then not restricted; see [below](#with-tools).                                                             |
| `unenforced_keyword`, `unenforced_pattern` | A keyword, or a `pattern`, that the provider does not enforce.                                                                                 |
| `unenforced_format`                        | A `format` value that the provider does not enforce. It cannot occur for a workflow file, because the loader refuses `format` in every schema. |
| `optional_emission`                        | The schema has an optional property. Under strict mode a model may leave it out more often.                                                    |
| `null_union_emission`                      | A property allows `null`. Under strict mode a model may answer `null` more often.                                                              |
| `tools_runtime_assessed`                   | The step has `tools`. Shown when the file is loaded; see [below](#with-tools).                                                                 |

`realm workflow validate` prints the notes for each step that asks for strict mode:

```text
ℹ Step 'classify': structured_output caveat — 'minLength' at 'properties.reason' is silently ignored or rejected by the API — either way enforced post-hoc by realm
```

For steps that do not ask for it, validate prints one line saying how many could, and `--explain` gives the detail.

### What the record says

Each attempt records whether strict mode was asked for and whether it was sent. When it was sent:

```json
{ "requested": true, "sent": true, "provider": "openai" }
```

When it was not sent, `downgrade_reason` says why:

| `downgrade_reason`          | Why strict mode was not used                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `gate_ineligible`           | The schema cannot be used with the provider in use.                                           |
| `api_rejected_schema`       | The provider refused the request. Realm sent it again without strict mode.                    |
| `grammar_unavailable`       | Anthropic could not prepare the schema at that moment.                                        |
| `service_unavailable`       | Anthropic answered that it was overloaded.                                                    |
| `provider_unsupported`      | The provider module in use does not support strict mode.                                      |
| `unsupported_context_tools` | The step has `tools`.                                                                         |
| `external_agent`            | The step was done by an assistant over MCP, not by `realm agent`.                             |
| `compat_endpoint`           | `realm agent` was given `--base-url`, and was not told that the address enforces strict mode. |

A run where a step asked for strict mode and went without it carries a finding, shown by `realm run inspect`:

```text
Run Health (1 finding(s)):
  structured_output_downgraded: 1 step(s) requested strict structured output but ran without it (classify: compat_endpoint) — outputs were validated post-hoc (L1), not grammar-constrained
```

`external_agent` does not raise this finding.

### With a custom address

With `--base-url`, `realm agent` does not send strict mode, because it cannot tell whether the server at that address enforces it. The record says `"sent": false, "downgrade_reason": "compat_endpoint"`. Adding `--strict-base-url` states that the server does enforce it; strict mode is then sent, and the record says `"sent": true`.

### With tools

On a step that has `tools`, the step's own answer is not restricted. Strict mode is applied instead to the arguments of each tool call, for each tool whose own schema can be used. `realm workflow validate` says so:

```text
ℹ Step 'summarise': structured_output caveat — this step declares tools — strict applies to tool-call arguments here, not to the step output; …
```

## `llm_timeout_seconds`

- **Type:** whole number above 0. **Default:** 600, or the value of `realm agent --llm-timeout`.
- The longest one request to the model may take. A request that takes longer is abandoned and sent again, up to three times in all. If every one runs out of time, `realm agent` stops and the run stays open.

With `llm_timeout_seconds: 1` and a model that did not answer, `realm agent` printed:

```text
✗ Step 'classify' LLM call failed: Request timed out.
```

and the run's record kept the failure:

```text
Drive failures:
  2026-10-01T22:27:05.314Z  classify  openai  connection_timeout after 5257ms: Request timed out. (declared 1000ms) (ceiling 64500ms) (attempt 3)
```

`declared` is the limit for one request. `ceiling` is the longest the three requests together are allowed, which Realm works out from it. The run was still `running`, so it can be driven again. See [Operate runs](../../guides/operate-runs.md#open-with-no-driver).

## `tools` and the tool limits

| Field            | Type                  | Default  | What it does                                                                                             |
| ---------------- | --------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `tools`          | list of `server:tool` | None     | The tools the model may call. Needs `input_schema` on the step and `mcp_servers` at the top of the file. |
| `max_tool_calls` | whole number above 0  | 20       | The most tool calls in one run of the step.                                                              |
| `max_fan_out`    | whole number above 0  | No limit | The most calls to `start_run` and `start_run_batch` tools.                                               |
| `tool_timeout`   | whole number above 0  | 30       | The longest one tool call may take, in seconds. Needs `tools`.                                           |

[Give an agent step tools](../../guides/agent-tools.md) shows `tools` and `max_tool_calls` at work.

**`tool_timeout`.** A tool that took 3 seconds, on a step with `tool_timeout: 1`, was stopped. The model was told `Error: tool call timed out after 1000ms`, and the call is in the record:

```text
     Tool calls (1):
       [slow:slow_lookup]  1002ms  error: tool call timed out after 1000ms
```

**`max_fan_out`.** A step with `max_fan_out: 1` whose model asked to start two runs started one. The second request was not carried out, and the model was then told to give its answer:

```text
You have reached the maximum number of tool calls. Produce your final JSON answer now using only what you have already gathered. No further tool calls will be executed.
```

## See also

- [Step fields](step-fields.md)
- [Retry and timeouts](retry-and-timeouts.md)
- [JSON Schema blocks](json-schema-blocks.md)
- [`realm agent` reference](../cli/realm-agent.md) covers `--llm-timeout`, `--base-url`, `--strict-base-url` and `--schema-retries`.
