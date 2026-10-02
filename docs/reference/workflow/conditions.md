# Conditions: `when`, `preconditions`, `abort_unless`

Three step fields take conditions: `when`, `preconditions` and `abort_unless`. This page gives the one way conditions are written, the operators, what each comparison does with values of different kinds, and where the three fields differ. Every result in the tables comes from a run.

## The three fields

| Field           | Allowed on               | Checked when                         | If a condition is false                     |
| --------------- | ------------------------ | ------------------------------------ | ------------------------------------------- |
| `when`          | `auto`, `agent`, `guard` | The steps it depends on are settled. | The step is skipped.                        |
| `preconditions` | `auto`, `agent`          | Someone tries to run the step.       | The step is blocked. It can be tried again. |
| `abort_unless`  | `guard`                  | The guard runs.                      | The run is aborted.                         |

Each field takes one condition, or a list. In a list, every condition must be true. `preconditions` must be a list, even for one condition.

## How a condition is written

```text
<path> <operator> <value>
<path>
```

- **Path.** A step's name, a dot, and a field of that step's output: `classify.category`. Deeper fields and list items follow with more dots: `order.customer.name`, `order.items.0.sku`. Two other roots exist: `run.params.<name>` for the run's parameters, and `$settlement.<step>.<field>`, described [below](#settlement).
- **Operator.** One of `==`, `!=`, `>`, `>=`, `<`, `<=`.
- **Value.** Text in single or double quotes, a number, `true`, `false` or `null`.
- **A path alone** is true when its value counts as true. `preconditions` does not accept this form.

Paths here are shorter than in `input_map` and in template expressions. There, a step's output is `context.resources.classify.category`. In a condition that form is refused:

```text
Invalid workflow: Step 'c': 'when' references step 'context' which is not in its depends_on [a]. Add it to depends_on or use 'run.params.*'. (step at line 11)
```

There is no `and`, `or` or `not`. For "and", use a list:

```yaml
when:
  - 'extract.found == true'
  - 'resolve.store != null'
```

A condition that contains `and` or `or` is refused, and the message shows the list to write in its place:

```text
Invalid workflow: Step 'c': 'when' uses unsupported 'and' — write it as a list:
  when:
    - "a.x == 1"
    - "a.y == 2" (step at line 11)
```

For "or", use two steps, or a step with `trigger_rule: one_success`. See [Order and routing](../../concepts/order-and-routing.md).

## What each comparison gives

These results are from one run. A step named `data` produced this output:

```json
{
  "n": 5,
  "numstr": "5",
  "price": 9.99,
  "neg": -4.2,
  "s": "billing",
  "t": true,
  "f": false,
  "z": 0,
  "e": "",
  "nul": null,
  "list": ["a"],
  "empty_list": [],
  "obj": { "k": 1 }
}
```

Each condition below was the `when` of its own step. `true` means that step ran; `false` means it was skipped.

**Comparing numbers**

| Condition            | Result | Note                                                             |
| -------------------- | ------ | ---------------------------------------------------------------- |
| `data.n == 5`        | true   | `n` is the number 5.                                             |
| `data.n == '5'`      | false  | A number is never equal to text.                                 |
| `data.numstr == '5'` | true   | `numstr` is the text `5`.                                        |
| `data.numstr == 5`   | false  | Text is never equal to a number.                                 |
| `data.n != 5`        | false  |                                                                  |
| `data.n > 3`         | true   |                                                                  |
| `data.n >= 5`        | true   |                                                                  |
| `data.n < 5`         | false  |                                                                  |
| `data.n <= 5`        | true   |                                                                  |
| `data.price >= 9.99` | true   |                                                                  |
| `data.neg < -1`      | true   | `neg` is −4.2.                                                   |
| `data.s > 3`         | false  | `>`, `>=`, `<` and `<=` are false unless both sides are numbers. |

**Comparing text and true or false**

| Condition             | Result | Note                                           |
| --------------------- | ------ | ---------------------------------------------- |
| `data.s == 'billing'` | true   |                                                |
| `data.s == "billing"` | true   | Double quotes work too.                        |
| `data.s == billing`   | true   | A word without quotes is read as text.         |
| `data.s == 'Billing'` | false  | Upper and lower case differ.                   |
| `data.s != 'billing'` | false  |                                                |
| `data.s == 'a >= b'`  | false  | An operator inside quotes is part of the text. |
| `data.t == true`      | true   |                                                |
| `data.f == false`     | true   |                                                |
| `data.t == 'true'`    | false  | true is not the text `true`.                   |

**A path alone**

| Condition         | Result | Note                                       |
| ----------------- | ------ | ------------------------------------------ |
| `data.t`          | true   | true                                       |
| `data.f`          | false  | false                                      |
| `data.z`          | false  | The number 0.                              |
| `data.e`          | false  | Empty text.                                |
| `data.nul`        | false  | null                                       |
| `data.missing`    | false  | There is no such field.                    |
| `data.list`       | true   | A list, even an empty one, counts as true. |
| `data.empty_list` | true   |                                            |
| `data.obj`        | true   | A map counts as true.                      |

**Missing values and `null`**

| Condition              | Result | Note                                                                  |
| ---------------------- | ------ | --------------------------------------------------------------------- |
| `data.missing == null` | true   | True when the value is missing or null.                               |
| `data.nul == null`     | true   |                                                                       |
| `data.missing != null` | false  |                                                                       |
| `data.n != null`       | true   | True when the value is present and not null.                          |
| `data.missing == 'x'`  | false  | Any other comparison with a missing value is false.                   |
| `data.missing != 'x'`  | false  | This one too: `!=` does not become true because the value is missing. |
| `data.missing > 1`     | false  |                                                                       |

**Deeper paths, run parameters and `$settlement`**

| Condition                                      | Result | Note                                   |
| ---------------------------------------------- | ------ | -------------------------------------- |
| `data.obj.k == 1`                              | true   |                                        |
| `data.list.0 == 'a'`                           | true   | A number selects an item of a list.    |
| `run.params.mode == 'live'`                    | true   | The run was started with `mode: live`. |
| `run.params.absent == null`                    | true   |                                        |
| `$settlement.data.failed == false`             | true   |                                        |
| `$settlement.data.settled_by_default == false` | true   |                                        |
| `$settlement.data.validation_rejections == 0`  | true   |                                        |

## Where the three fields differ

The table above is for `when`. The same conditions were run as `preconditions` and as `abort_unless`. They agree except here:

| Condition form                       | `when`                           | `preconditions`                  | `abort_unless`                                |
| ------------------------------------ | -------------------------------- | -------------------------------- | --------------------------------------------- |
| A path alone                         | Accepted                         | Refused when the file is loaded  | Accepted                                      |
| `<path> == null`                     | True for a missing or null value | False                            | False                                         |
| `run.params.<name>`                  | Read                             | Not read: the condition is false | Not read: the run fails                       |
| A path that finds nothing            | The condition is false           | The condition is false           | The run fails. It is not recorded as aborted. |
| A path to a step not in `depends_on` | Refused when the file is loaded  | Accepted                         | Accepted                                      |

So a test for a missing value belongs in `when`. In `preconditions` and `abort_unless`, `null` is not understood: `== null` is false even when the value is null.

A path alone in `preconditions` is refused:

```text
Step 'c17': precondition 'data.t' must be a comparison (e.g. "step.field >= 1"). (step at line 95)
```

## What a false condition looks like

**`when`.** The step is listed as skipped, and the record keeps each condition with the value it found:

```json
{
  "kind": "when_false",
  "expression": "data.n == '5'",
  "leaves": [{ "leaf": "data.n == '5'", "lhs_present": true, "resolved_value": 5, "passed": false }]
}
```

**`preconditions`.** Running the step returns `status: blocked`, and says which condition failed and what it found:

```text
status: blocked
Precondition failed for step 'c04'.
Precondition failed: 'data.n != 5'. Resolved value: 5.
```

The run stays open. When the step does run, its record shows each precondition and the value it found: `preconditions: data.n == 5 → true (5)`.

**`abort_unless`.** The run ends as `aborted`. The guard's record lists every condition, and the steps after it are skipped:

```text
Phase: aborted
Sealed by: guard_abort (check)
Skipped: check, after
  check: guard_abort
```

When a guard's path finds nothing, the run ends as `failed`:

```text
Guard step 'check' failed with a resolution error. Run is terminated.
```

## `$settlement`

`$settlement.<step>` says how a step was settled. It has an entry for every step that completed or failed, and none for a step that was skipped or has not finished.

| Field                   | Type          | Meaning                                                                                  |
| ----------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| `failed`                | true or false | The step failed.                                                                         |
| `settled_by_default`    | true or false | The step was completed with its declared default answer, after too many refused answers. |
| `validation_rejections` | whole number  | How many of the step's answers were refused before it settled.                           |

```yaml
cleanup:
  description: Undo the extract if it failed.
  execution: auto
  depends_on: [extract, transform]
  trigger_rule: all_done
  when: '$settlement.extract.failed == true'
  handler: compensate_extract
```

`trigger_rule: all_done` is needed here. Under the default rule the step is skipped as soon as a step it depends on fails, so the condition could never be true. The loader refuses that combination:

```text
Invalid workflow: Step 'c': 'when' condition "$settlement.a.failed == true" can never be true — under the default 'all_success' trigger rule, 'a' can never be in failed_steps when this step is evaluated (…). To run this step when 'a' fails, set trigger_rule to one of: all_done, one_failed, all_failed. (step at line 11)
```

In `input_map` and template expressions, the same values are at `context.resources.$settlement.<step>.<field>`.

Because a skipped step has no entry, `$settlement.<step>.failed == null` in a `when` is true exactly when that step was skipped or has not settled.

## Rules the loader applies

- A `when` path must start with `run.params`, or with a step listed in the step's own `depends_on`. A `$settlement` path must name such a step too: `'$settlement' paths must reference a direct dependency (one-hop rule)`.
- `preconditions` must be a list: `'preconditions' must be an array of strings`.
- A `when` list must not be empty: `'when' array must not be empty`.
- A step cannot be named `run`, `context` or `$settlement`: `Step name 'run' is reserved and cannot be used as a step identifier`.
- Field names are not checked. A misspelt field is a path that finds nothing.

## See also

- [Order and routing](../../concepts/order-and-routing.md) explains how `depends_on`, `trigger_rule`, `when` and `preconditions` work together.
- [Step fields](step-fields.md)
- [Agent-step controls](agent-step-controls.md) covers the default answer that `settled_by_default` reports.
