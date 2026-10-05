# Let an assistant plan its own workflow

<!-- description: How an assistant connected to Realm writes a workflow for a task that none of yours covers, what Realm checks and refuses, and how it differs from a file. -->

An assistant connected to Realm can write a workflow for a task that none of yours covers. It lists the steps it intends to take, and Realm then holds it to that list: in order, with each answer checked, and with a record at the end. This guide shows what the assistant sends, what Realm does with it, what it refuses, and how such a workflow differs from one you write in a file.

## Before you start

You need an assistant connected to Realm. See [Connect an MCP client](connect-an-mcp-client.md).

## When an assistant does this

The tool is called `create_workflow`, and every connected assistant has it. Realm suggests it when the assistant lists your workflows:

```text
Call get_workflow_protocol with a workflow_id before calling start_run. If no workflow matches your task, use create_workflow to define and start your own plan.
```

So an assistant may create a workflow without being asked to, when the task is long and nothing registered fits.

## 1. What the assistant sends

A list of steps, and a few words about the task. This plan drafts release notes in three steps:

```json
{
  "metadata": {
    "name": "release-notes",
    "description": "Draft release notes for a version.",
    "task_description": "Collect the merged changes, group them, then write the notes."
  },
  "steps": [
    {
      "id": "collect",
      "description": "List the changes merged since the last release.",
      "input_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["changes"],
        "properties": {
          "changes": { "type": "array", "items": { "type": "string" }, "minItems": 1 }
        }
      }
    },
    {
      "id": "group",
      "description": "Group the changes into Added, Changed and Fixed.",
      "depends_on": ["collect"]
    },
    {
      "id": "write",
      "description": "Write the release notes as Markdown.",
      "depends_on": ["group"],
      "input_schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["markdown"],
        "properties": { "markdown": { "type": "string", "minLength": 20 } }
      }
    }
  ]
}
```

A step can have these fields and no others:

| Field                 | Meaning                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `id`                  | The step's name. Required.                                                                          |
| `description`         | What the step is for. Required.                                                                     |
| `depends_on`          | Steps that must finish first. Each must be earlier in the list.                                     |
| `input_schema`        | The shape the step's answer must have.                                                              |
| `structured_output`   | `strict`, to have the model provider hold answers to that shape when `realm agent` drives the step. |
| `llm_timeout_seconds` | The longest one model request for this step may take under `realm agent`.                           |

`metadata` takes `name`, `description` and `task_description`. `task_description` is returned as `quick_start` when an assistant asks how to run the workflow.

## 2. What comes back

Realm registers the workflow, starts a run of it, and returns the first step to do:

```text
status: ok
workflow_id: release-notes-86de43b5661ea6e9
run_id: 6fe03f8d-14bc-4da9-9513-39341907ee0c
Run '6fe03f8d-14bc-4da9-9513-39341907ee0c' created for workflow 'release-notes-86de43b5661ea6e9'. Ready for the agent: 'collect'.
next: execute_step collect
```

The `Ready for the agent: …` sentence was added after version 0.46.0, which ends the line at `created for workflow '…'.`.

The assistant does not choose the workflow's ID. Realm makes it from the name and a code computed from the plan's content. The same plan sent again gets the same ID and a new run. A plan with no name gets an ID that starts with `dynamic-`.

## 3. Realm holds the assistant to its plan

From here the run behaves like any other. The assistant tried `group` before `collect`, and was refused:

```text
status: blocked
Step 'group' is not eligible in the current run state.
eligible_steps: collect
```

It then answered `collect` with an empty list, which its own schema does not allow:

```text
status: error
VALIDATION_INPUT_SCHEMA: Invalid input for step 'collect'
/changes must NOT have fewer than 1 items
agent_action: provide_input
```

With a valid answer to each step in order, the run completed.

## 4. Look at it afterwards

The workflow is in the list, marked as made by an agent:

```bash
realm workflow list
```

```text
ID                              NAME           VERSION  ORIGIN  SCHEMA
release-notes-86de43b5661ea6e9  release-notes  1        agent   1 (current)
```

The run has a record like any other. `realm run inspect <run-id>` shows each step's answer:

```text
Phase: completed  ✓
Completed: collect, group, write
…
  1. collect                success   0ms   hash: 8d7a0354
     Input:  {"changes":["Add replay page","Fix copy button"]}
…
  2. group                  success   0ms   hash: 3a5f234a
     Input:  {"whatever":true}
```

The workflow stays registered. Anyone can start another run of it by its ID.

## How a created workflow differs from yours

**Every step is done by the assistant.** A created workflow has no steps that Realm runs by itself, no services, no handlers, no conditions and no human gates. It is a checklist with checked answers, not an automation.

**An assistant cannot give itself a human gate.** If it sends `trust`, `gate`, `execution` or any other field that is not in the table above, Realm leaves the field out, creates the workflow without it, and says so in the reply:

```text
status: ok
⚠ step 'a': unknown key 'trust' — ignored (not a recognized step field).
⚠ step 'a': unknown key 'gate' — ignored (not a recognized step field).
```

If a task needs your approval part-way, write the workflow yourself. See [Add a human gate](human-gates.md).

**A step is only as strict as its schema.** In the plan above, `group` has no `input_schema`, so any answer to it is accepted. The record in step 4 shows the one it got: `{"whatever":true}`. The assistant writes the checks that are then applied to its own answers.

**It has no project.** It cannot name code to load, and it reads no `realm.yaml` unless the server was started with `--project`. See [Deploy a project](deploy.md#workflows-that-have-no-project).

## What Realm refuses

In each of these cases nothing is created. Except for the first, the reply has `agent_action: provide_input`, which tells the assistant to correct the plan and send it again.

| The plan has                                            | The reply says                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| No steps                                                | `Array must contain at least 1 element(s) at steps`                                                                       |
| Two steps with one `id`                                 | `Duplicate step id: 'a'`                                                                                                  |
| A `depends_on` naming no step                           | `Step 'a': depends_on references unknown step 'zzz'`                                                                      |
| A `depends_on` naming a later step                      | `Step 'a': depends_on must reference a step that appears earlier in the list`                                             |
| An `input_schema` that is not valid JSON Schema         | `Step 'a': 'input_schema' is not a valid JSON Schema — 'type' must be one of array, boolean, integer, …`                  |
| `structured_output: strict` with a schema it cannot use | `Step 'a': 'structured_output: strict' is not eligible for this step's schema — add 'additionalProperties: false' …`      |
| `extensions`                                            | `extensions is not supported on dynamically-created workflows. Project extensions are register-time and operator-only: …` |

## What Realm leaves out, with a warning

In these cases the workflow is created and the run starts. The reply lists what was left out.

| The plan has                                | The warning says                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A step field that is not in the table       | `step 'a': unknown key 'handler' — ignored (not a recognized step field).`                                                     |
| A top-level field Realm does not know       | `unknown key 'services' — ignored (not a recognized create_workflow field).`                                                   |
| `workflow_id`                               | `'workflow_id' is ignored — create_workflow mints its own workflow id and returns it as data.workflow_id; …`                   |
| `name` beside `steps`, not under `metadata` | `'name' belongs under metadata — submitted at the top level it is ignored; use metadata.name.`                                 |
| `timeout_seconds` on a step                 | `'timeout_seconds' was removed (#412) — nothing enforces it on agent steps; the model-request bound is 'llm_timeout_seconds'.` |

## Keep the list tidy

Created workflows add up, one for each different plan. No command removes a workflow. Each is one file in `~/.realm/workflows/`, named after its ID, and deleting the file removes it from the list. Runs of it stay in the store, and `realm run inspect` still shows their record.

## See also

- [MCP tools reference](../reference/mcp/tools.md) covers `create_workflow` in full.
- [Who drives a run](../concepts/who-drives-a-run.md)
- [Write your first workflow](first-workflow.md), for workflows you write yourself.
