# Evidence, and how a run ends

Every run leaves a record: what each step received, what it produced, why a step was skipped, and what ended the run. This page explains what is in that record, how to read it, and what it does and does not prove.

## One entry per step that ran

`realm run inspect <run-id>` prints the record. Each step that ran has an entry:

```text
  3. pay                    success   1ms   hash: 02e8468b
     Input:  {}
     Output: {"paid":20}
```

An entry holds:

- the step's name and whether it succeeded or failed;
- when it started and finished, and how long it took;
- what went in and what came out;
- a **hash** of the output: a short fingerprint that changes if the output changes.

A step that failed has an entry too, marked `error`:

```text
  3. pay                    error   1ms   hash: 44136fa3
     Input:  {}
     Output: {}
```

A human gate leaves its own entry when it is answered, with the choice that was made.

## What is not in the evidence

**Refused answers.** An answer that fails a step's schema is not recorded as that step's output. The record keeps a count of refusals for the step. For a step driven over MCP, `realm run attempts <run-id>` lists them: when each happened and which rule it broke. Refusals at the `realm workflow run` prompt, and the ones `realm agent` repairs by asking the model again, are not listed there; `realm agent` reports its own under `Drive failures` when it gives up.

**Skipped steps.** A step that never ran has no entry. It is listed under `Skipped`, with the reason:

```text
Skipped: flag_large, open_ticket
  flag_large: when_false: assess.amount > 50 [lhs → 20]
  open_ticket: trigger_rule_unsatisfiable: one_failed, dep pay completed
```

The reason includes the value the condition was checked against. See [Order and routing](order-and-routing.md) for the six reasons.

## How a run ends

A finished run has one of four final phases. The record also says exactly what ended it, on the `Sealed by` line.

| Final phase | Sealed by                  | What happened                                                   |
| ----------- | -------------------------- | --------------------------------------------------------------- |
| `completed` | `complete`                 | The last step finished.                                         |
| `completed` | `gate_resolution_complete` | Answering a gate finished the run.                              |
| `completed` | `guard_pass_complete`      | A guard passed and nothing was left to run.                     |
| `completed` | `gate_expiry_default`      | A gate ran out of time and its default choice finished the run. |
| `failed`    | `step_failure`             | A step failed and the workflow had no way to carry on.          |
| `failed`    | `guard_resolution_error`   | A guard's condition pointed at a value that does not exist.     |
| `failed`    | `spawn_failure`            | `realm listen` could not start the process to drive the run.    |
| `failed`    | `extensions_load_failure`  | The project's own code could not be loaded.                     |
| `aborted`   | `guard_abort`              | A guard's condition was false.                                  |
| `aborted`   | `handler_abort`            | A handler asked for the run to stop.                            |
| `aborted`   | `gate_expiry_abort`        | A gate ran out of time and was set to abort.                    |
| `abandoned` | `abandon_requested`        | An operator ended the run with `realm run abandon`.             |
| `abandoned` | `cleanup_sweep`            | `realm run cleanup` ended the run because it was idle.          |

For example, a run stopped by a guard:

```text
Phase: aborted
Sealed by: guard_abort (only_low_risk)
```

## Completed, with a failed step

A run can be `completed` and still list a failed step. That happens when a step fails and the workflow has another step that handles the failure. `realm run inspect` flags such a run:

```text
Phase: completed  ✓
Failed: pay
Run Health (1 finding(s)):
  completed_with_failed_steps: completed with 1 failed step(s): pay …
```

Check `Failed:` as well as `Phase:` when you need to know whether everything went well.

## What the record proves, and what it does not

The record shows what Realm accepted and when. For each step, the hash ties the entry to the output the step produced at that moment.

It does not prove that the record is unchanged. Run records are plain files under `~/.realm/runs/`. If a file is edited by hand, `realm run inspect` prints the edited text and shows no warning; the hash is not checked again when the record is read. If you need to show a record to someone else, keep a copy somewhere the people involved cannot change, for example by exporting it with `realm run export` at the end of the run.

It also does not prove that an output is correct. Realm checks that an answer has the right shape. Whether the answer is right is for the workflow's own checks and for the people at its gates.

## See also

- [Run record and export format](../reference/run-record-and-export.md) lists every field.
- [`realm run` reading commands](../reference/cli/realm-run-reading.md) covers `list`, `inspect`, `attempts`, `diff` and `export`.
- [Operate runs](../guides/operate-runs.md) covers what to do with a run that did not finish.
