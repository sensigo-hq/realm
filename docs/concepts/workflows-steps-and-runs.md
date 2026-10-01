# Workflows, steps and the run record

Realm has four things you will meet in every command: the workflow file, the registered copy, the run, and the run record. This page explains what each one is and how they relate, so that you know which one a command is reading or changing.

## The workflow file

A workflow is a YAML file, usually named `workflow.yaml`. It has an `id`, a `name`, a `version`, and a list of steps:

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

The file is yours. You keep it in your project and under version control.

## Steps

A step is one unit of work. Its name is the key under `steps`. Three fields matter most:

- `description` says what the step is for. An agent is shown this text.
- `execution` says who performs the step. There are [four kinds](step-kinds.md).
- `depends_on` lists the steps that must finish first. Steps with nothing in common can be listed in any order: the dependencies decide when each one runs, not the order in the file.

## The registered copy

`realm workflow register` reads your file, checks it, and stores a copy under `~/.realm/workflows/`, named after the workflow's `id`. Commands that take a workflow by name, and AI clients, read this copy, not your file.

Two things follow from that.

**Edits do nothing until you register again.** Changing `workflow.yaml` does not change what runs until you run `realm workflow register` once more. While you are editing, `realm workflow watch` registers on every save.

**Registering again replaces the copy, for runs that have already started too.** Realm keeps one copy per `id`. A run does not carry its own copy of the workflow: it reads the registered one each time it moves. In a test, a run was started, the workflow was edited and registered again, and the run's next step showed the new text:

```text
before: Execute step 'assess': Decide how risky the refund is and state the amount.
after : Execute step 'assess': CHANGED AFTER THE RUN STARTED.
```

So do not re-register a workflow in a way that changes its steps while runs of it are still open. The `version` field does not protect you here: it is a label you set, and Realm does not keep older versions.

## Runs

A run is one execution of a workflow. Each run has an ID, the parameters it was started with, and a **phase**:

| Phase          | Meaning                                               |
| -------------- | ----------------------------------------------------- |
| `running`      | Work remains, and nothing is waiting on a person.     |
| `gate_waiting` | The run is stopped at a human gate.                   |
| `completed`    | The run reached its end.                              |
| `failed`       | A step failed and nothing in the workflow recovered.  |
| `aborted`      | The workflow itself stopped the run, by a rule in it. |
| `abandoned`    | An operator ended the run by hand.                    |

The last four are final. [Evidence](evidence.md) explains each ending.

One workflow can have many runs at the same time. They do not share anything except the registered copy.

## The run record

Every run has one file under `~/.realm/runs/`, named after the run ID. This is the run record. It holds:

- the parameters the run started with;
- which steps completed, failed or were skipped, and why a step was skipped;
- one evidence entry for each step that ran: what went in, what came out, how long it took, and a hash of the output;
- the phase, and for a finished run, what ended it.

`realm run inspect <run-id>` prints the record. `realm run list` lists the runs.

The record is a plain file. Realm does not detect changes made to it by hand; see [Evidence](evidence.md).

## Running without registering

`realm workflow run <path>` runs a workflow straight from the file, without a registered copy. This is for trying a workflow by hand. `realm run inspect` then cannot show the workflow's details and says so, until you register it.

## See also

- [The four step kinds](step-kinds.md)
- [Order and routing](order-and-routing.md)
- [`realm workflow` command reference](../reference/cli/realm-workflow.md)
- [Top-level fields of the workflow file](../reference/workflow/top-level-fields.md)
