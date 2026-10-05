# Example 06 — Ticket Router

**Pain:** Routing rules embedded in agent instructions — a growing `SKILL.md` section that says
"if the ticket is a billing issue, handle it like X; if it's a bug, do Y; if it's a
feature request…". The agent must read, interpret, and act on those rules itself.
This is invisible, untestable, and breaks silently when the agent misreads the intent.

**After:** `when` conditions move routing rules out of prompt text and into the workflow YAML.
Each handler step declares `when: "classify_ticket.category == '<category>'"`. The engine
evaluates these automatically after `classify_ticket` completes — exactly one step becomes
eligible, and the other four are moved to `skipped_steps`. No routing logic in agent prompts.

---

## What this shows

```
read_ticket       (auto — filesystem adapter, loads the raw ticket text)
     │
identify_ticket   (agent — extracts: customer_id, product_area, product_version, reported_issue)
     │
classify_ticket   (agent — classifies: category, priority, summary)
     │
     ├── handle_billing   (when: classify_ticket.category == 'billing')
     ├── handle_bug       (when: classify_ticket.category == 'bug')
     ├── handle_feature   (when: classify_ticket.category == 'feature_request')
     ├── handle_account   (when: classify_ticket.category == 'account')
     └── handle_other     (when: classify_ticket.category == 'other')
        (exactly one fires; four land in skipped_steps)
```

**Key points:**

- `when` is evaluated by the engine against the evidence chain — not by the agent.
- Routing is declarative and visible in the workflow YAML.
- `realm run inspect <run-id>` shows `skipped_steps` — the audit trail includes which
  branches were evaluated and not taken.
- Fixtures use `skipped_steps` to verify routing directly: a fixture that only asserts
  `final_state: completed` does not test routing at all.

---

## Install

```bash
# From the repo root
npm install
```

---

## Run fixture tests

```bash
realm workflow test examples/06-ticket-router/workflow.yaml -f examples/06-ticket-router/fixtures/
```

All 5 fixtures should pass. Each fixture provides one ticket, mocks `identify_ticket` and
`classify_ticket`, and asserts both the evidence chain and `skipped_steps` — confirming
that the four non-matching handlers were correctly skipped.

Expected output:

```
Realm Test — examples/06-ticket-router/workflow.yaml
  PASS account issue — SSO lockout after migration
  PASS billing inquiry — double charge
  PASS bug report — payment gateway timeout
  PASS feature request — webhook support for invoice events
  PASS general question — GDPR data retention inquiry

5/5 passed
```

---

## Run with an AI agent

**Option A — VS Code + Copilot (MCP)**

Register the workflow and start the MCP server:

```bash
realm workflow register examples/06-ticket-router/workflow.yaml

# Start the MCP server:
realm mcp
```

With VS Code: open the workspace — `realm mcp` starts automatically via `.vscode/mcp.json`.

> **Custom agents (Copilot, Claude):** if you are using a custom agent defined in
> `.github/agents/*.agent.md`, add `realm/*` to its `tools:` list — this grants access
> to every tool the Realm MCP server exposes without having to list them individually.
> The MCP server can be running and the workflow registered, but the tools will not
> appear in the agent's session unless the agent explicitly includes them. Default
> (non-custom) agents in VS Code pick up all MCP tools automatically.

Open Copilot chat and say:

> Route this ticket with Realm: examples/06-ticket-router/tickets/payment-gateway-bug.txt

Realm reads the file, runs the three agent steps, routes to `handle_bug`, and records
the full chain in the evidence log.

**Option B — Skill file (default agent)**

Copy `realm-ticket-router.md` from this directory to your workspace's `.github/skills/`
folder. With the default agent, trigger it with:

> "Route this ticket with Realm: examples/06-ticket-router/tickets/payment-gateway-bug.txt"

> "Route this ticket with Realm: examples/06-ticket-router/tickets/billing-overcharge.txt"

> **Why "with Realm"?** The skill file's `description` intentionally includes that phrase
> as a trigger signal so the default agent routes to Realm only when explicitly asked to.
> Without it, a general prompt like "route this ticket" could match the skill and start a
> Realm run silently. If you want fully natural-language invocation without the trigger
> phrase, open `realm-ticket-router.md` and remove the phrase from the `description`
> field — the skill will then fire on any support ticket routing request. Use the Realm
> agent (Option A) if you want that behaviour without modifying the skill file.

**Option C — `realm agent` CLI (no VS Code required)**

```bash
realm agent \
  --workflow examples/06-ticket-router/workflow.yaml \
  --params "{\"path\":\"$(pwd)/examples/06-ticket-router/tickets/billing-overcharge.txt\"}" \
  --provider anthropic \
  --model claude-sonnet-5-5
```

Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` before running. The commands use Anthropic and the model `claude-sonnet-5-5`; with an OpenAI key, use `--provider openai --model <a model from OpenAI's list>` ([OpenAI's models](https://developers.openai.com/api/docs/models)).

Point `--params path` at any ticket file in `tickets/` to test a different route:

```bash
realm agent \
  --workflow examples/06-ticket-router/workflow.yaml \
  --params "{\"path\":\"$(pwd)/examples/06-ticket-router/tickets/general-question.txt\"}" \
  --provider anthropic \
  --model claude-sonnet-5-5
```

## Inspect the evidence chain

```bash
realm run inspect <run-id>
```

The evidence chain shows entries for `read_ticket`, `identify_ticket`, `classify_ticket`, and
the matching handler. `skipped_steps` lists the four handlers that were evaluated but not
taken. The routing decision is permanently recorded — `realm run inspect` shows which `when`
condition matched and which four were skipped.

## Configuration reference

`params_schema` requires:

| Field | Type   | Description                                    |
| ----- | ------ | ---------------------------------------------- |
| path  | string | Absolute path to the support ticket text file. |

---

## What to look at next

- [Example 2 — Ticket Classifier](../02-ticket-classifier/) — this example builds directly
  on it: `classify_ticket.category` is the field the `when` conditions evaluate. Start there
  if you want to understand the schema design.
- [Workflow file reference](../../docs/reference/workflow/top-level-fields.md) — `when` condition syntax,
  `skipped_steps` in run state, and all other step fields.
