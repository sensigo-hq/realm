# Gates: `trust` and the `gate` block

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

Realm has no background process. A gate whose time is up stays open until a call acts on its run: a late answer, a call to another step of the run, `realm run drain --expired`, or `realm listen` started with `--sweep-expired-gates`. Until then, the run is listed as expired:

```text
3fdf338c-…  ex-default v1  gate_waiting  …  gate: approve (0m)  EXPIRED 0m ago
```

and `realm run list --stuck` says what would be done:

```text
3fdf338c-…  ex-default v1  gate_waiting  …  approve=gate_expired(settle_default)
34cba823-…  ex-abort v1    gate_waiting  …  approve=gate_expired(abort)
774285e8-…  ex-finding v1  gate_waiting  …  approve=gate_expired(finding_only) (realm run respond)
```

`realm run drain --expired --all` reports the same, and with `--force` carries it out:

```text
  ✓ 34cba823-b1be-4688-8811-1f56eab4a775: gate enacted
  ✓ 3fdf338c-abd3-4315-b1d7-cdd5ae4b3575: gate enacted
Drained 2/2 run(s).
```

After `settle_default`, the record says that the answer came from the time limit. `realm run inspect` shows `Sealed by: gate_expiry_default (approve)`, and the run's record holds `"choice": "hold", "resolved_by": "timeout"` for the step.

After `abort`, the run reads:

```text
Phase: aborted
Sealed by: gate_expiry_abort (approve)
Cause: Gate 'approve' expired and the run aborted per the workflow's declared on_expiry.
```

**An answer that arrives after the time is up is not recorded.** The expiry is carried out first, and the person is told:

```text
Gate '9e07b1ef-ea66-4469-a3e1-fc0ce75372d3' was settled by timeout with choice 'hold' — your choice 'ship' was not recorded.
```

A gate with `timeout_seconds` and no `on_expiry` accepts an answer after its time is up.

## See also

- [Gates and trust](../../concepts/gates-and-trust.md) explains what a gate does and does not guarantee.
- [Add a human gate](../../guides/human-gates.md)
- [Answer gates from Slack](../../guides/slack-gates.md)
- [Step fields](step-fields.md)
