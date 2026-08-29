---
applyTo: '**'
---

# Pre-Publication Checklist

## Part A — Every PR Merge

Follow this checklist in order before merging any branch into `main`.

### 1. Remove Dead Code

- Delete commented-out code blocks (not explanatory comments — actual dead code)
- Remove unused variables, imports, and functions
- Remove TODO/FIXME/HACK comments that reference incomplete work — either finish the work or delete the comment and its stub
- Remove development logging (debug prints, console.log, etc.) unless it is intentional production logging
- Remove broken or irrelevant test files

### 2. Automated Checks _(hard gate — must pass before merge)_

- Run linter; zero errors and zero warnings
- Run type-checker (if applicable); clean output
- Run dependency vulnerability audit (`npm audit --audit-level=high` or equivalent) — scope to production dependencies; no high or critical findings
- `npm run deps:audit` — knip's dead/phantom dependency gate. Exit 0 with zero findings AND zero configuration hints. This runs on the weekly scheduled audit, NOT on PR CI, so nothing else catches it: issue #415 sat red for five days, invisible to every PR check.
- `node scripts/check-action-pins.mjs` — every GitHub Action pinned to a SHA whose comment matches it
- `npm run typecheck:tests` — post-build, because it type-checks against `dist`
- Release-diff hygiene sweep for stray debug output:
  ```bash
  git diff <prev-tag>..main -- ':(glob)packages/*/src/**' | grep -cE '^\+.*console\.'
  git diff <prev-tag>..main -- ':(glob)packages/*/src/**' | grep -cE '^\+'
  ```
  **A review gate, never a zero-hits gate.** Print the hit count BESIDE the total added lines — a zero-hit sweep over a zero-line diff is self-refuting, and reporting only the numerator hides that. Realm's own render code legitimately writes to the console, so hits are expected (29 on this release). ENUMERATE them and adjudicate each as intentional production output; an unadjudicated hit blocks the merge.
- All CI pipeline checks are green on the PR before merging

### 3. Comments and Documentation

- Every exported function, class, or module has at least a one-sentence description
- Parameters and return values are documented for all public functions
- Comments explain **why**, not **what** — remove comments that just restate the code
- Non-obvious decisions, edge cases, and performance choices are explained inline
- Each file has a brief top-level comment stating what it contains

### 4. Public API Review _(hard gate for breaking changes)_

- Every publicly exported symbol is intentionally public — internals are clearly marked or unexported
- Similar operations have consistent signatures (options object vs positional args — pick one pattern)
- All documented configuration options are implemented and functional
- Default values are sensible and documented
- **If any exported symbol's signature or behaviour changes in a non-backwards-compatible way:** this is a breaking change — flag it explicitly. Do not merge without a CHANGELOG entry planned, a major version bump in the version plan, and a migration guide committed or linked.
- **Pre-1.0 (0.x), breaking changes MAY ship in a minor** when flagged **BREAKING** in the changelog with upgrade guidance; 1.0.0 is reserved. (House precedent: v0.14.0, the #390 trio adjudication.)

### 5. Test Coverage

- Every public function or module has at least one test
- No skipped, pending, or commented-out tests — either implement them or delete them
- Edge cases flagged in comments are covered

### 6. README

- README accurately reflects the current state of the code
- Includes: what the project is, how to install/run it, a minimal working example, configuration reference, and how to run tests
- No references to features that don't exist or were removed

### 7. Repository Hygiene _(hard gate — no secrets)_

- `.gitignore` covers all build artifacts, dependency directories, IDE files, OS files, local config, and secrets
- `package.json` / project manifest has accurate name, version, description, and entry points. Version follows Semantic Versioning: patch for bug fixes, minor for new backwards-compatible features, major for breaking changes — **except pre-1.0 (0.x), where a breaking change MAY ship in a minor if flagged BREAKING in the changelog with upgrade guidance (see §4)**.
- No files that shouldn't be public: credentials, local config, database files, logs, build output
- **No hardcoded secrets, API keys, tokens, or environment-specific paths in source code**
- License file is present if this is an open-source release

### 8. Final Verification

1. Re-read every file modified in this session. Verify each is coherent, complete, and consistent with adjacent code.
2. Confirm nothing private, internal, or unfinished is exposed in the public surface.
3. Operator-facing changes: the customer-journey walk (guardrail 8 — fresh-eyes lane + crown, findings dispositioned) must have run at PR review.

---

## Part B — Release Publication

> Run Part B after the Part A PR has been merged and your local `main` is up to date (`git switch main && git pull`).
>
> This repository uses a two-part release process. The release script (`scripts/release.mjs`) bumps all four packages atomically and creates the release git commit and tag. Publishing to npm is handled by `.github/workflows/publish.yml`, which is triggered automatically when the tag is pushed after the release PR is merged. Do not attempt manual per-package publishes; the workflow is the authoritative publish mechanism.
>
> A package with `"private": true` in its manifest is not published. Part B does not apply to it.

**When to run Part B:** Cut a release when `[Unreleased]` in `CHANGELOG.md` contains at least one `### Added`, `### Changed`, or `### Security` entry and all open PRs for the milestone are merged. Do not let `[Unreleased]` accumulate across multiple sessions without a release — npm will show the previous version until a tag is pushed.

**1. Create a release branch**

```bash
git switch main && git pull
git switch -c release/v<version>
```

**2. Update CHANGELOG.md**

Rename `## [Unreleased]` to `## [<version>] — YYYY-MM-DD`. Use [keepachangelog.com](https://keepachangelog.com/en/1.1.0/) sections: `## Added`, `## Changed`, `## Fixed`, `## Removed`, `## Deprecated`, `## Security`. Rules:

- Security entries must link to a CVE or advisory if applicable.
- Breaking changes: include a note referencing the migration guide.
- If using automated CHANGELOG tooling (changesets, git-cliff), run the tool and verify its output before committing.

Commit:

```bash
git add CHANGELOG.md
git commit -m "docs: update changelog for v<version>"
```

**3. Run the release script**

```bash
npm run release -- --version <version>
```

The script: checks the working tree is clean, bumps `version` in all four `package.json` files and five source-file `VERSION` constants, runs `npm run build` as a local sanity check, stages the changed files, commits with `chore: release v<version>`, and creates the git tag `v<version>`. It does **not** publish — publishing is handled by GitHub Actions when the tag is pushed. If any step fails, the script exits without creating the commit or tag — fix the issue and re-run.

**4. Push and open a PR**

```bash
git push -u origin release/v<version>
```

Open a PR to `main`. Use **merge commit** (`gh pr merge --merge`) — not rebase, not squash. The release script tags the release commit on the branch before the PR is opened; a rebase merge would rewrite that commit's SHA, making the tag a dangling reference unreachable from `main` and breaking the publish workflow. Merge after CI passes.

**5. Push the tag**

> **Hard gate — this is the only action that triggers the automated npm publish pipeline.** `publish.yml` fires on `push: tags: v*` and will not run until this command is executed. Packages remain at the previous version on npm despite CI being green and the PR being merged until this step runs. Do not skip it.

After the PR is merged:

```bash
git switch main && git pull
git push --tags
```

Pushing the tag triggers `.github/workflows/publish.yml`, which builds and publishes all four packages to npm using OIDC Trusted Publishing — no token required.

**6. Verify the publish workflow**

Go to https://github.com/sensigo-hq/realm/actions and confirm the **Publish** workflow triggered and completed successfully on the `v<version>` tag. Each of the four `npm publish` steps should be green.

**7. Verify the published artifact**

Install the package in a clean environment and confirm the minimal working example from the README runs correctly. `@sensigo/realm` is **ESM-only**, so verify with an ESM `import` — `require()` throws `ERR_PACKAGE_PATH_NOT_EXPORTED`:

```bash
mkdir /tmp/test-install && cd /tmp/test-install
npm init -y
npm install @sensigo/realm@<version>
node --input-type=module -e "import { VERSION } from '@sensigo/realm'; console.log(VERSION);"
```

**8. Verify the consumer** _(user-side, Mac-executed)_

Not runnable from WSL — realm-workspace and its deploy live on the Mac. Every other step in Part B
is a hard gate; this one is a hard gate **on the Mac**, so a Part B run elsewhere records it as
pending rather than wedging on it.

On the Mac, before the deploy — realm-workspace against the published release:

```bash
npm install @sensigo/realm@<version> @sensigo/realm-cli@<version> @sensigo/realm-mcp@<version> --save-exact
npm test
npx realm workflow validate workflows/<each>/workflow.yaml
```

then `npm run deploy`.

**9. Rollback note**

If the publish workflow fails after some packages are published but before all four complete: re-push the tag (delete and re-push, or re-trigger the workflow manually). `npm publish` will skip packages already at the target version with a `EPUBLISHCONFLICT` error. Confirm all four packages appear on the registry before proceeding.

If the tag was pushed but verification (step 7) reveals a broken artifact: publish a patch release following this entire Part B sequence with an incremented patch version.

---

## Naming Consistency

_(Review these before running the build in Part B step 3. For projects with fully configured linting, passing Automated Checks §2 satisfies most of these items.)_

- File names follow a single consistent convention throughout the project (pick one: camelCase, kebab-case, snake_case)
- Types and classes are PascalCase
- Functions and variables are camelCase or snake_case — consistently, not mixed
- Constants are UPPER_SNAKE_CASE
- No single-letter variable names outside of loop indices and obvious lambda shorthand
- Equivalent concepts use the same name everywhere — no `opts` vs `options`, `handler` vs `callback` for the same pattern

## Code Consistency

_(Review these before running the build in Part B step 3. For projects with fully configured linting, passing Automated Checks §2 satisfies most of these items.)_

- Consistent quote style (single or double — pick one)
- Consistent semicolons (all or none)
- Consistent indentation and spacing
- Consistent brace and bracket style
- Same patterns used for the same operations — no mixing paradigms without a documented reason
- Error handling follows a uniform pattern across all similar components

---

## Agent Instructions

**Part A**

- Do not refactor architecture during a publication pass. Structure is intentional. This is a cleanup pass.
- Do not add new features. If you find something worth improving, note it but do not implement it.
- Do not change public API signatures without explicit instruction.
- If you find a genuine bug, fix it and document what you fixed and why.

**Part B**

- Treat each numbered step as a hard gate. Do not proceed to the next step until the current step has completed successfully.
- Do not run `npm run release` directly on `main`. Always use a `release/v<version>` branch.
- Do not create git tags manually. The release script creates the tag after a successful publish.
