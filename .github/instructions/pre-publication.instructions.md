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
> This repository uses a two-part release process. The release script (`scripts/release.mjs`) bumps every package to one version, creates the release commit and tag, and then moves the tree to the next development version. Publishing to npm is handled by `.github/workflows/publish.yml`, which is triggered automatically when the tag is pushed after the release PR is merged. Do not attempt manual per-package publishes; the workflow is the authoritative publish mechanism.
>
> A package with `"private": true` in its manifest is not published. The release script still sets its version when its `package.json` has `exports` or `main`, like every package it sets.

**When to run Part B:** Cut a release when `[Unreleased]` in `CHANGELOG.md` contains at least one `### Added`, `### Changed`, or `### Security` entry and all open PRs for the milestone are merged. Do not let `[Unreleased]` accumulate across multiple sessions without a release — npm will show the previous version until a tag is pushed.

**0. Pre-flight — release-diff hygiene sweep**

Stray debug output, over the whole release rather than one PR:

```bash
git diff <prev-tag>..main -- ':(glob)packages/*/src/**' | grep -cE '^\+.*console\.'
git diff <prev-tag>..main -- ':(glob)packages/*/src/**' | grep -cE '^\+'
```

**A review gate, never a zero-hits gate.** Print the hit count BESIDE the total added lines — a zero-hit sweep over a zero-line diff is self-refuting, and reporting only the numerator hides that. Realm's own render code legitimately writes to the console, so hits are expected. ENUMERATE them and adjudicate each as intentional production output; an unadjudicated hit blocks the release.

**1. Create a release branch**

```bash
git switch main && git pull
git switch -c release/v<version>
```

**2. Update CHANGELOG.md**

Rename `## [Unreleased]` to `## [<version>] — YYYY-MM-DD`. Use [keepachangelog.com](https://keepachangelog.com/en/1.1.0/) sections: `### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Deprecated`, `### Security`. Rules:

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

_What it checks first._ Before it changes anything, the script refuses: an unfinished earlier release; another release running in this repository, or the lock a killed one left; a version written with a leading `v`, or one that is not `MAJOR.MINOR.PATCH`; a run on `main`, on no branch, on another version's release branch, or on any other branch while `release/v<version>` exists; a working tree with uncommitted changes or untracked files; a tree that fails `check-versions`; a file it sets that is a symbolic link, or that has CRLF line ends (in the checkout, or in the commit itself); a `package-lock.json` it cannot set the versions in, or an `npm-shrinkwrap.json`; a `package-lock.json` that does not record a dependency a `package.json` declares (`npm ci` would refuse the tree); a version not above the current one; a `CHANGELOG.md` with no `## [<version>]` section; a tag that already exists on origin (a `v*` tag pushed there starts the Publish workflow) or here; and a version that is already published or not above the highest published one. It reads the npm registry for that, and refuses if it cannot. For a version already prepared on the branch (HEAD its development commit or a commit after it, on its tagged release commit, the two commits holding only what the release writes) it says so, and exits 0.

_What it does._ It works in two steps. First it sets every package's version in its `package.json`, its `src/version.ts` and `package-lock.json`, runs `npm run build`, commits `chore: release v<version>` and creates the tag `v<version>`. Then it sets the next development version (`X.Y.Z+1-dev.0`) and commits `chore: begin development after v<version>`, so the source tree never claims to be a release. It does **not** publish: publishing happens in GitHub Actions when the tag is pushed. With the repository's hooks installed (`npm run setup`), each of the two commits runs the pre-commit hook, which can take a minute and prints its output.

_What it never does._ It never overwrites a change it did not make to a version file other than `package-lock.json`, and never tags or finishes a commit that holds one: `--resume` refuses instead, a failed release leaves such a file as it is, and when a git hook changes one of its commits or makes another, the release stops and names the files or the commit, and the reset (back to the commit it made, when a hook only made another commit after it, so nothing is built again). A file's mode counts as part of it. It never keeps a symbolic link in place of a file it sets: where it would offer to keep or set aside a change, it offers only putting the file back, since `git stash` cannot carry a link through the release. It sets the versions in `package-lock.json` itself and never runs npm for it; npm keeps using the repository's own copies of realm's packages only while every dependency on them in the repository is `"*"` and no `overrides` entry names one, so the release refuses otherwise. Wherever it puts files back, it puts `package-lock.json` back too, and says so when that throws a change away: if the change came from `npm install`, run it again after the release.

_If it stops:_

- If it says a release is already running in this repository, wait for that run, or stop it with the `kill` it names. If it says a release ran here and is no longer running (the script was killed, or the machine went down), delete its lock with the `git update-ref -d` command it prints, then run the command it names. That command names the lock by its id, so it cannot delete a lock another release took in the meantime. If it says it cannot tell whether that release is still running, or cannot read the lock, find out first: delete the lock with the command it prints only when no release is running here. The script never deletes another run's lock itself, and a release whose lock is deleted under it stops at its next step and changes nothing more.
- If the checkout left the release branch while the release ran (a `git switch` in another terminal), it stops, changes nothing more, and names the switch back (and, when a commit of the release was made on the other branch, the `git merge --ff-only` that takes it); `npm run release -- --resume` there puts the files back or goes on, as it says.
- Before it changed anything (HEAD or a version file changed while it read origin and the registry), it says what changed and leaves nothing to undo: re-run it, after committing, stashing or discarding a change to a file it names (it prints the command that discards it; a file replaced by a symbolic link is put back instead, with the command it prints).
- Before the release commit (the build failed, for example), it restores every tracked file it changed, except one that also holds a change it did not make, which it leaves as it is and names with what to do (for a file a symbolic link replaced, the command that puts the file back); it also names anything else left uncommitted, since the re-run needs a clean checkout: re-run it once the cause is fixed. `packages/*/dist` may still hold the new version's build, so run `npm run build` before using this checkout.
- If HEAD moved after it started and before its release commit (a commit made during the build, or after a crash), and that commit changes none of the files it sets, it restores them (after a crash, `--resume` does) and tells you to re-run, which releases the new HEAD. If the commit does change them (`git commit -a` takes the release's own changes with it), it names the commit and the reset that takes it off the branch; after the reset, `--resume` puts back the files the release changed, and the release runs again with `--version`.
- Whenever `--resume` only puts files back (the branch holds no release commit), it exits 1: nothing is released until you re-run the release with `--version`, as it says.
- After the release commit, it tells you to run `npm run release -- --resume`, which finishes the remaining steps. Run it on the branch the release ran on: anywhere else it refuses and names that branch.
- If the release branch was put back by hand to before a commit of the release and committed on, `--resume` refuses and names the command that keeps the commits moving the branch would take off on a branch (`git branch <branch>-kept-<commit> <commit>`), then the reset that moves it; once the release has finished, its message names that branch and the command that brings the commits back.
- After a crash, run the release command again: it names the command that deletes the lock the killed run left, and the next command. If the script was killed rather than interrupted, a build it started can keep running for a while, still printing to the terminal: wait until that output stops.

_To abandon an unfinished release_ after its release commit, before anything is pushed (before the release commit, `--resume` puts the files back and the release starts again): when the branch was put back by hand before the release commit, and maybe committed on since, the script's message names its own commands for abandoning it, items 3 and 4 below run from where the branch is (so commits made since are released too; when a reset kept the files, it first names the restore that puts the release's changes back, and the set-aside for a file that holds a change of yours): run those. Otherwise run these one at a time, in this order:

1. To keep commits of yours made after the release's own (the reset in item 2 takes them off the branch), put them on a branch first: `git branch release/v<version>-kept-<commit> <commit>`, `<commit>` being HEAD's (`git rev-parse --short HEAD`). The script's message names this command when it names those commits. When the release has run again, its success message names that branch and the commands that bring them back on top of the release, a merge among them too.
2. Put the release branch back at your changelog commit (Part B step 2; `git log --oneline` shows it below `chore: release v<version>`) with `git reset --keep <your changelog commit>`, which moves the branch and its files and refuses rather than overwrite a change of yours (any commit after it leaves the branch). If the reset refuses, it names the file that holds your change: set that change aside (`git stash push -- <the file>`) and run the reset again. The release's success message then names the stash (`git stash pop`; if that conflicts, keep version `X.Y.Z+1-dev.0` and your other changes in that file, then `git restore --staged -- <the file>` and `git stash drop`).
3. Only once the reset has succeeded, delete the tag if `git tag --list v<version>` lists it (`git tag -d v<version>`), then the journal (`rm -f "$(git rev-parse --git-dir)/realm-release.json"`).
4. Run the release again from the start (`npm run release -- --version <version>`), then the commands its success message names for a kept branch and a stash. To have the release include the commits you kept instead (a fix to the release's own notes, for example), bring them back before you run it: `git rebase --rebase-merges --onto release/v<version> <last> release/v<version>-kept-<commit>`, `<last>` being the commit the script's message counted them after (the last commit of the abandoned release), then `git switch release/v<version>`, `git merge --ff-only release/v<version>-kept-<commit>` and `git branch -D release/v<version>-kept-<commit>`.

_To finish an unfinished release by hand_ when the script says its journal cannot be read, or no longer matches the repository, or that HEAD is, or comes after, a commit of an unfinished release no journal records, work on the release branch from what HEAD is (to abandon the release instead, follow _To abandon an unfinished release_ above; when a journal it cannot read leaves nothing of the release behind, the script says so instead: delete the journal and re-run; when an unfinished release that no journal records misses only its tag, the script names the one command that finishes it instead):

1. If HEAD is none of the three commits below (a commit a git hook made, or one of yours, after the latest of them, which the script names), put the branch back to it (`git reset <that commit>`): the commits after it leave the branch, and their changes stay in your files; commit them again after item 7.
2. If HEAD is `chore: begin development after v<version>` or `chore: release v<version>`, check that it changes only versions: `git diff --name-only HEAD~1 HEAD` names exactly `package-lock.json` and the `package.json` and `src/version.ts` of every package the release sets (each `packages/*` whose `package.json` has `exports` or `main`), and `git diff HEAD~1 HEAD` changes only their `version` fields and VERSION lines, each to `<version>` at `chore: release v<version>` and to the next development version (`X.Y.Z+1-dev.0`) at `chore: begin development after v<version>`. If it names another file, misses one (a commit a git hook made with the same subject may change nothing), sets another version, or changes anything else, put the branch back one commit (`git reset HEAD~1`) and check again.
3. Each time you put the branch back, in item 1 or 2, also put the version files back to where it now is (`git restore --staged --worktree -- package-lock.json 'packages/*/package.json' 'packages/*/src/version.ts'`; this discards any change of yours to those files, so set yours aside first, and item 7 brings it back): the reset keeps the commit's changes in the files, and the items below would commit a hook's change again.
4. At `chore: begin development after v<version>`, the release is done once its parent is tagged: if `git tag --points-at HEAD~1` does not list `v<version>`, create it (`git tag --no-sign v<version> HEAD~1`; if git answers that it already exists, it points elsewhere: delete it first, `git tag -d v<version>`). Then go on with item 7.
5. At `chore: release v<version>`: create the tag if `git tag --points-at HEAD` does not list `v<version>` (`git tag --no-sign v<version>`; if git answers that it already exists, delete it first, `git tag -d v<version>`). Set the next development version (`X.Y.Z+1-dev.0`) exactly as the release writes it, in every package the release sets: the `version` of its `package.json` and of its entry in `package-lock.json`, and the `VERSION` line of its `src/version.ts`. This command works that version out from the release commit's and does that and nothing else (`npm pkg set` would also reorder other fields):

   ```bash
   node -e '
     const fs = require("fs");
     const { execFileSync } = require("child_process");
     const held = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "package-lock.json", "packages/*/package.json", "packages/*/src/version.ts"], { encoding: "utf8" }).trim();
     if (held !== "") {
       console.error(`These files hold changes that are not committed, which the commit of item 5 would take:\n${held}\nSet them aside first (git stash push -- ${held.split("\n").join(" ")}), then run this command again; item 7 brings them back.`);
       process.exit(1);
     }
     const dirs = fs.readdirSync("packages").map((name) => `packages/${name}`).filter((dir) => {
       if (!fs.existsSync(`${dir}/package.json`)) return false;
       const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`, "utf8"));
       return pkg.exports !== undefined || pkg.main !== undefined;
     });
     const released = JSON.parse(fs.readFileSync(`${dirs[0]}/package.json`, "utf8")).version;
     const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(released);
     if (parts === null) {
       console.error(`The packages are at ${released}, not a released version: run this at the release commit (item 5).`);
       process.exit(1);
     }
     const version = `${parts[1]}.${parts[2]}.${Number(parts[3]) + 1}-dev.0`;
     const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
     for (const dir of dirs) {
       const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`, "utf8"));
       pkg.version = version;
       fs.writeFileSync(`${dir}/package.json`, JSON.stringify(pkg, null, 2) + "\n");
       const ts = fs.readFileSync(`${dir}/src/version.ts`, "utf8");
       fs.writeFileSync(`${dir}/src/version.ts`, ts.replace(/^export const VERSION = \x27[^\x27]+\x27;$/m, `export const VERSION = \x27${version}\x27;`));
       lock.packages[dir].version = version;
     }
     fs.writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
     console.log(`Set ${dirs.length} packages to ${version}.`);
   '
   ```

   Commit only those files: `git commit -m "chore: begin development after v<version>" -- package-lock.json 'packages/*/package.json' 'packages/*/src/version.ts'`. That commit takes everything in those files, so the command first refuses, writing nothing, while one of them holds a change of yours: set it aside with the `git stash push` command it prints, and run the command again; item 7 brings it back. It also refuses when the packages are not at a released version (run it at `chore: release v<version>`).

6. At your changelog commit (Part B step 2), nothing of the release is on the branch: restore the version files (`git restore --staged --worktree -- package-lock.json 'packages/*/package.json' 'packages/*/src/version.ts'`; this discards any change of yours to those files, so set yours aside first), and delete the tag if `git tag --list v<version>` lists it (`git tag -d v<version>`).
7. Then delete the journal if there is one (`rm -f "$(git rev-parse --git-dir)/realm-release.json"`). If you finished the release (item 4 or 5), run `npm run build` (`packages/*/dist` may still hold the released version's build) and check that `node scripts/check-versions.mjs` passes; if it does not, do not edit the files its message names (the script checks the development commit itself, so a fixing commit on top leaves the release unfinished): put the branch back on the release commit (`git reset --keep HEAD~1`) and do item 5 again. Then bring back any change you set aside for this release, in item 3 or 5 or when the script asked for a clean checkout (`git stash pop`; if that conflicts, keep version `X.Y.Z+1-dev.0` and your other changes in that file, then `git restore --staged -- <the file>` and `git stash drop`), and continue with Part B step 4: `npm run release -- --resume` now says the release is prepared, and exits 0. If nothing of the release was on the branch (item 6), run the release again: `npm run release -- --version <version>`; its success message names a change you set aside.

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
git push origin v<version>
```

Push only this tag: `git push --tags` would also push any stray local tag, and the workflow publishes every `v*` tag it receives.

Pushing the tag triggers `.github/workflows/publish.yml`, which builds and publishes every package to npm using OIDC Trusted Publishing — no token required.

**6. Verify the publish workflow**

Go to https://github.com/sensigo-hq/realm/actions and confirm the **Publish** workflow triggered and completed successfully on the `v<version>` tag. Each publish step should be green.

**7. Verify the published artifact**

Install the package in a clean environment and confirm the minimal working example from the README runs correctly. `@sensigo/realm` is **ESM-only**, so verify with an ESM `import` — `require()` throws `ERR_PACKAGE_PATH_NOT_EXPORTED`:

```bash
mkdir /tmp/test-install && cd /tmp/test-install
npm init -y
npm install @sensigo/realm@<version>
node --input-type=module -e "import { VERSION } from '@sensigo/realm'; console.log(VERSION);"
```

**8. Create the GitHub Release**

Once steps 6 and 7 have passed, create the release's page on GitHub by hand. Its title is `v<version>`, and its text is the `## [<version>]` section of `CHANGELOG.md` as the tag `v<version>` holds it, without the heading. Run these one at a time, in the checkout where you ran step 5 (it holds the tag). The first writes the section to a file and says how many lines it holds: read the file before you run the second.

````bash
node -e '
  const fs = require("fs");
  const { execFileSync } = require("child_process");
  const [version, out] = process.argv.slice(1);
  let changelog;
  try {
    changelog = execFileSync("git", ["show", `v${version}:CHANGELOG.md`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    console.error(`There is no tag v${version} here: run this in the checkout where you ran step 5, or fetch the tag first (git fetch origin tag v${version}).`);
    process.exit(1);
  }
  const lines = changelog.split("\n");
  const head = `## [${version}]`;
  const start = lines.findIndex((l) => l === head || l.startsWith(`${head} `));
  if (start === -1) {
    console.error(`CHANGELOG.md at v${version} has no ${head} section.`);
    process.exit(1);
  }
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## ["));
  if (end === -1) end = lines.length;
  const body = lines.slice(start + 1, end);
  while (body.length > 0 && ["", "---"].includes(body[0].trim())) body.shift();
  while (body.length > 0 && ["", "---"].includes(body[body.length - 1].trim())) body.pop();
  // GitHub shows every line break in the text of a release, and CHANGELOG.md wraps its lines, so
  // join each wrapped line to the one before it (never inside a code block, never a new item).
  const joined = [];
  let inCode = false;
  for (const line of body) {
    const fence = /^\s*```/.test(line);
    const prev = joined.length > 0 ? joined[joined.length - 1] : "";
    const startsBlock = /^\s*([-*+] |\d+\. |#{1,6}(\s|$)|\||>)/.test(line);
    const prevJoinable = prev.trim() !== "" && !/^\s*(#{1,6}(\s|$)|\||```)/.test(prev);
    if (!inCode && !fence && line.trim() !== "" && !startsBlock && prevJoinable) {
      joined[joined.length - 1] = `${prev} ${line.trim()}`;
    } else {
      joined.push(line);
    }
    if (fence) inCode = !inCode;
  }
  fs.writeFileSync(out, joined.join("\n") + "\n");
  console.log(`Wrote ${joined.length} lines of the v${version} notes to ${out}.`);
' <version> /tmp/realm-v<version>-notes.md
````

```bash
gh release create v<version> --repo sensigo-hq/realm --title "v<version>" --notes-file /tmp/realm-v<version>-notes.md --verify-tag
```

Before you run the second, check the file: its first line is the opening paragraph of the release notes, its last line is the last entry of the section (not the next version's heading and not `---`), and each list item is one line.

`--verify-tag` makes `gh` refuse when `v<version>` is not on GitHub: push the tag (step 5) and run it again. Without `--verify-tag`, `gh` would create a new tag `v<version>` from the latest commit of `main`, which is not the release commit, and a pushed `v*` tag starts the Publish workflow. If a release for the tag already exists (a second run), `gh release view v<version>` shows it; to replace its text, run `gh release edit v<version> --notes-file /tmp/realm-v<version>-notes.md`. Create no release for a version whose publish did not finish: if the publish needs a new version (step 10), create the release for the new version instead.

**9. Verify the consumer** _(user-side, Mac-executed)_

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

**10. Rollback note**

If the publish workflow fails after some packages are published: open the failed **Publish** run on the Actions page and re-run all its jobs. Each publish step skips a package already published from the tagged commit and publishes the rest. A package already published from a different commit makes its step fail instead; that needs a new version. A run that failed at "Check versions, and that the tag names the version" fails there again: the tag names a commit whose packages are not at the tag's version. Push the tag the release script created instead, as that check says; when origin already holds that tag's name at another commit, that needs a new version too. Starting the workflow by hand does not help: a manual run is always a dry run. Confirm every package appears on the registry before proceeding.

If the tag was pushed but verification (step 7) reveals a broken artifact: publish a patch release following this entire Part B sequence with an incremented patch version.

**11. Bump the website's live demo**

The home page's live demo (`website/src/live/`, #624) runs the Realm release its pins name, in the visitor's browser. After a successful publish (step 7), bump it, or record in the release notes why it stays on the older release.

1. In `website/package.json`, set `@sensigo/realm`, `@sensigo/realm-mcp` and `@sensigo/realm-testing` to `<version>`. Move all three together: the build refuses a bundle that holds more than one copy of `@sensigo/realm`. If realm-mcp's own pin of `@modelcontextprotocol/sdk` is now 1.31.0 or later, drop that `overrides` entry, as its `//overrides` note says. Then run `npm install --ignore-scripts` in `website/` (`website/` has no `.npmrc`, so the flag is needed).
2. Copy the workflow from the new tag: `git show v<version>:examples/08-pr-review/workflow.yaml > website/src/live/workflow.yaml`.
3. Re-record the replay on the new release, as the header of `website/scripts/replay/record.mjs` says:
   - `NM` is a folder outside the repository holding a `package.json` with `@sensigo/realm-cli` and `@sensigo/realm-testing` at `<version>`, and the same `@modelcontextprotocol/sdk` pin and `$` override as `website/package.json`; run `npm install --ignore-scripts` in it.
   - `WORK` is an empty folder outside any folder that holds a `package.json` or a `.git`; otherwise `realm workflow register` refuses and the recorder fails.
   - In `website/`: `NM=<nm> WORK=<work> node scripts/replay/record.mjs`, then `WORK=<work> node scripts/replay/distill.mjs`, then `npx prettier --write src/data/replay.json`.
   - The new `src/data/replay.json` should differ from the old one only in run and gate ids, durations, `realm_version` and `recorded_at`. Any other difference is a change in what the engine does; read it before going on.
4. Run `npm run build` in `website/`. It runs the build guard (`scripts/live/smoke.mjs`), which must print `GUARD PASSED`.
5. Serve `website/dist` (for example `python3 -m http.server 8624 --bind 0.0.0.0 --directory dist`) and run `scripts/live/walk.cjs` on it, as its header says. It must print `WALK PASSED: 0 FAIL`.
6. Re-run the claim ledger at the top of `stageSentences` in `website/src/live/view.mjs`. The guard checks the rows marked "guard"; check the rows marked "hand" yourself on the new release.

If a step shows that the new release makes a sentence of the demo untrue, change the sentence and its ledger row in `view.mjs` before deploying, or keep the demo on the older release and say why in the release notes.

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
- Run `npm run release` on the `release/v<version>` branch from step 1. The script refuses `main`, a detached HEAD, another version's release branch, and any other branch while `release/v<version>` exists; when that branch does not exist it accepts a branch with another name, so make the branch first. Run one release at a time in a repository and wait for it to end before you run anything else there: a second run, or `--resume`, is refused while one is running. Delete a lock only with the command the script prints: when it says that release is no longer running; and when it says it cannot tell, or cannot read the lock, only after you have made sure no release is running in this repository (ask the person who runs releases).
- `npm run release -- --resume` exits 1 when it only puts files back (the branch holds no release commit), and when there is nothing to resume (the whole message is `Error: There is no unfinished release to resume.`; for a release already prepared on the branch, the text instead starts `There is no unfinished release to resume: v<version> is prepared here`, without `Error:`, and exits 0): the step has not completed until the release is run with `--version` and succeeds.
- `npm run release -- --version <version>` for a version already prepared on the branch, and `npm run release -- --resume` after it, exit 0 and say that the release is prepared: the step is complete. When that text, or the success message, names changes that are not committed, a branch kept for this release, or stashes, bring back only what you set aside or kept for this release yourself, as the text says; leave the rest as it is and report it.
- Do not create release tags manually. The release script creates the tag, and, while its journal records the release, `npm run release -- --resume` creates it if it is missing. The exceptions create the tag of an unfinished release whose journal cannot be read or no longer matches the repository, or that no release journal records, and apply only if you finish that release rather than abandon it: step 3's _To finish an unfinished release by hand_, and, when an unfinished release that no journal records misses only its tag, the tag command the script names. Pushing the tag starts the publish.
