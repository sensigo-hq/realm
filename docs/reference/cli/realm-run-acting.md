# `realm run`: commands that act

<!-- description: Reference for the realm run subcommands that change a run or the store: their arguments, flags, output and exit codes. -->

`realm run` has sixteen subcommands. This page covers the ten that change a run or the store. The six that only read are in [`realm run`: commands that read](realm-run-reading.md). Every output shown came from a run of the command.

| Subcommand                | What it does                                                  | Acts when                   |
| ------------------------- | ------------------------------------------------------------- | --------------------------- |
| [`respond`](#respond)     | Answers a gate.                                               | Always                      |
| [`resume`](#resume)       | Makes a failed step runnable again.                           | Always                      |
| [`abandon`](#abandon)     | Ends an open run.                                             | Always                      |
| [`cleanup`](#cleanup)     | Abandons every open run that has been idle for a given time.  | Unless `--dry-run` is given |
| [`reclaim`](#reclaim)     | Frees a step that was started and never finished.             | Only with `--force`         |
| [`drain`](#drain)         | Runs the cleanup steps a finished run still owes.             | Only with `--force`         |
| [`purge`](#purge)         | Deletes finished runs.                                        | Only with `--force`         |
| [`gc`](#gc)               | Deletes files that a crash left in the store.                 | Only with `--force`         |
| [`reconcile`](#reconcile) | Rebuilds the index of idempotency keys.                       | Unless `--dry-run` is given |
| [`migrate`](#migrate)     | Records the ending of runs that were written by old versions. | Only with `--force`         |

A duration is a whole number followed by `d`, `h` or `m`: `30d`, `6h`, `10m`. A run ID that is not in the store gets `Run not found: <id>` and exit code 1.

When the `@sensigo/realm` the workflow's code imports is not the version the command runs, the command prints [`REALM_RELEASE_LINE_MISMATCH`](../workflow/loader-diagnostics.md#warning-codes) to stderr once per copy and goes on. This was added after version 0.45.0.

## `respond`

```text
realm run respond <run-id> --gate <gate-id> --choice <choice> [--by <name>] [--project <dir>] [--extensions-module <path>]
```

Answers the gate a run is waiting at. `realm run inspect <run-id>` prints the gate's ID and its choices.

| Flag                         | Required | What it does                                                                                                                                        |
| ---------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--gate <gate-id>`           | Yes      | The ID of the open gate.                                                                                                                            |
| `--choice <choice>`          | Yes      | One of the gate's choices.                                                                                                                          |
| `--by <name>`                | No       | Who made the choice. Recorded with the answer as given, and not checked. At most 200 characters, no control characters. Added after version 0.45.0. |
| `--project <dir>`            | No       | The project whose `realm.yaml` applies if the workflow has no project of its own. Default: the current folder.                                      |
| `--extensions-module <path>` | No       | Loads this code file in place of the files named by the workflow's `extensions`.                                                                    |

```bash
realm run respond 3ebc1158-1d29-41b5-9ca5-df054a681b58 --gate 0d499c26-a6b4-406f-ae29-6d6ef5c75fcb --choice approve
```

```text
Responded: 3ebc1158-1d29-41b5-9ca5-df054a681b58 | choice 'approve' | new state 'running'
```

`new state` is the run's phase after the answer: `running` if steps remain, `completed` if the gate's step was the last.

When the answer leaves `auto` steps that only the engine can run, one more line names them and the command that runs them (`runs it` for one step, `runs them` for more). Added after version 0.46.0:

```text
Responded: b178179a-998d-457e-85e6-6d38439d0585 | choice 'approve' | new state 'running'
Owed to the engine: 'process', 'notify' — realm run advance b178179a-998d-457e-85e6-6d38439d0585 runs them from this shell.
```

When the answer leaves nothing that can run from here — no agent step ready, no owed step that can run, only `auto` steps that cannot run — each such step is named, then the way out. Added after version 0.46.0:

```text
Responded: 77772f0c-a80d-49d3-b665-4ac186186fd1 | choice 'approve' | new state 'running'
'compute' cannot run (input_schema): Invalid input for step 'compute': the input must have required property 'n'.
Run 77772f0c-a80d-49d3-b665-4ac186186fd1 stays open (phase 'running'): correct the workflow, register it again, then realm run advance 77772f0c-a80d-49d3-b665-4ac186186fd1; or end it: realm run abandon 77772f0c-a80d-49d3-b665-4ac186186fd1.
```

A step that needs a handler or adapter this program lacks ends with its own way out (`— load the missing extension, or run the step on a runner that has it.`), and when no step is refused before its claim the last line is `To end the run instead: realm run abandon <id>.`

`respond` records the answer. Without `--by` the answer names nobody, and `realm run inspect` shows `(not stated)`. A name is never taken from the operating system or from `REALM_OPERATOR`: those name a program, and `respond` uses `REALM_OPERATOR` only for the cleanup steps its answer runs. An empty, long or control-character name is refused before the run is read:

```text
--by: empty; nothing was recorded. Give a name of at most 200 characters with no control characters, or leave it out.
```

A `REALM_OPERATOR` that cannot be used refuses the answer too, even when the workflow has no cleanup steps, because `respond` checks it before it reads the run:

```text
REALM_OPERATOR: contains a control character; it is written as the program's name on any cleanup steps the answer lets run, and respond checks it before reading the run, so nothing was recorded. Unset it or give it a name of at most 200 characters with no control characters.
```

The middle word is `empty`, `longer than 200 characters` or `contains a control character`. `respond` never passes a `claim_token`; the answer's proof reads `no claim_token passed` on `inspect`.

A guard step that the answer makes ready is decided in the same write, and what it did is printed before the `Responded:` line. No other step runs: the steps that follow run when a driver next calls the run.

A guard that passed, with steps still to run:

```text
Guard step 'only_if_shipping' passed.
Responded: 989c0619-1bda-4b2e-b5e3-4d33d6519a67 | choice 'ship' | new state 'running'
```

A guard that ended the run. `Reason:` is the guard's `abort_message`, and is left out when the guard has none:

```text
Guard step 'only_if_shipping' aborted the run.
Reason: The order was held.
Responded: c267f37e-bddb-46aa-aea2-b14f62ba358e | choice 'hold' | new state 'aborted'
```

The first line is one of three sentences: `Guard step '<step>' aborted the run.`, `Guard step '<step>' failed with a resolution error. Run is terminated.`, or `Guard step '<step>' passed and completed the run.` When the run ended and it has cleanup steps, they run in this process, and one line per cleanup step follows: `finalizer '<name>': <status>`.

Giving the same answer again prints the `Responded:` line again and changes nothing.

An answer that arrives after the gate's time is up is not recorded, and for a gate that was settled with its default choice the last line is `Not recorded:` in place of `Responded:`. See [An answer after the time is up](../workflow/gates.md#an-answer-after-the-time-is-up).

**Exit code:** 0 if the call succeeded, otherwise 1. An answer that was recorded exits 0, also when the guard it made ready aborted the run. A late answer that names the choice the gate was settled with exits 0, although it was not recorded. A refused answer exits 1. This differs from `realm workflow run`, which exits 1 for a run that ended as aborted.

The refusals:

| Case                                                           | Message                                                                                                                                                                                            |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--gate` is not the open gate                                  | `Gate 'wrong' is not the open gate and matches no committed resolution.`                                                                                                                           |
| `--choice` is not one of the choices                           | `Choice 'maybe' is not valid. Expected one of: approve, reject`                                                                                                                                    |
| The gate was answered differently                              | `Gate '70d76b3b-…' was already resolved with choice 'approve' — your choice 'reject' was not recorded.`                                                                                            |
| The gate's time was up, and it was settled with another choice | `Gate '80e024ee-…' was settled by timeout with choice 'hold' — your choice 'ship' was not recorded.` Then what the guard did, if this answer carried out the expiry, and the `Not recorded:` line. |
| The run has ended                                              | `Run '00b33778-…' is terminal; cannot submit a gate response — 'realm run resume' clears a stale pending gate on a resumable run, or 'realm run purge' removes the record entirely.`               |

## `advance`

Added after version 0.46.0. Runs the guards and `auto` steps a run owes, from this shell — no model provider, no key. It loads the project's extensions exactly as `respond` does (`--project`, `--extensions-module`), names this program with `REALM_OPERATOR` or the OS user (a `REALM_OPERATOR` that cannot be used prints one line and exits 1 before any work), and prints what it is about to do before it runs anything:

```text
Advancing run <id> (workflow 'cli-owed-wf') from /home/me/project.
This program: tester (from REALM_OPERATOR) · project code: neither side records project code.
Last recorded driver: none recorded.
Owed to the engine: 'after'.
→ after
Stopped: an agent step is ready: 'finish' — drive it with realm agent --run-id <id>
Run <id>: phase 'running'
```

The preview's `project code` words compare the code this program loaded with what the run last recorded:

| Words                                                       | Means                                                                                                                                                                             |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `same as the run's last record`                             | The same files with the same hashes.                                                                                                                                              |
| `differs from the run's last record`                        | Comparable, and different: a code file, an entry module, the `realm.yaml` or the `--extensions-module` override changed.                                                          |
| `not comparable with the run's last record`                 | The run records project code and this program loaded none, the two fingerprints were taken under different rules, one was cut short at its size limit, or one side's load failed. |
| `not comparable — the run has recorded no project code yet` | This program loaded project code, and the run has recorded none: no program with project code has run a step of it yet, as on a run just created. It is not a mismatch.           |
| `neither side records project code`                         | Neither the run nor this program loaded project code.                                                                                                                             |

When another program holds an owed step, the preview says so before anything runs, once, with the program and the time: `In flight: '<step>' is in flight, taken by <program> since <time>.`

`Stopped:` lines say why it stopped, one line for each reason that holds, in this order: a step that failed (`'<step>' failed: <error>`), the run ended (`the run has ended (<phase>)`), a question opened (with the `realm run respond` command), each step that cannot run (`'<step>' cannot run (<check>): <why>`, or `cannot run here (capability)` for a handler or adapter this program lacks, ending with its way out: `— load the missing extension, or run the step on a runner that has it`), agent steps ready (`an agent step is ready: '<step>' — drive it with realm agent --run-id <id>` for one, `agent steps are ready: '<a>', '<b>' — drive them with …` for several), each step another program holds (`'<step>' is in flight in another program — wait for it, or see realm run inspect <id>`), and otherwise `nothing is ready to run now`. A run the command completes gets no `Stopped:` line: the phase line says it. A step another process took while this one was about to run it is said as a fact, and the command goes on with what is left. The command prints `→ <step>` as it starts a step, before it claims it, so the losing program prints both lines, in this order — the second says another program took the step first, so it did not run here:

```text
→ process
• Step 'process' was taken by racer-a (from REALM_OPERATOR, via advance) at 2026-10-05T00:02:25.302Z; not run here.
```

When the engine can run nothing, the last preview line says why and nothing runs. It opens `Nothing is owed to the engine: <reasons>.` when nothing is owed (the run ended, a question is open, only agent steps are ready), and `The engine can run nothing now: <reasons>.` when steps are still owed to the engine but none can run here now (a step that cannot run, or a step in flight in another program). When the run stops on a step refused before its claim (an invalid `trust`, a failed precondition, an input its schema refuses) and nothing else is ready, the last line gives the one way out — correcting the workflow and registering it again is the fix, since the run picks up the corrected definition:

```text
The engine can run nothing now: 'compute' cannot run (input_schema): Invalid input for step 'compute': the input must have required property 'n'.
Run 507090b5-3b5b-4a6c-a814-3faa03404f95 stays open (phase 'running'): correct the workflow, register it again, then realm run advance 507090b5-3b5b-4a6c-a814-3faa03404f95; or end it: realm run abandon 507090b5-3b5b-4a6c-a814-3faa03404f95.
```

After a call that ran other steps, the same way out takes the place of the `Run <id>: phase '<phase>'` line. A step another program holds:

```text
In flight: 'process' is in flight, taken by crown (from REALM_OPERATOR, via advance) since 2026-10-04T22:26:13.994Z.
The engine can run nothing now: 'process' is in flight in another program — wait for it, or see realm run inspect 65d2afc8-2cb3-4401-808c-1d83a40bf989.
```

Exit code 1 when a step failed or cannot run, else 0. The steps run in this shell's environment (its secrets, its `.env`); two programs with the same code and different secrets look the same to the preview (#592).

## `resume`

```text
realm run resume <run-id> --from <step> [--force]
```

Takes a failed step off the run's list of failed steps and opens the run again. The run must be in `failed` or `abandoned`, and `<step>` must be listed under `Failed` by `realm run inspect`. Steps that completed stay completed.

| Flag            | Required | What it does                                                                                                  |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `--from <step>` | Yes      | The failed step to make runnable again.                                                                       |
| `--force`       | No       | Resumes even though another step of the run is marked in progress and Realm cannot tell how long it has been. |

```bash
realm run resume 8d4053bf-ceb4-4bde-bbde-3595715fd7c5 --from fetch
```

```text
Resumed run '8d4053bf-ceb4-4bde-bbde-3595715fd7c5': step 'fetch' re-enabled and run reset to 'running'.
Drive it with: realm agent --run-id 8d4053bf-ceb4-4bde-bbde-3595715fd7c5 --provider <provider> --model <model>
Add the other flags the run was driven with, such as --extensions-module or --project (realm run inspect 8d4053bf-ceb4-4bde-bbde-3595715fd7c5 shows the extension module the run loaded).
```

Fill in `<provider>` and `<model>` before you run the second line. `<model>` is the model to drive the run with. Give the flags you drove the run with: the model flags (`--provider-module`, or `--provider`, `--model`, `--base-url` and `--strict-base-url`) as you used them, and `--extensions-module`, `--project`, `--schema-retries`, `--llm-timeout` or `--mint-writer-nonce` if you used them. Realm does not record the model or most of those flags: `realm run inspect` shows the provider of a drive failure, and the extension module the run loaded under `Extension Identity`. A run started by `realm workflow run` was never driven by a model: name any provider and model you want. Version 0.45.0 prints the second line without `--provider <provider> --model <model>`, and no third line.

When the step that is ready again is one only the engine runs, one more line names it (`the step` / `the steps`). Added after version 0.46.0:

```text
Resumed run '8bc06d55-77fb-43f4-937f-8d166fad20cf': step 'a' re-enabled and run reset to 'running'.
Drive it with: realm agent --run-id 8bc06d55-77fb-43f4-937f-8d166fad20cf --provider <provider> --model <model>
Add the other flags the run was driven with, such as --extensions-module or --project (realm run inspect 8bc06d55-77fb-43f4-937f-8d166fad20cf shows the extension module the run loaded).
To run the step the engine owes ('a') without a model: realm run advance 8bc06d55-77fb-43f4-937f-8d166fad20cf.
```

When the step that is ready again cannot run — the workflow was registered again with a check the step fails — and nothing else can run, driving the run would only stop on that step: the step and the way out take the place of the `Drive it with:` lines. Added after version 0.46.0, which prints the `Drive it with:` lines in this case too:

```text
Resumed run '729eaab3-6203-46cb-9c5c-3714070723a8': step 'a' re-enabled and run reset to 'running'.
'a' cannot run (input_schema): Invalid input for step 'a': the input must have required property 'n'.
Run 729eaab3-6203-46cb-9c5c-3714070723a8 stays open (phase 'running'): correct the workflow, register it again, then realm run advance 729eaab3-6203-46cb-9c5c-3714070723a8; or end it: realm run abandon 729eaab3-6203-46cb-9c5c-3714070723a8.
```

`resume` runs no step. Cleanup steps that had not yet run for the ended run are cancelled, and each is named on a line that starts with `⚠`.

**Exit code:** 0 if the run was resumed, otherwise 1:

| Case                                             | Message                                                                                                                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The step did not fail                            | `Step 'review' is not in failed_steps for run '00b33778-…'.`                                                                                                                            |
| The run is in another phase                      | `Run 4233aa3c-… is in phase 'completed', which is not resumable.`                                                                                                                       |
| The step is a cleanup step                       | `Step 'release' is a finalizer — finalizers cannot be resumed via --from. Use 'realm run drain cba9901c-…' or '--void release' instead.`                                                |
| The run was aborted                              | `Run <id> was aborted (step '<step>') — aborted runs are never resumable.`                                                                                                              |
| A step is in progress, and within its time limit | `Step '<step>' has a HEALTHY claim (deadline <time>) — a live runner is presumed on it. Resume refuses to disturb live work.`                                                           |
| A step is in progress, for an unknown time       | `Step '<step>' has an unknown-age claim (no reliable deadline) — its liveness cannot be verified. Re-run with --force to override (only after confirming the runner is actually dead).` |
| A cleanup step is being run now                  | `Run <id> has an active drain lease on finalizer '<name>' (expires <time>) — a drainer is executing NOW. …`                                                                             |

## `abandon`

```text
realm run abandon <run-id> [--reason <text>]
```

Ends an open run. Its phase becomes `abandoned`. The workflow's cleanup steps do not run.

| Flag              | What it does                                                             |
| ----------------- | ------------------------------------------------------------------------ |
| `--reason <text>` | Recorded as the run's cause. Default: `Abandoned via realm run abandon`. |

```bash
realm run abandon 00b33778-f504-4d65-93ca-6300441f41e7 --reason "upstream still down"
```

```text
Run '00b33778-f504-4d65-93ca-6300441f41e7' abandoned (phase: 'abandoned'). Reason: upstream still down.
To run the same work again: realm workflow run /srv/shop/sync --params '{"fail":true}' (the directory it was registered from) — a fresh run; this run's evidence stays at realm run inspect 00b33778-f504-4d65-93ca-6300441f41e7.
abandon is a kill — declared finalizers (if any) did NOT run and will not for this run. The graceful path is the workflow's own guard step (abort_unless), which runs them; there is no operator abort command.
```

The second line gives a command that starts a new run of the same workflow with the same parameters.

Abandoning a run that is already abandoned changes nothing, and the first line says so: `… Already abandoned (no change this call). …`

**Exit code:** 0 if the run is abandoned, otherwise 1:

| Case                         | Message                                                                                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The run is waiting at a gate | `Run '4233aa3c-…' is waiting on human gate 'review' (gate '70d76b3b-…'); answer it before abandoning. Answer it: realm run respond 4233aa3c-… --gate 70d76b3b-… --choice <one of: approve, reject>.` |
| The run ended in another way | `Run '08c61d5d-…' is already terminal (failed); cannot abandon a finished run.`                                                                                                                      |

## `cleanup`

```text
realm run cleanup --older-than <duration> [--dry-run]
```

Abandons every open run that has not changed for `<duration>`. It leaves runs that are waiting at a gate.

| Flag                      | Required | What it does                                             |
| ------------------------- | -------- | -------------------------------------------------------- |
| `--older-than <duration>` | Yes      | How long a run must have been idle.                      |
| `--dry-run`               | No       | Lists the runs that would be abandoned and changes none. |

```bash
realm run cleanup --older-than 7d --dry-run
```

```text
Would mark 4 run(s) as abandoned.
  • 0a8d87bf-b7fc-4983-96e2-3656718e231d
  • 3ebc1158-1d29-41b5-9ca5-df054a681b58
  • 6302fd4c-6a9f-4f17-b5ff-79574cb569b7
  • cba9901c-fa22-47dd-97e2-47439238d01f
abandon is a kill — declared finalizers (if any) did NOT run and will not for this run. The graceful path is the workflow's own guard step (abort_unless), which runs them; there is no operator abort command.
```

Without `--dry-run`, the first line reads `Marked 4 run(s) as abandoned.` A run it abandons shows `Sealed by: cleanup_sweep` and `Cause: Marked abandoned by realm cleanup` in `realm run inspect`.

**Exit code:** 0, also when no run matches. 1 for a duration that cannot be read.

## `reclaim`

```text
realm run reclaim <run-id>
realm run reclaim <run-id> --step <name> --force
realm run reclaim --all [--workflow <id>] [--older-than <duration>] [--force]
```

When a step starts, Realm marks it in progress and, where it can, records a time by which the step must have finished. If the process running the step dies, the mark stays and the run cannot move. `reclaim` reports such marks and, with `--force`, removes one so that the step can run again. The step's work may then happen twice.

| Flag                      | What it does                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `--step <name>`           | The step to free. Needs `--force`.                                                                                        |
| `--force`                 | Frees the step, or with `--all` every selected step.                                                                      |
| `--all`                   | Selects, across all runs, every step that is past its time, is declared `idempotent: true`, and is not waiting at a gate. |
| `--workflow <id>`         | With `--all`: only runs of this workflow.                                                                                 |
| `--older-than <duration>` | With `--all`: only steps that are past their time by at least this long.                                                  |

With a run ID alone, it lists the steps in progress and the state of each:

```bash
realm run reclaim 70f9528e-4f45-4806-8690-c4e92a31760d
```

```text
Run '70f9528e-4f45-4806-8690-c4e92a31760d' (running) — in-progress claims:
  • fetch: claim_stale  (deadline: 2026-10-01T23:15:36.957Z)
      reclaim: realm run reclaim 70f9528e-4f45-4806-8690-c4e92a31760d --step fetch --force

Reclaim re-drives a step (at-least-once — side effects may repeat). Use --step <name> --force to act on a specific claim, or --all for batch auto-reclaim.
```

| State               | Meaning                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `healthy`           | The step's time has not passed. Something is presumed to be running it.                                    |
| `claim_stale`       | The step's time has passed.                                                                                |
| `claim_unknown_age` | No time was recorded. This is so for agent steps, and for every step of a workflow that has cleanup steps. |

The time is the step's `timeout_seconds` across all its attempts plus one minute, and never less than 15 minutes after the step started.

A step that is waiting at a gate is listed with `open gate — resolve via 'realm run respond <run-id>', not reclaim.`

With `--step` and `--force`:

```text
⚠ Reclaiming 'fetch' on run '70f9528e-4f45-4806-8690-c4e92a31760d' — this re-drives the step; its side effects may repeat.
Reclaimed 'fetch' (was claim_stale). It is eligible again — the next driver will re-drive it.
```

`reclaim` runs no step. The freed step runs when a driver next calls the run. The run's record keeps an entry for the step that says it was reclaimed, with the state and the time it had.

Freeing a step that is still `healthy` is allowed, with a second warning first: `⚠ 'fetch' currently has a HEALTHY claim (a live runner is presumed on it). --force will override it and may double-drive live work.`

With `--all`:

```text
2 claim(s) WOULD be auto-reclaimed (idempotent ∧ past-deadline ∧ non-gated):
  • 70f9528e-4f45-4806-8690-c4e92a31760d / fetch  (deadline 2026-10-01T23:15:36.957Z, 0m past)
  • 7252133d-1033-4300-8ddb-ff949f646a79 / fetch  (deadline 2026-10-01T23:15:34.551Z, 0m past)

Re-run with --force to reclaim them. WARNING: each re-executes its handler at-least-once with NO per-step human judgment — enable only for genuinely idempotent handlers.
```

With `--all --force`:

```text
⚠ Auto-reclaiming 1 claim(s); each re-executes its handler — side effects may repeat.
  ✓ 7252133d-1033-4300-8ddb-ff949f646a79: Reclaimed 'fetch' (was claim_stale). It is eligible again — the next driver will re-drive it.
Reclaimed 1/1 selected claim(s).
```

When nothing is selected, it prints `No auto-reclaimable claims found (idempotent ∧ concrete-past-deadline ∧ non-gated).` A run with no step in progress gets `Run '<id>' (running) has no in-progress claims. Nothing to reclaim.`, and a run that has ended gets `Run '<id>' is terminal (completed); it has no reclaimable claim.`

**Exit code:** 0, also when there is nothing to free. 1 for a combination that cannot be used:

```text
Provide a <run-id> to inspect/reclaim, or use --all for batch mode.
Refusing to reclaim 'fetch' without --force. Re-run with --force to re-drive it (the step re-executes; its side effects may repeat).
--force requires --step <name> (or use --all for batch). Run without arguments to see a dry-run.
--workflow and --older-than are only valid with --all.
Cannot combine a <run-id> with --all. Use one or the other.
--step is a per-run flag; it cannot be combined with --all.
```

## `drain`

```text
realm run drain <run-id> [--force] [--expired] [--project <dir>] [--extensions-module <path>]
realm run drain <run-id> --void <finalizer>
realm run drain --all [--force] [--expired]
```

A workflow's cleanup steps, the steps with `execution: finalizer`, run after the run has ended. If the process stops before they finish, the run stays ended and still owes them. `drain` reports the cleanup steps a run owes and, with `--force`, runs them.

| Flag                         | What it does                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--force`                    | Runs the cleanup steps.                                                                                        |
| `--all`                      | Every run that owes a cleanup step that can be run now.                                                        |
| `--void <finalizer>`         | Cancels one owed cleanup step without running it. Acts at once, without `--force`.                             |
| `--expired`                  | Also carries out gates whose time has passed. See [Gates](../workflow/gates.md#what-happens-at-expiry).        |
| `--project <dir>`            | The project whose `realm.yaml` applies if the workflow has no project of its own. Default: the current folder. |
| `--extensions-module <path>` | Loads this code file in place of the files named by the workflow's `extensions`.                               |

Without `--force`, it reports:

```text
Run '64e1c3a6-5882-4955-a796-a03355fe97f4' (completed) — pending finalizers, rank order:
  • [0] release: actionable — would lease and run on --force, if its handler resolves on this surface

Re-run with --force to actually drain. Use --void <finalizer> to void one instead.
```

A cleanup step that another process took less than its lease time ago is reported as held. The lease here was 30 seconds:

```text
  • [0] release: lease held (expires 2026-10-01T23:01:37.538Z) — a drainer is executing NOW
```

With `--force`:

```text
Drained run '64e1c3a6-5882-4955-a796-a03355fe97f4'.
```

With `--void`:

```text
finalizer 'release' voided by operator — may have executed without a recorded mark (its lease had already expired)
```

With `--all`, and then with `--all --force`:

```text
3 run(s) WOULD be drained:
  • 1bdb1307-af8b-4016-8189-f054621411b9
  • 41a348b2-e48e-48ee-8622-21df7135688e
  • 64e1c3a6-5882-4955-a796-a03355fe97f4

Re-run with --force to actually drain them.
```

```text
  ✓ 1bdb1307-af8b-4016-8189-f054621411b9: drained
Drained 1/1 run(s).
```

With `--expired`, a gate whose time has passed is reported first, with the choice it would be settled with. If the settled choice would make a guard step ready, the report says what the guard would then do: `would pass`, `would pass and complete the run`, `would then abort the run (<reason>)` or `would then fail the run (<reason>)`. Nothing is written:

```text
Run '0e0ace7e-e57c-400c-a63a-eaf685688d19': gate expired 0m ago — would enact settle_default 'hold'; guard 'only_if_shipping' would then abort the run (The order was held.) on --force.
Run '230b0939-9c61-40e4-8b6f-910594a81e92': gate expired 0m ago — would enact settle_default 'ship'; guard 'only_if_shipping' would pass on --force.
```

The report leaves the guard out when the run's registered workflow cannot be read.

With `--expired --force`, the gate is carried out. The same write decides the guard, and its lines follow. Then the run's cleanup steps are drained as usual:

```text
✓ gate enacted (settle_default 'hold').
Guard step 'only_if_shipping' aborted the run.
Reason: The order was held.
Run '0e0ace7e-e57c-400c-a63a-eaf685688d19' has no pending finalizers. Nothing to drain.
```

```text
✓ gate enacted (settle_default 'ship').
Guard step 'only_if_shipping' passed.
Run '230b0939-9c61-40e4-8b6f-910594a81e92' is not terminal (phase: 'running') — nothing further to drain.
```

When the enacted gate leaves `auto` steps only the engine runs, one more line names them. Added after version 0.46.0:

```text
✓ gate enacted (settle_default 'approve').
Run 'daeede5e-c0dd-4b88-9caf-6efa089902dd' is not terminal (phase: 'running') — nothing further to drain.
To run the step the engine owes ('after'): realm run advance daeede5e-c0dd-4b88-9caf-6efa089902dd.
```

When it leaves nothing that can run from here, the steps that cannot run and the way out follow instead. Added after version 0.46.0:

```text
✓ gate enacted (settle_default 'approve').
Run '1d703406-777f-4bc6-a6bc-6058b4d8f490' is not terminal (phase: 'running') — nothing further to drain.
'compute' cannot run (input_schema): Invalid input for step 'compute': the input must have required property 'n'.
Run 1d703406-777f-4bc6-a6bc-6058b4d8f490 stays open (phase 'running'): correct the workflow, register it again, then realm run advance 1d703406-777f-4bc6-a6bc-6058b4d8f490; or end it: realm run abandon 1d703406-777f-4bc6-a6bc-6058b4d8f490.
```

With `--all --expired`, the list names what each gate declared, without the choice or the guard. With `--force`, what each guard did is printed under its run:

```text
2 run(s) WOULD be drained:
  • 962cb7f0-a894-4592-aadc-a4907ef14c9c: gate expired 0m ago — would enact settle_default
  • ce8296d1-c5d3-4ea6-b62c-7dc0f795fb09: gate expired 0m ago — would enact settle_default

Re-run with --force to actually drain them.
```

```text
  ✓ 962cb7f0-a894-4592-aadc-a4907ef14c9c: gate enacted
    Guard step 'only_if_shipping' passed.
  ✓ ce8296d1-c5d3-4ea6-b62c-7dc0f795fb09: gate enacted
    Guard step 'only_if_shipping' aborted the run.
    Reason: The order was held.
Drained 2/2 run(s).
```

When there is nothing to do, it prints one of:

```text
Run '03431f4f-7b71-4ad0-98b1-f1d51cc5c4c8' has no pending finalizers. Nothing to drain.
Run 'cba9901c-fa22-47dd-97e2-47439238d01f' is not terminal (phase: 'running') — nothing to drain. To end the run: realm run abandon cba9901c-fa22-47dd-97e2-47439238d01f.
Run 'daeede5e-c0dd-4b88-9caf-6efa089902dd' is not terminal (phase: 'running') — nothing to drain. To run the step the engine owes ('after'): realm run advance daeede5e-c0dd-4b88-9caf-6efa089902dd. To end the run instead: realm run abandon daeede5e-c0dd-4b88-9caf-6efa089902dd.
Run '573ff99d-44fc-42c9-98e8-c394fed45e6e' is not terminal (phase: 'running') — nothing to drain. 'compute' cannot run (input_schema): Invalid input for step 'compute': the input must have required property 'n'. Run 573ff99d-44fc-42c9-98e8-c394fed45e6e stays open (phase 'running'): correct the workflow, register it again, then realm run advance 573ff99d-44fc-42c9-98e8-c394fed45e6e; or end it: realm run abandon 573ff99d-44fc-42c9-98e8-c394fed45e6e.
Run '22efc6a7-01f8-4256-9d2f-74621b621d28' is not terminal (phase: 'gate_waiting') — nothing to drain. To end the run, answer its gate first: realm run respond 22efc6a7-01f8-4256-9d2f-74621b621d28 --gate 817f3921-6ddd-4bda-9506-762892ae37e7 --choice <one of: approve, reject>. The answer can end the run by itself. If the run is still open after it: realm run abandon 22efc6a7-01f8-4256-9d2f-74621b621d28.
Run '94bf33c8-3933-47c4-ad50-556d0b298e6c' is not terminal (phase: 'gate_waiting') — nothing to drain. Its gate expired 0m ago. To see what the expiry will do: realm run drain 94bf33c8-3933-47c4-ad50-556d0b298e6c --expired; add --force to carry it out.
No runs with an actionable pending finalizer.
```

The third and fourth lines, and the step and the way out on a run in `running`, were added after version 0.46.0, which prints the second line's `To end the run: realm run abandon <id>.` for every run in `running`.

**Exit code:** 0 if every cleanup step it tried ran, and when there is nothing to do. 1 if a cleanup step is left owed after `--force`, if `--force` prints one of the four `is not terminal … nothing to drain` lines above, or for one of:

```text
Provide a <run-id>, or use --all for batch mode.
Finalizer 'release' is 'voided', not 'pending' — nothing to void.
No finalizer ledger entry named 'nope' on run '41a348b2-e48e-48ee-8622-21df7135688e'.
Finalizer 'release' has an active drain lease (expires 2026-10-01T23:02:59.535Z) — a drainer is executing NOW. Wait for the lease to expire (bounded — leases are clamped to 300s) and retry. Not force-bypassable.
```

## `purge`

```text
realm run purge <run-id> [--force]
realm run purge --older-than <duration> [--workflow <id>] [--force]
```

Deletes finished runs, with their refused answers and trace entries. A deleted run cannot be brought back. Runs that have not ended are never deleted.

| Flag                      | What it does                                                   |
| ------------------------- | -------------------------------------------------------------- |
| `--force`                 | Deletes. Without it, `purge` lists what it would delete.       |
| `--older-than <duration>` | Selects every finished run that has not changed for this long. |
| `--workflow <id>`         | With `--older-than`: only runs of this workflow.               |

```bash
realm run purge --older-than 30d
```

```text
3 run(s) WOULD be purged (7.2 KB to free):
  • 08c61d5d-8db8-4556-87e4-0ba4cc76dc6c  (failed, 2.4 KB)
  • 5ef64237-9f2d-4624-84c8-9686feb38998  (completed, 2.4 KB)
  • d0375dc9-35f5-462b-b12c-f145b404f276  (abandoned, 2.5 KB)

1 of 3 selected run(s) are resumable via 'realm run resume' — purging would destroy that path permanently.
Re-run with --force to actually delete.
```

With `--force`:

```text
Purged 2/3 run(s) (4.9 KB freed, store-reported). 0 already gone, 1 blocked, 0 failed.
  ⚠ 5ef64237-9f2d-4624-84c8-9686feb38998: drain_pending
1 of 3 selected run(s) were resumable via 'realm run resume' — purging has destroyed that path for them.
```

| Count          | Means                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| `Purged`       | Runs deleted, of the runs selected.                                                                           |
| `already gone` | Runs that something else deleted first.                                                                       |
| `blocked`      | Runs that were left in place. `drain_pending` means the run still owes a cleanup step; see [`drain`](#drain). |
| `failed`       | Runs that could not be deleted because of an error.                                                           |

The line about `realm run resume` counts the selected runs that had a failed step, which `resume` could have made runnable again.

Given a run ID in place of `--older-than`, `purge` works on that one run:

```text
1 run(s) WOULD be purged (2.7 KB to free):
  • 03431f4f-7b71-4ad0-98b1-f1d51cc5c4c8  (completed, 2.7 KB)

None of the 1 selected run(s) are resumable via 'realm run resume'.
Re-run with --force to actually delete.
```

When no run is old enough, it prints `No eligible runs found to purge.`

**Exit code:** 0, also when a run was blocked or nothing matched. 1 if a run could not be deleted because of an error, or for one of:

```text
Provide a <run-id> to purge, or use --older-than for batch mode.
Cannot combine a <run-id> with --older-than. Use one or the other.
Refusing to purge 'f78b61ba-3464-4802-8bc0-03fcaaeebb8d': not terminal (phase: 'gate_waiting').
```

## `gc`

```text
realm run gc --older-than <duration> [--heal] [--force]
realm run gc --heal [--force]
```

Removes two kinds of file that a crash can leave in `~/.realm/runs/`: temporary files from a write that was cut off, and trace entries whose run no longer exists. With `--heal`, it also corrects run records whose stored phase differs from the phase their contents give.

| Flag                      | What it does                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--older-than <duration>` | Only files at least this old. The least it accepts is `1h`. Required unless `--heal` is the only thing asked for. |
| `--force`                 | Deletes and rewrites. Without it, `gc` lists what it would do.                                                    |
| `--heal`                  | Also corrects stored phases. No age limit applies to this part.                                                   |

```bash
realm run gc --older-than 1d
```

```text
1 orphaned .tmp file(s) WOULD be reaped (2.4 KB to free):
  • ~/.realm/runs/08c61d5d-8db8-4556-87e4-0ba4cc76dc6c.json.4242.9f3c2a1b.tmp

Re-run with --force to actually delete.

1 run-less orphaned artifact(s) WOULD be reaped:
  • ~/.realm/runs/trace-buffer-fbe2f08b-b5e2-435b-ac41-77b0be623b33-d29yaw.jsonl  (run fbe2f08b-b5e2-435b-ac41-77b0be623b33)
Re-run with --force to actually delete.

gc does NOT yet reap orphaned .lock dirs (deferred — issue #164). Their presence in runsDir is expected and not a sign gc is broken.
```

On version 0.45.0 the part after the process id is a counter instead of 8 random characters: `….json.4242.1.tmp`. gc removes both forms.

With `--force`:

```text
Reaped 1 orphaned .tmp file(s) (2.4 KB freed). 0 already gone, 0 failed.

Reaped 1 run-less orphaned artifact(s). 0 already gone, 0 failed.
  • ~/.realm/runs/trace-buffer-fbe2f08b-b5e2-435b-ac41-77b0be623b33-d29yaw.jsonl  (run fbe2f08b-b5e2-435b-ac41-77b0be623b33)
```

Both forms end with the same note about lock folders. On a store with nothing to remove:

```text
No orphaned .tmp files found to reap.

No run-less orphaned WAL/sidecar artifacts found to reap.

gc does NOT yet reap orphaned .lock dirs (deferred — issue #164). Their presence in runsDir is expected and not a sign gc is broken.
```

With `--heal`, on a store with nothing to correct:

```text
No stale-phase records found to heal.
```

Correcting a record sets its time of last change to now. `realm run purge --older-than` and `realm run cleanup --older-than` read that time.

**Exit code:** 0. 1 if a file could not be read or deleted, or for:

```text
--older-than must be at least 1h (got '30m'). gc refuses to reap crash residue younger than that, even with --force.
```

## `reconcile`

```text
realm run reconcile [--workflow <id>] [--dry-run]
```

Realm keeps one small file for each idempotency key, in `~/.realm/runs/keys/`, that names the run holding the key. `reconcile` writes any of these files that is missing or out of date, from the runs themselves.

| Flag              | What it does                                      |
| ----------------- | ------------------------------------------------- |
| `--workflow <id>` | Only runs of this workflow.                       |
| `--dry-run`       | Reports what would be written and writes nothing. |

```bash
realm run reconcile --dry-run
```

```text
Would write 1 pointer(s) across 1 key group(s); 0 already current.
```

Without `--dry-run`, the line starts with `Wrote`. Run again, it prints `Wrote 0 pointer(s) across 1 key group(s); 1 already current.` A key group is one key of one workflow. See [Idempotency and batches](../../guides/idempotency-and-batches.md) for a store where two runs hold one key.

**Exit code:** 0.

## `migrate`

```text
realm run migrate --stamp-seals [--force] [--detailed-exitcode]
```

Since version 0.39, a run that ends records what ended it, which `realm run inspect` prints as `Sealed by`. `migrate --stamp-seals` works out that value for finished runs written by older versions and stores it. It does not change a run's time of last change.

| Flag                  | Required | What it does                                                                                                                |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `--stamp-seals`       | Yes      | The only kind of migration.                                                                                                 |
| `--force`             | No       | Writes. Without it, `migrate` lists what it would write.                                                                    |
| `--detailed-exitcode` | No       | Exits with 2 if a finished run is left whose ending cannot be worked out, or whose record disagrees with its stored ending. |

On two runs written by version 0.38:

```bash
realm run migrate --stamp-seals
```

```text
2 run(s) WOULD be stamped:
  • 9a45ca3c-2df1-4daf-ac77-832344422fed: complete (phase completed)
  • c9334380-2d09-463e-96c1-2a98f98a66c9: abandon_requested (phase abandoned)
Re-run with --force to actually stamp.
Residue: 2 terminal run(s) still without a recorded seal arm.
Run `realm run migrate --stamp-seals` BEFORE `realm run gc --heal` after upgrading across #367 if retention clocks matter: heal rewrites the same records and resets updated_at, which this command deliberately preserves.
```

With `--force`, the first lines become:

```text
Stamped 2 run(s) with their seal arm.
  • 9a45ca3c-2df1-4daf-ac77-832344422fed: complete (phase completed)
  • c9334380-2d09-463e-96c1-2a98f98a66c9: abandon_requested (phase abandoned)
Residue: 0 terminal run(s) still without a recorded seal arm.
```

A run stamped in this way shows `Sealed by: complete (recovered by classifier)` in `realm run inspect`.

When every finished run has the value already:

```text
Nothing would be stamped — every terminal run already carries its seal arm.
3 run(s) already stamped, and their arms agree with the record.
Residue: 0 terminal run(s) still without a recorded seal arm.
```

**Exit code:** 0. 1 if a write failed, or if `--stamp-seals` was not given. 2 only with `--detailed-exitcode`, as described above.

## See also

- [Operate runs](../../guides/operate-runs.md)
- [`realm run`: commands that read](realm-run-reading.md)
- [Handle failure](../../guides/handle-failure.md)
- [Upgrade Realm](../../guides/upgrade.md)
