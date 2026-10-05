# Order and routing

<!-- description: How Realm decides which steps may run after every result, explained through the fields that control it and several runs of one workflow. -->

Realm decides which steps may run, and it decides again after every result. This page explains the five fields that control that decision, using one workflow and three runs of it. Every output shown is from a real run.

## The example

This workflow pays a refund. An agent assesses the request, a guard stops high-risk refunds, and the rest is automatic.

```yaml
id: refund
name: Refund
version: 1
extensions: ./registry.mjs

steps:
  assess:
    description: Decide how risky the refund is and state the amount.
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [risk, amount]
      properties:
        risk:
          type: string
          enum: [low, high]
        amount:
          type: number

  only_low_risk:
    description: Stop the run unless the refund is low risk.
    execution: guard
    depends_on: [assess]
    abort_unless:
      - "assess.risk == 'low'"
    abort_message: 'High-risk refunds are not automated.'

  pay:
    description: Pay the refund.
    execution: auto
    depends_on: [only_low_risk]
    handler: pay

  send_receipt:
    description: Send a receipt after a successful payment.
    execution: auto
    depends_on: [pay]
    handler: note

  open_ticket:
    description: Open a support ticket when the payment fails.
    execution: auto
    depends_on: [pay]
    trigger_rule: one_failed
    handler: note

  flag_large:
    description: Flag refunds over 50 for a later audit.
    execution: auto
    depends_on: [assess]
    when: 'assess.amount > 50'
    handler: note

  close_books:
    description: Record that the refund run ended, however it ended.
    execution: finalizer
    handler: note
    on_outcome: always
```

The `pay` handler in this example fails for amounts over 100.

## `depends_on`: what must finish first

A step can run only after every step in its `depends_on` has settled. A step with no `depends_on` can run at once. The order of steps in the file does not matter.

Two steps that depend on the same step are both allowed as soon as it settles. Here `send_receipt` and `open_ticket` both wait for `pay`.

## `trigger_rule`: what "finished" has to mean

By default a step runs only if all of its dependencies succeeded. `trigger_rule` changes that.

| Value         | The step runs when                                   |
| ------------- | ---------------------------------------------------- |
| `all_success` | Every dependency succeeded. This is the default.     |
| `all_failed`  | Every dependency failed.                             |
| `all_done`    | Every dependency settled, whatever the result.       |
| `one_failed`  | At least one dependency failed.                      |
| `one_success` | At least one dependency succeeded.                   |
| `none_failed` | No dependency failed. Skipped dependencies are fine. |

`open_ticket` uses `one_failed`, so it runs only when `pay` fails. `send_receipt` uses the default, so it runs only when `pay` succeeds. One of the two is always skipped.

## `when`: a condition on earlier results

`when` holds a condition about what earlier steps produced. The step runs only if the condition is true. `flag_large` runs only for amounts over 50.

## `abort_unless`: a rule that stops the run

`abort_unless` belongs to [guard steps](step-kinds.md#guard-steps). If a condition is false, the whole run stops.

## `preconditions`: a check at the moment of running

`preconditions` are conditions the engine checks when someone tries to run the step. If one is false, the step is refused and the run stays where it is. A step that needed at least one item, tried with none, got:

```text
Precondition failed for step 'write'.
Precondition failed: 'count.items > 0'. Resolved value: 0.
```

The difference from `when`: a false `when` skips the step and the run moves on without it. A false precondition blocks the step and the run waits.

## Run one: low risk, small amount

The agent answered `{"risk":"low","amount":20}`. In that one call the engine ran the guard, the payment and the receipt, and finished the run.

```text
Phase: completed  ✓
Completed: assess, only_low_risk, pay, send_receipt, close_books
Skipped: flag_large, open_ticket
  flag_large: when_false: assess.amount > 50 [lhs → 20]
  open_ticket: trigger_rule_unsatisfiable: one_failed, dep pay completed
```

Two steps were skipped, and the record says why for each: the amount was not over 50, and `pay` did not fail.

## Run two: high risk

The agent answered `{"risk":"high","amount":20}`. The guard stopped the run.

```text
Phase: aborted
Sealed by: guard_abort (only_low_risk)
Completed: assess, close_books
Skipped: flag_large, only_low_risk, pay, send_receipt, open_ticket
  flag_large: when_false: assess.amount > 50 [lhs → 20]
  only_low_risk: guard_abort
  pay: trigger_rule_unsatisfiable: all_success, dep only_low_risk skipped
  send_receipt: trigger_rule_unsatisfiable: all_success, dep pay skipped
  open_ticket: trigger_rule_unsatisfiable: one_failed, dep pay skipped
```

Skips travel down the graph. `pay` could never run, so the steps that depended on it could never run either. Only the finalizer ran.

## Run three: the payment fails

The agent answered `{"risk":"low","amount":500}`. The guard passed and `pay` failed.

```text
Step 'pay' failed. Recovery steps are available in next_actions.
```

`send_receipt` was skipped at once. `open_ticket` and `flag_large` were now allowed. After they ran, the run finished:

```text
Phase: completed  ✓
Completed: assess, only_low_risk, open_ticket, flag_large, close_books
Failed: pay
Skipped: send_receipt
  send_receipt: trigger_rule_unsatisfiable: all_success, dep pay failed
Run Health (1 finding(s)):
  completed_with_failed_steps: completed with 1 failed step(s): pay …
```

The run is `completed`, not `failed`, because the workflow had a step to handle the failure and that step ran. The failed step stays listed, and `realm run inspect` flags the run.

In this run, the steps that became allowed after the failure did not start by themselves. They ran when the driver called them. `realm agent` does that for you.

## What a skip records

Every skipped step has one of six reasons in the record:

| Reason                       | Meaning                                                     |
| ---------------------------- | ----------------------------------------------------------- |
| `when_false`                 | The step's `when` condition was false.                      |
| `trigger_rule_unsatisfiable` | The step's dependencies settled in a way its rule excludes. |
| `guard_abort`                | The step is the guard that stopped the run.                 |
| `handler_abort`              | A handler stopped the run.                                  |
| `gate_cancelled_by_abort`    | The step's open gate was cancelled when the run stopped.    |
| `gate_expired`               | The step's gate ran out of time.                            |

## See also

- [Conditions reference](../reference/workflow/conditions.md) for the condition syntax.
- [Handle failure](../guides/handle-failure.md) for retries, timeouts and cleanup.
- [Evidence](evidence.md) for the rest of the record.
