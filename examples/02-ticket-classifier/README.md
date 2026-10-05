# Example 2 — Verified Data Flows Between Steps

## What this shows

Most LLM pipelines extract and classify in a single step. When that step is wrong,
you cannot tell whether the extraction failed or the classification failed — the error
is in the combined output, and the trace is one opaque blob.

Realm separates extraction from classification into two sequential agent steps. Each
step's output is validated before the next step starts. The second step receives data
from the first via `context.resources` — the prompt literally names where each field
came from. `realm run inspect` shows the full chain: what each step received, what it
returned, and which schema check confirmed it.

**Pain points addressed:**

- **No audit trail / observability (#3)** — `realm run inspect` shows two linked
  evidence entries: what `identify_ticket` extracted and what `classify_ticket`
  produced. When the classifier gets the category wrong, you can see whether it
  misread the ticket or misclassified correct data.
- **Tool calling brittleness (#6)** — `classify_ticket` cannot receive bad extraction
  data. `identify_ticket`'s schema is enforced before `classify_ticket` starts.
- **Framework magic / hidden complexity (#7)** — no hidden retry, no swallowed
  exceptions. Both steps, their inputs, and their outputs are explicit YAML.

## The before / after

**Before (a plain LLM chain with one step):**

```python
result = llm.invoke(classify_prompt.format(ticket=ticket_text))
# result might be {"category": "billing", ...} but the extraction was wrong:
# the agent misread CUST-3847 as a billing account, not a payment gateway bug.
# You only find out downstream when the SLA routing is wrong.
# And you can't tell if the extractor was wrong or the classifier was wrong.
```

Everything is in one call. The trace is one blob. When the output is wrong,
you re-run the whole call. You cannot narrow the failure.

**After (Realm — two chained steps):**

```yaml
identify_ticket:
  execution: agent
  depends_on: []
  input_schema:
    type: object
    required: [customer_id, product_area, product_version, reported_issue]
    properties:
      customer_id:
        pattern: '^CUST-[0-9]{4}$'

classify_ticket:
  execution: agent
  depends_on: [identify_ticket] # cannot start until identify passes
  prompt: |
    Classify this {{ context.resources.identify_ticket.product_area }} ticket.
    Reported issue: {{ context.resources.identify_ticket.reported_issue }}
```

`classify_ticket`'s prompt explicitly names what it received and from which step.
The classifier cannot invent a product area — it receives the value the extractor
validated. When the classifier is wrong, the evidence chain shows the inputs it
received were correct; you have narrowed the failure to the classification logic.

## Steps

```
read_ticket      (auto — filesystem adapter, loads the raw ticket text)
     │ → ticket_loaded
identify_ticket  (agent — extracts: customer_id, product_area, product_version, reported_issue)
     │ → ticket_identified    ← schema enforced before classify_ticket starts
classify_ticket  (agent — classifies: category, priority, summary)
                 (prompt reads context.resources.identify_ticket.product_area)
     │ → classified
record_ticket    (auto — records the full structured result)
     │ → completed
```

`identify_ticket` and `classify_ticket` each have their own `input_schema`. Each must
pass before the run advances. The run stays in its current state on rejection — the
agent receives `agent_action: provide_input` with the validation error and resubmits.
Nothing downstream runs on bad data.

## Install

```bash
# From the repo root
npm install
```

---

## Run fixture tests

```bash
realm workflow test examples/02-ticket-classifier/workflow.yaml -f examples/02-ticket-classifier/fixtures/
```

Two fixtures:

- `bug-ticket.yaml` — a P1 payment gateway bug from `CUST-3847`, expected: `completed`
- `billing-ticket.yaml` — a billing overcharge from `CUST-1122`, expected: `completed`

Expected output:

```
Realm Test — examples/02-ticket-classifier/workflow.yaml
  PASS billing inquiry — double charge on March invoice
  PASS bug report — payment gateway timeout

2/2 passed
```

Each fixture has two `agent_responses` entries — one for `identify_ticket`, one for
`classify_ticket` — and an `expected.evidence` with all four steps.

---

## Run with an AI agent

```bash
# Register the workflow (once, from the repo root):
realm workflow register examples/02-ticket-classifier/workflow.yaml

# Start the MCP server:
realm mcp
```

With VS Code: open the workspace — `realm mcp` starts automatically via
`.vscode/mcp.json`.

> **Custom agents (Copilot, Claude):** if you are using a custom agent defined in
> `.github/agents/*.agent.md`, add `realm/*` to its `tools:` list — this grants access
> to every tool the Realm MCP server exposes without having to list them individually.
> The MCP server can be running and the workflow registered, but the tools will not
> appear in the agent's session unless the agent explicitly includes them. Default
> (non-custom) agents in VS Code pick up all MCP tools automatically.

**Option A — Realm agent (zero friction)**

Switch to the **Realm** agent in the VS Code Chat agent picker. Then ask:

> "Classify this support ticket: examples/02-ticket-classifier/tickets/billing-overcharge.txt"

> "Classify this support ticket: examples/02-ticket-classifier/tickets/payment-gateway-bug.txt"

**Option B — Skill file (default agent)**

Copy `realm-ticket-classifier.md` from this directory to your workspace's `.github/skills/`
folder. With the default agent, trigger it with:

> "Classify this support ticket with Realm: examples/02-ticket-classifier/tickets/billing-overcharge.txt"

> "Classify this support ticket with Realm: examples/02-ticket-classifier/tickets/payment-gateway-bug.txt"

> **Why "with Realm"?** The skill file's `description` intentionally includes that phrase
> as a trigger signal so the default agent routes to Realm only when explicitly asked to.
> Without it, a general prompt like "classify this ticket" could match the skill and start
> a Realm run silently. If you want fully natural-language invocation without the trigger
> phrase, open `realm-ticket-classifier.md` and remove the phrase from the `description`
> field — the skill will then fire on any ticket classification request. Use the Realm
> agent (Option A) if you want that behaviour without modifying the skill file.

**Option C — `realm agent` CLI (no VS Code required)**

Run the workflow autonomously from the terminal — no MCP client, no IDE, no configuration:

```bash
realm agent \
  --workflow examples/02-ticket-classifier/workflow.yaml \
  --params "{\"path\":\"$(pwd)/examples/02-ticket-classifier/tickets/billing-overcharge.txt\"}" \
  --provider anthropic \
  --model claude-sonnet-5-5
```

Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` before running. The command uses Anthropic and the model `claude-sonnet-5-5`; with an OpenAI key, use `--provider openai --model <a model from OpenAI's list>` ([OpenAI's models](https://developers.openai.com/api/docs/models)). The agent drives both steps sequentially, validating each output against its schema before advancing, and prints the `classify_ticket` result when the run completes.

Either way, the agent will:

1. Start the run — `read_ticket` executes automatically.
2. Receive a `next_action.prompt` asking it to extract ticket identity. It submits
   `customer_id`, `product_area`, `product_version`, and `reported_issue`. If any
   field fails schema validation, it receives `provide_input` and must correct and
   resubmit. The state stays at `ticket_loaded` until the schema passes.
3. Receive a second `next_action.prompt` asking it to classify the ticket. The prompt
   already contains the verified product area and reported issue from step 2. It
   submits `category`, `priority`, and `summary`. Same schema enforcement
   applies.
4. Once the classification schema passes, `record_ticket` runs and the workflow
   completes.

## Inspect the evidence chain

After the run completes, check what each step received and produced:

```bash
realm run inspect <run-id>
```

The evidence chain shows four entries in order: `read_ticket`, `identify_ticket`,
`classify_ticket`, `record_ticket`. The `identify_ticket` entry shows the extracted
fields. The `classify_ticket` entry shows the inputs it received (from
`context.resources.identify_ticket`) and its output. If classification is wrong, the
evidence chain tells you whether the extractor or the classifier was at fault.

## Configuration reference

`params_schema` requires:

| Field | Type   | Description                                    |
| ----- | ------ | ---------------------------------------------- |
| path  | string | Absolute path to the support ticket text file. |

## What to look at next

- [Example 3 — Incident Response](../03-incident-response/) — builds on the
  `context.resources` data-flow pattern from this example and adds a human gate:
  execution is structurally blocked until an engineer chooses to send or reject the
  drafted response.
- [Workflow file reference](../../docs/reference/workflow/top-level-fields.md) — all step fields,
  execution modes, gate configuration, and `depends_on` / `trigger_rule`
- [Example 6 — Ticket Router](../06-ticket-router/) — builds on this example's
  `classify_ticket.category` field: uses `when` conditions to route to one of five
  handlers automatically, with the routing decision recorded in the evidence chain.
