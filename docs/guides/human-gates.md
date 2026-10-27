# Add a human gate

<!-- description: Add a point where a person must decide before anything takes effect: a gate with your own choices and message, a step for one choice, and a time limit. -->

This guide adds a point in a workflow where a person must decide before anything takes effect. At the end you have a gate with your own choices and message, a step that runs only for one of the choices, and a time limit with a safe default.

## Before you start

You need a workflow you can run. [Write your first workflow](first-workflow.md) makes one. For how gates work, read [Human gates and trust levels](../concepts/gates-and-trust.md).

## The workflow this guide builds

An agent drafts an announcement, a person decides, and the announcement is sent only if they say so.

```yaml
id: announce
name: Send an announcement
version: 1

steps:
  draft:
    description: Draft the announcement.
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [subject, body]
      properties:
        subject:
          type: string
        body:
          type: string

  review:
    description: A person decides whether the announcement goes out.
    execution: auto
    depends_on: [draft]
    trust: human_confirmed
    gate:
      choices: [send, discard]
      message: |
        Subject: {{ context.resources.draft.subject | upper }}

        {{ context.resources.draft.body }}
      resolution_messages:
        send: 'Sent.'
        discard: 'Discarded. Nothing was sent.'

  send:
    description: Send the announcement.
    execution: auto
    depends_on: [review]
    when: "review.choice == 'send'"
```

## 1. Put the gate on its own step

Add an `auto` step after the work that needs approval, and set `trust: human_confirmed` on it. The run stops when it reaches this step.

Keeping the gate on its own step, apart from the agent step, makes the record clear: one entry for what the agent produced, and a separate step for the decision.

## 2. Name the choices

List the choices under `gate.choices`. Use words that say what will happen, such as `send` and `discard`. Without `gate.choices`, the choices are `approve` and `reject`.

## 3. Write what the person sees

Put the text for the person in `gate.message`. It can pull in earlier results with `{{ context.resources.STEP.FIELD }}`, and it can use filters such as `upper`. For the draft above, the person is shown:

```text
Subject: OFFICE CLOSED FRIDAY

The office is closed this Friday.
```

Show the thing being approved itself, not a description of it. The person should not have to look anywhere else to decide.

The message is rendered once, when the gate opens. Every surface shows it with the step's output below it, through the step's `display` when it has one. When the two together pass 600 characters, they are cut to fit, and a sentence at the end of the message says so; approving still lets the step's whole output go ahead. See [`message`](../reference/workflow/gates.md#message).

`gate.resolution_messages` gives one line per choice. When a gate is answered from Slack, Realm posts that line in the thread to confirm what happened.

## 4. Act on the answer

The answer is available to later steps as `review.choice`. Give the step that must wait for approval a `when` condition:

```yaml
when: "review.choice == 'send'"
```

A step with this condition is skipped for any other answer.

## 5. Run to the gate

Register the workflow and start a run with whichever driver you use. When the draft is accepted, the run stops. The driver is told:

```text
status: confirm_required
run_phase: gate_waiting
Run is paused at gate '39792a3a-f9c3-470a-b94c-c314fb254234'.
```

The choices are the gate's (`send`, `discard`); the line named them up to version 0.47.0.

An agent that tries to run `send` at this point is refused:

```text
status: blocked
Step 'send' cannot be called now: it waits on the question on step 'review' (choices: send, discard) — answer it with submit_human_response.
```

Its `next_actions` holds that answer, `submit_human_response`. Added after version 0.46.0, which says `Step 'send' is not eligible in the current run state.` and offers nothing to call.

That refusal is from a session that lists the answer tool. Under `withheld`, or in an app that shows forms, the refusal names no answer, and `next_actions` holds the await entry instead of the answer call (see [Gate answers](../reference/mcp/gate-answers.md)).

Find runs that are waiting, from any terminal:

```bash
realm run list --status gate_waiting
```

It prints:

```text
64993bb2-6f65-47d9-801c-d008e9291a00  announce v1  gate_waiting  10/1/2026, 11:13:36 PM  2 step(s)  gate: review (0m)
```

`realm run inspect <run-id>` shows the gate's ID, its question as the person reads it, its choices and the command that answers it (the question and the command were added after version 0.47.0):

```text
Gate: review (gate 39792a3a-f9c3-470a-b94c-c314fb254234, opened 0m ago)
  Question: "Subject: OFFICE CLOSED FRIDAY\n\nThe office is closed this Friday.\n"
  Choices: send, discard
  To answer: realm run respond 64993bb2-6f65-47d9-801c-d008e9291a00 --gate 39792a3a-f9c3-470a-b94c-c314fb254234 --choice <one of: send, discard>
```

## 6. Answer it

Answer with the run ID, the gate ID and a choice:

```bash
realm run respond 64993bb2-6f65-47d9-801c-d008e9291a00 --gate 39792a3a-f9c3-470a-b94c-c314fb254234 --choice send
```

It prints:

```text
Responded: 64993bb2-6f65-47d9-801c-d008e9291a00 | choice 'send' | new state 'running'
Owed to the engine: 'send' — realm run advance 64993bb2-6f65-47d9-801c-d008e9291a00 runs it, with no project code (nothing to load under /home/me/announce), in the environment of the shell it runs in.
If a realm workflow run or realm agent is still waiting on this run, it goes on by itself; the line above is for when none is.
```

The second line names the step the answer leaves to the engine and the command that runs it; the third is printed with it. Both were added after version 0.46.0.

The answer names its answerer only if you say who with `--by`:

```bash
realm run respond 64993bb2-6f65-47d9-801c-d008e9291a00 --gate 39792a3a-f9c3-470a-b94c-c314fb254234 --choice send --by alice
```

Realm records the name as you give it, without spaces at either end, and does not check it. It takes at most 200 characters, with no control characters, and `realm run inspect` shows it as `answered by alice (as stated)`. Without `--by` it shows `(not stated)`. `--by` names a person. It is never filled in from the operating system or from `REALM_OPERATOR`, which name a program.

Over MCP, who answers depends on the server's gate-answers value (see [Gate answers over MCP](../reference/mcp/gate-answers.md)). Under the default, `asked`, a chat app that shows forms gets the question as a form, and the person answers there; under `withheld`, no tool answers. On an HTTP server built per request — `realm serve`, or a program that builds a server per request or passes `statelessHttp` — no client gets forms: under `asked` every client keeps the answer tool, marked for approval. A program that keeps one server per HTTP session sends forms as stdio does. An AI assistant that has the answer tool (under `offered`, or under `asked` in an app that shows no forms) answers by copying the call in `next_actions[0].instruction.call_with` and filling in the choice. In the reply that opened the gate, that call carries the gate's `claim_token`; the same call in a later reply, such as `get_run_state`'s, has none. See [The claim token](../reference/mcp/tools.md#the-claim-token).

A choice that is not on the list is refused, and the gate stays open:

```text
Choice 'maybe' is not valid. Expected one of: send, discard
```

The driver then carries on. Here it ran `send`, and the run completed:

```text
Phase: completed  ✓
Completed: draft, review, send
```

## 7. Set a time limit

A gate with no limit waits for ever. To give it one, add three keys:

```yaml
gate:
  choices: [send, discard]
  timeout_seconds: 86400
  on_expiry: settle_default
  default_choice: discard
```

After a day with no answer, the gate is answered with `discard`. Choose the default that is safe to happen unattended. To stop the run instead, use `on_expiry: abort` and leave out `default_choice`.

The limit takes effect when something acts on the run. To have expired gates dealt with on a schedule, run this from cron:

```bash
realm run drain --expired --all --force
```

With a two-second limit for the test, it printed:

```text
  ✓ 2d252821-75ef-4e16-b3c4-41d7a125f830: gate enacted
Drained 1/1 run(s).
```

The record shows that the default was used and that `send` did not run:

```text
Phase: completed  ✓
Sealed by: gate_expiry_default (review)
Skipped: send
  send: when_false: review.choice == 'send' [lhs → "discard"]
```

## If you see something else

- **`'gate.on_expiry: settle_default' requires 'gate.default_choice'`** You asked for a default answer without naming it. Add `default_choice`, with one of the gate's choices.
- **At the `realm workflow run` prompt, the gate shows `Preview:` but no `Question:` line.** The gate has no `message`, so there is no question to show: the step's `prompt` is never shown as the question. Add a `message`. Up to version 0.46.0 the hand-run prompt showed no question for any gate.

## See also

- [Gates reference](../reference/workflow/gates.md) lists every `gate` key, including reminders.
- [Answer gates from Slack](slack-gates.md)
- [Operate runs](operate-runs.md) covers runs that are stuck at a gate.
