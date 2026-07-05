# Example 09 — Webhook PR Review

**Pain:** Standard webhook pipelines commit all three side effects — MCP tool calls, Slack
notifications, GitHub writes — in a single handler with no structural boundary between them.
The human review step is a convention in a `README.md`, not an enforced pause. If the LLM
skips the `get_pull_request_files` call, the review is based on incomplete data but nothing
stops it from proceeding. If the reviewer is busy, the pipeline writes to GitHub anyway.

**After:** Realm enforces the ordering from webhook receipt through MCP calls →
schema-validated output (`review_body`, `confirmation_text`) → human gate → conditional
GitHub write → Slack confirmation. `analyze_changes` cannot run until `fetch_pr` records
real diff data. `post_review` cannot execute until the gate resolves `approve`. On reject,
`post_review` and `notify_posted` land in `skipped_steps` — the evidence chain is complete
whether or not you approved.

---

## What this shows

```
fetch_pr          (agent — GitHub MCP: get_pull_request, get_pull_request_files)
     │
analyze_changes   (agent — GitHub MCP: get_pull_request)
     │            Produces: review_body, confirmation_text
     │
approve_review    (gate — approve / reject)
     ├── post_review    (auto — GitHub adapter, post_comment)
     │        │
     │   notify_posted  (auto — Slack adapter, post_message)
     │                  Sends confirmation_text after review is posted.
     └── [skipped on reject]
```

**Key points:**

- `fetch_pr` and `analyze_changes` connect to GitHub through the
  `@modelcontextprotocol/server-github` MCP server — not the internal GitHub adapter.
  The adapter is used only for the write step (`post_review`).
- `approve_review` is an auto step with `trust: human_confirmed`. The engine evaluates the
  `when` condition on `post_review` after gate resolution — not the agent.
- On reject: `post_review` and `notify_posted` move to `skipped_steps`. Nothing is written
  to GitHub.
- `confirmation_text` is composed by `analyze_changes` and sent by `notify_posted` only
  on the approve path — after the review has been posted to GitHub.

---

## Install

```bash
# From the repo root
npm install
```

---

## Run fixture tests

```bash
realm workflow test examples/09-webhook-pr-review/workflow.yaml \
  -f examples/09-webhook-pr-review/fixtures/
```

Two fixtures:

- `approve-review.yaml` — gate choice: approve; `post_review` and `notify_posted` in
  evidence; run reaches `completed`
- `reject-review.yaml` — gate choice: reject; `skipped_steps` contains `post_review` and
  `notify_posted`

Expected output:

```
Realm Test — examples/09-webhook-pr-review/workflow.yaml
  PASS pr review — approved
  PASS pr review — rejected

2/2 passed
```

---

## Requirements

Create a `.env` file in this example's directory (next to `realm.yaml`):

```bash
# GitHub — PR read and write
GITHUB_TOKEN=ghp_...             # needs contents:read and pull_requests:write

# AI provider — one of:
OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...

# Slack — required for gate notification and post-approval confirmation
SLACK_WEBHOOK_URL=https://hooks.slack.com/...  # bound TWICE in realm.yaml: adapters.slack AND notifiers.slack_gate
SLACK_BOT_TOKEN=xoxb-...         # bound in realm.yaml notifiers.slack_gate
SLACK_CHANNEL_ID=C...            # bound in realm.yaml notifiers.slack_gate
SLACK_APP_TOKEN=xapp-...         # bound in realm.yaml notifiers.slack_gate (Socket Mode)

# Webhook secret — must match the secret set in GitHub webhook settings
GITHUB_WEBHOOK_SECRET=<your-secret>
```

**Slack setup notes:**

Your Slack bot needs the OAuth scopes `chat:write` and `channels:history` on the target
channel.

All of these are **secret values in `.env`**, referenced from this example's `realm.yaml` deployment manifest (`${secret:NAME}` bindings) — the gate notifier and adapters are constructed from the manifest, not from environment reads.

This example is the canonical illustration of the **slack adapter-vs-notifier distinction**: `adapters.slack` constructs the SERVICE adapter the `notify_posted` step calls (`uses_service: slack`), while `notifiers.slack_gate` configures the human-gate notification channel. Two constructions, one Slack integration — both reference the same `${secret:SLACK_WEBHOOK_URL}`.

The fixture tests above need **no credentials**: `realm workflow test` runs in sentinel mode and the fixtures mock the github and slack services.

`SLACK_WEBHOOK_URL` is used by the Slack adapter for `notify_posted` — the confirmation
message sent to Slack after the review is approved and posted to GitHub.

`SLACK_BOT_TOKEN` + `SLACK_CHANNEL_ID` are used by the gate transport when `approve_review`
opens — the transport posts the gate with the full review draft and choice commands to the
channel.

`SLACK_APP_TOKEN` enables [Socket Mode](https://api.slack.com/apis/socket-mode). With it,
you can resolve the gate by replying `approve` or `reject` in the Slack thread where the
gate was posted. Without it, the gate falls back to terminal resolution via
`realm run respond` (see Option B below).

---

## Run with an AI agent

### Option A — VS Code + MCP

Register the workflow and start the MCP server:

```bash
realm workflow register examples/09-webhook-pr-review/workflow.yaml

# Start the MCP server:
realm mcp
```

With VS Code: open the workspace — `realm mcp` starts automatically via `.vscode/mcp.json`.

> **Custom agents (Copilot, Claude):** if you are using a custom agent defined in
> `.github/agents/*.agent.md`, add `realm/*` to its `tools:` list — this grants access
> to every tool the Realm MCP server exposes without having to list them individually.
> Default (non-custom) agents in VS Code pick up all MCP tools automatically.

Open Copilot chat and provide the PR params directly (useful for testing without a live
webhook):

> Run the Webhook PR Review workflow with Realm for PR 42 in acme/api-service.

You will need to supply the full `params_schema` fields — see the Configuration reference
below for the complete list.

### Option B — `realm listen`

Use this option to connect a live GitHub webhook. The workflow's `trigger:` block (see
`workflow.yaml`) handles verification, event filtering, dedup, and param mapping — there are no
per-event CLI flags.

**Step 1: Expose a local port**

```bash
ngrok http 4000
```

Copy the `https://` forwarding URL.

**Step 2: Configure a GitHub webhook**

In your repository → **Settings → Webhooks → Add webhook**:

- **Payload URL**: `https://<your-ngrok-id>.ngrok-free.app/webhook-pr-review` (the `trigger.path`)
- **Content type**: `application/json`
- **Secret**: any random string — set it as `GITHUB_WEBHOOK_SECRET` (the workflow's
  `trigger.auth.secret_from`)
- **Events**: select **Pull requests**

**Step 3: Start the listener**

```bash
GITHUB_WEBHOOK_SECRET=<your-webhook-secret> \
realm listen examples/09-webhook-pr-review/workflow.yaml --port 4000
```

The `trigger:` block declares `auth.mode: github` (verifying the HMAC signature against
`GITHUB_WEBHOOK_SECRET`), filters to `pull_request` opened/synchronize, dedups by delivery id, and
maps the PR payload into run params. Ensure all env vars from the Requirements section are set before
running.

**Step 4: Open or update a pull request**

When the event arrives, the terminal logs:

```
realm listen on 127.0.0.1:4000 — 1 workflow(s) mounted
webhook: dispatched {"path":"/webhook-pr-review","run_id":"run-x1y2z3","pid":12345}
```

The agent runs `fetch_pr` and `analyze_changes` autonomously. When `analyze_changes`
completes, `notify_reviewer` fires and posts the review draft to your Slack channel.

When the gate opens, the output includes:

```
⏸  Gate: approve_review | ID: gate-def456

   PR #42 — acme/api-service
   Title: Add rate limiting to auth endpoints
   Author: dev-user

   Drafted review:
   The rate limiting implementation looks solid...

   Approve: realm run respond <run-id> --gate <gate-id> --choice approve
   Reject:  realm run respond <run-id> --gate <gate-id> --choice reject
   Waiting for approval...
```

If `SLACK_APP_TOKEN` is set (Socket Mode), you can resolve the gate by replying `approve`
or `reject` in the Slack thread where the gate was posted.

Otherwise, in a separate terminal:

```bash
# To approve (posts the review to GitHub and confirms on Slack):
realm run respond <run-id> --gate <gate-id> --choice approve

# To reject (no writes reach GitHub):
realm run respond <run-id> --gate <gate-id> --choice reject
```

---

## Inspect the evidence chain

```bash
realm run inspect <run-id>
```

On approve: evidence includes `fetch_pr`, `analyze_changes`, `approve_review`, `post_review`,
and `notify_posted` — all at `status: success`.

On reject: `skipped_steps` lists `post_review` and `notify_posted`. Evidence includes only
`fetch_pr`, `analyze_changes`, and `approve_review`. The gate choice is
recorded permanently — the audit trail shows which choice was made and that no write reached
GitHub.

---

## Configuration reference

`params_schema` requires:

| Field                | Type    | Description                                         |
| -------------------- | ------- | --------------------------------------------------- |
| `pr_number`          | integer | Pull request number                                 |
| `repo`               | string  | Full repository name in `owner/repo` format         |
| `repo_owner`         | string  | Repository owner                                    |
| `repo_name`          | string  | Repository name                                     |
| `pr_title`           | string  | Pull request title                                  |
| `head_sha`           | string  | Head commit SHA                                     |
| `pr_url`             | string  | Pull request URL                                    |
| `author`             | string  | PR author login                                     |
| `pr_action`          | string  | Webhook action (`opened` or `synchronize`)          |
| `github_delivery_id` | string  | GitHub delivery ID — used to prevent duplicate runs |
| `base_sha`           | string  | Base commit SHA (optional)                          |

---

## What to look at next

- [Example 3 — Incident Response](../03-incident-response/) — the original gate example:
  a gate on an auto step with no agent output at gate time.
- [Example 7 — Issue Triage](../07-issue-triage/) — agent step combined with a gate;
  approve fires parallel writes, reject skips both.
- [Example 8 — PR Review](../08-pr-review/) — PR review without a webhook trigger; both
  gate choices post to GitHub.
- [YAML Schema Reference](../../docs/reference/yaml-schema.md) — `trust: human_confirmed`,
  `when` condition syntax, `resolution_messages`, the `trigger:` block, and `realm listen`.
