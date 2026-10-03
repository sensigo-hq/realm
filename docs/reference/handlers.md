# Handlers

A handler is code from your project that an `auto` step or a finalizer runs. This page gives the handler interface, what `execute` receives, what each return value and each thrown error does, how a handler is registered, and the 5 helper functions that `@sensigo/realm` exports for handlers. Every output shown came from a run.

Realm has no handlers of its own. Every handler a workflow names comes from the project. For a walk through a first handler, see [Write a step handler](../guides/step-handlers.md).

## The interface

```ts
interface StepHandler {
  readonly id: string;
  readonly uses_resources?: readonly string[];
  execute(
    inputs: StepHandlerInputs,
    context: StepContext,
    signal?: AbortSignal,
  ): Promise<StepHandlerResult>;
}
```

| Member           | What it is                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `id`             | The handler's name. Realm does not use it: the name a step uses is the one the handler is [registered](#registration) under. |
| `uses_resources` | Names of steps whose outputs the handler reads. Checked when the workflow is loaded.                                         |
| `execute`        | The function Realm calls each time the step is tried.                                                                        |

The types `StepHandler`, `StepHandlerInputs`, `StepContext` and `StepHandlerResult` are exported by `@sensigo/realm`. A handler does not have to be a class: an object with an `execute` function is accepted.

### `uses_resources`

Each name must be a step in the workflow that uses the handler. With a handler that declares `uses_resources: ['fetch', 'parse']` in a workflow that has no step `parse`:

```text
Invalid workflow — 2 errors:
  Step 'fetch': handler 'needs' declares uses_resources 'parse' but no step with that ID exists in this workflow (step at line 6)
  Step 'check': handler 'needs' declares uses_resources 'parse' but no step with that ID exists in this workflow (step at line 10)
```

The list is checked and nothing else. It does not change what `context.resources` holds.

## What `execute` receives

| Argument             | Holds                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `inputs.params`      | The step's input. With an `input_map` on the step, the values that map resolved to.                                          |
| `context.run_id`     | The ID of the run.                                                                                                           |
| `context.run_params` | The parameters the run was started with.                                                                                     |
| `context.config`     | The step's `config` block from the workflow file. `{}` if the step has none.                                                 |
| `context.resources`  | The outputs of the steps that have run, by step name, and one more entry, `$settlement`.                                     |
| `signal`             | An `AbortSignal`. It fires when the step's time limit passes. See [When the time limit passes](#when-the-time-limit-passes). |

This step:

```yaml
price:
  description: Second step.
  execution: auto
  handler: show
  depends_on: [fetch]
  config:
    currency: EUR
    rate: 1.19
  input_map:
    order: run.params.order
```

in a run started with `{"order":"A-17"}`, after a step `fetch` whose output was `{}`, received:

```json
{
  "inputs": {
    "params": { "order": "A-17" }
  },
  "context": {
    "run_id": "031047f7-ea22-4247-ae2b-36370d4eb9ad",
    "run_params": { "order": "A-17" },
    "config": { "currency": "EUR", "rate": 1.19 },
    "resources": {
      "fetch": {},
      "$settlement": {
        "fetch": { "settled_by_default": false, "validation_rejections": 0, "failed": false }
      }
    }
  }
}
```

`$settlement` says how each earlier step ended. Its fields are in [Conditions](workflow/conditions.md#settlement).

## What `execute` returns

`execute` returns an object with up to 4 fields:

| Field          | Type                  | What Realm does with it                                        |
| -------------- | --------------------- | -------------------------------------------------------------- |
| `data`         | Object                | Records it as the step's output.                               |
| `warn`         | `{ message: string }` | Records the message with the step. The step still completes.   |
| `abort`        | `{ message: string }` | Ends the run as `aborted`, with the message as the cause.      |
| `state_update` | Object                | Nothing. The field is in the type, and Realm does not read it. |

What each return value did:

| `execute` returned                      | The step    | The run                   | The step's recorded output                              |
| --------------------------------------- | ----------- | ------------------------- | ------------------------------------------------------- |
| `{ data: { checked: 3 } }`              | Completes.  | Goes on to the next step. | `{"checked":3}`                                         |
| `{}`                                    | Completes.  | Goes on.                  | `{}`                                                    |
| `{ data: { checked: 3 }, warn: { … } }` | Completes.  | Goes on.                  | `{"checked":3}`                                         |
| `{ abort: { message: '…' } }`           | Is skipped. | Ends as `aborted`.        | `{"aborted":true,"abort_message":"…"}`                  |
| `{ abort: { … }, data: { … } }`         | Is skipped. | Ends as `aborted`.        | The same. `data` is dropped.                            |
| Nothing (`undefined`)                   | Fails.      | Ends as `failed`.         | `{}`                                                    |
| A string                                | Completes.  | Goes on.                  | `{}`                                                    |
| `{ data: [1, 2] }`                      | Completes.  | Goes on.                  | `[1,2]`. Realm does not check that `data` is an object. |

A handler that returns nothing fails its step with this cause:

```text
Step 'only' failed: Dispatcher failed: Cannot read properties of undefined (reading 'abort')
```

### `warn`

The message is stored in the step's entry in the run's record, as `warn`:

```json
{
  "step_id": "only",
  "status": "success",
  "output_summary": { "checked": 3 },
  "warn": "One record had no email address."
}
```

A caller over MCP gets it in the reply's `warnings` list. `realm agent` and `realm run inspect` do not print it. To read it afterwards, use `realm run export`.

### `abort`

```text
→ [auto] only
  ✓ → aborted

Run ended in phase: aborted
```

```text
Phase: aborted
Sealed by: handler_abort (only)
Cause: Handler 'only' aborted the run: The account is closed.
Skipped: only
  only: handler_abort
```

Steps that depend on the step do not run. Finalizers whose `on_outcome` includes `abort` or `always` run: in a workflow with one, the run's record showed the finalizer completed after the abort.

In a finalizer, `abort` does not change how the run ended. It is recorded as that finalizer's failure.

## What a thrown error does

A step whose handler throws fails, and the run ends as `failed`. What is recorded depends on what was thrown. Each row was run on a step with `retry: { max_attempts: 3 }`:

| The handler threw                                              | Times run | The step's failure                                    | `error_code` in an MCP reply |
| -------------------------------------------------------------- | --------- | ----------------------------------------------------- | ---------------------------- |
| `new Error('the billing service is down')`                     | 1         | `Handler 'throws' threw: the billing service is down` | `ENGINE_HANDLER_FAILED`      |
| A `WorkflowError` with `retryable: false`                      | 1         | The error's own message.                              | The error's own `code`.      |
| A `WorkflowError` with `retryable: true`, twice, then a result | 3         | None. The step completed.                             | None.                        |
| A `WorkflowError` with `retryable: true`, every time           | 3         | `Step 'only' failed after 3 attempts`                 | `STEP_RETRY_EXHAUSTED`       |

A handler's error is tried again only when both hold: the step has a [`retry`](workflow/retry-and-timeouts.md#retry) block, and the error is a `WorkflowError` with `retryable: true`. An ordinary `Error` is never tried again.

### `WorkflowError`

```js
import { WorkflowError } from '@sensigo/realm';

throw new WorkflowError('Order A-17 is not in the system.', {
  code: 'RESOURCE_NOT_FOUND',
  category: 'RESOURCE',
  agentAction: 'report_to_user',
  retryable: false,
  details: { order: 'A-17' },
});
```

| Option        | Required | Holds                                                                                                      |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `code`        | Yes      | One of Realm's [error codes](error-codes.md).                                                              |
| `category`    | Yes      | `NETWORK`, `SERVICE`, `STATE`, `VALIDATION`, `ENGINE` or `RESOURCE`.                                       |
| `agentAction` | Yes      | `report_to_user`, `provide_input`, `resolve_precondition`, `stop`, `wait_for_human` or `wait_and_proceed`. |
| `retryable`   | Yes      | Whether the step may be tried again.                                                                       |
| `details`     | No       | An object with anything else about the failure.                                                            |

The error above gave a caller over MCP this reply:

```json
{
  "status": "error",
  "run_phase": "failed",
  "errors": ["Order A-17 is not in the system."],
  "error_code": "RESOURCE_NOT_FOUND",
  "agent_action": "stop",
  "error_details": { "order": "A-17" }
}
```

The message, the code and the details are the handler's. `agent_action` is `stop` whatever the handler gave, because the run has ended.

After the last of 3 attempts, the reply carries the last error's message in its details:

```json
{
  "errors": ["Step 'only' failed after 3 attempts"],
  "error_code": "STEP_RETRY_EXHAUSTED",
  "error_details": {
    "stepName": "only",
    "attempts": 3,
    "lastError": "rate limited",
    "exhausted_by": "attempts"
  }
}
```

### The handler and `realm` must use the same realm version

Realm recognises a `WorkflowError` made by any copy of `@sensigo/realm` at the version the `realm` command uses. An error from another version is treated as an ordinary `Error`: it is not tried again, and its code and details are lost. See [Which realm your code imports](project-extensions.md#which-realm-your-code-imports).

Recognising another copy of the same version was added after version 0.45.0. On 0.45.0 the second row below gives the first row's result; [Which realm your code imports](project-extensions.md#which-realm-your-code-imports) says what to do there.

The same handler and workflow, with a retryable error on the first 2 attempts, run with `realm agent` and a provider module the command accepts (see [Your own provider](cli/realm-agent.md#your-own-provider)):

| How Realm was installed                                                                      | Result                                                                      |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| The project's `@sensigo/realm` at another version than the `realm` command's                 | 1 attempt, then `✗ Step 'only' failed: Handler 'flaky' threw: rate limited` |
| The project's `@sensigo/realm` and the `realm` command's own copy, two copies of one version | 3 attempts, then `Run complete`                                             |
| One copy of `@sensigo/realm`, shared by the project and the `realm` command                  | 3 attempts, then `Run complete`                                             |

`realm workflow test` on the same project gives the same three results, with no provider module.

## When the time limit passes

Realm passes `execute` a signal on every call. When the step's [`timeout_seconds`](workflow/retry-and-timeouts.md#timeout_seconds) passes, Realm fires the signal, stops waiting, and fails the step:

```text
✗ Step 'only' failed: Step 'only' timed out after 1000ms
```

Realm does not stop the handler's code. In the run above, the step had `timeout_seconds: 1` and a handler that waits 4 seconds: the signal fired after 1 second, and the step had failed by then. A handler that should stop its work when the limit passes has to listen to the signal:

```js
signal?.addEventListener('abort', () => {
  // stop the work
});
```

## Registration

A step names a handler with its `handler` field. The name is looked up among the handlers the project registers. There are 2 ways to register one.

### In a code file

The default export of the file named by the workflow's `extensions` has a `handlers` map. Each key is a name:

```js
export default {
  handlers: {
    order_total: {
      id: 'order_total',
      async execute(inputs, context) {
        return { data: { total: inputs.params.quantity * context.config.unit_price } };
      },
    },
  },
};
```

The name is the key. If a handler's `id` differs from its key, Realm prints this and uses the key:

```text
[realm] extension handler registered as 'other_key' (map key) but its instance id is 'not_the_key' (module '../registry.mjs'). The registration name is the map key.
```

A handler with no `id` is accepted. See [Project extensions](project-extensions.md).

### In `realm.yaml`

```yaml
version: 1
handlers:
  order_total:
    use: ./handlers.mjs#makeTotal
    config:
      unit_price: 12.5
```

`use` names a file and one of its exports. The export is a function that Realm calls once, with the name and the `config` block, and that returns the handler:

```js
export function makeTotal({ id, config }) {
  return {
    id,
    async execute(inputs) {
      return { data: { total: 4 * config.unit_price } };
    },
  };
}
```

The step ran with the output `{"total":50}`. See [Deployment manifest](deployment-manifest.md).

A name registered both ways is refused:

```text
Error loading extensions: Extension handler 'order_total' is declared by both '../reg.mjs' and the deployment manifest '/srv/shop/realm.yaml' — manifest entries and code-module exports share one namespace; names must be unique.
```

### A name that is not registered

`realm workflow validate` and `realm workflow register` do not check that a step's handler is registered. Both accepted a workflow whose step names a handler that no file provides.

`realm agent` warns when it starts, and stops when it reaches the step:

```text
⚠ Step 'only' needs handler 'missing', which is not registered in this runner. If reached it will block recoverably (not fail) until a runner that provides this handler executes it — load the missing extension or run on a capable runner.
```

```text
⚠ Step 'only' is blocked: handler 'missing' is not registered in this runner. The run is NOT failed — add handler 'missing' and re-attach (`realm agent --run-id 69ad1113-4f72-4fdc-a2b4-1abac5135833`).
```

The run stays open, and the step can be run later by a process that has the handler.

This is also what happens to a step that names `validate_verbatim_quotes` or `validate_field_match`. Earlier versions of this page described those two as built in. Neither is registered.

## Helper functions

`@sensigo/realm` exports 5 functions for use inside handlers. The list comes from the package's exports.

```js
import {
  resolveResource,
  walkField,
  partitionBySubstring,
  countResults,
  compareStrings,
} from '@sensigo/realm';
```

The examples use these values:

```js
const resources = { fetch: { text: 'Payment is due in 30 days.', pages: 2 } };
const data = {
  clauses: [
    { quote: 'due in 30 days', page: 1 },
    { quote: 'due in 60 days', nested: { quote: 'Payment' } },
  ],
};
const candidates = [
  { quote: 'due in 30 days' },
  { quote: 'due in 60 days' },
  { quote: 30 },
  { other: 'x' },
  { quote: 'payment' },
];
```

### `resolveResource(resources, stepId, fieldName)`

Returns one field of one step's output from `context.resources`. Returns `undefined` if `resources` is `undefined`, if the step has no entry, if the entry is not an object, or if the field is absent.

| Call                                             | Returns                        |
| ------------------------------------------------ | ------------------------------ |
| `resolveResource(resources, 'fetch', 'text')`    | `"Payment is due in 30 days."` |
| `resolveResource(resources, 'fetch', 'missing')` | `undefined`                    |
| `resolveResource(resources, 'nope', 'text')`     | `undefined`                    |
| `resolveResource(undefined, 'fetch', 'text')`    | `undefined`                    |

### `walkField(data, fieldName)`

Searches any value, to any depth, and returns a list of every object that has the field as its own property. An object inside a matching object is searched too.

| Call                               | Returns                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `walkField(data, 'quote')`         | `[{"quote":"due in 30 days","page":1},{"quote":"due in 60 days","nested":{"quote":"Payment"}},{"quote":"Payment"}]` |
| `walkField('text', 'quote')`       | `[]`                                                                                                                |
| `walkField({ quote: 1 }, 'quote')` | `[{"quote":1}]`                                                                                                     |

### `partitionBySubstring(candidates, quoteField, sourceText)`

Splits a list of objects in two. An object is `accepted` if its `quoteField` is a string that appears in `sourceText` exactly, letter case included. Every other object is `rejected`. With an empty `sourceText`, every object is rejected.

| Call                                                                      | Returns                                                                                                                            |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `partitionBySubstring(candidates, 'quote', 'Payment is due in 30 days.')` | `{"accepted":[{"quote":"due in 30 days"}],"rejected":[{"quote":"due in 60 days"},{"quote":30},{"other":"x"},{"quote":"payment"}]}` |
| `partitionBySubstring([{ quote: '' }], 'quote', 'abc')`                   | `{"accepted":[{"quote":""}],"rejected":[]}`                                                                                        |

### `countResults(accepted, rejected)`

Returns the length of each list and their sum.

| Call                               | Returns                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| `countResults(accepted, rejected)` | `{"accepted_count":1,"rejected_count":4,"candidates_found":5}` |
| `countResults([], [])`             | `{"accepted_count":0,"rejected_count":0,"candidates_found":0}` |

### `compareStrings(a, b, mode)`

Compares `a` with `b`. `mode` is `exact`, `prefix` or `regex`.

| Mode     | `true` when                                                                              |
| -------- | ---------------------------------------------------------------------------------------- |
| `exact`  | `a` and `b` are the same string.                                                         |
| `prefix` | `a` starts with `b`.                                                                     |
| `regex`  | The regular expression `b` matches anywhere in `a`. An invalid expression gives `false`. |

| Call                                                | Returns     |
| --------------------------------------------------- | ----------- |
| `compareStrings('INV-2041', 'INV-2041', 'exact')`   | `true`      |
| `compareStrings('INV-2041', 'inv-2041', 'exact')`   | `false`     |
| `compareStrings('INV-2041', 'INV-', 'prefix')`      | `true`      |
| `compareStrings('INV-2041', '^INV-\\d+$', 'regex')` | `true`      |
| `compareStrings('INV-2041', '\\d+', 'regex')`       | `true`      |
| `compareStrings('INV-2041', '(', 'regex')`          | `false`     |
| `compareStrings('INV-2041', 'INV', 'other')`        | `undefined` |

## See also

- [Write a step handler](../guides/step-handlers.md)
- [Workflow file: step fields](workflow/step-fields.md#what-an-auto-step-does) covers `handler`, `config` and `input_map` on a step.
- [Retry and timeouts](workflow/retry-and-timeouts.md)
- [Project extensions](project-extensions.md) and [Deployment manifest](deployment-manifest.md)
- [Adapters](adapters.md), for calling an outside service without writing code.
