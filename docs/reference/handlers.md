# Handler Authoring Reference

Step handlers contain custom business logic for `execution: auto` steps — validation,
transformation, enrichment, or any computation the engine should run automatically without
returning to the agent.

This document covers the full handler interface, context fields, error handling rules, the
five available primitives, and the two built-in handlers shipped with `@sensigo/realm`.

---

## Handler interface

A handler is any object that satisfies these four TypeScript interfaces, exported from
`@sensigo/realm`:

```typescript
interface StepHandler {
  readonly id: string;
  execute(
    inputs: StepHandlerInputs,
    context: StepContext,
    signal?: AbortSignal,
  ): Promise<StepHandlerResult>;
}

interface StepHandlerInputs {
  params: Record<string, unknown>;
}

interface StepContext {
  run_id: string;
  run_params: Record<string, unknown>;
  config: Record<string, unknown>;
  resources?: Record<string, unknown>;
}

interface StepHandlerResult {
  data: Record<string, unknown>;
  state_update?: Record<string, unknown>;
}
```

`StepHandler.id` is the name string that must match the `handler:` value in YAML. It must be
unique across all registered handlers.

---

## Context fields

| Field        | Type                | Description                                                                                                               |
| ------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `run_id`     | string              | The current run's identifier.                                                                                             |
| `run_params` | object              | The params passed to `start_run` for this run.                                                                            |
| `config`     | object              | The `config:` block from the YAML step definition. Always present; empty object if no `config:` was declared.             |
| `resources`  | object \| undefined | Outputs from earlier steps, keyed by step name. Use `resources['step_name']['field']` or the `resolveResource` primitive. |

### Accessing prior step outputs

```typescript
// Direct access
const text = context.resources?.['fetch_document']?.['text'];

// Via resolveResource primitive (returns undefined instead of throwing on missing)
import { resolveResource } from '@sensigo/realm';
const text = resolveResource(context.resources, 'fetch_document', 'text');
```

`resources` contains the `output_summary` of every prior step in the run. Adapter responses,
agent outputs, and prior handler results are all accessible here.

### Accessing step configuration

```typescript
const { source_step, source_field = 'text' } = context.config as {
  source_step: string;
  source_field?: string;
};
if (typeof source_step !== 'string') {
  throw new Error('config.source_step is required and must be a string');
}
```

Config values come directly from the YAML step's `config:` block. `config` may hold any JSON
value — scalars, arrays, and nested objects. Always validate that required config keys are
present and correctly typed — the engine does not validate `config:` contents for handler steps.

### Accessing run params

```typescript
const repoName = context.run_params['repo'] as string;
```

Use `run_params` for values that vary per run (e.g. the target repo, document ID, or user
preference). Use `config` for values that are fixed per workflow step (e.g. which prior step
to read from, a threshold, a pattern string).

---

## Error handling rules

**Throw a plain `Error`, not `WorkflowError`.**

```typescript
// ✓ Correct
throw new Error('source text is missing — check config.source_step');

// ✗ Wrong — do not import engine internals
import { WorkflowError } from '@sensigo/realm/internal';
throw new WorkflowError(...);
```

The engine catches any thrown error and wraps it as `ENGINE_HANDLER_FAILED`. If a recovery step with `trigger_rule: one_failed` depends on this step, the engine will invoke the recovery step. Otherwise, the run fails.

**Return `{ data: { ... } }` for all business-logic non-errors.** A validation result of
"no matches found" is not an error — it is an outcome the workflow should handle. Return it
as data.

```typescript
// ✓ Correct — let the workflow decide what to do with matched: false
return { data: { matched: false, value: null, pattern } };

// ✗ Wrong — throwing on a business outcome prevents downstream steps from handling it gracefully
throw new Error('no match found');
```

**Honour the cancellation signal.** If your handler does async I/O, check `signal?.aborted`
between operations:

```typescript
async execute(inputs, context, signal) {
  const result = await doFirstThing();
  if (signal?.aborted) throw new Error('cancelled');
  const final = await doSecondThing(result);
  return { data: final };
}
```

**Do not import from engine internals.** Handlers must not import from
`packages/core/src/engine/` or any path that is not part of the `@sensigo/realm` public API.
Use only imports from `@sensigo/realm`.

---

## Writing a handler — minimal example

```yaml
# workflow.yaml
steps:
  validate_output:
    description: 'Validate that required fields are present.'
    execution: auto
    handler: check_required_fields
    depends_on: [extract_fields]
    config:
      required_keys: [name, date, summary]

  handle_validation_error:
    description: 'Recovery step when validation fails.'
    execution: agent
    depends_on: [validate_output]
    trigger_rule: one_failed
```

```typescript
import type {
  StepHandler,
  StepHandlerInputs,
  StepContext,
  StepHandlerResult,
} from '@sensigo/realm';

const checkRequiredFields: StepHandler = {
  id: 'check_required_fields',

  async execute(inputs: StepHandlerInputs, context: StepContext): Promise<StepHandlerResult> {
    const keys = (context.config['required_keys'] as string[] | undefined) ?? [];
    const fields = inputs.params as Record<string, unknown>;
    const missing = keys.filter((k) => !(k in fields) || fields[k] === null || fields[k] === '');
    if (missing.length > 0) {
      throw new Error(`Missing required fields: ${missing.join(', ')}`);
    }
    return { data: { validated: true, field_count: keys.length } };
  },
};
```

---

## Registering a handler

Handlers are registered with `ExtensionRegistry` before starting the MCP server or engine:

```typescript
import { ExtensionRegistry, createRealmMcpServer } from '@sensigo/realm-mcp';
import { checkRequiredFields } from './handlers/check-required-fields.js';

const registry = new ExtensionRegistry();
registry.register('handler', 'check_required_fields', checkRequiredFields);

const server = createRealmMcpServer({ registry });
server.start();
```

The string passed to `register('handler', NAME, ...)` must exactly match the `handler: NAME`
value in your YAML step definition.

---

## Primitives

Five utility functions are exported from `@sensigo/realm` for use inside handler
implementations. They handle the most common sub-operations — reading prior step data, walking
nested JSON, string comparison, and result counting — so you do not have to reimplement them.

### `resolveResource`

```typescript
resolveResource(
  resources: Record<string, unknown> | undefined,
  stepId: string,
  field: string,
): unknown
```

Reads a named field from the output of a prior step. Returns `undefined` (does not throw)
when the step or field is missing. Use this instead of chained optional access when you want
a clear, auditable read path.

```typescript
import { resolveResource } from '@sensigo/realm';

const text = resolveResource(context.resources, 'fetch_document', 'text');
if (typeof text !== 'string') {
  throw new Error('source text is missing — check config.source_step');
}
```

---

### `walkField`

```typescript
walkField(
  data: Record<string, unknown>,
  fieldName: string,
): Record<string, unknown>[]
```

Recursively walks a JSON object and returns every sub-object that contains the named field,
at any depth and inside any array. Use this to extract a flat list of items from deeply nested
API responses or AI extraction outputs.

```typescript
import { walkField } from '@sensigo/realm';

// Given: { sections: [{ candidates: [{ verbatim_quote: "..." }] }] }
const items = walkField(data, 'verbatim_quote');
// Returns: [{ verbatim_quote: "..." }, ...]
```

---

### `partitionBySubstring`

```typescript
partitionBySubstring(
  candidates: Record<string, unknown>[],
  quoteField: string,
  sourceText: string,
): { accepted: Record<string, unknown>[]; rejected: Record<string, unknown>[] }
```

Splits `candidates` into `accepted` (those whose `quoteField` value appears as a verbatim
substring of `sourceText`) and `rejected` (those that do not). The comparison is
case-sensitive exact substring — no normalization, no fuzzy matching.

```typescript
import { partitionBySubstring } from '@sensigo/realm';

const { accepted, rejected } = partitionBySubstring(
  candidates,
  'verbatim_quote',
  originalDocumentText,
);
```

Use this to detect AI hallucinations: if a model produces a "verbatim quote" that does not
appear literally in the source document, it is rejected.

---

### `countResults`

```typescript
countResults(
  accepted: Record<string, unknown>[],
  rejected: Record<string, unknown>[],
): { accepted_count: number; rejected_count: number; candidates_found: number }
```

Computes summary counts from partition results. `candidates_found` is
`accepted.length + rejected.length` — the total before any filtering. This is the most
useful diagnostic field: it distinguishes "zero extracted" from "extracted but all invalid".

```typescript
import { countResults } from '@sensigo/realm';

const counts = countResults(accepted, rejected);
// { accepted_count: 3, rejected_count: 1, candidates_found: 4 }
```

---

### `compareStrings`

```typescript
compareStrings(
  a: string,
  b: string,
  mode: 'exact' | 'prefix' | 'regex',
): boolean
```

Compares two strings using one of three modes. Returns `false` (does not throw) when `mode`
is `'regex'` and `b` is not a valid regular expression.

| Mode     | Behaviour               |
| -------- | ----------------------- |
| `exact`  | `a === b`               |
| `prefix` | `a.startsWith(b)`       |
| `regex`  | `new RegExp(b).test(a)` |

```typescript
import { compareStrings } from '@sensigo/realm';

compareStrings('myorg/my-repo', 'myorg/.*', 'regex'); // true
compareStrings('v1.2.3', 'v1', 'prefix'); // true
compareStrings('active', 'active', 'exact'); // true
```

---

## Handler composition pattern

Combine primitives in sequence to build a handler:

```typescript
import type { StepHandler } from '@sensigo/realm';
import { resolveResource, walkField, partitionBySubstring, countResults } from '@sensigo/realm';

const validateExtractions: StepHandler = {
  id: 'validate_extractions',

  async execute(inputs, context) {
    // 1. Read config
    const sourceStep = context.config['source_step'] as string;
    const sourceField = (context.config['source_field'] as string | undefined) ?? 'text';
    const quoteField = (context.config['quote_field'] as string | undefined) ?? 'excerpt';

    // 2. Resolve the source text from a prior step's output
    const sourceText = resolveResource(context.resources, sourceStep, sourceField);
    if (typeof sourceText !== 'string') {
      throw new Error(`source text missing — check config.source_step ('${sourceStep}')`);
    }

    // 3. Get the candidates array from this step's inputs
    const rawCandidates = inputs.params['candidates'];
    if (!Array.isArray(rawCandidates)) {
      throw new Error('inputs.params.candidates must be an array');
    }

    // 4. Walk for items that contain the quote field
    const allItems = rawCandidates.flatMap((item) =>
      walkField(item as Record<string, unknown>, quoteField),
    );

    // 5. Partition: literal substring check
    const { accepted, rejected } = partitionBySubstring(allItems, quoteField, sourceText);

    // 6. Return counts and results
    return { data: { accepted, rejected, ...countResults(accepted, rejected) } };
  },
};
```

---

## Built-in handlers

Two handlers are registered automatically by `@sensigo/realm`. You do not need to register
them — they are available in every Realm instance.

---

### `validate_verbatim_quotes`

Verifies that AI-extracted quotes appear verbatim in a source document. Use this on any step
where an agent extracts literal passages that must be grounded in the source text.

#### Config

| Key            | Type   | Required | Default            | Description                                                         |
| -------------- | ------ | -------- | ------------------ | ------------------------------------------------------------------- |
| `source_step`  | string | Yes      | —                  | Name of the prior step that produced the source text.               |
| `source_field` | string | No       | `"text"`           | Field name in the source step's output that holds the source text.  |
| `quote_field`  | string | No       | `"verbatim_quote"` | Field name in each candidate object that holds the quote to verify. |

#### Inputs

| Key          | Type  | Description                                                                              |
| ------------ | ----- | ---------------------------------------------------------------------------------------- |
| `candidates` | array | Array of objects (or nested structures) each containing a `quote_field` value to verify. |

#### Output

| Key                | Type   | Description                                                                                                       |
| ------------------ | ------ | ----------------------------------------------------------------------------------------------------------------- |
| `accepted`         | array  | Candidates whose quote appears verbatim in the source text.                                                       |
| `rejected`         | array  | Candidates whose quote does not appear (potential hallucinations).                                                |
| `accepted_count`   | number | Length of `accepted`.                                                                                             |
| `rejected_count`   | number | Length of `rejected`.                                                                                             |
| `candidates_found` | number | `accepted_count + rejected_count`. Useful for diagnosing "nothing was extracted" vs "all extracted were invalid". |

#### Example

```yaml
validate_quotes:
  description: 'Verify that extracted quotes appear verbatim in the source document.'
  execution: auto
  handler: validate_verbatim_quotes
  depends_on: [extract_quotes]
  config:
    source_step: fetch_document
    source_field: text
    quote_field: verbatim_quote
```

---

### `validate_field_match`

Reads a field from a prior step's output and compares it against a pattern. Use this as a
guard to verify that a fetched resource belongs to the expected entity before proceeding.

#### Config

| Key            | Type                                 | Required | Default   | Description                                              |
| -------------- | ------------------------------------ | -------- | --------- | -------------------------------------------------------- |
| `source_step`  | string                               | Yes      | —         | Name of the prior step that produced the value to match. |
| `source_field` | string                               | Yes      | —         | Field path in that step's output.                        |
| `pattern`      | string                               | Yes      | —         | The value or pattern to compare against.                 |
| `mode`         | `"exact"` \| `"prefix"` \| `"regex"` | No       | `"exact"` | Comparison mode.                                         |

#### Output

| Key       | Type           | Description                                            |
| --------- | -------------- | ------------------------------------------------------ |
| `matched` | boolean        | Whether the field value satisfied the pattern.         |
| `value`   | string \| null | The actual field value read. `null` if missing.        |
| `pattern` | string         | The pattern from config, echoed back for auditability. |
| `mode`    | string         | The mode used, echoed back for auditability.           |

This handler **never throws on mismatch** — `matched: false` is a valid outcome that the
workflow handles via preconditions on downstream steps.

#### Example

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

---

## Testing handlers

Use `@sensigo/realm-testing` to test handlers in isolation:

```typescript
import { testStepHandler } from '@sensigo/realm-testing';
import { myHandler } from './my-handler.js';

const result = await testStepHandler(
  myHandler,
  { params: { candidates: [...] } },
  {
    config: { source_step: 'fetch_doc', source_field: 'text' },
    resources: { fetch_doc: { text: 'The original document.' } },
  },
);

expect(result.data.accepted_count).toBe(2);
```

The `testStepHandler` helper constructs a complete `StepContext` from the partial context you
provide, so you only need to specify the fields relevant to your test.

For the full testing API — fixture runner, mocks, adapter and processor test helpers, gate
responder, assertion helpers, and `startGitHubMockServer` — see the
[Testing Reference](testing.md).
