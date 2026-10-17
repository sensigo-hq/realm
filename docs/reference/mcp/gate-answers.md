# Gate answers over MCP

<!-- description: How Realm's MCP server handles the answer to a human gate: the asked, offered and withheld values, the form a chat app shows, present_question, what an answer records, and the separation check. -->

A human gate is a question a run asks a person. This page says who can answer it through Realm's MCP server, and how. Added after version 0.47.0.

## The three values

| Value      | What the agent gets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asked`    | The default. In an app that shows forms, the question goes to the person in the app's own form, and the agent gets no tool that records an answer. In an app without forms, the agent keeps the answer tool, and the app is asked to have the person approve each call. On an HTTP server built per request — `realm serve`, or a program that builds a server per request or passes `statelessHttp` — no client gets forms: under `asked` every client keeps the answer tool, marked for approval. A program that keeps one server per HTTP session sends forms as stdio does. |
| `offered`  | The answer tool, for any client of the server, the agent included.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `withheld` | No tool on the server records an answer, and its replies name no way to answer, except where a workflow's own text does: a gate's `agent_hint`, a gated step's `instructions` and `protocol.rules` are forwarded labelled as the author's, and warned about when the workflow is loaded; other step text and `quick_start` are forwarded as written.                                                                                                                                                                                                                            |

There are three ways to set the value: the `--gate-answers` flag of `realm mcp` and `realm serve`, the `REALM_MCP_GATE_ANSWERS` environment variable, and the `gateAnswers` option of `createRealmMcpServer`. When more than one is set, the most restrictive value wins: `withheld`, then `asked`, then `offered`. A value that is not one of the three stops the server from starting.

Set the value in your MCP client's own config, as an argument (`"args": ["mcp", "--gate-answers", "withheld"]`) or in its `env` block. A variable you export in a shell may not reach a server your client starts (the MCP SDK's client starts servers with a reduced environment).

`realm mcp` and `realm serve` print the value they run with when they start. Under `withheld` they also print how a person answers from a terminal: `realm run inspect <run_id>`, then `realm run respond <run_id> --gate <gate_id> --choice <choice>`.

Another Realm server or CLI that uses the same store can still record answers. The value holds only for the server it is given to.

## The form

Under `asked`, in an app that shows forms, the question is sent to the user's app as a form the first time `start_run`, `execute_step` or `advance_run` reaches it. The form has one field, "Your answer", whose options are the question's choices. Only an accepted form holding one of those choices records an answer. A declined, cancelled or failed form records nothing, and the question keeps waiting.

Realm waits for the form itself. The wait ends at the question's deadline when the gate declares `on_expiry`, or at the end of the call's own time: 240 seconds by default, counted from the start of the call. `--form-wait-seconds` (`REALM_MCP_FORM_WAIT_SECONDS`, the `formWaitSeconds` option) changes it, from 30 to 3600 seconds; when it is set in more than one place, the smallest value wins. The setting is refused at start wherever no form is sent: under `withheld` or `offered`, on `realm serve`, and with `statelessHttp`.

The tool `present_question` sends the form again. It is listed only in a session whose client shows forms, and it can send one question's form three more times in one server process.

The agent never gets an answer call for such a question. Its reply's `next_actions` entry has `awaiting` instead of `instruction`: the question's run, gate, step and choices, with words that say whether a form was sent in this session.

In an app without forms, the answer tool carries `_meta["anthropic/requiresUserInteraction"]`, which asks the app to have the person approve each call. Some apps ask the person, some skip it (Claude Code asked in interactive sessions and refused the call in headless runs when this page was written, October 2026); other apps may not ask. Realm cannot see whether anyone approved. A headless client that declares forms but cancels them leaves the question waiting: set `offered` for such a client.

## What an answer records

Each answer's entry in the run record says how it arrived:

| Field                     | What it holds                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `answer`                  | `{ route, shown? }`: `mcp_form`, `mcp` or `cli`, as its door declared it; `{ absent: 'route_not_declared' }` from a program that declared none. |
| `driven_by`               | The program that recorded it.                                                                                                                   |
| `client_prompt_requested` | `true` when the app was asked to have the person approve the call.                                                                              |
| `principal`               | Who the server's transport authenticated: an API key's id, `realm serve`'s shared token (which names no one), or why there is none.             |

`realm run inspect` prints them on the answer's line, for example:

```text
Answer: approve · answered by (not stated) · through the user's app, as a form (as its door declared), recorded by mcp-stdio, running as ops@server-1 (from the OS user) · token: none passed (a token is passed only by Realm's MCP answer tool, from the conversation that opened the question, or by a program that calls the library with it)
```

An entry written by an earlier version reads `how it arrived was not recorded`.

## The separation check

`realm mcp --check` and `realm serve --check` print the value the server would start with and where it came from, then a separation check, and start nothing. Run it from the agent's own shell: it measures what that login can reach. With `HOME` set to the home of the user that runs Realm, it checks that user's store: a store this login cannot open is measured out of its reach, and one that is not found is not measured. The agent's own app settings are read from the login's own home, never from `HOME`.

Each condition prints as measured, as configured but not enforced by Realm, or as unknown with its cause; the two informational lines print as facts, marked (fact). The check says an agent cannot record a gate answer only when all of these hold: the store belongs to another user; this login cannot write or read the store, become that user without a password, reach the Docker engine, or change the files Realm executes; and `--gate-answers withheld` is given on the `--check` line itself. The claim then names what the check cannot read: that no program Realm runs can run code for the agent, that Realm's server runs the Node binary and Realm package the check ran from, that every Realm server on the machine starts with `--gate-answers withheld`, and, when the store cannot be read, that no registered workflow's extension file can be changed by this login.

Becoming another user without a password is not tested in this version: wherever `sudo`, `doas`, `run0`, `pkexec` or `su` is installed, the check names them as not probed and reads the condition as unknown. A later version of Realm reads their rules without running them.

On a host with any of those programs — every common system — the check therefore prints 'may still be able to answer'. The stronger sentence is reached only where none of them is installed, such as a container image with neither `su` nor `sudo`.
