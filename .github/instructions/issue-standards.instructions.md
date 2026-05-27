---
applyTo: '**'
---

# GitHub Issue Standards

This policy applies to all agents and human contributors across all 187n repositories.

---

## When to Open an Issue

Open an issue when:

- A bug is confirmed and a fix will be a separate piece of work (not done immediately in the same session)
- A security vulnerability is identified that requires a dedicated fix
- A feature or improvement is agreed but not yet started
- A task must be tracked, assigned, or discussed before implementation begins

Do **not** open an issue for:

- Changes already captured in an open or merged PR
- One-line fixes done in the same session as the discovery
- Vague ideas without a defined scope — clarify first, then file

---

## Issue Title

Use a concise, descriptive imperative phrase prefixed with a type label:

```
[type] short imperative description
```

| Type         | When to use                                             |
| ------------ | ------------------------------------------------------- |
| `[bug]`      | Confirmed misbehaviour in production or staging         |
| `[security]` | Vulnerability, data exposure, or access control failure |
| `[feat]`     | New capability or user-facing feature                   |
| `[chore]`    | Maintenance, dependency updates, configuration          |
| `[perf]`     | Performance degradation or improvement opportunity      |
| `[docs]`     | Missing or incorrect documentation                      |

**Rules:**

- Imperative mood: "lock bot to owner" not "bot should be locked" or "locking bot"
- Lowercase after the type prefix
- No period at the end
- Be specific: `[security] telegram bot responds to any user` not `[security] bot issue`

---

## Issue Body

Always write the body to a temp file and pass it with `--body-file`:

```bash
cat > /tmp/issue-body.md << 'BODY'
<content>
BODY

gh issue create \
  --title "[type] description" \
  --body-file /tmp/issue-body.md \
  --label "bug" \
  --repo owner/repo
```

**Never** use `--body "..."` inline — multiline content becomes unreadable and escaping errors are common.

---

## Required Sections

Every issue body must contain these sections in this order.

### `## Summary`

One or two sentences. What is wrong or what is needed. Written for someone who has no prior context.

### `## Current Behaviour` _(bugs and security only)_

What is actually happening. Be specific: include the affected component, the trigger condition, and the observable symptom. Do not conflate symptom with root cause.

### `## Expected Behaviour` _(bugs and security only)_

What should happen instead.

### `## Root Cause` _(if known)_

The confirmed or strongly suspected cause. If unknown, write `Under investigation.` Do not guess and state it as fact.

### `## Motivation` _(features and chores only)_

Why this is needed. What problem it solves and for whom.

### `## Proposed Fix` _(if known)_

What the solution should be. Keep it at the approach level — implementation detail belongs in the PR. If multiple options exist, list them with tradeoffs.

### `## Acceptance Criteria`

A numbered list of conditions that must be true for this issue to be considered resolved. Each item must be verifiable.

```
1. New users completing setup must have TELEGRAM_ALLOWED_USERS set to their ID
2. Existing deployed containers can have the value updated without full re-provisioning
3. Unit tests cover the new field in buildCustomerRow
```

### `## Severity` _(bugs and security only)_

| Label           | Meaning                                                   |
| --------------- | --------------------------------------------------------- |
| `P0 — critical` | Production data exposed, service down, or revenue blocked |
| `P1 — high`     | Significant user impact; no safe workaround               |
| `P2 — medium`   | Impact is real but a workaround exists                    |
| `P3 — low`      | Minor inconvenience; negligible user impact               |

### `## Related` _(optional)_

Links to relevant PRs, issues, Supabase rows, Whop dashboard entries, or external references.

---

## Labels

Apply at least one label when creating the issue. Use the labels that exist on the repo; create new ones only if none fit.

Common labels:

- `bug` — confirmed misbehaviour
- `security` — access control, data exposure, secrets
- `enhancement` — new feature or improvement
- `chore` — maintenance / housekeeping
- `blocked` — cannot progress until a dependency is resolved

---

## Enforcement for Agents

Before running `gh issue create`, verify:

1. The issue body contains every required section for its type
2. Acceptance criteria are numbered and verifiable — not vague
3. Severity is set for bugs and security issues
4. The title uses the correct type prefix and imperative mood
5. `--body-file` is used, not `--body "..."`

An issue body that is missing sections, uses vague acceptance criteria, or omits severity for a security finding is not acceptable.
