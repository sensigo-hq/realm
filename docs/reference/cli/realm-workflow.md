# `realm workflow`

<!-- description: Reference for the realm workflow subcommands, which work on workflow files and registered workflows: their arguments, flags, output and exit codes. -->

`realm workflow` has eight subcommands that work on workflow files and on the workflows registered in `~/.realm/workflows/`. This page gives the arguments, flags, output and exit code of each. Every output shown came from a run of the command.

| Subcommand              | What it does                                                |
| ----------------------- | ----------------------------------------------------------- |
| [`init`](#init)         | Creates a folder with a starting workflow.                  |
| [`validate`](#validate) | Checks a workflow file, or a registered copy.               |
| [`register`](#register) | Checks a workflow file and stores it.                       |
| [`watch`](#watch)       | Registers a workflow again each time its file changes.      |
| [`list`](#list)         | Lists the registered workflows.                             |
| [`run`](#run)           | Runs a workflow by hand in a terminal.                      |
| [`test`](#test)         | Runs a workflow's fixture tests.                            |
| [`migrate`](#migrate)   | Updates registered copies written by old versions of Realm. |

Wherever a subcommand takes a `<path>`, it is the folder that holds `workflow.yaml`, or the file itself.

## `init`

```text
realm workflow init <name>
```

Creates a folder called `<name>` with six files.

```bash
realm workflow init invoice-check
```

```text
Created: invoice-check/
  workflow.yaml
  schema.json
  .env.example
  README.md
  registry.sample.js
  realm.yaml

Next: realm workflow validate ./invoice-check/
```

**Exit code:** 0, or 1 if the folder already exists: `Directory already exists: …/invoice-check`.

## `validate`

```text
realm workflow validate <path> [flags]
realm workflow validate --registered <id> [flags]
```

Checks a workflow and prints the result. It stores nothing. With a path it checks the file; with `--registered` it checks the stored copy of a registered workflow against the rules of the installed version.

| Flag                         | What it does                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `--registered <id>`          | Checks the registered copy of workflow `<id>`. Cannot be combined with a path.                 |
| `--strict`                   | Exits with 1 if there is any warning.                                                          |
| `--explain`                  | Prints one line for each step about `structured_output: strict`, in place of one summary line. |
| `--json`                     | Prints the result as one JSON object and nothing else.                                         |
| `--extensions-module <path>` | Loads this code file in place of the files named by the workflow's `extensions`.               |

The warning that the `@sensigo/realm` your code imports is another version than the command's ([`REALM_RELEASE_LINE_MISMATCH`](../workflow/loader-diagnostics.md#warning-codes)) counts as a warning for `--strict`. This was added in 0.46.0.

```bash
realm workflow validate invoice-check
```

```text
Valid: invoice-check v1 (2 steps)
```

See [What the loader refuses and warns about](../workflow/loader-diagnostics.md) for every form the output takes, and for the JSON fields.

**Exit code:** 0 if the workflow is accepted; 1 if it is refused, if `--strict` was given and there was a warning, or if neither a path nor `--registered` was given:

```text
Error: provide a workflow path, or --registered <id> to audit a stored definition.
```

## `register`

```text
realm workflow register <path> [--strict]
```

Checks the file as `validate` does and, if it is accepted, stores a copy as `~/.realm/workflows/<id>.json`. Runs are started from the stored copy. Registering a workflow that is already registered replaces the copy.

| Flag       | What it does                                             |
| ---------- | -------------------------------------------------------- |
| `--strict` | Stores nothing and exits with 1 if there is any warning. |

A project realm of another version ([`REALM_RELEASE_LINE_MISMATCH`](../workflow/loader-diagnostics.md#warning-codes)) is a warning: without `--strict` the workflow is registered and the warning printed; with it, nothing is stored. This was added in 0.46.0.

```bash
realm workflow register invoice-check
```

```text
Registered: invoice-check v1 (2 steps)
```

The stored copy also holds the text of every agent profile the workflow names, and the folder of the workflow's project. See [Deploy a project](../../guides/deploy.md).

**Exit code:** 0 if the workflow was stored, otherwise 1.

## `watch`

```text
realm workflow watch <path>
```

Registers the workflow, then registers it again each time the file or one of its profile files changes. It runs until you stop it with Ctrl+C. Each line it prints begins with the time.

```text
Watching invoice-check/workflow.yaml — press Ctrl+C to stop
[2026-10-01T22:47:07.024Z] Registered: invoice-check v1 (2 steps)
[2026-10-01T22:47:08.062Z] Registered: invoice-check v1 (2 steps)
[2026-10-01T22:47:10.067Z] Invalid workflow: 'version' must be a number
[2026-10-01T22:47:12.073Z] Registered: invoice-check v2 (2 steps)
```

A file that is refused is reported, and the copy registered before it stays in place. `watch` keeps running.

If the watched folder is removed, `watch` stops:

```text
Error: The watched directory no longer exists — deleted, or moved out from under the watch. Nothing is watched any more; restart 'realm workflow watch' when the path exists again.
```

**Exit code:** 1 if the file does not exist when `watch` starts, or if the watched folder is removed.

## `list`

```text
realm workflow list [--json]
```

Lists the registered workflows in order of ID.

```text
ID             NAME           VERSION  ORIGIN  SCHEMA
invoice-check  invoice-check  1        human   1 (current)

1 workflow registered.
```

| Column    | Holds                                                                                     |
| --------- | ----------------------------------------------------------------------------------------- |
| `ID`      | The workflow's `id`.                                                                      |
| `NAME`    | Its `name`.                                                                               |
| `VERSION` | Its `version`.                                                                            |
| `ORIGIN`  | `human` for a workflow registered from a file; `agent` for one made by `create_workflow`. |
| `SCHEMA`  | The format of the stored copy, and whether it is the format this version of Realm writes. |

With `--json`:

```json
{
  "workflows": [
    {
      "id": "invoice-check",
      "name": "invoice-check",
      "version": 1,
      "origin": "human",
      "schema_version": 1,
      "current": true
    }
  ],
  "unreadable": [],
  "mismatched": []
}
```

`unreadable` lists stored files that could not be read, each with the reason. `mismatched` lists stored files whose name differs from the `id` inside them. With no workflows registered, the table is empty and the last line reads `0 workflows registered.`

**Exit code:** 0.

## `run`

```text
realm workflow run <path> [flags]
```

Runs the workflow in the terminal, one step at a time, asking you for each step's answer and for each gate's choice. It is meant for trying a workflow while you write it. The workflow does not have to be registered.

| Flag                         | Default            | What it does                                                                      |
| ---------------------------- | ------------------ | --------------------------------------------------------------------------------- |
| `--params <json>`            | `{}`               | The run's parameters.                                                             |
| `--extensions-module <path>` | None               | Loads this code file in place of the files named by the workflow's `extensions`.  |
| `--project <dir>`            | The current folder | The project whose `realm.yaml` applies if the workflow has no project of its own. |
| `--mint-writer-nonce`        | Off                | Marks each attempt's trace entries with a fresh identifier.                       |

It needs a terminal. Started without one, it creates no run:

```text
Error: dev-mode run is interactive — it prompts on stdin for every step and gate, and stdin here is not a terminal. No run was created. Scripted flows: 'realm workflow test' drives fixtures; 'realm listen' / 'realm agent' are the production drives. To run this workflow by hand, use a real terminal.
```

A step that does not return `ok` prints a line that starts with `✗`, then the reply's status and the reason. When the step that stopped is one the engine ran after the step you answered, the line names it:

```text
  ✗ error (step 'file', run by the engine after 'classify' finished): Handler 'file_ticket' threw: the filing system is down
```

This was added in 0.46.0; version 0.45.0 prints `✗ error: …` without naming the step.

A gate's prompt closes when its question is settled while it waits: by its time running out, when the gate declares an `on_expiry` (this process carries the expiry out and prints its own `⏰` line), or by another process — `realm run respond` from another terminal, `realm run advance`, `realm run drain --expired` or `realm listen`. Those read the workflow from the registry, so they act on the run only once it is registered (`realm workflow register <file>`): for a workflow never registered, `realm run respond`, `realm run advance` and `realm run drain` are refused with `Workflow not found: <id> — …`, and `realm listen` skips the run. It then prints what the run's record holds, in the words of `realm run inspect`, and the run goes on:

```text
  Choice [ship/hold]: ⏰ gate '02ebe774-…' on run '81771ac5-…' expired — enacted via the attending-process timer (enacted_via: timer).

  This prompt is closed: the question on 'review' is no longer open — Answer: hold · settled by the gate's expiry (no answer in time).
```

When no answer was recorded (an `on_expiry: abort`), the line ends `— no answer was recorded; the run is 'aborted'.` The prompt reads the run's record twice a second while it waits. Added after version 0.46.0, whose prompt stayed open and refused what was typed after the question was settled.

An `auto` step's prompt closes the same way when another process takes or runs that step while the prompt waits (`realm run advance`, `realm agent`, an `execute_step` call): it prints `This prompt is closed: step '<step>' was taken by <program>, and completed; not run here.`, or `… was taken by <program>; not run here.` while the other process still holds it, and goes on. While an agent step's prompt waits, the command holds the step's claim, so no other driver does the step's work: `realm run inspect` shows the step taken by this program (`via run`), `realm agent` waits for it and asks no model, and an `execute_step` call is refused with `Step '<step>' cannot be called now: it is in flight (claimed by another call).` `realm agent` holds nothing while its model works on a step, so a prompt opened during that call takes the step with no word of the call: the model's answer is then not recorded, and if you leave the prompt while that drive still waits for the step, its model is asked again. Like any claim on an agent step, it has no time limit: `realm run list --stuck` lists the run (`<step>=claim_unknown_age`) while the prompt waits. The command lets the claim go when you answer (the engine then takes it for the answer), when you leave the prompt, and when it is ended by SIGHUP, SIGINT or SIGTERM (it then exits with 128 plus the signal's number); a command killed outright (SIGKILL) leaves it, and `realm run reclaim <run> --step <step> --force` releases it. When another process takes or runs the step between your answer and the engine's claim for it, the answer is not recorded: `Not run here: step '<step>' was taken by <program>, and completed; the answer typed here was not recorded.` (or `… was taken by <program>; …` while that process holds it) The agent step's prompt closes when another process removed its claim (`This prompt is closed: the claim it held on step '<step>' was removed by another process, and the step has not run.`; the step is asked for again if it is still ready) or the run ended. While another process holds a step and nothing else is ready, it waits for that process, as `realm agent` does, and says so: `• Step '<step>' is in flight, taken by <program> since <time>: waiting up to 60s for the run's record to change.` When the record changes it runs what is ready; when the record has not changed for 60 seconds it prints `• Step '<step>' has been in flight since <time>, taken by <program>; the record has not changed for 60s. If the program that took it is gone: realm run reclaim <run> --step <step> --force` and hands the run back at that step, with the ways on that fit a step another program is still running: `realm run advance`, once the step is no longer in flight, runs what the engine then owes and names an agent step or a question that is ready. Added after version 0.46.0:

```text
• Step 'sleep' has been in flight since 2026-10-08T12:34:50.336Z, taken by mihai@host (from the OS user, via advance); the record has not changed for 60s. If the program that took it is gone: realm run reclaim 7d1f0c2e-5a8b-4c36-9e21-3b6f8d0a4c17 --step sleep --force
Stopped waiting — detached from run '7d1f0c2e-5a8b-4c36-9e21-3b6f8d0a4c17' at step 'sleep' (phase: running). The run is saved.
  Go on:     once 'sleep' is no longer in flight, realm run advance 7d1f0c2e-5a8b-4c36-9e21-3b6f8d0a4c17
  Inspect:   realm run inspect 7d1f0c2e-5a8b-4c36-9e21-3b6f8d0a4c17
```

The gate's prompt shows the question before its choices: the gate's `message`, or the step's `prompt` when the gate has no `message`, rendered as the reply that opened the gate renders it. Each of its lines is printed as written, with any other control character written as the escape `realm run inspect` writes in its `Message:` line (a tab as `\t`, an escape character as `\u001b`): `Question: Ship it?` for one line, and for more, `Question:` with each line indented below it. Added after version 0.46.0.

Leaving a prompt with Ctrl+D or Ctrl+C keeps the run and says how to carry on:

```text
Prompt cancelled — detached from run '00ac2e9c-6728-4fb4-8ba0-234617eff305' at step 'note' (phase: running). The run is saved.
  Drive it:  realm agent --run-id 00ac2e9c-6728-4fb4-8ba0-234617eff305 --provider <provider> --model <model>
  Inspect:   realm run inspect 00ac2e9c-6728-4fb4-8ba0-234617eff305
  Discard:   realm run abandon 00ac2e9c-6728-4fb4-8ba0-234617eff305
```

To drive the run with `realm agent`, fill in `<provider>` and `<model>` with the provider and model you want: a run started by `realm workflow run` has not been driven by a model. The `Drive it` line also repeats the `--extensions-module`, `--project` and `--mint-writer-nonce` you gave `realm workflow run` (none in this example), as you typed them: run it from the folder you started that command in. If the workflow file was never registered, register it first (`realm workflow register <file>`). Until then the command stops with `Error: Workflow not found: <id> — most often this run was created from a file without --register. …`, and after it the same command drives the run. Version 0.45.0 prints the `Drive it` line without `--provider <provider> --model <model>` and without those flags.

An `auto` step's answer is the one you type, so a step whose input its schema refuses is asked for again. A step that no typed answer can unblock — a failed precondition, an invalid `trust`, a handler or adapter this program lacks — is not asked for. When nothing else can run, the run stops there, names each such step and gives the way out. Added after version 0.46.0:

```text
Workflow stalled: nothing else can run.
'compute' cannot run (precondition): Precondition failed for step 'compute'. Precondition failed: 'run.params.ok == true'. Resolved value: undefined.
Run 2a319588-0843-41c4-b28b-44f88ecb0752 stays open (phase 'running'): correct the workflow, register it again, then realm run advance 2a319588-0843-41c4-b28b-44f88ecb0752; or end it: realm run abandon 2a319588-0843-41c4-b28b-44f88ecb0752.
```

[Install Realm and run a workflow](../../start/install-and-first-run.md) shows a whole session.

**Exit code:** 0 if the run completed; 1 if it ended in any other way, if nothing else could run, if it stopped waiting for a step another program holds, if you left a prompt with Ctrl+C or Ctrl+D, or if there was no terminal.

## `test`

```text
realm workflow test <path> -f <dir> [--extensions-module <path>]
```

Runs every fixture file in `<dir>` against the workflow and prints one line for each.

| Flag                         | What it does                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `-f`, `--fixtures <dir>`     | The folder that holds the fixture files. Required.                               |
| `--extensions-module <path>` | Loads this code file in place of the files named by the workflow's `extensions`. |

```text
Realm Test — ./
  PASS a discarded summary is not published
  PASS a good summary is published

2/2 passed
```

When a fixture's error takes several lines, the second and later lines are indented under its `FAIL` line. A fixture whose step's precondition fails, with nothing else left to run ([what each failure prints](../testing-package.md)):

```text
Realm Test — flow
  FAIL one: Workflow stalled: nothing else can run.
    'compute' cannot run (precondition): Precondition failed for step 'compute'. Precondition failed: 'run.params.ok == true'. Resolved value: undefined.

0/1 passed
```

Added after version 0.46.0, which prints the second and later lines at the start of the line, and fails this fixture with `Workflow stalled: exceeded maximum loop iterations`.

See [Test a workflow](../../guides/test-a-workflow.md).

**Exit code:** 0 if every fixture passed; 1 if one failed, or if the folder does not exist: `Error: fixtures directory does not exist: invoice-check/fixtures`.

## `migrate`

```text
realm workflow migrate
```

Adds the `origin` field to registered copies that were stored by a version of Realm older than the field. It prints what it did:

```text
Done. 0 migrated, 1 already up to date.
```

**Exit code:** 0.

## `--extensions-module`

On `validate`, `run` and `test`, this flag replaces the code files the workflow names. It is for repairs, such as a code file that has moved. Realm says when it is in use:

```text
[realm] --extensions-module override active: loading './alt.mjs' (resolved: /srv/shop/alt.mjs). Declared workflow extensions are IGNORED.
```

## See also

- [What the loader refuses and warns about](../workflow/loader-diagnostics.md)
- [Write your first workflow](../../guides/first-workflow.md)
- [Upgrade Realm](../../guides/upgrade.md) covers `list` and `validate --registered` after an upgrade.
