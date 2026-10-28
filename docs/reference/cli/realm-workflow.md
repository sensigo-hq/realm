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

Creates a folder called `<name>` with six files. Inside a project — when a folder above it holds a `package.json` or a `.git` — it writes four: Realm reads `realm.yaml` only from the project's top folder ([Deployment manifest](../deployment-manifest.md#where-realm-looks-for-it)), so `init` leaves `realm.yaml` and `.env.example` out of the new folder and names the project's folder.

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

Inside the project `/srv/shop`, which holds a `package.json`:

```text
Created: invoice-check/
  workflow.yaml
  schema.json
  README.md
  registry.sample.js

invoice-check/ is inside the project '/srv/shop', which holds a package.json or a .git.
Realm reads realm.yaml only from that folder, so it and .env.example were not written here.
The project has no realm.yaml yet: add one there when a workflow needs settings — how an adapter, handler or processor is built, its secrets, or a gate notifier.

Next: realm workflow validate ./invoice-check/
```

When the project already has a `realm.yaml`, the last of those lines reads `The project's realm.yaml applies to this workflow.`

**Exit code:** 0, or 1 if the folder already exists: `Directory already exists: …/invoice-check`.

## `validate`

```text
realm workflow validate <path> [flags]
realm workflow validate --registered <id> [flags]
```

Checks a workflow and prints the result. It stores nothing. With a path it checks the file; with `--registered` it checks the stored copy of a registered workflow against the rules of the installed version.

| Flag                         | What it does                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--registered <id>`          | Checks the registered copy of workflow `<id>`. Cannot be combined with a path.                                                          |
| `--strict`                   | Exits with 1 if there is any warning.                                                                                                   |
| `--explain`                  | Prints one line for each step about `structured_output: strict`, in place of one summary line.                                          |
| `--json`                     | Prints the result as one JSON object and nothing else.                                                                                  |
| `--extensions-module <path>` | Loads this code file in place of the files named by the workflow's `extensions`.                                                        |
| `--provider <name>`          | Describes only that provider's request, `anthropic` or `openai`, in the [cache lines](#the-cache-lines).                                |
| `--model <id>`               | The model the runner uses. Needs `--provider`. Its minimum is read from your [economics file](../cache-economics.md#the-cache-minimum). |
| `--floor <tokens>`           | A minimum of your own to judge each agent step against, in tokens.                                                                      |
| `--ratio <chars-per-token>`  | Your own count of characters per token, in place of the estimate's range.                                                               |

The warning that the `@sensigo/realm` your code imports is another version than the command's ([`REALM_RELEASE_LINE_MISMATCH`](../workflow/loader-diagnostics.md#warning-codes)) counts as a warning for `--strict`. This was added in 0.46.0.

```bash
realm workflow validate invoice-check
```

```text
Valid: invoice-check v1 (2 steps)
ℹ 1 step ready for structured_output: strict — run 'realm workflow validate --explain' for detail (REALM_NO_NUDGE=1 to silence).
cache: step_one — anthropic 588 chars ≈ 338–765 tokens, with Anthropic's tool text · openai 304 chars ≈ 61–122 tokens (estimates: 2.5–5 chars/token, with margin)
anthropic: on steps without tools, realm marks the fixed part for caching unless the drive's --prompt-cache turns it off; a fixed part below the model's minimum is sent uncached, silently
openai: realm sends no cache marker; the provider's own rules decide — see https://developers.openai.com/api/docs/guides/prompt-caching (as of 2026-10-16)
anthropic: the cache is kept per workspace (per organization on Bedrock and Google Cloud), as Anthropic's page said on 2026-10-09: drives from different workspaces each pay the write
```

See [What the loader refuses and warns about](../workflow/loader-diagnostics.md) for every form the output takes, and for the JSON fields.

**Exit code:** 0 if the workflow is accepted; 1 if it is refused, if `--strict` was given and there was a warning, or if neither a path nor `--registered` was given:

```text
Error: provide a workflow path, or --registered <id> to audit a stored definition.
```

### The cache lines

An agent step sends the same text ahead of its input on every call: its profile, Realm's instructions and its schema. A provider can cache that fixed part, but not when it is shorter than the model's minimum, and then it says nothing. `validate`, `register` and `watch` print one `cache:` line for each agent step: the size of its fixed part, the other steps that share it (on OpenAI also a start shared after a profile; none for a step below the minimum), and, when a minimum is known, whether the step can be cached at all. No model is called, and no key is read. These lines were added after version 0.48.0.

The lines below come from the examples in the Realm repository. With no flag, `realm workflow validate examples/01-code-reviewer` gives the size of the request each provider is sent:

```text
cache: review_changes — anthropic 1,010 chars ≈ 422–934 tokens, with Anthropic's tool text · openai 515 chars ≈ 103–206 tokens (estimates: 2.5–5 chars/token, with margin)
```

**How the estimate is made.** Realm has no tokenizer, so the tokens are a range. Realm's own text is counted at 2.5 to 5 characters a token, measured on English text. Text in other scripts counts up to one token a character, an approximation: for such text, pass `--ratio` from your own count. On Anthropic, a step with a schema is sent Realm's tool, and Anthropic adds text of its own to such a request: 220 to 530 tokens, set from measurements on claude-sonnet-4-6 and claude-sonnet-5-5 on 2026-10-27, with margin. The line says `with Anthropic's tool text` where it adds them.

**A minimum.** `--floor <tokens>` tests a minimum of your own. With `--provider` and `--model`, the minimum is the one your [economics file](../cache-economics.md#the-cache-minimum) states for the model. When both give one, `--floor` decides. The line names both only when the numbers differ, as in `(1,000, your --floor; your economics file says 512)`; when they are the same, it names only `--floor`. `cannot cache on it` and `long enough to cache` speak for the model only when the minimum is the economics file's; a minimum given by `--floor` reads `at that minimum`. Each provider's size is then followed by its verdict, here with `--floor 512`:

```text
cache: review_changes — anthropic 1,010 chars ≈ 422–934 tokens, with Anthropic's tool text — near the floor (512, your --floor) · openai 515 chars ≈ 103–206 tokens — below the floor (512, your --floor): this step cannot cache at that minimum
```

A verdict is given only when the whole range is on one side of the minimum. A range that holds the minimum reads `near`, and is not judged. At a 512-token minimum, an Anthropic step with a schema never reads `below`: the high end of Anthropic's tool text alone reaches 530. The verdicts with `--provider`, from examples 01, 04 and 03:

```text
cache: review_changes — 1,010 chars ≈ 422–934 tokens, with Anthropic's tool text (estimate) — below the floor for claude-sonnet-4-6 (1,024, your economics file): this step cannot cache on it
cache: tag_content — 938 chars ≈ 408–905 tokens, with Anthropic's tool text (estimate) — near the floor for claude-sonnet-5-5 (512, your economics file): not judged from an estimate; --ratio <chars-per-token> narrows it
cache: analyze_cause — 1,782 chars ≈ 577–1,244 tokens, with Anthropic's tool text (estimate) — above the floor (512, your --floor): long enough to cache at that minimum when the drive asks for caching
cache: analyze_cause — 1,118 chars ≈ 224–448 tokens (estimate) — above the floor (200, your --floor): within the provider's own rules (realm sends no marker)
```

On OpenAI, a step with `structured_output: strict` and a schema is sent the schema in `response_format`. OpenAI's own text for it is not counted, so a `below` verdict there ends `; by realm's bytes — OpenAI's own schema text is not counted`.

**Your own count.** `--ratio <chars-per-token>` takes your own count: the step's characters as the line prints them, divided by the input tokens the provider counted for one request of the step with a one-character message, tools included. The range is then that count ±15%, and no tool text is added, because your count holds it:

```text
cache: review_changes — 1,010 chars ≈ 220–297 tokens (estimate: 4 chars/token ±15%, your --ratio) — the floor was not judged: no --model named
```

**No verdict.** When no minimum is known, the line says why:

| The line ends                                                                             | When                                                                                                              |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `the floor was not judged: no --model named`                                              | `--provider` is given, with no `--model` and no `--floor`.                                                        |
| `no economics file named in realm.yaml (runner.cache.economics); --floor tests a minimum` | `--model` is given and `realm.yaml` names no economics file.                                                      |
| `economics unreachable: <reason>`, `your economics file: <reason>`                        | The economics file cannot be read, or does not parse.                                                             |
| `no entry for <model> in your economics file`                                             | The economics file has no entry for the model.                                                                    |
| `no minimum stated for <model> in your economics file`                                    | The model's entry has no `min_cacheable_tokens`.                                                                  |
| `economics not checked (<reason>)`                                                        | `--registered`, and the copy records no project folder, or the one it records is gone.                            |
| `profile unavailable (<reason>): sizes not computed`                                      | `--registered`, the step names a profile, and the copy records no workflow folder, or the one it records is gone. |

A step that calls tools is not judged: each tool's definition comes from its MCP server when the step runs, so its request cannot be measured before a run:

```text
cache: fetch_pr — uses tools: each tool's definition comes from its MCP server at run time, so the request cannot be measured before a run: not judged
```

**Steps that share a fixed part.** The line names the other steps whose fixed part is the same as this step's: `shares its whole fixed part with …`. On Anthropic nothing else is named: Anthropic writes its cache entry at the block Realm marks, and a read needs every character up to it, so two steps that part earlier share no entry. On OpenAI, two steps that carry the same profile are named too when they first differ in the schema, which comes after it. The line then says `shares its first <n> chars with …: the schemas differ`. With a minimum in force, they are named only when the estimate of the start they share reaches it or comes near it. On OpenAI the `<n> chars` count Realm's own text after the profile too, so with a short profile most of them are Realm's. The line says what the text shares, not how much of it is yours. No other shared start is named. A step below the minimum names no sharing, because it cannot cache whatever it shares; on OpenAI with `structured_output: strict`, where the provider's own schema text is not counted, the clause stays. The clause comes back with a lower floor or a longer fixed part. Two steps that differ only in `structured_output: strict`, one strict and one not, are not named to each other: a strict step sends a different fixed part. Two identical strict steps still name each other, on both providers; two strict steps with different schemas name nothing. A list of more than six steps names five and ends `and N more`. From example 05, with `--provider anthropic`:

```text
cache: review_security — 954 chars ≈ 411–912 tokens, with Anthropic's tool text (estimate) — the floor was not judged: no --model named — shares its whole fixed part with review_performance
```

After the step lines come the lines that hold for each provider shown, once:

```text
anthropic: on steps without tools, realm marks the fixed part for caching unless the drive's --prompt-cache turns it off; a fixed part below the model's minimum is sent uncached, silently
openai: realm sends no cache marker; the provider's own rules decide — see https://developers.openai.com/api/docs/guides/prompt-caching (as of 2026-10-16)
anthropic: the cache is kept per workspace (per organization on Bedrock and Google Cloud), as Anthropic's page said on 2026-10-09: drives from different workspaces each pay the write
```

The verdict is worked out the same way on every machine: Realm reads no key and no environment variable for it. The lines are printed like any other output, so in a log a value Realm hides elsewhere is hidden in them too. That includes the model id and the word `anthropic` when an environment variable holds the same text, for example `ANTHROPIC_MODEL=claude-sonnet-5-5` or `LLM_PROVIDER=anthropic`: the line then reads `[REDACTED]` where they stood. Realm hides an environment value only when it is 8 characters or more, so `openai` prints whole. In `--json`, both print whole (#885). With `--json`, `validate` gives the same facts in `cacheability`: see [the JSON output](../workflow/loader-diagnostics.md#--json).

`--model` needs `--provider`, `--floor` a whole number of tokens, 1 or more, and `--ratio` a number above 0. Otherwise the command prints one of these lines on standard error and exits with 1, with nothing on standard output, with or without `--json`:

```text
Error: --provider is required with --model: realm does not guess a model's provider. Add --provider anthropic or --provider openai.
Error: --floor must be a whole number of tokens, 1 or more (got '0').
Error: --ratio must be a number of characters per token above 0 (got '0').
```

A flag given last, with nothing after it, and a `--provider` other than `anthropic` or `openai` (in lower case) get the command line parser's own message instead, also on standard error with exit 1 and nothing on standard output: `error: option '--floor <tokens>' argument missing`, or `error: option '--provider <name>' argument 'foo' is invalid. --provider must be openai or anthropic.` A flag followed by an option that takes no value takes that option as its value and gets the line above: `--floor --json` prints `Error: --floor must be a whole number of tokens, 1 or more (got '--json').` With a path given, a flag followed by an option that takes a value is read by the command line parser instead: `--floor --ratio 4` and `--floor --provider anthropic` print `error: too many arguments for 'validate'. Expected 1 argument but got 2: …` (`register` and `watch` name themselves; the path and the value follow). `--provider --floor 5` prints `error: option '--provider <name>' argument '--floor' is invalid. --provider must be openai or anthropic.` Each goes to standard error with exit 1 and nothing on standard output.

## `register`

```text
realm workflow register <path> [flags]
```

Checks the file as `validate` does and, if it is accepted, stores a copy as `~/.realm/workflows/<id>.json`. Runs are started from the stored copy. Registering a workflow that is already registered replaces the copy.

| Flag                        | What it does                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--strict`                  | Stores nothing and exits with 1 if there is any warning.                                                                                |
| `--provider <name>`         | Describes only that provider's request, `anthropic` or `openai`, in the [cache lines](#the-cache-lines).                                |
| `--model <id>`              | The model the runner uses. Needs `--provider`. Its minimum is read from your [economics file](../cache-economics.md#the-cache-minimum). |
| `--floor <tokens>`          | A minimum of your own to judge each agent step against, in tokens.                                                                      |
| `--ratio <chars-per-token>` | Your own count of characters per token, in place of the estimate's range.                                                               |

A project realm of another version ([`REALM_RELEASE_LINE_MISMATCH`](../workflow/loader-diagnostics.md#warning-codes)) is a warning: without `--strict` the workflow is registered and the warning printed; with it, nothing is stored. This was added in 0.46.0.

```bash
realm workflow register invoice-check
```

```text
Registered: invoice-check v1 (2 steps)
cache: step_one — anthropic 588 chars ≈ 338–765 tokens, with Anthropic's tool text · openai 304 chars ≈ 61–122 tokens (estimates: 2.5–5 chars/token, with margin)
anthropic: on steps without tools, realm marks the fixed part for caching unless the drive's --prompt-cache turns it off; a fixed part below the model's minimum is sent uncached, silently
openai: realm sends no cache marker; the provider's own rules decide — see https://developers.openai.com/api/docs/guides/prompt-caching (as of 2026-10-16)
anthropic: the cache is kept per workspace (per organization on Bedrock and Google Cloud), as Anthropic's page said on 2026-10-09: drives from different workspaces each pay the write
```

It prints the [cache lines](#the-cache-lines) after the description line.

The stored copy also holds the text of every agent profile the workflow names, and the folder of the workflow's project. See [Deploy a project](../../guides/deploy.md).

**Exit code:** 0 if the workflow was stored, otherwise 1.

## `watch`

```text
realm workflow watch <path> [flags]
```

Registers the workflow, then registers it again each time the file or one of its profile files changes. It runs until you stop it with Ctrl+C. Each line it prints begins with the time.

| Flag                        | What it does                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--provider <name>`         | Describes only that provider's request, `anthropic` or `openai`, in the [cache lines](#the-cache-lines).                                |
| `--model <id>`              | The model the runner uses. Needs `--provider`. Its minimum is read from your [economics file](../cache-economics.md#the-cache-minimum). |
| `--floor <tokens>`          | A minimum of your own to judge each agent step against, in tokens.                                                                      |
| `--ratio <chars-per-token>` | Your own count of characters per token, in place of the estimate's range.                                                               |

It prints the [cache lines](#the-cache-lines) after the first `Registered` line, and again only when they change.

```text
Watching invoice-check/workflow.yaml — press Ctrl+C to stop
[2026-10-27T16:56:26.020Z] Registered: invoice-check v1 (2 steps)
[2026-10-27T16:56:26.020Z] cache: step_one — anthropic 588 chars ≈ 338–765 tokens, with Anthropic's tool text · openai 304 chars ≈ 61–122 tokens (estimates: 2.5–5 chars/token, with margin)
[2026-10-27T16:56:26.020Z] anthropic: on steps without tools, realm marks the fixed part for caching unless the drive's --prompt-cache turns it off; a fixed part below the model's minimum is sent uncached, silently
[2026-10-27T16:56:26.020Z] openai: realm sends no cache marker; the provider's own rules decide — see https://developers.openai.com/api/docs/guides/prompt-caching (as of 2026-10-16)
[2026-10-27T16:56:26.020Z] anthropic: the cache is kept per workspace (per organization on Bedrock and Google Cloud), as Anthropic's page said on 2026-10-09: drives from different workspaces each pay the write
[2026-10-27T16:56:28.472Z] Registered: invoice-check v1 (2 steps)
[2026-10-27T16:56:30.472Z] Invalid workflow: 'version' must be a number
[2026-10-27T16:56:32.473Z] Registered: invoice-check v2 (2 steps)
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

| Column    | Holds                                                                                                                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ID`      | The workflow's `id`.                                                                                                                                                                                     |
| `NAME`    | Its `name`.                                                                                                                                                                                              |
| `VERSION` | Its `version`.                                                                                                                                                                                           |
| `ORIGIN`  | `human` for a workflow registered from a file; `agent` for one made by `create_workflow`.                                                                                                                |
| `SCHEMA`  | The format of the stored copy, and whether it is the format this version of Realm writes. A copy a later or an older version of Realm registered is never in the table: it is counted under the ⚠ lines. |

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

The text output counts the copies it cannot list on its last line, and names them on standard error, one ⚠ line per kind, each ending ` — realm cannot audit what it cannot read.`:

```text
⚠ 1 file in the registry was registered by a later version of Realm: rec627.json — realm cannot audit what it cannot read.
⚠ 1 file in the registry was registered by an older version of Realm: ancient.json; re-register each from its source (realm workflow register <path-to-workflow>) — realm cannot audit what it cannot read.
```

The other kinds read `could not be read (<errno>)`, `could not be parsed`, `is empty`, `is a directory, not a workflow file` and `is gone`. Added after version 0.47.0 for the later and the older version.

`unreadable` lists stored files that could not be read, each with the reason. `mismatched` lists stored files whose name differs from the `id` inside them. With no workflows registered, the table is empty and the last line reads `0 workflows registered.`

**Exit code:** 0.

## `run`

```text
realm workflow run <path> [flags]
```

Runs the workflow in the terminal, one step at a time, asking you for each step's answer and for each gate's choice. It is meant for trying a workflow while you write it. The workflow does not have to be registered.

| Flag                         | Default            | What it does                                                                                                                                                                                               |
| ---------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--params <json>`            | `{}`               | The run's parameters.                                                                                                                                                                                      |
| `--params-from-run <run-id>` | None               | Starts with the parameters of an earlier run of this workflow, read from that run's record as they were given, not as any output showed them. Cannot be given with `--params`. Added after version 0.47.1. |
| `--extensions-module <path>` | None               | Loads this code file in place of the files named by the workflow's `extensions`.                                                                                                                           |
| `--project <dir>`            | The current folder | The project whose `realm.yaml` applies if the workflow has no project of its own.                                                                                                                          |
| `--mint-writer-nonce`        | Off                | Marks each attempt's trace entries with a fresh identifier.                                                                                                                                                |

`--params-from-run` refuses a run of another workflow (`Error: run '<run-id>' is a run of workflow '<other>', not '<this>'; its params are not this workflow's.`) and refuses to be given with `--params` (`Error: give --params or --params-from-run, not both.`). `realm run abandon` prints a command that uses it.

Parameters given with `--params`, and an answer typed at a step's prompt, are recorded as given. When they hold a mark Realm prints in place of a hidden value, such as `[REDACTED]`, a warning says so: `Warning: This answer holds '[REDACTED]': a value Realm hid when it showed it, sent back. Realm records what was sent, the marker included, so the run now holds the marker, not the value. Send the value itself, or leave the field out. An answer with no marker is recorded as sent.` For an answer typed at a step's prompt, the same sentence is printed indented under the prompt, without `Warning:`. Added after version 0.47.1.

It needs a terminal. Started without one, it creates no run:

```text
Error: dev-mode run is interactive — it prompts on stdin for every step and gate, and stdin here is not a terminal. No run was created. Scripted flows: 'realm workflow test' drives fixtures; 'realm listen' / 'realm agent' are the production drives. To run this workflow by hand, use a real terminal.
```

A step that does not return `ok` prints a line that starts with `✗`, then the reply's status and the reason. When the step that stopped is one the engine ran after the step you answered, the line names it:

```text
  ✗ error (step 'file', run by the engine after 'classify' finished): Handler 'file_ticket' threw: the filing system is down
```

This was added in 0.46.0; version 0.45.0 prints `✗ error: …` without naming the step.

A gate's prompt closes when its question is settled while it waits: by its time running out, when the gate declares an `on_expiry` (this process carries the expiry out and prints its own `⏰` line), or by another process — `realm run respond` from another terminal, `realm run advance`, `realm run drain --expired` or `realm listen`. Those read the workflow from the registry, so they act on the run only once it is registered (`realm workflow register <file>`): for a workflow never registered, `realm run respond`, `realm run advance` and `realm run drain` are refused with `Workflow '<id>' is not registered in this workflow store, …`, and `realm listen` skips the run. It then prints what the run's record holds, in the words of `realm run inspect`, and the run goes on:

```text
  Choice [ship/hold]: ⏰ gate '02ebe774-…' on 'review' had expired 0s before this call — this timer call first carried out its declared settle_default: the default choice 'hold' was recorded (enacted_via: timer).

  This prompt is closed: the question on 'review' is no longer open — Answer: hold · settled by the gate's expiry (no answer in time).
```

When no answer was recorded (an `on_expiry: abort`), the line ends `— no answer was recorded; the run is 'aborted'.` The prompt reads the run's record twice a second while it waits. Added after version 0.46.0, whose prompt stayed open and refused what was typed after the question was settled.

An `auto` step's prompt closes the same way when another process takes or runs that step while the prompt waits (`realm run advance`, `realm agent`, an `execute_step` call): it prints `This prompt is closed: step '<step>' was taken by <program>, and completed; not run here.`, or `… was taken by <program>; not run here.` while the other process still holds it, and goes on. While an agent step's prompt waits, the command holds the step's claim, so no other driver does the step's work: `realm run inspect` shows the step taken by this program (`via run`), `realm agent` waits for it and asks no model, and an `execute_step` call is refused with `Step '<step>' cannot be called now: it is in flight (claimed by another call).` `realm agent` holds nothing while its model works on a step, so on a run this command started (it cannot join a run it did not start), a prompt opened during that call takes the step with no word of the call: if the prompt still holds the step when the model answers, the model's answer is not recorded, and if you then leave the prompt while that drive still waits for the step, its model is asked again. Like any claim on an agent step, it has no time limit: `realm run list --stuck` lists the run (`<step>=claim_unknown_age`) while the prompt waits. The command lets the claim go when you answer (the engine then takes it for the answer), when you leave the prompt, and when it is ended by SIGHUP, SIGINT or SIGTERM (it then exits with 128 plus the signal's number); a command killed outright (SIGKILL) leaves it, and `realm run reclaim <run> --step <step> --force` releases it. When another process takes or runs the step between your answer and the engine's claim for it, the answer is not recorded: `Not run here: step '<step>' was taken by <program>, and completed; the answer typed here was not recorded.` (or `… was taken by <program>; …` while that process holds it) The agent step's prompt closes when another process removed its claim (`This prompt is closed: the claim it held on step '<step>' was removed by another process, and the step has not run.`; the step is asked for again if it is still ready) or the run ended. A step's prompt also closes when another process opens a question: `This prompt is closed: a question is open on '<question step>', and '<step>' waits for its answer.`, and the step is asked for again after the answer. When another process settles the step, takes it over, removes its claim or ends the run while the engine runs it after your answer, the line is the one `realm run advance` prints — `• Step '<step>' was taken by <program>, and completed; this program's outcome for it was not recorded.`, for one — and the command goes on with what is left; never `✗ error:`. While another process holds a step and nothing else is ready, it waits for that process, as `realm agent` does, and says so: `• Step '<step>' is in flight, taken by <program> since <time>: waiting up to 60s for the run's record to change.` When the record changes it runs what is ready; when the record has not changed for 60 seconds it prints `• Step '<step>' has been in flight since <time>, taken by <program>; the record has not changed for 60s. If the program that took it is gone: realm run reclaim <run> --step <step> --force` and hands the run back at that step, with the ways on that fit a step another program is still running: `realm run advance`, once the step is no longer in flight, runs what the engine then owes and names an agent step or a question that is ready. Added after version 0.46.0:

```text
• Step 'sleep' has been in flight since 2026-10-08T12:34:50.336Z, taken by mihai@host (from the OS user, via advance); the record has not changed for 60s. If the program that took it is gone: realm run reclaim 7d1f0c2e-5a8b-4c36-9e21-3b6f8d0a4c17 --step sleep --force
Stopped waiting — detached from run '7d1f0c2e-5a8b-4c36-9e21-3b6f8d0a4c17' at step 'sleep' (phase: running). The run is saved.
  Go on:     once 'sleep' is no longer in flight, realm run advance 7d1f0c2e-5a8b-4c36-9e21-3b6f8d0a4c17
  Inspect:   realm run inspect 7d1f0c2e-5a8b-4c36-9e21-3b6f8d0a4c17
```

The gate's prompt shows the question before its choices: the gate's `message` as it was stored when the gate opened; a gate with no `message` shows none, since the step's `prompt` is never shown as the question. Below it, `Preview:` shows the step's output, through the step's `display` when it has one. Each of its lines is printed as written, with any other control character written as the escape `realm run inspect` writes in its `Message:` line (a tab as `\t`, an escape character as `\u001b`): `Question: Ship it?` for one line, and for more, `Question:` with each line indented below it. Added after version 0.46.0.

Leaving a prompt with Ctrl+D or Ctrl+C keeps the run and says how to carry on:

```text
Prompt cancelled — detached from run '00ac2e9c-6728-4fb4-8ba0-234617eff305' at step 'note' (phase: running). The run is saved.
  Drive it:  realm agent --run-id 00ac2e9c-6728-4fb4-8ba0-234617eff305 --provider <provider> --model <model>
             If a realm workflow run or realm agent is still waiting on this run, it goes on by itself; the line above is for when none is.
  Inspect:   realm run inspect 00ac2e9c-6728-4fb4-8ba0-234617eff305
  Discard:   realm run abandon 00ac2e9c-6728-4fb4-8ba0-234617eff305
```

The lines after the first are the ways on that fit the run as its record stands when you leave. `Drive it` is printed only when an agent step is ready. When the engine owes work, as when you leave an `auto` step's prompt, `Advance:` gives the call that runs it with no model, above `Drive it` when both hold (the line under them then ends `the lines above are for when none is.`), and in place of `Respond` for a question whose time is up and that declares `on_expiry`:

```text
Prompt cancelled — detached from run '5b0c2f4e-8d1a-4e7b-9c63-2a7f1e9d4b80' at step 'fetch' (phase: running). The run is saved.
  Advance:   realm run advance 5b0c2f4e-8d1a-4e7b-9c63-2a7f1e9d4b80 — for what the engine owes ('fetch'), with no model
             If a realm workflow run or realm agent is still waiting on this run, it goes on by itself; the line above is for when none is.
  Inspect:   realm run inspect 5b0c2f4e-8d1a-4e7b-9c63-2a7f1e9d4b80
  Discard:   realm run abandon 5b0c2f4e-8d1a-4e7b-9c63-2a7f1e9d4b80
```

With more than one step owed, the `Advance:` line says where that call stops, as the preview of `realm run advance` does: `— for what the engine owes ('approve', 'fetch'), with no model; it runs them until a step opens a question, fails or ends the run`. A question that can be answered gets `Respond:`, the answer command with the choices as a placeholder to replace, `realm run respond <id> --gate <gate-id> --choice <one of: ship, hold>` (bash and sh refuse to run it as printed), or with the choice itself when the question has only one. Added after version 0.46.0, whose `Respond` line gave the choices as `ship|hold`, which a shell runs as a pipe: pasted, it records the first choice.

`realm run advance` reads the workflow from the registry, as `realm agent` does: register a workflow file never registered first.

When neither holds: a run that cannot go on from here (an `auto` step whose input its schema refuses, left at its prompt, for one) gets the lines `realm run respond` prints for such a run, each step that cannot run and then the way out (for that step, `'<step>' cannot run (input_schema): <why>.`, then — for a step that builds no input from an `input_map` — `'<step>' takes its input from an operator, checked against its input_schema; no realm command supplies it.` (added after version 0.47.0), and `Run <id> stays open (phase 'running'): for '<step>', start a run with params that fit, or correct its input_schema and register the workflow again; then, after a fix, realm run advance <id> — or end it: realm run abandon <id>`; for a step that builds its input with an `input_map`, `for '<step>', correct its input_map or its input_schema and register the workflow again`), then `Inspect`; a step in flight in another program gets the `Go on:` line shown above and `Inspect`; and a run with nothing ready gets `Inspect` and `Discard` alone, as when the command stalls with nothing ready (`Workflow stalled — detached from run …`; a first step whose `when` is never true, for one). When the engine owes work this command does not run — a guard, for one: the command runs only the steps it prompts — it is not stalled: it says `The engine owes '<step>', which this command does not run.`, and the map starts `Engine work owed — detached from run …` and gives the `Advance:` line (added after version 0.46.0). A run that has ended gets `Inspect`, after a `Resume:` line, `realm run resume <id> --from <step>` (`--from <one of: …>` for several), when a step failed that `realm run resume` takes. Added after version 0.46.0, whose map printed `Drive it` whenever no question was open and the run had not ended, and `Inspect` alone for a run that had ended.

Ctrl+C typed at a prompt is a key the prompt reads, so it leaves the prompt as above, with exit code 1. A signal sent to the command, SIGINT (`kill -INT <pid>`) or SIGTERM, is not read by the prompt: the command ends at once and prints nothing, none of the lines above. The run is kept; the `Run ID:` line the command printed when it started names it. A shell shows 128 plus the signal's number as the command's exit code (130 for SIGINT).

To drive the run with `realm agent`, fill in `<provider>` and `<model>` with the provider and model you want: a run started by `realm workflow run` has not been driven by a model. The `Drive it` line also repeats the `--extensions-module`, `--project` and `--mint-writer-nonce` you gave `realm workflow run` (none in this example), as you typed them: run it from the folder you started that command in. If the workflow file was never registered, register it first (`realm workflow register <file>`). Until then the command stops with `Error: Workflow '<id>' is not registered in this workflow store, and the store does not know the file it came from, so no path to it is recorded. …`, and after it the same command drives the run. Version 0.45.0 prints the `Drive it` line without `--provider <provider> --model <model>` and without those flags.

An `auto` step's answer is the one you type, so a step whose input its schema refuses is asked for again — except a step that builds its input with an `input_map` (one with a `handler` or a `uses_service`): its schema checks what the map builds, which no typed answer changes. A step that no typed answer can unblock — a failed precondition, an invalid `trust`, a handler or adapter this program lacks, an input its `input_map` builds that its schema refuses — is not asked for. When nothing else can run, the run stops there, names each such step and gives the way out. Added after version 0.46.0:

```text
Workflow stalled: nothing else can run.
'compute' cannot run (precondition): Precondition failed for step 'compute'. Precondition failed: 'run.params.ok == true'. Resolved value: undefined.
Run 2a319588-0843-41c4-b28b-44f88ecb0752 stays open (phase 'running'): correct the workflow, register it again, then realm run advance 2a319588-0843-41c4-b28b-44f88ecb0752 — or end it: realm run abandon 2a319588-0843-41c4-b28b-44f88ecb0752
```

The last line is `Run complete. Phase: <phase>`. When an engine failure ended the run with a failed step `realm run resume` takes, one more line gives the command that makes it runnable again — `  Resume:    realm run resume <run-id> --from <step>`, the line the detach map gives (added after version 0.46.0). When an operator ended the run, that line is `  Ended:     An operator ended this run, with the reason "<reason>"; to run the work again, start a new run.`, never `realm run resume`, which would erase that ending and its reason. When the ending left cleanup steps `pending`, the next line names the command that runs them: `Cleanup step left pending: '<name>' — to run it with code that has its handler: realm run drain <run-id> --force` (added after version 0.46.0). [Call a service](../../guides/call-a-service.md) shows one.

[Install Realm and run a workflow](../../start/install-and-first-run.md) shows a whole session.

**Exit code:** 0 if the run completed; 1 if it ended in any other way, if nothing else could run, if it stopped waiting for a step another program holds, if you left a prompt with Ctrl+C or Ctrl+D, or if there was no terminal. A signal sent to the command gives 128 plus the signal's number, as above.

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
