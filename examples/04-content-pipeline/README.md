# Example 4 — Persistent State: Fail at Step 3, Resume from Step 3

This is a four-step content enrichment pipeline that demonstrates what happens when
`tag_content` receives a provider timeout. `fetch_content` and `summarise` are already
`completed` before the failure occurs — `realm run resume` continues from step 3 without
re-running anything. No tokens are re-spent on steps that already produced validated outputs,
and no side effects are re-fired.

## Pain points addressed

- **State management / no checkpoint resume (#4)** — `realm run resume <run-id> --from
tag_content` continues from step 3; `fetch_content` and `summarise` are not re-run. Their
  validated outputs are already in the evidence chain.
- **LLM provider reliability / timeouts (#10)** — a timeout at `tag_content` pauses the run
  in the step's pending state; the run is not lost. The evidence chain preserves everything
  completed so far.
- **Verification gap (#8)** — the resumed `tag_content` validates its output the same way as
  the first attempt. Schema enforcement applies on retry — the tagger cannot submit a
  malformed tags list on resumption any more than it could on the first attempt.

## The before / after

**Before (a plain Python pipeline — restarts from step 1 on any failure):**

```python
def enrich_article(path: str) -> dict:
    content = read_file(path)               # step 1
    summary = llm.summarise(content)        # step 2 — already succeeded
    tags = llm.tag(summary)                 # step 3 — times out
    record(summary, tags)                   # step 4 — never reached
    return {"summary": summary, "tags": tags}

# On timeout:
enrich_article(path)  # retries from step 1 — re-reads, re-summarises, re-tags
                      # tokens re-spent on steps 1 and 2
                      # no record of which attempt succeeded
                      # side effects on record() could fire twice
```

Everything restarts from the top. Tokens are re-spent on steps that already succeeded.
There is no record of which attempt actually produced the accepted output.

**After (Realm — resume from where it stopped):**

```bash
realm run resume <run-id> --from tag_content
```

`fetch_content` and `summarise` are already `completed`. The run resumes at `tag_content`
with the same schema-validated `summarise` outputs as inputs — no re-runs, no double spend.

## Steps

```
fetch_content  (auto — filesystem adapter)          [depends_on: none]
     ↓
summarise      (agent — produces: title, summary, word_count)
               [depends_on: fetch_content]           schema enforced before tag_content starts
     ↓
tag_content    (agent — reads context.resources.summarise; produces: headline, message)
               [depends_on: summarise]               provider timeout target in resume fixture
     ↓
record_result  (auto — terminal step; marks pipeline complete)
               [depends_on: tag_content]
```

`summarise` and `tag_content` each have their own `input_schema`. Each must pass before the
run advances. The run stays in its current state on rejection — the agent receives
`agent_action: provide_input` with the validation error and resubmits. Nothing downstream
runs on bad data.

## Install

```bash
# From the repo root
npm install
```

---

## Run fixture tests

```bash
realm workflow test examples/04-content-pipeline/workflow.yaml \
  -f examples/04-content-pipeline/fixtures/
```

Two fixtures:

- `happy-path.yaml` — all steps succeed, no retry; final state: `completed`
- `resume-after-timeout.yaml` — `tag_content` fails once with a provider timeout, succeeds
  on retry; the evidence chain shows all four steps as `success`

Expected output:

```
Realm Test — examples/04-content-pipeline/workflow.yaml
  PASS happy path — ML infrastructure article
  PASS resume after timeout — distributed tracing article

2/2 passed
```

---

## Run with an AI agent

```bash
# Register the workflow (once, from the repo root):
realm workflow register examples/04-content-pipeline/workflow.yaml

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

**Option A — Realm agent (zero friction)**

Switch to the **Realm** agent in the VS Code Chat agent picker. Then ask:

> "Enrich this article: examples/04-content-pipeline/articles/ml-infrastructure.txt"

> "Enrich this article: examples/04-content-pipeline/articles/distributed-tracing.txt"

**Option B — Skill file (default agent)**

Copy `realm-content-pipeline.md` from this directory to your workspace's `.github/skills/`
folder. With the default agent, trigger it with:

> "Enrich this article with Realm: examples/04-content-pipeline/articles/ml-infrastructure.txt"

> "Enrich this article with Realm: examples/04-content-pipeline/articles/distributed-tracing.txt"

> **Why "with Realm"?** The skill file's `description` intentionally includes that phrase
> as a trigger signal so the default agent routes to Realm only when explicitly asked to.
> Without it, a general prompt like "enrich this article" could match the skill and start
> a Realm run silently. If you want fully natural-language invocation without the trigger
> phrase, open `realm-content-pipeline.md` and remove the phrase from the `description`
> field — the skill will then fire on any content enrichment request. Use the Realm agent
> (Option A) if you want that behaviour without modifying the skill file.

**Option C — `realm agent` CLI (no VS Code required)**

Run the workflow autonomously from the terminal — no MCP client, no IDE, no configuration:

```bash
realm agent \
  --workflow examples/04-content-pipeline/workflow.yaml \
  --params "{\"path\":\"$(pwd)/examples/04-content-pipeline/articles/ml-infrastructure.txt\"}"
```

Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` before running. Use `--provider anthropic` to switch providers. The agent drives all steps sequentially and prints the `tag_content` result when the run completes. If `tag_content` times out mid-run, use `realm run list` to find the run ID and `realm run resume` as described in the timeout section below.

Either way, the agent will:

1. Start the run — `fetch_content` executes automatically via the filesystem adapter.
2. Receive a prompt asking it to summarise the article. It submits `title`,
   `summary`, and `word_count`. If any field fails schema validation, it receives
   `provide_input` and must correct and resubmit. The run stays at `summarise` until
   the schema passes.
3. Receive a second prompt asking it to produce a formatted article result. The prompt
   already contains the verified title, summary, and word count from step 2. It submits
   `headline` and `message`. Same schema enforcement applies — both fields have minimum
   length requirements.
4. Once `tag_content`'s schema passes, `record_result` runs and the workflow completes.

**When `tag_content` fails with a provider timeout:**

```bash
realm run list          # find the run-id — state will be 'summarised'
realm run resume <run-id> --from tag_content
```

Then start a new MCP session and ask the agent to continue. The run resumes at `tag_content`
with the same validated inputs. Steps 1 and 2 are not re-run.

## Inspect the evidence chain

After the run completes, check what each step received and produced:

```bash
realm run inspect <run-id>
```

The evidence chain shows four entries in order: `fetch_content`, `summarise`, `tag_content`,
`record_result`. In the resume-after-timeout scenario, `tag_content` appears twice — once
for the failed attempt (with the provider timeout error) and once for the successful retry.
You can see the timestamp of the failed attempt and the successful retry side by side. Steps
1 and 2 appear only once each — they were not re-run.

## Configuration reference

`params_schema` requires:

| Field | Type   | Description                            |
| ----- | ------ | -------------------------------------- |
| path  | string | Absolute path to the article text file |

## What to look at next

- [Example 3 — Incident Response](../03-incident-response/) — the preceding example in the
  ladder; demonstrates human gates and structured approval before a message is sent
- [Workflow file reference](../../docs/reference/workflow/top-level-fields.md) — all step fields, execution
  modes, service adapters, and input_schema configuration
