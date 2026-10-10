# Run record and export bundle format

<!-- description: Every field of a run record and of an evidence entry, the objects inside them, and the fields of the file that realm run export writes. -->

A run's record is one JSON object that holds everything Realm knows about the run. This page lists the record's 34 fields, the 30 fields of an evidence entry (28 rows below: two rows hold two fields each), the smaller objects inside them, and the 9 fields of the file that `realm run export` writes. The field lists come from Realm's types. All 34 record fields, and the fields of 26 of the 27 evidence rows that 0.46.0 has, were seen in the 312 run records and 519 evidence entries written while these docs were made. The example at the end is one real run.

## Where the record is

With the file store, the record is the file `~/.realm/runs/<run-id>.json`. `realm run inspect` prints a view of it. `get_run_state` returns part of it. `realm run export` writes all of it, with the run's other files, into one bundle.

Realm rewrites the file each time the run changes, and adds 1 to `version` each time.

## The record's fields

### What the run is

| Field              | Type   | Always there | Holds                                                                        |
| ------------------ | ------ | ------------ | ---------------------------------------------------------------------------- |
| `id`               | text   | Yes          | The run's ID.                                                                |
| `workflow_id`      | text   | Yes          | The workflow's ID.                                                           |
| `workflow_version` | number | Yes          | The workflow's `version` when the run was made.                              |
| `params`           | object | Yes          | The parameters the run was started with.                                     |
| `created_at`       | text   | Yes          | When the run was made.                                                       |
| `updated_at`       | text   | Yes          | When the record was last written.                                            |
| `version`          | number | Yes          | How many times the record has been written. A new run has 0.                 |
| `idempotency_key`  | text   | No           | The key the run was started with.                                            |
| `rerun_of`         | text   | No           | The ID of the ended run this run replaced under the same key.                |
| `parent_run_id`    | text   | No           | The ID of the run that started this one with `start_run_batch`.              |
| `agent_pid`        | number | No           | The process ID of the `realm agent` that `realm listen` started for the run. |
| `agent_started_at` | text   | No           | When that process was started.                                               |

Every time is text in the form `2026-10-02T00:45:53.865Z`.

### Where each step stands

| Field                   | Type         | Always there | Holds                                                                                                                |
| ----------------------- | ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `completed_steps`       | list of text | Yes          | The steps that completed.                                                                                            |
| `in_progress_steps`     | list of text | Yes          | The steps that have started and not ended.                                                                           |
| `failed_steps`          | list of text | Yes          | The steps that failed.                                                                                               |
| `skipped_steps`         | list of text | Yes          | The steps that will not run.                                                                                         |
| `skip_details`          | object       | No           | For each skipped step, [why](#skip_details).                                                                         |
| `claims`                | object       | No           | For each step in progress, its [claim](#claims).                                                                     |
| `settled`               | object       | No           | For each step that has ended, [how it was settled](#settled).                                                        |
| `capability_blocks`     | object       | No           | For each step that could not run because its handler or adapter was missing, [what was missing](#capability_blocks). |
| `validation_rejections` | object       | No           | For each agent step, how many of its answers were refused.                                                           |
| `defaulted_steps`       | list of text | No           | The steps that were given their default output. Written when the run completes.                                      |
| `pending_gate`          | object       | No           | The [gate](#pending_gate) the run is waiting at.                                                                     |

A step that has not started is in none of the four lists.

### How the run ended

| Field              | Type    | Always there | Holds                                                                                                     |
| ------------------ | ------- | ------------ | --------------------------------------------------------------------------------------------------------- |
| `run_phase`        | text    | Yes          | `running`, `gate_waiting`, `completed`, `failed`, `aborted` or `abandoned`.                               |
| `terminal_state`   | boolean | Yes          | `true` once the run has ended.                                                                            |
| `terminal_reason`  | text    | No           | One sentence on why the run ended, for a person to read.                                                  |
| `sealed_by`        | object  | No           | [What ended the run](#sealed_by).                                                                         |
| `aborted_at`       | object  | No           | For a run a guard or a handler stopped: `step_id`, and where they apply `conditions` and `abort_message`. |
| `abandoned_at`     | text    | No           | When the run was abandoned.                                                                               |
| `finalizer_ledger` | object  | No           | For each cleanup step chosen when the run ended, [its state](#finalizer_ledger).                          |

`run_phase` is stored for display. Realm works the phase out from the rest of the record each time it needs it, and a program that reads the file should do the same with `deriveRunPhase` from `@sensigo/realm`.

### What happened

| Field                        | Type   | Always there | Holds                                                                                                                         |
| ---------------------------- | ------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `evidence`                   | list   | Yes          | One [entry](#evidence-entries) for each attempt of each step, and for each gate answer, in order.                             |
| `drive_failures`             | object | No           | The [failed model requests](#drive_failures) of `realm agent` for this run.                                                   |
| `extension_identity`         | list   | No           | Which project code ran the run. See [Project extensions](project-extensions.md#what-a-run-records).                           |
| `workflow_context_snapshots` | object | No           | For each `workflow_context` file: `source_path`, `content`, `content_hash`, `loaded_at`, and `error` if it could not be read. |

## Evidence entries

| Field                                 | Type   | Always there | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `step_id`                             | text   | Yes          | The step.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `kind`                                | text   | No           | `gate_response` on the entry for a gate's answer. Absent, or `execution`, on the others.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `status`                              | text   | Yes          | `success`, `error` or `skipped`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `started_at`, `completed_at`          | text   | Yes          | When the attempt started and ended.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `duration_ms`                         | number | Yes          | The time between them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `attempt`                             | number | No           | Which attempt this is, on a step with a `retry` block.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `input_summary`                       | object | Yes          | What the step was given.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `resolved_params`                     | object | No           | The values the step's `input_map` resolved to.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `output_summary`                      | object | Yes          | The step's output. `{}` for a failed attempt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `output_source`                       | text   | No           | On a bare `auto` step's entry only, where its output came from: `driven_step` (the output the caller that named the step gave), `dependency` (its one `depends_on` step's output), `run_params` (the run's params; it has no `depends_on`) or `none` (nothing to copy, so `{}`: the engine ran a step that depends on several steps, or whose one dependency has no successful entry). Absent on every other entry, and on a bare step's entry written before the field; core's `outputSourceOf(entry, definition)` gives the source or why there is none (`not_an_output_entry`, `definition_unavailable`, `not_a_bare_step`, `predates_output_source`). `realm run export` writes the record as stored, so a reader of an export derives the absence with that same read. Added after version 0.46.0. |
| `evidence_hash`                       | text   | Yes          | The SHA-256 hash of `output_summary` as JSON.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `error`                               | text   | No           | The failure's message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `warn`                                | text   | No           | A handler's warning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `diagnostics`                         | object | No           | See [below](#diagnostics).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `agent_profile`, `agent_profile_hash` | text   | No           | The agent profile the step used, and the hash of its text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tool_calls`                          | list   | No           | Each tool call the model made: `server_id`, `tool`, `args`, `result`, `duration_ms`, and `error` if it failed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `trace`                               | list   | No           | The step's trace entries: `seq`, `event`, and where given `timestamp` and `data`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `trace_digest`                        | text   | No           | A hash of `trace`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `trace_summary`                       | object | No           | How many trace entries were sent, stored and dropped, and whether the list was cut.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `effective_timeout_seconds`           | number | No           | The time limit applied to the attempt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `clipped_to_ms`                       | number | No           | The shorter limit applied because the step's `total_timeout_seconds` was nearly used up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `exhausted_by`                        | text   | No           | `attempts` or `total_timeout`, on the last attempt of a step that ran out of either.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `gate_message`                        | text   | No           | On a gate answer: the message the person was shown.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `responded_by`                        | text   | No           | On a gate answer: who answered, if the caller said. `timeout` if the gate's time ran out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `driven_by`                           | object | No           | The program whose code and credentials ran this entry: `by`, `by_source` (`stated`, `ambient` or `derived`) and `channel`. Written on the entries where a program's code ran: a step's result and a cleanup step. Not written on the entries Realm makes itself (an expiry, a guard, a reclaim) or on a gate answer. Absent if the host named none. Added in 0.46.0.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `claim_proof`                         | object | No           | On a gate answer: whether the caller passed back the `claim_token` of the reply that opened the question. `proof`, and a `cause` for `unverifiable` and `spent`. See [The claim token](mcp/tools.md#the-claim-token). Absent on an answer that the gate's time running out settled, and on an answer written before the field existed. Added in 0.46.0.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `resolution`                          | text   | No           | On a gate that ran out of time: `expired_default` or `expired_abort`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `debug_output`                        | any    | No           | Not seen in any entry examined.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

The type also allows the `status` value `abandoned`. Nothing in Realm writes it.

A step with a gate has two entries: one for the step's run, and one with `kind: gate_response` for the answer. The answer's `output_summary` is the step's output with `choice` added.

### `diagnostics`

| Field                   | Type    | Always there | Holds                                                                                                                                  |
| ----------------------- | ------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `input_token_estimate`  | number  | Yes          | The size of the step's input, as JSON, divided by 4.                                                                                   |
| `precondition_trace`    | list    | Yes          | Each of the step's `preconditions` with the value it found and whether it passed.                                                      |
| `validation_rejections` | number  | No           | How many of the step's answers had been refused when this entry was written.                                                           |
| `settled_by_default`    | boolean | No           | `true` if the step was given its default output.                                                                                       |
| `structured_output`     | object  | No           | Whether strict structured output was asked for and sent. See [Agent-step controls](workflow/agent-step-controls.md#structured_output). |
| `cache`                 | object  | No           | What the model's provider reported about the prompt cache: `state`, `basis` and `requests`. Added in 0.46.0.                           |

`cache.state` is `engaged`, `never_engaged`, `write_only`, `partially_observed` or `unobservable`. `cache.basis` is `provider_reported` or `unobservable`. Each of `cache.requests` has `request_index` and `request_start`, and the counts the provider reported: `prompt_tokens`, `uncached_input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_write_tokens`, `output_tokens`, `cache_creation`.

## Objects inside the record

### `pending_gate`

| Field                              | Always there | Holds                                            |
| ---------------------------------- | ------------ | ------------------------------------------------ |
| `gate_id`                          | Yes          | The gate's ID. An answer must name it.           |
| `step_name`                        | Yes          | The step the gate is on.                         |
| `preview`                          | Yes          | The step's output, for the person to see.        |
| `choices`                          | Yes          | The choices offered.                             |
| `opened_at`                        | Yes          | When the gate opened.                            |
| `owner`                            | No           | The gate's `owner`.                              |
| `resolved_message`                 | No           | The gate's `message`, with its values filled in. |
| `resolution_messages`              | No           | The gate's message for each choice.              |
| `expires_at`                       | No           | When the gate's time runs out.                   |
| `on_expiry`                        | No           | `settle_default` or `abort`.                     |
| `default_choice`                   | No           | The choice taken when the time runs out.         |
| `reminder_seconds`, `reminder_max` | No           | The gate's reminder settings.                    |

These are copied from the workflow when the gate opens. A later change to the workflow does not change an open gate.

### `settled`

| Field         | Holds                                                                                  |
| ------------- | -------------------------------------------------------------------------------------- |
| `token`       | The token of the claim that settled the step, or `null`.                               |
| `outcome`     | `complete`, `fail`, `skip` or `gate`. `gate` means a person's answer settled the step. |
| `choice`      | With `gate`: the choice.                                                               |
| `resolved_by` | `timeout`, when the gate's time ran out and its default choice was taken.              |

### `claims`

| Field      | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deadline` | When the claim is taken to be dead, or `null` if Realm cannot tell. See [`realm run reclaim`](cli/realm-run-acting.md#reclaim).                                                                                                                                                                                                                                                                                                        |
| `token`    | A random ID made when the step was claimed. The step's result must carry it to settle the step. For a step with a gate, the answer may pass it back as `claim_token` to show that it came from the conversation that opened the question. The answer is recorded either way.                                                                                                                                                           |
| `holder`   | The program that took the step: `by`, `by_source` (`stated`, `ambient` or `derived`) and `channel`. Absent if the host named none, or the store dropped it. For a step waiting on a person's answer it says who asked the question, and nothing about anyone working on it now. A shared server puts its own name on every caller's claims, and two programs of one user on one machine are not told apart. No process ID is recorded. |
| `since`    | When the claim was made. Realm's own stores write it on every claim they make, from 0.46.0 on. A store someone else wrote has it only if that store writes it.                                                                                                                                                                                                                                                                         |

The program's name is the value of `REALM_OPERATOR` when it is set (without spaces at either end; an empty or blank value counts as unset), and otherwise the OS user and host name. It is written on the record, so it reaches `realm run inspect`, `get_run_state` and the reply to an answer (which a model reads), and export bundles. Put nothing in `REALM_OPERATOR` that must stay out of them. [Environment and files](environment-and-files.md) lists which commands write it.

### `capability_blocks`

`requirement` (`{ kind, name }`, where `kind` is `handler` or `adapter`), `code` (`ENGINE_HANDLER_NOT_REGISTERED` or `ENGINE_ADAPTER_NOT_REGISTERED`) and `at`.

### `skip_details`

| `kind`                       | Means                                                                | Also holds                                         |
| ---------------------------- | -------------------------------------------------------------------- | -------------------------------------------------- |
| `when_false`                 | The step's `when` was false.                                         | `expression`, and `leaves` with each part's value. |
| `trigger_rule_unsatisfiable` | The steps it depends on ended in a way its `trigger_rule` rules out. | `rule`, `blocking_deps`.                           |
| `handler_abort`              | The step's own handler stopped the run.                              |                                                    |
| `guard_abort`                | The step is a guard, and it stopped the run.                         |                                                    |
| `gate_cancelled_by_abort`    | The step's gate was open when the run was stopped.                   | `gate_id`.                                         |
| `gate_expired`               | The step's gate ran out of time, and the run was stopped.            | `gate_id`.                                         |

### `sealed_by`

| Field         | Holds                                                                                   |
| ------------- | --------------------------------------------------------------------------------------- |
| `arm`         | Which of 13 things ended the run. See the list below.                                   |
| `step`        | The step involved, where one was.                                                       |
| `classified`  | `true` if `realm run migrate --stamp-seals` worked the ending out from an older record. |
| `adjudicated` | An operator's ruling on the ending: `by`, `at`, `previous_arm`, and `reason` if given.  |

| `arm`                      | The run's phase | Ended by                                                |
| -------------------------- | --------------- | ------------------------------------------------------- |
| `complete`                 | `completed`     | Its last step completing.                               |
| `gate_resolution_complete` | `completed`     | A gate answer.                                          |
| `guard_pass_complete`      | `completed`     | A guard passing.                                        |
| `gate_expiry_default`      | `completed`     | A gate's default choice, taken when its time ran out.   |
| `step_failure`             | `failed`        | A step failing.                                         |
| `guard_resolution_error`   | `failed`        | A guard whose condition could not be worked out.        |
| `spawn_failure`            | `failed`        | `realm listen` failing to start the run's driver.       |
| `extensions_load_failure`  | `failed`        | The project's code failing to load before any step ran. |
| `handler_abort`            | `aborted`       | A handler returning `abort`.                            |
| `guard_abort`              | `aborted`       | A guard's condition being false.                        |
| `gate_expiry_abort`        | `aborted`       | A gate with `on_expiry: abort` running out of time.     |
| `abandon_requested`        | `abandoned`     | `realm run abandon` or `abandon_run`.                   |
| `cleanup_sweep`            | `abandoned`     | `realm run cleanup`.                                    |

A record written before version 0.39.0 has no `sealed_by`.

### `finalizer_ledger`

| Field                           | Holds                                                                   |
| ------------------------------- | ----------------------------------------------------------------------- |
| `status`                        | `pending`, `completed`, `failed` or `voided`.                           |
| `rank`                          | The order in which pending cleanup steps are run.                       |
| `lease_token`, `lease_deadline` | While a process is running the step: its token, and when its hold ends. |

### `drive_failures`

`first_failed_at`, `total`, and `entries`, the last 5 failures. Each entry has:

| Field                                             | Always there | Holds                                                                                                                        |
| ------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `at`, `step`, `provider`                          | Yes          | When, on which step, and which provider.                                                                                     |
| `error_class`                                     | Yes          | The kind of failure, such as `connection_timeout`, `connection_error`, `api_status`, `sdk_missing` or `validation_rejected`. |
| `message`                                         | Yes          | The failure's message.                                                                                                       |
| `elapsed_ms`                                      | Yes          | How long the request took.                                                                                                   |
| `attempts_sdk`                                    | No           | How many times the provider's client tried.                                                                                  |
| `declared_per_attempt_ms`, `derived_ceiling_ms`   | No           | The time limits that applied.                                                                                                |
| `last_observed_status`, `retry_after_observed_ms` | No           | The last HTTP status and wait the provider gave.                                                                             |
| `usage`                                           | No           | The tokens billed before the failure. Added in 0.46.0.                                                                       |

## The export bundle

`realm run export` writes a file with 9 fields:

| Field                  | Type             | Holds                                                                                                               |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `realm_export_version` | number           | `4`.                                                                                                                |
| `exported_at`          | text             | When the file was made.                                                                                             |
| `run`                  | object           | The whole run record.                                                                                               |
| `attempts`             | list             | The answers that were refused, oldest first.                                                                        |
| `attempts_capped`      | boolean          | `true` if the run had more refused answers than Realm keeps. The list then lacks the later ones.                    |
| `wal`                  | object           | By step, the trace entries kept in the trace buffer: batches of `{ ts, entries }`.                                  |
| `sealed`               | object or `null` | By step, the sets of trace entries set aside when a step was taken over. `null` if the store cannot keep such sets. |
| `complete`             | boolean          | `false` if any of `attempts`, `wal` and `sealed` could not be read.                                                 |
| `artifact_errors`      | list             | For each part that could not be read: `artifact`, `code`, `message`. `[]` when `complete` is `true`.                |

Each of `attempts` has `run_id`, `workflow_id`, `step_id`, `ts`, `error_code`, `validation_error_summary`, `submitted_key_count`, `submitted_keys`, `submitted_bytes` and `trace_entry_count`. It holds the names of the keys that were sent, not their values.

### An export that is not complete

With the file of refused answers made unreadable:

```text
⚠ INCOMPLETE export: 1 artifact(s) could not be read
  ✗ failed-attempt sidecar (EISDIR): readFile failed for '/home/dana/.realm/runs/b9836b8a-17c8-445d-aca1-09c567d570cf.attempts.jsonl' (EISDIR): EISDIR: illegal operation on a directory, read
The bundle was still written to '/srv/shop/broken.json' — inspect it for what could be recovered.
```

```json
{
  "complete": false,
  "attempts": [],
  "attempts_capped": false,
  "artifact_errors": [
    {
      "artifact": "failed-attempt sidecar",
      "code": "EISDIR",
      "message": "readFile failed for '/home/dana/.realm/runs/b9836b8a-17c8-445d-aca1-09c567d570cf.attempts.jsonl' (EISDIR): EISDIR: illegal operation on a directory, read"
    }
  ]
}
```

An empty `attempts` or `wal` means "none" only when `complete` is `true`.

### An export of an open run

The bundle of a run that has not ended is a snapshot: its parts are read one after another, and the run may change between them. In `wal` and `sealed`, the writer's identifier on entries of a step still in progress is replaced with `[redacted-live-claim]`.

### Versions of the bundle

| `realm_export_version` | Added                                        |
| ---------------------- | -------------------------------------------- |
| 1                      | `run`, `attempts`, `attempts_capped`, `wal`. |
| 2                      | `complete`, `artifact_errors`.               |
| 3                      | `sealed`.                                    |
| 4                      | `sealed_by` inside `run`.                    |

## An example

This run read a file, had one answer refused, completed its agent step with two trace entries, and was approved at a gate. It was exported after it ended.

```json
{
  "realm_export_version": 4,
  "exported_at": "2026-10-02T00:45:56.088Z",
  "run": {
    "id": "b9836b8a-17c8-445d-aca1-09c567d570cf",
    "workflow_id": "refund",
    "workflow_version": 1,
    "completed_steps": ["fetch", "decide"],
    "in_progress_steps": [],
    "failed_steps": [],
    "skipped_steps": [],
    "run_phase": "completed",
    "version": 6,
    "params": {
      "order": "/srv/shop/order.txt"
    },
    "evidence": [
      {
        "step_id": "fetch",
        "started_at": "2026-10-02T00:45:53.885Z",
        "completed_at": "2026-10-02T00:45:53.886Z",
        "duration_ms": 1,
        "input_summary": {
          "order": "/srv/shop/order.txt"
        },
        "output_summary": {
          "content": "Order A-17: 2 mugs, 40 EUR, arrived broken.\n",
          "path": "/srv/shop/order.txt",
          "line_count": 2,
          "size_bytes": 44
        },
        "status": "success",
        "evidence_hash": "46aefcaa7bf8f2a91ecf41783bbbe4197716320f1d79b9a3c98c3e101284f03f",
        "diagnostics": { "input_token_estimate": 29, "precondition_trace": [] },
        "resolved_params": {
          "path": "/srv/shop/order.txt"
        },
        "effective_timeout_seconds": 3600
      },
      {
        "step_id": "decide",
        "started_at": "2026-10-02T00:45:55.007Z",
        "completed_at": "2026-10-02T00:45:55.007Z",
        "duration_ms": 0,
        "input_summary": { "refund": true, "reason": "Arrived broken." },
        "output_summary": { "refund": true, "reason": "Arrived broken." },
        "status": "success",
        "evidence_hash": "21e91e16ac3de3e16c0beebe3ad87c9e8406049ee20f4c829bdfb88309346d72",
        "diagnostics": {
          "input_token_estimate": 11,
          "precondition_trace": [],
          "validation_rejections": 1
        },
        "trace": [
          { "seq": 1, "event": "read_order", "data": { "finding": "arrived broken" } },
          { "seq": 2, "event": "decided", "data": { "refund": true } }
        ],
        "trace_digest": "e4116f1a897f3d7df7073fbe04bbb0d8deb452fd6b9dd9766d37353db72c5e01",
        "trace_summary": {
          "submitted_entries": 2,
          "stored_entries": 2,
          "discarded_entries": 0,
          "discarded_reserved_event_entries": 0,
          "discarded_overflow_entries": 0,
          "truncated": false,
          "buffered_lines_adopted": 1
        }
      },
      {
        "step_id": "decide",
        "started_at": "2026-10-02T00:45:55.007Z",
        "completed_at": "2026-10-02T00:45:55.019Z",
        "duration_ms": 12,
        "input_summary": { "choice": "approve" },
        "output_summary": { "refund": true, "reason": "Arrived broken.", "choice": "approve" },
        "status": "success",
        "evidence_hash": "4d532b4f5b77500da1895fea5899755aa3bd561a76eab62443d88069d55c362a",
        "kind": "gate_response",
        "responded_by": "dana"
      }
    ],
    "created_at": "2026-10-02T00:45:53.865Z",
    "updated_at": "2026-10-02T00:45:55.023Z",
    "terminal_state": true,
    "claims": {},
    "settled": {
      "fetch": { "token": "a12c02a7-891a-4d64-b4dd-1f3da62ffa79", "outcome": "complete" },
      "decide": {
        "token": "7379fa28-7291-4672-bd7a-3ae53c582bed",
        "outcome": "gate",
        "choice": "approve"
      }
    },
    "skip_details": {},
    "validation_rejections": { "decide": 1 },
    "terminal_reason": "Workflow completed.",
    "sealed_by": { "arm": "gate_resolution_complete", "step": "decide" }
  },
  "attempts": [
    {
      "run_id": "b9836b8a-17c8-445d-aca1-09c567d570cf",
      "workflow_id": "refund",
      "step_id": "decide",
      "ts": "2026-10-02T00:45:53.968Z",
      "error_code": "VALIDATION_INPUT_SCHEMA",
      "validation_error_summary": [
        {
          "instancePath": "",
          "schemaPath": "#/required",
          "keyword": "required",
          "message": "must have required property 'reason'",
          "missing_property": "reason"
        }
      ],
      "submitted_key_count": 1,
      "submitted_keys": ["refund"],
      "submitted_bytes": 16,
      "trace_entry_count": 0
    }
  ],
  "attempts_capped": false,
  "wal": {
    "decide": [
      {
        "ts": 1790901953912,
        "entries": [{ "event": "read_order", "data": { "finding": "arrived broken" } }]
      }
    ]
  },
  "sealed": {},
  "complete": true,
  "artifact_errors": []
}
```

In this bundle, `wal` still holds the trace entry sent with `append_trace`, though the same entry is recorded in the step's `trace`. The trace buffer of a step that ends at a gate is not emptied.

## See also

- [`realm run`: commands that read](cli/realm-run-reading.md) covers `inspect` and `export`.
- [Run state and health findings](mcp/run-state-and-health.md) covers what `get_run_state` returns.
- [Evidence](../concepts/evidence.md)
- [Core library](core-library.md) covers the stores that keep the record.
