# Install and first run

This page takes you from nothing to a finished run you can inspect. You install the command-line tool, create a small workflow, run it by hand, and read the record it leaves behind. It needs no AI model and no account.

## Before you start

You need Node.js 22 or later.

## Install the CLI

```bash
npm install -g @sensigo/realm-cli
```

Check that it works:

```bash
realm --version
```

It prints the installed version, for example `0.45.0`.

## Create a workflow

A **workflow** is a file that lists the steps of a job and the order they run in. The `init` command writes a starter one:

```bash
realm workflow init my-first
cd my-first
```

```text
Created: my-first/
  workflow.yaml
  schema.json
  .env.example
  README.md
  registry.sample.js
  realm.yaml

Next: realm workflow validate ./my-first/
```

Only `workflow.yaml` matters for this page. The other files are starting points for later: `realm.yaml` holds deployment settings, `.env.example` lists secrets, and `registry.sample.js` shows where your own code plugs in.

## Read the workflow

Open `workflow.yaml`:

```yaml
id: my-first
name: 'my-first'
version: 1

steps:
  step_one:
    description: 'First step — replace with your own'
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [result]
      properties:
        result:
          type: string

  step_two:
    description: 'Second step'
    execution: auto
    depends_on: [step_one]
```

- `id` is the name you use for this workflow in every command.
- `steps` lists the work. This workflow has two steps.
- `step_one` has `execution: agent`. An **agent step** waits for someone to submit its output. Usually that is an AI model. On this page it is you.
- `input_schema` describes the output `step_one` will accept: an object with exactly one field, `result`, which must be text. Realm refuses anything else.
- `step_two` has `execution: auto`. Realm runs an **auto step** itself.
- `depends_on: [step_one]` means `step_two` cannot run until `step_one` has finished.

## Check the file

```bash
realm workflow validate ./
```

```text
Valid: my-first v1 (2 steps)
ℹ 1 step ready for structured_output: strict — run 'realm workflow validate --explain' for detail (REALM_NO_NUDGE=1 to silence).
```

`Valid` means Realm can load the file. The second line is a suggestion you can ignore for now.

## Register it

Registering stores a copy of the workflow so that Realm can run it:

```bash
realm workflow register ./
```

```text
Registered: my-first v1 (2 steps)
```

List what is registered:

```bash
realm workflow list
```

```text
ID        NAME      VERSION  ORIGIN  SCHEMA
my-first  my-first  1        human   1 (current)

1 workflow registered.
```

## Run it by hand

`realm workflow run` starts a **run**, which is one execution of the workflow. It asks you for the output of each agent step, so you play the part of the model. It needs a real terminal, because it prompts you.

```bash
realm workflow run ./
```

It stops at `step_one` and asks for the output as JSON. First give it a wrong answer, a number where the schema asks for text:

```text
Realm — my-first v1
Run ID: 731242a8-3350-46a5-b723-a5b7ad1680f2

→ [agent] step_one: First step — replace with your own
  Agent output JSON (Enter for {}): {"result": 42}
  ✗ error: Invalid input for step 'step_one'
```

Realm refuses it and asks again. The run has not moved. Now give it a valid answer:

```text
→ [agent] step_one: First step — replace with your own
  Agent output JSON (Enter for {}): {"result":"hello from my first run"}
  ✓ → completed | hash: 735e6dd8... | 0ms

Run complete. Phase: completed
```

Realm accepted the output, recorded it, and then ran `step_two` itself. That finished the run.

## Read the record

List your runs:

```bash
realm run list
```

```text
731242a8-3350-46a5-b723-a5b7ad1680f2  my-first v1  completed  10/1/2026, 3:48:23 PM  2 step(s)
```

Then inspect one, using its run ID:

```bash
realm run inspect 731242a8-3350-46a5-b723-a5b7ad1680f2
```

```text
Run: 731242a8-3350-46a5-b723-a5b7ad1680f2
Workflow: my-first v1
Phase: completed  ✓
Sealed by: complete
Cause: Workflow completed.
Completed: step_one, step_two
In Progress: (none)
Failed: (none)
Skipped: (none)
…
Evidence (2 steps):

  1. step_one               success   0ms   hash: 735e6dd8
     Input:  {"result":"hello from my first run"}
     Output: {"result":"hello from my first run"}
     …

  2. step_two               success   0ms   hash: 735e6dd8
     Input:  {}
     Output: {"result":"hello from my first run"}
     …
```

Each step that ran has one entry under `Evidence`: what went in, what came out, and a hash of the output. A hash is a short fingerprint: if the output changed, the hash would change too. The wrong answer you gave first is not in the evidence, because Realm never accepted it.

## Where things are stored

Everything stays on your machine, under your home directory:

- `~/.realm/workflows/` holds one file per registered workflow, for example `my-first.json`.
- `~/.realm/runs/` holds one file per run, named after the run ID.

## See also

- [Write your first workflow](../guides/first-workflow.md) builds a workflow from an empty file.
- [Run a workflow with `realm agent`](../guides/realm-agent.md) lets a model do the agent steps.
- [Connect an MCP client](../guides/connect-an-mcp-client.md) lets an AI assistant such as Claude drive runs.
- [How a run moves](how-a-run-moves.md) explains what happens between the agent and Realm.
