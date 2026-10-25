# Handlers

<!-- description: Reference for handlers: the interface, what execute receives, what each return value and thrown error does, registration, and the helper functions. -->

A handler is code from your project that an `auto` step or a finalizer runs. This page gives the handler interface, what `execute` receives, what each return value and each thrown error does, how a handler is registered, and the 6 helper functions that `@sensigo/realm` exports for handlers. Every output shown came from a run.

Realm has one handler of its own, `check_quotes` (see [Built-in handlers](#built-in-handlers)); every other handler a workflow names comes from the project. For a walk through a first handler, see [Write a step handler](../guides/step-handlers.md).

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

A caller over MCP gets it in the reply's `warnings` list. `realm run inspect` prints it on the step's `Warn:` line; `realm agent` does not print it. To read it afterwards, use `realm run export`.

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

| Option        | Required | Holds                                                                                                                                                                                                            |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`        | Yes      | One of Realm's [error codes](error-codes.md).                                                                                                                                                                    |
| `category`    | Yes      | `NETWORK`, `SERVICE`, `STATE`, `VALIDATION`, `ENGINE` or `RESOURCE`.                                                                                                                                             |
| `agentAction` | Yes      | `report_to_user`, `provide_input`, `resolve_precondition`, `stop`, `wait_for_service`, `wait_and_proceed` or `await` (`wait_for_service` was `wait_for_human` up to version 0.47.0; `await` was added after it). |
| `retryable`   | Yes      | Whether the step may be tried again.                                                                                                                                                                             |
| `details`     | No       | An object with anything else about the failure.                                                                                                                                                                  |

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

Realm recognises a `WorkflowError` made by any copy of `@sensigo/realm` at the version the `realm` command uses. Realm objects do not cross versions: a `WorkflowError` your handlers or adapters throw is not recognised — its step fails after one attempt, without that error's own code and retry setting. What the failure says depends on the copy the error came from:

- From a copy that carries the release mark, the message names both versions and both folders, and the reply of the call that ran the step (`start_run` or `execute_step` over MCP) carries the code `ENGINE_RELEASE_LINE_MISMATCH`.
- From an older copy with no mark (0.45.0 and earlier), the step fails with the ordinary failure message plus a note — the class carries no release mark, what was not used if it is realm's, and the way out — and the reply carries `ENGINE_HANDLER_FAILED` (`ENGINE_ADAPTER_FAILED` for an adapter).

Either way the run record keeps the message only. This was added in 0.46.0; on 0.45.0 the error is treated as an ordinary `Error` and its code and details are lost. See [Which realm your code imports](project-extensions.md#which-realm-your-code-imports).

Recognising another copy of the same version was added in 0.46.0. On 0.45.0 the second row below gives the first row's result; [Which realm your code imports](project-extensions.md#which-realm-your-code-imports) says what to do there.

The same handler and workflow, with a retryable error on the first 2 attempts, run with `realm agent` and a provider module the command accepts (see [Your own provider](cli/realm-agent.md#your-own-provider)):

| How Realm was installed                                                                      | Result                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The project's `@sensigo/realm` at another version than the `realm` command's                 | 1 attempt, then `✗ Step 'only' failed: Handler 'flaky' threw a WorkflowError from realm 0.46.1 (…); this engine runs realm 0.46.0 (…). Realm objects do not cross versions, so its code 'SERVICE_RATE_LIMITED' and its retry setting were not used. …` |
| The project's `@sensigo/realm` and the `realm` command's own copy, two copies of one version | 3 attempts, then `Run complete`                                                                                                                                                                                                                        |
| One copy of `@sensigo/realm`, shared by the project and the `realm` command                  | 3 attempts, then `Run complete`                                                                                                                                                                                                                        |

In the first row, the project's copy is 0.46.0 given the version number 0.46.1 for this example. `realm workflow test` on the same project gives the same three results, with no provider module.

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

`realm agent` warns when it starts, and stops when it reaches the step. Started with `realm agent --workflow ./ --provider anthropic --model claude-sonnet-5-5`, it printed:

```text
⚠ Step 'only' needs handler 'missing', which is not registered in this runner. If reached it will block recoverably (not fail) until a runner that provides this handler executes it — load the missing extension or run on a capable runner.
```

```text
⚠ Step 'only' is blocked: handler 'missing' is not registered in this runner. The run is NOT failed — add handler 'missing' and re-attach (`realm agent --run-id 019e6924-4d83-4488-aca8-046ae4b8ec8a --provider anthropic --model claude-sonnet-5-5`).
```

The re-attach command repeats the flags the drive was started with: the model flags, `--extensions-module`, `--project`, `--schema-retries` when it is not 2, `--llm-timeout` and `--mint-writer-nonce`; it leaves out `--workflow`, `--params` and `--register`. It also repeats `--prompt-cache` when the drive was given it and its provider applies it, `auto` included, never the default, and never the trigger gaps `realm listen` passes (added after version 0.47.0). Version 0.45.0 prints `realm agent --run-id <run-id>` alone there.

The run stays open, and the step can be run later by a process that has the handler.

`check_quotes` is registered, added after version 0.47.1 (see [Built-in handlers](#built-in-handlers)). `validate_verbatim_quotes` and `validate_field_match` were never registered: a step naming them is blocked, as any unregistered handler is (above).

## Built-in handlers

Every registry `createDefaultRegistry()` returns has them: the CLI, `realm agent`, `realm listen`, the MCP server and the testing runner. A registry built with `new ExtensionRegistry()` does not.

### `check_quotes`

Checks, for each value an earlier step extracted, that the value's quote appears in a source document, and records how it was found. A missing quote never stops the run, and the step never judges whether a value is correct; a guard on its `all_found` stops the run (below).

| `config` key       | Default      | What it names                                                                          |
| ------------------ | ------------ | -------------------------------------------------------------------------------------- |
| `source_step`      | required     | The step whose output holds the document.                                              |
| `source_field`     | `text`       | The field of that output that holds the document's text.                               |
| `candidates_step`  | required     | The step whose output holds the extracted values.                                      |
| `candidates_field` | `candidates` | The field of that output that holds the values, a list of objects.                     |
| `quote_field`      | `quote`      | The field of each value that holds its quote.                                          |
| `min_part_chars`   | `20`         | The shortest part a stitched quote may rest on, in canonical characters; at least `4`. |

Both steps are read from the run's record by their ids, never from the step's input. Any other key, a missing required key, a step with no output yet, a document that is not text, or values that are not a list of objects ends the step `failed` with `ENGINE_HANDLER_FAILED` and a message saying what to change; every fault in the config is named at once. List the steps the check reads in its own `depends_on`. Without it the check can run first, before the values exist, and fail; the run goes on, every step that depends on the check under the default `all_success` trigger rule is skipped (a guard on `all_found` included), and the run can end `completed` with nothing checked.

Each value is an object: its `quote_field` holds the quote, its `value` key the value, and its `field` key its name in the warning; a value with no `value` key and no quote counts as `not_found`.

Each value gets a `quote_check` with one of six states. The state describes the quote's match, never the value's correctness.

| State                   | Means                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exact`                 | The quote is in the document character for character, and starts and ends at word and number edges; an invisible format character (`Cf`) inside a word, such as a soft hyphen or a zero-width space, does not make a word edge (U+FEFF excepted: the canonical form reads it as a space), and neither does a combining mark, visible or not (an accent, U+034F, a variation selector); the quote never starts or ends between a letter and a visible mark on it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `reformatted`           | The quote is in the document once letter case, punctuation, quotation marks, dash variants and spacing are set aside. Digits, the separators between two digits, `%`, `‰`, `°`, `‱`, currency signs, every mathematical sign (`<` `>` `≤` `≥` `+` `=` `±` …), primes (`′` `″`), ballot boxes and check marks (`☐` `☒` `✓` `✗`), superscripts and fractions never are: `9.5` is not `9-5`, `2,000` is not `2.000`, `$1,200` is not `£1,200`, and `<5%` is not `>5%`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `stitched`              | The quote joins whole pieces of the document, in the document's order. A piece ends where the quote breaks: at `…` or `...`, a sentence end, `;` or `:` (not one between two digits, as in `9:30`), a double quotation mark or a line break. Inside one piece nothing may be left out, and every piece is at least `min_part_chars` long, counting pieces that sit together in the document as one. After each skip, the next piece starts where the document starts a sentence, a clause (after `;` or `:`) or a line. A line counts only after a blank line, or a line that ends a sentence, a clause or a table row; a clause number (`6.2`, `12.`, `(a)`, never bare digits such as `12`) or a list mark is skipped only at such a line start, and a clause number only before a capital letter or an opening mark (`"` `“` `„` `«` `'` `‘` `(` `[`). After a full stop, `!` or `?`, on the same line or at the end of the line before, the next piece begins with a capital letter or an opening mark (`"` `“` `„` `«` `'` `‘` `(` `[`), or starts right after one in the document; at a new line that counts, an item after a list mark (`-` `*` `•` `◦` `▪` `‣` `·` `–` `—` `\|`, or a run of `#`) may open with any word, and a line quoted with its own clause number before a capital letter (`2. Send…`) passes. The piece before a skip may end mid-sentence. A `.` after an initial or one of `e.g.`, `i.e.`, `etc.`, `No.`, `Nos.`, `cl.`, `para.`, `Sch.`, `Ltd.`, `Co.`, `Inc.`, `St.`, `Mr.`, `Mrs.`, `Ms.`, `Dr.` is not a sentence end. |
| `stitched_out_of_order` | The same, with the pieces in another order.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `not_found`             | A piece is not in the document, or a part is shorter than `min_part_chars`, or locating the quote took more than 1,000 substring searches; or the value has no quote.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `unquoted`              | The value has no quote, and its `value` key holds `null` or an empty string. It does not count as missing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

A quote that ends a sentence where the document's sentence goes on is marked `cut_short`, with where; the reviewer reads the rest. An `exact` quote is marked when its last character is its `.`, `!` or `?` and the document, past the closing marks `"` `'` `)` `]` `}` `»` `’` `”`, plain spaces and tabs, goes on with a lowercase letter or a digit (`approx. 412`); any other whitespace there, a `\p{Ll}` or `\p{Nd}` character outside the Basic Multilingual Plane, or whitespace the quote carries after its stop, leaves it unmarked. In every other state, the mark falls at each `.`, `!` or `?` inside the quote, but the dots of `...` and a `.` right after `…`, that whitespace or the quote's end follows, unless it ends an abbreviation on the check's list or an initial, where the document has no stop and does not end its line or its text there; a space, tab or line break the quote carries changes nothing.

A number written in digits is one unit: a digit never matches inside a longer number or next to a letter, and a quote never starts or ends on a number's separator or beside a group of thousands. `clause 9` is not found in `clause 9a`, `9,20` not in `9,200`, `€48` not in `€48,000`, `18` and `18.` not in `18.5`, `1 200` not in `1 200 000`, and `75%` not in `.75%`. A currency or mathematical sign, or a dash, written right before a number belongs to it (the exceptions are listed under "What `check_quotes` does not catch"): `48,000` is not found in `€48,000`, and `5` not in `-5`. A number written in words is matched as words: `five hundred thousand euro` is found inside `six million five hundred thousand euro`. A reviewer can trust `exact` more than `reformatted`, and `reformatted` more than `stitched`.

An unvowelled Arabic word matches every vowelling of it: `كتب` is found in `كُتُب` ("books") as in `كَتَبَ` ("he wrote").

#### What `check_quotes` does not catch

`check_quotes` is built to catch the mistakes models make when they quote: a word dropped or added, a number cut short, a piece resumed in the middle of a sentence. A quote written on purpose to mislead it can still read found in the cases below.

The words below name exact sets, here and in the `cut_short` paragraph above, so they can be applied as written. Each is the set the check uses, as the running Node.js reads Unicode (Node 24: Unicode 17.0); anything outside it is not one.

| word               | set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a plain space      | U+0020 SPACE                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| a tab              | U+0009 CHARACTER TABULATION                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| whitespace         | U+0009 CHARACTER TABULATION, U+000A LINE FEED, U+000B LINE TABULATION, U+000C FORM FEED, U+000D CARRIAGE RETURN, U+0020 SPACE, U+00A0 NO-BREAK SPACE, U+1680 OGHAM SPACE MARK, U+2000 EN QUAD, U+2001 EM QUAD, U+2002 EN SPACE, U+2003 EM SPACE, U+2004 THREE-PER-EM SPACE, U+2005 FOUR-PER-EM SPACE, U+2006 SIX-PER-EM SPACE, U+2007 FIGURE SPACE, U+2008 PUNCTUATION SPACE, U+2009 THIN SPACE, U+200A HAIR SPACE, U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR, U+202F NARROW NO-BREAK SPACE, U+205F MEDIUM MATHEMATICAL SPACE, U+3000 IDEOGRAPHIC SPACE, U+FEFF ZERO WIDTH NO-BREAK SPACE                                                                                                                                                                                                                     |
| a line break       | U+000A LINE FEED, U+000D CARRIAGE RETURN, U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| a closing mark     | U+0022 QUOTATION MARK, U+0027 APOSTROPHE, U+0029 RIGHT PARENTHESIS, U+005D RIGHT SQUARE BRACKET, U+007D RIGHT CURLY BRACKET, U+00BB RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK, U+2019 RIGHT SINGLE QUOTATION MARK, U+201D RIGHT DOUBLE QUOTATION MARK                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| an opening mark    | U+0022 QUOTATION MARK, U+201C LEFT DOUBLE QUOTATION MARK, U+201E DOUBLE LOW-9 QUOTATION MARK, U+00AB LEFT-POINTING DOUBLE ANGLE QUOTATION MARK, U+0027 APOSTROPHE, U+2018 LEFT SINGLE QUOTATION MARK, U+0028 LEFT PARENTHESIS, U+005B LEFT SQUARE BRACKET                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| a list mark        | U+002D HYPHEN-MINUS, U+002A ASTERISK, U+2022 BULLET, U+25E6 WHITE BULLET, U+25AA BLACK SMALL SQUARE, U+2023 TRIANGULAR BULLET, U+00B7 MIDDLE DOT, U+2013 EN DASH, U+2014 EM DASH, U+007C VERTICAL LINE, or a run of U+0023 NUMBER SIGN                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| a dash             | U+002D HYPHEN-MINUS, U+058A ARMENIAN HYPHEN, U+05BE HEBREW PUNCTUATION MAQAF, U+1400 CANADIAN SYLLABICS HYPHEN, U+1806 MONGOLIAN TODO SOFT HYPHEN, U+2010 HYPHEN, U+2011 NON-BREAKING HYPHEN, U+2012 FIGURE DASH, U+2013 EN DASH, U+2014 EM DASH, U+2015 HORIZONTAL BAR, U+2E17 DOUBLE OBLIQUE HYPHEN, U+2E1A HYPHEN WITH DIAERESIS, U+2E3A TWO-EM DASH, U+2E3B THREE-EM DASH, U+2E40 DOUBLE HYPHEN, U+2E5D OBLIQUE HYPHEN, U+301C WAVE DASH, U+3030 WAVY DASH, U+30A0 KATAKANA-HIRAGANA DOUBLE HYPHEN, U+FE31 PRESENTATION FORM FOR VERTICAL EM DASH, U+FE32 PRESENTATION FORM FOR VERTICAL EN DASH, U+FE58 SMALL EM DASH, U+FE63 SMALL HYPHEN-MINUS, U+FF0D FULLWIDTH HYPHEN-MINUS, U+2212 MINUS SIGN, U+2796 HEAVY MINUS SIGN, U+02D7 MODIFIER LETTER MINUS SIGN, U+207B SUPERSCRIPT MINUS, U+208B SUBSCRIPT MINUS |
| a capital letter   | one Basic Multilingual Plane character in `\p{Lu}` or `\p{Lt}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| a lowercase letter | one Basic Multilingual Plane character in `\p{Ll}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| a digit            | one Basic Multilingual Plane character in `\p{Nd}`; where a number's digits are read (`9:30`, a number written in digits), superscripts and fractions (`\p{No}`) count too                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| an initial         | one Basic Multilingual Plane letter (`\p{L}`) that changes when lowercased, with neither a letter nor `.` right before it, followed by `.`: the `A.` of `A. Smith`, not the `S.` of `U.S.`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

U+2053 SWUNG DASH is not a dash here. U+000B, U+000C and U+0085 are not line breaks here.

What can still read found:

- A clause joined to a later sentence (`stitched`) or an earlier one (`stitched_out_of_order`): the piece before a skip may end mid-sentence.
- A number written in words, matched as words: `five hundred thousand euro` is found inside `six million five hundred thousand euro`.
- A true quote that stops before its sentence ends is found. It is marked `cut_short` only at a `.`, `!` or `?` the quote itself carries.
- An abbreviation that is not on the check's list (`e.g.`, `i.e.`, `etc.`, `No.`, `Nos.`, `cl.`, `para.`, `Sch.`, `Ltd.`, `Co.`, `Inc.`, `St.`, `Mr.`, `Mrs.`, `Ms.`, `Dr.`, and an initial), before a capital letter or an opening mark, is read as a sentence end (`a.m. Monday`, `excl. VAT`, `U.S. The`, `U.K. The`, `U.S.A. The`, `U.S. (the`): a skip may land there.
- A grouped amount written with a letter prefix (`500 euro` in `EUR2 500 euro`), and a middle-dot decimal (`·5`).
- A combining mark on a digit or a sign is set aside (`5 degrees` reads found in `-́5 degrees`), and circled, squared and parenthesised letters read as letters (`ⓃⓄⓉ` reads `not`). Negative squared and negative circled letters (`🅽🅾🆃`, `🅝🅞🅣`) and regional indicators are set aside like other symbols, so a quote reads found whether it carries them or leaves them out.
- Symbols other than the kept ones (bullets, emoji) are set aside.
- A quote that starts or ends at a U+FEFF inside a word reads `reformatted` (`lawful use` in `un`, U+FEFF, `lawful use`), since the canonical form reads it as a space.
- A blank line inside a sentence, or a header between blank lines, counts as a line start, as at a PDF page break: a skip may land on the words after it.
- A dotted decimal before a capitalised word at a line start that counts reads as a clause label (`2.5 Million`): a skip may land after it.
- An invisible format character (`Cf`) inside a number, between a leading decimal point and its digits, or between a dash and its number (every dash reads as `-`), so part of the number reads found: `12` in a `12500` with a soft hyphen after `12`, `75%` in a `.75%` with a zero-width space after the `.`, and `5` in a `-5` with a zero-width space after the `-`. U+FEFF reads as a space, so `12` is not found in `12`, U+FEFF, `500`, which reads as a group of thousands. After `€`, `$`, `+`, `±` or `<` the number is not found, except across U+FEFF, which reads as a space: `48,000` is found in `€`, U+FEFF, `48,000`.
- A hyphen outside the Basic Multilingual Plane (U+10D6E, U+10EAD) does not belong to its number: `5` is found after it.
- A sign set apart from its number by a space (`48,000` in `€ 48,000`; U+FEFF reads as a space).
- A contraction written in capitals, with another apostrophe, misspelled, or cut at its start: `CAN` is found in `CAN'T`, `can` in `can´t` and `can' t`, `did` in `did'nt`, and `t make` in `won't make`. A lowercase `can` is not found in `can't` or `can’t`.
- A quote that starts or ends at a hyphen breaking a word across a line: `paid` is found in `un-` at a line's end followed by `paid`.
- A group of thousands spaced with any space but a plain space, a no-break space (U+00A0), a thin space (U+2009) or a narrow no-break space (U+202F) — such as U+2007, U+2002 or U+3000: `1 200` written with the same space is found in `1 200 000` written with one of them.
- A `:` at a line's end before a digit (`at 9:` ending a line and `30` starting the next): a skip may land on the digit.

What reads not found although it is honest:

- A quote that skips into the middle of a sentence, with or without `…`.
- A skip onto a sentence that opens with a digit, a currency sign, a lowercase word (`iPhones…`), or a script with no capital letters.
- A skip onto a clause number in the middle of a line after a sentence end.
- A zero-width space used as the only separator between two words.
- A whole word quoted across U+FEFF (`unlawful` in `un`, U+FEFF, `lawful`).
- A skip onto a new line, a list item included, after a line that ends mid-sentence, or onto a line under a heading with no stop.
- An item that opens with another mark (`+`, `○`, `●`, `■`, `>`, U+F0B7), at any line start; quoting a kept sign other than a minus sign (`+`, `>`, `=` …) with the item reads `stitched` after a line ending with `;` or `:` or a blank line.
- A skip past a clause number onto a lowercase first word (`… keep the Premises` after `(b)`); quoting the label as well reads `stitched` after a line that ends with `;` or `:`, or after a blank line; after a line that ends a sentence, a label that opens with an opening mark or a capital letter does (`(b) keep…`, `A) keep…`, `IV. keep…`), and one that opens with a digit needs a capital letter or an opening mark after it (`2. Send…`). `b.` and `a)` are not read as labels.
- A page header crossed without `…`, joined with a space; a quote that keeps the line break, or skips the header with `…`, reads `stitched` only when a blank line follows the header, or the header ends with `;`, `:` or `|`, or ends a sentence and the line after it opens with a capital letter, an opening mark, a list mark or a run of U+0023; a line that opens with `;` or `:` reads `stitched` after any header, since a clause starts there.
- A whole word quoted across a hyphen that breaks it over a line (`substantial` across `sub-` ending a line and `stantial` starting the next).
- A sentence after a no-break space or a form feed; a sentence after a footnote marker; a tab-separated row with no stop; a skip past the labels `a)`, `A)` and `A.`, which are not read as clause numbers; `Ltd.`, `Inc.` or `etc.` ending a sentence; `Schedule A.` (read as an initial); a bullet in the middle of a line after a sentence end.
- A visible mark the quote leaves out makes another word, in every script but Arabic and Hebrew: `замок` is not found in `за́мок` (a stress mark), nor unpointed Syriac in pointed text.
- In Chinese, Japanese and Thai text, a quote must be a whole run, between spaces, punctuation, symbols or the text's ends (an invisible format character joins the runs beside it, U+FEFF excepted, as the `exact` row says): part of a run reads `not_found`. A reformatted quote of a run that only a punctuation mark or a symbol the check sets aside joins to another run (`。` `、` `，` `「` `」` `,` `.` `★` …, with no space beside it) reads `not_found` too; a character Unicode turns into a space and a mark (`´`, `゛`) counts as a space. Quoted character for character, the run reads `exact`, and a number in it follows the number rule above. Word boundaries for these scripts are designed later.

The step's output, for a document `The rent is €48,000 a year, paid quarterly in advance on the usual quarter days.` and two values:

```json
{
  "results": [
    {
      "field": "annual_rent",
      "value": "48000",
      "quote": "The rent is €48,000 a year",
      "quote_check": { "state": "exact", "parts": [{ "start": 0, "end": 26 }], "occurrences": 1 }
    },
    {
      "field": "payment",
      "value": "quarterly",
      "quote": "the rent is paid quarterly",
      "quote_check": {
        "state": "not_found",
        "parts": [],
        "occurrences": 0,
        "nearest": { "start": 28, "end": 42 }
      }
    }
  ],
  "by_state": {
    "exact": 1,
    "reformatted": 0,
    "stitched": 0,
    "stitched_out_of_order": 0,
    "not_found": 1,
    "unquoted": 0
  },
  "all_found": false,
  "candidates_found": 2
}
```

`parts` are where each part was found, as offsets into the document (`text.slice(start, end)`). `occurrences` is how many times the whole quote occurs; it is `0` when the quote is stitched or not found. `nearest` is where the longest piece of the quote that is in the document lies (an Arabic or Hebrew piece, and the document, read without their Arabic or Hebrew marks); it is absent when that piece holds no whole word, and it may start or end inside a word. `cut_short` and `cut_short_at` (the document offsets where the quote's sentences stop short) appear only when it does.

`all_found` is true when no value is `not_found`: `exact`, `reformatted`, `stitched` and `stitched_out_of_order` count as found, and `unquoted` is not counted.

When any quote is not found, the step completes with a warning that names each one: its field, the quote's first 80 characters, and the offsets of its nearest match, or `no nearby match`; a value with no quote reads `no quote given`, and one whose quote is not a string `the quote is not text`. It prints the quote as the model gave it, on one line, with control characters written out (`\u001b`), and cut after its 80th character with `…` (a mark after the 80th character is cut too), and offsets; it never prints text it read from the document. It names ten at most, then `and N more`:

```text
Quote check: 1 of 2 values not found in 'fetch_document.text': payment — "the rent is paid quarterly" (nearest match at 28–42).
```

To stop the run when a quote is missing, follow the check with a guard on `all_found`. A whole workflow: the document's text comes in the run's params, the agent extracts the values, the check reads both, and the guard stops the run:

```yaml
id: lease-quotes
name: Lease quotes
version: 1
params_schema:
  type: object
  required: [text]
  properties:
    text: { type: string }
steps:
  fetch_document:
    description: Take the document's text from the run's params
    execution: auto
  extract_fields:
    description: Extract each value with the quote that supports it
    execution: agent
    depends_on: [fetch_document]
    prompt: |
      Extract each value from the document below, with its field name and the quote it comes
      from. Quote one contiguous span copied character for character, or two spans joined by …;
      each span after the first starts where a sentence or clause of the document starts, or at
      a new line after a finished sentence, a finished clause or a blank line; after a full stop,
      a sentence starts with a capital letter.

      {{ context.resources.fetch_document.text }}
    input_schema:
      type: object
      required: [fields]
      properties:
        fields:
          type: array
          items:
            type: object
            required: [field, value, quote]
            properties:
              field: { type: string }
              value: { type: string }
              quote: { type: string }
  quote_check:
    description: Check each value's quote against the document
    execution: auto
    handler: check_quotes
    depends_on: [fetch_document, extract_fields]
    config:
      source_step: fetch_document
      candidates_step: extract_fields
      candidates_field: fields
  stop_if_not_found:
    description: Stop when a quote is not in the document
    execution: guard
    depends_on: [quote_check]
    abort_unless: ['quote_check.all_found']
    abort_message: A quote is not in the document; check the values against the source.
```

The guard needs `depends_on: [quote_check]`. Without it the guard is checked when the run starts, before the check has an output, and the run ends `failed` with a resolution error instead of `aborted`. With it, the run ends `aborted` and the check's record is kept. Register it with `realm workflow register <file>`.

The step checks quotes, not meaning. A value whose quote is in the document may still be wrong: the quote can say `4.5%` while the value says `5%`. Realm matches quotes exactly, because exact matching is what makes the check reliable. It does not judge meaning with a model, which is a different approach that some tools take and Realm declines. Nor does it know whether a later part of the document, such as a deed of variation, changed the clause it quotes.

Ask the model for one contiguous span copied character for character, or two spans joined by `…`; each span after the first starts where a sentence or clause of the document starts, or at a new line after a finished sentence, a finished clause or a blank line; after a full stop, a sentence starts with a capital letter.

The per-value record is the step's output: read it afterwards with `realm run export <run-id>`, which writes the whole run. `get_run_state` does not carry a step's output, and `realm run inspect` prints the step's output cut at 120 characters and its warning whole, on the `Warn:` line.

## Helper functions

`@sensigo/realm` exports 6 functions for use inside handlers. The list comes from the package's exports.

```js
import {
  resolveResource,
  walkField,
  partitionBySubstring,
  countResults,
  compareStrings,
  locateQuote,
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

### `locateQuote(quote, source, options)`

Finds `quote` in `source` and says how, as `check_quotes` does for each value; it is the one rule that handler uses. It returns `{ state, parts, occurrences, nearest? }`, with the offsets into `source`. The first rule that holds wins:

1. `exact`: `quote` is a substring of `source`, starting and ending at word and number edges.
2. `reformatted`: their canonical forms match (below).
3. `stitched`: the quote's pieces, split where it breaks (`…` or `...`, a sentence end, `;`, a `:` not between two digits, a double quotation mark or a line break), are each found whole, at word edges, and in order; pieces next to each other in `source` count as one part, and every part is at least `options.minPartChars` long (default `20`, at least `4`). After each skip, the next piece starts where the document starts a sentence, a clause (after `;` or `:`) or a line. A line counts only after a blank line, or a line that ends a sentence, a clause or a table row (`|`); a clause number (`6.2`, `12.`, `(a)`, never bare digits such as `12`) or a list mark is skipped only at such a line start, and a clause number only before a capital letter or an opening mark (`"` `“` `„` `«` `'` `‘` `(` `[`). After a full stop, `!` or `?`, on the same line or at the end of the line before, the next piece begins with a capital letter or an opening mark (`"` `“` `„` `«` `'` `‘` `(` `[`), or starts right after one in the document; at a new line that counts, an item after a list mark (`-` `*` `•` `◦` `▪` `‣` `·` `–` `—` `|`, or a run of `#`) may open with any word, and a line quoted with its own clause number before a capital letter (`2. Send…`) passes. The piece before a skip may end mid-sentence. A quote with no break is never stitched.
4. `stitched_out_of_order`: the same, with the parts in another order.
5. `not_found`: otherwise, with `nearest` when the longest piece of the quote that is in `source` holds a whole word (an Arabic or Hebrew piece, and `source`, read without their Arabic or Hebrew marks); otherwise it is absent.

The canonical form is the text after Unicode NFKC normalisation, in lower case, with every dash and hyphen read as `-` (two hyphens outside the Basic Multilingual Plane excepted; a soft hyphen is not a dash: it is invisible, and makes no word edge), every punctuation mark and quotation mark dropped and spaces collapsed, keeping letters with their visible combining marks (a mark is part of its letter, so a quote must carry it; an Arabic or Hebrew vowel mark a quote leaves out is optional, and one it writes must match), digits, `%`, `‰`, `°`, `‱`, currency signs, every mathematical sign (`<` `>` `≤` `≥` `+` `=` `±` …), primes (`′` `″`), ballot boxes and check marks (`☐` `☒` `✓` `✗`), superscripts and fractions (never folded into digits), a `-` directly before a digit, a `.` or `,` directly before a digit that follows no letter or digit, and the separators between two digits. A number written in digits is one unit: a digit never matches inside a longer number of `source`, or next to its letters, and a quote never starts or ends on a number's separator or beside a group of thousands. An empty `source`, or a `quote` with no letter or digit, is `not_found` with no parts.

| Call                                                  | Returns                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `locateQuote('due in 30 days', resources.fetch.text)` | `{"state":"exact","parts":[{"start":11,"end":25}],"occurrences":1}`                |
| `locateQuote('PAYMENT is due', resources.fetch.text)` | `{"state":"reformatted","parts":[{"start":0,"end":14}],"occurrences":1}`           |
| `locateQuote('due in 60 days', resources.fetch.text)` | `{"state":"not_found","parts":[],"occurrences":0,"nearest":{"start":11,"end":17}}` |

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
