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
