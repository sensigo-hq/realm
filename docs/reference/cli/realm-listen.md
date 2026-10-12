# `realm listen`

<!-- description: Reference for realm listen, the web server that starts a run for each accepted HTTP request: its flags, its startup, every line it logs, and how it stops. -->

`realm listen` is a web server that starts a run for each HTTP request a workflow's `trigger` block accepts. This page lists its argument and 11 flags, what it does when it starts, each line it logs, and how it stops. Every output shown came from a running `realm listen`.

The `trigger` block, the checks made on a request and the reply for each are in [Webhook trigger](../workflow/webhook-trigger.md). For a walk through one webhook, see [Start runs from webhooks](../../guides/webhooks.md).

## Synopsis

```text
realm listen [workflows...] --model <model> [flags]
```

`workflows` is one or more workflow folders or files. Without it, `realm listen` uses the workflow in the current folder.

`--model` is required: Realm has no default model, and `realm listen` passes the model to the `realm agent` it starts for each run. It is required even for a workflow in which no step calls a model. Version 0.45.0 has no `--model` or `--provider` on `realm listen`; each run's `realm agent` used its own default model there.

The commands on this page use Anthropic and the model `claude-sonnet-5-5`; any model Anthropic lists works. With an OpenAI key, use `--provider openai --model <a model from OpenAI's list>` ([OpenAI's models](https://developers.openai.com/api/docs/models)).

## Flags

| Flag                              | Default                                                                                  | What it does                                                                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--port <n>`                      | `3000`                                                                                   | The port to listen on.                                                                                                                                                                        |
| `--host <addr>`                   | `127.0.0.1`                                                                              | The address to listen on. The default accepts requests from the same machine only.                                                                                                            |
| `--max-body-bytes <n>`            | `1048576`                                                                                | The largest request body accepted, in bytes. The default is 1 MiB.                                                                                                                            |
| `--body-timeout-ms <n>`           | `5000`                                                                                   | The longest a request body may take to arrive, in milliseconds.                                                                                                                               |
| `--max-concurrent <n>`            | `20`                                                                                     | How many requests may be handled at once. A request above the limit gets `503`.                                                                                                               |
| `--dedup-store <kind>`            | `file`                                                                                   | Where the IDs of events already seen are kept: `file` or `memory`.                                                                                                                            |
| `--log-level <level>`             | `info`                                                                                   | The least important level that is logged: `debug`, `info`, `warn` or `error`.                                                                                                                 |
| `--provider <provider>`           | None: each `realm agent` chooses from the API key it finds, and OpenAI when both are set | Passed to each `realm agent` it starts as that command's `--provider`: `openai` or `anthropic`. Another word is refused. Added in 0.46.0.                                                     |
| `--model <model>`                 | None. Required.                                                                          | Passed to each `realm agent` it starts as that command's `--model`: the model's name, as the provider knows it. A name that is empty or holds only spaces counts as missing. Added in 0.46.0. |
| `--llm-timeout <seconds>`         | None                                                                                     | Passed to each `realm agent` it starts as that command's `--llm-timeout`.                                                                                                                     |
| `--sweep-expired-gates <seconds>` | Off                                                                                      | Every this many seconds, carries out the gates in the store whose time has passed.                                                                                                            |

### `--host`

With an address other than the machine's own, `realm listen` warns when it starts:

```text
listen: binding to non-loopback host '0.0.0.0' — this server serves plaintext HTTP. Terminate TLS at a reverse proxy before exposing it.
```

### `--dedup-store`

| Kind     | IDs are kept                                              | After a restart                                                                                                                                                                                                                                               |
| -------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`   | In `~/.realm/dedup/<workflow-id>/`, one file for each ID. | An event seen before the restart is still recognised.                                                                                                                                                                                                         |
| `memory` | In the process.                                           | The list is empty, but the run store still knows the event's ID: the same request gets `200` `deduplicated` with the run it started, and no second agent starts. When that run's agent failed to start, it gets that first reply again: `500` `spawn_failed`. |

### `--llm-timeout`

Without the flag, each run uses `realm agent`'s own default of 600 seconds. With `--llm-timeout 45`, a failed drive's record shows the value it was given:

```text
Drive failures:
  2026-10-04T23:48:57.125Z  answer  anthropic  connection_error after 1471ms: Connection error. (declared 45000ms) (ceiling 196500ms) (attempt 3)
```

### `--sweep-expired-gates`

A gate with `timeout_seconds` is carried out, once its time has passed, only when something next touches its run. With this flag, `realm listen` looks through every run in the store at the given interval and carries out the gates that are due, whether or not it started those runs:

```text
listen: sweeper enacted an expired gate {"run_id":"a36b4ec7-f82b-439d-8011-816ae0023663","gate_id":"10e986c4-6507-48a9-a86f-e00fc7ce6ead","disposition":"abort"}
listen: the enactment terminalized the run — it may carry pending finalizers; run 'realm run drain --expired' (or plain drain, once terminal) to deliver them (the sweeper never drains finalizers itself — no extension registry for an unmounted workflow) {"run_id":"a36b4ec7-f82b-439d-8011-816ae0023663"}
```

When the gate it carried out leaves steps owed to the engine, the line adds `owed`: their names (`realm run advance <run-id>` runs them until a step opens a question, fails or ends the run). When it leaves the run with nothing that can run from here, the line adds `cannot_go_on`: each step that cannot run, then the way out. Both added after version 0.46.0:

```text
listen: sweeper enacted an expired gate {"run_id":"f17eb4b7-7295-4dac-a6a9-1ab52e301a60","gate_id":"2ba6c94a-0ba7-4ba9-9b0c-da687a5bc744","disposition":"settle_default","cannot_go_on":["'compute' cannot run (input_schema): Invalid input for step 'compute': the input must have required property 'n'.","Run f17eb4b7-7295-4dac-a6a9-1ab52e301a60 stays open (phase 'running'): for 'compute', the engine gives it no input, so correct its input_schema and register the workflow again; then, after a fix, realm run advance f17eb4b7-7295-4dac-a6a9-1ab52e301a60 — or end it: realm run abandon f17eb4b7-7295-4dac-a6a9-1ab52e301a60"]}
```

It does not run cleanup steps. See [Gates](../workflow/gates.md#what-happens-at-expiry).

## What it does when it starts

1. Checks that `--model` was given. Without it, it refuses to start before it reads any workflow (see [Exit codes](#exit-codes)). This check was added in 0.46.0.
2. Loads each workflow file. A workflow without a `trigger` block is skipped.
3. Reads the environment variable named by each `secret_from`.
4. Registers each workflow it mounts, as `realm workflow register` does.
5. Loads each workflow's code files.
6. Starts listening, and logs the address.

`realm listen` checks no API key. Each run's `realm agent` checks its own, after it loads the `.env` file in the workflow's folder, so a key kept only in that file is found.

```bash
realm listen open shared --port 4971 --provider anthropic --model claude-sonnet-5-5
```

```text
listen: workflow 'open' uses auth.mode 'none' — webhook verification is DISABLED for path '/open'. Use only on a trusted network.
listen: mounted {"workflow":"open","path":"/open","mode":"none"}
listen: mounted {"workflow":"shared","path":"/shared","mode":"shared_secret"}
realm listen on 127.0.0.1:4971 — 2 workflow(s) mounted
```

Workflows are read once. After any change to a workflow's folder — a deploy, a `git pull`, an edited `.env` — restart `realm listen`: until then, new runs use the workflow it read at start while their agents read the folder as it is now, and keys it loaded from the `.env` of the folder it was started in keep those values in every agent.

When a workflow's code imports a `@sensigo/realm` of another version than the command's, `realm listen` prints the [`REALM_RELEASE_LINE_MISMATCH`](../workflow/loader-diagnostics.md#warning-codes) warning once per copy on stderr at startup (it is not a `listen: <event>` line); the `realm agent` it starts for each request does not repeat it. This was added in 0.46.0.

## What it does for a request

For a request that passes every check, `realm listen` creates the run, starts `realm agent --run-id <run-id> --model <model>` (with `--provider <provider>` when `realm listen` was given one) as a separate process in the workflow's folder, and replies `202`. It does not wait for the run.

A request whose event ID belongs to a run that already exists starts nothing and writes nothing to that run, whether the run is still going or has ended. This happens when the sender delivers the event again after the [duplicate window](../workflow/webhook-trigger.md#dedup) (GitHub's Redeliver, for one), or when two copies of one delivery arrive together. The reply is `200` `{"status":"deduplicated","run_id":"<run-id>","run_phase":"<phase>"}`, and `realm listen` logs `webhook: deduplicated` at `info` (see [Log lines](#log-lines)). `run_phase` is the phase on the run's record, not whether an agent is working on it. When the request's mapped parameters differ from the run's, the request's values are not used: the reply adds `"params_differ":true`, and the line is logged at `warn`:

```text
200 {"status":"deduplicated","run_id":"29d749b9-077f-417b-aafc-0b4e7aaa8be1","run_phase":"running","params_differ":true}
```

Added after version 0.46.0, which started a second `realm agent` on the run, wrote to its record and replied `202`.

When the run's `realm agent` cannot be started (its workflow folder missing, or a folder `realm listen` is not allowed to enter), the run is ended as failed, `realm listen` logs `webhook: spawn failed` naming the folder, and it goes on serving. This holds when `realm listen` was started inside that folder too (`realm listen`, `realm listen ./`): it keeps the folder's full path, so a folder removed and created again at that path is used again. Started inside a folder reached through a symbolic link, the path it keeps is the link's target, so re-pointing the link is not followed. A start the system itself refuses (too many processes, or the Node program removed by an upgrade) ends the run the same way; after a Node upgrade, restart `realm listen`. A folder renamed away while `realm listen` runs (a deploy that swaps folders with `mv`, for one) counts as missing until a folder is back at that path: each delivery meanwhile gets this failure, and its run must be purged before the event can start again. Version 0.46.0 behaves differently. Given the folder by a path from another folder, it stops when the folder is missing or it may not enter it: the request gets no reply, and the run stays `running` with no agent working on it. Started inside the folder, it stops when it may not enter it; when the folder is removed, it answers `202` and starts an agent that cannot run, and the run stays `running`; when the folder is renamed away, it answers `202` and runs the agent in the renamed folder, old contents included. Given the folder by a path, 0.46.0 already answered a file in the folder's place with this failure and kept serving, but its line did not name the folder. The reply to a failed start is:

```text
500 {"error":"spawn_failed","run_id":"726707a4-a0f5-4b98-bff6-8edfe9c3aba8","status":"failed"}
```

A later delivery of that same delivery's event gets that same reply again, starts nothing, and is logged at `warn` as `webhook: deduplicated` with `"reason":"matched_spawn_failed_run"`. Added after version 0.46.0, which answered such a retry by starting another `realm agent` on the failed run. One case does not behave this way yet: when two copies of one delivery arrive together while the agent fails to start, one copy can be answered `200` `{"status":"deduplicated","run_id":"<run-id>","run_phase":"running"}`, and its ID is recorded. Retries then get the bare `200` `{"status":"deduplicated"}` until the duplicate window has passed, then the `500` again, and a purge followed by a new delivery starts a new run only after the window.

What to do with a run a delivery matched:

- A run still going whose agent stopped: drive it again with `realm agent --run-id <run-id>`.
- A run that has ended is not driven again: `realm agent --run-id` refuses it with `Error: Run <run-id> is already in terminal state: <reason>.`, naming the run's own end reason (with no model key set, it refuses on the key first).
- A run whose agent failed to start: remove it with `realm run purge <run-id> --force`, then deliver the event again. It starts a new run at once: the copy whose start failed keeps no duplicate record. Unless two copies arrived together (the case above): then it starts one only after the duplicate window.
- A run that ended any other way: purge it, then deliver the event again once the duplicate window has passed. The window starts again each time a delivery of the event is matched in the meantime, so it is not counted from the first delivery. (With the default file store and a `ttl_minutes` under 60, a delivery matched in the same clock hour, UTC, as the last one recorded does not start it again.) Purge does not clear the duplicate record, so until then the delivery gets `200` `{"status":"deduplicated"}` and starts nothing.

The new process has the environment of `realm listen`, and it loads the `.env` file in the workflow's folder when it starts. The model provider's key must therefore be set where `realm listen` is started or in that `.env`. `realm agent` needs a key to start at all, even for a workflow in which no step calls a model.

If a run's `realm agent` refuses to start (for example, no key for its provider), the run that `realm listen` created stays open, with nothing on its record. Its refusal appears in the same output as the log, and ends `If run <run-id> exists, it was not changed.` To drive the run once the cause is fixed, run `realm agent --run-id <run-id> --provider <provider> --model <model>` in the workflow's folder, with the key set, adding `--llm-timeout` if `realm listen` was given one.

What the new process prints appears in the same output as the log:

```text
webhook: dispatched {"path":"/shared","run_id":"36ae3898-4a7e-4a2b-a240-e3fc3b87240b","pid":599154}

Realm Agent — Webhook shared v1
Run ID: 36ae3898-4a7e-4a2b-a240-e3fc3b87240b

→ [auto] record
  ✓ → completed

Run complete: 36ae3898-4a7e-4a2b-a240-e3fc3b87240b
```

## Log lines

Each line is a message, followed where there are details by a JSON object. Lines at `warn` and `error` go to standard error, the others to standard output.

| Level   | Line                                                                           | Logged when                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `info`  | `listen: mounted {"workflow","path","mode"}`                                   | A workflow is mounted.                                                                                                                                                                              |
| `info`  | `listen: workflow has no trigger block — not mounted`                          | A workflow given on the command line has no `trigger`.                                                                                                                                              |
| `info`  | `listen: extensions loaded {…}`                                                | A mounted workflow's code files were loaded.                                                                                                                                                        |
| `info`  | `realm listen on <host>:<port> — N workflow(s) mounted`                        | The server is ready.                                                                                                                                                                                |
| `info`  | `webhook: dispatched {"path","run_id","pid"}`                                  | A run was created and its driver started.                                                                                                                                                           |
| `info`  | `webhook: rejected params_invalid — <reason>`                                  | A request's values did not fit `params_schema`.                                                                                                                                                     |
| `info`  | `listen: sweeper enacted an expired gate {…}`                                  | `--sweep-expired-gates` carried out a gate.                                                                                                                                                         |
| `info`  | `listen: shutting down {"reason"}`                                             | A stop signal arrived.                                                                                                                                                                              |
| `debug` | `webhook: filtered out {"path"}`                                               | A request did not match the `filter`.                                                                                                                                                               |
| `info`  | `webhook: deduplicated {"path","run_id","run_phase","reason"}`                 | A request's event ID belongs to a run that exists (`reason`: `matched_existing_run`), with the run's mapped parameters; nothing was started. Added after version 0.46.0.                            |
| `debug` | `webhook: deduplicated {"path"}`                                               | A request repeated an event seen within `ttl_minutes`.                                                                                                                                              |
| `warn`  | `listen: workflow '<id>' uses auth.mode 'none' — …`                            | A mounted workflow does not check its requests.                                                                                                                                                     |
| `warn`  | `listen: binding to non-loopback host '<addr>' — …`                            | `--host` is not the machine's own address.                                                                                                                                                          |
| `warn`  | `webhook: verification failed {"path","mode"}`                                 | A request failed the `auth` check.                                                                                                                                                                  |
| `warn`  | `webhook: duplicated security header {"path","header"}`                        | A request carried the signature or secret header more than once.                                                                                                                                    |
| `warn`  | `webhook: dedup id unresolvable, proceeding without dedup`                     | The event's ID was not in the request, and `on_missing_id` is `skip`.                                                                                                                               |
| `warn`  | `webhook: deduplicated {"path","run_id","run_phase","reason","params_differ"}` | As the `info` line, but the request's mapped parameters differ from the run's (`"params_differ":true`); its values were not used. Added after version 0.46.0.                                       |
| `warn`  | `webhook: deduplicated {"path","run_id","run_phase","reason"}`                 | A request's event ID belongs to a run whose agent failed to start (`reason`: `matched_spawn_failed_run`); the reply is that first `500` again, and nothing was started. Added after version 0.46.0. |
| `error` | `webhook: run creation failed {"path","error"}`                                | The run could not be created. The reply is `500`.                                                                                                                                                   |
| `error` | `webhook: spawn failed {"path","run_id","cwd","error"}`                        | The driver could not be started; the run is ended as failed. `cwd` is the workflow's folder as a full path (added after version 0.46.0); `error` is explained below.                                |
| `error` | `webhook: agent process error {"run_id","cwd","error"}`                        | Node reported an error on a driver's process after it started; not expected (see below). `realm listen` goes on serving. Added after version 0.46.0.                                                |
| `error` | `listen: sweeper failed to enact an expired gate {…}`                          | A gate could not be carried out.                                                                                                                                                                    |

In `webhook: spawn failed`, `error` is Node's: it may name the Node program, never the folder. Read it with `cwd`: `ENOENT`, the folder is missing (if it exists, the Node program itself is gone: restart `realm listen`); `EACCES`, `realm listen` may not enter it (if it can, the Node program cannot be run); `ENOTDIR`, it is not a folder; `EAGAIN`, the system would start no more processes; `EMFILE` or `ENFILE`, too many files are open.

`webhook: agent process error` is not expected: Node reports an error on a started process only when signalling or messaging it fails, and `realm listen` does neither. A driver that exits with an error, or is killed, is not logged by `realm listen`; its own output appears in `realm listen`'s output.

With `--log-level error`, a normal start prints nothing.

## How it stops

On Ctrl+C or a `SIGTERM`, `realm listen` logs `listen: shutting down {"reason":"SIGTERM"}`, stops accepting requests, and exits with code 0. Runs it has started are driven by their own processes and are not stopped.

## Exit codes

| Code | When                                   |
| ---- | -------------------------------------- |
| 0    | It was stopped by Ctrl+C or `SIGTERM`. |
| 1    | It could not start.                    |

It does not start in these cases:

| Case                                                          | Message                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No workflow has a `trigger`                                   | `Error: no workflows with a trigger: block to mount.`                                                                                                                                                                                                                                                                                                                                       |
| A workflow file is missing or refused                         | `Error: failed to load workflow 'nowhere/workflow.yaml': Failed to read workflow file: ENOENT: …`                                                                                                                                                                                                                                                                                           |
| Two workflows have the same address                           | `Error: listen: path collision on '/open' — workflow 'dup' conflicts with 'open'`                                                                                                                                                                                                                                                                                                           |
| A secret's variable is not set                                | `Error: listen: workflow 'shared' references secret env var 'WH_SECRET' which is not set`                                                                                                                                                                                                                                                                                                   |
| A workflow's code files cannot be loaded                      | `Error: listen startup failed: …`                                                                                                                                                                                                                                                                                                                                                           |
| The port is in use                                            | `Error: listen EADDRINUSE: address already in use 127.0.0.1:4973`, inside an error trace                                                                                                                                                                                                                                                                                                    |
| `--llm-timeout` is not a whole number above 0                 | `error: option '--llm-timeout <seconds>' argument '0' is invalid. --llm-timeout must be a positive integer number of seconds.`                                                                                                                                                                                                                                                              |
| No `--model`, with `--provider anthropic` (added in 0.46.0)   | `Error: --model is required: realm has no default model, and realm listen starts realm agent --provider anthropic for every run. Name an Anthropic model; Anthropic lists them at https://platform.claude.com/docs/en/models/overview. Nothing was started.`                                                                                                                                |
| No `--model`, with `--provider openai` (added in 0.46.0)      | `Error: --model is required: realm has no default model, and realm listen starts realm agent --provider openai for every run. Name an OpenAI model; OpenAI lists them at https://developers.openai.com/api/docs/models. Nothing was started.`                                                                                                                                               |
| No `--model` and no `--provider` (added in 0.46.0)            | `Error: --model is required: realm has no default model, and realm listen starts realm agent for every run. Each one picks its provider from the API key it finds (OpenAI when both are set; choose one with --provider). Anthropic lists its models at https://platform.claude.com/docs/en/models/overview; OpenAI at https://developers.openai.com/api/docs/models. Nothing was started.` |
| `--provider` is not `openai` or `anthropic` (added in 0.46.0) | `error: option '--provider <provider>' argument 'antropic' is invalid. --provider must be openai or anthropic.`                                                                                                                                                                                                                                                                             |

The other flags are not checked. `--dedup-store` with a value other than `memory` means `file`. `--log-level` with an unknown value logs everything. `--max-concurrent` with a value that is not a number applies no limit.

## See also

- [Webhook trigger](../workflow/webhook-trigger.md)
- [Start runs from webhooks](../../guides/webhooks.md)
- [`realm agent`](realm-agent.md)
- [Deploy a project](../../guides/deploy.md)
