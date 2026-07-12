# Operating & recovering runs

How to diagnose and recover runs that are stuck, dead, or idle. Realm is daemonless: there is no
background process driving runs — an agent drives a run by calling tools, and the run record on disk
is the source of truth. Recovery is therefore about the **record**, not about killing a process.

---

## Decision table

| Situation             | Symptom                                                                                              | Action                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stuck but recoverable | A run is terminal `failed` because one step errored, but the work can be retried                     | `realm resume <run-id> --from <step>` — re-enables the failed step and resets the run to `running`, then drive with `realm agent --run-id <run-id>`. |
| Stuck and dead        | A run is `running` with no claimed step (`in_progress_steps: []`) and no agent is coming back for it | `realm run abandon <run-id> [--reason …]` (or the `abandon_run` MCP tool), then re-run (see [Recovery loop](#recovery-loop)).                        |
| Bulk idle             | Many old non-terminal runs left parked                                                               | `realm run cleanup --older-than 30d` — abandons idle non-terminal runs (skips `gate_waiting`).                                                       |
| Disk cleanup          | Old terminal runs (and their artifacts) should be permanently removed                                | `realm run purge --older-than 30d [--force]` — see [Purging runs](#purging-runs-permanent-deletion). **Irreversible.**                               |
| Fleet visibility      | "Which runs are stuck right now?"                                                                    | `realm run list --stuck` (running ∧ no claimed step, with idle age) and `get_run_state` → `next_actions_status`.                                     |
| Awaiting a human      | A run is `gate_waiting`                                                                              | Resolve it via `submit_human_response` (the `respond` MCP tool / `realm run respond`). **Do NOT abandon a gated run** — abandon refuses it.          |

### `next_actions_status` (from `get_run_state`)

`get_run_state` returns `next_actions` plus a `next_actions_status` that classifies the run:

| Status                | Meaning                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ok`                  | `next_actions` is authoritative — either there are agent steps to call, or the run is healthy with nothing pending right now.                    |
| `auto_pending`        | Eligible steps exist but they are all `auto` — the engine drives them on the next `execute_step`/chain; the run is **not** waiting on the agent. |
| `awaiting_human`      | A human gate is open — answer it with `submit_human_response`.                                                                                   |
| `skipped_terminal`    | The run is terminal; nothing to do.                                                                                                              |
| `workflow_unresolved` | The workflow definition could not be loaded (not registered, or no workflow store wired) — `next_actions` could not be computed.                 |

`auto_pending` vs an empty `ok` is the key diagnostic that separates a genuinely-parked run from one
that simply has no agent action pending.

---

## Abandoning a run

`abandon_run` (MCP) / `realm run abandon` (CLI) stamps an authoritative `abandoned_at` marker, which
makes the run derive to phase `abandoned` regardless of any `failed_steps` it carries. It:

- is **idempotent** — abandoning an already-abandoned run is a no-op success;
- **refuses a terminal run** (`completed`/`failed`/`aborted`) with `STATE_RUN_TERMINAL` — it never clobbers a finished run;
- **refuses a `gate_waiting` run** with `STATE_TRANSITION_DENIED` — resolve the gate first (gate abandonment is intentionally not supported in this version);
- is **concurrency-safe** — if a live writer advances the run while abandon is in flight, abandon loses (propagates `STATE_SNAPSHOT_MISMATCH`) rather than corrupting the record.

### Honesty note

Abandoning closes the **record**, not any detached agent process. Realm cannot stop a detached
`realm agent` that may still be running elsewhere. This is safe: the engine's terminal-run guards
make that agent's next `execute_step` / `submit_human_response` / `executeChain` call a no-op on the
now-terminal run — it cannot re-drive or un-abandon it.

---

## Recovery loop

After abandoning a run you usually want to re-run the same work. Because the original run keeps its
idempotency key, the **default** `start_run` policy (`on_terminal_match: 'reuse'`) returns the
abandoned run instead of starting fresh. To actually re-run, either:

- call `start_run(..., on_terminal_match: 'rerun')` (or `'rerun_if_failed'`) to **supersede** the
  abandoned run with a fresh one, or
- start with a **new idempotency key**.

See the idempotency re-encounter policy in [mcp-protocol.md](mcp-protocol.md#idempotency-re-encounter-policy).

---

## Purging runs (permanent deletion)

`realm run cleanup` and `realm run abandon` only **mark** a run terminal — the record, the
idempotency-key pointer, the failed-attempt sidecar, and any orphaned trace-buffer WAL files all stay
on disk forever. Realm is daemonless and evidence-first by design: nothing runs in the background to
reclaim disk, and nothing is ever deleted implicitly. `realm run purge` is the one place that changes —
an **operator-invoked, irreversible** deletion of a terminal run and everything co-located with it.

```bash
realm run purge <run-id>                                   # dry-run: reports what WOULD be deleted
realm run purge <run-id> --force                            # actually deletes it
realm run purge --older-than 30d [--workflow <id>]          # dry-run over a batch
realm run purge --older-than 30d --force                    # actually deletes the batch
```

### Abandon vs. purge — they are not the same axis

|                    | `cleanup` / `abandon`                          | `purge`                                                    |
| ------------------ | ---------------------------------------------- | ---------------------------------------------------------- |
| What it does       | Marks a run terminal (`abandoned`)             | Deletes the run and all its artifacts from disk            |
| Reversible?        | Yes — the record still exists; resume/rerun it | **No** — this is the first irreversible primitive in Realm |
| Targets            | Non-terminal, non-`gate_waiting` runs          | **Terminal-only** runs, claim-state permitting (see below) |
| Exposed to agents? | Yes (`abandon_run` MCP tool)                   | **No** — CLI-only, deliberately never an MCP tool          |

Purge will **never** touch a run that is not terminal or a run that is `gate_waiting`. Beyond that, its
claim-state check is **mode-aware** — the same run can be refused in a batch sweep yet purgeable when
you name it directly:

- A run carrying a **future-deadline (`healthy`)** claim on a step is **never purged, in either mode** —
  a runner is provably still working it, and there is no override. This matters specifically for
  `abandoned` runs, since abandoning does **not** clear `in_progress_steps`/`claims`.
- A run carrying an **indeterminate-age (`claim_unknown_age` — no deadline recorded)** claim is
  **skipped with a warning in batch mode** — a cron sweep cannot prove the runner is dead, so it
  refuses to guess — but **is** purgeable via an explicit single-run `realm run purge <id> --force`.
  Naming the exact run is a deliberate operator judgment call that a batch sweep won't make
  automatically (mirrors why `reclaim`'s own `--all` auto-reclaim refuses this same claim state).
- A run with a **past-deadline (`claim_stale`)** claim, or no in-progress claim at all, is purgeable in
  both modes.

Like `reclaim --all`, purge is **dry-run by default** — even naming a single `<run-id>` only reports
what would happen until you add `--force`. The report always includes an explicit count of how many
of the selected runs are **resumable** (phase ∈ `failed`/`abandoned`) via `realm resume` — because
purging one destroys that path permanently. Batch mode's continue-on-error report distinguishes a
run that a concurrent purge already removed (`already_purged` — benign) from a genuine deletion
failure (`failed`).

### Retention model

There is no background retention policy and no cron. `--older-than` is an **age-only** selector in
this version — size- or count-based retention (e.g. "keep the last N" or "cap total disk usage") is a
deferred fast-follow, not yet implemented. Retention is entirely operator-managed: you decide when
and what to purge, and the command tells you exactly what it did.

Purge does **not** sweep orphaned `.tmp`/`.lock` crash-residue files — a live-held lockfile could be
corrupted by an unconditional sweep, so that cleanup has its own dedicated safety design and ships
separately.

---

## Failed agent attempts (`agent_step_attempt_failed` telemetry)

When an agent calls `execute_step` with output that fails schema validation, the engine rejects it
**before the step is claimed** — a write-free path: nothing is persisted to the run record and
`version` is not bumped. The validation error is returned live to the caller (`error_details.errors`)
but is otherwise ephemeral, so there is no post-mortem trail of _what the agent submitted_ or _which
rule failed_.

To give operators that trail, the MCP server emits a structured **stderr** event on each such
rejection:

```json
{
  "event": "agent_step_attempt_failed",
  "run_id": "...",
  "workflow_id": "...",
  "step_id": "...",
  "ts": "...",
  "error_code": "VALIDATION_OUTPUT_SCHEMA",
  "validation_error_summary": [
    { "instancePath": "/category", "schemaPath": "...", "keyword": "required", "message": "..." }
  ],
  "submitted_key_count": 1,
  "submitted_keys": ["ticket_body"],
  "submitted_bytes": 48,
  "trace_entry_count": 0
}
```

- **Filter by `event`** (`agent_step_attempt_failed`) — stderr also carries other structured events
  (e.g. `idempotency_dedup`).
- Emitted only for the three pre-claim validation codes: `VALIDATION_INPUT_SCHEMA`,
  `VALIDATION_OUTPUT_SCHEMA`, `VALIDATION_TRACE_SCHEMA`. Not for `blocked`, other errors, or success.
- **Metadata-only — never raw model output.** The record carries Ajv error metadata (with the
  offending-value echoes dropped), submitted key _names_ (capped), counts, and byte size — never
  submitted values or trace content. (Key names are leak-resistant, not leak-proof — a hard cap
  applies; the durable sidecar below records the same metadata-only record.)

**Pre-claim vs post-claim — the load-bearing distinction:** a pre-claim _validation_ rejection
(this event) never reaches `failed_steps[]` and never bumps `version` — it is invisible on the run
record, which is exactly why this telemetry exists. A post-claim _execution_ failure (the step
claimed, then its handler/adapter failed) **does** land in `failed_steps[]`, bumps `version`, and is
visible via `get_run_state` / `realm run inspect`.

### Durable sidecar + `realm run attempts`

stderr is ephemeral, so the same record is also appended to a **durable, co-located per-run sidecar**:

```
<runsDir>/<run-id>.attempts.jsonl     # one JSON record per line
```

- The suffix is **`.jsonl`** by design — `JsonFileStore.list()` parses every top-level `*.json` as a
  run record, so a `<id>.attempts.json` sibling would corrupt `list()` / `cleanup` / `reconcile`.
  `.jsonl` is invisible to that filter (like `trace-buffer-*.jsonl` and the `keys/` subdir). The path
  is derived only from the server-generated UUID run id.
- **Operator-managed retention** — the sidecar lives in `runsDir` next to the run files. Realm has no
  _background_ run-GC by design, but an operator can explicitly delete it (and the run it belongs to)
  via `realm run purge` — see [Purging runs](#purging-runs-permanent-deletion) below.
- **Append-and-stop cap** — each sidecar is bounded at ~256 KB (~80+ records). Once at the ceiling,
  later attempts are **dropped** (it keeps the **first N**, not a ring buffer), and reads report a
  `capped` flag. The append is lock-free (each line is ≤ PIPE_BUF, so a single `O_APPEND` write is
  atomic) and best-effort (a failed write never affects the `execute_step` response).

Read the sidecar with the CLI:

```bash
realm run attempts <run-id>          # table: ts, step, error_code, key count, validation summary
realm run attempts <run-id> --json   # raw records + capped flag
```

A run with no recorded failures prints a friendly empty message; if the sidecar hit its ceiling, the
output notes that later attempts were dropped.
