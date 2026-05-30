---
applyTo: '**'
---

# Pull Request Standards

This policy applies to all agents and human contributors across all repositories.

---

## PR Title

Use [Conventional Commits](https://www.conventionalcommits.org/) format:

```
type(scope): short imperative description
```

| Type       | When to use                               |
| ---------- | ----------------------------------------- |
| `feat`     | New feature or capability                 |
| `fix`      | Bug fix                                   |
| `chore`    | Maintenance, dependencies, config         |
| `refactor` | Code restructure with no behaviour change |
| `docs`     | Documentation only                        |
| `test`     | Test additions or changes                 |
| `perf`     | Performance improvement                   |
| `ci`       | CI/CD configuration                       |
| `security` | Security fix or vulnerability patch       |
| `revert`   | Reverting a prior commit                  |

**Rules:**

- Lowercase throughout
- Imperative mood: "add X", "fix Y", not "added X" or "fixes Y"
- No period at the end
- Scope is optional but preferred when the change is localised (e.g. `fix(auth): …`)

---

## PR Body

Always write the body to a temp file and pass it with `--body-file`:

```bash
cat > /tmp/pr-body.md << 'BODY'
<content>
BODY

gh pr create \
  --title "type(scope): description" \
  --body-file /tmp/pr-body.md \
  --base main \
  --head branch-name
```

**Never** use `--body "..."` inline — multiline content becomes unreadable and escaping errors are common.

---

## Required Sections

Every PR body must contain these sections in this order. Omit only `## Root Cause` when there is no bug (feature PRs replace it with `## Motivation`).

### `## Context`

What prompted this change. Include:

- Who reported it / what triggered the work (ticket ID, issue number, date)
- What was observed (the symptom, not the cause)
- Any relevant quoted communication or linked discussion

### `## Root Cause` _(bugs)_ / `## Motivation` _(features)_

**For bugs:** The confirmed root cause. State what the code was doing and why it was wrong. Do not conflate symptom with cause.

**For features:** Why this capability is needed. What problem it solves and for whom.

### `## Changes`

What changed and why each change was made. For non-trivial logic, include before/after code snippets. If the change has multiple distinct parts (e.g. a data fix + a code fix), use sub-sections.

### `## Verification`

Concrete, copy-pasteable commands the reviewer can run to confirm the change works. Include expected output where meaningful. Do not write "I tested it locally" — write the commands.

### `## Rollback`

How to revert this change if it causes a production incident. At minimum:

```bash
git revert HEAD
```

If the change includes out-of-band data mutations (e.g. external API calls, database writes) that cannot be reverted with `git revert`, state this explicitly and describe the manual revert steps.

### `## Related` _(optional)_

Links to tickets, issues, other PRs, or external references. Use when relevant.

To auto-close a linked issue when this PR merges, place a closing keyword on its own line in the PR body:

```
Closes #123
```

Supported keywords: `Closes`, `Fixes`, `Resolves` (case-insensitive). GitHub will close the referenced issue automatically on merge.

---

## Commit Messages

Individual commit messages (not the PR title) follow the same Conventional Commits format.

Keep commit messages focused: one logical change per commit. Avoid bundling unrelated changes into a single commit.

---

## Branch Hygiene

- Delete the branch after merge (use `--delete-branch` with `gh pr merge`)
- Do not leave stale branches on remote

---

## Enforcement for Agents

Before running `gh pr create`, verify the draft PR body satisfies every required section above. A PR body that is missing sections, uses vague language, or omits verification commands is not acceptable.
