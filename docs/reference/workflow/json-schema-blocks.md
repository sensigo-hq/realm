# JSON Schema blocks

<!-- description: The JSON Schema fields of workflow.yaml: what each is checked against, which parts of JSON Schema Realm accepts, and what the loader refuses or warns about. -->

Four fields of `workflow.yaml` hold a JSON Schema: `params_schema`, `input_schema`, `output_schema` and `trace_schema`. This page says what each one is checked against, which parts of JSON Schema Realm accepts, and what the loader refuses or warns about. Every message shown came from the loader or from a run.

## The four blocks

| Field           | Where         | What must fit it                                                                                                                                                                                                                                                                                                                                                                                                              | Checked when                    | If it does not fit                                                                                        |
| --------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `params_schema` | Top level     | The parameters a run is started with.                                                                                                                                                                                                                                                                                                                                                                                         | A run is started, by any means. | No run is created: `VALIDATION_INPUT_SCHEMA`.                                                             |
| `input_schema`  | An agent step | The answer given to the step.                                                                                                                                                                                                                                                                                                                                                                                                 | The step is called.             | The answer is refused: `VALIDATION_INPUT_SCHEMA`.                                                         |
| `input_schema`  | An auto step  | The input the step will receive: what its `input_map` builds when the step has an `input_map` and a `handler` or `uses_service`; otherwise the engine's input: the run's params when the step has no `depends_on`, `{}` otherwise. A program that names the step through the library (`executeStep`) with an input of its own has that input checked; an assistant's call never does (its `params` are not the step's input). | Before the step is claimed.     | The step is not run: `'<step>' cannot run (input_schema): …`, with the way out when nothing else can run. |
| `output_schema` | An agent step | The answer given to the step.                                                                                                                                                                                                                                                                                                                                                                                                 | The step is called.             | The answer is refused: `VALIDATION_OUTPUT_SCHEMA`.                                                        |
| `trace_schema`  | An agent step | The list of trace entries recorded for the step.                                                                                                                                                                                                                                                                                                                                                                              | The step is called.             | A warning, or with `trace_validation_mode: enforce` a refusal: `VALIDATION_TRACE_SCHEMA`.                 |

When the `input_schema` check refuses an `auto` step that builds its input with `input_map` (one with a `handler` or a `uses_service`), and the step was called by name, the reply is `VALIDATION_INPUT_SCHEMA` and routes as every refusal before the claim: `resolve_precondition` when another step can be called, else `report_to_user` (added after version 0.47.0, which always said `report_to_user`). Its schema checks what the map builds, not the input sent with the call.

A refused answer leaves the step open, so that it can be answered again. Refusals are counted. See [Agent-step controls](agent-step-controls.md#validation_exhaustion).

On an agent step, `input_schema` and `output_schema` are both checked against the same answer. One of them is enough.

## What a check does and does not do

- **The value must fit; nothing is changed.** A `default` in the schema is not applied. A run started with `{}` against a schema whose `region` has `default: eu` had the parameters `{}`.
- **Extra fields are kept unless the schema forbids them.** An answer `{"answer": "42", "extra": "kept?"}` against a schema that names only `answer` was accepted and recorded whole. To refuse extra fields, add `additionalProperties: false`.
- **The whole list of trace entries is checked at once.** `trace_schema` describes a list, with `type: array`.
- **A refusal names every problem found, up to 10, and gives the total.** The reply carries the first 10 in `error_details.errors` and the total in `error_count` (added after version 0.47.0, which named the first problem only); `realm run attempts` and `realm agent`'s repair message print the 10 and `and N more`:

  ```text
  2026-10-16T17:54:01.097Z  extract  VALIDATION_OUTPUT_SCHEMA  8 key(s)  13 problems
      - (root): must have required property 'area' [required] (missing property: 'area')
      - (root): must have required property 'reporter' [required] (missing property: 'reporter')
      - (root): must have required property 'product' [required] (missing property: 'product')
      - (root): must have required property 'version' [required] (missing property: 'version')
      - (root): must NOT have additional properties [additionalProperties] (additional property: 'note')
      - /code: must match pattern "^[A-Z]+-[0-9]+$" [pattern]
      - /title: must NOT have fewer than 5 characters [minLength]
      - /priority: must be equal to one of the allowed values [enum]
      - /estimate: must be >= 0 [minimum]
      - /tags: must NOT have more than 3 items [maxItems]
      and 3 more
  ```

- **Every rule is checked, so bound what an answer may hold.** Realm checks an answer against every rule of its schema, not only up to the first one it breaks. The validator's own notes warn that this can take long for a large answer against a costly rule, such as a `pattern` over a long string; give string fields a `maxLength` and lists a `maxItems`.

## Which JSON Schema is accepted

Realm checks with draft-07 of JSON Schema, in a strict mode that refuses what it does not understand.

| Feature                                                                                                         | Accepted                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`                              | Yes                                                                                                                                                                                                                                                                                                     |
| `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `minItems`, `maxItems` and the other draft-07 checks | Yes                                                                                                                                                                                                                                                                                                     |
| `anyOf`, `oneOf`, `allOf`, `not`                                                                                | Yes                                                                                                                                                                                                                                                                                                     |
| `$ref` to `#/definitions/<name>` or `#/$defs/<name>` in the same block                                          | Yes                                                                                                                                                                                                                                                                                                     |
| `$ref` to another file or address                                                                               | No. Realm does not fetch schemas.                                                                                                                                                                                                                                                                       |
| `format`                                                                                                        | No, whatever its value. Use `pattern`.                                                                                                                                                                                                                                                                  |
| A list of types, such as `type: [string, number]`                                                               | Accepted with a warning. Write `anyOf`.                                                                                                                                                                                                                                                                 |
| Keywords of later drafts, such as `prefixItems`                                                                 | No                                                                                                                                                                                                                                                                                                      |
| `$schema` naming a later draft                                                                                  | No                                                                                                                                                                                                                                                                                                      |
| `$async`                                                                                                        | No. A schema Realm checks must answer at once: a root `$async` (any true value) is refused when the workflow is loaded or created, and a workflow stored by an earlier version is refused at its first check, except a `trace_schema` in warn mode (the default), which is reported and left unchecked. |
| Your own keywords, including ones that start with `x-`                                                          | No. `x-` fields are for the top of the workflow file only.                                                                                                                                                                                                                                              |

## What the loader refuses

Each block is compiled when the file is loaded, with the same validator that checks values during a run. A block that cannot be compiled is refused, with the line of the offending keyword. The message says what a run would have met:

| The block has                              | Message                                                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A keyword with a wrong value               | `'input_schema' is not a valid JSON Schema — 'type' must be one of array, boolean, integer, null, number, object, string ('type: banana' here). …`                                                                              |
| A misspelt keyword                         | `'input_schema' is refused by realm's validator — 'minlength' is not a JSON-Schema keyword ('minlength: 10' here), at "input_schema/properties/summary". … remove 'minlength', or write 'minLength' if that is what you meant.` |
| An unknown keyword                         | `… 'colour' is not a JSON-Schema keyword ('colour: red' here). … remove 'colour', or correct its spelling.`                                                                                                                     |
| An `x-` keyword                            | `… 'x-note' is not a JSON-Schema keyword … remove it, or move it to the top of the workflow file, where the 'x-' extension namespace lives.`                                                                                    |
| `format`                                   | `… the 'format' keyword is unsupported, whatever its value ('format: email' here) … remove the 'format' keyword, or replace it with a 'pattern' that expresses the string shape you need.`                                      |
| A `$ref` to a definition that is not there | `… '$ref' points at a definition this block does not have ('$ref: #/definitions/nope' here) … add that definition, or remove 'properties'.`                                                                                     |
| A `$ref` to somewhere else                 | `… '$ref' points outside this block, and realm fetches no remote schemas …`                                                                                                                                                     |
| An empty `enum`                            | `… 'enum' must not be empty ('enum: []' here) … add at least one value to 'enum', or remove it.`                                                                                                                                |
| `required` that is not a list              | `… 'required' must be a list ('required: summary' here) … give 'required' a list.`                                                                                                                                              |
| Nothing under the key                      | `'input_schema' is null, not a schema (a JSON-Schema block is an object, or the boolean true/false); write a schema under 'input_schema', or remove it.`                                                                        |
| A root `$async` (any true value)           | ``'input_schema' declares `$async: true`, which Realm does not support: it checks data against a schema synchronously and cannot wait for an asynchronous check. … remove `$async` from the schema.``                           |

The middle of each message names the consequence for that block:

| Block                                                           | Consequence named in the message                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `params_schema`                                                 | `Every run start would be refused with that error at run time`                             |
| `input_schema`                                                  | `Every execute_step submission to this step would be rejected with that error at run time` |
| `output_schema`                                                 | `Every agent submission to this step would be rejected with that error at run time`        |
| `trace_schema`                                                  | `Every trace submission for this step would fail with that error at run time`              |
| `trace_schema` with a root `$async`, in warn mode (the default) | `Every trace for this step would go unchecked at run time`                                 |

## What the loader warns about

Two things compile and are probably not what was meant. The file is accepted, with a warning:

```text
⚠ Step 'a': 'input_schema' compiles, but Ajv warns: strict mode: use allowUnionTypes to allow union type keyword at "input_schema/properties/id" (strictTypes). Remedy: realm does not enable union types — write anyOf: [{type: string}, {type: number}] instead. This advisory clears when the schema is fixed; nothing is printed at run time. (line 12)
```

```text
⚠ Step 'a': 'input_schema' compiles, but Ajv warns: strict mode: missing type "string" for keyword "minLength" at "input_schema/properties/s" (strictTypes). Remedy: add type: string beside minLength, or remove minLength. This advisory clears when the schema is fixed; nothing is printed at run time. (line 12)
```

With `--strict`, `realm workflow validate` and `realm workflow register` fail on a warning:

```text
Valid: w v1 (1 step) — 1 warning; failing due to --strict
```

## `trace_schema` in both modes

This step requires at least two trace entries:

```yaml
research:
  description: Research the question.
  execution: agent
  trace_schema:
    type: array
    minItems: 2
    items:
      type: object
      required: [event]
      properties:
        event:
          type: string
          enum: [searched, read]
```

Called with one entry, in the default mode `warn`, the step completed and the reply carried:

```text
Trace schema violation for step 'research': (root) must NOT have fewer than 2 items
```

The warning names every violation, up to 10, then `and N more`, and `validation_errors` in the step's trace summary is the number of violations found (added after version 0.47.0, whose check stopped at the first violation, so a run it recorded can count fewer).

With `trace_validation_mode: enforce` added to the step, the same call was refused, and the step stayed open. The reply, trimmed to these four keys:

```json
{
  "error_code": "VALIDATION_TRACE_SCHEMA",
  "errors": ["Trace schema validation failed for step 'research'"],
  "error_details": {
    "errors": [
      {
        "instancePath": "",
        "schemaPath": "#/minItems",
        "keyword": "minItems",
        "params": { "limit": 2 },
        "message": "must NOT have fewer than 2 items"
      }
    ],
    "error_count": 1
  },
  "agent_action": "provide_input"
}
```

## Schemas and strict output

`structured_output: strict` has rules of its own about which schemas a model provider can enforce. They are narrower than the rules on this page. See [Agent-step controls](agent-step-controls.md#structured_output).

## See also

- [Top-level fields](top-level-fields.md#params_schema)
- [Step fields](step-fields.md)
- [What the loader refuses and warns about](loader-diagnostics.md)
