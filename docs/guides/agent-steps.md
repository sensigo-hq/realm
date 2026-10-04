# Write an agent step

<!-- description: Write an agent step that hands work to a model and accepts the answer only if it has the right shape: the task, the schema, a profile and the closing text. -->

An agent step hands a piece of work to a model and accepts the answer only if it has the right shape. This guide shows how to write the four parts of one: the task, the answer's schema, a reusable profile, and the text shown when it finishes.

## Before you start

You need a workflow you can run. [Write your first workflow](first-workflow.md) makes one.

## The step this guide builds

```yaml
id: triage
name: Triage a ticket
version: 1

params_schema:
  type: object
  additionalProperties: false
  required: [ticket]
  properties:
    ticket:
      type: string

steps:
  classify:
    description: Classify the ticket and say how urgent it is.
    execution: agent
    agent_profile: support-lead
    prompt: |
      Classify this support ticket.

      Ticket:
      {{ run.params.ticket }}
    input_schema:
      type: object
      additionalProperties: false
      required: [category, urgent, reason]
      properties:
        category:
          type: string
          enum: [billing, bug, how_to]
        urgent:
          type: boolean
        reason:
          type: string
          minLength: 10
    display: |
      {{ category }} (urgent: {{ urgent }})
      {{ reason }}
```

## 1. Write the task in `prompt`

Put the task in `prompt`. Use `{{ … }}` to pull in values:

| Write this                           | To get                                 |
| ------------------------------------ | -------------------------------------- |
| `{{ run.params.NAME }}`              | A parameter the run was started with.  |
| `{{ context.resources.STEP.FIELD }}` | A field from an earlier step's output. |

Realm fills the values in before the model sees the prompt. For a run started with the ticket "I was charged twice this month.", the model receives:

```text
Classify this support ticket.

Ticket:
I was charged twice this month.
```

Keep `description` to one line that says what the step is for. It appears in listings and in the hand-run prompt. The detail belongs in `prompt`.

## 2. Say what a valid answer is in `input_schema`

`input_schema` is a JSON Schema for the step's answer. Write it as strictly as the work allows:

- List every field under `required`.
- Set `additionalProperties: false`, so that fields you did not ask for are refused.
- Use `enum` for a field with a fixed set of values, and `minLength`, `minItems` or `maxItems` where a field has limits.

The schema is the part of the step that Realm enforces. A rule written only in the prompt is a request. A rule in the schema cannot be broken.

A model that answered with a category outside the list was refused, and told why:

```text
status: error
error_code: VALIDATION_INPUT_SCHEMA
/category must be equal to one of the allowed values
agent_action: provide_input
```

The step stayed open, and a second, valid answer was accepted.

## 3. Give the model a role with `agent_profile`

A profile is a Markdown file that describes who the model should be for this step. Profiles live in a `profiles` folder beside `workflow.yaml`. One profile can serve many steps.

Create `profiles/support-lead.md`:

```text
You are a support lead. You classify tickets by what the customer needs next, not by the words they use. When a ticket could fit two categories, you choose the one that gets the customer an answer sooner.
```

Name it on the step, without the `.md`:

```yaml
agent_profile: support-lead
```

Register the workflow:

```bash
realm workflow register ./
```

It prints:

```text
Registered: triage v1 (1 step)
```

The profile's text is copied into the registered workflow at this moment. If you edit the profile file later, register again, or the old text is still used.

The record of a run names the profile each step ran with:

```text
  1. classify               [profile: support-lead] success   0ms   hash: e077242e
```

## 4. Choose what is shown with `display`

`display` is a short template for showing the step's answer to a person. `realm agent` prints it in the terminal when the step finishes, in place of the raw JSON.

```yaml
display: |
  {{ category }} (urgent: {{ urgent }})
  {{ reason }}
```

In `display`, `{{ field }}` means a field of this step's own answer. The longer forms used in `prompt`, such as `{{ run.params.ticket }}`, do not work here.

## If you see something else

- **`Invalid workflow: Step 'classify': agent_profile 'support-lead' not found. Searched: …/profiles/support-lead.md`** The profile file is missing or has another name. Create it at the path shown, or correct the name on the step.

## See also

- [Agent-step controls](../reference/workflow/agent-step-controls.md) covers what happens after repeated refusals, and stricter output modes.
- [JSON Schema blocks](../reference/workflow/json-schema-blocks.md) lists what a schema may contain.
- [`input_map`, templates and filters](../reference/workflow/input-map-and-templates.md)
- [Give an agent step tools](agent-tools.md)
