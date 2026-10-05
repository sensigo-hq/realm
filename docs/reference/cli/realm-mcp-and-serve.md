# `realm mcp` and `realm serve`

<!-- description: Reference for realm mcp and realm serve, the two ways to start Realm's MCP server: their flags, what each prints, and how each refuses a request. -->

`realm mcp` and `realm serve` start the same MCP server, the one an AI assistant calls to run workflows. They differ in how the assistant reaches it. This page lists the flags of each, what each prints, and how each handles a request it refuses. Every output shown came from a run of the command.

| Command       | The assistant reaches it                           | Started by                               | Who may call it             |
| ------------- | -------------------------------------------------- | ---------------------------------------- | --------------------------- |
| `realm mcp`   | Over the standard input and output of the process. | The assistant's client, on your machine. | The client that started it. |
| `realm serve` | Over HTTP.                                         | You.                                     | Anyone who has the token.   |

Both serve the 11 tools listed in [MCP tools](../mcp/tools.md), for every workflow registered in `~/.realm/workflows/`, and both keep runs in `~/.realm/runs/`. For setting up a client, see [Connect an MCP client](../../guides/connect-an-mcp-client.md).

## `realm mcp`

```text
realm mcp [--project <dir>] [--extensions-module <path>]
```

| Flag                         | Default | What it does                                                                           |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------- |
| `--project <dir>`            | None    | The project whose `realm.yaml` applies to workflows that have no project of their own. |
| `--extensions-module <path>` | None    | Loads this code file in place of the files named by every workflow's `extensions`.     |

`realm mcp` prints nothing of its own. Its standard output carries the MCP messages, so nothing else may be written there. It runs until its input is closed, then exits with code 0.

A client that connects is told the server's name and version:

```json
{ "name": "realm", "version": "0.45.0" }
```

### `--project` has no default

Other commands use the folder they are started in as the project. `realm mcp` does not, because the client chooses that folder: an assistant opened in a folder someone sent you would otherwise make Realm read that folder's `realm.yaml` and load its code. A workflow registered from a folder uses that folder's project whatever `--project` says. See [Deploy a project](../../guides/deploy.md#workflows-that-have-no-project).

### `realm-mcp`

The package `@sensigo/realm-mcp` installs a command `realm-mcp`, which starts the same server with no flags. It loads no project code: a step that needs a handler from a workflow's `extensions` is blocked. `start_run` still creates the run and replies `status: ok`; the block is in its `warnings`:

```text
Step 'fetch' is blocked: its handler 'fetch_record' is not registered in this runner. The run is NOT terminated — the step remains eligible, so a runner that provides this handler can execute it. …
```

The same run started through `realm mcp` ran the step.

## `realm serve`

```text
realm serve [--port <number>] [--host <address>] [--dev] [--project <dir>] [--extensions-module <path>]
```

| Flag                         | Default            | What it does                                                                           |
| ---------------------------- | ------------------ | -------------------------------------------------------------------------------------- |
| `--port <number>`            | `3001`             | The port to listen on.                                                                 |
| `--host <address>`           | `127.0.0.1`        | The address to listen on. The default accepts connections from the same machine only.  |
| `--dev`                      | Off                | Turns the token check off.                                                             |
| `--project <dir>`            | The current folder | The project whose `realm.yaml` applies to workflows that have no project of their own. |
| `--extensions-module <path>` | None               | Loads this code file in place of the files named by every workflow's `extensions`.     |

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
```

With `--dev`:

```text
Warning: Running in dev mode — authentication is disabled. Do not expose this to a network.
Realm MCP server listening on http://127.0.0.1:3001/
```

After these lines, `realm serve` prints nothing for the requests it handles.

### Requests

A caller sends MCP messages as HTTP `POST` requests with the header `Authorization: Bearer <token>`. The path is not checked: every path reaches the server. Each request is handled on its own, and nothing is kept in the process between requests.

`realm serve` serves plain HTTP. To reach it from another machine, put it behind a web server that provides HTTPS.

| Request                        | Reply                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| No token, or a wrong one       | `401` `{"error":"Unauthorized"}`, with the header `WWW-Authenticate: Bearer`                                                 |
| A body that is not JSON        | `400` `{"error":"Invalid JSON in request body"}`                                                                             |
| A body larger than 1 MiB       | `413` `{"error":"Request body too large"}`                                                                                   |
| No `Accept: text/event-stream` | `406` `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Not Acceptable: Client must accept text/event-stream"},"id":null}` |
| An MCP message                 | `200`, with the MCP reply                                                                                                    |

The token is checked before anything else, so a caller without it learns nothing about the request.

### Stopping and exit codes

On Ctrl+C or a `SIGTERM`, `realm serve` stops accepting connections and exits with code 0.

| Code | When                                   |
| ---- | -------------------------------------- |
| 0    | It was stopped by Ctrl+C or `SIGTERM`. |
| 1    | It could not start.                    |

It does not start in these cases:

| Case                                | Message                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| No token, and the token check is on | `Error: REALM_SERVE_TOKEN is not set.` then `Set it to a secret token, or use --dev / REALM_DEV=1 for local development only.` |
| The port is in use                  | `Error: listen EADDRINUSE: address already in use 127.0.0.1:3001`, inside an error trace                                       |

### A store or registry from another realm version

`createRealmMcpServer` refuses a store that declares no realm release line (`ENGINE_RELEASE_LINE_UNDECLARED`) or belongs to another realm version (`ENGINE_RELEASE_LINE_MISMATCH`). `realm serve` builds one server before it listens: when that is refused it prints one line to stderr and exits with code 1, and nothing listens; with `--dev`, its dev-mode warning prints first. `realm mcp` prints one line to stderr and exits with code 1, with nothing on stdout. These two commands hand the server only the workflow store they build themselves, so a release-line refusal there means the command's own packages are at different versions, and the line says so (here, a global install whose realm-mcp carries its own `@sensigo/realm` 0.45.9):

```text
realm serve: this realm command's own packages disagree: its realm-mcp runs @sensigo/realm 0.45.9 (/usr/lib/node_modules/@sensigo/realm-cli/node_modules/@sensigo/realm-mcp/node_modules/@sensigo/realm) and was handed a workflow store from @sensigo/realm 0.45.0 (/usr/lib/node_modules/@sensigo/realm-cli/node_modules/@sensigo/realm). Reinstall @sensigo/realm-cli so every @sensigo package it installs is one version (npm ls -g @sensigo/realm lists the copies of a global install; npm ls @sensigo/realm in a project).
```

`realm mcp` prints the same line beginning `realm mcp:`. Any other error that stops the server from being built is printed as `realm serve: <message>` or `realm mcp: <message>`. A registry is also checked when a tool resolves it for a call: a registry from another realm version that the server's registry provider returned is refused in that tool's reply, with `error_code` `ENGINE_RELEASE_LINE_MISMATCH` and a message that begins `The registry the server's registry provider returned for start_run` (or `start_run_batch`, `execute_step`, `submit_human_response`). Any other error while a request is handled is logged as `realm serve: <message>` and the request is answered with `500`; the server keeps running. A program that builds the server itself must catch the refusal: an `http` request handler that throws ends the process. When the `@sensigo/realm` the workflow's code imports is not the version the command runs, both commands print [`REALM_RELEASE_LINE_MISMATCH`](../workflow/loader-diagnostics.md#warning-codes) to stderr once per copy and go on. This was added after version 0.45.0.

## What both read when a tool is called

- **Workflows** are read from `~/.realm/workflows/` at each call. A workflow registered while the server runs is available at once.
- **Project code** is loaded the first time a workflow needs it and kept for the life of the process. After you change a handler or an adapter, restart `realm serve`, or reconnect the client so that it starts `realm mcp` again.

## The `realm` command itself

```text
realm [--version] [--help] <command>
```

`realm --version` prints the installed version, such as `0.45.0`. `realm --help`, and `--help` after any command, print that command's flags. `realm` has six commands: `workflow`, `run`, `agent`, `listen`, `mcp` and `serve`. A seventh name, `webhook`, is kept only to say that it was removed:

```text
`realm webhook` has been removed. Use `realm listen` with a `trigger:` block (auth.mode: github + a params_map for the PR fields) in your workflow instead. See `realm listen --help`.
```

## See also

- [Connect an MCP client](../../guides/connect-an-mcp-client.md)
- [MCP tools](../mcp/tools.md)
- [Deploy a project](../../guides/deploy.md)
- [`realm workflow`](realm-workflow.md), [`realm run`: commands that read](realm-run-reading.md), [`realm run`: commands that act](realm-run-acting.md), [`realm agent`](realm-agent.md), [`realm listen`](realm-listen.md)
