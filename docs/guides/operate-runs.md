# Operate runs

This guide is for the person who looks after runs once workflows are in use. It shows how to find the runs that need attention, how to get each kind moving again or end it, and how to keep the store tidy. Every output shown is from a real run of the command.

## Find the runs that need attention

List the runs, newest first:

```bash
realm run list
```

It prints one line for each run: its ID, workflow, phase, last change and number of steps.

```text
566ba1b6-8e67-4255-9fd9-ed9b270b452d  sync v1  abandoned  10/2/2026, 12:33:38 AM  1 step(s)
7be2233c-2f2d-4f22-98cd-f561496c129b  sync v1  failed  10/2/2026, 12:32:56 AM  3 step(s)
```

Narrow the list with `--status <phase>` or `--workflow <id>`.

To see only the runs that are open and have not moved for a while, use `--stuck`:

```bash
realm run list --stuck
```

It prints:

```text
No stuck runs found (threshold 24h).
```

By default a run counts as stuck after 24 hours without a change. Set another limit with `--older-than`, for example `--older-than 30m`. A run that is listed says why:

```text
Stuck runs (threshold 0m):
f4dee18d-e5a4-4989-885d-bea2a7b60483  sync v1  running  10/2/2026, 12:35:37 AM  1 step(s)  idle: 0m
```

## Look at one run

```bash
realm run inspect <run-id>
```

The first lines say where the run stands and, for a finished run, what ended it:

```text
Phase: failed
Sealed by: step_failure
Cause: Step 'fetch' failed: Step 'fetch' failed after 3 attempts
Completed: page_on_call, release_lock
Failed: fetch
Skipped: summarise
```

Further down, `Run Health` lists anything Realm finds wrong with the run, and `Drive failures` lists the times a driver gave up on it. See [Evidence](../concepts/evidence.md) for how to read the rest.

## Decide what to do

| The run is                            | Do this                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `gate_waiting`                        | Answer the gate. See [Waiting at a gate](#waiting-at-a-gate).                 |
| `running`, and its driver has stopped | Start a driver on it again. See [Open, with no driver](#open-with-no-driver). |
| `failed`, and the cause is now fixed  | Resume it. See [Failed](#failed).                                             |
| open, and should not continue         | Abandon it. See [No longer wanted](#no-longer-wanted).                        |
| finished, and old                     | Purge it. See [Keep the store tidy](#keep-the-store-tidy).                    |

## Waiting at a gate

`realm run inspect` shows the gate's ID and choices. Answer with:

```bash
realm run respond <run-id> --gate <gate-id> --choice <choice>
```

See [Add a human gate](human-gates.md#6-answer-it).

## Open, with no driver

A run in `running` moves only when a driver calls it. If the driver has stopped, start one on the same run:

```bash
realm agent --run-id <run-id>
```

An assistant connected over MCP can pick the run up as well, by asking for its state and following the reply.

## Failed

When the cause of a failure has been fixed, re-enable the failed step:

```bash
realm run resume <run-id> --from <step>
```

It prints:

```text
Resumed run '7be2233c-2f2d-4f22-98cd-f561496c129b': step 'fetch' re-enabled and run reset to 'running'.
Drive it with: realm agent --run-id 7be2233c-2f2d-4f22-98cd-f561496c129b
```

The run is open again. Steps that had completed stay completed; the named step will run again. Then start a driver on it, as the second line says.

`--from` must name a step the run lists under `Failed`. For any other step, the command refuses:

```text
Step 'fetch' is not in failed_steps for run '44df45a3-630d-4679-961e-4cc1616307b4'.
```

A run that was `aborted` cannot be resumed. Start a new run.

## No longer wanted

To end an open run by hand:

```bash
realm run abandon <run-id> --reason "docs test"
```

It prints:

```text
Run '566ba1b6-8e67-4255-9fd9-ed9b270b452d' abandoned (phase: 'abandoned'). Reason: docs test.
…
abandon is a kill — declared finalizers (if any) did NOT run and will not for this run. …
```

Two things to know before you abandon:

- **Cleanup steps do not run.** A workflow's finalizers are skipped.
- **A run waiting at a gate cannot be abandoned.** Answer the gate first.

A run that has already finished is left alone:

```text
Run '0fdae340-…' is already terminal (failed); cannot abandon a finished run.
```

To abandon every open run that has been idle for a while, preview first:

```bash
realm run cleanup --older-than 7d --dry-run
```

It prints:

```text
Would mark 1 run(s) as abandoned.
  • f4dee18d-e5a4-4989-885d-bea2a7b60483
```

Without `--dry-run`, the same command abandons them. It leaves runs that are waiting at a gate.

## Keep the store tidy

Run records stay on disk until you remove them.

### Keep a copy first

`realm run export` writes everything Realm holds about a run to one file:

```bash
realm run export <run-id> --out ./run-44df45a3.json
```

It prints:

```text
Exported run '44df45a3-630d-4679-961e-4cc1616307b4' to './run-44df45a3.json' (5.8 KB).
  phase: failed, attempts: 2, WAL steps: 0, sealed artifacts: 0
```

### Delete finished runs

`realm run purge` deletes finished runs for good. It only reports what it would delete, unless you add `--force`:

```bash
realm run purge --older-than 30d
```

It prints:

```text
6 run(s) WOULD be purged (25.9 KB to free):
  • 0fdae340-a7e5-4ff5-b83f-9fb6086a53be  (failed, 3.6 KB)
  …
5 of 6 selected run(s) are resumable via 'realm run resume' — purging would destroy that path permanently.
Re-run with --force to actually delete.
```

Read the list, then run it again with `--force`:

```text
Purged 1/1 run(s) (6.4 KB freed, store-reported). 0 already gone, 0 blocked, 0 failed.
```

Purge never touches a run that is still open. To purge one run, give its ID in place of `--older-than`.

### Remove leftovers

`realm run gc` removes files that a crash can leave behind. Like purge, it only reports unless you add `--force`:

```bash
realm run gc --older-than 1d
```

It prints, on a clean store:

```text
No orphaned .tmp files found to reap.

No run-less orphaned WAL/sidecar artifacts found to reap.
```

## Two rarer cases

- **A step was started and never finished**, because the process running it died. `realm run reclaim <run-id>` reports such steps, and with `--force` makes them runnable again. The step's work may then happen twice, so read what it reports first.
- **A run ended but its cleanup steps did not finish.** `realm run drain <run-id>` reports them, and with `--force` runs them.

## If you see something else

- **`Run not found: <id>`** No run has that ID in this store. Check the ID with `realm run list`.

## See also

- [`realm run` commands that read](../reference/cli/realm-run-reading.md)
- [`realm run` commands that act](../reference/cli/realm-run-acting.md)
- [Run state and health findings](../reference/mcp/run-state-and-health.md) lists everything `Run Health` can report.
