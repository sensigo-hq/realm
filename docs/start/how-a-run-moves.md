# How a run moves

<!-- description: How a Realm run moves one step at a time: which steps Realm runs itself, which need a model or a person, and the ways a run can be driven. -->

A run moves one step at a time, and every move goes through the same engine. This page explains who does what: which steps Realm runs itself, which ones need a model or a person, and the three ways a run can be driven. For the same story as diagrams, see [How it works](https://realmengine.dev/how-it-works/) on the website.

## The engine owns the order

The workflow file says which steps exist and what each one depends on. The engine reads that and decides, at every moment, which steps are allowed to run. The model never decides the order. It only answers the steps that are handed to it.

The engine also owns the record. Every result goes to the engine first. The engine checks it, writes it to the run record, and only then works out what can run next.

## Four kinds of step

A step's `execution` field says who performs it.

| Kind        | Who performs it                                                       |
| ----------- | --------------------------------------------------------------------- |
| `auto`      | The engine. It calls your code or an outside service. No model.       |
| `agent`     | Whoever is driving the run: a model, or a person typing the answer.   |
| `guard`     | The engine. It checks a condition and lets the run continue or stops. |
| `finalizer` | The engine. It runs cleanup after the run has ended.                  |

A human gate is not a fifth kind. Any step can carry a gate. When it does, the run waits at that step until someone answers.

## What happens on each call

A run moves only when something calls the engine. On each call the engine does three things:

1. It checks and records the result it was given.
2. It runs every `auto` and `guard` step that is now allowed, one after another.
3. It stops at the next `agent` step, at a gate, or at the end of the run, and replies with what to do next.

Here is the start of a real run of the pull-request review example. The first step is `auto`, so the engine ran it inside the very first call:

```text
start_run     →  Step 'fetch_pr' completed. 1 step(s) now available.
```

The reply then names the one step the agent may run, `write_review`, with its task and its schema.

One case needs care. When a gate is answered, the answer is recorded, and a `guard` step that the answer makes ready is decided in the same call. The `auto` steps after the gate do not start by themselves. They run on the next call. In the same example, after the reviewer approved:

```text
submit_human_response  →  Gate 'confirm_review' resolved with choice 'approve'. 0 step(s) now available.
```

The run was then waiting for a call to run its last `auto` step. `realm agent` makes that call for you. A client that drives the run itself must call `execute_step` for that step.

## Three ways to drive a run

All three end at the same engine. They differ in who calls the model and who makes the calls.

### An MCP client drives

An AI assistant, such as Claude, connects to Realm over the Model Context Protocol (MCP). The assistant's own model does the agent steps.

1. The assistant calls `start_run`.
2. Realm replies with the next step, its task and its schema.
3. The assistant does the work and calls `execute_step` with its answer.
4. Realm accepts or refuses the answer, and replies with the next step.

Realm makes no model call on this path. See [Connect an MCP client](../guides/connect-an-mcp-client.md).

### `realm agent` drives

`realm agent` is a command that plays the assistant's part. It starts a run, sends each agent step to a model provider you choose, and submits the model's answer to the engine. When a gate opens it waits for the answer and then carries on.

It runs one step at a time. Steps on parallel branches are recorded correctly, but they are not sent to the model at the same moment. See [Run a workflow with `realm agent`](../guides/realm-agent.md).

### A webhook starts the run

`realm listen` is a small web server. When a request arrives, it checks it, creates a run, and starts a separate `realm agent` process to drive that run. It does not drive anything itself.

Its busy limit (`--max-concurrent`, 20 by default) counts requests being handled, not runs being driven. Nothing limits how many runs are driven at once on a machine. See [Start runs from webhooks](../guides/webhooks.md).

## See also

- [The four step kinds](../concepts/step-kinds.md) covers each kind in detail.
- [Order and routing](../concepts/order-and-routing.md) explains how the engine decides what may run.
- [Who drives a run](../concepts/who-drives-a-run.md) compares the three ways side by side, plus running by hand.
