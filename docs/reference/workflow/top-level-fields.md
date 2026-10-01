# Workflow file: top-level fields

This page lists every field that can appear at the top level of `workflow.yaml`. There are 15, taken from the list the loader checks files against. For each one it gives the type, whether it is required, what it does, and an example that was run.

For the fields of a step, see [Step fields](step-fields.md).

## Summary

| Field                                   | Type           | Required | What it holds                            |
| --------------------------------------- | -------------- | -------- | ---------------------------------------- |
| [`id`](#id)                             | string         | Yes      | The name runs are started by.            |
| [`name`](#name)                         | string         | Yes      | The name shown to people.                |
| [`description`](#description)           | string         | No       | What the workflow is for.                |
| [`version`](#version)                   | number         | Yes      | A number you choose.                     |
| [`params_schema`](#params_schema)       | JSON Schema    | No       | The shape of a run's parameters.         |
| [`protocol`](#protocol)                 | map            | No       | Instructions given to an assistant.      |
| [`services`](#services)                 | map            | No       | The services that `auto` steps call.     |
| [`mcp_servers`](#mcp_servers)           | list           | No       | Tool servers for agent steps.            |
| [`templates`](#templates)               | map            | No       | Groups of steps to reuse.                |
| [`steps`](#steps)                       | map            | Yes      | The steps.                               |
| [`profiles_dir`](#profiles_dir)         | string         | No       | The folder that holds agent profiles.    |
| [`extensions`](#extensions)             | string or list | No       | Your own code to load.                   |
| [`workflow_context`](#workflow_context) | map            | No       | Files whose text any prompt can include. |
| [`context_wrapper`](#context_wrapper)   | string         | No       | How that text is marked off in a prompt. |
| [`trigger`](#trigger)                   | map            | No       | The webhook that starts runs.            |

The examples below are parts of one file, shown whole in [A file that uses every field](#a-file-that-uses-every-field).

## `id`

- **Type:** string. **Required.**
- The name the workflow is registered under. `start_run` takes it as `workflow_id`, and CLI commands take it wherever they ask for a workflow ID. The registered copy is stored as `~/.realm/workflows/<id>.json`.
- The loader does not check which characters the ID contains. An ID that contains `/` passes `realm workflow validate` and then fails at `realm workflow register`, because the ID is used as a file name.

```yaml
id: review-note
```

Without it, the file is refused: `Invalid workflow: Missing required field: 'id'`.

## `name`

- **Type:** string. **Required.**
- The name shown in `realm workflow list` and returned to assistants by `list_workflows`.

```yaml
name: Review a note
```

Without it: `Invalid workflow: Missing required field: 'name'`.

## `description`

- **Type:** string. **Optional.**
- What the workflow is for. `realm workflow validate` and `realm workflow register` print it under their first line, and `get_workflow_protocol` returns it to an assistant as `description`.

```yaml
description: Reads a note, has it reviewed, and files the result.
```

## `version`

- **Type:** number. **Required.**
- A number you choose and change yourself. It is shown after the ID, as in `review-note v1`, and stored with each run. Realm does not increase it, and registering a changed file under the same version replaces the stored copy.

```yaml
version: 1
```

A value in quotes is refused: `Invalid workflow: 'version' must be a number`.

## `params_schema`

- **Type:** a JSON Schema. **Optional.**
- The shape that a run's parameters must have. Starting a run with parameters that do not fit is refused, and no run is created. Without `params_schema`, any parameters are accepted.
- The schema itself is checked when the file is loaded. See [JSON Schema blocks](json-schema-blocks.md).

```yaml
params_schema:
  type: object
  additionalProperties: false
  required: [path]
  properties:
    path:
      type: string
```

Starting a run with no `path` returns:

```text
VALIDATION_INPUT_SCHEMA: Invalid params for workflow 'review-note': (root) must have required property 'path'
```

## `protocol`

- **Type:** map with two optional keys, `quick_start` and `rules`. **Optional.**
- Changes what `get_workflow_protocol` tells an assistant.

| Key           | Type            | Effect                                                                                              |
| ------------- | --------------- | --------------------------------------------------------------------------------------------------- |
| `quick_start` | string          | Replaces the opening instruction. An empty string is ignored.                                       |
| `rules`       | list of strings | Replaces the four standard rules. Two rules about concurrent attempts are always added after yours. |

```yaml
protocol:
  quick_start: Start a run with the full path of the note, then follow each step's prompt.
  rules:
    - Never state a fact that is not in the note.
```

Without `protocol`, the opening instruction is:

```text
Call start_run with workflow_id 'review-note'. The engine will run auto steps automatically and return control at the first step requiring agent action. Follow the next_action in each response until the workflow completes.
```

and the four standard rules are:

```text
Follow the next_action instruction in each response exactly.
When you receive status 'confirm_required', read gate.agent_hint for instructions, present gate.display to the user verbatim, wait for their response, then call submit_human_response with their choice and the gate_id.
Do NOT auto-confirm any human gate. The user must decide.
Do NOT ask the user for permission between steps unless the system tells you to.
```

Setting `rules` removes all four, including the two about human gates.

## `services`

- **Type:** map from a name you choose to a service definition. **Optional.**
- Each entry names an adapter. A step calls the service with `uses_service`. See [Services, profiles and context](services-profiles-and-context.md).

```yaml
services:
  files:
    adapter: filesystem
    trust: engine_delivered
```

## `mcp_servers`

- **Type:** list of tool-server definitions. **Optional.**
- The tool servers that agent steps can take tools from when `realm agent` drives them. Each entry has `id`, `transport` (only `stdio`), `command`, and optionally `args` and `env`. A step that lists `tools` requires this block. See [Give an agent step tools](../../guides/agent-tools.md).

```yaml
mcp_servers:
  - id: notes
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-filesystem', './notes']
```

## `templates`

- **Type:** map from a template name to a group of steps with parameters. **Optional.**
- A step entry that has `use_template` is replaced, when the file is loaded, by the template's steps. See [Input maps and templates](input-map-and-templates.md).

```yaml
templates:
  check:
    params:
      topic:
        required: true
    steps:
      look:
        description: 'Check the note for {{ topic }}.'
        execution: agent
        depends_on: [read_note]
```

Used with `prefix: spelling`, this template adds a step named `spelling_look`.

## `steps`

- **Type:** map from a step name to a step definition. **Required.**
- The steps of the workflow. The order of the entries does not decide the order in which steps run; `depends_on` does. See [Step fields](step-fields.md).

```yaml
steps:
  read_note:
    description: Read the note from disk.
    execution: auto
    uses_service: files
    operation: read
    input_map:
      path: run.params.path
```

Without it: `Invalid workflow: Missing required field: 'steps'`. A list in place of the map is refused: `Invalid workflow: 'steps' must be a non-null object`.

## `profiles_dir`

- **Type:** string, a path relative to the workflow file. **Optional.** Default: `profiles`.
- The folder in which a step's `agent_profile` is looked up, as `<profiles_dir>/<name>.md`. The folder is read only when a step names a profile.

```yaml
profiles_dir: personas
```

## `extensions`

- **Type:** string, or list of strings. Each is a path relative to the workflow file. **Optional.**
- Files of your own code to load: adapters, handlers and processors. Each file must be inside the workflow's project. See [Project extensions](../project-extensions.md).

```yaml
extensions: ./registry.mjs
```

`realm workflow validate` then reports what it loaded:

```text
Extensions: ./registry.mjs (adapters: 0, handlers: 1, processors: 0)
```

A path that starts at the root of the disk is refused:

```text
Invalid workflow: 'extensions' entry '/abs/registry.mjs' is an absolute path — extension modules must be declared RELATIVE to the workflow directory (e.g. ../dist/registry.js)
```

## `workflow_context`

- **Type:** map from a name to an entry with `source.path` and an optional `description`. **Optional.**
- Files whose text a prompt can include with `{{ workflow.context.<name> }}`. See [Services, profiles and context](services-profiles-and-context.md).

```yaml
workflow_context:
  glossary:
    source:
      path: ./glossary.md
    description: Terms used in the notes.
```

## `context_wrapper`

- **Type:** one of `xml`, `brackets`, `none`. **Optional.** Default: `xml`.
- How the text of a `workflow_context` entry is marked off where a prompt includes it.

```yaml
context_wrapper: brackets
```

With `brackets`, a prompt that includes `{{ workflow.context.glossary }}` was delivered as:

```text
[glossary]
SKU: the code that identifies one product.

[/glossary]
```

Any other value is refused: `Invalid workflow: 'context_wrapper' must be 'xml', 'brackets', or 'none' (found: 'html') (line 4)`.

## `trigger`

- **Type:** map. **Optional.**
- The webhook that starts runs of this workflow under `realm listen`. See [Webhook trigger](webhook-trigger.md).

```yaml
trigger:
  type: webhook
  path: /review-note
  auth:
    mode: none
  params_map:
    path: body.path
```

## Your own fields

A top-level field whose name starts with `x-` is yours. Realm keeps it in the registered copy and never reads it. `realm workflow validate` and `realm workflow register` name the ones they found:

```yaml
x-owner: docs-team
```

```text
Valid: review-note v1 (4 steps) — 1 extension key carried, never read by realm: x-owner
```

Names that start with `x-realm-` are reserved, and are refused.

## Any other field

A top-level field that is neither in the table nor starts with `x-` makes `realm workflow validate` and `realm workflow register` fail:

```text
⚠ workflow 'w': unknown key 'owner' (line 4) — ignored (not a recognized workflow field).
Invalid: 1 warning, 1 escalated to an error by policy: UNKNOWN_WORKFLOW_KEY 'owner'
```

## Fields that Realm writes

Realm adds seven fields to the registered copy: `source_dir`, `trust_root`, `resolved_profiles`, `schema_version`, `origin`, `model` and `agent`. They are not allowed in the file. Writing one, such as `schema_version`, is refused like any unknown field.

## A file that uses every field

This file, with the files it names beside it, was validated, registered and run to completion.

```yaml
id: review-note
name: Review a note
description: Reads a note, has it reviewed, and files the result.
version: 1

x-owner: docs-team

params_schema:
  type: object
  additionalProperties: false
  required: [path]
  properties:
    path:
      type: string

protocol:
  quick_start: Start a run with the full path of the note, then follow each step's prompt.
  rules:
    - Never state a fact that is not in the note.

services:
  files:
    adapter: filesystem
    trust: engine_delivered

mcp_servers:
  - id: notes
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-filesystem', './notes']

templates:
  check:
    params:
      topic:
        required: true
    steps:
      look:
        description: 'Check the note for {{ topic }}.'
        execution: agent
        depends_on: [read_note]
        input_schema:
          type: object
          additionalProperties: false
          required: [problems]
          properties:
            problems:
              type: array
              items:
                type: string

profiles_dir: personas
extensions: ./registry.mjs

workflow_context:
  glossary:
    source:
      path: ./glossary.md
    description: Terms used in the notes.
context_wrapper: brackets

trigger:
  type: webhook
  path: /review-note
  auth:
    mode: none
  params_map:
    path: body.path

steps:
  read_note:
    description: Read the note from disk.
    execution: auto
    uses_service: files
    operation: read
    input_map:
      path: run.params.path

  spelling:
    use_template: check
    prefix: spelling
    params:
      topic: spelling mistakes

  review:
    description: Give a verdict on the note.
    execution: agent
    agent_profile: reviewer
    depends_on: [spelling_look]
    prompt: |
      {{ workflow.context.glossary }}

      Give a verdict on this note:

      {{ context.resources.read_note.content }}
    input_schema:
      type: object
      additionalProperties: false
      required: [verdict]
      properties:
        verdict:
          type: string
          enum: [fine, needs_work]

  file:
    description: File the verdict.
    execution: auto
    depends_on: [review]
    handler: file_result
    input_map:
      verdict: context.resources.review.verdict
```

`realm workflow validate ./` prints:

```text
Valid: review-note v1 (4 steps) — 1 extension key carried, never read by realm: x-owner
  Reads a note, has it reviewed, and files the result.
Extensions: ./registry.mjs (adapters: 0, handlers: 1, processors: 0)
ℹ 2 steps ready for structured_output: strict — run 'realm workflow validate --explain' for detail (REALM_NO_NUDGE=1 to silence).
```
