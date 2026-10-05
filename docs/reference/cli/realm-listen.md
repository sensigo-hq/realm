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

| Kind     | IDs are kept                                              | After a restart                                            |
| -------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| `file`   | In `~/.realm/dedup/<workflow-id>/`, one file for each ID. | An event seen before the restart is still recognised.      |
| `memory` | In the process.                                           | Every event is new: the same request started a second run. |

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

Workflows are read once. After you change a workflow file, restart `realm listen`.

When a workflow's code imports a `@sensigo/realm` of another version than the command's, `realm listen` prints the [`REALM_RELEASE_LINE_MISMATCH`](../workflow/loader-diagnostics.md#warning-codes) warning once per copy on stderr at startup (it is not a `listen: <event>` line); the `realm agent` it starts for each request does not repeat it. This was added in 0.46.0.

## What it does for a request

For a request that passes every check, `realm listen` creates the run, starts `realm agent --run-id <run-id> --model <model>` (with `--provider <provider>` when `realm listen` was given one) as a separate process in the workflow's folder, and replies `202`. It does not wait for the run.

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

| Level   | Line                                                       | Logged when                                                           |
| ------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `info`  | `listen: mounted {"workflow","path","mode"}`               | A workflow is mounted.                                                |
| `info`  | `listen: workflow has no trigger block — not mounted`      | A workflow given on the command line has no `trigger`.                |
| `info`  | `listen: extensions loaded {…}`                            | A mounted workflow's code files were loaded.                          |
| `info`  | `realm listen on <host>:<port> — N workflow(s) mounted`    | The server is ready.                                                  |
| `info`  | `webhook: dispatched {"path","run_id","pid"}`              | A run was created and its driver started.                             |
| `info`  | `webhook: rejected params_invalid — <reason>`              | A request's values did not fit `params_schema`.                       |
| `info`  | `listen: sweeper enacted an expired gate {…}`              | `--sweep-expired-gates` carried out a gate.                           |
| `info`  | `listen: shutting down {"reason"}`                         | A stop signal arrived.                                                |
| `debug` | `webhook: filtered out {"path"}`                           | A request did not match the `filter`.                                 |
| `debug` | `webhook: deduplicated {"path"}`                           | A request repeated an event already seen.                             |
| `warn`  | `listen: workflow '<id>' uses auth.mode 'none' — …`        | A mounted workflow does not check its requests.                       |
| `warn`  | `listen: binding to non-loopback host '<addr>' — …`        | `--host` is not the machine's own address.                            |
| `warn`  | `webhook: verification failed {"path","mode"}`             | A request failed the `auth` check.                                    |
| `warn`  | `webhook: duplicated security header {"path","header"}`    | A request carried the signature or secret header more than once.      |
| `warn`  | `webhook: dedup id unresolvable, proceeding without dedup` | The event's ID was not in the request, and `on_missing_id` is `skip`. |
| `error` | `webhook: run creation failed {"path","error"}`            | The run could not be created. The reply is `500`.                     |
| `error` | `webhook: spawn failed {…}`                                | The driver could not be started. The run is ended as failed.          |
| `error` | `listen: sweeper failed to enact an expired gate {…}`      | A gate could not be carried out.                                      |

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
