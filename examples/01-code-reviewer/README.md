# Example 1 — The Naive vs. the Structured Run

## What this shows

A code reviewer skill file (`skill.md`) that started with one rule has grown to
five, each added after a production incident — wrong severity values, one-word
summaries, missed breaking change flags. Prose rules are ambiguous and forgettable.
When the agent has a bad run, none of them fire an error: the bad output propagates
silently, gets recorded, and is discovered later downstream.

**Before (from `skill.md`):**

```
IMPORTANT: severity must be exactly one of: critical, high, medium, low.
Do NOT use "urgent", "blocker", "minor", "trivial", "moderate", or any other
value. I had to correct this four times before adding this note.

IMPORTANT: summary must be at least two full sentences. Single-word responses
("refactor", "cleanup") are useless to the reviewer.
```

**After (in `workflow.yaml`):**

```yaml
review_changes:
  execution: agent
  input_schema:
    type: object
    required: [severity, summary, breaking_changes, action_required]
    properties:
      severity:
        type: string
        enum: [critical, high, medium, low]
      summary:
        type: string
        minLength: 20
      breaking_changes:
        type: boolean
      action_required:
        type: boolean
```

If the agent returns `severity: "urgent"` or a two-character summary, the engine
rejects the step before anything advances:

```json
{
  "agent_action": "provide_input",
  "errors": ["'urgent' is not one of [critical, high, medium, low]"]
}
```

The run stays in `diff_loaded`. Nothing downstream executes. The agent corrects
and resubmits. The rejected answers are not stored, but the step's evidence entry records
how many were rejected before one was accepted.

**Pain points addressed:**

- **Instruction file spiral (#1)** — the five prose rules in `skill.md` are replaced
  by the `input_schema` declaration. No `IMPORTANT:` annotations accumulate.
- **Non-determinism + structured output failures (#2)** — invalid enum values and
  short summaries are rejected at the boundary, not discovered downstream.
- **No audit trail (#3)** — every run produces an evidence chain: what each step
  received, what fields were returned, and how many answers a step rejected.
- **Verification gap / no test gating (#8)** — step output is verified structurally
  before the run advances; a step cannot complete with invalid output.

## Install

```bash
# From the repo root — installs all workspace packages:
npm install
```

No per-example build step is required.

## Run fixture tests

```bash
# From the repo root:
realm workflow test examples/01-code-reviewer/workflow.yaml -f examples/01-code-reviewer/fixtures/
```

Expected output:

```
Realm Test — examples/01-code-reviewer/workflow.yaml
  PASS breaking API change — OAuth provider parameter
  PASS null pointer fix — early return guard

2/2 passed
```

## Run with an AI agent

```bash
# Register the workflow (once, from the repo root):
realm workflow register examples/01-code-reviewer/workflow.yaml

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

> "Review this diff: examples/01-code-reviewer/diffs/add-oauth-provider.diff"

> "Review this diff: examples/01-code-reviewer/diffs/fix-null-pointer.diff"

**Option B — Skill file (default agent)**

Copy `realm-code-reviewer.md` from this directory to your workspace's `.github/skills/`
folder. With the default agent, trigger it with:

> "Review this diff with Realm: examples/01-code-reviewer/diffs/add-oauth-provider.diff"

> "Review this diff with Realm: examples/01-code-reviewer/diffs/fix-null-pointer.diff"

> **Why "with Realm"?** The skill file's `description` intentionally includes that phrase
> as a trigger signal so the default agent routes to Realm only when explicitly asked to.
> Without it, a general prompt like "review this diff" could match the skill and start a
> Realm run silently. If you want fully natural-language invocation without the trigger
> phrase, open `realm-code-reviewer.md` and remove the phrase from the `description`
> field — the skill will then fire on any code review request. Use the Realm agent
> (Option A) if you want that behaviour without modifying the skill file.

**Option C — `realm agent` CLI (no VS Code required)**

Run the workflow autonomously from the terminal — no MCP client, no IDE, no configuration:

```bash
realm agent \
  --workflow examples/01-code-reviewer/workflow.yaml \
  --params "{\"path\":\"$(pwd)/examples/01-code-reviewer/diffs/add-oauth-provider.diff\"}"
```

Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` before running. Use `--provider anthropic` to switch providers. The agent drives the full workflow, resubmits automatically if any field fails schema validation, and prints the `review_changes` result when the run completes.

Either way, the agent starts the run, loads the diff automatically, then receives a prompt
asking for the structured review. If any field violates the schema — wrong enum
value, summary too short, missing boolean — it receives `agent_action: provide_input`
with the exact validation error and must correct and resubmit. The workflow state
does not advance until the schema passes.

## Inspect the evidence chain

```bash
realm run inspect <run-id>
```

The evidence chain shows entries for `read_diff` and `review_changes`. The `review_changes`
entry shows the exact fields the agent submitted — severity, summary, breaking_changes, and
action_required. If the agent submitted an invalid value and corrected it on retry, both
attempts appear in the chain.

---

## Configuration reference

`params_schema` requires:

| Field | Type   | Description                               |
| ----- | ------ | ----------------------------------------- |
| path  | string | Absolute path to the diff file to review. |

---

## What to look at next

- [Example 2 — Verified Data Flows Between Steps](../02-ticket-classifier/) — two
  chained agent steps where each step's output is validated before the next step starts;
  `context.resources` threads verified data between steps
- [Workflow file reference](../../docs/reference/workflow/top-level-fields.md) — all step fields,
  execution modes, `input_schema` constraints, and `depends_on` / `trigger_rule`
