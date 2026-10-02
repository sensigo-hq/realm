# What Realm is, and when to use it

Realm is a workflow engine that an AI agent calls. You describe a job as a list of steps. The agent asks Realm for the next step, does it, and hands back the result. Realm accepts the result only if it fits the rules of that step. This page explains what that gives you, what it does not give you, and when it is the right tool.

## The problem it solves

When an agent follows instructions written in a prompt, every rule is a request. "Do not post before a person approves" works until the day the model skips it. Longer prompts and more capital letters do not change that: the agent is still free to do the wrong thing.

Realm moves the rules out of the prompt and into the thing the agent has to call. A step that is not allowed yet cannot run. An answer of the wrong shape is not recorded. The agent does not have to remember the rules, because it cannot get past them.

## How it is turned around

Most agent platforms call the model: the platform decides when the model runs and what it gets. Realm works the other way. The agent calls Realm.

1. The agent asks to run a step.
2. Realm replies with the task and the exact shape the answer must have.
3. The agent submits its answer.
4. Realm checks the answer. If it fits, Realm records it and the run moves on. If it does not, Realm refuses it and nothing changes.

Any program that speaks the Model Context Protocol (MCP) can be the agent: Claude, another assistant, or your own code. Realm can also run the model itself, with [`realm agent`](../guides/realm-agent.md).

## What Realm enforces

Each of these is something Realm refuses, not something it asks for. The refusals quoted here are from a real run of the pull-request review example.

**Order.** A step cannot run before the steps it depends on. An agent that tried to post a review before writing one got:

```text
Step 'post_approval' is not eligible in the current run state.
```

**Shape.** Every answer is checked against the step's schema, which lists the fields the answer must have and their types. A review with one field missing got:

```text
must have required property 'risk'
```

A field the step never asked for is refused the same way. A refused answer is not kept as the step's output.

**Human gates.** A step can be marked as needing a person. The run stops there, and the steps after it cannot run until an answer is recorded. While the gate was open, the agent's attempt to post anyway got the same refusal as above, and the run stayed where it was.

**A record.** Every step that runs leaves an entry: what went in, what came out, how long it took, and a hash (a short fingerprint) of the output. A step that was skipped has its reason recorded, for example:

```text
post_approval: when_false: confirm_review.choice == 'approve' [lhs → "request_changes"]
```

## What Realm does not do

- **It does not judge whether an answer is good.** It checks the shape of an answer, not its truth. A well-formed wrong answer is accepted.
- **It does not check who answers a gate.** A gate is answered by one call, from the command line, from Slack, or through the same MCP connection the agent uses. Realm records the answer; it does not verify that a person gave it. If the agent must not be able to approve its own work, answer gates from a channel the agent cannot reach.
- **It does not protect the record from later edits.** Run records are files on your machine. If someone changes a file by hand, `realm run inspect` shows the changed text without a warning. The hash tells you what the output was when the step ran; nothing re-checks it when you read the record.
- **It does not schedule work.** A run starts when something starts it: an agent, a command, or a webhook. There is no built-in timer.

## When to use it

Use Realm when a job has steps that must happen in order, when a person must approve something before it takes effect, or when you need to show afterwards what each step received and produced. Typical cases are code review that posts to a pull request, triage that writes to a ticket system, and anything an agent does on behalf of a client.

Do not reach for it when the job is one prompt and one answer, or when nothing bad happens if a step is skipped. A plain model call is less work.

## What you install

Realm is open source under the Apache-2.0 licence and runs on your own machine. The `realm` command-line tool is one npm package, `@sensigo/realm-cli`. Workflows and run records are stored as files under `~/.realm/`. There is nothing to sign up for.

## See also

- [Install and first run](install-and-first-run.md) gets you a finished run to look at.
- [How a run moves](how-a-run-moves.md) follows one run between the agent, Realm and the services it calls.
- [Human gates and trust levels](../concepts/gates-and-trust.md) covers who can answer a gate and how.
- [Evidence](../concepts/evidence.md) describes the record in full.
