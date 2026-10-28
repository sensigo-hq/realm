# Connect an MCP client

<!-- description: Connect an AI assistant to Realm's MCP server so that it can run your workflows and is held to their rules, and see the calls it makes to drive a run. -->

This guide connects an AI assistant to Realm, so that the assistant can run your workflows and is held to their rules. At the end, the assistant sees Realm's tools, and you know the calls it makes to drive a run.

Realm speaks the Model Context Protocol (MCP). Any assistant that can use MCP servers can connect: Claude Code, Claude Desktop, Cursor, or your own program.

## Before you start

You need the `realm` command installed and at least one registered workflow. See [Install and first run](../start/install-and-first-run.md).

## 1. Add Realm to the assistant

An assistant starts an MCP server by running a command. For Realm the command is `realm mcp`. In clients that are configured with a JSON file, add this entry:

```json
{
  "mcpServers": {
    "realm": {
      "command": "realm",
      "args": ["mcp"]
    }
  }
}
```

In Claude Code, add it from the terminal:

```bash
claude mcp add realm -- realm mcp
```

Restart the assistant, or reload its MCP servers.

To choose how gate answers are handled, put the flag in the same config. For example, to keep every assistant from answering a gate:

```json
{
  "mcpServers": {
    "realm": {
      "command": "realm",
      "args": ["mcp", "--gate-answers", "withheld"]
    }
  }
}
```

```bash
claude mcp add realm -- realm mcp --gate-answers withheld
```

Set it here, or in the entry's `env` block as `REALM_MCP_GATE_ANSWERS`: a variable you export in a shell may not reach a server the assistant starts (the MCP SDK's client starts servers with a reduced environment). The default, `asked`, sends each question to the person as a form in an app that shows forms. See [Gate answers over MCP](../reference/mcp/gate-answers.md). Added after version 0.47.0.

## 2. Check what the assistant sees

The assistant now has ten tools under `withheld` (the value step 1's example sets); eleven under `asked` or `offered` (`advance_run` was added after version 0.46.0, which has ten). The table lists the eleven:

| Tool                    | What it does                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `list_workflows`        | Lists the registered workflows.                                                                |
| `get_workflow_protocol` | Returns the briefing for one workflow: its steps, schemas and rules.                           |
| `start_run`             | Starts a run.                                                                                  |
| `start_run_batch`       | Starts several runs of one workflow at once.                                                   |
| `execute_step`          | Submits the answer to an agent step. An automatic step is the engine's: `advance_run` runs it. |
| `advance_run`           | Runs the guards and automatic steps a run owes (when named).                                   |
| `submit_human_response` | Records a person's answer to a gate.                                                           |
| `get_run_state`         | Returns where a run stands and what to do next.                                                |
| `abandon_run`           | Ends a run that should not continue.                                                           |
| `create_workflow`       | Lets the assistant define a small workflow of its own and start it.                            |
| `append_trace`          | Lets the assistant record notes while it works on a step.                                      |

In an app that shows forms, under the default `asked`, `present_question` takes the place of `submit_human_response`; under `withheld` neither is listed (added after version 0.47.0).

Ask the assistant to list the Realm workflows. With one workflow registered, `list_workflows` returns:

```json
{
  "status": "ok",
  "workflows": [{ "id": "article", "name": "Write a short article", "version": 1 }],
  "unreadable": [],
  "warnings": [],
  "hint": "Call get_workflow_protocol with a workflow_id before calling start_run. If no workflow matches your task, use create_workflow to define and start your own plan.",
  "disclosure": {
    "declared": "resolved",
    "environment": "swept",
    "hidden": { "declared": 0, "environment": 0, "pattern": 0 },
    "unchecked": 0,
    "unmaskable": 0,
    "too_deep": 0
  }
}
```

Every reply in JSON ends with `disclosure`: what Realm hid from the reply before the assistant read it. `declared` says whether Realm knew the secrets declared by the deployment manifest of the project the reply is about: `resolved`, as here, where the workflow's project has no `realm.yaml` and so declares none; `partial`, with `declared_cause: manifest_changed`, when the run's manifest no longer refers to a secret the run recorded, or its `secrets` block changed since the run recorded it; or `unknown`, with `declared_cause: load_failed` when the manifest or a secret it names could not be read, or `no_manifest` when the workflow has no project. A reply about several workflows, such as `list_workflows`, gives the weakest of theirs. `environment: swept` says the server's environment variables were checked; `hidden` counts what was replaced with `[REDACTED]`, by kind; `too_deep` counts the values shown as their type and size because they lie more than 64 levels deep. When a reply shows a gate's question, `question: declared_only` says the question hides only the declared secrets. When Realm cannot read the declared secrets, because the manifest cannot be read (`load_failed`) or changed since the run recorded it (`manifest_changed`), the reply shows its values as their type and size and its question as `withheld (…)`, and says `values: withheld` and `question: withheld`.

Notice that only registered workflows appear. If yours is missing, run `realm workflow register` on it.

## 3. Ask the assistant to run a workflow

Tell the assistant which workflow to run and give it the inputs, for example: "Run the article workflow in Realm on the topic human gates." The assistant then makes these calls:

1. `get_workflow_protocol` reads the briefing for the workflow.
2. `start_run` starts the run. Realm runs any automatic steps that come first, and replies with the first agent step: its task and the schema its answer must fit.
3. `execute_step` submits the answer. Realm accepts it and names the next step, or refuses it and says why.
4. The assistant repeats step 3 until the reply has nothing left to do.

Every reply carries `next_actions`, which names the next call to make. An assistant that follows `next_actions` stays on the workflow's path.

When an answer is refused, the reply says what was wrong and tells the assistant to try again:

```text
status: error
error_code: VALIDATION_INPUT_SCHEMA
/category must be equal to one of the allowed values
agent_action: provide_input
```

## 4. What happens at a human gate

When the run reaches a gate, the reply has `status: confirm_required`, the text to show you, and the choices. What happens next follows the server's [gate-answers value](../reference/mcp/gate-answers.md):

- Under the default `asked`, an app that shows forms asks you in its own form, and the assistant gets no tool that records an answer. An app that shows no forms keeps `submit_human_response`, and the app is asked to have you approve each call; some apps and settings skip that.
- Under `offered`, the briefing instructs the assistant to show you that text, wait for your choice, and pass it on with `submit_human_response`.
- Under `withheld`, you answer from a terminal: `realm run inspect <run_id>`, then `realm run respond <run_id> --gate <gate_id> --choice <choice>`.

Where it has the answer tool, the assistant answers by copying the call in `next_actions[0].instruction.call_with` and filling in the choice. That call includes the `claim_token` of the reply that opened the gate, which shows the answer comes from the conversation that opened it. It is never required.

Realm records the choice it is given. It does not check that you made it. If the assistant must not be able to approve its own work, see [Human gates and trust levels](../concepts/gates-and-trust.md#who-can-answer).

After a gate is answered, a guard step that the answer makes ready is decided in the same call, and the reply names it in `guards`. The `auto` steps that follow do not start by themselves. The reply names them, `Owed to the engine: '<step>' — call advance_run.`, and its `next_actions` holds `advance_run`, which runs them until a step opens a question, fails or ends the run (with more than one owed, the sentence says so: `… — call advance_run; it runs them until a step opens a question, fails or ends the run.`). If the run does not finish, tell the assistant to call what `next_actions` names: `execute_step` for an agent step, `advance_run` for the engine's.

## Connecting over HTTP

Some platforms cannot start a local command. For those, run Realm as an HTTP server:

```bash
REALM_SERVE_TOKEN=choose-a-long-secret realm serve --port 3001
```

It prints:

```text
Realm MCP server listening on http://127.0.0.1:3001/
Authentication: Bearer token (REALM_SERVE_TOKEN)
```

Point the platform at that address and give it the token as a Bearer token. A request without the token gets `401`.

Three things to know:

- **The token is one shared secret.** Everyone who has it can use every tool. Realm cannot tell callers apart.
- **It listens on this machine only**, unless you set `--host`.
- **`--dev` turns the token check off.** It prints `Warning: Running in dev mode — authentication is disabled. Do not expose this to a network.` Use it only on your own machine.

## Other clients

Codex keeps only the first and the last part of a long tool reply unless that tool's limit is raised: set `mcp_servers.<id>.tools.<tool>.output_token_limit` in its config (checked against Codex's source at 73bdd06f, 2026-10-27). Realm keeps every reply under 40,000 characters (see [The reply](../reference/mcp/tools.md#the-reply)).

## Workflows that use your own code or secrets

A workflow registered from a project folder remembers that folder. When an assistant runs it, Realm loads the project's `realm.yaml` and its code from there, with nothing more to set up.

## If you see something else

- **`Error: REALM_SERVE_TOKEN is not set.`** `realm serve` refuses to start without a token. Set `REALM_SERVE_TOKEN`, or use `--dev` on your own machine.
- **The assistant says it has no Realm tools.** The client did not start `realm mcp`. Check that `realm` is on the path the client uses, and restart the client.

## See also

- [MCP tools reference](../reference/mcp/tools.md) covers every tool, its arguments and the reply format.
- [`realm mcp` and `realm serve` reference](../reference/cli/realm-mcp-and-serve.md)
- [Who drives a run](../concepts/who-drives-a-run.md) compares an MCP client with the other ways to drive a run.
