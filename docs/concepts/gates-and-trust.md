# Human gates and trust levels

<!-- description: How a human gate stops a run until someone answers: how it opens, what the agent can do while it is open, who can answer, and what happens if nobody does. -->

A human gate stops a run until someone answers. It is how you make sure a person sees something before it takes effect. This page explains how a gate opens, what the agent can and cannot do while it is open, who can answer, and what happens if nobody does.

## A gate is set with `trust`

A step's `trust` field has three values.

| Value             | Effect                                                     |
| ----------------- | ---------------------------------------------------------- |
| `auto`            | No gate. This is the default.                              |
| `human_confirmed` | The run stops at this step and waits for an answer.        |
| `human_reviewed`  | Reserved. Today it behaves exactly like `human_confirmed`. |

Any other value is refused when the workflow is loaded. A misspelt `trust` cannot silently remove a gate.

```yaml
approve:
  description: A person approves the message.
  execution: auto
  depends_on: [draft]
  trust: human_confirmed
```

`trust` works on `auto` and `agent` steps. A guard cannot have one, and a finalizer cannot gate.

## What happens when a gate opens

When the run reaches a gated step, its phase becomes `gate_waiting`. The reply to whoever is driving says so, and lists the choices:

```text
status: confirm_required
run_phase: gate_waiting
choices: ["approve","reject"]
```

The choices are `approve` and `reject` unless the step lists its own under `gate.choices`. The step can also set `gate.message`, the text shown to the person.

While the gate is open, the steps after it cannot run. An agent that tried to run one was refused, and the run stayed at the gate.

A run that is waiting at a gate cannot be abandoned either. The gate has to be answered first:

```text
Run 'c3b7eed7-…' is waiting on human gate 'approve' (gate '9a35fbef-…'); answer it before abandoning.
```

## Routing on the answer

The answer is available to later steps as `<step>.choice`. Use it in a `when` condition to choose a branch:

```yaml
send:
  description: Send the message.
  execution: auto
  depends_on: [approve]
  when: "approve.choice == 'approve'"
```

The branch that was not chosen is skipped, and the record says why.

## Who can answer

A gate is answered by one call that names the run, the gate and the choice. There are four places it can come from:

- the command line: `realm run respond <run-id> --gate <gate-id> --choice <choice>`;
- the MCP tool `submit_human_response`;
- a Slack thread, when `realm agent` is set up to post gates to Slack;
- the prompt of `realm workflow run`, when you run by hand.

**Realm does not check who answers.** It records the choice. It does not verify that a person made it, or which person. An AI assistant connected over MCP has `submit_human_response` among its tools, and the protocol asks it to show the gate to the user and pass on the user's choice. Nothing stops an assistant from answering on its own.

If the agent must not be able to approve its own work, drive the run with `realm agent` and answer gates from the command line or Slack. The model behind `realm agent` is given each step's task and returns its output. `realm agent` itself waits at a gate until an answer is recorded.

## When nobody answers

By default a gate waits for ever. To set a limit, give the gate a timeout and say what should happen when it runs out:

```yaml
approve:
  description: A person approves the message.
  execution: auto
  depends_on: [draft]
  trust: human_confirmed
  gate:
    timeout_seconds: 3600
    on_expiry: abort
```

`on_expiry` is either `abort`, which stops the run, or `settle_default`, which answers with the choice named in `default_choice`.

Time alone does not end the gate. The gate expires when the limit passes, and the ending is carried out by the next call that tries to move the run, such as a late answer. Until then the run still reads `gate_waiting`, with a finding that says it is overdue:

```text
gate_expired_awaiting_drive: gate expired — awaiting enactment of the declared abort
```

An answer that arrives after the limit carries out the expiry, and is told so:

```text
Gate '9a35fbef-…' on 'approve' expired and the run aborted per the workflow's declared on_expiry — your choice was NOT recorded.
```

The record then shows how the run ended:

```text
Phase: aborted
Sealed by: gate_expiry_abort (approve)
Skipped: approve, send
  approve: gate_expired (gate_id: 9a35fbef-…)
```

To have expired gates carried out without waiting for someone to touch the run, run `realm run drain --expired` on a schedule, or start `realm listen` with `--sweep-expired-gates`.

## Trust on a service is a different field

`services.<name>.trust` has its own three values: `engine_delivered`, `engine_managed` and `agent_provided`. It is not a gate and does not stop a run. Putting one of those values on a step's `trust` is refused when the workflow is loaded.

## See also

- [Add a human gate](../guides/human-gates.md) walks through a gate from start to finish.
- [Answer gates from Slack](../guides/slack-gates.md)
- [Gates reference](../reference/workflow/gates.md) lists every `gate` key.
