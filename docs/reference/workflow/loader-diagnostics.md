# What the loader refuses and warns about

<!-- description: What realm workflow validate reports when it reads a workflow.yaml: accepted, accepted with warnings, or refused. Every warning code and the JSON output. -->

When Realm reads a `workflow.yaml`, it either accepts the file, accepts it with warnings, or refuses it. This page describes the three outcomes as `realm workflow validate` prints them, lists all 18 warning codes, and gives the machine-readable form of the result.

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

The loader has 18 warning codes. Two of them count as errors: an unknown key at the top of the file or on a step makes `validate` and `register` fail. The others are advice, and the file is accepted.

| Code                                | Counts as | Printed when                                                                                          |
| ----------------------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| `UNKNOWN_WORKFLOW_KEY`              | Error     | The top of the file has a field Realm does not know.                                                  |
| `UNKNOWN_STEP_KEY`                  | Error     | A step has a field Realm does not know.                                                               |
| `UNKNOWN_RETRY_KEY`                 | Warning   | A `retry` block has a key that is not one of its six.                                                 |
| `UNKNOWN_GATE_KEY`                  | Warning   | A `gate` block has a key that is not one of its nine.                                                 |
| `UNKNOWN_VALIDATION_EXHAUSTION_KEY` | Warning   | A `validation_exhaustion` block has a key that is not one of its three.                               |
| `UNKNOWN_CREATE_WORKFLOW_KEY`       | Warning   | An assistant sent `create_workflow` a field it does not take. Not printed for files.                  |
| `RETRY_NO_TIMEOUT`                  | Warning   | A step has `retry` and no `timeout_seconds`.                                                          |
| `ON_TIMEOUT_SINGLE_ATTEMPT`         | Warning   | `retry.on_timeout` is set and the step is tried only once.                                            |
| `TOTAL_TIMEOUT_BELOW_ATTEMPT`       | Warning   | `retry.total_timeout_seconds` is below `timeout_seconds`.                                             |
| `TOTAL_TIMEOUT_NON_AUTO`            | Warning   | `retry.total_timeout_seconds` is on a step that is not an `auto` step.                                |
| `RETRY_INERT_NON_AUTO`              | Warning   | `retry` is on an agent or guard step, where it does nothing.                                          |
| `IDEMPOTENT_INERT_IN_FINALIZER`     | Warning   | A step says `idempotent: true` in a workflow that has a finalizer.                                    |
| `DUAL_SCHEMA_DECLARED`              | Warning   | A step has both `input_schema` and `output_schema`.                                                   |
| `DEAD_GATE_CONFIG`                  | Warning   | A `gate` setting can have no effect.                                                                  |
| `DEAD_VALIDATION_EXHAUSTION_CONFIG` | Warning   | `default_output` is set without `mode: default`.                                                      |
| `SCHEMA_STRICT_ADVISORY`            | Warning   | A schema compiles, and uses a list of types or a check without its `type`.                            |
| `EXTENSION_SENTINEL`                | Warning   | A secret named in `realm.yaml` could not be found, so the check ran with placeholders.                |
| `REALM_RELEASE_LINE_MISMATCH`       | Warning   | The `@sensigo/realm` the project's code imports is not the version the command runs. Added in 0.46.0. |

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
  "extension_keys": []
}
```

| Field                          | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `valid`                        | Whether the file was accepted.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `mode`                         | `file`, or `registered` when `--registered` was used.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `workflow_id`                  | The workflow's `id`, or `null` when the file could not be read that far.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `loader_version`               | The version of Realm that did the check.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `error_count`, `warning_count` | How many of each.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `strict`                       | Whether `--strict` was given, and whether it turned an accepted file into a failure.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `diagnostics`                  | One entry for each warning: `code`, `severity`, `message`, `scope`, and where known `step`, `key`, `did_you_mean`, and the position. A `REALM_RELEASE_LINE_MISMATCH` entry comes first and also carries `release_line`: `{ project: { version, path, installed_by }, engine: { version, path } }`, where `installed_by` is `project` for the project's own copy or the package that installed it (for example `@sensigo/realm-cli`), and a path has no trailing separator (added in 0.46.0). |
| `errors`                       | The error lines, as text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `checks_not_run`               | Checks that were left out, each with the reason. Used with `--registered`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `extension_keys`               | The `x-` fields found at the top of the file.                                                                                                                                                                                                                                                                                                                                                                                                                                                |

In a position, `line` and `column` count from 1, and `endColumn` is one past the last character.

An error that is not a warning, such as a missing required field, appears in `errors` and has no entry in `diagnostics`. The warnings about secrets that could not be found are printed on standard error and are not in `diagnostics`.

## See also

- [`realm workflow` reference](../cli/realm-workflow.md) covers `validate` and `register` and their flags.
- [Top-level fields](top-level-fields.md) and [Step fields](step-fields.md)
- [Upgrade Realm](../../guides/upgrade.md) covers `validate --registered`.
