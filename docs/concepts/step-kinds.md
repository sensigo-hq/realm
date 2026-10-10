# The four step kinds

<!-- description: The four values of a step's execution field (auto, agent, guard and finalizer): what each kind is for, what it records, and how to choose. -->

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
- It does nothing of its own. A step with neither records an output it did not compute: when the engine runs it, the recorded output of its one `depends_on` step (with no `depends_on`, the run's params; with several, `{}`); when a caller names it, what the caller's dispatcher returned. Its evidence says which (`output_source`). This is useful as a place to put a human gate. Added after version 0.46.0, which records what it received.

An auto step the run's view refuses before it is claimed — an invalid `trust`, a failed precondition, or an input its schema rejects — is never submitted, so it never fails; it cannot run anywhere until the run or the workflow changes. A step whose handler or adapter this program has not registered is different: it cannot run here, and a program that has it can run it. Either way the step is named: `get_run_state` lists it under `engine_runnable` with the check that refused it (an input refusal names the field and what it must be, or the property the schema does not allow: `'<property>' is not allowed`), `realm run inspect` prints `Cannot run '<step>' (<check>): <why>`, and `realm agent` prints `• Step '<step>' cannot run (<check>): <why>` — `cannot run here (capability)` for a missing handler or adapter, ending `— load the missing extension, or run the step on a runner that has it` — once, and goes on with any agent step that is ready. An invalid `trust` is named in the words the run-health finding uses (`the engine will refuse this step at dispatch (VALIDATION_TRUST_VALUE)`): nothing has been dispatched. The `advance_run` act stops naming it.

An agent step is judged the same way for an invalid `trust` and a failed precondition, before any model is asked to answer it (its input schema is not judged: its input is the answer). A refused agent step is never offered: `get_run_state` lists it under `agent_refused`, every reply that says what comes next names it with the same `'<step>' cannot run (<check>): <why>.` words instead of `Ready for the agent`, `realm run inspect` prints `Cannot run '<step>' (<check>): <why>`, and `realm agent` names it once and never calls the model for it. Added after version 0.46.0: version 0.46.0 offers the step, and `realm agent` calls the model for it again and again.

When nothing else can run, `realm agent` stops on the first such step in the workflow's order and exits 1. For a refusal before the claim it prints one line, `✗ The drive stops: nothing else can run, and '<step>' cannot run (<check>). Run <id> stays open (phase '<phase>'): correct the workflow, register it again, then realm run advance <id> — or end it: realm run abandon <id>` When a step that cannot run is refused for its input, the line gives each such step's own way out instead, in the workflow's order, after `stays open (phase '<phase>'): ` — `for '<step>', correct the workflow and register it again` for a refused `trust` or precondition, `for '<step>', start a run with params that fit, or correct its input_schema and register the workflow again` for an input refused with no `depends_on` (the engine gives such a step the run's params), and `for '<step>', the engine gives it no input, so correct its input_schema and register the workflow again` for one with `depends_on` — joined by `; `, then `; then, after a fix, realm run advance <id> — or end it: realm run abandon <id>` (added after version 0.46.0). Correcting the workflow and registering it again is the fix: the run picks up the corrected definition, and `realm run advance` then runs the step. An input its schema rejects is also recorded as a drive failure, so `realm run list --stuck` names the step. For a missing handler or adapter, each drive that has nothing else to run attempts the step once and records each attempt in `capability_blocks`, so the run says which one is missing; the drive then prints the block's `⚠ … re-attach` line.

A program judges a missing handler or adapter with its own extensions: `realm agent`, `realm run advance`, and `realm mcp` or `realm serve` — a server with no project extensions has an empty set, so it says `handler '<name>' is not registered here`. Only a caller that passes no extensions at all — a program that embeds the engine, or `realm run inspect` — judges by the run's record, in the past tense: `could not run (capability): handler '<name>' was not registered in the runner that last attempted it` (`Could not run '<step>' (capability): … — from a program that has it: realm run advance <id>` on `inspect`). With neither, the step is `unknown`, and the act still names it.

The three paragraphs above were added after version 0.46.0.

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
