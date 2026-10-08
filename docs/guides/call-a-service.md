# Call a service with an adapter

<!-- description: Make an auto step do real work through an adapter, such as reading a file or calling an API, pass the result to a later step, and place the credentials. -->

This guide shows how to make an `auto` step do real work: read a file, call an API, post a message. At the end you have a step that reads a file through Realm's built-in file adapter, a later step that uses what it read, and you know where the credentials go for a service that needs them.

## Before you start

You need a workflow you can run. [Write your first workflow](first-workflow.md) makes one.

## How the pieces fit

Three things connect a step to the outside world:

- An **adapter** is the code that talks to one kind of service. Realm ships several, such as `filesystem` and `github`.
- A **service** is a name you give to an adapter inside one workflow, under `services`.
- An `auto` step names the service with `uses_service`, picks an `operation`, and builds the operation's input with `input_map`.

## 1. Declare the service

Add a `services` block to the workflow, and give the file adapter a name:

```yaml
services:
  files:
    adapter: filesystem
    trust: engine_delivered
```

## 2. Call it from an auto step

Add a step that reads a file. The path comes from the run's parameters:

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

`input_map` maps each input of the operation to a value. `run.params.path` means the `path` parameter the run was started with.

## 3. Use the result in a later step

The output of a step is available to later steps under `context.resources.<step>`. The `read` operation returns the file's text in a field named `content`. Put it in the next step's prompt:

```yaml
steps:
  # read_note: as above

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
```

The complete file:

```yaml
id: notes
name: Summarise a note
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
```

## 4. Run it

Register the workflow, then run it by hand with the full path of a text file:

```bash
realm workflow register ./
realm workflow run ./ --params '{"path":"/home/you/notes/note.txt"}'
```

At the first prompt, press Enter. Then type a summary:

```text
→ [auto] read_note: Read the note from disk.
  Mock output (service: files) — JSON (Enter for {}):
  ✓ → running | hash: 9016ad33... | 2ms

→ [agent] summarise: Summarise the note in one sentence.
  Agent output JSON (Enter for {}): {"summary":"Realm 0.45 adds a replay page."}
  ✓ → completed | hash: 740968a5... | 0ms

Run complete. Phase: completed
```

The first prompt is labelled `Mock output`, but the service is really called. Whatever you type there is recorded as the step's input and does not replace the service's output, so pressing Enter is the right answer.

Check that the file was read. Print the record:

```bash
realm run inspect <run-id>
```

It prints, for the first step (the paths are shortened here):

```text
  1. read_note              success   2ms   hash: 9016ad33
     Taken by: ops@server-1 (from the OS user, via run)
     Input:  {}
     Resolved: {"path":"/home/you/notes/note.txt"}
     Output: {"content":"Realm 0.45 ships a replay page.\nIt records two real runs.\n","path":"/home/you/notes/…
```

Notice `Resolved`, the input the adapter received after `input_map` was applied, and `Output`, the file's text.

## 5. See a service refuse

Run it again with a path that does not start at the root of the disk:

```bash
realm workflow run ./ --params '{"path":"note.txt"}'
```

It prints:

```text
→ [auto] read_note: Read the note from disk.
  Mock output (service: files) — JSON (Enter for {}):
  ✗ error: path must be absolute

Run complete. Phase: failed
```

The file adapter accepts only full paths. The step failed, the run ended as `failed`, and the step that depended on it was skipped. The record says so:

```text
Phase: failed
Sealed by: step_failure
Cause: Step 'read_note' failed: path must be absolute
Failed: read_note
Skipped: summarise
  summarise: trigger_rule_unsatisfiable: all_success, dep read_note failed
```

To keep a run alive when a service fails, give the workflow a step that handles the failure. See [Handle failure](handle-failure.md).

## A service that needs credentials

The file adapter needs no setup. Most others need a token. Credentials never go in `workflow.yaml`. They go in two files beside it:

`realm.yaml` says how to build the adapter, and names the secret it needs:

```yaml
version: 1
adapters:
  github:
    use: github
    config: { auth: { token: '${secret:GITHUB_TOKEN}' } }
```

`.env` holds the secret's value:

```text
GITHUB_TOKEN=your-token-here
```

The workflow then names the adapter as before:

```yaml
services:
  github:
    adapter: github
    trust: engine_delivered
```

If `realm.yaml` is missing, a step that uses the adapter is blocked, and the run waits. Over MCP, `start_run` replies `ok` and names the step in `warnings` (`Step '<step>' is blocked: …`), and `execute_step` on the step is refused with:

```text
Adapter 'github' for service 'github' is not registered. Declare this adapter under 'adapters:' in realm.yaml …
```

If the secret is missing, nothing starts, and Realm names it:

```text
Deployment manifest secrets: 1 unresolved secret reference(s):
  adapters.github.config.auth.token → ${secret:GITHUB_TOKEN}
```

## See also

- [Adapters reference](../reference/adapters.md) lists every built-in adapter and its operations.
- [`input_map`, templates and filters](../reference/workflow/input-map-and-templates.md)
- [Deployment manifest (`realm.yaml`)](../reference/deployment-manifest.md)
- [Deploy](deploy.md) covers secrets and project settings in full.
