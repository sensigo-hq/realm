# Give an agent step tools

An agent step can look things up before it answers: read a file, query an API, search a ticket system. This guide gives a step two tools from a tool server, limits how much it may use them, and shows what Realm records about each call. At the end you have a step that answers a question from a folder of notes.

## Before you start

You need:

- A workflow with an agent step. [Write an agent step](agent-steps.md) makes one.
- `realm agent` set up to drive it. See [Run a workflow with `realm agent`](realm-agent.md).
- `npx`, which comes with Node.js, to start the example tool server.

**The tools on this page are offered only when `realm agent` drives the step.** An assistant connected over MCP is given the step's prompt and nothing about its tools. It uses whatever tools it has itself, and Realm does not record those calls.

## How it works

A **tool server** is a program that offers tools over MCP, the same protocol assistants use to call Realm. The workflow names the servers it uses, and each agent step lists the tools it may call. When `realm agent` reaches the step, it starts the server, tells the model about the listed tools, carries out each call the model asks for, and records it.

## 1. Name the tool server

Add an `mcp_servers` block at the top level of the workflow. This one starts a public server that reads files in one folder:

```yaml
mcp_servers:
  - id: notes
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-filesystem', './notes']
```

| Key         | Meaning                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`        | The name steps use for this server.                                                                                |
| `transport` | How Realm talks to it. `stdio` is the only value: Realm starts the program and talks over its input and output.    |
| `command`   | The program to start.                                                                                              |
| `args`      | Its arguments.                                                                                                     |
| `env`       | Environment variables for it. A value such as `'${NOTES_TOKEN}'` is filled from the shell that runs `realm agent`. |

Create the folder and one note for the server to read:

```bash
mkdir notes
printf '# Returns\n\nCustomers may return an item within 30 days of delivery.\n' > notes/returns.md
```

## 2. List the step's tools

On the agent step, list each tool as `server:tool`:

```yaml
steps:
  answer:
    description: Answer the question from the notes.
    execution: agent
    tools:
      - notes:list_directory
      - notes:read_text_file
    max_tool_calls: 5
    tool_timeout: 20
    prompt: |
      Answer this question using only the files in the notes folder.
      List the folder, read what you need, then answer.

      Question: {{ run.params.question }}
    input_schema:
      type: object
      additionalProperties: false
      required: [answer, source_file]
      properties:
        answer:
          type: string
        source_file:
          type: string
```

The model is told about the listed tools and no others. This server offers 14 tools, among them `write_file` and `move_file`. The step above can list a folder and read a text file, and nothing else.

The two limits are optional:

| Key              | Limits                                               | Without it |
| ---------------- | ---------------------------------------------------- | ---------- |
| `max_tool_calls` | How many tool calls the model may make in this step. | 20         |
| `tool_timeout`   | How many seconds one tool call may take.             | 30         |

## 3. Run it

```bash
realm agent --workflow ./ --params '{"question":"How long do customers have to return an item?"}'
```

It prints, among the tool server's own start-up lines:

```text
→ [agent] answer
  Answer the question from the notes.
  ✓ → completed

Run complete: b190d283-5b2e-473e-ad61-b086b0342a8a

Result (answer):
{
  "answer": "Within 30 days of delivery.",
  "source_file": "returns.md"
}
```

## 4. Read what was recorded

Every tool call is part of the step's evidence. Add `--verbose` to see what was sent and what came back:

```bash
realm run inspect <run-id> --verbose
```

Under the step it prints:

```text
     Tool calls (2):
       [notes:list_directory]  7ms
         args:   {"path":"."}
         result: {"content":[{"type":"text","text":"[FILE] returns.md\n[FILE] shipping.md"}], …}
       [notes:read_text_file]  4ms
         args:   {"path":"returns.md"}
         result: {"content":[{"type":"text","text":"# Returns\n\nCustomers may return an item within 30 days of delivery.\n…"}], …}
```

Each entry names the server and tool, how long the call took, the arguments the model chose and the result it was given. Without `--verbose`, the same list shows one line for each call.

A call that fails is recorded too, with its error, and the model is told about the failure so that it can try something else:

```text
       [notes:list_directory]  7ms  error: ENOENT: no such file or directory, scandir '[REDACTED]/notes/notes'
```

Realm replaces any text that equals the value of an environment variable with `[REDACTED]`, in what it records and in what it shows the model, so that a secret held in a variable does not end up in either. Here it replaced the path of the working folder.

The record does not yet include what the model's requests cost for a step that uses tools. `realm run inspect` says so on the step's `cost` line.

## See Realm hold the limits

**When the step has used its tool calls**, the model is not given another. Realm sends it this message, with no tools, and takes its answer:

```text
You have reached the maximum number of tool calls. Produce your final JSON answer now using only what you have already gathered. No further tool calls will be executed.
```

With `max_tool_calls: 1`, the model listed the folder, was sent that message, and answered with what it had. The record shows one tool call. An answer that Realm refuses against the step's schema uses up one of the step's calls as well.

**A tool that the server does not have** stops the step before the model is asked anything:

```text
✗ Step 'answer' (tools) failed: Step 'answer' declares tool 'notes:read_pdf' which is not exposed by MCP server 'notes'. Check the tool name against the server's published tool list.
```

**A step that lists tools in a workflow with no `mcp_servers`** is refused when the workflow is loaded:

```text
Invalid workflow: Step 'answer': declares tools but the workflow defines no mcp_servers — no drive can ever offer these tools, so the declaration can never be satisfied. Define an mcp_servers block, or remove 'tools'. (step at line 14)
```

So is a tool whose server is not in the block, and a `tool_timeout` on a step with no tools.

When a step fails in one of these ways while it runs, the run stays open. Fix the cause and continue it. See [Operate runs](operate-runs.md#open-with-no-driver).

## Steps that start other runs

A tool server can be Realm itself, so that an agent step starts runs of other workflows. `max_fan_out` limits how many times the step may call `start_run` or `start_run_batch`. When the limit is reached, the model is sent the same message as above.

## If you see something else

- **`MCP server 'notes': env var NOTES_TOKEN is not set`** A value in the server's `env` names a variable that the shell running `realm agent` does not have. Set it and run again.
- **`Step 'answer' (tools) failed: Cannot read properties of undefined (reading 'indexOf')`** The model asked for a tool that is not in the step's list. The tool was not called. Run the step again; if it keeps happening, say in the prompt which tools the step has.

## See also

- [Agent-step controls reference](../reference/workflow/agent-step-controls.md) covers `tools`, `max_tool_calls`, `max_fan_out` and `tool_timeout` in full.
- [Top-level fields reference](../reference/workflow/top-level-fields.md) covers `mcp_servers`.
- [Evidence](../concepts/evidence.md)
