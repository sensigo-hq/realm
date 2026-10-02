# Who drives a run

A run does not move by itself. Something has to call the engine, hand in each agent step's answer, and call again. That something is the driver. Realm has four, and this page helps you choose one.

## The four drivers

|                               | MCP client                      | `realm agent`                  | `realm listen`                | `realm workflow run`      |
| ----------------------------- | ------------------------------- | ------------------------------ | ----------------------------- | ------------------------- |
| What it is                    | An AI assistant you connect     | A command that runs to the end | A web server that starts runs | A prompt in your terminal |
| Who answers agent steps       | The assistant's own model       | A model that Realm calls       | The `realm agent` it starts   | You, typing JSON          |
| Who pays for the model        | The assistant                   | Your provider key              | Your provider key             | Nobody                    |
| How a run starts              | The assistant calls `start_run` | You run the command            | A webhook request arrives     | You run the command       |
| Where the workflow comes from | The registered copy             | A file you name                | Files you name                | A file you name           |
| Use it for                    | Work inside a chat or an IDE    | Scripts, schedules, CI         | Reacting to outside events    | Trying a workflow by hand |

All four call the same engine, so the rules of the workflow hold whichever one you use.

## An MCP client

An assistant that speaks the Model Context Protocol connects to `realm mcp`, or to `realm serve` over HTTP. It sees Realm as a set of tools: list the workflows, start a run, execute a step, read a run's state, answer a gate.

The assistant's own model does the thinking. Realm calls no model and needs no provider key. In return, the assistant has to follow the replies: each one says which step to run next and what shape the answer must have.

This is the driver to use when a person is working with an assistant and wants the assistant held to a procedure.

## `realm agent`

`realm agent` drives one run from start to end without an assistant. It sends each agent step to a model provider, hands the answer to the engine, and repeats. If an answer is refused, it gives the model the reason and asks again, up to a limit.

When the run reaches a human gate, `realm agent` waits. It prints the command to answer the gate, or posts the gate to Slack if that is set up, and carries on when the answer arrives.

It runs one step at a time.

## `realm listen`

`realm listen` starts runs from webhooks. You give it one or more workflow files. Each says which requests it accepts in its `trigger` block. When a request arrives, `realm listen` checks it, creates a run, and starts a `realm agent` process for that run. The request gets its reply as soon as the run exists; it does not wait for the run to finish.

## `realm workflow run`

`realm workflow run` is for you, while you write a workflow. It asks you for the output of every agent step and the answer to every gate, so you can walk through the whole workflow with no model at all. It needs a terminal, because it asks questions.

## Mixing drivers

A run is not tied to the driver that started it. The record is on disk, and any driver can pick it up. Two common cases:

- A gate opened by `realm agent` can be answered from another terminal with `realm run respond`.
- A run that stopped part-way can be continued with `realm agent --run-id <run-id>`.

## See also

- [How a run moves](../start/how-a-run-moves.md) shows the calls each driver makes.
- [Connect an MCP client](../guides/connect-an-mcp-client.md)
- [Run a workflow with `realm agent`](../guides/realm-agent.md)
- [Start runs from webhooks](../guides/webhooks.md)
