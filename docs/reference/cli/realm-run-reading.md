# `realm run`: commands that read

`realm run` has sixteen subcommands. This page covers the six that only read: they change no run. The other ten are in [`realm run`: commands that act](realm-run-acting.md). Every output shown came from a run of the command.

| Subcommand              | What it does                                                  |
| ----------------------- | ------------------------------------------------------------- |
| [`list`](#list)         | Lists runs, newest first.                                     |
| [`inspect`](#inspect)   | Prints everything recorded about one run.                     |
| [`attempts`](#attempts) | Lists the answers to agent steps that were refused.           |
| [`diff`](#diff)         | Compares two runs, or two saved replays, step by step.        |
| [`replay`](#replay)     | Checks a run's preconditions again with changed step outputs. |
| [`export`](#export)     | Writes everything Realm holds about one run to one JSON file. |

All six read the store in `~/.realm/`. A run ID that is not in the store gets `Run not found: <id>` and exit code 1, except from `attempts`.

## `list`

```text
realm run list [--workflow <id>] [--status <phase>]
realm run list --stuck [--older-than <duration>] [--workflow <id>]
```

Prints one line for each run, newest change first.

| Flag                      | What it does                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `--workflow <id>`         | Lists only runs of this workflow.                                                                        |
| `--status <phase>`        | Lists only runs in this phase: `running`, `gate_waiting`, `completed`, `failed`, `abandoned`, `aborted`. |
| `--stuck`                 | Lists only runs that have a health finding. Cannot be combined with `--status`.                          |
| `--older-than <duration>` | With `--stuck`: how long an open run must have been idle to be listed. Default `24h`.                    |

A duration is a whole number followed by `d`, `h` or `m`: `7d`, `6h`, `30m`. Write zero as `0m`.

```bash
realm run list
```

```text
2b2fd502-f418-4b67-838d-6838b8dd4fa1  triage v1  running  10/2/2026, 1:52:37 AM  0 step(s)
fd894510-2017-4018-8087-1b1f357b6dfd  triage v1  gate_waiting  10/2/2026, 1:52:36 AM  2 step(s)  gate: draft (0m)
1620765a-51a0-4ceb-8017-657aafcf14e1  triage v1  running  10/2/2026, 1:52:34 AM  1 step(s)
419c3c51-c4e7-4066-970f-8f877844709a  triage v1  completed  10/2/2026, 1:52:32 AM  3 step(s)
```

Each line holds, in order:

| Part                 | Holds                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Run ID               | The run's ID.                                                                                                                   |
| Workflow             | The workflow's `id` and `version`.                                                                                              |
| Phase                | One of the six phases.                                                                                                          |
| Time                 | When the run last changed, in the local time and format of the machine.                                                         |
| `N step(s)`          | How many steps have a record in the run.                                                                                        |
| `gate: <step> (age)` | On a run in `gate_waiting`: the step whose gate is open, and for how long. `EXPIRED` and reminder times follow when they apply. |

With `--stuck`, a first line gives the limit, each line has `idle:` and the time since the run last changed, and the end of the line names what was found:

```text
Stuck runs (threshold 0m):
3b4c2b57-9b87-4bb6-88a1-e0c553f4970f  triage v1  running  10/2/2026, 12:26:36 AM  0 step(s)  idle: 1h 29m  classify=drive_failing(connection_error)
07125815-e69c-40e2-8af1-afff99a7b7d9  price2 v1  running  10/1/2026, 11:15:33 PM  1 step(s)  idle: 2h 40m  total: needs handler 'order_totl'
8814edbd-f187-4e95-a83b-5a0529fb55d0  price v1  running  10/1/2026, 11:15:03 PM  1 step(s)  idle: 2h 40m
```

A line with nothing after `idle:` is an open run with no step in progress that has not changed for longer than the limit. [Run state and health findings](../mcp/run-state-and-health.md) lists every finding.

When nothing matches, `list` prints one of:

```text
No runs found.
No runs found for workflow 'nope'.
No stuck runs found (threshold 24h).
No stuck runs found for workflow 'nope' (threshold 0m).
```

**Exit code:** 0, also when nothing matches. 1 for a flag that cannot be used:

```text
Invalid --status value 'done'. Valid values: running, gate_waiting, completed, failed, abandoned, aborted
Invalid duration '0'. Use format: <number>(d|h|m), e.g. 30d, 6h, 10m
--older-than is only valid with --stuck.
--stuck cannot be combined with --status.
```

## `inspect`

```text
realm run inspect <run-id> [--verbose] [--check-drift]
```

Prints the run's record: where it stands, then one entry for each step that ran.

The outputs in this section are from the `main` branch. Version 0.45.0 prints the `Diagnostics` line as `~10 tokens | no preconditions`: it has no `(estimate, step input)`, no measured token figures and no cache part. It also prints no `cost` line, and no `usage` line under a drive failure.

| Flag            | What it does                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `--verbose`     | Under each tool call, also prints the arguments it was given and what it returned.                        |
| `--check-drift` | Compares the project's code files as they are now with the hashes recorded when the run last loaded them. |

```bash
realm run inspect 419c3c51-c4e7-4066-970f-8f877844709a
```

```text
Run: 419c3c51-c4e7-4066-970f-8f877844709a
Workflow: triage v1
Phase: completed  ✓
Sealed by: complete
Cause: Workflow completed.
Completed: classify, draft, send
In Progress: (none)
Failed: (none)
Skipped: (none)
Created: 2026-10-01T22:52:32.587Z
Updated: 2026-10-01T22:52:32.807Z

Evidence (3 steps):

  1. classify               success   0ms   hash: 09a1b61c
     Input:  {"category":"billing","confidence":0.9}
     Output: {"category":"billing","confidence":0.9}
     Diagnostics: ~10 tokens (estimate, step input) | no preconditions
     cost: not recorded — realm did not drive this step (an outside agent over MCP, an answer typed at a realm workflow run prompt, or a record written before usage was measured)

  2. draft                  success   0ms   hash: 626ebbef
     Input:  {"reply":"We have refunded the charge."}
     Output: {"reply":"We have refunded the charge."}
     Diagnostics: ~10 tokens (estimate, step input) | preconditions: classify.confidence >= 0.7 → true (0.9)
     cost: not recorded — realm did not drive this step (an outside agent over MCP, an answer typed at a realm workflow run prompt, or a record written before usage was measured)
  …
```

### The lines at the top

| Line                                            | Printed                                  | Holds                                                                                                   |
| ----------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `Run`, `Workflow`, `Phase`                      | Always                                   | The run's ID, the workflow's `id` and `version`, and the phase.                                         |
| `Rerun of`                                      | When the run replaced an earlier one     | The ID of the run it replaced. See [Idempotency and batches](../../guides/idempotency-and-batches.md).  |
| `Sealed by`                                     | When the run has ended                   | What ended it, such as `complete`, `step_failure` or `handler_abort (total)`.                           |
| `Cause`                                         | When the run has ended                   | The same, as a sentence.                                                                                |
| `Completed`, `In Progress`, `Failed`, `Skipped` | Always                                   | The names of the steps in each state. Under `Skipped`, one line for each skipped step gives the reason. |
| `Defaulted (settled by default)`                | When a step was given its default output | The names of those steps.                                                                               |
| `Created`, `Updated`                            | Always                                   | When the run was started and when it last changed, in UTC.                                              |
| `Gate`, `Choices`                               | When the run is in `gate_waiting`        | The step, the gate's ID, how long it has been open, and the choices it accepts.                         |

A skipped step's reason looks like this:

```text
Skipped: total, confirm
  total: handler_abort
  confirm: trigger_rule_unsatisfiable: all_success, dep total skipped
```

A waiting gate looks like this:

```text
Gate: draft (gate 0f2d0b7a-bca4-45d0-9c6b-83559e04a88d, opened 0m ago)
  Choices: send, discard
```

### The blocks in the middle

Each block is printed only when the run has something for it.

| Block                | Printed when                                   | Holds                                                                                              |
| -------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `Drive failures`     | `realm agent` gave up on the run at least once | The time, the step, the model provider, the kind of failure, and what the provider had billed.     |
| `Run Health`         | Realm finds something wrong with the run       | One line for each finding: its name, the step, and a sentence.                                     |
| `Extension Identity` | The run used code from the project             | Each time the code was loaded: the files, their hashes, and which folder the hashes cover.         |
| `Drift check`        | `--check-drift` was given                      | For each recorded file, `same`, `DIFFERS` or `MISSING`.                                            |
| `Trace Summary`      | A step recorded trace entries                  | How many steps have entries, how many entries were kept and dropped, and the most frequent events. |

```text
Drive failures:
  2026-10-01T21:26:32.069Z  classify  openai  validation_rejected after 20ms: Invalid input for step 'classify'
    usage: 3 requests billed before the output was rejected — 1236 prompt tokens (totals across 3 requests), 114 output tokens (totals across 3 requests), cache not reported
```

```text
Run Health (1 finding(s)):
  structured_output_downgraded: 1 step(s) requested strict structured output but ran without it (classify: compat_endpoint) — outputs were validated post-hoc (L1), not grammar-constrained
```

```text
Trace Summary:
  steps_with_trace:        1
  steps_with_trace_unique: 1
  stored_entries_total:   2
  discarded_entries_total:0
  truncated_steps:        0
  top_events:             read_ticket (1), checked_history (1)
```

With `--check-drift`, after one of the project's files was edited:

```text
Drift check (pure recompute of the last entry under its recorded rules):
  module /srv/shop/handlers.mjs: DIFFERS (recorded a59b22a278c91b616785489dc22fb481c402a5a0f522a818d22f88991120f6bb, current f980fa2b6f70aaff613db47eee7bfafd78dbfe943c0bca97a735d2102f3f9a48)
  manifest /srv/shop/realm.yaml: same
  tree: DIFFERS (recorded 7f6269ffdae72dc4513e84520e3838970c18716fe9951703606547eb8864ff20, current 4bca32402e93d3ad7e124501c8353dca8941c2383666d7359ade2278eb80cc88)
```

The check reads the files and computes their hashes. It does not load or run them. For a run that used no project code, it prints `Drift check: no extension identity recorded for this run.`

### The entry for each step

`Evidence` has one entry for each step that ran, in the order they first ran.

| Line          | Printed when                         | Holds                                                                                                                                                                                      |
| ------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First line    | Always                               | The step's name, `[profile: <name>]` if it has an agent profile, `success` or `error`, how long it took, and the first 8 characters of its hash.                                           |
| `Input`       | Always                               | What the step was given. Text longer than 120 characters is cut, and ends in `…`.                                                                                                          |
| `Resolved`    | The step called a service            | The parameters after `input_map` was applied.                                                                                                                                              |
| `Output`      | Always                               | What the step produced, cut in the same way.                                                                                                                                               |
| `Trace`       | The step recorded trace entries      | How many.                                                                                                                                                                                  |
| `Tool calls`  | An agent step called tools           | One line for each call: the server, the tool and the time taken. `Tools declared, none called` if it had tools and used none.                                                              |
| `Diagnostics` | The step is an agent or an auto step | An estimate of the input's size, the measured prompt and output tokens if `realm agent` drove the step, each precondition with its result, and what the provider reported about its cache. |
| `cost`        | No token counts were recorded        | The reason there are none.                                                                                                                                                                 |

A step that `realm agent` drove has measured numbers:

```text
  1. classify               [profile: support-lead] success   0ms   hash: 93b4b175
     Input:  {"category":"bug","urgent":false,"reason":"A valid answer this time."}
     Output: {"category":"bug","urgent":false,"reason":"A valid answer this time."}
     Diagnostics: ~18 tokens (estimate, step input) | 412 prompt tokens (measured, first request) | 38 output tokens | no preconditions | cache: not reported by the provider (1 request)
```

A step that called a tool, with `--verbose`:

```text
     Tool calls (1):
       [notes:list_directory]  8ms
         args:   {"path":"."}
         result: {"content":[{"type":"text","text":"[FILE] returns.md\n[FILE] shipping.md"}],"structuredContent":{"content":"[FILE] returns.md\n[FILE] shipping.md"}}
```

Without `--verbose`, only the `[notes:list_directory]  8ms` line is printed.

A step that ran more than once has one line for each attempt. `Input`, `Output` and `Diagnostics` are those of the last attempt:

```text
  1. fetch
     (attempt 1/2)  error   1002ms   hash: 44136fa3
     (attempt 2/2)  success   0ms   hash: e715712f
     Input:  {"sleep_ms":1500,"sleep_calls":1}
     Output: {"ok":true,"calls":2}
     Diagnostics (attempt 2/2): ~9 tokens (estimate, step input) | no preconditions
```

The choice made at a gate is not among these lines. It is in the run's record, which [`export`](#export) writes out.

**Exit code:** 0, or 1 if the run is not in the store.

## `attempts`

```text
realm run attempts <run-id> [--json]
```

Lists the answers to agent steps that Realm refused because they did not fit the step's schema. Realm keeps the shape of each refused answer and not its values.

| Flag     | What it does                              |
| -------- | ----------------------------------------- |
| `--json` | Prints the full records as a JSON object. |

```bash
realm run attempts 419c3c51-c4e7-4066-970f-8f877844709a
```

```text
Failed attempts for run 419c3c51-c4e7-4066-970f-8f877844709a (1):

2026-10-01T22:52:32.649Z  classify  VALIDATION_INPUT_SCHEMA  2 key(s)  enum /category
```

Each line holds the time, the step, the error code, how many fields the answer had, and the first rule it broke with the field that broke it. `(+N more)` follows when it broke more than one.

With `--json`:

```json
{
  "records": [
    {
      "run_id": "419c3c51-c4e7-4066-970f-8f877844709a",
      "workflow_id": "triage",
      "step_id": "classify",
      "ts": "2026-10-01T22:52:32.649Z",
      "error_code": "VALIDATION_INPUT_SCHEMA",
      "validation_error_summary": [
        {
          "instancePath": "/category",
          "schemaPath": "#/properties/category/enum",
          "keyword": "enum",
          "message": "must be equal to one of the allowed values"
        }
      ],
      "submitted_key_count": 2,
      "submitted_keys": ["category", "confidence"],
      "submitted_bytes": 41,
      "trace_entry_count": 0
    }
  ],
  "capped": false
}
```

`capped` is `true` when the run had so many refused answers that Realm stopped recording them.

A run with none, and an ID that is not in the store, both get the same line:

```text
No failed attempts recorded for run 2b2fd502-f418-4b67-838d-6838b8dd4fa1.
```

**Exit code:** 0.

## `diff`

```text
realm run diff <run-id-a> <run-id-b>
realm run diff <replay-id-a> <replay-id-b>
```

Compares two runs step by step. It has no flags.

```bash
realm run diff 419c3c51-c4e7-4066-970f-8f877844709a fd894510-2017-4018-8087-1b1f357b6dfd
```

```text
Diff: 419c3c51-c4e7-4066-970f-8f877844709a  vs  fd894510-2017-4018-8087-1b1f357b6dfd
Workflow: triage

Step                   A status     B status   A hash     B hash     Δ ms
─────────────────────  ─────────  ─────────  ─────────  ─────────  ─────────
classify               success    ≠ success    09a1b61c   fa915a2f   0
draft                  success    ≠ success    626ebbef   0296aa12   0
send                   success      missing    3144c559   —          —
```

| Column                 | Holds                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `A status`, `B status` | `success` or `error` for the step in each run, or `missing` if the step did not run.      |
| Between them           | `=` if the step has the same status and the same output in both runs, `≠` if not.         |
| `A hash`, `B hash`     | The first 8 characters of the hash of the step's output. Equal outputs have equal hashes. |
| `Δ ms`                 | The step's duration in B minus its duration in A.                                         |

If the two runs are of different workflows, a warning is printed first, and the comparison is still made: `Warning: runs are from different workflows (w3 vs ex-default)`.

Given two replay IDs, which begin with `rpl_`, `diff` compares two saved replays:

```text
Replay diff: rpl_26bfbaf4-2069-422d-853d-616e900f3fce  vs  rpl_928fd9ef-ba28-4d5b-b3f7-33aebe8e99a1
Origin runs: 419c3c51-c4e7-4066-970f-8f877844709a  vs  419c3c51-c4e7-4066-970f-8f877844709a
Overrides A: classify.confidence=0.5
Overrides B: classify.confidence=0.95
Overrides B: classify.category=bug

Step                   Replay A                               Replay B                               Diff?
─────────────────────  ─────────────────────────────────────  ─────────────────────────────────────  ─────
classify               none                                   none                                   =
draft                  PASS → BLOCKED                         PASS → PASS                            ≠
send                   none                                   none                                   =
```

**Exit code:** 0, or 1 if an ID is not in the store, or if one ID is a run and the other a replay:

```text
Error: cannot diff a run against a replay. Provide two run IDs or two replay IDs.
```

## `replay`

```text
realm run replay <run-id> [--with <step>.<field>=<value> ...] [--save]
```

Takes the outputs the run's steps recorded, changes the ones you name, and checks every step's `preconditions` against the result. It runs no step and changes no run.

| Flag                            | What it does                                                          |
| ------------------------------- | --------------------------------------------------------------------- |
| `--with <step>.<field>=<value>` | Replaces one field of one step's output. Can be given more than once. |
| `--save`                        | Stores the result in `~/.realm/replays/` and prints its ID.           |

A value of `true` or `false` is read as a boolean, a number as a number, and anything else as text. `<field>` can be a path with dots, such as `result.score`.

```bash
realm run replay 419c3c51-c4e7-4066-970f-8f877844709a --with classify.confidence=0.5 --save
```

```text
Replay of 419c3c51-c4e7-4066-970f-8f877844709a
Override: classify.confidence = 0.5

Step                   Preconditions (original → replay)      Changed?
─────────────────────  ─────────────────────────────────────  ────────
classify               none                                   no
draft                  PASS → BLOCKED                         YES ⚠
send                   none                                   no

Saved replay: rpl_26bfbaf4-2069-422d-853d-616e900f3fce
```

| Column          | Holds                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Preconditions` | `none` for a step without preconditions. Otherwise the result with the recorded outputs, then with the changed ones. |
| `Changed?`      | `YES ⚠` if the two results differ.                                                                                   |

For a run that has not ended, a warning comes first: `Warning: run <id> is not in a terminal state. Partial replay.`

**Exit code:** 0, or 1 if the run is not in the store or a `--with` value is malformed:

```text
Invalid override 'classify': missing '='
Invalid override 'confidence=1': missing '.'
```

## `export`

```text
realm run export <run-id> [--out <path>]
```

Writes one JSON file with the run's record, its refused answers and its trace entries.

| Flag           | Default                 | What it does                                                                                   |
| -------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| `--out <path>` | `./<run-id>.realm.json` | The file to write. If `<path>` is an existing folder, the file is `<run-id>.realm.json` in it. |

```bash
realm run export 419c3c51-c4e7-4066-970f-8f877844709a --out ./exports
```

```text
Exported run '419c3c51-c4e7-4066-970f-8f877844709a' to '/srv/shop/exports/419c3c51-c4e7-4066-970f-8f877844709a.realm.json' (4.3 KB).
  phase: completed, attempts: 1, WAL steps: 0, sealed artifacts: 0
```

The second line gives:

| Part               | Holds                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `phase`            | The run's phase.                                                                                             |
| `attempts`         | How many refused answers the file holds.                                                                     |
| `WAL steps`        | How many steps have trace entries that were sent with `append_trace` and whose step has not yet been called. |
| `sealed artifacts` | How many sets of trace entries Realm set aside when a step was taken over from another caller.               |

A run that has not ended can be exported. A warning comes first:

```text
⚠ best-effort snapshot: run 'fd894510-2017-4018-8087-1b1f357b6dfd' is still gate_waiting; its artifacts are read at slightly different instants and may be mid-flight
```

`export` does not replace a file:

```text
Refusing to overwrite existing file '/srv/shop/419c3c51-c4e7-4066-970f-8f877844709a.realm.json'. Choose a different --out.
```

See [The run record and export file](../run-record-and-export.md) for the fields of the file.

**Exit code:** 0 if the file was written and is complete. 1 if the run is not in the store, if the file exists, or if part of the run's data could not be read; in the last case the file is still written, and the output names what is missing.

## See also

- [Operate runs](../../guides/operate-runs.md)
- [`realm run`: commands that act](realm-run-acting.md)
- [Run state and health findings](../mcp/run-state-and-health.md)
- [Evidence](../../concepts/evidence.md)
