# Install and first run

At the end of this page you have a finished Realm run on your machine and you have read the record it left behind. On the way, you watch Realm refuse a wrong answer. You need no AI model and no account: you play the part of the model yourself.

## Before you start

You need Node.js 22 or later, and a terminal.

## 1. Install the command-line tool

Install the `realm` command with npm:

```bash
npm install -g @sensigo/realm-cli
```

Check the install by asking for the version:

```bash
realm --version
```

It prints the version number, for example:

```text
0.45.0
```

## 2. Create a workflow

A **workflow** is a file that lists the steps of a job and the order they run in. Create a starter workflow and move into its folder:

```bash
realm workflow init my-first
cd my-first
```

It prints:

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

Notice `workflow.yaml`. It is the only file this page uses. It describes two steps:

```yaml
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

`step_one` is an **agent step**: it waits for someone to submit its output, and `input_schema` says what output it accepts. `step_two` is an **auto step**: Realm runs it itself, after `step_one`.

## 3. Register the workflow

Save a copy of the workflow with Realm, so that later commands can find it by name:

```bash
realm workflow register ./
```

It prints:

```text
Registered: my-first v1 (2 steps)
```

## 4. Run it, and give a wrong answer

Start a **run**, which is one execution of the workflow:

```bash
realm workflow run ./
```

Realm stops at `step_one` and asks for its output. The schema asks for text in `result`. Type a number instead:

```text
{"result": 42}
```

It prints:

```text
Realm — my-first v1
Run ID: 731242a8-3350-46a5-b723-a5b7ad1680f2

→ [agent] step_one: First step — replace with your own
  Agent output JSON (Enter for {}): {"result": 42}
  ✗ error: Invalid input for step 'step_one'

→ [agent] step_one: First step — replace with your own
  Agent output JSON (Enter for {}):
```

Notice that Realm refused the answer and is asking again. The run has not moved forward.

## 5. Give a valid answer

Type text for `result` this time:

```text
{"result":"hello from my first run"}
```

It prints:

```text
  ✓ → completed | hash: 735e6dd8... | 0ms

Run complete. Phase: completed
```

Notice that you answered once and the run finished. Realm accepted `step_one`, then ran `step_two` itself.

## 6. Read the record

Print the record of the run. Use the run ID from step 4; yours is different.

```bash
realm run inspect 731242a8-3350-46a5-b723-a5b7ad1680f2
```

It prints the following. Some lines are left out here and marked `…`.

```text
Run: 731242a8-3350-46a5-b723-a5b7ad1680f2
Workflow: my-first v1
Phase: completed  ✓
…
Completed: step_one, step_two
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

Notice three things:

- Each step has one entry under `Evidence`, with what went in and what came out.
- Each entry has a **hash**, a short fingerprint of the output. The two hashes match because the outputs match: the starter `step_two` has no work of its own, and its entry repeats the output of `step_one`.
- The number `42` is nowhere in the evidence. Realm never accepted it.

## If you see something else

- **`Error: dev-mode run is interactive — it prompts on stdin for every step and gate, and stdin here is not a terminal.`** You ran `realm workflow run` from a script or a pipe. Run it in a terminal window, where it can ask you questions.

## What you did

You installed Realm, created a workflow with two steps, and ran it to the end. Realm refused an answer that did not match the step's schema, accepted one that did, and kept a record of every step.

Next:

- [Write your first workflow](../guides/first-workflow.md) builds a workflow from an empty file.
- [Run a workflow with `realm agent`](../guides/realm-agent.md) lets a model do the agent steps.
- [Connect an MCP client](../guides/connect-an-mcp-client.md) lets an AI assistant such as Claude drive runs.
- [How a run moves](how-a-run-moves.md) explains what happens between the agent and Realm.
