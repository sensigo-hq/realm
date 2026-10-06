# Gates: `trust` and the `gate` block

<!-- description: Reference for trust and the gate block: the trust values, every gate key, the rules the loader applies, and what is stored when a gate opens. -->

A step stops for a person when its `trust` says so. The `gate` block on the same step sets what the person is asked, what they can answer, and what happens if nobody answers. This page lists the three `trust` values and the nine `gate` keys, the rules the loader applies to them, and what is stored when a gate opens.

For a walk through one gate, see [Add a human gate](../../guides/human-gates.md).

## `trust`

`trust` is allowed on `auto` and `agent` steps. On a guard or a finalizer it is refused.

| Value             | Effect                                                     |
| ----------------- | ---------------------------------------------------------- |
| `auto`            | The step does not stop. This is the default.               |
| `human_confirmed` | The step stops at a gate until a person chooses.           |
| `human_reviewed`  | Reserved. Today it behaves exactly like `human_confirmed`. |

Any other value is refused when the file is loaded. A misspelling gets a suggestion:

```text
Invalid workflow: Step 'approve': 'trust: "human_confirmd"' is not a recognized value — refused at load: this workflow cannot create a run while the value is wrong, so no step of it — gated or not — ever executes under it. A step's 'trust' accepts auto, human_confirmed, human_reviewed. Did you mean 'human_confirmed'? … (line 8)
```

`engine_delivered`, `engine_managed` and `agent_provided` are trust values of a service, not of a step, and are refused here with a message that says so.

## The `gate` block

The block is read only on a step whose `trust` is `human_confirmed` or `human_reviewed`. All nine keys are optional.

| Key                                           | Type                        | Default             | What it does                                     |
| --------------------------------------------- | --------------------------- | ------------------- | ------------------------------------------------ |
| [`choices`](#choices)                         | list of text                | `approve`, `reject` | The answers a person can give.                   |
| [`message`](#message)                         | text, with expressions      | None                | What the person is asked.                        |
| [`owner`](#owner)                             | text                        | None                | Who is expected to answer.                       |
| [`resolution_messages`](#resolution_messages) | map from choice to text     | None                | What the Slack thread is told after each choice. |
| [`timeout_seconds`](#timeout_seconds)         | whole number above 0        | None: no time limit | How long the gate waits.                         |
| [`on_expiry`](#on_expiry)                     | `settle_default` or `abort` | None                | What happens when the time is up.                |
| [`default_choice`](#default_choice)           | one of the choices          | None                | The answer given by `on_expiry: settle_default`. |
| [`reminder_seconds`](#reminder_seconds)       | whole number above 0        | None                | How often a reminder is sent.                    |
| [`reminder_max`](#reminder_max)               | whole number above 0        | 3                   | How many reminders are sent.                     |

This step uses all nine:

```yaml
approve:
  description: A person decides whether the order ships.
  execution: auto
  trust: human_confirmed
  gate:
    choices: [ship, hold]
    owner: '@ana'
    message: Ship order 4417?
    resolution_messages:
      ship: Shipping now.
      hold: Held for review.
    timeout_seconds: 3600
    on_expiry: settle_default
    default_choice: hold
    reminder_seconds: 900
    reminder_max: 2
```

### `choices`

The answers that are accepted. An answer that is not in the list is refused:

```text
Choice 'send' is not valid. Expected one of: ship, hold
```

Without `choices`, the gate takes the `enum` of `input_schema.properties.choice` if the step has one, and otherwise `approve` and `reject`.

An empty list is refused when the file is loaded, because no answer could ever be accepted:

```text
Invalid workflow: Step 'approve': 'gate.choices', when declared, must be non-empty — … Declare at least one choice, or remove the key to fall back to 'input_schema.properties.choice.enum' or the default pair (approve/reject). (line 10)
```

A value that is not a list is ignored without a warning, and the gate uses `approve` and `reject`.

### `message`

The question shown to the person. It can contain template expressions, and is the strictest place for them: a value that is missing, or a filter that does not exist, stops the step before the gate opens. See [Template expressions](input-map-and-templates.md#template-expressions).

An assistant receives the rendered message as `gate.display`. Without `message`, the step's `prompt` is rendered and used. With neither, `gate.display` is absent.

### `owner`

A name for the person expected to answer. It is stored with the gate, returned to assistants by `get_run_state`, and printed in the Slack message. Realm does not check who answers.

### `resolution_messages`

For each choice, the text that Realm posts in the Slack thread after that choice is made. It is used only when gates are answered through Slack. See [Answer gates from Slack](../../guides/slack-gates.md).

### `timeout_seconds`

How long after opening the gate expires. Must be a whole number above 0:

```text
Invalid workflow: Step 'approve': 'gate.timeout_seconds' must be a positive integer (step at line 5)
```

With `timeout_seconds` and no `on_expiry`, nothing is done when the time is up. The gate is reported as expired and still waits for a person.

### `on_expiry`

| Value            | When the time is up                                                 |
| ---------------- | ------------------------------------------------------------------- |
| `settle_default` | The gate is answered with `default_choice`, and the run carries on. |
| `abort`          | The run ends as `aborted`.                                          |

Any other value is refused: `'gate.on_expiry' must be 'settle_default' or 'abort' (got: "skip")`.

### `default_choice`

Required with `on_expiry: settle_default`, and must be one of the gate's choices:

```text
Invalid workflow: Step 'approve': 'gate.on_expiry: settle_default' requires 'gate.default_choice' (nothing to resolve the gate with on expiry) (step at line 5)
Invalid workflow: Step 'approve': 'gate.default_choice' ("cancel") is not one of the step's effective choices: ship, hold (step at line 5)
```

### `reminder_seconds`

The time between reminders while the gate is open. Reminders are sent by the process that is waiting at the gate with a Slack connection. They never answer the gate.

### `reminder_max`

The number of reminders sent, 3 unless set. Must be a whole number above 0.

## Settings that do nothing

These are accepted, with a warning that says the setting has no effect:

| The step has                                          | Warning                                                                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A `gate` block, and `trust` that opens no gate        | `the 'gate:' block is inert — this step declares no gate trust …`                                                            |
| `on_expiry` without `timeout_seconds`                 | `'gate.on_expiry' is ignored without 'gate.timeout_seconds' — set a timeout, or remove 'gate.on_expiry'.`                    |
| `default_choice` without `on_expiry: settle_default`  | `'gate.default_choice' is ignored without 'gate.on_expiry: settle_default' — set it, or remove 'gate.default_choice'.`       |
| `reminder_seconds` not shorter than `timeout_seconds` | `'gate.reminder_seconds' (90) >= 'gate.timeout_seconds' (60) — the first reminder would never fire before the gate expires.` |
| A key that is not one of the nine                     | `unknown key 'choises' (line 10) — ignored (did you mean 'choices'?)`                                                        |

## What is stored when a gate opens

When the step reaches its gate, the settings are copied into the run. `get_run_state` returns them as `pending_gate`:

```json
{
  "gate_id": "0392b416-f4ba-4240-b9ae-8ecbebbeb248",
  "step_name": "approve",
  "preview": {},
  "choices": ["ship", "hold"],
  "opened_at": "2026-10-01T22:18:14.448Z",
  "owner": "@ana",
  "resolved_message": "Ship order 4417?",
  "resolution_messages": { "ship": "Shipping now.", "hold": "Held for review." },
  "expires_at": "2026-10-01T23:18:14.448Z",
  "on_expiry": "settle_default",
  "default_choice": "hold",
  "reminder_seconds": 900,
  "reminder_max": 2
}
```

`preview` is the output of the step so far, which the person is deciding about. `expires_at` is `opened_at` plus `timeout_seconds`.

**An open gate keeps the settings it opened with.** While this gate was open, the workflow was registered again with `choices: [send, cancel]`. The open gate refused `send` and accepted `ship`:

```text
Choice 'send' is not valid. Expected one of: ship, hold
Responded: 8fe4e695-938b-4abe-95d0-b297bbc5ddf6 | choice 'ship' | new state 'running'
```

The new settings apply to gates that open afterwards.

## What happens at expiry

Realm has no background process. A gate whose time is up stays open until a call acts on its run: a late answer, a call to another step of the run, `advance_run` (or `realm run advance`, or `advanceRun` in a program), `realm run drain --expired`, or `realm listen` started with `--sweep-expired-gates`. Once the time is up on a gate that declares `on_expiry`, `get_run_state` offers `advance_run`, which carries out the declared default or abort and then runs the steps it makes ready; a gate with no `on_expiry` is never touched. The status is then `advance_owed`, or `claim_stale` when another step's claim is past its time. A server that cannot read the workflow says `workflow_unresolved` instead. `advance_run`, `realm run advance` and `advanceRun` were added after version 0.46.0. Until a call carries the expiry out, the run is listed as expired:

```text
3fdf338c-…  ex-default v1  gate_waiting  …  gate: approve (0m)  EXPIRED 0m ago
```

and `realm run list --stuck` says what would be done:

```text
3fdf338c-…  ex-default v1  gate_waiting  …  approve=gate_expired(settle_default) (realm run advance)
34cba823-…  ex-abort v1    gate_waiting  …  approve=gate_expired(abort) (realm run advance)
774285e8-…  ex-finding v1  gate_waiting  …  approve=gate_expired(finding_only) (realm run respond)
```

The two dispositions the engine carries out name `realm run advance`, which carries them out now; the finding-only one names `realm run respond`. The `(realm run advance)` pointer was added after version 0.46.0.

`realm run drain --expired --all` reports the same, and with `--force` carries it out:

```text
  ✓ 34cba823-b1be-4688-8811-1f56eab4a775: gate enacted
  ✓ 3fdf338c-abd3-4315-b1d7-cdd5ae4b3575: gate enacted
Drained 2/2 run(s).
```

After `settle_default`, the record says that the answer came from the time limit: it holds `"choice": "hold", "resolved_by": "timeout"` for the step. On the gate's step, `realm run inspect` prints `Answer: hold · settled by the gate's expiry (no one answered)`, and `get_run_state` gives that answer `answered_by: { "by": null, "absent_cause": "settled_by_expiry" }`. When the expiry itself completed the run, with nothing left to run after the gate, `inspect` also shows `Sealed by: gate_expiry_default (approve)`.

After `abort`, the run reads:

```text
Phase: aborted
Sealed by: gate_expiry_abort (approve)
Cause: Gate 'approve' expired and the run aborted per the workflow's declared on_expiry.
```

Nothing was answered: `inspect` prints no `Answer:` line for the step, it lists the step under `Skipped:` as `gate_expired`, and `get_run_state` gives the step no `answers` entry.

Over MCP, the call that carries out an expiry says so in its `warnings`, naming itself — for a late answer, `this submit_human_response call first carried out its declared …` (`enacted_via: submit`). `realm run advance`, `realm run drain` and the process waiting at the gate print a line of their own; `realm run advance` prints it before the steps it runs. Afterwards, `realm run inspect` and `get_run_state` do not show which call carried it out.

### A guard after the gate

A guard step that the settled choice makes ready is decided in the same write as the expiry. In the examples below the gate's step is followed by a guard, `only_if_shipping`, which stops the run unless the choice is `ship`.

For one run, `realm run drain <run-id> --expired` names the choice it would settle and says what the guard would then do. With `--force` it carries the expiry out and says what the guard did:

```text
Run '0e0ace7e-e57c-400c-a63a-eaf685688d19': gate expired 0m ago — would enact settle_default 'hold'; guard 'only_if_shipping' would then abort the run (The order was held.) on --force.
```

```text
✓ gate enacted (settle_default 'hold').
Guard step 'only_if_shipping' aborted the run.
Reason: The order was held.
```

See [`drain`](../cli/realm-run-acting.md#drain) for the other forms.

### An answer after the time is up

**An answer that arrives after the time is up is not recorded.** The expiry is carried out first. What the person is told depends on what the gate declared.

**`on_expiry: settle_default`.** The gate was settled with its default choice. For such an answer `realm run respond` does not print `Responded:`. Its last line is `Not recorded:`, with the choice the gate was settled with and the run's phase.

If the answer is the choice the gate was settled with, the command exits 0:

```text
the outcome matches your choice, but it was settled by timeout; your response was not recorded.
Guard step 'only_if_shipping' passed.
Not recorded: e428e60c-a362-410f-8819-008e40456639 | gate settled by timeout with choice 'ship' | state 'running'
```

If the answer is a different choice, it is refused. Every line goes to the error stream, and the command exits 1:

```text
Gate '80e024ee-2fd7-415e-8d38-a2fb8faf0cbb' was settled by timeout with choice 'hold' — your choice 'ship' was not recorded.
Guard step 'only_if_shipping' aborted the run.
Reason: The order was held.
Not recorded: 71f47780-06a7-421c-87d0-c74d2c8998de | gate settled by timeout with choice 'hold' | state 'aborted'
```

The lines about the guard are printed only when this answer is the call that carried out the expiry. If `realm run drain --expired`, the process waiting at the gate, or `realm listen` carried it out first, that call reported the guard. The late answer then prints its first line and `Not recorded:`, and a different choice is told `was already resolved with choice 'ship'` in place of `was settled by timeout`:

```text
the outcome matches your choice, but it was settled by timeout; your response was not recorded.
Not recorded: 96727c7c-cdf5-495c-92ed-28cd478b19d6 | gate settled by timeout with choice 'ship' | state 'running'
```

```text
Gate '5f71e609-cf61-40ef-8397-2d46f5dd1a54' was already resolved with choice 'ship' — your choice 'hold' was not recorded.
Not recorded: efe0a7c8-65f7-4be4-9fd9-447f5badd0ed | gate settled by timeout with choice 'ship' | state 'running'
```

Over MCP these replies carry `answer_recorded: false`. See [`submit_human_response`](../mcp/tools.md#submit_human_response).

**`on_expiry: abort`.** The run ended and no choice was settled, so there is no `Not recorded:` line. The answer that carries out the abort is refused with the message below, and its MCP reply carries `answer_recorded: false`:

```text
Gate '638d412e-ee8a-492c-ae80-750d2a26cbc2' on 'approve' expired and the run aborted per the workflow's declared on_expiry — your choice was NOT recorded.
```

An answer that arrives after something else carried out the abort gets the refusal that every ended run gives, without that field:

```text
Run '063dee23-e68e-4d7f-bcc2-968dd764370c' is terminal; cannot submit a gate response — 'realm run resume' clears a stale pending gate on a resumable run, or 'realm run purge' removes the record entirely.
```

A gate with `timeout_seconds` and no `on_expiry` accepts an answer after its time is up.

## See also

- [Gates and trust](../../concepts/gates-and-trust.md) explains what a gate does and does not guarantee.
- [Add a human gate](../../guides/human-gates.md)
- [Answer gates from Slack](../../guides/slack-gates.md)
- [Step fields](step-fields.md)
