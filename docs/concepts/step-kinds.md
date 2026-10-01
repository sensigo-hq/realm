# The four step kinds

Every step has an `execution` field that says who performs it. There are four values: `auto`, `agent`, `guard` and `finalizer`. This page explains what each kind is for, what it leaves in the record, and how to choose between them.

| Kind        | Who performs it        | Use it for                                             |
| ----------- | ---------------------- | ------------------------------------------------------ |
| `agent`     | Whoever drives the run | Work that needs judgement: a model, or a person.       |
| `auto`      | The engine             | Work that code can do: call a service, run a function. |
| `guard`     | The engine             | A rule that must hold, or the run stops.               |
| `finalizer` | The engine             | Cleanup that runs when the run ends.                   |

The examples on this page come from one small workflow that pays a refund. The whole file is on [Order and routing](order-and-routing.md).

## Agent steps

An agent step waits for an answer from outside the engine. The engine hands out the step's description and its `input_schema`, and accepts the answer only if it fits the schema.

```yaml
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
```

Who answers depends on how the run is driven. It can be an AI assistant connected over MCP, a model called by `realm agent`, or you at the terminal. The engine treats all three the same way. See [Who drives a run](who-drives-a-run.md).

## Auto steps

The engine runs an auto step itself. No model is involved. An auto step does one of three things:

- It calls a **handler**, a function from your project, named with `handler:`.
- It calls an outside **service** through an adapter, named with `uses_service:`.
- It does nothing of its own. A step with neither passes along the output it received. This is useful as a place to put a human gate.

```yaml
pay:
  description: Pay the refund.
  execution: auto
  depends_on: [only_low_risk]
  handler: pay
```

If the handler throws, the step fails. In the refund example, a payment that was declined was recorded like this:

```text
Step 'pay' failed. Recovery steps are available in next_actions.
Handler 'pay' threw: payment provider declined 500
```

## Guard steps

A guard checks one or more conditions against what earlier steps produced. If every condition is true, the run continues. If any is false, the engine stops the whole run, and its phase becomes `aborted`.

```yaml
only_low_risk:
  description: Stop the run unless the refund is low risk.
  execution: guard
  depends_on: [assess]
  abort_unless:
    - "assess.risk == 'low'"
  abort_message: 'High-risk refunds are not automated.'
```

A guard is never handed to the agent. The engine evaluates it in the same call that made it reachable. With a high-risk answer, the reply to the agent's own step was:

```text
Guard step 'only_low_risk' aborted the run.
```

The record keeps each condition with the value it was checked against:

```text
Output: {"conditions":[{"condition":"assess.risk == 'low'","resolved_value":"low","passed":true}],"aborted":false}
```

Use a guard, not a prompt instruction, for a rule the agent must not be able to talk its way past.

## Finalizer steps

A finalizer runs after the run has ended. It is the place for cleanup and for notifications about how the run went. A finalizer needs a `handler` and an `on_outcome` that says which endings it runs for.

```yaml
close_books:
  description: Record that the refund run ended, however it ended.
  execution: finalizer
  handler: note
  on_outcome: always
```

With `on_outcome: always`, this step ran when the refund completed and also when the guard aborted it. In the aborted run it is the only step that ran after the guard:

```text
Phase: aborted
Sealed by: guard_abort (only_low_risk)
Completed: assess, close_books
```

A finalizer without a handler is refused when the workflow is loaded:

```text
Invalid workflow: Step 'tidy': execution: finalizer requires 'handler' (handler-only in v1) (step at line 8)
```

## A gate is not a kind

A human gate is a property of a step, set with `trust:`. An auto or agent step can carry one. See [Human gates and trust levels](gates-and-trust.md).

## How to choose

- The work needs a model or a person to think: `agent`.
- Code can do it, and a wrong result would simply be a bug to fix: `auto`.
- It is a yes-or-no rule about earlier results, and a "no" must stop everything: `guard`.
- It must happen at the end, whatever happened before: `finalizer`.

## See also

- [Step fields, and which step kind accepts which](../reference/workflow/step-fields.md)
- [Write a step handler](../guides/step-handlers.md)
- [Handle failure](../guides/handle-failure.md)
