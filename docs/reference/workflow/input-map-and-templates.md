# Input maps, template expressions and filters

<!-- description: How a workflow file refers to values that exist only during a run: input_map and template expressions, where values come from, and every filter. -->

This page covers the two ways a workflow file refers to values that exist only when a run is under way: `input_map`, which builds the input of an `auto` step, and `{{ … }}` expressions in text fields. It lists where values can come from, where each form is allowed, what happens when a value is missing, and all 34 filters.

## Where values come from

| Path starts with              | Holds                                                                         | Available in                      |
| ----------------------------- | ----------------------------------------------------------------------------- | --------------------------------- |
| `run.params.`                 | The parameters the run was started with.                                      | `input_map`, template expressions |
| `context.resources.<step>.`   | The output of an earlier step.                                                | `input_map`, template expressions |
| `workflow.context.<name>`     | The text of a `workflow_context` entry, marked off as `context_wrapper` says. | Template expressions              |
| `workflow.context.<name>.raw` | The same text with nothing around it.                                         | Template expressions              |

A path goes into a value with dots. A number selects an item of a list, counting from 0. With a step `order` whose output is `{"id": "ord_7", "items": [{"sku": "A-100"}], "customer": {"name": "Ana"}}`:

| Path                                    | Value   |
| --------------------------------------- | ------- |
| `context.resources.order.id`            | `ord_7` |
| `context.resources.order.customer.name` | `Ana`   |
| `context.resources.order.items.0.sku`   | `A-100` |

## `input_map`

`input_map` is allowed on `auto` steps. It builds the input that the step's adapter or handler receives. Each key is a name in that input. Each value is one of three forms:

| Form                    | Result                                                                |
| ----------------------- | --------------------------------------------------------------------- |
| A path, as text         | The value found at the path.                                          |
| A map                   | A map with the same keys, each value built in the same way.           |
| `{ $literal: <value> }` | The value as written: text, a number, true or false, a list or a map. |

This step uses all three:

```yaml
show:
  description: Echo what input_map built.
  execution: auto
  depends_on: [order]
  handler: echo
  input_map:
    sku: run.params.sku
    order_id: context.resources.order.id
    first_item: context.resources.order.items.0.sku
    whole_customer: context.resources.order.customer
    shipping:
      method: { $literal: express }
      to: context.resources.order.customer.name
    tags: { $literal: [urgent, billing] }
    limit: { $literal: 30 }
    looks_like_a_path: { $literal: run.params.sku }
    missing: context.resources.order.nope
```

Started with `{"sku": "A-100"}`, the handler received:

```json
{
  "sku": "A-100",
  "order_id": "ord_7",
  "first_item": "A-100",
  "whole_customer": { "name": "Ana", "tier": "gold" },
  "shipping": { "method": "express", "to": "Ana" },
  "tags": ["urgent", "billing"],
  "limit": 30,
  "looks_like_a_path": "run.params.sku"
}
```

`realm run inspect` shows the built input on the step's `Resolved:` line.

### Rules

- **A path that finds nothing leaves its key out.** In the example, `missing` is not in what the handler received. There is no error and no warning, when the file is loaded or when the step runs. A path without one of the roots above, such as `order.id`, finds nothing.
- **A bare list, number, or true or false is refused.** Wrap it in `$literal`.

  ```text
  Invalid workflow: Step 'a': input_map path "tags": expected a string or object, got array (step at line 5)
  ```

- **Keys that start with `$` are reserved.** `$literal` is the only one in use. Any other is refused, when the file is loaded and again when the step runs:

  ```text
  Invalid workflow: Step 'a': input_map path "body": unknown directive '$litteral' — supported directives: $literal. Did you mean '$literal'? To pass literal data containing $-keys, wrap the subtree in $literal. input_map values are context paths, nested maps, or $literal — templated strings are not supported. (step at line 5)
  ```

- **`$literal` stands alone.** A map that has `$literal` and another key is refused: `$literal node must have exactly one key ($literal); found sibling keys`.
- **Maps can be nested 10 deep.** One more is refused: `exceeded maximum nesting depth of 10`.
- **`input_map` does not build text.** A value cannot be made from pieces, and `{{ … }}` expressions are not read here.

## Template expressions

A template expression is a path between double braces, optionally followed by filters:

```text
{{ path }}
{{ path | filter }}
{{ path | filter: argument | another_filter }}
```

### Where expressions are read

| Field          | Read when                               | Paths it can use                | Filters | A path that finds nothing                    | An unknown filter                  |
| -------------- | --------------------------------------- | ------------------------------- | ------- | -------------------------------------------- | ---------------------------------- |
| `prompt`       | The step becomes the next action.       | All four roots                  | Yes     | The expression is left as written.           | The expression is left as written. |
| `gate.message` | The gate opens.                         | All four roots                  | Yes     | The step stops: `GATE_MESSAGE_UNRESOLVABLE`. | The step stops: `FILTER_UNKNOWN`.  |
| `display`      | `realm agent` prints the step's result. | Fields of the step's own output | No      | Nothing is printed in its place.             | Nothing is printed in its place.   |

`instructions` and `description` are not read for expressions. They are passed on as written.

A prompt with these lines:

```yaml
prompt: |
  Order {{ context.resources.order.id }} for {{ context.resources.order.customer.name | upper }}.
  Items: {{ context.resources.order.items | pluck: "sku" | and_join }}.
  Not there: {{ run.params.nope }}.
  Unknown filter: {{ run.params.sku | shout }}.
```

was delivered as:

```text
Order ord_7 for ANA.
Items: A-100 and B-200.
Not there: {{ run.params.nope }}.
Unknown filter: {{ run.params.sku | shout }}.
```

A gate message is stricter, because a person decides from it. With a path that finds nothing, the gate does not open:

```text
GATE_MESSAGE_UNRESOLVABLE: gate.message has unresolvable references: context.resources.order.customer.city
```

and with a filter that does not exist:

```text
FILTER_UNKNOWN: gate.message uses unknown filter 'shout'
```

In both cases the run stays open, with the step not done. `realm workflow validate` does not check the paths or filter names in a template; these errors appear when the run reaches the step.

In `display`, a path is a field of the step's own output, without a root: `{{ note }}`. With this template:

```yaml
display: 'Note: {{ note }} / upper: {{ note | upper }} / other step: {{ context.resources.order.id }}'
```

`realm agent` printed:

```text
Note: Pack with care. / upper:  / other step:
```

### How a value is written into text

- Text is inserted as it is.
- A number, or true or false, is written as it would be in JSON.
- A list or a map is written as JSON, indented by two spaces.

### Filters

A filter takes the value on its left and gives a new value. Filters are applied from left to right. An argument follows the filter's name after a colon. Several arguments are separated by commas. An argument that contains a space or a comma goes in quotes.

If a filter is given a kind of value it does not work on, the whole expression is left as written. `default` is not reached in that case: it replaces a value that is missing, not a filter that could not be applied.

In the examples, `s.` stands for `context.resources.scan.`, and `⏎` marks a line break in the result.

| Filter          | Argument                                                          | Works on           | Example                                          | Result                      |
| --------------- | ----------------------------------------------------------------- | ------------------ | ------------------------------------------------ | --------------------------- |
| `bullets`       | none                                                              | a list             | `s.tags \| bullets`                              | `• urgent⏎• billing`        |
| `join`          | separator; `, ` if left out                                       | a list             | `s.tags \| join: " / "`                          | `urgent / billing`          |
| `default`       | the value to use                                                  | any value, or none | `s.missing \| default: "none"`                   | `none`                      |
| `upper`         | none                                                              | text               | `run.params.repo \| upper`                       | `SENSIGO/REALM`             |
| `lower`         | none                                                              | text               | `s.code \| lower`                                | `database_down`             |
| `capitalize`    | none                                                              | text               | `s.title \| capitalize`                          | `Refund request`            |
| `truncate`      | the longest length                                                | text               | `s.summary \| truncate: 30`                      | `The customer was charged…` |
| `pluck`         | the key to take from each item                                    | a list             | `s.findings \| pluck: "title" \| join`           | `Typo, Broken link, Typo`   |
| `count`         | none                                                              | a list             | `s.findings \| count`                            | `3`                         |
| `limit`         | how many items to keep                                            | a list             | `s.nums \| limit: 2 \| join`                     | `3, 1`                      |
| `compact`       | none                                                              | a list             | `s.gaps \| compact \| join`                      | `a, b`                      |
| `round`         | decimal places; 0 if left out                                     | a number           | `s.price \| round: 1`                            | `1234.6`                    |
| `floor`         | none                                                              | a number           | `s.price \| floor`                               | `1234`                      |
| `ceil`          | none                                                              | a number           | `s.price \| ceil`                                | `1235`                      |
| `abs`           | none                                                              | a number           | `s.neg \| abs`                                   | `4.2`                       |
| `number_format` | decimal places; 0 if left out                                     | a number           | `s.price \| number_format: 2`                    | `1,234.57`                  |
| `percent`       | decimal places; 0 if left out                                     | a number           | `s.ratio \| percent: 1`                          | `85.7%`                     |
| `replace`       | the text to find, the text to put                                 | text               | `run.params.repo \| replace: "/", " / "`         | `sensigo / realm`           |
| `yesno`         | a word for true and one for false; `yes` and `no` if left out     | true or false      | `s.ok \| yesno: "Active", "Inactive"`            | `Active`                    |
| `and_join`      | none                                                              | a list             | `s.tags \| and_join`                             | `urgent and billing`        |
| `trim`          | none                                                              | text               | `s.padded \| trim`                               | `hi`                        |
| `first`         | none                                                              | a list             | `s.tags \| first`                                | `urgent`                    |
| `last`          | none                                                              | a list             | `s.tags \| last`                                 | `billing`                   |
| `sum`           | none                                                              | a list of numbers  | `s.nums \| sum`                                  | `6`                         |
| `flatten`       | none                                                              | a list             | `s.nested \| flatten \| join`                    | `1, 2, 3`                   |
| `split`         | the text to split at                                              | text               | `s.csv \| split: "," \| compact \| join: "+"`    | `a+b++c`                    |
| `sort`          | none                                                              | a list             | `s.nums \| sort \| join`                         | `1, 2, 3`                   |
| `unique`        | none                                                              | a list             | `s.findings \| pluck: "title" \| unique \| join` | `Typo, Broken link`         |
| `title`         | none                                                              | text               | `s.title \| title`                               | `Refund Request`            |
| `code`          | none                                                              | text               | `s.code \| code`                                 | `DATABASE_DOWN`             |
| `indent`        | how many spaces                                                   | text               | `s.text \| indent: 2`                            | `  line one⏎  line two`     |
| `date`          | `short`, `long`, `iso`, `time` or `datetime`; `short` if left out | text               | `s.when \| date: "long"`                         | `January 28, 2026`          |
| `from_now`      | none                                                              | text               | `s.when \| from_now`                             | `246 days ago`              |
| `duration`      | none                                                              | a number           | `s.ms \| duration`                               | `1m 23s`                    |

`date` and `from_now` read text in the ISO 8601 form, such as `2026-01-28T14:05:00Z`, and write in UTC. The five forms of `date` give:

| Argument   | Result                |
| ---------- | --------------------- |
| `short`    | `Jan 28, 2026`        |
| `long`     | `January 28, 2026`    |
| `iso`      | `2026-01-28`          |
| `time`     | `14:05`               |
| `datetime` | `Jan 28, 2026, 14:05` |

The result shown for `from_now` was produced on 1 October 2026.

`bullets`, `first`, `last` and `and_join` on an empty list leave the expression as written.

## See also

- [Step fields](step-fields.md)
- [Gates](gates.md) covers `gate.message`.
- [Services, profiles and context](services-profiles-and-context.md) covers `workflow_context` and step templates (`use_template`).
