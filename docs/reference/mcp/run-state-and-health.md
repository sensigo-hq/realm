# Run state and health findings

<!-- description: Every field of the get_run_state reply, every value of next_actions_status, and the health findings that realm run inspect and the stuck-run list also report. -->

`get_run_state` returns where a run stands: its phase, its steps, what can be called next, and anything Realm finds wrong with it. This page lists every field of the reply, the 8 values of `next_actions_status`, and the 14 health findings, which `realm run inspect` and `realm run list --stuck` also report. Every reply shown came from a call.

For the tool's parameters, see [MCP tools](tools.md#get_run_state).

## The reply

For a run that is waiting at a gate:

```json
{
  "run_id": "7da561ee-5987-497d-83a5-1eded6dc9b63",
  "workflow_id": "triage",
  "run_phase": "gate_waiting",
  "terminal_state": false,
  "completed_steps": ["classify"],
  "in_progress_steps": ["draft"],
  "failed_steps": [],
  "skipped_steps": [],
  "pending_gate": {
    "gate_id": "00bb04f5-1bb7-4f38-91c5-14cdb17b3f0e",
    "step_name": "draft",
    "preview": { "reply": "We have refunded the charge." },
    "choices": ["send", "discard"],
    "opened_at": "2026-10-01T23:34:09.630Z"
  },
  "evidence_count": 2,
  "last_step": "draft",
  "created_at": "2026-10-01T23:34:09.429Z",
  "updated_at": "2026-10-01T23:34:09.635Z",
  "params": { "ticket": 101 },
  "next_actions": [],
  "next_actions_status": "awaiting_human"
}
```

For the same run after it completed, `pending_gate` is gone and two fields are added:

```json
{
  "run_phase": "completed",
  "terminal_state": true,
  "terminal_reason": "Workflow completed.",
  "sealed_by_arm": "complete",
  "next_actions": [],
  "next_actions_status": "skipped_terminal"
}
```

### Fields that are always present

| Field                                                                   | Holds                                                                                                 |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `run_id`, `workflow_id`                                                 | The run and its workflow.                                                                             |
| `run_phase`                                                             | `running`, `gate_waiting`, `completed`, `failed`, `abandoned` or `aborted`.                           |
| `terminal_state`                                                        | `true` once the run has ended.                                                                        |
| `completed_steps`, `in_progress_steps`, `failed_steps`, `skipped_steps` | The names of the steps in each state.                                                                 |
| `evidence_count`                                                        | How many entries the run's record has.                                                                |
| `last_step`                                                             | The step of the newest entry, or `null`.                                                              |
| `created_at`, `updated_at`                                              | When the run was started and when it last changed, in UTC.                                            |
| `params`                                                                | The parameters the run was started with.                                                              |
| `next_actions`                                                          | The calls that can be made next, in the form given in [MCP tools](tools.md#an-entry-of-next_actions). |
| `next_actions_status`                                                   | Why `next_actions` is what it is. See below.                                                          |

### Fields that are present when they apply

| Field                   | Present when                                                                                                             | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending_gate`          | A gate is open                                                                                                           | The gate: `gate_id`, `step_name`, `preview`, `choices`, `opened_at`, and the settings stored when it opened. See [Gates](../workflow/gates.md#what-is-stored-when-a-gate-opens).                                                                                                                                                                                                                                                                                                                                  |
| `terminal_reason`       | The run has ended, unless a guard aborted it                                                                             | What ended it, as a sentence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `sealed_by_arm`         | The run has ended                                                                                                        | What ended it, as a fixed word such as `complete`, `step_failure` or `abandon_requested`.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `sealed_by_step`        | A guard, a gate or a handler ended the run                                                                               | That step.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `sealed_by_classified`  | The ending was worked out by `realm run migrate`                                                                         | `true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `sealed_by_adjudicated` | A person has ruled on how the run ended                                                                                  | Who, when, the earlier value and the reason.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `rerun_of`              | The run replaced an earlier run with the same key                                                                        | The earlier run's ID.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `abort_context`         | A guard aborted the run                                                                                                  | The guard, its conditions with their values, and its message.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `skip_details`          | A step was skipped                                                                                                       | For each skipped step, the kind of skip and what decided it.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `defaulted_steps`       | A step was given its default output                                                                                      | The names of those steps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `drive_failures`        | `realm agent` gave up on the run at least once                                                                           | The failures: the time, the step, the provider, the kind, and what was billed.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `run_health`            | The run is open and Realm finds something wrong                                                                          | The findings. See [Health findings](#health-findings).                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `stuck_claims`          | The run is open and a step is in progress past its time, or for an unknown time                                          | Each such step and its state. The same facts as the `stale_claim` and `wedged_gate_sibling` findings.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `step_claims`           | The run is open and a step is in progress                                                                                | For each such step, `step`, `holder` and `since`. `holder` is the program that took the step: `by` (its name), `by_source` (`stated`, `ambient` for `REALM_OPERATOR`, or `derived` for the OS user and host name) and `channel` (the door, such as `mcp-stdio` or `agent`). If there is no name it is `{ "by": null, "absent_cause": … }`. A step whose question is open names the program through which the question was opened, and says nothing about anyone working on it now. The claim's token is not here. |
| `engine_runnable`       | The run is open and owes `auto` steps                                                                                    | Each such step and `runnable_here` (`true`, `false` or `"unknown"`). When `false`: `refused_by` (`trust`, `precondition`, `input_schema` or `capability`), `refusal`, and for `capability` a `basis` (`registry` or `marker`). Added after version 0.46.0.                                                                                                                                                                                                                                                        |
| `pending_guards`        | The run is open and a guard is ready that no write has decided                                                           | The guards. Added after version 0.46.0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `capability_blocks`     | The run is open and records that the program which last attempted a step lacked its code, and the step has not run since | Each such step, what it needs, and the error code: the record's marker, shown whenever the run carries one, whatever this server has. The `capability_block` finding is narrower: `get_run_state` reports it only when this server lacks the code too (see [The 14 findings](#the-14-findings)). Added after version 0.46.0.                                                                                                                                                                                      |
| `warnings`              | There is something to say about the reply                                                                                | Sentences, such as `this run has 1 active run-health finding(s) — see 'run_health' for detail.`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `steps`                 | `include_steps` was `true`                                                                                               | Each step's attempts and their cost. See [`include_steps`](#include_steps).                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `drive_failure_costs`   | `include_steps` was `true` and there are drive failures                                                                  | The cost of each failed drive, in the order of `drive_failures.entries`.                                                                                                                                                                                                                                                                                                                                                                                                                                          |

A skipped step's entry in `skip_details`:

```json
"skip_details": {
  "route": {
    "kind": "when_false",
    "expression": "$settlement.classify.settled_by_default == false",
    "leaves": [
      {
        "leaf": "$settlement.classify.settled_by_default == false",
        "lhs_present": true,
        "resolved_value": true,
        "passed": false
      }
    ]
  }
}
```

For a run that a guard aborted:

```json
"sealed_by_arm": "guard_abort",
"sealed_by_step": "limit",
"abort_context": {
  "step_id": "limit",
  "conditions": [{ "condition": "quote.amount <= 1000", "resolved_value": 5000, "passed": false }],
  "abort_message": "The amount is over the limit."
}
```

A run ID that is not in the store gets a reply with `status: "error"` and the message `Run not found: nope`.

## `next_actions_status`

| Value                   | Means                                                                                                                                                                                                                                                                                                                           | `next_actions`                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `ok`                    | `next_actions` says what to do next.                                                                                                                                                                                                                                                                                            | The steps that can be called. It can be empty. |
| `awaiting_human`        | A gate is open.                                                                                                                                                                                                                                                                                                                 | Empty.                                         |
| `skipped_terminal`      | The run has ended.                                                                                                                                                                                                                                                                                                              | Empty.                                         |
| `advance_owed`          | The only work that can run is the engine's: a guard is pending or an `auto` step can run here. Added after version 0.46.0, which says `auto_pending` and offers no act.                                                                                                                                                         | The one act, `advance_run`.                    |
| `blocked_on_capability` | An owed step needs a handler or an adapter that this server does not have, and nothing else is owed to the engine. A server judges with its own extensions (an empty set when it has no project extensions). A server that has it says `advance_owed`. Judging with the server's own extensions was added after version 0.46.0. | Empty, or the agent steps that are ready.      |
| `claim_stale`           | A step was started, did not finish, and is past its time. The process running it has probably died.                                                                                                                                                                                                                             | Any other steps that can be called.            |
| `claim_unknown_age`     | A step was started and did not finish, Realm has no time limit for it, and nothing else can be called.                                                                                                                                                                                                                          | Empty.                                         |
| `workflow_unresolved`   | The run's workflow cannot be read, so Realm cannot work out the next step.                                                                                                                                                                                                                                                      | Empty.                                         |

When more than one applies, `awaiting_human` comes first, then `blocked_on_capability`, then `claim_stale`.

`ok` with an empty `next_actions` on an open run means one of two things. A step is in flight elsewhere: wait for it. Or every step the engine owes cannot run (an invalid `trust`, a failed precondition, an input its schema refuses) — `engine_runnable` names each with `refused_by` and `refusal`. Waiting does not help then: the run cannot go on until the workflow is corrected and registered again (the run picks up the corrected definition), or it is ended with `abandon_run`. Every reply that says what comes next ends with that way out — the reply of the step or the answer that left the run there, `start_run`'s creation reply, and `advance_run`'s reply, which runs nothing: `Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.` A step refused for its handler or adapter also says what it was judged from, in `basis` (added after version 0.46.0): `registry` — the server's own extensions lack it (`refusal`: `handler '<name>' is not registered here`). Every server judges this way: one with no project extensions has an empty set of them. Only a caller that passes no extensions at all — a program that embeds the engine — judges by the run's `capability_blocks` record of the last attempt: `basis` `marker`, `refusal` `handler '<name>' was not registered in the runner that last attempted it`. With neither, `runnable_here: "unknown"`. A guard that is ready and that no write has decided is owed work: the status is `advance_owed` and `next_actions` holds `advance_run` (see `guard_awaiting_settlement` below). This paragraph describes behaviour added after version 0.46.0.

## `include_steps`

`include_steps`, and the `steps` and `drive_failure_costs` fields it adds, were added after version 0.45.0. So was the record of what a failed drive was billed. So were `step_claims`, `driven_by` and `answers`.

With `include_steps: true`, the reply has a `steps` object with one entry for each step that ran:

```json
"steps": {
  "classify": {
    "attempts": [
      {
        "attempt": 1,
        "status": "success",
        "cost": {
          "requests": 1,
          "basis": "unobservable",
          "state": "unobservable",
          "prompt": { "value": 412, "reported": 1, "of": 1, "only_request_index": 0 },
          "output": { "value": 38, "reported": 1, "of": 1, "only_request_index": 0 }
        }
      }
    ]
  }
}
```

| Field                                                        | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attempt`                                                    | The attempt's number, from 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `status`                                                     | `success` or `error`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `cost`                                                       | What the model calls of this attempt cost, if `realm agent` made them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `cost_unrecorded`                                            | Why there is no `cost`: `not_driven_by_realm` if an outside assistant or a person gave the answer, `tool_calling_step` if the step used tools.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `cost.requests`                                              | How many requests were made to the model.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `cost.prompt`, `cost.output`                                 | Tokens sent and received.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `cost.cache_read`, `cost.cache_write`, `cost.uncached_input` | Tokens the provider read from its cache, wrote to it, and charged in full. Present only if the provider reported them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `cost.basis`, `cost.state`                                   | How the cache numbers are known and what they show. `unobservable` means the provider reported nothing about its cache.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `driven_by`                                                  | The program whose code ran this attempt, in the same form as `holder` in `step_claims`. `{ "by": null, "absent_cause": "driver_not_recorded" }` if the attempt's entry names none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `answers`                                                    | On the step, beside `attempts`. One entry for each answer to the step's gate: `choice`; `answered_by`, which is `{ "by": …, "by_source": "stated" }` (the name the caller gave, not verified) or `{ "by": null, "absent_cause": … }` with `not_stated` (the caller gave no name), `name_unreadable` (a stored name that cannot be shown) or `settled_by_expiry` (the gate's expiry wrote its default choice: no one answered); and `claim_proof`, the verdict of [the claim token](tools.md#the-claim-token). A step with an answer and no attempt still has an entry, with `attempts: []`. An `on_expiry: abort` expiry is not an answer: the step gets no `answers` entry, and `skip_details` says `gate_expired`. When there is no `claim_proof`, `claim_proof_absent` says why: `settled_by_expiry`, `proof_not_recorded` or `proof_unreadable`. |

Each number is an object: `value` is the sum over the requests that reported it, `reported` is how many requests did, and `of` is how many requests there were. A number that no request reported is absent. It is never given as 0.

For an agent step whose output a caller passed in over MCP, the attempt has no cost:

```json
{
  "attempt": 1,
  "status": "success",
  "driven_by": { "by": "ana@build-01", "by_source": "derived", "channel": "mcp-stdio" },
  "cost_unrecorded": "not_driven_by_realm"
}
```

`driven_by` names the program that recorded the attempt, here Realm's MCP server. `not_driven_by_realm` says that the model call which produced the output was not made by Realm, so Realm has no cost for it.

## Health findings

A finding is one thing Realm has noticed about a run that someone may need to act on. Each has a `kind`, a `reason`, and where they apply a `step`, a `since` time and `evidence`.

```json
"run_health": [
  {
    "kind": "drive_failing",
    "step": "classify",
    "reason": "the last drive attempt failed 17m ago (connection_error): Connection error.",
    "evidence": {
      "step": "classify",
      "error_class": "connection_error",
      "at": "2026-10-01T23:21:18.899Z",
      "total": 1,
      "first_failed_at": "2026-10-01T23:21:18.899Z",
      "derived_ceiling_ms": 1861500
    }
  }
]
```

### Where findings are shown

| Surface                  | Shows                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_run_state`          | The findings of a run that is open, judged with this server's extensions: a `capability_block` finding only when this server lacks the code too. (added after version 0.46.0) For a run that has ended, `run_health` is absent. |
| `realm run inspect`      | The findings of any run, open or ended, under `Run Health`.                                                                                                                                                                     |
| `realm run list --stuck` | The runs that have a finding, with a short label at the end of the line. It does not read workflows, so the two findings that need the workflow are never found by it, and two findings do not select a run.                    |

### The 14 findings

Findings about a run that is open:

| `kind`                         | Found when                                                                                                                                                                                                                                                                                                | Label in `list --stuck`                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `never_claimed_idle`           | The run is in `running`, no step is in progress, and it has not changed for 24 hours.                                                                                                                                                                                                                     | None. The line ends after `idle:`.                             |
| `drive_failing`                | The last thing that happened to the run was a failed drive by `realm agent`.                                                                                                                                                                                                                              | `<step>=drive_failing(<kind>)`                                 |
| `stale_claim`                  | A step is in progress past its time, or for an unknown time, and the run is in `running`.                                                                                                                                                                                                                 | `<step>=claim_stale` or `<step>=claim_unknown_age`             |
| `wedged_gate_sibling`          | The same, in a run that is waiting at a gate, for a step other than the gate's.                                                                                                                                                                                                                           | `<step>=claim_stale` or `<step>=claim_unknown_age`             |
| `capability_block`             | A step needs a handler or an adapter that the process which tried it did not have. `get_run_state` leaves the finding out for a step its own server can run (the record stays in `capability_blocks`); `inspect` and `list --stuck` read the record alone. Leaving it out was added after version 0.46.0. | `<step>: needs handler '<name>'`                               |
| `gate_expired_awaiting_drive`  | A gate's time has passed and nothing has yet carried out what was declared for it.                                                                                                                                                                                                                        | `<step>=gate_expired(<on_expiry>)`                             |
| `guard_awaiting_settlement`    | A guard step is ready, and no write has decided it.                                                                                                                                                                                                                                                       | Not found by `list`.                                           |
| `trust_value_invalid`          | A step that is ready has a `trust` value Realm does not accept. The registered copy was stored by an older version.                                                                                                                                                                                       | Not found by `list`.                                           |
| `definition_unresolvable`      | The run's registered workflow cannot be read.                                                                                                                                                                                                                                                             | `definition_unresolvable (<why>) (realm run inspect <run-id>)` |
| `gate_corruption`              | The run's record says a gate is both answered and open.                                                                                                                                                                                                                                                   | `<step>=gate_corruption`                                       |
| `structured_output_downgraded` | A step asked for `structured_output: strict` and ran without it.                                                                                                                                                                                                                                          | None. It does not select a run.                                |

Findings about a run that has ended:

| `kind`                        | Found when                                                                                 | Label in `list --stuck`               |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------- |
| `terminal_pending_finalizer`  | The run still owes a cleanup step.                                                         | `<step>=<state> (realm run drain)`    |
| `completed_with_failed_steps` | The run completed, and one of its steps had failed.                                        | None. It does not select a run.       |
| `terminal_with_stale_gate`    | The run's record still holds an open gate. Only records written by old versions have this. | `<step>=stale_gate (realm run purge)` |

`structured_output_downgraded` is also found on runs that have ended.

### Examples

`never_claimed_idle`, for a run that had not changed for two days:

```json
{
  "kind": "never_claimed_idle",
  "reason": "parked with no claimed step, idle",
  "since": "2026-09-29T23:39:44.004Z",
  "idle_ms": 172815275,
  "evidence": { "idle_threshold_ms": 86400000, "eligible_steps": ["a"] }
}
```

`stale_claim`, for a step whose process was killed, 15 minutes after the step started. The reply also has `"next_actions_status": "claim_stale"` and the same step under `stuck_claims`:

```json
{
  "kind": "stale_claim",
  "step": "fetch",
  "reason": "claim_stale",
  "evidence": { "state": "claim_stale", "deadline": "2026-10-01T23:53:39.499Z" }
}
```

When Realm has no time limit for the step, `reason` and `evidence.state` are `claim_unknown_age`, `deadline` is `null`, and the finding is there from the start.

`wedged_gate_sibling`, for the same in a run that is waiting at a gate on another step. `next_actions_status` stays `awaiting_human`:

```json
{
  "kind": "wedged_gate_sibling",
  "step": "fetch",
  "reason": "claim_stale",
  "evidence": { "state": "claim_stale", "deadline": "2026-10-01T23:53:41.736Z" }
}
```

The lines `realm run list --stuck` prints for these runs:

```text
cc91f631-831e-44ce-862d-3f2f46dbe964  tidy2 v1  running  10/2/2026, 2:43:14 AM  0 step(s)  idle: 10m  fetch=claim_unknown_age
f0d487b6-747a-4106-953b-b52ae36e4e59  gated v1  gate_waiting  10/2/2026, 2:39:37 AM  1 step(s)  idle: 14m  approve=gate_expired(abort)
e315bb67-091d-4283-aa74-3b85503ef109  fan v1  gate_waiting  10/2/2026, 2:38:47 AM  1 step(s)  idle: 15m  fetch=claim_stale
83bb9750-bbc0-4b1c-8e03-64014a6da81d  sync v1  running  10/2/2026, 2:38:39 AM  0 step(s)  idle: 15m  fetch=claim_stale
88a6d0fd-a89c-46eb-934f-e4ba0eb320bd  idle v1  running  9/30/2026, 2:39:44 AM  0 step(s)  idle: 2d 0h
```

`capability_block`:

```json
{
  "kind": "capability_block",
  "step": "total",
  "reason": "ENGINE_HANDLER_NOT_REGISTERED",
  "since": "2026-10-01T20:15:33.944Z",
  "evidence": {
    "requirement": { "kind": "handler", "name": "order_totl" },
    "code": "ENGINE_HANDLER_NOT_REGISTERED"
  }
}
```

`gate_expired_awaiting_drive`:

```json
{
  "kind": "gate_expired_awaiting_drive",
  "step": "approve",
  "reason": "gate expired — awaiting enactment of the declared abort",
  "evidence": {
    "gate_id": "60d9660a-cdf5-41b5-8c20-d1739faba3ce",
    "expires_at": "2026-10-01T23:39:39.676Z",
    "overdue_ms": 18108,
    "disposition": "abort"
  }
}
```

`guard_awaiting_settlement`, for a workflow whose only first step is the guard `limit`:

```json
{
  "kind": "guard_awaiting_settlement",
  "step": "limit",
  "reason": "guard 'limit' is eligible and has not been settled"
}
```

A guard is decided inside the write that makes it ready: a step that finishes, an answer to a gate, or a gate whose time runs out. This finding is about a guard that became ready some other way. That is a guard that is ready when the run is created, as here, or when `realm run resume` opens the run again at a failed guard, or a run kept in a store that does not settle in one write. Such a guard is decided by the run's next finished step or gate answer. Where the run has none, as in the workflow above, `next_actions` is empty, and a call to the guard or to the step after it is refused as not eligible.

`trust_value_invalid`, for a workflow registered by version 0.38 with `trust: human_confirm`:

```json
{
  "kind": "trust_value_invalid",
  "step": "review",
  "reason": "'trust: \"human_confirm\"' is not a recognized value — the engine will refuse this step at dispatch (VALIDATION_TRUST_VALUE). Accepts auto, human_confirmed, human_reviewed; did you mean 'human_confirmed'? — correct the value and 'realm workflow register <path>'.",
  "evidence": { "trust": "human_confirm" }
}
```

`definition_unresolvable`:

```json
{
  "kind": "definition_unresolvable",
  "reason": "Workflow 'dynamic-67280ddfb5f913a2' not found — this run's workflow was created by an agent (create_workflow) and its stored copy is gone; there is no source file to register. To end the run: realm run abandon 88620ee8-f8c1-4889-9468-a62dcb1b3c8f.",
  "evidence": { "workflow_id": "dynamic-67280ddfb5f913a2", "code": "STATE_WORKFLOW_NOT_FOUND" }
}
```

The findings about ended runs, as `realm run inspect` prints them:

```text
Run Health (1 finding(s)):
  terminal_pending_finalizer [release]: lease_held
```

```text
Run Health (1 finding(s)):
  completed_with_failed_steps: completed with 1 failed step(s): fetch — fail-triggered finalizers do not run on a completed seal unless the workflow opts into the 'completed_with_failed_steps' trigger
```

```text
Run Health (1 finding(s)):
  structured_output_downgraded: 1 step(s) requested strict structured output but ran without it (classify: compat_endpoint) — outputs were validated post-hoc (L1), not grammar-constrained
```

`gate_corruption` and `terminal_with_stale_gate` describe records that current versions of Realm do not write. They were not reproduced for this page.

## See also

- [MCP tools](tools.md)
- [`realm run`: commands that read](../cli/realm-run-reading.md) covers `inspect` and `list --stuck`.
- [`realm run`: commands that act](../cli/realm-run-acting.md) covers `reclaim`, `drain` and `respond`.
- [The run record and export file](../run-record-and-export.md)
- [Operate runs](../../guides/operate-runs.md)
