#!/usr/bin/env node
// scripts/release.mjs — issue #620 PR-A (D6). Every realm release goes through this script:
// bump every package to the new version, build, commit and tag the release, then move the tree
// to a development version so no later build of `main` ever claims to be a release.
//
// Usage: npm run release -- --version <MAJOR.MINOR.PATCH>
//        npm run release -- --resume
// Test-only: --root <dir>, --registry-fixture <file> (see readPublishedVersions below).
//
// Every entry check runs BEFORE any file is written: `checkRelease` (scripts/lib/check-release.mjs)
// is the same check `publish.yml` runs against the tagged tree, so this script never tags a
// release the publish workflow would refuse.
//
// The two phases (release, then development) each end in a commit, and each phase's start is
// recorded in a journal (`realm-release.json`, in the git directory — never in the working tree,
// so it is never dirty and never committed, and it lands in the RIGHT place for a linked
// worktree too). On failure or interrupt, the script reads git and the journal to work out
// exactly what happened, restores any uncommitted edits from the journal's own recorded commit
// (never from in-memory state — that would not survive a crash), and tells the releaser precisely
// what to run next. `--resume` reads the same state and finishes from wherever it is.

import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRelease } from './lib/check-release.mjs';
import {
  readReleaseSet,
  publishedSet,
  isFinal,
  isAbove,
  devVersionAfter,
  VERSION_LINE,
} from './lib/release-set.mjs';

// ── small git/text helpers ─────────────────────────────────────────────────────────────────────

function gitSync(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function tryGit(root, ...args) {
  try {
    return gitSync(root, ...args);
  } catch {
    return null;
  }
}
function tryGitCapture(root, ...args) {
  try {
    return { output: gitSync(root, ...args), error: null };
  } catch (e) {
    return { output: null, error: e.stderr ? String(e.stderr) : String(e.message) };
  }
}
function shortSha(root, sha) {
  return gitSync(root, 'rev-parse', '--short', sha);
}
function firstLine(text) {
  for (const line of String(text).split('\n')) {
    if (line.trim().length > 0) return line.trim();
  }
  return '(no output)';
}

// ── the journal: outside the working tree, in the git directory (correct in a linked worktree,
// where --git-dir is a path unique to that worktree — never `.git` itself) ───────────────────────

function journalPathFor(root) {
  const gitDirOut = gitSync(root, 'rev-parse', '--git-dir');
  const gitDir = isAbsolute(gitDirOut) ? gitDirOut : join(root, gitDirOut);
  return join(gitDir, 'realm-release.json');
}
function readJournal(journalPath) {
  return JSON.parse(readFileSync(journalPath, 'utf-8'));
}
function writeJournal(journalPath, journal) {
  const tmp = `${journalPath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(journal, null, 2) + '\n');
  renameSync(tmp, journalPath);
}
function removeJournal(journalPath) {
  unlinkSync(journalPath);
}

const STATE_WORDS = {
  'nothing-committed': 'nothing is committed yet',
  'committed-untagged': 'the release commit exists, but it is not tagged',
  tagged: 'the release is tagged; the development version is not committed',
  done: 'every commit exists; only the journal is left',
};

/**
 * The state the journal and the git history are actually in. Both the failure path and
 * `--resume` use this — one function, so they can never disagree about what happened.
 */
function readState(root, journal) {
  const V = journal.version;
  const head = gitSync(root, 'rev-parse', 'HEAD');
  const subjectOf = (sha) => tryGit(root, 'log', '-1', '--format=%s', sha);
  const parentOf = (sha) => tryGit(root, 'rev-parse', `${sha}^`);
  const tagSha = tryGit(root, 'rev-parse', '-q', '--verify', `refs/tags/v${V}`);

  if (journal.phase === 'release') {
    const releaseCommit =
      subjectOf(head) === `chore: release v${V}` && parentOf(head) === journal.startSha
        ? head
        : null;
    if (head === journal.startSha) return { name: 'nothing-committed' };
    if (releaseCommit !== null && tagSha === null)
      return { name: 'committed-untagged', releaseCommit };
    if (releaseCommit !== null && tagSha === releaseCommit && head === releaseCommit) {
      return { name: 'tagged', releaseCommit };
    }
    return { name: 'unknown' };
  }

  // phase === 'development': the release commit is the journal's own record of it, not derived.
  const releaseCommit = journal.releaseSha;
  if (head === releaseCommit && tagSha === releaseCommit) return { name: 'tagged', releaseCommit };
  if (
    subjectOf(head) === `chore: begin development after v${V}` &&
    parentOf(head) === journal.releaseSha &&
    tagSha === journal.releaseSha
  ) {
    return { name: 'done', releaseCommit };
  }
  return { name: 'unknown' };
}

function hasChangedSince(root, sha, files) {
  try {
    execFileSync('git', ['diff', '--quiet', sha, '--', ...files], { cwd: root, stdio: 'ignore' });
    return false;
  } catch {
    return true;
  }
}
function restoreFiles(root, sha, files) {
  try {
    execFileSync('git', ['restore', `--source=${sha}`, '--staged', '--worktree', '--', ...files], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: firstLine(e.stderr ? String(e.stderr) : String(e.message)) };
  }
}
function printRestoreFailedAndExit(reason) {
  console.error(`Error: Restoring the files failed: ${reason}. Run: npm run release -- --resume`);
  process.exit(1);
}
function printUnknown(root, journalPath, journal) {
  const shortStart = shortSha(root, journal.startSha);
  const shortHead = shortSha(root, gitSync(root, 'rev-parse', 'HEAD'));
  console.error(
    `Error: The release journal describes v${journal.version}, started at ${shortStart}, but this checkout matches none of its steps (HEAD is ${shortHead}). Inspect the history, then delete ${journalPath}.`,
  );
}
function printSuccess(root, journal, releaseCommit) {
  const short = shortSha(root, releaseCommit);
  console.log(
    `Released v${journal.version}: commit ${short}, tag v${journal.version}. Development continues at ${journal.devVersion}.`,
  );
  console.log('Next steps:');
  console.log('  1. Push the branch:  git push -u origin HEAD');
  console.log(
    '  2. Open the release PR and merge it with a merge commit (not squash, not rebase), so the tagged commit is on main.',
  );
  console.log(
    `  3. Push the tag:     git switch main && git pull && git push origin v${journal.version}`,
  );
  console.log(
    '     Pushing the tag starts the Publish workflow. Push only this tag: --tags would push every local tag.',
  );
  process.exit(0);
}

// ── running steps: async, interruptible, journal-aware on failure ────────────────────────────

let interrupted = null;
let currentChild = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    interrupted = sig;
    if (currentChild) currentChild.kill(sig);
  });
}

function run(root, cmd, cmdArgs) {
  return new Promise((resolveStep, rejectStep) => {
    currentChild = spawn(cmd, cmdArgs, { cwd: root, stdio: 'inherit' });
    currentChild.on('exit', (code, signal) => {
      currentChild = null;
      if (interrupted) rejectStep(new Error(`interrupted by ${interrupted}`));
      else if (code === 0) resolveStep();
      else rejectStep(new Error(`${cmd} ${cmdArgs.join(' ')} exited ${code ?? signal}`));
    });
    currentChild.on('error', (err) => {
      currentChild = null;
      rejectStep(err);
    });
  });
}
async function step(label, fn) {
  console.log(`→ ${label}`);
  if (interrupted) throw new Error(`interrupted by ${interrupted}`);
  await fn();
  if (interrupted) throw new Error(`interrupted by ${interrupted}`);
}

function bumpFiles(root, set, newVersion) {
  for (const m of set) {
    const pkgPath = join(root, m.dir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    pkg.version = newVersion;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    const versionFile = join(root, m.dir, 'src/version.ts');
    const content = readFileSync(versionFile, 'utf-8');
    if (!VERSION_LINE.test(content)) throw new Error(`${m.dir}/src/version.ts has no VERSION line`);
    writeFileSync(
      versionFile,
      content.replace(VERSION_LINE, `export const VERSION = '${newVersion}';`),
    );
  }
}

const INSTALL_ARGS = [
  'install',
  '--package-lock-only',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
];

async function onFailure(root, journalPath, reason) {
  const journal = readJournal(journalPath);
  const state = readState(root, journal);

  if (state.name === 'nothing-committed') {
    const r = restoreFiles(root, journal.startSha, journal.files);
    if (!r.ok) printRestoreFailedAndExit(r.reason);
    removeJournal(journalPath);
    console.error(
      `Error: The release of v${journal.version} stopped: ${reason}. Every file it changed is restored. Fix the cause, then re-run: npm run release -- --version ${journal.version}`,
    );
    process.exit(1);
  }
  if (state.name === 'committed-untagged') {
    console.error(
      `Error: The release commit for v${journal.version} exists (${shortSha(root, state.releaseCommit)}), but it is not tagged: ${reason}. Fix the cause, then run: npm run release -- --resume`,
    );
    process.exit(1);
  }
  if (state.name === 'tagged') {
    if (hasChangedSince(root, state.releaseCommit, journal.files)) {
      const r = restoreFiles(root, state.releaseCommit, journal.files);
      if (!r.ok) printRestoreFailedAndExit(r.reason);
    }
    console.error(
      `Error: v${journal.version} is committed and tagged, but the development version is not committed: ${reason}. Fix the cause, then run: npm run release -- --resume`,
    );
    process.exit(1);
  }
  if (state.name === 'done') {
    removeJournal(journalPath);
    printSuccess(root, journal, state.releaseCommit);
    return;
  }
  printUnknown(root, journalPath, journal);
  process.exit(1);
}

async function enterAndRunPhase2(root, journalPath, journal, set, V) {
  const releaseSha =
    journal.phase === 'development' ? journal.releaseSha : gitSync(root, 'rev-parse', 'HEAD');
  const newJournal = {
    version: journal.version,
    devVersion: journal.devVersion,
    phase: 'development',
    startSha: releaseSha,
    releaseSha,
    files: journal.files,
  };
  writeJournal(journalPath, newJournal);
  const devV = journal.devVersion;
  const files = journal.files;
  try {
    await step(`Setting every package to ${devV}`, () => bumpFiles(root, set, devV));
    await step('Syncing the lockfile', () => run(root, 'npm', INSTALL_ARGS));
    await step('Staging the release files', () => run(root, 'git', ['add', '--', ...files]));
    await step(`Committing chore: begin development after v${V}`, () =>
      run(root, 'git', ['commit', '-m', `chore: begin development after v${V}`, '--', ...files]),
    );
  } catch (e) {
    await onFailure(root, journalPath, e.message);
    return;
  }
  removeJournal(journalPath);
  printSuccess(root, newJournal, releaseSha);
}

async function runPhase1(root, journalPath, journal, set, V) {
  const files = journal.files;
  try {
    await step(`Setting every package to v${V}`, () => bumpFiles(root, set, V));
    await step('Syncing the lockfile', () => run(root, 'npm', INSTALL_ARGS));
    await step('Building', () => run(root, 'npm', ['run', 'build']));
    await step('Staging the release files', () => run(root, 'git', ['add', '--', ...files]));
    await step(`Committing chore: release v${V}`, () =>
      run(root, 'git', ['commit', '-m', `chore: release v${V}`, '--', ...files]),
    );
    await step(`Tagging v${V}`, () => run(root, 'git', ['tag', '--no-sign', `v${V}`]));
  } catch (e) {
    await onFailure(root, journalPath, e.message);
    return;
  }
  await enterAndRunPhase2(root, journalPath, journal, set, V);
}

// ── the registry read (readable at entry-check time, and swappable in tests) ─────────────────

/**
 * `{ kind: 'ok', versions: string[] }` or `{ kind: 'error', firstLine: string }`. Real npm: an
 * E404 (the package was never published) counts as `ok` with no versions — that is fine, a brand
 * new package has never been released. With `--registry-fixture <file>`, a published member
 * missing from the fixture is itself treated as an unreadable registry.
 */
function readPublishedVersions(root, name, fixturePath) {
  if (fixturePath !== null) {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));
    if (!(name in fixture)) return { kind: 'error', firstLine: `no fixture entry for ${name}` };
    const entry = fixture[name];
    if (entry.error !== undefined) {
      if (entry.error === 'E404') return { kind: 'ok', versions: [] };
      return { kind: 'error', firstLine: entry.error };
    }
    return { kind: 'ok', versions: entry.versions ?? [] };
  }
  const result = spawnSync('npm', ['view', name, 'versions', '--json'], {
    cwd: root,
    encoding: 'utf-8',
  });
  if (result.status === 0) {
    const trimmed = (result.stdout ?? '').trim();
    const parsed = trimmed === '' ? [] : JSON.parse(trimmed);
    return { kind: 'ok', versions: Array.isArray(parsed) ? parsed : [parsed] };
  }
  let isE404 = false;
  try {
    const parsed = JSON.parse(result.stdout ?? '');
    if (parsed?.error?.code === 'E404') isE404 = true;
  } catch {
    // not the E404 JSON shape: fall through to the generic refusal
  }
  if (isE404) return { kind: 'ok', versions: [] };
  return { kind: 'error', firstLine: firstLine((result.stderr ?? '') || (result.stdout ?? '')) };
}

// ── --version: every entry check, before any write ────────────────────────────────────────────

async function runVersion(root, journalPath, V, registryFixturePath) {
  if (existsSync(journalPath)) {
    const journal = readJournal(journalPath);
    const state = readState(root, journal);
    if (state.name === 'unknown') {
      printUnknown(root, journalPath, journal);
    } else {
      console.error(
        `Error: An earlier release of v${journal.version} did not finish: ${STATE_WORDS[state.name]}. Run: npm run release -- --resume`,
      );
    }
    process.exit(1);
  }

  if (gitSync(root, 'status', '--porcelain').length > 0) {
    console.error(
      'Error: The working tree has uncommitted changes. Commit or stash them, then re-run.',
    );
    process.exit(1);
  }

  if (!isFinal(V)) {
    console.error(
      `Error: "${V}" is not a release version. Use MAJOR.MINOR.PATCH, with no prerelease or build suffix: the publish workflow publishes to npm's latest tag.`,
    );
    process.exit(1);
  }

  const checkErrors = checkRelease(root, {});
  if (checkErrors.length > 0) {
    console.error('Error: The release checks failed:');
    for (const e of checkErrors) console.error(`  ✗ ${e}`);
    console.error('Fix these, then re-run.');
    process.exit(1);
  }

  const set = readReleaseSet(root);
  const published = publishedSet(set);
  const [S] = [...new Set(set.map((m) => m.version))]; // checkRelease guarantees exactly one

  if (!isAbove(V, S)) {
    console.error(`Error: ${V} is not above the current version ${S}. Choose a higher version.`);
    process.exit(1);
  }

  if (tryGit(root, 'rev-parse', '-q', '--verify', `refs/tags/v${V}`) !== null) {
    console.error(
      `Error: Tag v${V} already exists in this repository. If it is left from an abandoned attempt, delete it (git tag -d v${V}); otherwise choose another version.`,
    );
    process.exit(1);
  }

  const remotesOut = tryGit(root, 'remote');
  const hasOrigin =
    remotesOut !== null &&
    remotesOut
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .includes('origin');
  if (!hasOrigin) {
    console.error(
      'Error: This repository has no origin remote, so the release cannot be pushed. Add it (git remote add origin <url>), then re-run.',
    );
    process.exit(1);
  }

  const lsRemote = tryGitCapture(root, 'ls-remote', '--tags', 'origin', `refs/tags/v${V}`);
  if (lsRemote.error !== null) {
    console.error(
      `Error: Cannot read tags from origin: ${firstLine(lsRemote.error)}. Check that git ls-remote origin works, then re-run.`,
    );
    process.exit(1);
  }
  if (lsRemote.output.trim().length > 0) {
    console.error(`Error: Tag v${V} already exists on origin. Choose another version.`);
    process.exit(1);
  }

  for (const m of published) {
    const registry = readPublishedVersions(root, m.name, registryFixturePath);
    if (registry.kind === 'error') {
      console.error(
        `Error: Cannot read ${m.name} from the npm registry: ${registry.firstLine}. Check that npm view ${m.name} versions works, then re-run.`,
      );
      process.exit(1);
    }
    const finals = registry.versions.filter(isFinal);
    if (finals.includes(V)) {
      console.error(`Error: ${m.name}@${V} is already published. Choose another version.`);
      process.exit(1);
    }
    let top = null;
    for (const v of finals) if (top === null || isAbove(v, top)) top = v;
    if (top !== null && !isAbove(V, top)) {
      console.error(
        `Error: ${V} is not above ${m.name}'s highest published version ${top}. Choose a higher version.`,
      );
      process.exit(1);
    }
  }

  // every entry check passed: write the journal, then run.
  const devV = devVersionAfter(V);
  const files = set
    .flatMap((m) => [`${m.dir}/package.json`, `${m.dir}/src/version.ts`])
    .concat(['package-lock.json']);
  const head = gitSync(root, 'rev-parse', 'HEAD');
  const journal = {
    version: V,
    devVersion: devV,
    phase: 'release',
    startSha: head,
    releaseSha: null,
    files,
  };
  writeJournal(journalPath, journal);
  await runPhase1(root, journalPath, journal, set, V);
}

// ── --resume: read the journal, act on the state it and git describe ─────────────────────────

async function doResume(root, journalPath) {
  if (!existsSync(journalPath)) {
    console.error('Error: There is no unfinished release to resume.');
    process.exit(1);
  }
  const journal = readJournal(journalPath);
  const state = readState(root, journal);
  const set = readReleaseSet(root);
  const V = journal.version;

  if (state.name === 'nothing-committed') {
    const r = restoreFiles(root, journal.startSha, journal.files);
    if (!r.ok) printRestoreFailedAndExit(r.reason);
    removeJournal(journalPath);
    console.log(`Restored. Re-run: npm run release -- --version ${V}`);
    process.exit(0);
  }
  if (state.name === 'committed-untagged') {
    try {
      await step(`Tagging v${V}`, () => run(root, 'git', ['tag', '--no-sign', `v${V}`]));
    } catch (e) {
      await onFailure(root, journalPath, e.message);
      return;
    }
    await enterAndRunPhase2(root, journalPath, journal, set, V);
    return;
  }
  if (state.name === 'tagged') {
    if (hasChangedSince(root, state.releaseCommit, journal.files)) {
      const r = restoreFiles(root, state.releaseCommit, journal.files);
      if (!r.ok) printRestoreFailedAndExit(r.reason);
    }
    await enterAndRunPhase2(root, journalPath, journal, set, V);
    return;
  }
  if (state.name === 'done') {
    removeJournal(journalPath);
    printSuccess(root, journal, state.releaseCommit);
    return;
  }
  printUnknown(root, journalPath, journal);
  process.exit(1);
}

// ── entry ──────────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf('--root');
  const root =
    rootIdx !== -1
      ? resolve(args[rootIdx + 1])
      : join(dirname(fileURLToPath(import.meta.url)), '..');
  const registryFixtureIdx = args.indexOf('--registry-fixture');
  const registryFixturePath = registryFixtureIdx !== -1 ? args[registryFixtureIdx + 1] : null;

  const hasVersionFlag = args.includes('--version');
  const hasResumeFlag = args.includes('--resume');
  const versionValue = hasVersionFlag ? args[args.indexOf('--version') + 1] : undefined;
  const versionValueOk = versionValue !== undefined && !versionValue.startsWith('--');

  const journalPath = journalPathFor(root);

  if (hasResumeFlag && !hasVersionFlag) {
    await doResume(root, journalPath);
    return;
  }
  if (hasVersionFlag && !hasResumeFlag && versionValueOk) {
    await runVersion(root, journalPath, versionValue, registryFixturePath);
    return;
  }
  console.error(
    'Error: Usage: npm run release -- --version <MAJOR.MINOR.PATCH>, or npm run release -- --resume',
  );
  process.exit(1);
}

main();
