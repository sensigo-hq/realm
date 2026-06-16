---
applyTo: '**'
---

# Git Workflow Policy

This policy applies to all agents and human contributors working across all repositories.

## The Rule

All changes flow through branches. **Direct commits to `main` are not permitted on any repo.**

```
git switch main
git pull
git switch -c feat/scope/description
# make changes
git add .
git commit -m "feat(scope): add thing"
git push -u origin feat/scope/description
# open PR into main
```

## Repos

This rule applies to every repository without exception. The reviewer for any given repo is whoever owns that project. When in doubt, ask the human to confirm the reviewer before opening a PR.

The reviewer and the branch author may be the same person — the PR still exists as a record.

---

## Branch Naming Convention

| Type            | Pattern                          | Example                                |
| --------------- | -------------------------------- | -------------------------------------- |
| Feature         | `feat/{scope}/{description}`     | `feat/api/add-klaviyo-flow`            |
| Bug fix         | `fix/{scope}/{description}`      | `fix/auth/shopify-token-refresh`       |
| Hotfix          | `hotfix/{description}`           | `hotfix/critical-null-pointer`         |
| Chore / deps    | `chore/{description}`            | `chore/update-env-docs`                |
| Docs            | `docs/{description}`             | `docs/update-readme`                   |
| Refactor        | `refactor/{scope}/{description}` | `refactor/core/simplify-state-machine` |
| Performance     | `perf/{scope}/{description}`     | `perf/db/optimise-query`               |
| Tests           | `test/{scope}/{description}`     | `test/core/add-edge-cases`             |
| CI / infra      | `ci/{description}`               | `ci/add-lint-step`                     |
| Security        | `security/{description}`         | `security/patch-cve-2024-1234`         |
| Revert          | `revert/{description}`           | `revert/feat-klaviyo-flow`             |
| AI agent branch | `agent/{branch-name}`            | `agent/setup-dev-workspace`            |

**Rules:**

- Use lowercase and hyphens. No spaces. No uppercase.
- `{scope}` is optional for single-scope repos but preferred when the change is localised to a package, service, or feature area.
- For client-services work, `{scope}` is the client name (e.g. `fix/maxim/shopify-token-refresh`).

---

## Commit Messages

Follow [Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```
type(scope): short imperative description

[optional body]

[optional footer(s)]
```

| Type       | When to use                               |
| ---------- | ----------------------------------------- |
| `feat`     | New feature or capability                 |
| `fix`      | Bug fix                                   |
| `chore`    | Maintenance, dependencies, config         |
| `docs`     | Documentation only                        |
| `refactor` | Code restructure with no behaviour change |
| `perf`     | Performance improvement                   |
| `test`     | Test additions or changes                 |
| `ci`       | CI/CD configuration                       |
| `security` | Security fix or vulnerability patch       |
| `revert`   | Reverting a prior commit                  |

**Rules:**

- Lowercase throughout.
- Imperative mood: "add X", "fix Y" — not "added X" or "fixes Y".
- No period at the end of the description.
- Subject line ≤ 50 characters. Wrap the body at 72 characters.
- Scope is optional but preferred when the change is localised.
- Breaking changes: append `!` after the type/scope (e.g. `feat!: drop Node 18 support`) and add a `BREAKING CHANGE:` footer.

---

## Branch Lifecycle

- Delete the branch after merge. Never leave stale branches on remote.
- **Never force-push** (`--force` / `-f`) to any branch that has an open PR or has been shared with others. Force-pushing rewrites history and breaks reviewer workflows.
- `git push --force-with-lease` is permitted on your own branch to clean up commits **before** review has started — never after.

---

## PR Merge Strategy

- **Rebase merge is the default.** Individual commits are replayed onto `main` with their original messages and a linear history is preserved. Use `gh pr merge --rebase`.
- **Merge commit is required for `release/v*` branches.** The release script tags the release commit on the branch before the PR is opened. A rebase merge would rewrite that commit's SHA, making the tag a dangling reference unreachable from `main` and breaking the publish workflow. Use `gh pr merge --merge` for release PRs only.
- **Squash merge** is permitted when a branch has a noisy commit history that adds no value to the record (e.g. many "wip" or "fix" commits with no meaningful structure).
- Do not mix strategies beyond the above rules without a documented reason.

---

## Stacked / Dependent Branches

Never open a PR from a branch that is based on another unmerged feature branch.

For sequentially-dependent work, choose one of two approaches:

- **Combine** — put both phases in a single branch and open one PR.
- **Sequence** — merge the first PR before branching the second.

Opening PR2 while PR1 is unmerged creates a rebase dependency: PR2's diff on GitHub shows both branches combined, auto-merge becomes unreliable, and a rebase is required after PR1 lands. This is avoidable.

---

## Draft PRs

Open a draft PR when:

- The branch is ready for early feedback but not yet ready to merge.
- CI must run but the work is incomplete.
- You want to signal work is in progress without triggering a review request.

Convert to ready-for-review only when all checklist items are satisfied and CI passes.

---

## Enforcement for Agents

- **Never push directly to `main`** on any repo.
- Always create a branch before making any changes.
- After pushing a branch, open a PR. Do not merge it yourself unless explicitly authorised by the human.
- If a task prompt does not specify a branch name, generate one following the naming convention above and state it in your report.
- Never use `--force` on any branch. `--force-with-lease` is only permitted before review has started.
