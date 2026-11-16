# What the loader refuses and warns about

<!-- description: What realm workflow validate reports when it reads a workflow.yaml: accepted, accepted with warnings, or refused. Every warning code and the JSON output. -->

When Realm reads a `workflow.yaml`, it either accepts the file, accepts it with warnings, or refuses it. This page describes the three outcomes as `realm workflow validate` prints them, lists all 36 warning codes, and gives the machine-readable form of the result.

`realm workflow register` applies the same checks before it stores anything.

## The three outcomes

**Accepted.** One line, and exit code 0:

```text
Valid: w v1 (1 step)
```

**Accepted with warnings.** Each warning on a line that starts with `⚠`, then the same `Valid` line. The exit code is 0:

```text
⚠ Step 'fetch': 'retry.on_timeout: true' has no effect with an effective 'max_attempts' of 1 — there is no second attempt to retry into.
Valid: w v1 (1 step)
```

**Refused.** One or more errors, and exit code 1. A single error is printed on one line:

```text
Invalid workflow: Step 'a': missing required field 'description' (step at line 5)
```

Several errors are listed together, so that one pass shows them all:

```text
Invalid workflow — 2 errors:
  Step 'fetch': invalid execution value 'manual'; must be 'auto', 'agent', 'guard', or 'finalizer' (step at line 5)
  Step 'other': missing required field 'description' (step at line 8)
```

Three other forms of refusal:

| When                              | Printed                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A warning that counts as an error | `Invalid: 1 warning, 1 escalated to an error by policy: UNKNOWN_STEP_KEY 'colour'`                       |
| The file is not valid YAML        | `Invalid: YAML parse error: bad indentation of a mapping entry (7:14)`, then the lines around the place  |
| The file cannot be read           | `Invalid: Failed to read workflow file: ENOENT: no such file or directory, open 'nowhere/workflow.yaml'` |

A line that starts with `ℹ` is neither a warning nor an error. It is a note, such as how many steps could use strict output. Set `REALM_NO_NUDGE=1` to leave these notes out.

## Line numbers

Messages end with the place in the file:

| Form               | Points at                                 |
| ------------------ | ----------------------------------------- |
| `(line 8)`         | The line of the key the message is about. |
| `(step at line 5)` | The line where the step begins.           |
| `(7:14)`           | In a YAML error, the line and the column. |

A message has no line when the place could not be found exactly.

## Warning codes

The loader has 36 warning codes. Twelve of them count as errors and make `validate`, `register` and `watch` fail: an unknown key at the top of the file or on a step; an `input_map` path that can never be found; a `when` condition that reads a path that can never be found or compares a gate's answer with a choice it does not offer; a webhook `params_map` that names a parameter a closed `params_schema` does not have, or leaves a required one unfilled; a template that uses a filter Realm does not have, gives a filter an argument no value accepts, or is not text; and a path in an approval question or `display` that can never be found, or one in an approval question that may be missing, unless `| default` comes first in its filters and the filters after it take its value. The others are advice, and the file is accepted.

| Code                                | Counts as | Printed when                                                                                                                                                                               |
| ----------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `UNKNOWN_WORKFLOW_KEY`              | Error     | The top of the file has a field Realm does not know.                                                                                                                                       |
| `UNKNOWN_STEP_KEY`                  | Error     | A step has a field Realm does not know.                                                                                                                                                    |
| `INPUT_MAP_PATH_UNRESOLVABLE`       | Error     | An `input_map` path can never be found. Added after version 0.49.0.                                                                                                                        |
| `INPUT_MAP_PATH_UNCERTAIN`          | Warning   | An `input_map` path may be absent when the step runs. Added after version 0.49.0.                                                                                                          |
| `WHEN_PATH_UNRESOLVABLE`            | Error     | A `when` condition reads a path that can never be found. Added after version 0.49.0.                                                                                                       |
| `WHEN_CHOICE_NOT_OFFERED`           | Error     | A `when` condition compares a gate's answer with a choice the gate does not offer. Added after version 0.49.0.                                                                             |
| `WHEN_PATH_UNCERTAIN`               | Warning   | A `when` condition reads a path that may be absent. Added after version 0.49.0.                                                                                                            |
| `PARAMS_MAP_UNKNOWN_PARAM`          | Error     | A webhook `params_map` names a parameter a closed `params_schema` does not have. Added after version 0.49.0.                                                                               |
| `PARAMS_MAP_REQUIRED_UNMAPPED`      | Error     | `params_schema` requires a parameter the webhook's `params_map` does not fill. Added after version 0.49.0.                                                                                 |
| `PARAMS_MAP_UNDECLARED_PARAM`       | Warning   | A webhook `params_map` names a parameter an open `params_schema` does not list in its `properties`. Added after version 0.49.0.                                                            |
| `HANDLER_NOT_PROVIDED`              | Warning   | A step's handler is not one the project provides. Added after version 0.49.0.                                                                                                              |
| `ADAPTER_NOT_PROVIDED`              | Warning   | The adapter a step's service names is not one the project provides. Added after version 0.49.0.                                                                                            |
| `TEMPLATE_FILTER_UNKNOWN`           | Error     | A template uses a filter Realm does not have. Added after version 0.49.0.                                                                                                                  |
| `TEMPLATE_FILTER_ARGUMENT`          | Error     | A template gives a filter an argument no value accepts. Added after version 0.49.0.                                                                                                        |
| `TEMPLATED_FIELD_NOT_TEXT`          | Error     | A field Realm reads as a template (`prompt`, `gate.message`, `display`, or `instructions` on a step with a gate) is not text. Added after version 0.49.0.                                  |
| `TEMPLATE_PATH_UNRESOLVABLE`        | Error     | A path in an approval question or a step's `display` can never be found. Added after version 0.49.0.                                                                                       |
| `TEMPLATE_PATH_NO_DEFAULT`          | Error     | A path in an approval question may be missing, and no `default` filter fills it. Added after version 0.49.0.                                                                               |
| `TEMPLATE_PATH_UNCERTAIN`           | Warning   | A path in a step's `display` may be missing. Added after version 0.49.0.                                                                                                                   |
| `GATE_ANSWERER_NOT_SLACK_ID`        | Warning   | With a Slack notifier in `realm.yaml` that reads replies, a gate names someone who is not a Slack member ID, so no reply from them counts in its Slack thread. Added after version 0.49.0. |
| `UNKNOWN_RETRY_KEY`                 | Warning   | A `retry` block has a key that is not one of its six.                                                                                                                                      |
| `UNKNOWN_GATE_KEY`                  | Warning   | A `gate` block has a key that is not one of its ten.                                                                                                                                       |
| `UNKNOWN_VALIDATION_EXHAUSTION_KEY` | Warning   | A `validation_exhaustion` block has a key that is not one of its three.                                                                                                                    |
| `UNKNOWN_CREATE_WORKFLOW_KEY`       | Warning   | An assistant sent `create_workflow` a field it does not take. Not printed for files.                                                                                                       |
| `RETRY_NO_TIMEOUT`                  | Warning   | A step has `retry` and no `timeout_seconds`.                                                                                                                                               |
| `ON_TIMEOUT_SINGLE_ATTEMPT`         | Warning   | `retry.on_timeout` is set and the step is tried only once.                                                                                                                                 |
| `TOTAL_TIMEOUT_BELOW_ATTEMPT`       | Warning   | `retry.total_timeout_seconds` is below `timeout_seconds`.                                                                                                                                  |
| `TOTAL_TIMEOUT_NON_AUTO`            | Warning   | `retry.total_timeout_seconds` is on a step that is not an `auto` step.                                                                                                                     |
| `RETRY_INERT_NON_AUTO`              | Warning   | `retry` is on an agent or guard step, where it does nothing.                                                                                                                               |
| `IDEMPOTENT_INERT_IN_FINALIZER`     | Warning   | A step says `idempotent: true` in a workflow that has a finalizer.                                                                                                                         |
| `DUAL_SCHEMA_DECLARED`              | Warning   | A step has both `input_schema` and `output_schema`.                                                                                                                                        |
| `DEAD_GATE_CONFIG`                  | Warning   | A `gate` setting can have no effect.                                                                                                                                                       |
| `DEAD_VALIDATION_EXHAUSTION_CONFIG` | Warning   | `default_output` is set without `mode: default`.                                                                                                                                           |
| `SCHEMA_STRICT_ADVISORY`            | Warning   | A schema compiles, and uses a list of types or a check without its `type`.                                                                                                                 |
| `EXTENSION_SENTINEL`                | Warning   | A secret named in `realm.yaml` could not be found, so the check ran with placeholders.                                                                                                     |
| `REALM_RELEASE_LINE_MISMATCH`       | Warning   | The `@sensigo/realm` the project's code imports is not the version the command runs. Added in 0.46.0.                                                                                      |
| `AUTHOR_TEXT_NAMES_ANSWER_TOOL`     | Warning   | The `instructions` of a step whose `trust` is `human_confirmed` or `human_reviewed`, or the workflow's `protocol.rules`, tell the agent to use an answer tool, which it may not have.      |

An unknown key is reported with its line, and with the nearest known key when there is one:

```text
⚠ step 'fetch': unknown key 'depend_on' (line 8) — ignored (did you mean 'depends_on'?)
Invalid: 1 warning, 1 escalated to an error by policy: UNKNOWN_STEP_KEY 'depend_on'
```

Fields that start with `x-` at the top of the file are not unknown keys. See [Top-level fields](top-level-fields.md#your-own-fields).

The pages for each block show the full text of each warning: [Retry and timeouts](retry-and-timeouts.md#advice-the-loader-prints), [Gates](gates.md#settings-that-do-nothing), [Agent-step controls](agent-step-controls.md#rules) and [JSON Schema blocks](json-schema-blocks.md#what-the-loader-warns-about).

## `--strict`

With `--strict`, `validate` and `register` treat every warning as a failure. The file is still described as valid, and the exit code is 1:

```text
Valid: w v1 (1 step) — 1 warning; failing due to --strict
```

`register --strict` stores nothing when it fails, and says so: `Error: 'strictreg' v1 has 1 warning; refusing to register due to --strict`.

`REALM_RELEASE_LINE_MISMATCH` counts as a warning here too: with `--strict`, `validate` and `register` fail when the `@sensigo/realm` your code imports is not the version the command runs. Without `--strict` the workflow is still registered. This was added in 0.46.0.

## `--explain`

By default, `validate` prints one line about steps that could use `structured_output: strict`. With `--explain` it prints one line for each such step:

```text
ℹ Step 'classify': eligible for structured_output: strict — add 'structured_output: strict' to opt in.
```

## `--json`

With `--json`, `validate` prints one JSON object and nothing else on standard output. The exit code is the same as without it.

```json
{
  "valid": false,
  "mode": "file",
  "path": "./",
  "workflow_id": "w",
  "loader_version": "0.46.0",
  "schema_version": null,
  "error_count": 1,
  "warning_count": 1,
  "strict": { "requested": false, "failed": false },
  "diagnostics": [
    {
      "code": "UNKNOWN_STEP_KEY",
      "severity": "error",
      "message": "step 'fetch': unknown key 'depend_on' (line 8) — ignored (did you mean 'depends_on'?)",
      "scope": "step",
      "key": "depend_on",
      "step": "fetch",
      "did_you_mean": "depends_on",
      "line": 8,
      "column": 5,
      "endLine": 8,
      "endColumn": 14
    }
  ],
  "errors": ["Invalid: 1 warning, 1 escalated to an error by policy: UNKNOWN_STEP_KEY 'depend_on'"],
  "checks_not_run": [],
  "extension_keys": [],
  "not_checked": []
}
```

| Field                          | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `valid`                        | Whether the file was accepted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `mode`                         | `file`, or `registered` when `--registered` was used.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `workflow_id`                  | The workflow's `id`, or `null` when the file could not be read that far.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `loader_version`               | The version of Realm that did the check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `error_count`, `warning_count` | How many of each.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `strict`                       | Whether `--strict` was given, and whether it turned an accepted file into a failure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `diagnostics`                  | One entry for each warning: `code`, `severity`, `message`, `scope`, and where known `step`, `key`, `did_you_mean`, and the position. A `REALM_RELEASE_LINE_MISMATCH` entry comes first and also carries `release_line`: `{ project: { version, path, installed_by }, engine: { version, path } }`, where `installed_by` is `project` for the project's own copy or the package that installed it (for example `@sensigo/realm-cli`), and a path has no trailing separator (added in 0.46.0).                                                                                                                                                                                            |
| `errors`                       | The error lines, as text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `checks_not_run`               | Checks that were left out, each with the reason. Used with `--registered`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `extension_keys`               | The `x-` fields found at the top of the file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `not_checked`                  | The `input_map` paths, `when` conditions and template references (in `gate.message` and `display`) that read data the workflow declares no shape for, or a context entry only a file adds: `surface` (`input_map`, `when` or `template`), `step`, `key` (`when` for a condition, the field's name for a template), `path`, `why` (`producer_declares_no_shape`, `no_params_schema`, `added_from_file`, or `check_failed` when the check itself failed on that path). Empty when the file could not be loaded. Added after version 0.49.0.                                                                                                                                               |
| `cacheability`                 | Each agent step's fixed part, for each provider described: its size and token range, its blocks and their segments, the other steps whose whole fixed part is the same as its own (a step below the minimum lists none, except a `structured_output: strict` step on OpenAI with a model that is not an `o1` model), and its verdict or why it has none. `shares_with` lists exactly the steps the `cache:` line names, all of them when the line ends `and N more`. Each entry holds `step`, the other step's id. It holds no prompt text, and is absent when the file could not be read. See [The cache lines](../cli/realm-workflow.md#the-cache-lines). Added after version 0.48.0. |

In a position, `line` and `column` count from 1, and `endColumn` is one past the last character.

An error that is not a warning, such as a missing required field, appears in `errors` and has no entry in `diagnostics`. The warnings about secrets that could not be found are printed on standard error and are not in `diagnostics`.

## See also

- [`realm workflow` reference](../cli/realm-workflow.md) covers `validate` and `register` and their flags.
- [Top-level fields](top-level-fields.md) and [Step fields](step-fields.md)
- [Upgrade Realm](../../guides/upgrade.md) covers `validate --registered`.
