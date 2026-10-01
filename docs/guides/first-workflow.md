# Write your first workflow

At the end of this page you have a workflow you wrote yourself, with a parameter, two agent steps that pass work from one to the other, and one automatic step. You run it by hand and read its record. On the way, Realm catches a typing mistake in your file.

## Before you start

You need the `realm` command installed. See [Install and first run](../start/install-and-first-run.md).

## 1. Start the file

Make a folder and create `workflow.yaml` in it:

```bash
mkdir article
cd article
```

Put this in `workflow.yaml`:

```yaml
id: article
name: Write a short article
version: 1

params_schema:
  type: object
  additionalProperties: false
  required: [topic]
  properties:
    topic:
      type: string

steps:
  outline:
    description: List the points the article will make.
    execution: agent
    prompt: |
      List two to five points for a short article about {{ run.params.topic }}.
    input_schema:
      type: object
      additionalProperties: false
      required: [points]
      properties:
        points:
          type: array
          minItems: 2
          maxItems: 5
          items:
            type: string
```

Notice three parts:

- `params_schema` says what a run must be given at the start. Here it is one piece of text, `topic`.
- `prompt` is the task a model receives for this step. `{{ run.params.topic }}` is replaced with the run's topic.
- `input_schema` says what the step's answer must look like: a list of two to five points.

## 2. Add a step that uses the first one

Add two more steps under `steps`, after `outline`. Type the third line of `write` exactly as shown, mistake included:

```yaml
steps:
  # outline: as above

  write:
    description: Write the article from the outline.
    execution: agent
    depend_on: [outline]
    prompt: |
      Write a short article about {{ run.params.topic }} that makes these points:

      {{ context.resources.outline.points | bullets }}
    input_schema:
      type: object
      additionalProperties: false
      required: [text]
      properties:
        text:
          type: string
          minLength: 40

  publish:
    description: Keep the article as the result of the run.
    execution: auto
    depends_on: [write]
```

`{{ context.resources.outline.points | bullets }}` puts the answer of the `outline` step into the prompt of `write`, as a bulleted list. That is how one step's work reaches the next.

## 3. Check the file

Ask Realm to check the file:

```bash
realm workflow validate ./
```

It prints:

```text
⚠ step 'write': unknown key 'depend_on' (line 34) — ignored (did you mean 'depends_on'?)
Invalid: 1 warning, 1 escalated to an error by policy: UNKNOWN_STEP_KEY 'depend_on'
```

Notice that Realm refused the file and named the line. The key should be `depends_on`. Without it, `write` would not wait for `outline`. Fix the line:

```yaml
depends_on: [outline]
```

Check again:

```bash
realm workflow validate ./
```

It prints:

```text
Valid: article v1 (3 steps)
ℹ 2 steps ready for structured_output: strict (2 with caveats) — run 'realm workflow validate --explain' for detail (REALM_NO_NUDGE=1 to silence).
```

Notice `Valid`. The second line is a suggestion you can ignore here.

## 4. Register it

Save a copy of the workflow with Realm, so that other commands can find it by name:

```bash
realm workflow register ./
```

It prints:

```text
Registered: article v1 (3 steps)
```

## 5. Run it

Start a run and give it a topic:

```bash
realm workflow run ./ --params '{"topic":"human gates"}'
```

Realm asks for the answer to `outline`. Type an outline with two points:

```text
{"points":["Gates stop a run","Evidence is recorded"]}
```

It prints:

```text
Realm — Write a short article v1
Run ID: 6824dacc-5f25-4a6e-a152-3dee7c88ea97

→ [agent] outline: List the points the article will make.
  Agent output JSON (Enter for {}): {"points":["Gates stop a run","Evidence is recorded"]}
  ✓ → running | hash: 043e7f4b... | 0ms

→ [agent] write: Write the article from the outline.
  Agent output JSON (Enter for {}):
```

Notice that the run moved on to `write`. At this prompt you see each step's description. A model would be sent the `prompt` text, with your two points filled in:

```text
Write a short article about human gates that makes these points:

• Gates stop a run
• Evidence is recorded
```

Type the article:

```text
{"text":"Realm stops a run at a gate until someone answers, and records every step."}
```

It prints:

```text
  ✓ → completed | hash: 77d5900d... | 1ms

Run complete. Phase: completed
```

Notice that `publish` did not ask you anything. It is an `auto` step, so Realm ran it.

## 6. Read the record

Print the record, using the run ID from step 5:

```bash
realm run inspect 6824dacc-5f25-4a6e-a152-3dee7c88ea97
```

It prints the following. Some lines are left out here and marked `…`.

```text
Phase: completed  ✓
…
Completed: outline, write, publish
…
Evidence (3 steps):

  1. outline                success   0ms   hash: 043e7f4b
     Input:  {"points":["Gates stop a run","Evidence is recorded"]}
     Output: {"points":["Gates stop a run","Evidence is recorded"]}
     …
  2. write                  success   0ms   hash: 77d5900d
     Input:  {"text":"Realm stops a run at a gate until someone answers, and records every step."}
     …
  3. publish                success   1ms   hash: 77d5900d
     …
```

Notice that all three steps are in the record, in the order they ran.

## If you see something else

- **`Error: Invalid params for workflow 'article': (root) must have required property 'topic'`** You started the run without `--params`, or without a `topic` in it. No run was created. Start it again with the topic.
- **`✗ error: Invalid input for step 'outline'`** Your answer did not fit the step's `input_schema`, for example an outline with one point. Realm asks again; type an answer that fits.

## What you did

You wrote a workflow with a parameter and three steps, and Realm caught a misspelt key before anything ran. You passed one step's answer into the next step's prompt, and the run's record shows each step in order.

Next:

- [Write an agent step](agent-steps.md) covers prompts, schemas and profiles in more depth.
- [Call a service with an adapter](call-a-service.md) makes an `auto` step do real work.
- [Add a human gate](human-gates.md) stops the run for a person's approval.
- [Run a workflow with `realm agent`](realm-agent.md) lets a model answer the agent steps.
