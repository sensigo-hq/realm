# Example 07 — Issue Triage

**Pain:** A human reviewing an LLM-generated triage is given no structural guarantee that
the comment and labels only reach GitHub if they approve. The review is a context switch
with no enforcement — the agent can write to GitHub before the human has seen anything,
or write despite a rejection if the logic is in prompt instructions.

**After:** `trust: human_confirmed` on the triage step pauses execution at a structured gate.
The agent produces `{severity, labels, comment_draft}` — the human sees that exact output
(rendered via the `display` field) and chooses `approve` or `reject`. Two write steps
(`post_comment` and `apply_labels`) carry `when: "triage_issue.choice == 'approve'"` — the
engine evaluates these after gate resolution. On reject, both are moved to `skipped_steps`
and nothing touches GitHub.

---

## What this shows

```
fetch_issue    (auto — github adapter, get_issue)
     │
triage_issue   (agent + gate — severity, labels, comment_draft)
     │          Human sees the triage via display field; approves or rejects.
     ├── post_comment   (auto — github adapter, post_comment)   ┐ structurally
     └── apply_labels   (auto — github adapter, apply_labels)   ┘ parallel
```

**Key points:**

- `triage_issue` is both the agent step and the gate step (`trust: human_confirmed`).
  The agent produces `{severity, labels, comment_draft}`; the `display` field is rendered
  by the CLI and shown to the reviewer at gate time.
- `post_comment` and `apply_labels` each declare `when: "triage_issue.choice == 'approve'"`.
  On reject, `propagateSkips` moves both to `skipped_steps` automatically — the engine
  enforces the gate outcome, not the agent.
- `resolution_messages` on the gate provides a confirmation message for both `approve` and
  `reject` paths — no extra step or CLI change required.
- `GITHUB_TOKEN` must be present for write operations to authenticate with GitHub. Add it
  to a `.env` file in the repo root — the workflow is configured with
  `realm.yaml` binds the github adapter's token via `${secret:GITHUB_TOKEN}` (resolved from `.env`).

---

## Parallel execution note

The two write steps (`post_comment` and `apply_labels`) are structurally parallel — both
become eligible at the same time after gate resolution. MCP sessions (VS Code + Copilot)
can execute both simultaneously via subagent fan-out. The `realm agent` CLI executes them
sequentially — it picks `eligible[0]` on each iteration.

---

## Install

```bash
# From the repo root
npm install
```

---

## Run fixture tests

```bash
realm workflow test examples/07-issue-triage/workflow.yaml -f examples/07-issue-triage/fixtures/
```

Two fixtures:

- `approve-critical-issue.yaml` — gate choice: approve; asserts `post_comment` and
  `apply_labels` appear in evidence as `success`
- `reject-issue.yaml` — gate choice: reject; asserts `skipped_steps` contains both
  `post_comment` and `apply_labels`

Expected output:

```
Realm Test — examples/07-issue-triage/workflow.yaml
  PASS critical memory leak — approved
  PASS memory leak issue — rejected

2/2 passed
```

---

## Requirements

Create a `.env` file in the repo root with your GitHub token:

```bash
GITHUB_TOKEN=ghp_...
```

Credentials live in the deployment manifest (`realm.yaml`) — the loader reads
the value from `.env` and injects it into the GitHubAdapter at run time. The `realm agent`
preflight enforces that `GITHUB_TOKEN` is set before starting a run.

Ensure the token has `issues:write` and `issues:read` scope on the target repository.

---

## Run with an AI agent

**Option A — VS Code + Copilot (MCP)**

Register the workflow and start the MCP server:

```bash
realm workflow register examples/07-issue-triage/workflow.yaml

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

> Triage this issue with Realm: repo acme/api-service issue 123

Or with explicit params:

> Run issue triage with Realm for repo acme/api-service, issue 42

Realm fetches the issue, runs the triage agent, and presents the formatted output
(`severity`, `labels`, `comment_draft`) at the gate. Choose `approve` to post or `reject`
to discard.

**Option B — `realm agent` CLI (no VS Code required)**

Replace `your-org/your-repo` and `123` with a real repository and issue number that your
`GITHUB_TOKEN` can access (the token needs `issues:read` and `issues:write` on that repo).

```bash
realm agent \
  --workflow examples/07-issue-triage/workflow.yaml \
  --params "{\"repo\":\"your-org/your-repo\",\"issue_number\":123}"
```

Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` before running. Use `--provider anthropic` to
switch providers.

When the run reaches `triage_issue`, `realm agent` pauses and displays the triage output:

```
⏸  Gate: triage_issue | ID: gate-abc123

   Severity: critical
   Labels: ["bug", "P1", "memory"]
   Comment: Triaged as critical. This appears to be a memory leak...

   Approve: realm run respond <run-id> --gate <gate-id> --choice approve
   Reject:  realm run respond <run-id> --gate <gate-id> --choice reject
   Waiting for approval...
```

In a separate terminal, run the printed command to approve or reject:

```bash
# To approve (posts comment and applies labels):
realm run respond <run-id> --gate <gate-id> --choice approve

# To reject (no writes reach GitHub):
realm run respond <run-id> --gate <gate-id> --choice reject
```

`realm agent` detects the resolved gate and continues automatically.

---

## Inspect the evidence chain

```bash
realm run inspect <run-id>
```

On approve: evidence includes `fetch_issue`, `triage_issue`, `post_comment`, and
`apply_labels` — all at `status: success`.

On reject: `skipped_steps` lists `post_comment` and `apply_labels`. Evidence includes only
`fetch_issue` and `triage_issue`. The routing decision is recorded permanently — the audit
trail shows which `when` condition was evaluated and that neither write step was reached.

---

## Configuration reference

`params_schema` requires:

| Field        | Type    | Description                              |
| ------------ | ------- | ---------------------------------------- |
| repo         | string  | GitHub repository in `owner/repo` format |
| issue_number | integer | The GitHub issue number to triage        |

---

## What to look at next

- [Example 3 — Incident Response](../03-incident-response/) — the original human-gate
  example: a gate on an auto step (no agent output at gate time) with routing on gate choice.
- [Example 6 — Ticket Router](../06-ticket-router/) — `when` conditions for routing without
  a gate; structurally similar to the post-gate routing here.
- [YAML Schema Reference](../../docs/reference/yaml-schema.md) — `trust: human_confirmed`,
  `when` condition syntax, `resolution_messages`, and `display` field.
