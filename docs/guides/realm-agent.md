# Run a workflow with `realm agent`

`realm agent` runs a workflow from start to end with a model doing the agent steps. You give it a workflow and a model provider; it calls the model, hands each answer to Realm, and carries on until the run ends or needs a person. This guide shows a run, what happens when the model answers wrongly, and how to pick up a run that stopped.

The outputs on this page come from real runs of `realm agent` against a local stand-in for the model, which returned answers chosen for the test. Everything on the Realm side is real.

## Before you start

You need:

- a workflow with at least one agent step. This guide uses the `triage` workflow from [Write an agent step](agent-steps.md);
- an API key for OpenAI or Anthropic.

## 1. Set the provider key

Set one of these in your shell:

```bash
export OPENAI_API_KEY=your-key
```

or

```bash
export ANTHROPIC_API_KEY=your-key
```

`realm agent` picks the provider from whichever key is set. To choose yourself, add `--provider openai` or `--provider anthropic`. To choose the model, add `--model <name>`.

## 2. Run the workflow

Run it from the workflow's folder, with the run's parameters as JSON:

```bash
realm agent --workflow ./ --register --params '{"ticket":"I was charged twice this month."}'
```

`--register` stores a copy of the workflow as part of the run, so that the other `realm` commands can find it afterwards.

It prints:

```text
Realm Agent — Triage a ticket v1
Run ID: 5e689157-23cc-46fc-b7b2-75124f46f0bc

→ [agent] classify
  Classify the ticket and say how urgent it is.
  ✓ → completed

Run complete: 5e689157-23cc-46fc-b7b2-75124f46f0bc

Result (classify):
billing (urgent: true)
The customer was charged twice this month.
```

Notice `Result`. It is the last agent step's answer, shown through that step's `display` template.

## What the model is sent

For each agent step, `realm agent` sends two messages. The first holds the step's profile, if it has one, followed by fixed instructions and the step's schema:

```text
You are a support lead. You classify tickets by what the customer needs next, …

You are an AI agent executing a step in a structured workflow.
Your task is described below. Respond with a JSON object only — no markdown, no explanation.
The JSON must conform to this schema: {"type":"object","additionalProperties":false,"required":["category","urgent","reason"], …}
```

The second is the step's `prompt`, with its values filled in:

```text
Classify this support ticket.

Ticket:
I was charged twice this month.
```

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
  2026-10-01T21:26:32.069Z  classify  openai  validation_rejected after 20ms: Invalid input for step 'classify'
    usage: 3 requests billed before the output was rejected — 1236 prompt tokens (totals across 3 requests), 114 output tokens (totals across 3 requests), cache not reported
```

## Pick up a run that stopped

To continue a run, name it with `--run-id`, without `--workflow`:

```bash
realm agent --run-id 0bd6b09c-fb00-4826-afd1-a721e57e63fa
```

It prints:

```text
Realm Agent — Triage a ticket v1
Run ID: 0bd6b09c-fb00-4826-afd1-a721e57e63fa

→ [agent] classify
  Classify the ticket and say how urgent it is.
  ✓ → completed

Run complete: 0bd6b09c-fb00-4826-afd1-a721e57e63fa
```

The run carries on from where it was. Steps that already completed are not run again.

## What a run costs

`realm run inspect` shows, for each step the model answered, how many tokens the provider counted:

```text
     Diagnostics: ~23 tokens (estimate, step input) | 412 prompt tokens (measured, first request) | 38 output tokens | no preconditions | cache: not reported by the provider (1 request)
```

For the run in which the first answer was refused, the same line shows two requests:

```text
     Diagnostics: ~23 tokens (estimate, step input) | 824 prompt tokens (measured, totals across 2 requests) | 76 output tokens (totals across 2 requests) | no preconditions | cache: not reported by the provider (totals across 2 requests)
```

A refused answer still costs a request. `measured` figures come from the provider's own count. The `estimate` is Realm's rough size of the step's input only, and is much smaller than what was sent.

## Human gates

When the run reaches a human gate, `realm agent` prints the gate and waits. It prints one `realm run respond` command for each choice; run one from another terminal and the run carries on. To take the answer from Slack, see [Answer gates from Slack](slack-gates.md).

## Other providers

`--base-url <url>` points `realm agent` at any service that speaks the OpenAI chat-completions format. Use it with `--provider openai` and `--model <name>`.

## Limit how long a model request may take

Each model request is given up to 600 seconds. Change that for a whole run with `--llm-timeout <seconds>`, or for one step with `llm_timeout_seconds` in the workflow.

## If you see something else

- **`Error: realm agent requires an LLM API key. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.`** No provider key is set in this shell.
- **`Error: one of --workflow or --run-id is required`** Give one of the two.
- **`Error: --workflow and --run-id are mutually exclusive`** To continue a run, give `--run-id` alone.
- **`Error: Workflow not found: triage — most often this run was created from a file without --register.`** You tried to continue a run whose workflow was never registered. Run `realm workflow register ./`, then try again.
- **`✗ Step 'classify' LLM call failed: Connection error.`** The provider could not be reached. The run is not ended; fix the connection and continue it with `--run-id`.

## See also

- [`realm agent` reference](../reference/cli/realm-agent.md) lists every flag.
- [Agent-step controls](../reference/workflow/agent-step-controls.md) covers stricter output modes and what to do after repeated refusals.
- [Give an agent step tools](agent-tools.md)
- [Operate runs](operate-runs.md) covers runs that did not finish.
