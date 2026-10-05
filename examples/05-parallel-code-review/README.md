# Example 5 — Fan-Out: Two Specialists, One Verdict

A diff enters. Two specialists review it simultaneously — one focused on security, one on
performance. Neither knows the other exists. When both finish, a synthesizer combines their
validated findings into a single verdict.

The moment to watch is after `read_diff` completes. The engine returns two items in
`next_actions` at the same time: one for `review_security`, one for `review_performance`.
Both branches run — the synthesizer is ineligible until both complete. This is
`depends_on: [review_security, review_performance]` in action: no new engine primitives,
no parallel execution framework. The YAML is the coordinator.

## Pain points addressed

- **Non-determinism / no audit trail (#3)** — two independent reviewers produce independent
  outputs, each captured in the evidence chain before synthesis begins. When the final verdict
  disagrees with one reviewer, `realm run inspect` shows exactly what each branch received and
  what it returned — the disagreement is traceable, not just observable.
- **Verification gap (#8)** — `synthesize_review` cannot receive a malformed review from
  either branch. `review_security` and `review_performance` each have their own `input_schema`.
  Both are independently enforced before `synthesize_review` becomes eligible.
- **Sequential bottleneck** — a plain LLM chain that calls security review then performance
  review in sequence couples their latency. Both specialists read from the same `read_diff`
  output and have no dependency on each other — Realm runs them as soon as `read_diff` completes.

## The before / after

**Before (a plain sequential pipeline — one specialist waits for the other):**

```python
def review_diff(path: str) -> dict:
    diff = read_file(path)
    security = llm.review_security(diff)     # must finish before performance starts
    performance = llm.review_performance(diff)  # waits even though it only needs diff
    verdict = llm.synthesize(security, performance)
    return verdict
```

Neither reviewer depends on the other's output — the wait is artificial. Both need only
the diff, which is the same for both. In a plain pipeline you pay the latency cost twice:
security first, performance second, in series.

**After (Realm — both reviewers start as soon as the diff is loaded):**

When `read_diff` completes, the engine yields two eligible steps at once:

```json
{
  "status": "ok",
  "next_actions": [
    {
      "prompt": "You are a security specialist reviewing a code diff...",
      "instruction": {
        "tool": "execute_step",
        "call_with": {
          "run_id": "<run-id>",
          "command": "review_security",
          "params": {
            "findings": [],
            "risk_level": "<low|medium|high|critical>",
            "confidence": 0
          }
        }
      }
    },
    {
      "prompt": "You are a performance specialist reviewing a code diff...",
      "instruction": {
        "tool": "execute_step",
        "call_with": {
          "run_id": "<run-id>",
          "command": "review_performance",
          "params": {
            "findings": [],
            "risk_level": "<low|medium|high|critical>",
            "confidence": 0
          }
        }
      }
    }
  ]
}
```

Both steps are eligible simultaneously. An orchestrating agent can execute them inline
(one after the other, fastest for short steps) or spawn subagents to run them in true
parallel. `synthesize_review` becomes eligible only after both complete successfully.

## Steps

```
read_diff              (auto — filesystem adapter)             [depends_on: none]
     │
     ├──────────────────────────────────────┐
     ↓                                      ↓
review_security        (agent)              review_performance  (agent)
[depends_on: read_diff]                     [depends_on: read_diff]
schema enforced before                      schema enforced before
synthesize_review starts                    synthesize_review starts
     │                                      │
     └──────────────────┬───────────────────┘
                        ↓
               synthesize_review   (agent)
               [depends_on: review_security, review_performance]
               receives confirmed outputs from both branches
                        │
                        ↓
               record_review       (auto — terminal step)
               [depends_on: synthesize_review]
```

Both `review_security` and `review_performance` read from `context.resources.read_diff`.
Neither reads from the other. `synthesize_review` reads from both via
`context.resources.review_security.*` and `context.resources.review_performance.*`.

## Install

```bash
# From the repo root
npm install
```

---

## Run fixture tests

```bash
realm workflow test examples/05-parallel-code-review/workflow.yaml \
  -f examples/05-parallel-code-review/fixtures/
```

Two fixtures:

- `fan-out-pass.yaml` — both specialists succeed on the first call. All five steps reach
  `success`. Final state: `completed`.
- `convergence-after-branch-retry.yaml` — `review_security` receives one provider timeout,
  then succeeds on retry. `review_performance` succeeds immediately. The test runner resets
  the run state and retries `review_security` — the synthesizer waits for both branches
  regardless of retry. All five steps reach `success`. Final state: `completed`.

Expected output:

```
Realm Test — examples/05-parallel-code-review/workflow.yaml
  PASS convergence after branch retry — provider timeout and recovery
  PASS fan-out pass — payment integration diff

2/2 passed
```

---

## Run with an AI agent

```bash
# Register the workflow (once, from the repo root):
realm workflow register examples/05-parallel-code-review/workflow.yaml

# Start the MCP server:
realm mcp
```

With VS Code: open the workspace — `realm mcp` starts automatically via `.vscode/mcp.json`.

**Option A — Realm agent (zero friction)**

Switch to the **Realm** agent in the VS Code Chat agent picker. Then ask:

> "Review the diff at examples/05-parallel-code-review/diffs/add-payment-integration.diff with Realm."

**Option B — Skill file (default agent)**

Copy `realm-parallel-code-review.md` from this directory to your workspace's `.github/skills/`
folder. With the default agent, trigger it with:

> "Review this diff with Realm: examples/05-parallel-code-review/diffs/add-payment-integration.diff"

**Option C — `realm agent` CLI (no VS Code required)**

```bash
realm agent \
  --workflow examples/05-parallel-code-review/workflow.yaml \
  --params "{\"path\":\"$(pwd)/examples/05-parallel-code-review/diffs/add-payment-integration.diff\"}" \
  --provider anthropic \
  --model claude-sonnet-5-5
```

Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` before running. The command uses Anthropic and the model `claude-sonnet-5-5`; with an OpenAI key, use `--provider openai --model <a model from OpenAI's list>` ([OpenAI's models](https://developers.openai.com/api/docs/models)).

The agent will:

1. Start the run — `read_diff` executes automatically via the filesystem adapter.
2. Receive two prompts simultaneously in `next_actions`: one for security review, one for
   performance review. It executes both (inline or as subagents).
3. Once both branches complete, receive the synthesis prompt. It combines the findings into
   a single verdict: agreed risk level, security summary, performance summary, recommendation.
4. `record_review` runs automatically and the run reaches `completed`.

## Inspect the evidence chain

```bash
realm run inspect <run-id>
```

The evidence chain has five entries in completion order. Because the two specialist steps
complete asynchronously, their order in the chain reflects whichever finished first — not
their declaration order in the YAML. `synthesize_review` always appears after both.

`realm run inspect` shows the `Resolved:` line for auto steps that use `input_map`
(i.e. `read_diff`), so you can confirm exactly which diff file path was read.

## Configuration reference

| Param  | Type   | Description                     |
| ------ | ------ | ------------------------------- |
| `path` | string | Path to the diff file to review |

## The `display` field

The `display` field on a step definition is a Jinja-style template rendered by the CLI
against the step's `output_summary` when a run completes. It is evaluated client-side at
run completion — the engine never sees it.

**Supported syntax:** `{{ field }}` and `{{ nested.field }}` — plain dot-path references into
the step output object. Filters (e.g. `| upper`) are not supported. Missing paths render as
an empty string.

**When to use it:** on convergence or classification steps that produce structured output
and also need readable terminal display. Steps that already use `headline`/`message` do not
need it — `formatOutputForTerminal` already renders those directly.

**Example** — `synthesize_review` uses:

```yaml
display: |
  {{ agreed_risk_level }}: {{ recommendation }}

  Security: {{ security_concerns }}
  Performance: {{ performance_concerns }}
```

When a run completes, the CLI prints the rendered template instead of a JSON dump:

```
critical: BLOCKED — resolve the hardcoded secret key and all SQL injection vulnerabilities before merge.

Security: Three SQL injection vulnerabilities found...
Performance: getOrderSummaries executes one database query per order row...
```

Without `display`, the CLI would fall back to printing the raw JSON object.

## Shared reviewer guidelines

Both specialist steps load the same reviewer guidelines file at run start via
`workflow_context`. The file lives in `guidelines/reviewer-guidelines.md` and is
referenced in both prompts as `{{ workflow.context.reviewer_guidelines }}`.

This means updating the guidelines takes effect at the next run without re-registering
the workflow. The guidelines are not injected into the evidence chain — they are
workflow-level standing configuration, not run-specific data.

## What to look at next

- [04-content-pipeline/](../04-content-pipeline/) — the preceding example in the ladder:
  checkpoint/resume when a step fails mid-run
- [Workflow file reference](../../docs/reference/workflow/top-level-fields.md) — full reference for
  `workflow_context`, `depends_on`, `input_schema`, and `input_map`
