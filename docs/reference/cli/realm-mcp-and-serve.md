# `realm mcp` and `realm serve`

<!-- description: Reference for realm mcp and realm serve, the two ways to start Realm's MCP server: their flags, what each prints, and how each refuses a request. -->

`realm mcp` and `realm serve` start the same MCP server, the one an AI assistant calls to run workflows. They differ in how the assistant reaches it. This page lists the flags of each, what each prints, and how each handles a request it refuses. Every output shown came from a run of the command.

| Command       | The assistant reaches it                           | Started by                               | Who may call it             |
| ------------- | -------------------------------------------------- | ---------------------------------------- | --------------------------- |
| `realm mcp`   | Over the standard input and output of the process. | The assistant's client, on your machine. | The client that started it. |
| `realm serve` | Over HTTP.                                         | You.                                     | Anyone who has the token.   |

Both serve the 11 tools listed in [MCP tools](../mcp/tools.md) (`advance_run` was added after version 0.46.0, which serves 10), for every workflow registered in the Realm home's store, and both keep runs there (`~/.realm/realm.db`). Which answer tool is among them follows the server's gate-answers value and the client: `submit_human_response` under `offered` and under `asked` with a client that shows no forms, `present_question` under `asked` with a forms client of `realm mcp` (never on `realm serve`, which sends no forms), and neither under `withheld`, which serves 10. See [Gate answers over MCP](../mcp/gate-answers.md). Added after version 0.47.0. For setting up a client, see [Connect an MCP client](../../guides/connect-an-mcp-client.md).

## `realm mcp`

```text
realm mcp [--project <dir>] [--extensions-module <path>] [--gate-answers <value>] [--form-wait-seconds <seconds>] [--check]
```

| Flag                            | Default | What it does                                                                                                                                                                                                             |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--project <dir>`               | None    | The project whose `realm.yaml` applies to workflows that have no project of their own.                                                                                                                                   |
| `--extensions-module <path>`    | None    | Loads this code file in place of the files named by every workflow's `extensions`.                                                                                                                                       |
| `--gate-answers <value>`        | `asked` | How the server handles gate answers: `asked`, `offered` or `withheld`. With `REALM_MCP_GATE_ANSWERS` also set, the most restrictive wins. Added after version 0.47.0.                                                    |
| `--form-wait-seconds <seconds>` | `240`   | The longest a form waits for the person, from 30 to 3600. With `REALM_MCP_FORM_WAIT_SECONDS` also set, the smaller wins. Refused at start under `withheld` or `offered`, which send no form. Added after version 0.47.0. |
| `--check`                       | Off     | Prints the gate-answers value the server would start with and the separation check, then exits without starting. Added after version 0.47.0.                                                                             |

`--project` and `--extensions-module` refuse a value that starts with `-`, except a lone `-`; write `--option=value` for one.

When it starts, `realm mcp` prints one line to standard error: the gate-answers value it runs with, where it came from, and what that means (added after version 0.47.0, which printed nothing). Its standard output carries the MCP messages, so nothing else may be written there. It runs until its input is closed, then exits with code 0. A gate-answers or form-wait value that is not valid stops it before it starts, with one line on standard error and exit code 1.

A client that connects is told the server's name and version:

```json
{ "name": "realm", "version": "0.49.0" }
```

### `--project` has no default

Other commands use the folder they are started in as the project. `realm mcp` does not, because the client chooses that folder: an assistant opened in a folder someone sent you would otherwise make Realm read that folder's `realm.yaml` and load its code. A workflow registered from a folder uses that folder's project whatever `--project` says. See [Deploy a project](../../guides/deploy.md#workflows-that-have-no-project).

### `realm-mcp`

The package `@sensigo/realm-mcp` installs a command `realm-mcp`, which starts the same server. It opens `~/.realm` itself, the same home every `realm` command uses. It takes no flags and refuses any; it reads `REALM_MCP_GATE_ANSWERS` and `REALM_MCP_FORM_WAIT_SECONDS`, and prints its start line on stderr. It loads no project code: a step that needs a handler from a workflow's `extensions` is blocked. `start_run` still creates the run and replies `status: ok`; the block is in its `warnings` (added after version 0.46.0, which replies `status: error`):

```text
Step 'fetch' is blocked: its handler 'fetch_record' is not registered in this runner. The run is NOT terminated — the step remains eligible, so a runner that provides this handler can execute it. …
```

The same run started through `realm mcp` ran the step.

`realm-mcp` reads no `realm.yaml`, so `get_run_state` prices model calls from the installed price list only, and every figure says `no economics file is configured on this server`. `realm mcp` and `realm serve` price from the project's [economics file](../cache-economics.md) first. Added after version 0.47.0.

## `realm serve`

```text
realm serve [--port <number>] [--host <address>] [--shutdown-grace <seconds>] [--shutdown-drain <seconds>] [--dev] [--project <dir>] [--extensions-module <path>] [--gate-answers <value>] [--check]
```

| Flag                         | Default            | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--port <number>`            | `3001`             | The port to listen on: a whole number from 0 to 65535; 0 lets the system pick, and the start line prints the port it picked. Added after version 0.48.0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--host <address>`           | `127.0.0.1`        | The address to listen on. The default accepts connections from the same machine only. An IP address or a host name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--shutdown-grace <seconds>` | `30`               | How long requests that are being answered get to finish after Ctrl+C or `SIGTERM`: a whole number of seconds from 0 to 2147483. When it runs out, the requests still open are cut and the exit code is 1. 0 cuts them at once. A program that stops `realm serve` on a shorter limit than `--shutdown-drain` plus `--shutdown-grace` ends it first, with `SIGKILL` and no line printed: give it a longer one. systemd waits 90 seconds by default (`TimeoutStopSec=` in the unit sets it). `docker stop` waits for the container's `--stop-timeout` (`docker run --stop-timeout <seconds>`, or `docker stop -t <seconds>`); without one it waits the Docker daemon's default, which Docker's documentation gives as 10 seconds and the daemon's `default-stop-timeout` option can change. Added after version 0.49.0. |
| `--shutdown-drain <seconds>` | `0`                | How long, after Ctrl+C or `SIGTERM`, the program keeps accepting connections and answering requests while `/health` answers 503, before the stop described below begins: a whole number of seconds from 0 to 2147483. 0, the default, begins it at once. Added after version 0.49.0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--dev`                      | Off                | Turns the token check off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--project <dir>`            | The current folder | The project whose `realm.yaml` applies to workflows that have no project of their own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--extensions-module <path>` | None               | Loads this code file in place of the files named by every workflow's `extensions`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--gate-answers <value>`     | `asked`            | As for `realm mcp`. Added after version 0.47.0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--check`                    | Off                | As for `realm mcp`. Added after version 0.47.0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

`--project` and `--extensions-module` refuse a value that starts with `-`, except a lone `-`; write `--option=value` for one.

`realm serve` sends no forms, so `--form-wait-seconds`, or `REALM_MCP_FORM_WAIT_SECONDS`, stops it from starting, as it stops `realm mcp` under `withheld` or `offered`: the setting is refused at start wherever no form is sent. Added after version 0.47.0.

| Environment variable | What it does                                                          |
| -------------------- | --------------------------------------------------------------------- |
| `REALM_SERVE_TOKEN`  | The token a caller must send. Required unless the token check is off. |
| `REALM_DEV`          | Set to `1`, has the same effect as `--dev`.                           |

```bash
REALM_SERVE_TOKEN=choose-a-long-secret realm serve --port 3001
```

```text
Realm MCP server listening on http://127.0.0.1:3001/
Authentication: Bearer token (REALM_SERVE_TOKEN)
Gate answers over MCP: asked (the default). On this server no chat app gets forms: under asked every client keeps the answer tool, and the app is asked to have the person approve each call; some apps and settings skip that. To keep the agent from answering in every app, set --gate-answers withheld. To answer from a terminal: realm run inspect <run_id>, then realm run respond <run_id> --gate <gate_id> --choice <choice>.
```

With `--dev`:

```text
Warning: Running in dev mode — authentication is disabled. Do not expose this to a network.
Realm MCP server listening on http://127.0.0.1:3001/
```

After these lines, `realm serve` prints the gate-answers value it runs with, and, in dev mode when that value is not `withheld`, `Warning: dev mode — authentication is disabled: any process on this machine can call this server's tools, the gate answer tool included.` (added after version 0.47.0). Then it prints nothing for the requests it handles.

### Requests

A caller sends MCP messages as HTTP `POST` requests with the header `Authorization: Bearer <token>`. Apart from `GET` and `HEAD` to `/health` (added after version 0.49.0; see [The health address](#the-health-address)), the path is not checked: every path reaches the server. Each request is handled on its own, and nothing is kept in the process between requests.

`realm serve` serves plain HTTP. To reach it from another machine, put it behind a web server that provides HTTPS.

| Request                                                                               | Reply                                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No token, or a wrong one                                                              | `401` `{"error":"Unauthorized"}`, with the header `WWW-Authenticate: Bearer`                                                                                               |
| A body that is not JSON                                                               | `400` `{"error":"Invalid JSON in request body"}`                                                                                                                           |
| A body larger than 1 MiB                                                              | `413` `{"error":"Request body too large"}`                                                                                                                                 |
| An `Accept` header that does not list both `application/json` and `text/event-stream` | `406` `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Not Acceptable: Client must accept both application/json and text/event-stream"},"id":null}`                     |
| A batch of more than 100 MCP messages                                                 | `400` `{"jsonrpc":"2.0","error":{"code":-32600,"message":"Invalid Request: Batch must not exceed 100 messages"},"id":null}` (added after version 0.46.0, which answers it) |
| An MCP message                                                                        | `200`, with the MCP reply                                                                                                                                                  |

The token is checked before anything else except the health address (added after version 0.49.0), so a caller without it learns nothing about the request.

### The health address

`GET` and `HEAD` requests to `/health` are answered without a token or a signature, so a load balancer or a monitor can ask whether the program is accepting connections: `200` with `{"status":"ok"}`. From the moment it is asked to stop (Ctrl+C or `SIGTERM`) it answers `503` with `{"status":"shutting_down"}` and `Connection: close`. The body says nothing else. With the default `--shutdown-drain 0` the program stops accepting connections at once, so a poller usually sees a refused connection, not the `503`; set `--shutdown-drain` for the `503` to be seen. The address tells you the program is running and not stopping; it does not look at the store, so it does not tell you that a request would succeed. Do not use it as a check that restarts the program: it fails on purpose while the program stops. This section was added after version 0.49.0.

After version 0.49.0, `GET` and `HEAD` requests to `/health` no longer reach the MCP endpoint; a client that used that path as its address must use another.

### Stopping and exit codes

From Ctrl+C or `SIGTERM`, `/health` answers `503`; the program keeps accepting connections until `--shutdown-drain` has ended, and the stop below begins then. When the stop begins, `realm serve` stops accepting requests. A connection that is waiting between requests is closed at once. A connection that has not sent a request yet is given up to 5 seconds from the moment it connected, and a request that arrives on it in that time is answered. Requests being answered get `--shutdown-grace` seconds (30 by default) to finish; each answer written from then on says `Connection: close`, and a connection is closed once its answer is finished. A stream that a client opened only to wait for the server's messages (an MCP client's `GET` stream) is closed at once; that is not a cut request. A second Ctrl+C or `SIGTERM` ends everything still open at once.

After Ctrl+C or `SIGTERM`, `/health` answers `503` at once. With `--shutdown-drain N` the program then goes on accepting connections and answering every other request as usual for N seconds, so that a load balancer that checks `/health` sees the `503` and stops sending requests before the program stops accepting them. When N seconds have passed, the stop described above begins. Set N to at least the time the balancer needs to notice: its check interval times the number of failed checks it needs (a balancer that checks every 30 seconds and needs 2 failures: 60). Kubernetes starts taking a stopping pod out of a Service's list at the same moment it starts the pod's shutdown, so a few seconds of drain can also cover the time that takes to reach every router. A second Ctrl+C or `SIGTERM` during the drain ends the drain and the grace at once. The program that stops `realm serve` must wait longer than N plus `--shutdown-grace` seconds.

With `--shutdown-drain` above 0, `realm serve` prints one line to stderr at the first signal. With `--shutdown-drain 3`:

```text
realm serve: --shutdown-drain 3 started. /health answers 503 now; connections are accepted until the drain ends. A second Ctrl+C ends it at once.
```

When it had to cut requests, `realm serve` prints one line to stderr and exits with code 1. With `--shutdown-grace 1` and a request whose body never finished:

```text
realm serve: --shutdown-grace 1 ran out. Requests cut: 1.
```

After a second signal the line is `realm serve: a second signal arrived. Requests cut: 1.`

A request cut while it ran an `auto` step leaves that step taken by `realm serve`: `realm run inspect <run>` shows it in progress, and `realm run list --stuck` does not list the run while that claim is healthy (`realm run reclaim <run>` shows it healthy, with its deadline). `realm run reclaim <run> --step <step> --force` frees it and warns that the step's side effects may repeat; `realm run inspect` then shows the step owed, with the `realm run advance <run>` that runs it again.

Every paragraph above in this section was added or changed after version 0.49.0.

| Code | When                                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | It was stopped by Ctrl+C or `SIGTERM` and cut no request (changed after version 0.49.0).                                                       |
| 1    | It could not start, or it was stopped and had to cut requests that were still being answered (the second case was added after version 0.49.0). |

It does not start in these cases:

| Case                                                                                                      | Message                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No token, and the token check is on                                                                       | `Error: REALM_SERVE_TOKEN is not set.` then `Set it to a secret token, or use --dev / REALM_DEV=1 for local development only.`                                                |
| The port is in use (changed after version 0.48.0)                                                         | `Error: cannot listen on 127.0.0.1:3001: the port is already in use. Stop the program using it, or choose another --port.`                                                    |
| `--port` is not a whole number from 0 to 65535 (added after version 0.48.0)                               | `error: option '--port <number>' argument 'abc' is invalid. --port must be a whole number from 0 to 65535.`                                                                   |
| `--host` is empty, holds a space or starts with `-` (added after version 0.48.0)                          | `error: option '--host <address>' argument 'a b' is invalid. --host must be an IP address or a host name.`                                                                    |
| `--shutdown-grace` is not a whole number from 0 to 2147483 (added after version 0.49.0)                   | `error: option '--shutdown-grace <seconds>' argument '-1' is invalid. --shutdown-grace must be a whole number from 0 to 2147483.`                                             |
| `--shutdown-drain` is not a whole number from 0 to 2147483 (added after version 0.49.0)                   | `error: option '--shutdown-drain <seconds>' argument '-1' is invalid. --shutdown-drain must be a whole number from 0 to 2147483.`                                             |
| The port needs rights `realm serve` does not have, or the system reserves it (added after version 0.48.0) | `Error: cannot listen on 127.0.0.1:80: permission denied. A port below 1024 usually needs extra rights, and on Windows the system can reserve a port. Choose another --port.` |
| `--host` is not an address of this machine (added after version 0.48.0)                                   | `Error: cannot listen on 192.0.2.1:3001: 192.0.2.1 is not an address of this machine. Check --host.`                                                                          |
| `--host` is a name that cannot be resolved (added after version 0.48.0)                                   | `Error: cannot listen on no-such-host.invalid:3001: the name no-such-host.invalid cannot be resolved. Check --host.`                                                          |

### A store or registry from another realm version

`createRealmMcpServer` refuses a store that declares no realm release line (`ENGINE_RELEASE_LINE_UNDECLARED`) or belongs to another realm version (`ENGINE_RELEASE_LINE_MISMATCH`). `realm serve` builds one server before it listens: when that is refused it prints one line to stderr and exits with code 1, and nothing listens; with `--dev`, its dev-mode warning prints first. `realm mcp` prints one line to stderr and exits with code 1, with nothing on stdout. These two commands hand the server only stores they build themselves, so a release-line refusal there means the command's own packages are at different versions, and the line says so (here, a global install of 0.46.0 whose realm-mcp carries its own `@sensigo/realm`, a copy of 0.46.0 given the version number 0.46.1 for this example; realm's packages pin each other to one exact version, so npm does not install such a mix by itself, and this one was put together by hand):

```text
realm serve: this realm command's own packages disagree: its realm-mcp runs @sensigo/realm 0.46.1 (/usr/lib/node_modules/@sensigo/realm-cli/node_modules/@sensigo/realm-mcp/node_modules/@sensigo/realm) and was handed a workflow store from @sensigo/realm 0.46.0 (/usr/lib/node_modules/@sensigo/realm-cli/node_modules/@sensigo/realm). Reinstall @sensigo/realm-cli so every @sensigo package it installs is one version (npm ls -g @sensigo/realm lists the copies of a global install; npm ls @sensigo/realm in a project).
```

`realm mcp` prints the same line beginning `realm mcp:`. Any other error that stops the server from being built is printed as `realm serve: <message>` or `realm mcp: <message>`. A registry is also checked when a tool resolves it for a call: a registry from another realm version that the server's registry provider returned is refused in that tool's reply, with `error_code` `ENGINE_RELEASE_LINE_MISMATCH` and a message that begins `The registry the server's registry provider returned for start_run` (or `start_run_batch`, `execute_step`, `submit_human_response`, `get_run_state`, `advance_run`). Any other error while a request is handled is logged as `realm serve: <message>` and the request is answered with `500`; the server keeps running. A program that builds the server itself must catch the refusal: an `http` request handler that throws ends the process. When the `@sensigo/realm` the workflow's code imports is not the version the command runs, both commands print [`REALM_RELEASE_LINE_MISMATCH`](../workflow/loader-diagnostics.md#warning-codes) to stderr once per copy and go on. This was added in 0.46.0.

## What both read when a tool is called

- **Workflows** are read from the store at each call. A workflow registered while the server runs is available at once.
- **Project code** is loaded the first time a workflow needs it and kept for the life of the process. After you change a handler or an adapter, restart `realm serve`, or reconnect the client so that it starts `realm mcp` again.

## The `realm` command itself

```text
realm [--version] [--help] <command>
```

`realm --version` prints the installed version, such as `0.46.0`. `realm --help`, and `--help` after any command, print that command's flags. `realm` has seven commands: `workflow`, `run`, `db`, `agent`, `listen`, `mcp` and `serve`. A seventh name, `webhook`, is kept only to say that it was removed:

```text
`realm webhook` has been removed. Use `realm listen` with a `trigger:` block (auth.mode: github + a params_map for the PR fields) in your workflow instead. See `realm listen --help`.
```

## See also

- [Connect an MCP client](../../guides/connect-an-mcp-client.md)
- [MCP tools](../mcp/tools.md)
- [Deploy a project](../../guides/deploy.md)
- [`realm workflow`](realm-workflow.md), [`realm run`: commands that read](realm-run-reading.md), [`realm run`: commands that act](realm-run-acting.md), [`realm db`](realm-db.md), [`realm agent`](realm-agent.md), [`realm listen`](realm-listen.md)
