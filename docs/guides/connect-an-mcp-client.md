# Connect an MCP client

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

## 2. Check what the assistant sees

The assistant now has eleven tools:

| Tool                    | What it does                                                         |
| ----------------------- | -------------------------------------------------------------------- |
| `list_workflows`        | Lists the registered workflows.                                      |
| `get_workflow_protocol` | Returns the briefing for one workflow: its steps, schemas and rules. |
| `start_run`             | Starts a run.                                                        |
| `start_run_batch`       | Starts several runs of one workflow at once.                         |
| `execute_step`          | Submits the answer to an agent step, or runs an automatic step.      |
| `advance_run`           | Runs the guards and automatic steps a run owes (when named).         |
| `submit_human_response` | Records a person's answer to a gate.                                 |
| `get_run_state`         | Returns where a run stands and what to do next.                      |
| `abandon_run`           | Ends a run that should not continue.                                 |
| `create_workflow`       | Lets the assistant define a small workflow of its own and start it.  |
| `append_trace`          | Lets the assistant record notes while it works on a step.            |

Ask the assistant to list the Realm workflows. With one workflow registered, `list_workflows` returns:

```json
{
  "status": "ok",
  "workflows": [{ "id": "article", "name": "Write a short article", "version": 1 }],
  "unreadable": [],
  "warnings": [],
  "hint": "Call get_workflow_protocol with a workflow_id before calling start_run. If no workflow matches your task, use create_workflow to define and start your own plan."
}
```

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

When the run reaches a gate, the reply has `status: confirm_required`, the text to show you, and the choices. The briefing instructs the assistant to show you that text, wait for your choice, and pass it on with `submit_human_response`.

The assistant answers by copying the call in `next_actions[0].instruction.call_with` and filling in the choice. That call includes the `claim_token` of the reply that opened the gate, which shows the answer comes from the conversation that opened it. It is never required.

Realm records the choice it is given. It does not check that you made it. If the assistant must not be able to approve its own work, see [Human gates and trust levels](../concepts/gates-and-trust.md#who-can-answer).

After a gate is answered, a guard step that the answer makes ready is decided in the same call, and the reply names it in `guards`. The `auto` steps that follow do not start by themselves, and the reply does not name them. If the run does not finish, tell the assistant to call `execute_step` for the next step by name.

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

## Workflows that use your own code or secrets

A workflow registered from a project folder remembers that folder. When an assistant runs it, Realm loads the project's `realm.yaml` and its code from there, with nothing more to set up.

## If you see something else

- **`Error: REALM_SERVE_TOKEN is not set.`** `realm serve` refuses to start without a token. Set `REALM_SERVE_TOKEN`, or use `--dev` on your own machine.
- **The assistant says it has no Realm tools.** The client did not start `realm mcp`. Check that `realm` is on the path the client uses, and restart the client.

## See also

- [MCP tools reference](../reference/mcp/tools.md) covers every tool, its arguments and the reply format.
- [`realm mcp` and `realm serve` reference](../reference/cli/realm-mcp-and-serve.md)
- [Who drives a run](../concepts/who-drives-a-run.md) compares an MCP client with the other ways to drive a run.
