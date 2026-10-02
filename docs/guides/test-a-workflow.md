# Test a workflow

This guide shows how to check a workflow's logic without a model, without real services and without a person at the gate. You write small files that say "given these inputs, the run should end like this", and one command runs them all. At the end you have tests you can run after every change and in CI.

## Before you start

You need a workflow. This guide uses one that reads a note, has an agent summarise it, asks a person, and publishes only if they agree:

```yaml
id: digest
name: Publish a note digest
version: 1

params_schema:
  type: object
  additionalProperties: false
  required: [path]
  properties:
    path:
      type: string

services:
  files:
    adapter: filesystem
    trust: engine_delivered

steps:
  read_note:
    description: Read the note from disk.
    execution: auto
    uses_service: files
    operation: read
    input_map:
      path: run.params.path

  summarise:
    description: Summarise the note in one sentence.
    execution: agent
    depends_on: [read_note]
    prompt: |
      Summarise this note in one sentence.

      {{ context.resources.read_note.content }}
    input_schema:
      type: object
      additionalProperties: false
      required: [summary]
      properties:
        summary:
          type: string
          minLength: 10

  review:
    description: A person decides whether the summary is published.
    execution: auto
    depends_on: [summarise]
    trust: human_confirmed
    gate:
      choices: [publish, discard]

  publish:
    description: Publish the summary.
    execution: auto
    depends_on: [review]
    when: "review.choice == 'publish'"
```

## How a test is built

A test is a YAML file called a **fixture**. It supplies everything that would come from outside the workflow, and says how the run should end:

| Key               | Supplies                                                  |
| ----------------- | --------------------------------------------------------- |
| `params`          | The run's parameters.                                     |
| `mocks`           | What each service returns, by service name and operation. |
| `agent_responses` | What the model answers, by step name.                     |
| `gate_responses`  | What the person chooses, by step name.                    |
| `expected`        | How the run should end.                                   |

Nothing real is called. The file adapter does not read a file, no model is asked, and nobody is prompted. The workflow's own rules, such as order, schemas and conditions, run exactly as they do in a real run.

## 1. Write a fixture

Create a `fixtures` folder beside `workflow.yaml`, and put this in `fixtures/published.yaml`:

```yaml
name: a good summary is published
params:
  path: /notes/release.txt
mocks:
  files:
    read:
      status: 200
      data:
        content: 'Realm 0.45 ships a replay page.'
agent_responses:
  summarise:
    summary: Realm 0.45 adds a replay page.
gate_responses:
  review: publish
expected:
  final_state: completed
  evidence:
    - step_id: read_note
      status: success
    - step_id: summarise
      status: success
    - step_id: publish
      status: success
```

`expected.final_state` is the phase the run must end in. `expected.evidence` lists steps that must have run, with their result.

## 2. Test the other branch

A second fixture checks that a discarded summary is not published. Put this in `fixtures/discarded.yaml`:

```yaml
name: a discarded summary is not published
params:
  path: /notes/release.txt
mocks:
  files:
    read:
      status: 200
      data:
        content: 'Realm 0.45 ships a replay page.'
agent_responses:
  summarise:
    summary: Realm 0.45 adds a replay page.
gate_responses:
  review: discard
expected:
  final_state: completed
  skipped_steps:
    - publish
```

`expected.skipped_steps` is the exact set of steps that must have been skipped.

## 3. Run the tests

Run every fixture in the folder:

```bash
realm workflow test ./ -f ./fixtures/
```

It prints:

```text
Realm Test — ./
  PASS a discarded summary is not published
  PASS a good summary is published

2/2 passed
```

The command exits with code 0 when every fixture passes, and 1 otherwise, so it can be a step in CI.

## 4. See a test catch a mistake

Remove the `when` line from the `publish` step, as if by accident, and run the tests again:

```bash
realm workflow test ./ -f ./fixtures/
```

It prints:

```text
Realm Test — ./
  FAIL a discarded summary is not published: Expected skipped_steps ["publish"] but got []
  PASS a good summary is published

1/2 passed
```

Notice which test failed and why: without the condition, the summary would be published even when the person said to discard it. Put the line back.

## Test that bad answers are refused

The schema is checked in tests too. A fixture whose `agent_responses` do not fit the step's `input_schema` fails:

```text
  FAIL a summary that is too short is refused: Invalid input for step 'summarise'
```

This is useful the other way round: to check that a schema is as strict as you intend, write a fixture with an answer that should be refused and confirm that the test fails for that reason.

## What tests do not cover

- **The model.** `agent_responses` are your words, not a model's. Tests prove that the workflow handles an answer correctly, not that a model will produce it.
- **The real services.** Mocks return what you wrote. A change in a real service's response is not caught.
- **Your run store.** Test runs are not saved under `~/.realm/`.

## If you see something else

- **`error: required option '-f, --fixtures <dir>' not specified`** Give the folder that holds the fixture files.

## See also

- [Testing package reference](../reference/testing-package.md) covers every fixture key and running tests from your own test code.
- [Write an agent step](agent-steps.md)
- [Add a human gate](human-gates.md)
