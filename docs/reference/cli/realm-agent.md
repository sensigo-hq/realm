# `realm agent`

<!-- description: Reference for realm agent, which drives one run from the command line with a model doing the agent steps: its flags, its output and its exit codes. -->

`realm agent` drives one run from the command line. It asks a model for the answer to each agent step, runs each `auto` step itself, and waits at each human gate. This page lists its 14 flags, what it prints, and its exit codes.

The outputs on this page come from runs of `realm agent` against a local stand-in for the model, which returned answers chosen for the test. Everything on the Realm side is real. For a walk through a first run, see [Run a workflow with `realm agent`](../../guides/realm-agent.md).

The commands on this page that name a provider use Anthropic and the model `claude-sonnet-5-5`; any model Anthropic lists works. With an OpenAI key, use `--provider openai --model <a model from OpenAI's list>` ([OpenAI's models](https://developers.openai.com/api/docs/models)).

## Synopsis

```text
realm agent --workflow <path> --model <model> [--params <json>] [--register] [flags]
realm agent --run-id <id> --model <model> [flags]
```

Give exactly one of `--workflow` and `--run-id`. With `--workflow` it starts a new run from a file. With `--run-id` it continues a run that exists.

Give `--model` too, unless you give `--provider-module`: Realm has no default model. Version 0.45.0 has one (`gpt-4o`, or `claude-sonnet-4-5` for Anthropic).

## Flags

### Which run

| Flag                | Default | What it does                                                                                              |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `--workflow <path>` | None    | Starts a new run of the workflow in this folder or file. The workflow does not have to be registered.     |
| `--run-id <id>`     | None    | Continues this run. The run's workflow must be registered.                                                |
| `--params <json>`   | `{}`    | The new run's parameters. Checked against the workflow's `params_schema`. Cannot be used with `--run-id`. |
| `--register`        | Off     | Also registers the workflow, as `realm workflow register` does, so that the run can be continued later.   |

### Which model

| Flag                       | Default                                               | What it does                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--provider <provider>`    | `openai` if `OPENAI_API_KEY` is set, else `anthropic` | `openai` or `anthropic`. Another word is refused; version 0.45.0 takes any other word as `anthropic`.                                                                                                                                                                                                                                |
| `--model <model>`          | None. Required, unless `--provider-module` is given.  | The model's name, as the provider knows it ([Anthropic's models](https://platform.claude.com/docs/en/models/overview), [OpenAI's models](https://developers.openai.com/api/docs/models)). A name that is empty or holds only spaces counts as missing. Version 0.45.0 has a default: `gpt-4o`, or `claude-sonnet-4-5` for Anthropic. |
| `--base-url <url>`         | The provider's own address                            | Sends requests to another service that speaks the OpenAI chat-completions format. Only with `openai`.                                                                                                                                                                                                                                |
| `--strict-base-url`        | Off                                                   | States that the service at `--base-url` enforces strict structured output. See [Agent-step controls](../workflow/agent-step-controls.md#structured_output).                                                                                                                                                                          |
| `--provider-module <path>` | None                                                  | Uses your own provider, loaded from this code file. Cannot be combined with the four flags above.                                                                                                                                                                                                                                    |

### How steps are run

| Flag                         | Default            | What it does                                                                                                |
| ---------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `--schema-retries <n>`       | `2`                | How many times the model is asked again when its answer does not fit the step's schema. `0` turns this off. |
| `--llm-timeout <seconds>`    | `600`              | The longest one request to the model may take. A step's own `llm_timeout_seconds` takes precedence.         |
| `--mint-writer-nonce`        | Off                | Gives each attempt of a step a fresh identifier, which Realm records with the attempt's trace entries.      |
| `--project <dir>`            | The current folder | The project whose `realm.yaml` applies if the workflow has no project of its own.                           |
| `--extensions-module <path>` | None               | Loads this code file in place of the files named by the workflow's `extensions`.                            |

## Environment variables

| Variable             | What it does                                                             |
| -------------------- | ------------------------------------------------------------------------ |
| `OPENAI_API_KEY`     | The key for OpenAI, and for a service at `--base-url`.                   |
| `ANTHROPIC_API_KEY`  | The key for Anthropic.                                                   |
| `ANTHROPIC_BASE_URL` | Sends Anthropic requests to another address. Read by Anthropic's client. |

One of the two keys must be set, unless `--provider-module` is given. If both are set and `--provider` is not given, OpenAI is used. With either key, `--model` is required. When you name a provider with `--provider`, its own key must be set.

A key that is empty or holds only spaces counts as not set, both for choosing the provider and in the messages below. Version 0.45.0 counted it as set: with `OPENAI_API_KEY=` and an Anthropic key, it picked OpenAI.

The key and the model are needed even for a workflow in which no step calls a model: `realm agent` checks its flags before it reads the workflow.

## What it prints

```bash
realm agent --workflow ./ --register --params '{"ticket":"I was charged twice this month."}' --provider anthropic --model claude-sonnet-5-5
```

```text
Realm Agent — Reply to a ticket v1
Run ID: 50e31961-baec-4e4e-ae6a-ef0af3754761

→ [auto] fetch
  ✓ → running

→ [agent] classify
  Classify the ticket and say how urgent it is.

⏸  Gate: classify | ID: 8fd100bb-116e-44b7-80cf-3ed3eab5ed42

   {
     "category": "billing",
     "urgent": true,
     "reason": "The customer was charged twice this month."
   }

   Send: realm run respond 50e31961-baec-4e4e-ae6a-ef0af3754761 --gate 8fd100bb-116e-44b7-80cf-3ed3eab5ed42 --choice send
   Discard: realm run respond 50e31961-baec-4e4e-ae6a-ef0af3754761 --gate 8fd100bb-116e-44b7-80cf-3ed3eab5ed42 --choice discard
   Waiting for approval...
→ [auto] file
  ✓ → completed

Run complete: 50e31961-baec-4e4e-ae6a-ef0af3754761

Result (classify):
{
  "category": "billing",
  "urgent": true,
  "reason": "The customer was charged twice this month."
}
```

| Line                                                                                         | Printed when                                                                                     | Holds                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Realm Agent — <name> v<version>`                                                            | At the start                                                                                     | The workflow.                                                                                                                                                                                   |
| `Run ID`                                                                                     | At the start                                                                                     | The run, new or continued.                                                                                                                                                                      |
| `→ [agent] <step>` or `→ [auto] <step>`                                                      | A step starts                                                                                    | The step, and under an agent step its `description`.                                                                                                                                            |
| `✓ → <phase>`                                                                                | A step completes                                                                                 | The run's phase after it.                                                                                                                                                                       |
| `• Step '<step>' cannot run (<check>): <why>`                                                | An `auto` step cannot run                                                                        | Printed once per drive; the drive goes on with any agent step that is ready. See below. Added after version 0.46.0.                                                                             |
| `⚠ output rejected (<code>); repairing (attempt n/m)`                                        | The model's answer was refused and it is asked again                                             | The error code, and which of the `--schema-retries` attempts this is.                                                                                                                           |
| `⏸  Gate: <step> \| ID: <gate-id>`                                                           | The run reaches a human gate                                                                     | The answer waiting for approval, then one `realm run respond` command for each choice.                                                                                                          |
| `⚠ gate '<gate>' on '<step>' had expired — this agent call first carried out its declared …` | The run reaches a question whose time is already up and whose `on_expiry` the engine carries out | The expiry it carried out, in place of the gate's lines: such a question is not shown, since an answer could no longer be recorded. Added after version 0.46.0.                                 |
| `Run complete: <run-id>`                                                                     | The run completes                                                                                | The run.                                                                                                                                                                                        |
| `Result (<step>)`                                                                            | The run completes                                                                                | The last agent step's answer, through that step's `display` template if it has one, otherwise as JSON. When another program gave it: `Result (<step>) — given by <program>, not by this drive`. |
| `✗ Step '<step>' …`, `✗ The drive stops: …`, `⚠ Step '<step>' is blocked …`                  | The run cannot go on                                                                             | The reason: a step that failed, a step refused before its claim with nothing else to run, or a handler or adapter this program has not registered. See [When it stops](#when-it-stops).         |

At a gate, `realm agent` waits until the gate is answered, by `realm run respond` from another terminal or by any other means, and then carries on: it runs the guards and `auto` steps the answer leaves owed (each `auto` step as `→ [auto] <step>`), then the next agent step. Running the owed steps after the answer was added after version 0.46.0.

An `auto` step that cannot run is named once per drive with the check that refused it: `• Step '<step>' cannot run (<check>): <why>` for an invalid `trust`, a failed precondition or an input its schema rejects (the refusal names the field and what it must be, or the property the schema does not allow), and `• Step '<step>' cannot run here (capability): <why>` for a handler or adapter this program has not registered — judged with this program's own extensions. The drive goes on with any agent step that is ready. A step refused before its claim is never submitted. A step whose handler or adapter is missing is attempted once by each drive (`→ [auto] <step>`), and each attempt adds an evidence entry and rewrites the step's entry in the run's `capability_blocks`: the first drive of a run attempts it as soon as it is owed, before any agent step that is ready; a later drive, once the run's record holds the block, attempts it only when it has nothing else to run; see [When it stops](#when-it-stops). When such a step comes right after an agent step, the agent step's call reaches it first: the agent step is said as completed (`✓ → running`), the step is named once, the drive goes on with any agent step that is ready, and its stop names that step and what it needs — never the agent step. This paragraph was added after version 0.46.0. If the project's `realm.yaml` sets up Slack, the gate is also posted there. See [Answer gates from Slack](../../guides/slack-gates.md).

An agent step that is refused before its claim — a failed precondition, or an invalid `trust` in a registered copy the loader never checked — is named the same way, `• Step 'ask' cannot run (precondition): Precondition failed for step 'ask'. …`, and is never sent to the model; when nothing else can run the drive stops on it (see [When it stops](#when-it-stops)). A `blocked` reply is never followed by `✓`: an `auto` step another process took between the drive's read and the engine's is said as taken (`• Step '<step>' was taken by …; not run here.`), and an agent step as below; when another process opened a gate or ended the run in that moment, the drive goes on as it does at any gate or end (it waits at the gate, or prints `Run ended in phase: <phase>`); any other `blocked` reply prints its own reason (`✗ Precondition failed for step 'ask'.`) and stops the drive with exit code 1. Added after version 0.46.0, which asks the model for such a step again and again, printing `✓ → running` each time.

When another process's answer to an agent step reaches the engine before the drive's own, the drive never prints `✓` for it: the line says the drive's answer was not recorded — `• Step '<step>' was taken by <program> at <time>; this drive's answer was not recorded.` while the other process holds the step, `• Step '<step>' was taken by <program>, and completed; this drive's answer was not recorded.` (or `and failed`) once it ran the step, also when that ended the run, and `• Step '<step>' was not run: the run ended (<phase>) before this drive's answer reached it; the answer was not recorded.` when the run ended without it. When the run completes, its `Result` line names the program that gave an answer this drive did not: `Result (<step>) — given by <program>, not by this drive:`. When nothing else is ready and another process holds a step, the drive says so — `• Step '<step>' is in flight, taken by <program> since <time>: waiting up to 60s for the run's record to change.` — and goes on when the record changes; after 60 seconds with no change it prints `• Step '<step>' has been in flight since <time>, taken by <program>; the record has not changed for 60s. If the program that took it is gone: realm run reclaim <run> --step <step> --force`, then the way on once that program is done with the step, `  Go on:     once '<step>' is no longer in flight, realm agent --run-id <run> <flags>` (with the flags this drive was started with, as the re-attach command in [When it stops](#when-it-stops) repeats them), and stops with exit code 1, the run still open. While `realm workflow run` waits at an agent step's prompt, it holds that step: the drive waits for it and asks no model. The drive itself holds nothing while its model works on a step: on a run that `realm workflow run` started (it cannot join a run it did not start), a prompt it opens during the model call takes the step; if the prompt still holds it when the model answers, the model's answer is not recorded (`• Step '<step>' was taken by <program> at <time>; this drive's answer was not recorded.`), and the drive then waits for the step as for any step another process holds — when the prompt lets it go unanswered, the model is asked for it again. Added after version 0.46.0, which asked the model and printed `✓ → completed` for an answer another process gave first.

When the `@sensigo/realm` the workflow's code imports is not the version the command runs, the command prints [`REALM_RELEASE_LINE_MISMATCH`](../workflow/loader-diagnostics.md#warning-codes) to stderr once per copy and goes on. This was added in 0.46.0.

## When it stops

`realm agent` stops with exit code 1 when a step cannot be completed. The line that starts with `✗` (`⚠` for a missing handler or adapter) gives the reason:

| Case                                                                        | Line                                                                                                                                                                                                                                                                    | The run afterwards  |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| The model's answer was refused every time                                   | `✗ Step 'classify' failed: Invalid input for step 'classify' after 1 schema-repair attempts`                                                                                                                                                                            | Open, in `running`. |
| The same, with `--schema-retries 0`                                         | `✗ Step 'classify' failed: Invalid input for step 'classify'`                                                                                                                                                                                                           | Open, in `running`. |
| The provider could not be reached                                           | `✗ Step 'classify' LLM call failed: Connection error.`                                                                                                                                                                                                                  | Open, in `running`. |
| A request took longer than `--llm-timeout`                                  | `✗ Step 'classify' LLM call failed: Request timed out.`                                                                                                                                                                                                                 | Open, in `running`. |
| The provider refused the request                                            | `✗ Step 'classify' LLM call failed: 401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}`                                                                                                                     | Open, in `running`. |
| The provider has no model by that name                                      | `✗ Step 'classify' LLM call failed: 404 {"type":"error","error":{"type":"not_found_error", …`                                                                                                                                                                           | Open, in `running`. |
| An `auto` step the drive called failed                                      | `✗ Step 'file' failed: Handler 'file_ticket' threw: the filing system is down`                                                                                                                                                                                          | Ended, in `failed`. |
| An `auto` step the engine ran after it failed                               | `✗ Step 'file' (run by the engine after 'classify' finished) failed: Handler 'file_ticket' threw: the filing system is down`                                                                                                                                            | Ended, in `failed`. |
| Nothing else can run, and an `auto` step is refused before it is claimed    | `✗ The drive stops: nothing else can run, and 'file' cannot run (input_schema). Run 50e31961-… stays open (phase 'running'): correct the workflow, register it again, then realm run advance 50e31961-…; or end it: realm run abandon 50e31961-….`                      | Open, in `running`. |
| Nothing else can run, and an agent step is refused before it is claimed     | `✗ The drive stops: nothing else can run, and 'ask' cannot run (precondition). Run f0fef02d-… stays open (phase 'running'): correct the workflow, register it again, then realm run advance f0fef02d-…; or end it: realm run abandon f0fef02d-….`                       | Open, in `running`. |
| Nothing else can run, and an `auto` step needs a handler this program lacks | ``⚠ Step 'file' is blocked: handler 'file_ticket' is not registered in this runner. The run is NOT failed — add handler 'file_ticket' and re-attach (`realm agent --run-id b179423b-… --provider anthropic --model claude-sonnet-5-5 --extensions-module ./ext.mjs`).`` | Open, in `running`. |

When the step that stopped is one the engine ran after the step the drive called, the line names it and adds `(run by the engine after '<step>' finished)`, as in the eighth row. This was added in 0.46.0; version 0.45.0 names the step the drive called there. The last three rows were added after version 0.46.0 (the agent-step row: 0.46.0 never stops on that step, see above), which prints `✗ Step 'file' (run by the engine after 'classify' finished) failed: Invalid input for step 'file'` for an input its schema refuses, and stops the drive at once on a missing handler. When the run ended with a failed step `realm run resume` takes, one more line gives the command that makes it runnable again, `  Resume:    realm run resume <run-id> --from <step>` (added after version 0.46.0): run it once the step's cause is fixed, then `realm agent --run-id <run-id>` with the flags you drove it with.

The lines that say why the drive stopped (`✗ Step …` and `⚠ Step … is blocked`) go to stderr, and so do the `Resume:` line after them and `Run ended in phase: <phase>`, which the drive prints instead when it ends with neither line and the run not completed (for example, a guard aborted it) — except when it stops on a step another process holds, whose `Go on:` line (above) is the last. The progress lines go to stdout. Keep both streams to keep the reason with the rest.

In the first six cases nothing was recorded as the step's answer. The run's record keeps the failure under `Drive failures`, and `realm run list --stuck` lists the run with `drive_failing` and the kind of failure. Continue the run with `--run-id` when the cause is fixed.

In the ninth case, when the check is `input_schema`, the step's schema refused the input the engine built for it. The run's record keeps the refusal under `Drive failures`. Change the step so it accepts that input, register the workflow again, and continue with `--run-id`.

A step that needs a handler or adapter `realm agent` was not given also stops the drive with exit code 1, with a line that starts with `⚠`. When it starts a run with `--workflow`, Realm warns about such a step first. The run stays open, in `running`. Handlers and adapters come from the project's extensions ([Project extensions](../project-extensions.md)) or from `--extensions-module`. Here the drive was started with `--extensions-module ./ext.mjs`, and its step `publish` needs a handler `publish_answer` that the module does not have:

```text
⚠ Step 'publish' needs handler 'publish_answer', which is not registered in this runner. If reached it will block recoverably (not fail) until a runner that provides this handler executes it — load the missing extension or run on a capable runner.

⚠ Step 'publish' is blocked: handler 'publish_answer' is not registered in this runner. The run is NOT failed — add handler 'publish_answer' and re-attach (`realm agent --run-id d1a87150-33b5-4126-86c2-60350446794d --provider anthropic --model claude-sonnet-5-5 --extensions-module ./ext.mjs`).
```

The re-attach command repeats the flags the drive was started with: the model flags, `--extensions-module`, `--project`, `--schema-retries` when it is not 2, `--llm-timeout` and `--mint-writer-nonce`; it leaves out `--workflow`, `--params` and `--register`. Run it from the folder you started the drive in: paths are repeated as you typed them, and `realm agent` reads that folder's `.env`. If the drive was started with `--extensions-module`, add the handler to that module: the command repeats the flag, and the flag replaces the workflow's own `extensions`. Otherwise, if you add an `extensions` entry to the workflow file, register the workflow again before you re-attach: `--run-id` uses the registered copy. For a run created from a file without `--register`, register the workflow first; until then the command stops with `Error: Workflow not found: …`. Version 0.45.0 prints `realm agent --run-id <run-id>` alone. When the blocked step comes right after an agent step, the agent step is said as completed (`✓ → running`), the blocked step is named once (`• Step 'publish' cannot run here (capability): handler 'publish_answer' is not registered here — load the missing extension, or run the step on a runner that has it`), the drive goes on with any agent step that is ready, and its stop is the line above, naming `publish`. Added after version 0.46.0, which stops the drive at once with `⚠ Step 'publish' (run by the engine after 'classify' finished) is blocked: handler 'publish_answer' is not registered in this runner. …`; version 0.45.0 names the step the drive called there, and says "the missing handler".

When Anthropic answers that it has no model by the name given, `realm agent` prints a second line under the failure line. With `--model claude-sonnet-4-5`, against a stand-in that answers as Anthropic does:

```text
✗ Step 'classify' LLM call failed: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-4-5"},"request_id":"req_stand_in"}
  Anthropic offers no model named claude-sonnet-4-5 to this API key. Check the name given to --model; current models are listed at https://platform.claude.com/docs/en/models/overview and retired ones at https://platform.claude.com/docs/en/about-claude/model-deprecations.
```

The second line was added in 0.46.0. With OpenAI, the failure line is printed alone. The run stays open: continue it with `--run-id` and the right `--model`.

A request that times out is tried again by the provider's client. With `--llm-timeout 1` and a model that took 3 seconds, the step stopped after 4.5 seconds, on the third request:

```text
Drive failures:
  2026-10-04T23:48:33.237Z  classify  anthropic  connection_timeout after 4530ms: Request timed out. (declared 1000ms) (ceiling 64500ms) (attempt 3)
```

## Your own provider

`--provider-module` takes a code file whose default export is an object of a class that extends `LlmProvider`. The `LlmProvider` must come from the same realm version as the `realm` command (on version 0.45.0, from the same copy as the command): see [Which realm your code imports](../project-extensions.md#which-realm-your-code-imports). The import below needs `@sensigo/realm-cli` installed in the project. The class has one method to write, `callStep`, which is given the step's prompt, its schema and its profile's text, and returns the answer as an object:

```js
import { LlmProvider } from '@sensigo/realm-cli/agent';

class FixedProvider extends LlmProvider {
  async callStep(prompt, inputSchema, agentProfileInstructions) {
    return { category: 'how_to', urgent: false, reason: 'Answered by my own provider.' };
  }
}

export default new FixedProvider();
```

```bash
realm agent --workflow ./ --params '{"ticket":"I was charged twice this month."}' --provider-module ../my-provider.mjs
```

```text
→ [agent] classify
  Classify the ticket and say how urgent it is.
  ✓ → completed

Run complete: 79b101f5-aad9-427c-9721-e8a53eba61b1

Result (classify):
how_to (urgent: false)
Answered by my own provider.
```

No API key is needed. The answer is checked against the step's schema like any other. To drive steps that use tools, extend `ToolCapableLlmProvider` and write `callStepWithTools` as well.

A provider can also explain a failure. `LlmProvider` has an optional method, `explainFailure(err)`: when a model call throws, `realm agent` calls it with the error, and prints the sentence it returns on its own line under the failure line. Return one plain sentence for an error your provider recognises, and `undefined` for any other. The method must not throw: Realm ignores a throw, and a sentence that is empty or holds only spaces, and prints the failure line alone. The method was added in 0.46.0.

## Exit codes

| Code | When                                                                                       |
| ---- | ------------------------------------------------------------------------------------------ |
| 0    | The run completed.                                                                         |
| 1    | The run ended in any other way, a step could not be completed, or the command was refused. |

A command that is refused creates no run. The refusals:

| Case                                                                                | Message                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Neither `--workflow` nor `--run-id`                                                 | `Error: one of --workflow or --run-id is required`                                                                                                                                                                                                                                                                                                               |
| Both                                                                                | `Error: --workflow and --run-id are mutually exclusive`                                                                                                                                                                                                                                                                                                          |
| `--params` with `--run-id`                                                          | `Error: --params cannot be used with --run-id; the run already has params from creation time`                                                                                                                                                                                                                                                                    |
| `--params` is not JSON                                                              | `Error: Unexpected token 'o', "not json" is not valid JSON`                                                                                                                                                                                                                                                                                                      |
| The parameters do not fit `params_schema`                                           | `Error: Invalid params for workflow 'triage': /ticket must be string`                                                                                                                                                                                                                                                                                            |
| The workflow file is not there                                                      | `Error: Failed to read workflow file: ENOENT: no such file or directory, open 'nowhere/workflow.yaml'`                                                                                                                                                                                                                                                           |
| The run is not in the store                                                         | `Error: Run not found: abc`                                                                                                                                                                                                                                                                                                                                      |
| The run has ended                                                                   | `Error: Run 487908d6-… is already in terminal state: Workflow completed..`                                                                                                                                                                                                                                                                                       |
| The run's workflow is not registered                                                | `Error: Workflow not found: triage — most often this run was created from a file without --register. …`                                                                                                                                                                                                                                                          |
| No key is set, and no `--provider`                                                  | `Error: realm agent requires an LLM API key. Set OPENAI_API_KEY or ANTHROPIC_API_KEY. Nothing was started.`                                                                                                                                                                                                                                                      |
| No key is set, with `--provider anthropic` (added in 0.46.0)                        | `Error: realm agent requires an LLM API key: --provider anthropic was given, and ANTHROPIC_API_KEY is not set or is empty. Set ANTHROPIC_API_KEY. Nothing was started.`                                                                                                                                                                                          |
| No key is set, with `--provider openai` (added in 0.46.0)                           | `Error: realm agent requires an LLM API key: --provider openai was given, and OPENAI_API_KEY is not set or is empty. Set OPENAI_API_KEY. Nothing was started.`                                                                                                                                                                                                   |
| `--provider anthropic`, and `ANTHROPIC_API_KEY` is not set (added in 0.46.0)        | `Error: --provider anthropic was given, but ANTHROPIC_API_KEY is not set or is empty (only OPENAI_API_KEY is set). Set ANTHROPIC_API_KEY, or use --provider openai with an OpenAI model. Nothing was started.`                                                                                                                                                   |
| `--provider openai`, and `OPENAI_API_KEY` is not set (added in 0.46.0)              | `Error: --provider openai was given, but OPENAI_API_KEY is not set or is empty (only ANTHROPIC_API_KEY is set). Set OPENAI_API_KEY, or use --provider anthropic with an Anthropic model. Nothing was started.`                                                                                                                                                   |
| `--base-url` with Anthropic                                                         | `Error: --base-url is only supported with --provider openai (or OpenAI-compatible endpoints). For Anthropic, configure the endpoint via the ANTHROPIC_BASE_URL environment variable. Nothing was started.`                                                                                                                                                       |
| No `--model`, with `--base-url` (added in 0.46.0)                                   | `Error: --model is required: realm has no default model. Name the model the service at --base-url offers. Nothing was started.`                                                                                                                                                                                                                                  |
| No `--model`, with `--provider anthropic` (added in 0.46.0)                         | `Error: --model is required: realm has no default model. Name an Anthropic model; Anthropic lists them at https://platform.claude.com/docs/en/models/overview. Nothing was started.`                                                                                                                                                                             |
| No `--model`, with `--provider openai` (added in 0.46.0)                            | `Error: --model is required: realm has no default model. Name an OpenAI model; OpenAI lists them at https://developers.openai.com/api/docs/models. Nothing was started.`                                                                                                                                                                                         |
| No `--model` and no `--provider`, only `ANTHROPIC_API_KEY` is set (added in 0.46.0) | `Error: --model is required: realm has no default model. ANTHROPIC_API_KEY is set, so the provider is Anthropic; name one of its models (Anthropic lists them at https://platform.claude.com/docs/en/models/overview). Nothing was started.`                                                                                                                     |
| No `--model` and no `--provider`, only `OPENAI_API_KEY` is set (added in 0.46.0)    | `Error: --model is required: realm has no default model. OPENAI_API_KEY is set, so the provider is OpenAI; name one of its models (OpenAI lists them at https://developers.openai.com/api/docs/models). Nothing was started.`                                                                                                                                    |
| No `--model` and no `--provider`, both keys are set (added in 0.46.0)               | `Error: --model is required: realm has no default model. Both OPENAI_API_KEY and ANTHROPIC_API_KEY are set, so the provider is OpenAI; name one of its models (OpenAI lists them at https://developers.openai.com/api/docs/models), or choose Anthropic with --provider anthropic. Nothing was started.`                                                         |
| `--provider` is not `openai` or `anthropic` (added in 0.46.0)                       | `error: option '--provider <provider>' argument 'antropic' is invalid. --provider must be openai or anthropic.`                                                                                                                                                                                                                                                  |
| `--provider-module` with a model flag                                               | `Error: --provider-module cannot be combined with --provider, --model, --base-url, or --strict-base-url`                                                                                                                                                                                                                                                         |
| The module does not export a provider                                               | `Error: provider module default export must be an instance extending LlmProvider.`                                                                                                                                                                                                                                                                               |
| Its `LlmProvider` comes from another realm-cli version (added in 0.46.0)            | `Error: the provider module's LlmProvider comes from @sensigo/realm-cli 0.46.1 (…); this realm command is @sensigo/realm-cli 0.46.0 (…). Realm objects do not cross versions. Run realm 0.46.1 in the project: npm install --save-dev @sensigo/realm-cli@0.46.1, then npx realm; or install @sensigo/realm-cli@0.46.0 and @sensigo/realm@0.46.0 in the project.` |
| The module cannot be loaded                                                         | `Error: failed to import provider module '../none.mjs': Cannot find module '/srv/shop/none.mjs' …`                                                                                                                                                                                                                                                               |
| `--schema-retries` is not a whole number, 0 or more                                 | `error: option '--schema-retries <n>' argument 'x' is invalid. --schema-retries must be a non-negative integer.`                                                                                                                                                                                                                                                 |
| `--llm-timeout` is not a whole number above 0                                       | `error: option '--llm-timeout <seconds>' argument '0' is invalid. --llm-timeout must be a positive integer number of seconds.`                                                                                                                                                                                                                                   |

In the row about a provider from another realm-cli version, the project's realm-cli is a copy of 0.46.0 given the version number 0.46.1 for this example.

The refusals about the API keys, `--base-url` and `--model` end `Nothing was started.` with `--workflow`, as shown. After `--run-id`, they end `If run <run-id> exists, it was not changed.` instead. Realm checks these flags before it reads the run, so a mistyped run id is reported as not found once the flags are right. Both closing sentences were added in 0.46.0. A `--model` that is empty or holds only spaces gets the same refusal as a missing one.

`--strict-base-url` without `--base-url` is not refused. It prints `⚠ --strict-base-url has no effect without --base-url …` and carries on.

## See also

- [Run a workflow with `realm agent`](../../guides/realm-agent.md)
- [Give an agent step tools](../../guides/agent-tools.md)
- [Agent-step controls](../workflow/agent-step-controls.md)
- [`realm run`: commands that act](realm-run-acting.md) covers `respond`.
- [`realm listen`](realm-listen.md) starts `realm agent` for each webhook.
