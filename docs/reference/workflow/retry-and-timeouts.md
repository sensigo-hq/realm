# Retry and timeouts

<!-- description: How long a step may take and how often it is tried again: timeout_seconds, the keys of the retry block, and how they combine, with measured delays. -->

This page lists the settings that limit how long a step may take and how often it is tried again: `timeout_seconds`, the six keys of the `retry` block, and how they combine. The delays and results shown were measured in runs.

For a walk through the common cases, see [Handle failure](../../guides/handle-failure.md).

## Which limit applies to what

| Setting                                         | Limits                                              | On                            | Default                             |
| ----------------------------------------------- | --------------------------------------------------- | ----------------------------- | ----------------------------------- |
| `timeout_seconds`                               | One attempt of the step.                            | `auto`, `finalizer`           | 3600 on `auto` steps                |
| `retry.max_attempts`                            | How many times the step is tried.                   | `auto`, `agent`               | 1                                   |
| `retry.total_timeout_seconds`                   | All attempts together, with the waits between them. | `auto`; `agent`, with `retry` | See [below](#total_timeout_seconds) |
| [`llm_timeout_seconds`](agent-step-controls.md) | One model request, under `realm agent`.             | `agent`                       | None                                |
| [`tool_timeout`](agent-step-controls.md)        | One tool call, under `realm agent`.                 | `agent`                       | 30                                  |
| [`gate.timeout_seconds`](gates.md)              | How long a gate waits for a person.                 | A gate step                   | None                                |

## `timeout_seconds`

- **Type:** whole number above 0. **On:** `auto` and `finalizer` steps. On an agent or guard step it is refused.
- The longest one attempt of the step may run. An attempt that runs longer is stopped, and the step fails:

```text
STEP_TIMEOUT: Step 'fetch' timed out after 1000ms
```

A timed-out attempt is not tried again unless `retry.on_timeout` is set.

A value of 0, or one that is not a whole number, is refused: `'timeout_seconds' must be a positive integer`.

## `retry`

`retry` is a block on an `auto` step, and on an agent step that `realm agent` or `realm listen` drives. It has six keys.

| Key                                                    | Type                             | Default  | What it does                                                                                                                |
| ------------------------------------------------------ | -------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| [`max_attempts`](#max_attempts)                        | whole number above 0             | 1        | How many times the step is tried, counting the first.                                                                       |
| [`backoff`](#backoff-base_delay_ms-max_delay_ms)       | `fixed`, `linear`, `exponential` | `fixed`  | How the wait between attempts grows.                                                                                        |
| [`base_delay_ms`](#backoff-base_delay_ms-max_delay_ms) | number, 0 or more                | 0        | The wait the growth starts from, in milliseconds.                                                                           |
| [`max_delay_ms`](#backoff-base_delay_ms-max_delay_ms)  | number                           | No limit | The longest any one wait may be.                                                                                            |
| [`on_timeout`](#on_timeout)                            | true or false                    | false    | Whether a timed-out attempt is tried again. On an agent step, only false loads, and then a timed-out try is not sent again. |
| [`total_timeout_seconds`](#total_timeout_seconds)      | whole number above 0             | Computed | The longest all attempts together may take.                                                                                 |

```yaml
fetch:
  description: Fetch the record.
  execution: auto
  handler: fetch_record
  timeout_seconds: 30
  retry:
    max_attempts: 3
    backoff: exponential
    base_delay_ms: 1000
    max_delay_ms: 5000
    total_timeout_seconds: 120
```

### Which errors are retried

Only an error that is marked as retryable is tried again. Realm's built-in adapters mark the errors where another try can help. An error thrown by your own handler is retried only if it is a `WorkflowError` with `retryable: true`. See [Handle failure](../../guides/handle-failure.md#retry-a-step).

### `max_attempts`

The number of tries, counting the first. With `max_attempts: 3`, a step that fails twice and then works is recorded as:

```text
  1. fetch
     (attempt 1/3)  error   1ms   hash: 44136fa3
       Taken by: ops@server-1 (from the OS user, via mcp-stdio)
     (attempt 2/3)  error   0ms   hash: 44136fa3
       Taken by: ops@server-1 (from the OS user, via mcp-stdio)
     (attempt 3/3)  success   0ms   hash: d038311e
       Taken by: ops@server-1 (from the OS user, via mcp-stdio)
```

When every attempt fails, the step fails with `STEP_RETRY_EXHAUSTED`:

```text
STEP_RETRY_EXHAUSTED: Step 'fetch' failed after 3 attempts
```

A value of 0 is refused: `'retry.max_attempts' must be a positive integer`.

### `backoff`, `base_delay_ms`, `max_delay_ms`

The wait before attempt 2, 3 and 4, measured with `base_delay_ms: 200`:

| `backoff`                               | Before attempt 2 | Before attempt 3 | Before attempt 4 |
| --------------------------------------- | ---------------- | ---------------- | ---------------- |
| `fixed`                                 | 201 ms           | 201 ms           | 201 ms           |
| `linear`                                | 203 ms           | 401 ms           | 602 ms           |
| `exponential`                           | 201 ms           | 401 ms           | 801 ms           |
| `exponential`, with `max_delay_ms: 300` | 202 ms           | 302 ms           | 302 ms           |

So `fixed` waits the base each time, `linear` adds the base each time, `exponential` doubles, and `max_delay_ms` caps each wait.

Without `backoff`, the wait is fixed. Without `base_delay_ms`, there is no wait: the attempts follow each other at once.

Other values are refused: `'retry.backoff' must be 'fixed', 'linear', or 'exponential'` and `'retry.base_delay_ms' must be a non-negative number`.

### `on_timeout`

With `on_timeout: true`, an attempt that is stopped by `timeout_seconds` counts as a failed attempt and the step is tried again. A step whose first attempt ran too long and whose second was quick was recorded as:

```text
  1. fetch
     (attempt 1/2)  error   1002ms   hash: 44136fa3
       Taken by: ops@server-1 (from the OS user, via mcp-stdio)
     (attempt 2/2)  success   0ms   hash: e715712f
       Taken by: ops@server-1 (from the OS user, via mcp-stdio)
```

The stopped attempt may still be running somewhere when the next one starts. For that reason the step must also say `idempotent: true`, which states that running it again, even at the same time, does no harm. Without it the file is refused:

```text
Invalid workflow: Step 'fetch': 'retry.on_timeout: true' requires 'idempotent: true' declared on the step — a timeout-retry can run concurrently with the still-in-flight original attempt, so the step must explicitly attest that any partial prior application is harmless to re-apply. Declare 'idempotent: true' or remove 'on_timeout'. (step at line 6)
```

### `total_timeout_seconds`

The longest all attempts may take together, counting the waits between them. When the next wait would pass the limit, the step fails without waiting:

```text
STEP_RETRY_EXHAUSTED: Step 'fetch' failed after 2 attempts
```

That step had `max_attempts: 5`, a wait of 600 ms, and `total_timeout_seconds: 1`. It stopped after two attempts, because a third could not start within the second. The run's record marks the last attempt with `"exhausted_by": "total_timeout"` and, after version 0.50.0, `"stop_reason": "total_timeout"`.

Each attempt is also cut to the time that is left. In the same record, the second attempt has `"clipped_to_ms": 397`: it was given 397 ms, not its full timeout.

Without `total_timeout_seconds`, the limit is the step's own schedule: `max_attempts` times the timeout of one attempt, plus the waits between attempts. It takes effect only when something makes an attempt wait longer than the schedule says.

### On an agent step

Under `realm agent` and `realm listen`, `retry` on an agent step tries a failed model request again. Each model request the step makes is tried up to `max_attempts` times: its first request, each tool turn, the request sent after a reply that was not JSON, and the request for its final answer. The model client's own retries are off for such a step, so these are its only tries. A step without `retry` is unchanged: the model client tries each request up to 3 times, as before.

A request is tried again only after a failure another try can fix: a 408, 409, 429 or 5xx answer, a timeout, or a lost connection. The provider's `x-should-retry` header decides first: `true` tries again at any status, and `false` never does. A wrong key, a missing model, a refused workspace, used-up credit or quota, and a request the provider refuses as written are never tried again. With `on_timeout: false`, a try that timed out is not sent again.

Between tries the step waits as its block says. When it declares none of `backoff`, `base_delay_ms` and `max_delay_ms`, it waits as the model client did: 500 ms, doubling, at most 8 s. Each wait is shortened at random by up to a quarter, and is never shorter than a `Retry-After` the provider sends.

Each request has one time limit, for all its tries, waits and re-sends: `total_timeout_seconds` when the block declares it; otherwise `max_attempts` times the timeout of one try (`llm_timeout_seconds`, `--llm-timeout`, or 600 s), plus the waits, plus 60 s. A wait that would pass the limit is not taken: the drive stops at once.

Only the request that failed is sent again, with the conversation as it stood before it, so a tool the model already called never runs again.

After the last try, the drive stops and the run stays open, as after any failed model call. The drive-failure entry keeps each failed try (`model_attempts`), and `realm run inspect` lists them as `Failed tries:`. When the step succeeds after a failed try, its evidence entry keeps them.

`retry` never asks the model again after it gave an answer that was refused; that is `--schema-retries`.

A provider module (`--provider-module`) that says it handles retries is given the block and the time limit, and tries again itself. For a module that does not, Realm tries its whole call again on a step without tools, and tries nothing again on a step with tools; the drive then says so once.

A run an assistant drives over MCP makes no model call through Realm, so `retry` on an agent step does nothing there.

## Advice the loader prints

These are accepted, with a warning:

| The step has                                    | Warning                                                                                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `retry` and no `timeout_seconds`                | `declares 'retry' but no 'timeout_seconds' — each attempt is bounded by the default execution timeout (3600s), …`                        |
| `total_timeout_seconds` below `timeout_seconds` | `'retry.total_timeout_seconds: 10' is at or below its per-attempt timeout (30s) — each attempt is bounded by what remains of the cap, …` |
| A key in `retry` that is not one of the six     | `unknown key 'jitter' (line 10) — ignored (not a recognized retry field).`                                                               |
| `retry` on a guard step                         | `'retry' is inert on execution: 'guard' steps — …`                                                                                       |

`realm workflow validate --strict` treats a warning as a failure:

```text
Valid: w v1 (1 step) — 1 warning; failing due to --strict
```

`retry` on a finalizer is refused.

## See also

- [Handle failure](../../guides/handle-failure.md)
- [Agent-step controls](agent-step-controls.md) covers `llm_timeout_seconds`, `tool_timeout` and the limit on refused answers.
- [Gates](gates.md) covers `gate.timeout_seconds`.
- [Step fields](step-fields.md)
