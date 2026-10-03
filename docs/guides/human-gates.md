# Add a human gate

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
Run is paused at gate '39792a3a-f9c3-470a-b94c-c314fb254234'. Available choices: send, discard.
```

An agent that tries to run `send` at this point is refused:

```text
status: blocked
Step 'send' is not eligible in the current run state.
```

Find runs that are waiting, from any terminal:

```bash
realm run list --status gate_waiting
```

It prints:

```text
64993bb2-6f65-47d9-801c-d008e9291a00  announce v1  gate_waiting  10/1/2026, 11:13:36 PM  2 step(s)  gate: review (0m)
```

`realm run inspect <run-id>` shows the gate's ID and choices:

```text
Gate: review (gate 39792a3a-f9c3-470a-b94c-c314fb254234, opened 0m ago)
  Choices: send, discard
```

## 6. Answer it

Answer with the run ID, the gate ID and a choice:

```bash
realm run respond 64993bb2-6f65-47d9-801c-d008e9291a00 --gate 39792a3a-f9c3-470a-b94c-c314fb254234 --choice send
```

It prints:

```text
Responded: 64993bb2-6f65-47d9-801c-d008e9291a00 | choice 'send' | new state 'running'
```

The answer names its answerer only if you say who with `--by`:

```bash
realm run respond 64993bb2-6f65-47d9-801c-d008e9291a00 --gate 39792a3a-f9c3-470a-b94c-c314fb254234 --choice send --by alice
```

Realm records the name as you give it, without spaces at either end, and does not check it. It takes at most 200 characters, with no control characters, and `realm run inspect` shows it as `answered by alice (as stated, not verified)`. Without `--by` it shows `(not stated)`. `--by` names a person. It is never filled in from the operating system or from `REALM_OPERATOR`, which name a program.

An AI assistant connected over MCP answers by copying the call in `next_actions[0].instruction.call_with` and filling in the choice. That call carries the `claim_token` from the reply that opened the gate. See [The claim token](../reference/mcp/tools.md#the-claim-token).

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
- **At the `realm workflow run` prompt, the gate shows `Preview:` and raw JSON, not your message.** The hand-run prompt does not use `gate.message`. Drivers that connect over MCP, and `realm agent`, show the message.

## See also

- [Gates reference](../reference/workflow/gates.md) lists every `gate` key, including reminders.
- [Answer gates from Slack](slack-gates.md)
- [Operate runs](operate-runs.md) covers runs that are stuck at a gate.
