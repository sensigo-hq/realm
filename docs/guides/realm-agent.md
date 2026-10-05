# Run a workflow with `realm agent`

<!-- description: Run a workflow from start to end with realm agent and a model provider: a full run, what happens when the model answers wrongly, and resuming a stopped run. -->

`realm agent` runs a workflow from start to end with a model doing the agent steps. You give it a workflow and a model provider; it calls the model, hands each answer to Realm, and carries on until the run ends or needs a person. This guide shows a run, what happens when the model answers wrongly, and how to pick up a run that stopped.

The outputs on this page come from real runs of `realm agent` against a local stand-in for the model, which returned answers chosen for the test. Everything on the Realm side is real.

## Before you start

You need:

- a workflow with at least one agent step. This guide uses the `triage` workflow from [Write an agent step](agent-steps.md);
- an API key for Anthropic or OpenAI, and the name of a model that provider offers.

## 1. Set the provider key and choose a model

Set one of these in your shell:

```bash
export ANTHROPIC_API_KEY=your-key
```

or

```bash
export OPENAI_API_KEY=your-key
```

`realm agent` picks the provider from whichever key is set, and OpenAI when both are. To choose yourself, add `--provider anthropic` or `--provider openai`.

Name the model with `--model <name>`. It is required: Realm has no default model, because providers change their models often. Anthropic lists its models at [platform.claude.com/docs/en/models/overview](https://platform.claude.com/docs/en/models/overview), and OpenAI at [developers.openai.com/api/docs/models](https://developers.openai.com/api/docs/models). Version 0.45.0 has a default model (`gpt-4o`, or `claude-sonnet-4-5` for Anthropic).

The commands below use Anthropic and the model `claude-sonnet-5-5`; any model Anthropic lists today works. With an OpenAI key, use `--provider openai --model <a model from OpenAI's list>` in their place.

## 2. Run the workflow

Run it from the workflow's folder, with the run's parameters as JSON:

```bash
realm agent --workflow ./ --register --params '{"ticket":"I was charged twice this month."}' --provider anthropic --model claude-sonnet-5-5
```

`--register` stores a copy of the workflow as part of the run, so that the other `realm` commands can find it afterwards.

It prints:

```text
Realm Agent — Triage a ticket v1
Run ID: 4950eb94-37c0-41a0-8632-0b6f59cc999a


→ [agent] classify
  Classify the ticket and say how urgent it is.
  ✓ → completed

Run complete: 4950eb94-37c0-41a0-8632-0b6f59cc999a

Result (classify):
billing (urgent: true)
The customer was charged twice this month.
```

Notice `Result`. It is the last agent step's answer, shown through that step's `display` template.

## What the model is sent

For each agent step, `realm agent` sends one request to Anthropic. Its system prompt holds the step's profile, if it has one, followed by fixed instructions and the step's schema:

```text
You are a support lead. You classify tickets by what the customer needs next, …


You are an AI agent executing a step in a structured workflow.
Your task is described below. Call the `__realm_submit__` tool with your result, or respond with a JSON object only — no markdown, no explanation.
The JSON must conform to this schema: {"type":"object","additionalProperties":false,"required":["category","urgent","reason"], …}
```

Its one message is the step's `prompt`, with its values filled in:

```text
Classify this support ticket.

Ticket:
I was charged twice this month.
```

The request also offers the model one tool, `__realm_submit__`, whose input is the step's schema; the model can answer by calling it.

## When the model answers wrongly

If the answer does not fit the step's schema, Realm refuses it. `realm agent` then asks the model again, and tells it what was wrong. In another run of the same workflow, the model first chose a category that is not on the list:

```text
→ [agent] classify
  Classify the ticket and say how urgent it is.
  ⚠ output rejected (VALIDATION_INPUT_SCHEMA); repairing (attempt 1/2)
  ✓ → completed
```

The second request ended with the reason for the refusal:

```text
Your previous output was rejected by the input schema validator:
- /category: must be equal to one of the allowed values [enum]
Emit corrected JSON only, matching the schema exactly.
```

By default the model gets two such chances for each step. Change the number with `--schema-retries <n>`; `0` turns the repair off.

If the model is still wrong after the last chance, `realm agent` stops:

```text
  ⚠ output rejected (VALIDATION_INPUT_SCHEMA); repairing (attempt 1/2)
  ⚠ output rejected (VALIDATION_INPUT_SCHEMA); repairing (attempt 2/2)

✗ Step 'classify' failed: Invalid input for step 'classify' after 2 schema-repair attempts
```

The command exits with code 1. The run itself is not ended: its phase is still `running`, and nothing wrong was recorded as the step's output. The record says what happened and what it cost:

```text
Drive failures:
  2026-10-04T23:56:45.259Z  classify  anthropic  validation_rejected after 72ms: Invalid input for step 'classify'
    usage: 3 requests billed before the output was rejected — 1236 prompt tokens (totals across 3 requests), 114 output tokens (totals across 3 requests), cache read 0, wrote 0 (included in the prompt)
```

The `usage` line was added after version 0.45.0. That version prints the line above it and nothing about cost.

## Pick up a run that stopped

To continue a run, name it with `--run-id`, without `--workflow`. Give the provider and the model again:

```bash
realm agent --run-id a9fd51c7-b84d-49c9-afe5-07156edf8c27 --provider anthropic --model claude-sonnet-5-5
```

It prints:

```text
Realm Agent — Triage a ticket v1
Run ID: a9fd51c7-b84d-49c9-afe5-07156edf8c27


→ [agent] classify
  Classify the ticket and say how urgent it is.
  ✓ → completed

Run complete: a9fd51c7-b84d-49c9-afe5-07156edf8c27

Result (classify):
billing (urgent: true)
The customer was charged twice this month.
```

The run carries on from where it was. Steps that already completed are not run again.

## What a run costs

The measured figures in this section were added after version 0.45.0. On 0.45.0 the line reads `Diagnostics: ~23 tokens | no preconditions`.

`realm run inspect` shows, for each step the model answered, how many tokens the provider counted:

```text
     Diagnostics: ~23 tokens (estimate, step input) | 412 prompt tokens (measured, first request) | 38 output tokens | no preconditions | cache: not engaged — read 0, wrote 0 (provider-reported, 1 request)
```

For the run in which the first answer was refused, the same line shows two requests:

```text
     Diagnostics: ~23 tokens (estimate, step input) | 824 prompt tokens (measured, totals across 2 requests) | 76 output tokens (totals across 2 requests) | no preconditions | cache: not engaged — read 0, wrote 0 (provider-reported, totals across 2 requests)
```

A refused answer still costs a request. `measured` figures come from the provider's own count. `cache: not engaged` means the provider reported that no part of the prompt was read from its cache or written to it. The `estimate` is Realm's rough size of the step's input only, and is much smaller than what was sent.

## Human gates

When the run reaches a human gate, `realm agent` prints the gate and waits. It prints one `realm run respond` command for each choice; run one from another terminal and the run carries on. To take the answer from Slack, see [Answer gates from Slack](slack-gates.md).

## Other providers

`--base-url <url>` points `realm agent` at any service that speaks the OpenAI chat-completions format. Use it with `--provider openai` and `--model <name>`.

## Limit how long a model request may take

Each model request is given up to 600 seconds. Change that for a whole run with `--llm-timeout <seconds>`, or for one step with `llm_timeout_seconds` in the workflow.

## If you see something else

After `--run-id`, each refusal below that ends `Nothing was started.` ends `If run <run-id> exists, it was not changed.` instead.

- **`Error: realm agent requires an LLM API key. Set OPENAI_API_KEY or ANTHROPIC_API_KEY. Nothing was started.`** No provider key is set in this shell. A key that is empty or holds only spaces counts as not set; version 0.45.0 counted it as set. With `--provider anthropic`, the message names only `ANTHROPIC_API_KEY` (added after version 0.45.0).
- **`Error: --model is required: realm has no default model. ANTHROPIC_API_KEY is set, so the provider is Anthropic; name one of its models (Anthropic lists them at https://platform.claude.com/docs/en/models/overview). Nothing was started.`** Add `--model` with a model the provider lists. The message names the provider Realm chose and why; it reads differently when another key is set or `--provider` is given. After `--run-id`, it ends `If run <run-id> exists, it was not changed.` instead. Version 0.45.0 does not print it: it has a default model.
- **`Error: --provider anthropic was given, but ANTHROPIC_API_KEY is not set or is empty (only OPENAI_API_KEY is set). Set ANTHROPIC_API_KEY, or use --provider openai with an OpenAI model. Nothing was started.`** The provider you named has no key in this shell. Set its key, or name the other provider and one of its models. Version 0.45.0 does not print it: it creates the run, and the first model call fails.
- **`Error: one of --workflow or --run-id is required`** Give one of the two.
- **`Error: --workflow and --run-id are mutually exclusive`** To continue a run, give `--run-id` alone.
- **`Error: Workflow not found: triage — most often this run was created from a file without --register.`** You tried to continue a run whose workflow was never registered. Run `realm workflow register ./`, then try again.
- **`✗ Step 'classify' LLM call failed: Connection error.`** The provider could not be reached. The run is not ended; fix the connection and continue it with `--run-id`.
- **`✗ Step 'classify' LLM call failed: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-4-5"}, …`**, followed by the line `Anthropic offers no model named claude-sonnet-4-5 to this API key. …` Anthropic has no model by the name you gave. The run stays open, so continue it with `realm agent --run-id <run-id> --provider anthropic --model <the right name>`; running the `--workflow` command again starts a second run. The second line was added after version 0.45.0.

## See also

- [`realm agent` reference](../reference/cli/realm-agent.md) lists every flag.
- [Agent-step controls](../reference/workflow/agent-step-controls.md) covers stricter output modes and what to do after repeated refusals.
- [Give an agent step tools](agent-tools.md)
- [Operate runs](operate-runs.md) covers runs that did not finish.
