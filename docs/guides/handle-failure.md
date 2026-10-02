# Handle failure

Steps fail: a service is down, a call takes too long, a model keeps answering wrongly. This guide shows how to make a workflow retry what is worth retrying, give up within a limit, and clean up when a run ends badly. At the end you know what each kind of failure looks like in the record.

## Before you start

You need a workflow with a step handler. [Write a step handler](step-handlers.md) makes one.

## The workflow this guide uses

It fetches a record, has an agent summarise it, and has two cleanup steps.

```yaml
id: sync
name: Sync a record
version: 1
extensions: ./registry.mjs

params_schema:
  type: object
  additionalProperties: false
  properties:
    fail_times:
      type: number
    sleep_ms:
      type: number

steps:
  fetch:
    description: Fetch the record from the upstream system.
    execution: auto
    handler: fetch_record
    timeout_seconds: 1
    retry:
      max_attempts: 3
      backoff: fixed
      base_delay_ms: 200

  summarise:
    description: Summarise the record in one sentence.
    execution: agent
    depends_on: [fetch]
    input_schema:
      type: object
      additionalProperties: false
      required: [summary]
      properties:
        summary:
          type: string
          minLength: 10
    validation_exhaustion:
      threshold: 2

  release_lock:
    description: Release the record's lock, however the run ended.
    execution: finalizer
    handler: note
    on_outcome: always

  page_on_call:
    description: Tell the person on call that the sync failed.
    execution: finalizer
    handler: note
    on_outcome: fail
```

The `fetch_record` handler in this example can be told, through the run's parameters, to fail a number of times or to be slow.

## Retry a step

Add a `retry` block to an `auto` step:

```yaml
retry:
  max_attempts: 3
  backoff: fixed
  base_delay_ms: 200
```

`max_attempts` counts the first try. `backoff` is `fixed`, `linear` or `exponential`, and `base_delay_ms` is the wait it starts from.

**Realm retries only errors that are marked as worth retrying.** The built-in adapters mark the ones that are: a timeout on the network, a rate limit. An ordinary error thrown by your own handler is not marked, so it fails the step on the first attempt, whatever `retry` says:

```text
Step 'fetch' failed. Run is terminated.
ENGINE_HANDLER_FAILED: Handler 'fetch_record' threw: upstream returned 503 (attempt 1)
```

To have a handler's failure retried, throw a `WorkflowError` with `retryable: true`:

```javascript
import { WorkflowError } from '@sensigo/realm';

throw new WorkflowError('upstream returned 503', {
  code: 'SERVICE_RATE_LIMITED',
  category: 'SERVICE',
  agentAction: 'wait_and_proceed',
  retryable: true,
});
```

With that change, a fetch that failed twice and then worked was retried, and the run carried on. The record shows each attempt:

```text
  1. fetch
     (attempt 1/3)  error   1ms   hash: 44136fa3
     (attempt 2/3)  error   0ms   hash: 44136fa3
     (attempt 3/3)  success   0ms   hash: d038311e
```

When every attempt fails, the step fails with its own code, and the run ends:

```text
Step 'fetch' failed. Run is terminated.
STEP_RETRY_EXHAUSTED: Step 'fetch' failed after 3 attempts
```

Mark an error as retryable only when trying again can help. A wrong password will be wrong the next time too.

## Limit how long a step may take

`timeout_seconds` on an `auto` step is the longest one attempt may run. A fetch that took 2.5 seconds against a limit of 1 was stopped:

```text
Step 'fetch' failed. Run is terminated.
STEP_TIMEOUT: Step 'fetch' timed out after 1000ms
```

A timeout is not retried unless you ask for it. See [Retry and timeouts](../reference/workflow/retry-and-timeouts.md) for retrying timeouts and for a limit on the total time across attempts.

## Limit how often an agent may answer wrongly

Each refused answer to an agent step is counted. When the count reaches a limit, the step fails, so that a model which cannot produce a valid answer does not keep the run open for ever. The limit is 6 unless you set it:

```yaml
validation_exhaustion:
  threshold: 2
```

With a limit of 2, the first wrong answer was refused as usual:

```text
VALIDATION_INPUT_SCHEMA: /summary must NOT have fewer than 10 characters
agent_action: provide_input
```

The second ended the step and the run:

```text
Step 'summarise' failed. Run is terminated.
VALIDATION_EXHAUSTED: Step 'summarise' exhausted its validation-rejection budget (2/2)
```

## Clean up when a run ends

A finalizer step runs after the run has ended. Its `on_outcome` says for which endings:

| `on_outcome`                  | Runs when the run                                       |
| ----------------------------- | ------------------------------------------------------- |
| `complete`                    | completed                                               |
| `fail`                        | failed                                                  |
| `abort`                       | was stopped by a guard or a handler                     |
| `always`                      | ended in any of those three ways                        |
| `completed_with_failed_steps` | completed, but a step failed and was handled on the way |

`on_outcome` also takes a list, such as `[fail, abort]`.

In every failed run on this page, both finalizers ran: `release_lock` because it is set to `always`, and `page_on_call` because the run failed.

```text
Phase: failed
Sealed by: step_failure
Cause: Step 'fetch' failed: Step 'fetch' failed after 3 attempts
Completed: page_on_call, release_lock
Failed: fetch
Skipped: summarise
  summarise: trigger_rule_unsatisfiable: all_success, dep fetch failed
```

Finalizers do not run when an operator ends a run with `realm run abandon`.

## Carry on after a failure

A failed step does not have to end the run. Give the workflow a step that runs when another fails, with `trigger_rule: one_failed`. The run then ends as `completed`, with the failed step still listed. [Order and routing](../concepts/order-and-routing.md#run-three-the-payment-fails) shows this in full.

## If you see something else

- **A step with a `retry` block fails on the first attempt.** The error was not marked as retryable. See [Retry a step](#retry-a-step).

## See also

- [Retry and timeouts reference](../reference/workflow/retry-and-timeouts.md)
- [Agent-step controls](../reference/workflow/agent-step-controls.md) covers `validation_exhaustion` in full.
- [Error codes](../reference/error-codes.md)
- [Operate runs](operate-runs.md) covers what to do with a run that failed.
