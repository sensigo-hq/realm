# Services, tool servers, step templates, profiles and workflow context

<!-- description: Reference for services, mcp_servers, templates, agent profiles, workflow_context, context_wrapper and protocol: their keys, rules and when files are read. -->

This page covers the top-level blocks of `workflow.yaml` that steps draw on: `services`, `mcp_servers`, `templates`, agent profiles (`profiles_dir`), `workflow_context` with `context_wrapper`, and `protocol`. For each it gives the keys, the rules, and when Realm reads the files involved.

## `services`

A map from a name you choose to a service. An `auto` step calls a service with `uses_service: <name>`.

| Key          | Type                                                     | Required | What it holds                                                                                                 |
| ------------ | -------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `adapter`    | text                                                     | Yes      | The name of the adapter that does the call: a built-in one, one from `realm.yaml`, or one from your own code. |
| `trust`      | `engine_delivered`, `engine_managed` or `agent_provided` | No       | A label passed to the adapter with each call. Realm itself does not act on it.                                |
| `rate_limit` | map                                                      | No       | Limits how often the service is called.                                                                       |

```yaml
services:
  files:
    adapter: filesystem
    trust: engine_delivered
```

No other key is allowed: `Service 'files': unknown key 'colour'`. The keys inside `rate_limit` are not checked. A step that names a service the block does not have is refused:

```text
Invalid workflow: Step 'a': uses_service 'files' is not defined in 'services' (step at line 5)
```

Whether an adapter of that name exists is not checked when the file is loaded. A step whose adapter cannot be found is blocked when the run reaches it. See [Call a service with an adapter](../../guides/call-a-service.md).

### `rate_limit`

| Key                      | Type   | What it does                                                                                        |
| ------------------------ | ------ | --------------------------------------------------------------------------------------------------- |
| `requests_per_second`    | number | How many calls a second are let through. Later calls wait.                                          |
| `burst`                  | number | How many calls may go at once before waiting starts. Without it, the same as `requests_per_second`. |
| `fallback_retry_seconds` | number | How long to wait when the service answers "too many requests" and does not say how long.            |
| `min_retry_seconds`      | number | The shortest wait after such an answer, even if the service names a shorter one.                    |
| `max_retry_seconds`      | number | The longest wait accepted. If the service asks for more, the step fails without waiting.            |

With `requests_per_second: 1`, three steps that each called the service once finished 0.0, 2.0 and 3.0 seconds after the run started. Each waiting step's record shows the wait as its duration.

The limit is kept by the process that runs the steps. Two processes driving runs of the same workflow each keep their own.

## `mcp_servers`

A list of tool servers that agent steps can take tools from when `realm agent` drives them.

| Key         | Required | What it holds                                                                                              |
| ----------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `id`        | Yes      | The name steps use for the server, as in `tools: [notes:read_text_file]`.                                  |
| `transport` | Yes      | `stdio`, the only value.                                                                                   |
| `command`   | Yes      | The program to start.                                                                                      |
| `args`      | No       | Its arguments.                                                                                             |
| `env`       | No       | Environment variables for it. `'${NAME}'` is replaced by the value from the shell that runs `realm agent`. |

See [Give an agent step tools](../../guides/agent-tools.md).

## `templates`

A template is a named group of steps with blanks. A step entry that says `use_template` is replaced, when the file is loaded, by the template's steps with the blanks filled in.

```yaml
templates:
  check:
    params:
      topic:
        required: true
      tone:
        default: neutral
    steps:
      look:
        description: 'Check the note for {{ topic }}, in a {{ tone }} tone ({{ prefix }}).'
        execution: agent
      fix:
        description: 'Fix {{ topic }}.'
        execution: agent
        depends_on: ['{{ prefix }}_look']

steps:
  spelling:
    use_template: check
    prefix: spelling
    params:
      topic: spelling mistakes
  facts:
    use_template: check
    prefix: facts
    params:
      topic: wrong facts
      tone: strict
```

This file loads as four steps:

| Step            | Description                                                         | Depends on      |
| --------------- | ------------------------------------------------------------------- | --------------- |
| `spelling_look` | Check the note for spelling mistakes, in a neutral tone (spelling). | —               |
| `spelling_fix`  | Fix spelling mistakes.                                              | `spelling_look` |
| `facts_look`    | Check the note for wrong facts, in a strict tone (facts).           | —               |
| `facts_fix`     | Fix wrong facts.                                                    | `facts_look`    |

**In the template:**

| Key      | What it holds                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------- |
| `params` | The blanks. Each has `required: true`, or a `default`, or neither.                                    |
| `steps`  | Ordinary steps. In any text value, `{{ name }}` is a blank and `{{ prefix }}` is the caller's prefix. |

**In the entry that uses it:**

| Key            | Required | What it holds                                    |
| -------------- | -------- | ------------------------------------------------ |
| `use_template` | Yes      | The template's name.                             |
| `prefix`       | Yes      | Put before each step's name, with an underscore. |
| `params`       | No       | Values for the blanks.                           |

The entry's own name, `spelling` above, is not kept. To refer to a step of the same template, write `{{ prefix }}_<step>`, as `fix` does.

### Rules

- `prefix` is required: `Step 'spelling': use_template requires a non-empty 'prefix'`.
- A required blank must be given: `Step 'spelling': template 'check' requires param 'topic'`.
- The template must exist: `Step 'spelling': use_template references unknown template 'nope'`.
- A value given for a blank the template does not have is ignored. So is any other field on the entry.
- If a step you wrote has the same name as a step a template produces, the step you wrote is kept and the template's is dropped. No warning is printed.

## Agent profiles

A profile is a Markdown file of standing instructions for a model, kept apart from the workflow so that several steps can share it.

```yaml
profiles_dir: personas

steps:
  review:
    description: Give a verdict on the note.
    execution: agent
    agent_profile: reviewer
```

`agent_profile: reviewer` names the file `reviewer.md` in `profiles_dir`. Without `profiles_dir`, the folder is `profiles`, beside the workflow file.

- **The file is read when the workflow is registered.** Its text is stored in the registered copy. Editing the file afterwards changes nothing until you register again.
- **A missing file is refused** by `realm workflow validate` and `realm workflow register`:

  ```text
  Invalid workflow: Step 'a': agent_profile 'nobody' not found. Searched: …/profiles/nobody.md
  ```

- **`realm agent` gives the text to the model** with the step's prompt. An assistant connected over MCP receives it from `get_workflow_protocol`, as the step's `agent_profile_instructions`.
- **The record names the profile.** `realm run inspect` shows `[profile: reviewer]` on the step, and the run's record keeps a hash of the text that was used.

## `workflow_context`

`workflow_context` names files whose text any prompt or gate message can include.

```yaml
workflow_context:
  glossary:
    source:
      path: ./glossary.md
    description: Terms used in the notes.
```

| Key           | Required | What it holds                                        |
| ------------- | -------- | ---------------------------------------------------- |
| `source.path` | Yes      | The file, relative to the workflow file.             |
| `description` | No       | What the file contains. For readers of the workflow. |

A prompt includes the text with `{{ workflow.context.glossary }}`. `context_wrapper` decides how it is marked off:

| `context_wrapper` | `{{ workflow.context.glossary }}` becomes |
| ----------------- | ----------------------------------------- |
| `xml` (default)   | `<glossary>`, the text, `</glossary>`     |
| `brackets`        | `[glossary]`, the text, `[/glossary]`     |
| `none`            | The text alone                            |

`{{ workflow.context.glossary.raw }}` gives the text alone whatever the wrapper.

### When the files are read

The files are read once for each run, when the run's first step is executed, and the text is kept with the run. Later steps of that run use the kept text.

Two things follow:

- **Editing a file takes effect for every run whose first step has not yet been executed**, without registering again. A run that had read the file kept the old text; a run whose first step ran after the edit got the new text.
- **A prompt that is delivered before the first step is executed still has the expressions in it.** That is the prompt of a workflow's first step, as returned by `start_run`:

  ```text
  {{ workflow.context.glossary }}
  Give a verdict.
  ```

  The prompt of every later step has the text in place. In a workflow that begins with an `auto` step, the files have been read by the time the first prompt is delivered.

### A file that cannot be read

`realm workflow validate` does not check that the files exist. When a file cannot be read, the run continues, the expression is left in the prompt as written, and the run's record keeps the error:

```json
"house.rules": {
  "content": "",
  "error": "ENOENT: no such file or directory, open '/srv/notes/rules.md'"
}
```

### Rules

- A name may contain letters, digits, underscores and dots: `workflow_context entry 'my-notes' must match [\w.]+ (underscores and dots only — no hyphens)`.
- A name may not end in `.raw`: `workflow_context entry 'notes.raw' must not end with '.raw'`.
- `source.path` is required: `workflow_context.notes.source.path is required`.
- A file named `schema.json` beside the workflow file is added as `workflow.context.schema`, unless you declare an entry of that name.
- When more than half of the agent steps' prompts include the same entry, `realm workflow validate` prints a note:

  ```text
  ⚠ workflow.context.glossary is referenced in 2 of 2 agent step prompts. If this context applies universally, that is intentional — otherwise consider whether all steps truly need it.
  ```

## `protocol`

`protocol` changes what `get_workflow_protocol` tells an assistant: `quick_start` replaces the opening instruction, and `rules` replaces the standard rules. See [Top-level fields](top-level-fields.md#protocol).

## See also

- [Top-level fields](top-level-fields.md)
- [Input maps, template expressions and filters](input-map-and-templates.md) covers the `{{ … }}` expressions used in prompts.
- [Adapters reference](../adapters.md)
- [`realm.yaml` reference](../deployment-manifest.md)
