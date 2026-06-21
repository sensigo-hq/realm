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
- `package.json` / project manifest has accurate name, version, description, and entry points. Version follows Semantic Versioning: patch for bug fixes, minor for new backwards-compatible features, major for breaking changes.
- No files that shouldn't be public: credentials, local config, database files, logs, build output
- **No hardcoded secrets, API keys, tokens, or environment-specific paths in source code**
- License file is present if this is an open-source release

### 8. Final Verification

1. Re-read every file modified in this session. Verify each is coherent, complete, and consistent with adjacent code.
2. Confirm nothing private, internal, or unfinished is exposed in the public surface.

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

**8. Rollback note**

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
