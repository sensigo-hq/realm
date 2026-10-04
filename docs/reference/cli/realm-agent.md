# `realm agent`

`realm agent` drives one run from the command line. It asks a model for the answer to each agent step, runs each `auto` step itself, and waits at each human gate. This page lists its 14 flags, what it prints, and its exit codes.

The outputs on this page come from runs of `realm agent` against a local stand-in for the model, which returned answers chosen for the test. Everything on the Realm side is real. For a walk through a first run, see [Run a workflow with `realm agent`](../../guides/realm-agent.md).

## Synopsis

```text
realm agent --workflow <path> [--params <json>] [--register] [flags]
realm agent --run-id <id> [flags]
```

Give exactly one of `--workflow` and `--run-id`. With `--workflow` it starts a new run from a file. With `--run-id` it continues a run that exists.

## Flags

### Which run

| Flag                | Default | What it does                                                                                              |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `--workflow <path>` | None    | Starts a new run of the workflow in this folder or file. The workflow does not have to be registered.     |
| `--run-id <id>`     | None    | Continues this run. The run's workflow must be registered.                                                |
| `--params <json>`   | `{}`    | The new run's parameters. Checked against the workflow's `params_schema`. Cannot be used with `--run-id`. |
| `--register`        | Off     | Also registers the workflow, as `realm workflow register` does, so that the run can be continued later.   |

### Which model

| Flag                       | Default                                               | What it does                                                                                                                                                |
| -------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--provider <provider>`    | `openai` if `OPENAI_API_KEY` is set, else `anthropic` | `openai` or `anthropic`.                                                                                                                                    |
| `--model <model>`          | `gpt-4o`, or `claude-sonnet-4-5` for Anthropic        | The model's name, as the provider knows it.                                                                                                                 |
| `--base-url <url>`         | The provider's own address                            | Sends requests to another service that speaks the OpenAI chat-completions format. Only with `openai`.                                                       |
| `--strict-base-url`        | Off                                                   | States that the service at `--base-url` enforces strict structured output. See [Agent-step controls](../workflow/agent-step-controls.md#structured_output). |
| `--provider-module <path>` | None                                                  | Uses your own provider, loaded from this code file. Cannot be combined with the four flags above.                                                           |

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

One of the two keys must be set, unless `--provider-module` is given. If both are set and `--provider` is not given, OpenAI is used.

## What it prints

```bash
realm agent --workflow ./ --register --params '{"ticket":"I was charged twice this month."}'
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

| Line                                                  | Printed when                                         | Holds                                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Realm Agent — <name> v<version>`                     | At the start                                         | The workflow.                                                                                          |
| `Run ID`                                              | At the start                                         | The run, new or continued.                                                                             |
| `→ [agent] <step>` or `→ [auto] <step>`               | A step starts                                        | The step, and under an agent step its `description`.                                                   |
| `✓ → <phase>`                                         | A step completes                                     | The run's phase after it.                                                                              |
| `• Step '<step>' cannot run (<check>): <why>`         | An `auto` step cannot run                            | Printed once per drive; the drive goes on with any agent step that is ready. See below.                |
| `⚠ output rejected (<code>); repairing (attempt n/m)` | The model's answer was refused and it is asked again | The error code, and which of the `--schema-retries` attempts this is.                                  |
| `⏸  Gate: <step> \| ID: <gate-id>`                    | The run reaches a human gate                         | The answer waiting for approval, then one `realm run respond` command for each choice.                 |
| `Run complete: <run-id>`                              | The run completes                                    | The run.                                                                                               |
| `Result (<step>)`                                     | The run completes                                    | The last agent step's answer, through that step's `display` template if it has one, otherwise as JSON. |
| `✗ Step '<step>' …`                                   | The run cannot go on                                 | The reason. See [When it stops](#when-it-stops).                                                       |

At a gate, `realm agent` waits until the gate is answered, by `realm run respond` from another terminal or by any other means, and then carries on: it runs the guards and `auto` steps the answer leaves owed (`→ [auto] <step>`), then the next agent step.

An `auto` step that cannot run is named once with the check that refused it: `• Step '<step>' cannot run (<check>): <why>` for an invalid `trust`, a failed precondition or an input its schema rejects (the refusal names the field and what it must be), and `• Step '<step>' cannot run here (capability): <why>` for a handler or adapter this program has not registered. The step is not run, and the drive goes on with any agent step that is ready. If the project's `realm.yaml` sets up Slack, the gate is also posted there. See [Answer gates from Slack](../../guides/slack-gates.md).

When the `@sensigo/realm` the workflow's code imports is not the version the command runs, the command prints [`REALM_RELEASE_LINE_MISMATCH`](../workflow/loader-diagnostics.md#warning-codes) to stderr once per copy and goes on. This was added after version 0.45.0.

## When it stops

`realm agent` stops with exit code 1 when a step cannot be completed. The line that starts with `✗` (`⚠` for a missing handler or adapter) gives the reason:

| Case                                                                        | Line                                                                                                                                                                                       | The run afterwards  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| The model's answer was refused every time                                   | `✗ Step 'classify' failed: Invalid input for step 'classify' after 1 schema-repair attempts`                                                                                               | Open, in `running`. |
| The same, with `--schema-retries 0`                                         | `✗ Step 'classify' failed: Invalid input for step 'classify'`                                                                                                                              | Open, in `running`. |
| The provider could not be reached                                           | `✗ Step 'classify' LLM call failed: Connection error.`                                                                                                                                     | Open, in `running`. |
| A request took longer than `--llm-timeout`                                  | `✗ Step 'classify' LLM call failed: Request timed out.`                                                                                                                                    | Open, in `running`. |
| The provider refused the request                                            | `✗ Step 'classify' LLM call failed: 401 Incorrect API key provided: …`                                                                                                                     | Open, in `running`. |
| An `auto` step failed                                                       | `✗ Step 'file' failed: Handler 'file_ticket' threw: the filing system is down`                                                                                                             | Ended, in `failed`. |
| Nothing else can run, and an `auto` step is refused before it is claimed    | `✗ The drive stops: nothing else can run, and 'file' cannot run (input_schema). Run 50e31961-… stays open (phase 'running'); to end it: realm run abandon 50e31961-….`                     | Open, in `running`. |
| Nothing else can run, and an `auto` step needs a handler this program lacks | ``⚠ Step 'file' is blocked: handler 'file_ticket' is not registered in this runner. The run is NOT failed — add handler 'file_ticket' and re-attach (`realm agent --run-id 50e31961-…`).`` | Open, in `running`. |

In the first five cases nothing was recorded as the step's answer. The run's record keeps the failure under `Drive failures`, and `realm run list --stuck` lists the run with `drive_failing` and the kind of failure. Continue the run with `--run-id` when the cause is fixed.

A request that times out is tried again by the provider's client. With `--llm-timeout 1` and a model that took 3 seconds, the step stopped after 4.4 seconds, on the third request:

```text
Drive failures:
  2026-10-01T23:21:14.092Z  classify  openai  connection_timeout after 4392ms: Request timed out. (declared 1000ms) (ceiling 64500ms) (attempt 3)
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
| No key is set                                                                       | `Error: realm agent requires an LLM API key. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.`                                                                                                                                                                                                                                                                           |
| `--base-url` with Anthropic                                                         | `Error: --base-url is only supported with --provider openai (or OpenAI-compatible endpoints). For Anthropic, configure the endpoint via the ANTHROPIC_BASE_URL environment variable.`                                                                                                                                                                            |
| `--provider-module` with a model flag                                               | `Error: --provider-module cannot be combined with --provider, --model, --base-url, or --strict-base-url`                                                                                                                                                                                                                                                         |
| The module does not export a provider                                               | `Error: provider module default export must be an instance extending LlmProvider.`                                                                                                                                                                                                                                                                               |
| Its `LlmProvider` comes from another realm-cli version (added after version 0.45.0) | `Error: the provider module's LlmProvider comes from @sensigo/realm-cli 0.45.1 (…); this realm command is @sensigo/realm-cli 0.45.0 (…). Realm objects do not cross versions. Run realm 0.45.1 in the project: npm install --save-dev @sensigo/realm-cli@0.45.1, then npx realm; or install @sensigo/realm-cli@0.45.0 and @sensigo/realm@0.45.0 in the project.` |
| The module cannot be loaded                                                         | `Error: failed to import provider module '../none.mjs': Cannot find module '/srv/shop/none.mjs' …`                                                                                                                                                                                                                                                               |
| `--schema-retries` is not a whole number, 0 or more                                 | `error: option '--schema-retries <n>' argument 'x' is invalid. --schema-retries must be a non-negative integer.`                                                                                                                                                                                                                                                 |
| `--llm-timeout` is not a whole number above 0                                       | `error: option '--llm-timeout <seconds>' argument '0' is invalid. --llm-timeout must be a positive integer number of seconds.`                                                                                                                                                                                                                                   |

`--strict-base-url` without `--base-url` is not refused. It prints `⚠ --strict-base-url has no effect without --base-url …` and carries on.

## See also

- [Run a workflow with `realm agent`](../../guides/realm-agent.md)
- [Give an agent step tools](../../guides/agent-tools.md)
- [Agent-step controls](../workflow/agent-step-controls.md)
- [`realm run`: commands that act](realm-run-acting.md) covers `respond`.
- [`realm listen`](realm-listen.md) starts `realm agent` for each webhook.
