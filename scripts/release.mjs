#!/usr/bin/env node
// scripts/release.mjs — issue #620 PR-A (D6), corrected twice (the PR-A corrections 1 and 2).
// Every realm release goes through this script: bump every package to the new version, build,
// commit and tag the release, then move the tree to a development version so no later build of
// `main` ever claims to be a release.
//
// Usage: npm run release -- --version <MAJOR.MINOR.PATCH>
//        npm run release -- --resume
//        npm run release -- --help
// Test-only: --root <dir>, --registry-fixture <file> (see readPublishedVersions below).
//
// Every entry check runs BEFORE any file is written: `checkRelease` (scripts/lib/check-release.mjs)
// is the same check `publish.yml` runs against the tagged tree, so this script never tags a
// release whose versions the publish workflow's checks would refuse. The release must run on its
// own branch, never on `main` and never on a detached HEAD, and `CHANGELOG.md` must already carry a
// `## [<version>]` section (Part B step 2) before the script will touch a file.
//
// The two phases (release, then development) each end in a commit, and each phase's start is
// recorded in a journal (`realm-release.json`, in the git directory — never in the working tree,
// so it is never dirty and never committed, and it lands in the RIGHT place for a linked
// worktree too). On failure or interrupt, the script reads git and the journal to work out
// exactly what happened, puts back the files it changed (never from in-memory state — that would
// not survive a crash — and never a file that also holds a change it did not make), and tells the
// releaser precisely what to run next — naming the step that failed, never echoing the raw command
// line, and noting that `packages/*/dist` may still hold the abandoned version's build. `--resume`
// reads the same state and finishes from wherever it is.
//
// What this script never does (correction 2): it never overwrites a change it did not make to a
// version file other than `package-lock.json` (content or mode), and never tags or finishes a
// commit that holds one; it never runs npm to set the lockfile's versions (it sets them itself, the
// way npm would); it acts only on what it has checked (HEAD and each version file, content and mode,
// before the bump writes and again before it stages; each commit it makes, by subject, parent,
// content and modes, before it tags or records it); and `--resume` runs only on the branch the
// release ran on.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
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

const USAGE =
  'Usage: npm run release -- --version <MAJOR.MINOR.PATCH>, or npm run release -- --resume';
const HELP = [
  USAGE,
  '  --version <V>  Release V: set every package to it, build, commit and tag the release, then commit the next development version. Nothing is pushed or published.',
  '  --resume       Finish a release that stopped after its release commit. For one that stopped before it, restore its files and exit 1, since nothing was released: run --version again.',
].join('\n');

// Said once a restore has put back a lockfile that held a change the release did not make.
const LOCKFILE_NOTICE =
  'package-lock.json held changes the release did not make; it is restored, so they are gone. If they came from npm install, run it again after the release.';

// ── small git/text helpers ─────────────────────────────────────────────────────────────────────

const MAX_BUFFER = 512 * 1024 * 1024;

function gitRaw(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_BUFFER,
  });
}
function gitSync(root, ...args) {
  return gitRaw(root, ...args).trim();
}
function tryGit(root, ...args) {
  try {
    return gitSync(root, ...args);
  } catch {
    return null;
  }
}
function tryGitRaw(root, ...args) {
  try {
    return gitRaw(root, ...args);
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
function gitSucceeds(root, ...args) {
  try {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
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

/**
 * Every subject this script reads or prints comes from here, and this is the only place that
 * asks git for a commit message. With `log.showSignature` set, git prints a signed commit's
 * signature verdict BEFORE its subject; `--no-show-signature` keeps the subject alone (RL61).
 */
function subjectOf(root, sha) {
  return tryGit(root, 'log', '-1', '--no-show-signature', '--format=%s', sha);
}
function headSha(root) {
  return gitSync(root, 'rev-parse', 'HEAD');
}
function currentBranch(root) {
  return tryGit(root, 'symbolic-ref', '--quiet', '--short', 'HEAD');
}
function parentOf(root, sha) {
  return tryGit(root, 'rev-parse', `${sha}^`);
}
function isCommit(root, sha) {
  return tryGit(root, 'cat-file', '-t', sha) === 'commit';
}
function isAncestor(root, ancestor, descendant) {
  return gitSucceeds(root, 'merge-base', '--is-ancestor', ancestor, descendant);
}
function countCommits(root, range) {
  return Number(gitSync(root, 'rev-list', '--count', range));
}

/**
 * `git status --porcelain`, UNTRIMMED, with untracked files shown whatever the releaser's
 * `status.showUntrackedFiles` says (with `no`, an untracked source file would pass the clean-tree
 * check, and the release's build would compile a file the release commit does not hold — RL62).
 * The status column of the first entry starts with a space for an unstaged modification, and
 * `String.trim()` on the whole output would eat it.
 */
function porcelainLines(root) {
  return gitRaw(root, 'status', '--porcelain', '--untracked-files=normal')
    .split('\n')
    .filter((l) => l.length > 0);
}
function pathOfPorcelain(line) {
  return line.slice(3);
}
/** The word that tells what happened to a path, from the two status characters. */
function statusWord(xy) {
  if (xy === '??') return 'untracked';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('R')) return 'renamed';
  if (xy.includes('C')) return 'copied';
  if (xy.includes('A')) return 'added';
  return 'modified';
}
/**
 * The paths of the lines `git status --porcelain` lists, each after its word, the first ten and
 * ` and <n> more` for the rest. `exclude`: paths left out (the files a text names itself).
 * Returns null when nothing is left to list.
 */
function uncleanWords(lines, exclude = []) {
  const kept = lines.filter((l) => !exclude.includes(pathOfPorcelain(l)));
  if (kept.length === 0) return null;
  const shown = kept
    .slice(0, 10)
    .map((l) => `${statusWord(l.slice(0, 2))} ${pathOfPorcelain(l)}`)
    .join(', ');
  return kept.length > 10 ? `${shown} and ${kept.length - 10} more` : shown;
}

/** A path as one shell word: bare when it holds only safe characters, otherwise in single quotes
 * (a quote inside written `'\''`). Composed once, for every command a text prints. */
function shellWord(s) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}

// ── the journal: outside the working tree, in the git directory (correct in a linked worktree,
// where --git-dir is a path unique to that worktree — never `.git` itself) ───────────────────────

function journalPathFor(root) {
  const gitDirOut = gitSync(root, 'rev-parse', '--git-dir');
  const gitDir = isAbsolute(gitDirOut) ? gitDirOut : join(root, gitDirOut);
  return join(gitDir, 'realm-release.json');
}

/**
 * Write the journal durably: write a temporary file, fsync it, rename it over the journal, then
 * fsync the journal's directory. A power loss then leaves the old journal or the new one, never an
 * empty file. No test can observe a power loss, so this is argued, not pinned.
 */
function writeJournal(journalPath, journal) {
  const tmp = `${journalPath}.tmp.${process.pid}`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, JSON.stringify(journal, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, journalPath);
  try {
    const dirFd = openSync(dirname(journalPath), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (e) {
    // a platform that cannot open a directory for reading cannot fsync it either; every other
    // failure is a real one
    if (!['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'].includes(e.code)) throw e;
  }
}
function removeJournal(journalPath) {
  unlinkSync(journalPath);
}

const HEX_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The one function every read of the journal goes through. Returns `{ journal }`, or
 * `{ refusal: { opening, reason, aboutCommits } }`: `cannot be read` for a reason about the
 * journal's text or fields, `no longer matches this repository` for one about its commits (the
 * journal reads fine). A journal this script wrote always passes the commit rules (git objects
 * never change); one whose commits git has since removed, or that someone edited, would otherwise
 * send the releaser back to a commit that does not exist or is not the release's.
 */
function readJournalChecked(root, journalPath) {
  const cannot = (reason) => ({
    refusal: { opening: `cannot be read: ${reason}`, reason, aboutCommits: false },
  });
  const text = readFileSync(journalPath, 'utf-8');
  if (text.trim() === '') return cannot('it is empty');
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return cannot('it is not valid JSON');
  }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) {
    return cannot('it is not a JSON object');
  }
  const bad = (field) => cannot(`its ${field} field is missing or not valid`);
  if (typeof j.version !== 'string' || !isFinal(j.version)) return bad('version');
  if (typeof j.devVersion !== 'string' || j.devVersion === '') return bad('devVersion');
  if (j.phase !== 'release' && j.phase !== 'development') return bad('phase');
  if (typeof j.startSha !== 'string' || !HEX_SHA.test(j.startSha)) return bad('startSha');
  if (j.phase === 'release') {
    if (j.releaseSha !== null) return bad('releaseSha');
  } else if (typeof j.releaseSha !== 'string' || !HEX_SHA.test(j.releaseSha)) {
    return bad('releaseSha');
  }
  if (
    !Array.isArray(j.files) ||
    j.files.length === 0 ||
    !j.files.every((f) => typeof f === 'string' && f !== '')
  ) {
    return bad('files');
  }
  if (typeof j.branch !== 'string' || j.branch === '' || j.branch === 'main') return bad('branch');

  const aboutCommits = (reason) => ({
    refusal: {
      opening: `no longer matches this repository: ${reason}`,
      reason,
      aboutCommits: true,
    },
  });
  if (!isCommit(root, j.startSha)) {
    return aboutCommits(
      'the commit it records as the start of the release is not in this repository',
    );
  }
  if (j.phase === 'development') {
    const test = testStepCommit(root, j, 'release');
    if (!test.ok) {
      return isCommit(root, j.releaseSha)
        ? aboutCommits(
            `the commit it records as the release commit of v${j.version} (${shortSha(root, j.releaseSha)}) is not that commit`,
          )
        : aboutCommits(`the release commit of v${j.version} it records is not in this repository`);
    }
  }
  return { journal: j };
}

/** Print the refusal of an unreadable journal and exit 1. Nothing is written. */
function refuseJournal(root, journalPath, refusal, journalFields) {
  const head = headSha(root);
  const word = shellWord(journalPath);
  if (refusal.aboutCommits && journalFields !== null) {
    const nothingLeft =
      head === journalFields.startSha &&
      !tagExists(root, journalFields.version) &&
      !differsFrom(root, journalFields.startSha, journalFields.files);
    if (nothingLeft) {
      console.error(
        `Error: The release journal ${journalPath} no longer matches this repository: ${refusal.reason}. HEAD is ${shortSha(root, head)}, where that release started, tag v${journalFields.version} does not exist, and the files it sets are unchanged, so nothing of it is left here: delete the journal (rm ${word}), then re-run: npm run release -- --version ${journalFields.version}`,
      );
      process.exit(1);
    }
  }
  console.error(
    `Error: The release journal ${journalPath} ${refusal.opening}. HEAD is ${shortSha(root, head)} "${subjectOf(root, head)}": finish the release by hand (Part B step 3, "To finish an unfinished release by hand") or abandon it (Part B step 3, "To abandon an unfinished release"); either one deletes the journal (rm ${word}).`,
  );
  process.exit(1);
}

/**
 * Read the journal and return it, or print the refusal and exit. `journalFields` for the
 * nothing-left test is the parsed journal when it parses to an object with its own `version`,
 * `startSha` and `files` in the right form (a commit reason implies they are).
 */
function readJournalOrExit(root, journalPath) {
  const r = readJournalChecked(root, journalPath);
  if (r.journal) return r.journal;
  let fields = null;
  if (r.refusal.aboutCommits) {
    fields = JSON.parse(readFileSync(journalPath, 'utf-8'));
  }
  refuseJournal(root, journalPath, r.refusal, fields);
  return null;
}

// ── what the release writes into a version file ────────────────────────────────────────────────
//
// The bump has exactly three transformations, each its own function, and the bump and every check
// below use these same three, so they can never disagree about what the release's own content is:
// a `package.json`'s `version`; a `src/version.ts`'s VERSION line; and, in `package-lock.json`, the
// `version` of the entry `packages["packages/<dir>"]` of every package the release sets. The
// release sets the lockfile's versions itself and never runs npm to do it: nothing it did not
// write can then reach the lockfile of a commit it tags or finishes. On a lockfile npm wrote from
// the committed manifests, the output is npm's own, byte for byte (RL47 checks the fixture's).

const LOCKFILE = 'package-lock.json';

function setPackageJsonVersion(text, version) {
  const pkg = JSON.parse(text);
  pkg.version = version;
  return JSON.stringify(pkg, null, 2) + '\n';
}
function setVersionTsVersion(text, version) {
  if (!VERSION_LINE.test(text)) throw new Error('has no VERSION line');
  return text.replace(VERSION_LINE, `export const VERSION = '${version}';`);
}
function setLockfileVersions(text, dirs, version) {
  const lock = JSON.parse(text);
  for (const dir of dirs) lock.packages[dir].version = version;
  return JSON.stringify(lock, null, 2) + '\n';
}
/** `dirs`: the `packages/<dir>` of every package the release sets (journal-style, from `files`). */
function dirsOfFiles(files) {
  return files.filter((f) => /^packages\/[^/]+\/package\.json$/.test(f)).map((f) => dirname(f));
}
/** The text of `file` with its versions set to `version`; throws if the text cannot take it. */
function bumpedText(file, text, version, dirs) {
  if (file === LOCKFILE) return setLockfileVersions(text, dirs, version);
  if (file.endsWith('/package.json')) return setPackageJsonVersion(text, version);
  return setVersionTsVersion(text, version);
}
/** `bumpedText`, or null when the text cannot be transformed (a state no release was made from). */
function bumpOutput(file, text, version, dirs) {
  try {
    return bumpedText(file, text, version, dirs);
  } catch {
    return null;
  }
}
/**
 * The release's own contents of a journal file, from the base's text (read untrimmed: a trimmed
 * base never equals a file): the base itself, the base with its versions set to the release
 * version, and the base with its versions set to the development version.
 */
function releaseContents(file, baseText, journal) {
  if (baseText === null) return [];
  const dirs = dirsOfFiles(journal.files);
  const contents = [baseText];
  for (const v of [journal.version, journal.devVersion]) {
    const out = bumpOutput(file, baseText, v, dirs);
    if (out !== null) contents.push(out);
  }
  return contents;
}

// ── files, as git and the working tree hold them ───────────────────────────────────────────────

/** `Map file -> { text, mode }` of `files` at `commit` (text untrimmed; null when absent there). */
function readBase(root, commit, files) {
  const modes = new Map();
  const tree = tryGitRaw(root, 'ls-tree', commit, '--', ...files) ?? '';
  for (const line of tree.split('\n')) {
    const m = /^(\d+) \w+ [0-9a-f]+\t(.+)$/.exec(line);
    if (m) modes.set(m[2], m[1]);
  }
  const base = new Map();
  for (const f of files) {
    base.set(f, {
      text: tryGitRaw(root, 'show', `${commit}:${f}`),
      mode: modes.get(f) ?? null,
    });
  }
  return base;
}

/**
 * `Map file -> { work, index, indexMode, workMode }`: the working tree's text (null when the file
 * is missing), the index's text (null when it holds none), the index's mode, and the working
 * tree's mode when git reports it changed from the index (`mode change` in `git diff --summary`,
 * which follows `core.fileMode`; null when it did not).
 */
function readWorkState(root, files) {
  const indexModes = new Map();
  const staged = tryGitRaw(root, 'ls-files', '--stage', '--', ...files) ?? '';
  for (const line of staged.split('\n')) {
    const m = /^(\d+) [0-9a-f]+ \d\t(.+)$/.exec(line);
    if (m) indexModes.set(m[2], m[1]);
  }
  const workModes = new Map();
  const summary = tryGitRaw(root, 'diff', '--summary', '--', ...files) ?? '';
  for (const line of summary.split('\n')) {
    const m = /^ mode change \d+ => (\d+) (.+)$/.exec(line);
    if (m) workModes.set(m[2], m[1]);
  }
  const states = new Map();
  for (const f of files) {
    let work;
    try {
      work = readFileSync(join(root, f), 'utf-8');
    } catch {
      work = null;
    }
    states.set(f, {
      work,
      index: tryGitRaw(root, 'show', `:${f}`),
      indexMode: indexModes.get(f) ?? null,
      workMode: workModes.get(f) ?? null,
    });
  }
  return states;
}
function isLinkState(st) {
  return st.indexMode === '120000' || st.workMode === '120000';
}
function modeChanged(st, baseMode) {
  return st.indexMode !== baseMode || st.workMode !== null;
}
/** The working tree's mode of a file, as git reads it. */
function workModeOf(st) {
  return st.workMode ?? st.indexMode;
}

/**
 * Per journal file, against `base`: `{ changed, link, onlyInIndex, allowed, st, b }`. `changed`:
 * the file holds a change the release did not make (its working-tree or index content is none of
 * the release's contents, or its mode, in the index or the working tree, is not the base's, or it
 * is missing). `link`: it is a symbolic link now. `onlyInIndex`: its working-tree text is one of
 * the release's contents with the base's mode, so the change is only in the index.
 */
function inspectFiles(root, base, journal, files = journal.files) {
  const baseInfo = readBase(root, base, files);
  const work = readWorkState(root, files);
  const out = new Map();
  for (const f of files) {
    const b = baseInfo.get(f);
    const st = work.get(f);
    const allowed = releaseContents(f, b.text, journal);
    const changed =
      st.work === null ||
      st.index === null ||
      !allowed.includes(st.work) ||
      !allowed.includes(st.index) ||
      modeChanged(st, b.mode);
    out.set(f, {
      changed,
      link: isLinkState(st),
      onlyInIndex: st.work !== null && allowed.includes(st.work) && workModeOf(st) === b.mode,
      allowed,
      st,
      b,
    });
  }
  return out;
}

/** One comparison for every place that decides whether to restore: a file differs when the
 * working tree or the index differs from `sha`. */
function differsFrom(root, sha, files) {
  return (
    !gitSucceeds(root, 'diff', '--quiet', sha, '--', ...files) ||
    !gitSucceeds(root, 'diff', '--quiet', '--cached', sha, '--', ...files)
  );
}

function tagExists(root, version) {
  return tryGit(root, 'rev-parse', '-q', '--verify', `refs/tags/v${version}`) !== null;
}
function tagCommit(root, version) {
  return tryGit(root, 'rev-parse', '-q', '--verify', `refs/tags/v${version}^{commit}`);
}

// ── the one test of a commit the release made ──────────────────────────────────────────────────
//
// Git hooks run inside each commit step, after the files were checked: a pre-commit hook can
// change a file and stage it into the commit, a prepare-commit-msg or commit-msg hook can change
// the message, a post-commit hook can make a commit of its own. So the release tests each commit
// it made, and `readState` and every text that names "the release commit" or "the development
// commit" use the same test, so they can never disagree. A sha passes when (1) its subject is the
// step's and its parent is the anchor, and (2) every journal file holds exactly the bump's output
// (the anchor's content with its versions set to the step's version) with the mode it has in the
// anchor, and the commit changes no other file. The test recognises a commit by those, not by what
// made it.

function stepSubject(kind, version) {
  return kind === 'release'
    ? `chore: release v${version}`
    : `chore: begin development after v${version}`;
}
/**
 * `{ ok: true }` or `{ ok: false, part, files }`: part 'missing' (no such commit), 1 (subject or
 * parent), 2 (a journal file, or another file, holds something the bump does not write — `files`
 * are the journal files that differ in content or mode, in the journal's order, then every other
 * file). `spec`: `{ version, devVersion, files }`.
 */
function testCommit(root, sha, kind, anchor, spec) {
  if (sha === null || sha === undefined || !isCommit(root, sha)) {
    return { ok: false, part: 'missing', files: [] };
  }
  if (subjectOf(root, sha) !== stepSubject(kind, spec.version) || parentOf(root, sha) !== anchor) {
    return { ok: false, part: 1, files: [] };
  }
  const want = kind === 'release' ? spec.version : spec.devVersion;
  const dirs = dirsOfFiles(spec.files);
  const anchorBase = readBase(root, anchor, spec.files);
  const shaBase = readBase(root, sha, spec.files);
  const differing = [];
  for (const f of spec.files) {
    const a = anchorBase.get(f);
    const c = shaBase.get(f);
    const expected = a.text === null ? null : bumpOutput(f, a.text, want, dirs);
    if (expected === null || c.text !== expected || c.mode !== a.mode) differing.push(f);
  }
  const named = (tryGitRaw(root, 'diff', '--name-only', `${sha}^`, sha) ?? '')
    .split('\n')
    .filter((l) => l !== '');
  const others = named.filter((n) => !spec.files.includes(n));
  if (differing.length > 0 || others.length > 0) {
    return { ok: false, part: 2, files: [...differing, ...others] };
  }
  return { ok: true };
}
/** `testCommit` for a journal's own step: `sha` defaults to the journal's release commit. */
function testStepCommit(root, journal, kind, sha) {
  const target = sha ?? journal.releaseSha;
  const anchor = kind === 'release' ? journal.startSha : journal.releaseSha;
  return testCommit(root, target, kind, anchor, journal);
}
/** The commit a journal's current step expects: the release commit in phase `release`, the
 * development commit in phase `development`. */
function stepKindOf(journal) {
  return journal.phase === 'release' ? 'release' : 'development';
}
function stepAnchorOf(journal) {
  return journal.phase === 'release' ? journal.startSha : journal.releaseSha;
}
/**
 * The step's commit, intact below HEAD: the first commit after the step's anchor on HEAD's
 * first-parent line, when it passes the test as that step's commit; otherwise null. A hook, or the
 * releaser, that made another commit after one of the release's commits leaves that commit as the
 * release made it, so the release goes on from it rather than starting again.
 */
function stepCommitBelowHead(root, journal) {
  const anchor = stepAnchorOf(journal);
  const first = (
    tryGit(root, 'rev-list', '--first-parent', '--reverse', `${anchor}..HEAD`) ?? ''
  ).split('\n')[0];
  if (first === '') return null;
  return testStepCommit(root, journal, stepKindOf(journal), first).ok ? first : null;
}

// ── the state the journal and the git history are actually in ──────────────────────────────────

// `nothing-committed` and `moved` have their own, longer text at every call site (they tell the
// releaser to restore, then re-run with --version — the others just point at --resume), so they
// have no entry here.
const STATE_WORDS = {
  'committed-untagged': 'the release commit exists, but it is not tagged',
  tagged: 'the release is tagged; the development version is not committed',
  'developed-untagged': 'the development version is committed, but the release is not tagged',
  done: 'every commit exists; only the journal is left',
};

/**
 * The state the journal and the git history are actually in. Both the failure path and
 * `--resume` use this — one function, so they can never disagree about what happened.
 *
 * `moved`: HEAD moved on from the start by commits that change none of the files the release sets.
 * The release committed nothing, and HEAD holds the start's content of every journal file, so the
 * release's own changes can be put back and the release run again from HEAD.
 */
function readState(root, journal) {
  const V = journal.version;
  const head = headSha(root);
  const tagSha = tagCommit(root, V);

  if (journal.phase === 'release') {
    if (head === journal.startSha) return { name: 'nothing-committed', head };
    const isReleaseCommit = testStepCommit(root, journal, 'release', head).ok;
    if (isReleaseCommit && tagSha === null) {
      return { name: 'committed-untagged', releaseCommit: head, head };
    }
    if (isReleaseCommit && tagSha === head) return { name: 'tagged', releaseCommit: head, head };
    if (
      !isReleaseCommit &&
      isAncestor(root, journal.startSha, head) &&
      gitSucceeds(root, 'diff', '--quiet', journal.startSha, head, '--', ...journal.files)
    ) {
      return { name: 'moved', head };
    }
    return { name: 'unknown', head };
  }

  // phase === 'development': the release commit is the journal's own record of it, not derived.
  const releaseCommit = journal.releaseSha;
  if (head === releaseCommit && tagSha === null) {
    return { name: 'committed-untagged', releaseCommit, head };
  }
  if (head === releaseCommit && tagSha === releaseCommit) {
    return { name: 'tagged', releaseCommit, head };
  }
  if (testStepCommit(root, journal, 'development', head).ok) {
    if (tagSha === releaseCommit) return { name: 'done', releaseCommit, head };
    if (tagSha === null) return { name: 'developed-untagged', releaseCommit, head };
  }
  return { name: 'unknown', head };
}

// ── composers every text below shares ──────────────────────────────────────────────────────────

/** The reset every text prints is a plain (mixed) one: the index goes back with the branch and the
 * files keep what they hold. A soft reset would leave the release's own changes staged, and
 * `git stash push -- <files>` records the whole index — the keep route would then bring the
 * release's old changes back on top of the new ones (RL49 follows the keep route after it). */
function resetHint(root, sha) {
  return `(git reset ${shortSha(root, sha)} keeps the current files, with the differences unstaged)`;
}
/** `put back the file the link replaced (git restore …)`, for every place that offers only
 * putting a file back: `git stash` records a link as a type change, and popping it conflicts. */
function putBackText(files) {
  return `put back the file ${files.length === 1 ? 'the link' : 'each link'} replaced (git restore --staged --worktree -- ${files.join(' ')})`;
}
function keptBranchName(branch, headShortSha) {
  return `${branch}-kept-${headShortSha}`;
}
/** What to run once the branch is where a text says: from a commit of the release, `--resume`
 * finishes; from the start, `--resume` can only put back the files the release changed, and the
 * release then runs again. */
function thenText(journal, fromStart) {
  return fromStart
    ? `then run npm run release -- --resume to put back the files the release changed, and re-run: npm run release -- --version ${journal.version}`
    : 'then re-run: npm run release -- --resume';
}
/** The tag and the journal an abandon deletes, in Part B step 3's order. */
function abandonDeletes(root, version, journalPath) {
  const parts = [];
  const hasTag = tagExists(root, version);
  if (hasTag) parts.push(`delete its tag (git tag -d v${version})`);
  if (existsSync(journalPath)) {
    parts.push(`${hasTag ? 'its' : 'delete its'} journal (rm ${shellWord(journalPath)})`);
  }
  return parts.length === 0 ? null : parts.join(', then ');
}
/**
 * `<where>` of every text that offers to abandon a release: where to put the branch back, what
 * that takes off it, and what to delete. `n`: the number of commits HEAD holds after `itsSha`
 * (the commit the abandoned release's last commit sits on), `keptBranch`: what the commits are
 * kept on.
 */
function abandonWhere(root, { startSha, itsSha, n, keptBranch, version, journalPath }) {
  const startShort = shortSha(root, startSha);
  let text = `: put the branch back at ${startShort} "${subjectOf(root, startSha)}", where it started (git reset --keep ${startShort} brings its files too, and refuses rather than overwrite a change of yours)`;
  if (n >= 1) {
    const headShort = shortSha(root, headSha(root));
    const the = n === 1 ? 'the 1 commit' : `the ${n} commits`;
    const them = n === 1 ? 'it' : 'them';
    text += `, which takes ${the} after ${shortSha(root, itsSha)} off it too (to keep ${them}, run git branch ${keptBranch} ${headShort} first: when the release has run again, its text says how to bring ${them} back)`;
  }
  const deletes = abandonDeletes(root, version, journalPath);
  if (deletes !== null) text += `, then ${deletes}`;
  return text;
}
/** The version in HEAD's `package.json` files (the first journal one that names a version). */
function versionAt(root, commit, journal) {
  const base = readBase(root, commit, journal.files);
  for (const f of journal.files) {
    if (!f.endsWith('/package.json')) continue;
    try {
      const v = JSON.parse(base.get(f).text).version;
      if (typeof v === 'string') return v;
    } catch {
      // no readable version in this file: try the next
    }
  }
  return '(unknown)';
}

// ── --resume refuses a change the release did not make ─────────────────────────────────────────

/** The non-lockfile journal files that hold a change the release did not make, from `base`. */
function heldChanges(root, base, journal) {
  const inspected = inspectFiles(root, base, journal);
  const listed = journal.files.filter((f) => f !== LOCKFILE && inspected.get(f).changed);
  return { inspected, listed };
}

function refuseResume(root, journal, state, base, held) {
  const V = journal.version;
  const links = held.listed.filter((f) => held.inspected.get(f).link);
  if (links.length > 0) {
    console.error(
      [
        'Error: Resuming would overwrite a symbolic link that replaced a file the release sets, in:',
        ...links.map((f) => `  ${f}`),
        `A file the release sets cannot be kept as a link: ${putBackText(links)}, then re-run: npm run release -- --resume`,
      ].join('\n'),
    );
    process.exit(1);
  }
  const files = held.listed;
  const each = files.length === 1 ? 'that file' : 'each file';
  const spaced = files.join(' ');
  const pop = `git stash pop; if that conflicts, keep version ${journal.devVersion} and your other changes in ${each}, then run git restore --staged -- ${spaced} and git stash drop`;
  const staged = files.filter((f) => held.inspected.get(f).onlyInIndex);
  const into =
    staged.length > 0
      ? `put the changes that are only staged into their files (git restore -- ${staged.join(' ')}), `
      : '';
  const before = state.name === 'nothing-committed' || state.name === 'moved';
  const keep = before
    ? `${into}set the version in ${each} to ${versionAt(root, base, journal)}, set them aside (git stash push -- ${spaced}), re-run npm run release -- --resume, then npm run release -- --version ${V}, and bring them back once that finishes (${pop}).`
    : `${into}set them aside (git stash push -- ${spaced}), re-run npm run release -- --resume, then bring them back after it finishes (${pop}).`;
  const effect =
    state.name === 'committed-untagged'
      ? 'commit changes the release did not make into the development commit'
      : 'overwrite changes the release did not make';
  console.error(
    [
      `Error: Resuming would ${effect}, in:`,
      ...files.map((f) => `  ${f}`),
      `To keep them: ${keep}`,
      `To drop them: git restore --staged --worktree -- ${spaced}, then re-run: npm run release -- --resume`,
    ].join('\n'),
  );
  process.exit(1);
}

// ── restoring files: one place, so every restore says what it threw away ───────────────────────

function restoreFiles(root, sha, files) {
  const r = spawnSync(
    'git',
    ['restore', `--source=${sha}`, '--staged', '--worktree', '--', ...files],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  return { ok: r.status === 0 };
}
function printRestoreFailedAndExit() {
  console.error(
    "Error: Restoring the files failed (git's message is above). Fix the cause, then run: npm run release -- --resume",
  );
  process.exit(1);
}
/**
 * Put `files` back from `base`, and, when the lockfile held a change the release did not make
 * (its content or its mode, from the working tree and the index, by the same definition of a
 * change as every other place), say so once the restore has succeeded: npm owns the rest of that
 * file, so a restore puts it back rather than keeping a change to it.
 */
function restoreWithNotice(root, base, journal, files, inspected = null) {
  let notice = false;
  if (files.includes(LOCKFILE)) {
    const insp = inspected ?? inspectFiles(root, base, journal, [LOCKFILE]);
    notice = insp.get(LOCKFILE).changed;
  }
  const r = restoreFiles(root, base, files);
  if (!r.ok) printRestoreFailedAndExit();
  if (notice) console.error(LOCKFILE_NOTICE);
}

// ── what a restore leaves, and the clause that says so ─────────────────────────────────────────

/**
 * Point 2: put back only the files that hold no change the release did not make; the others stay
 * exactly as they are, working tree and index. `package-lock.json` is always restored. Returns
 * the files left (journal order), each `{ file, link }`. `onlyIfDiffers`: restore only when the
 * working tree or the index differs from `base` (the `tagged` state; before the release commit the
 * restore always runs).
 */
function restoreOnlyReleaseChanges(root, base, journal, onlyIfDiffers) {
  const inspected = inspectFiles(root, base, journal);
  const left = journal.files
    .filter((f) => f !== LOCKFILE && inspected.get(f).changed)
    .map((f) => ({ file: f, link: inspected.get(f).link }));
  const leftNames = left.map((l) => l.file);
  const toRestore = journal.files.filter((f) => !leftNames.includes(f));
  if (toRestore.length > 0 && (!onlyIfDiffers || differsFrom(root, base, toRestore))) {
    restoreWithNotice(root, base, journal, toRestore, inspected);
  }
  return left;
}
/**
 * The clause every failure before the release commit gives about what it restored. Composed once;
 * the interrupted and stopped forms and the `moved` forms all use it. It ends in `;`.
 */
function restoredClause(root, base, journal, left) {
  let clause;
  if (left.length === 0) {
    clause = 'Every tracked file it changed is restored';
  } else {
    const one = left.length === 1;
    const links = left.filter((l) => l.link).map((l) => l.file);
    const others = left.filter((l) => !l.link).map((l) => l.file);
    const steps = [];
    if (links.length > 0) steps.push(putBackText(links));
    if (others.length > 0) {
      const which =
        links.length === 0
          ? one
            ? 'it'
            : 'each'
          : others.length === 1
            ? 'the other'
            : 'each of the others';
      steps.push(
        `set the version in ${which} to ${versionAt(root, base, journal)}, and commit or set aside the rest`,
      );
    }
    clause = `Every tracked file it changed is restored, except ${left.map((l) => l.file).join(', ')}, which also ${one ? 'holds a change' : 'hold changes'} the release did not make and ${one ? 'is' : 'are'} left as ${one ? 'it is' : 'they are'}: ${steps.join(', ')}`;
  }
  clause += ';';
  const words = uncleanWords(
    porcelainLines(root),
    left.map((l) => l.file),
  );
  if (words !== null) {
    clause += ` this checkout also holds changes that are not committed, in ${words}, and the re-run needs a clean checkout: commit, stash or remove them;`;
  }
  return clause;
}

// ── a branch that has moved: say where the release can continue from ───────────────────────────

/**
 * The files the release sets that still hold the release's own changes, uncommitted, after a
 * reset that kept the files: the working tree holds the start's content with the release or the
 * development version set, HEAD holds something else, and the index holds HEAD's content or one of
 * those.
 */
function releaseChangesLeft(root, journal) {
  const files = journal.files;
  const dirs = dirsOfFiles(files);
  const startBase = readBase(root, journal.startSha, files);
  const headBase = readBase(root, 'HEAD', files);
  const work = readWorkState(root, files);
  const left = [];
  for (const f of files) {
    const s = startBase.get(f).text;
    if (s === null) continue;
    const ones = [journal.version, journal.devVersion]
      .map((v) => bumpOutput(f, s, v, dirs))
      .filter((o) => o !== null);
    const st = work.get(f);
    const h = headBase.get(f).text;
    if (
      st.work !== null &&
      ones.includes(st.work) &&
      h !== st.work &&
      st.index !== null &&
      (st.index === h || ones.includes(st.index))
    ) {
      left.push(f);
    }
  }
  return left;
}
/** ` <left>` of the text for a branch put back by hand, going on from a commit of the release. */
function leftClause(root, journal) {
  if (journal.phase !== 'development') return '';
  const own = releaseChangesLeft(root, journal);
  let text = '';
  if (own.length > 0) {
    text += ` The files the release sets hold its own changes, uncommitted, in ${own.join(', ')} (a reset that kept the files left them there): whichever way you take below, put them back first (git restore --staged --worktree -- ${own.join(' ')}).`;
  }
  const rest = journal.files.filter((f) => !own.includes(f) && differsFrom(root, 'HEAD', [f]));
  if (rest.includes(LOCKFILE)) {
    text += ` ${LOCKFILE} holds changes the release did not make, and npm owns the rest of it: whichever way you take below, put it back first too (git restore --staged --worktree -- ${LOCKFILE}); if they came from npm install, run it again after the release.`;
  }
  const yours = rest.filter((f) => f !== LOCKFILE);
  if (yours.length > 0) {
    const one = yours.length === 1;
    text += ` ${yours.join(', ')} ${one ? 'holds a change' : 'hold changes'} the release did not make: whichever way you take below, set the version in ${one ? 'that file' : 'each file'} to ${versionAt(root, 'HEAD', journal)} and set ${one ? 'it' : 'them'} aside first (git stash push -- ${yours.join(' ')}); when the release has run, its text names that stash and how to bring it back.`;
  }
  return text;
}

/**
 * The text for a checkout that matches none of the journal's steps: where the release can go on
 * from, the command that puts the branch there, and what that command takes off the branch. Each
 * text names a command that brings `--resume` back to a known state. (A HEAD that moved on from
 * the start by commits that change no journal file is the `moved` state, which never reaches
 * this.)
 */
function cannotContinueText(root, journalPath, journal) {
  const V = journal.version;
  const B = journal.branch;
  const head = headSha(root);
  const headShort = shortSha(root, head);
  const headSubject = subjectOf(root, head);
  const prefix = `Error: The unfinished v${V} release cannot continue from here`;

  // Tag v<V> names a commit other than the release commit.
  const tagAt = tagCommit(root, V);
  let releaseCommit;
  if (journal.phase === 'development') {
    releaseCommit = journal.releaseSha;
  } else if (testStepCommit(root, journal, 'release', head).ok) {
    releaseCommit = head;
  } else {
    releaseCommit = stepCommitBelowHead(root, journal);
  }
  if (tagAt !== null && releaseCommit !== null && tagAt !== releaseCommit) {
    return `${prefix}: tag v${V} points at ${shortSha(root, tagAt)}, not at its release commit ${shortSha(root, releaseCommit)}. Delete the tag (git tag -d v${V}), then re-run npm run release -- --resume: it tags ${shortSha(root, releaseCommit)}.`;
  }

  const below = stepCommitBelowHead(root, journal);
  let anchor;
  let words;
  let fromStart = false;
  if (below !== null && below !== head) {
    anchor = below;
    words = journal.phase === 'release' ? 'its release commit' : 'its development commit';
  } else if (journal.phase === 'development') {
    anchor = journal.releaseSha;
    words = 'its release commit';
  } else {
    anchor = journal.startSha;
    words = 'where it started';
    fromStart = true;
  }
  const anchorShort = shortSha(root, anchor);
  const then = thenText(journal, fromStart);
  const n = countCommits(root, `${anchor}..HEAD`);
  const kept = keptBranchName(B, headShort);
  const where = (itsSha, count) =>
    abandonWhere(root, {
      startSha: journal.startSha,
      itsSha,
      n: count,
      keptBranch: kept,
      version: V,
      journalPath,
    });

  if (isAncestor(root, anchor, head) && n >= 1) {
    const from = fromStart
      ? `It can start again from ${anchorShort}, ${words}`
      : `It can continue from ${anchorShort}, ${words}`;
    const notPart = fromStart ? '' : `, and are not part of v${V}`;
    const off =
      n === 1
        ? `The reset takes ${headShort} off ${B}; its changes stay in your files, uncommitted${notPart}.`
        : `The reset takes ${n} commits off ${B}, ${headShort} the newest; their changes stay in your files, uncommitted${notPart}.`;
    const abandonHere = fromStart
      ? ''
      : ` To abandon the release instead: Part B step 3, "To abandon an unfinished release"${where(anchor, n)}, then re-run: npm run release -- --version ${V}`;
    return `${prefix}: ${B} is at ${headShort} "${headSubject}". ${from}: put ${B} back there ${resetHint(root, anchor)}, ${then}. ${off}${abandonHere}`;
  }

  // The branch was put back by hand before the anchor, and maybe committed on since. No commit of
  // the release is below HEAD: a plain reset would leave the old files in place, and `--resume`
  // would refuse them as changes the release did not make.
  const left = leftClause(root, journal);
  const fromThere =
    journal.phase === 'development'
      ? 'It can continue from there'
      : 'It can start again from there';
  // the journal exists whenever this text is printed, so there is always something to delete
  const abandon = abandonDeletes(root, V, journalPath);
  const forward = `(git reset --keep ${anchorShort} brings its files too, and refuses rather than overwrite a change of yours)`;
  if (n === 0) {
    return `${prefix}: ${B} is at ${headShort} "${headSubject}", before ${anchorShort}, ${words}.${left} ${fromThere}: move ${B} forward to it ${forward}, ${then}. To abandon the release instead: ${abandon}, then re-run: npm run release -- --version ${V}`;
  }
  const taken =
    n === 1
      ? `${headShort} off it, with its changes`
      : `${n} commits off it, ${headShort} the newest, with their changes`;
  const them = n === 1 ? 'it' : 'them';
  const included = n === 1 ? 'that commit' : `those ${n} commits`;
  return `${prefix}: ${B} is at ${headShort} "${headSubject}", on a line that does not hold ${anchorShort}, ${words}. Moving ${B} there takes ${taken}.${left} ${fromThere}: keep ${them} on a branch (git branch ${kept} ${headShort}), move ${B} to ${anchorShort} ${forward}, ${then}; when the release has finished, its text says how to bring ${them} back. To abandon the release instead and release from ${headShort}, ${included} included: ${abandon}, then re-run: npm run release -- --version ${V}`;
}
function printCannotContinue(root, journalPath, journal) {
  console.error(cannotContinueText(root, journalPath, journal));
}

// ── running steps: async, interruptible, journal-aware on failure ──────────────────────────────
//
// An interrupt is reported as its own error TYPE (InterruptError, carrying the signal), distinct
// from an ordinary step failure (StepError, carrying a message that names the step — never the
// raw command line: "git commit -m chore: … exited 128" reads as if the commit message were
// "chore:" and hides that git's own message, printed just above, is the actual cause). onFailure
// below branches on which it received, since the two need different wording. A StepError can also
// carry what the failure path needs to know: `kind` (`before-bump`, `before-add` or `commit`) and
// the files, links, commit and part it concerns.

class StepError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
  }
}
class InterruptError extends Error {
  constructor(signal) {
    super(`interrupted by ${signal}`);
    this.signal = signal;
  }
}

let interrupted = null;
let interruptPrinted = false;
let currentChild = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (!interruptPrinted) {
      console.error(`Interrupt received (${sig}): stopping the current step, then cleaning up.`);
      interruptPrinted = true;
    }
    interrupted = sig;
    if (currentChild) currentChild.kill(sig);
  });
}

/**
 * `noun` names the step for its failure message ("the build", "the commit", …), never the raw
 * command line.
 */
function run(root, cmd, cmdArgs, noun) {
  return new Promise((resolveStep, rejectStep) => {
    currentChild = spawn(cmd, cmdArgs, { cwd: root, stdio: 'inherit' });
    currentChild.on('exit', (code, signal) => {
      currentChild = null;
      if (interrupted) {
        rejectStep(new InterruptError(interrupted));
        return;
      }
      if (code === 0) {
        resolveStep();
        return;
      }
      if (signal) {
        rejectStep(new StepError(`${noun} was stopped by ${signal}`));
        return;
      }
      rejectStep(new StepError(`${noun} failed (exit ${code}; its message is above)`));
    });
    currentChild.on('error', (err) => {
      currentChild = null;
      rejectStep(new StepError(`${noun} could not start (${err.message})`));
    });
  });
}
async function step(label, fn) {
  console.log(`→ ${label}`);
  if (interrupted) throw new InterruptError(interrupted);
  await fn();
  if (interrupted) throw new InterruptError(interrupted);
}

// ── the bump, and the two comparisons that guard it (point 3) ──────────────────────────────────

/** `<files> changed`, and `<file> was replaced by a symbolic link` for each link, joined by `, and `,
 * then `while the release ran`. */
function changedReason(changed, links) {
  const parts = [];
  if (changed.length > 0) parts.push(`${changed.join(', ')} changed`);
  for (const l of links) parts.push(`${l} was replaced by a symbolic link`);
  return `${parts.join(', and ')} while the release ran`;
}

/**
 * The first comparison, before the bump writes anything: every journal file must hold `anchor`'s
 * content and mode in the working tree and in the index, and HEAD must still be `anchor`. The mode
 * matters: a version file swapped for a symbolic link to a file with the same content still has
 * that content, and the bump would write through the link into a file the release does not set.
 * A file can change after the entry checks read it (in phase 1, while they read origin and the
 * registry) or by a hook of the release commit before phase 2, even into content the bump cannot
 * transform; this refuses it first, so the three transformations only ever read what the entry
 * checks read (phase 1) or what the release wrote (phase 2). Returns the texts it read: the bump
 * reads each file once, here, and transforms what it read.
 */
function checkBeforeBump(root, journal, anchor) {
  const files = journal.files;
  const base = readBase(root, anchor, files);
  const work = readWorkState(root, files);
  const changed = [];
  const links = [];
  const texts = new Map();
  for (const f of files) {
    const b = base.get(f);
    const st = work.get(f);
    texts.set(f, st.work);
    if (st.work === b.text && st.index === b.text && !modeChanged(st, b.mode)) continue;
    if (isLinkState(st)) links.push(f);
    else changed.push(f);
  }
  const headMoved = headSha(root) !== anchor;
  if (changed.length > 0 || links.length > 0 || headMoved) {
    throw new StepError(
      changed.length > 0 || links.length > 0
        ? changedReason(changed, links)
        : `${journal.branch} moved while the release ran`,
      { kind: 'before-bump', changed, links, headMoved },
    );
  }
  return texts;
}
/**
 * The second comparison, in the staging step, before `git add`: every journal file must hold
 * exactly the bump's output in the working tree and `anchor`'s content in the index, with
 * `anchor`'s mode in both, and then HEAD must still be `anchor`: a commit made while the build ran
 * would otherwise become the release commit's parent.
 */
function checkBeforeAdd(root, journal, anchor, version) {
  const files = journal.files;
  const dirs = dirsOfFiles(files);
  const base = readBase(root, anchor, files);
  const work = readWorkState(root, files);
  const changed = [];
  const links = [];
  for (const f of files) {
    const b = base.get(f);
    const st = work.get(f);
    const expected = b.text === null ? null : bumpOutput(f, b.text, version, dirs);
    if (
      expected !== null &&
      st.work === expected &&
      st.index === b.text &&
      !modeChanged(st, b.mode)
    ) {
      continue;
    }
    if (isLinkState(st)) links.push(f);
    else changed.push(f);
  }
  const headMoved = headSha(root) !== anchor;
  if (changed.length > 0 || links.length > 0 || headMoved) {
    throw new StepError(
      changed.length > 0 || links.length > 0
        ? changedReason(changed, links)
        : `${journal.branch} moved while the release ran`,
      { kind: 'before-add', changed, links, headMoved },
    );
  }
}
/** Write every journal file with its versions set to `version`, from the texts the first
 * comparison read; the lockfile last, after every `package.json` and `src/version.ts`. */
function bumpFiles(root, journal, texts, version) {
  const dirs = dirsOfFiles(journal.files);
  const order = [...journal.files.filter((f) => f !== LOCKFILE)];
  if (journal.files.includes(LOCKFILE)) order.push(LOCKFILE);
  const outputs = order.map((f) => [f, bumpedText(f, texts.get(f), version, dirs)]);
  for (const [f, out] of outputs) writeFileSync(join(root, f), out);
}

/** The sentence the step's failure and the text that names the way out both start with. */
function commitChangedSentence(root, kind, sha, files) {
  return `the ${kind} commit ${shortSha(root, sha)} holds changes the release did not make (${files.join(', ')})`;
}
/**
 * Point 4: right after a commit step, read HEAD once. That sha is the new commit, everything after
 * the step uses it (the tag names it, phase 2 records it as `releaseSha`), and the step fails
 * without tagging anything unless the commit passes the test.
 */
function assertStepCommit(root, journal, kind, sha) {
  const r = testStepCommit(root, journal, kind, sha);
  if (r.ok) return;
  if (r.part === 2) {
    throw new StepError(commitChangedSentence(root, kind, sha, r.files), {
      kind: 'commit',
      part: 2,
      stepKind: kind,
      sha,
      files: r.files,
    });
  }
  throw new StepError(
    "after the commit step, HEAD does not have the subject and parent the step's commit must have",
    { kind: 'commit', part: 1, stepKind: kind, sha },
  );
}
async function commitStep(root, journal, kind) {
  const V = journal.version;
  await run(
    root,
    'git',
    ['commit', '-m', stepSubject(kind, V), '--', ...journal.files],
    'the commit',
  );
  const sha = headSha(root);
  assertStepCommit(root, journal, kind, sha);
  return sha;
}
async function stageStep(root, journal, anchor, version) {
  checkBeforeAdd(root, journal, anchor, version);
  await run(root, 'git', ['add', '--', ...journal.files], 'staging the version files');
}
function tagStep(root, version, releaseSha) {
  return run(root, 'git', ['tag', '--no-sign', `v${version}`, releaseSha], 'tagging');
}

// ── the success text, and the lines that follow it ─────────────────────────────────────────────

/** The line about changes that are not committed (C2.9), or null. */
function uncommittedLine(root, version, branch) {
  const words = uncleanWords(porcelainLines(root));
  if (words === null) return null;
  return `This checkout also holds changes that are not committed, in ${words}: they are not part of v${version}. Commit them on ${branch} if the release PR should carry them.`;
}
/** The lines for every stash made on `branch` (C2.10), oldest first, or []. */
function stashLines(root, branch, devVersion, journalFiles) {
  const list = (tryGitRaw(root, 'stash', 'list', '--format=%gs') ?? '')
    .split('\n')
    .filter((l) => l !== '');
  const entries = [];
  list.forEach((subject, i) => {
    if (subject.startsWith(`WIP on ${branch}:`) || subject.startsWith(`On ${branch}:`)) {
      entries.push(i);
    }
  });
  entries.sort((a, b) => b - a); // `git stash list` is newest first: the oldest pops first
  const describe = (i) => {
    const ref = `stash@{${i}}`;
    const files = (
      tryGitRaw(root, 'stash', 'show', '--name-only', '--no-include-untracked', ref) ?? ''
    )
      .split('\n')
      .filter((l) => l !== '');
    const untracked = (
      tryGitRaw(root, 'stash', 'show', '--name-only', '--only-untracked', ref) ?? ''
    )
      .split('\n')
      .filter((l) => l !== '');
    const names = [...files, ...untracked.map((u) => `untracked ${u}`)];
    const holds =
      names.length > 0 ? `which holds ${names.join(', ')}` : 'which holds only untracked files';
    const mine = files.filter((f) => journalFiles.includes(f));
    const where = mine.length === 1 ? mine[0] : 'each conflicted file';
    const conflict =
      mine.length > 0
        ? `if that conflicts, keep version ${devVersion} and your other changes in ${where}, then run git restore --staged -- ${mine.join(' ')} and git stash drop`
        : null;
    return { ref, holds, conflict };
  };
  if (entries.length === 0) return [];
  if (entries.length === 1) {
    const i = entries[0];
    const d = describe(i);
    const ref = i === 0 ? '' : ` ${d.ref}`;
    const conflict = d.conflict === null ? '' : `; ${d.conflict}${ref}`;
    return [
      `A stash made on ${branch}, ${d.holds}, is waiting: if it holds changes you set aside for this release, bring them back now (git stash pop${ref}${conflict}).`,
    ];
  }
  const lines = [
    `${entries.length} stashes made on ${branch} are waiting: if they hold changes you set aside for this release, bring them back now, the oldest first:`,
  ];
  for (const i of entries) {
    const d = describe(i);
    lines.push(
      `  git stash pop ${d.ref}, ${d.holds}${d.conflict === null ? '' : ` (${d.conflict} ${d.ref})`}`,
    );
  }
  return lines;
}
/**
 * The newest commit of a release on branch `kept` that HEAD does not hold: a release commit that
 * passes the test on its parent, or a development commit on such a release commit. The first such
 * commit that HEAD holds ends the search, with none. A branch kept before an abandon also holds the
 * abandoned release's own commits under the releaser's.
 */
function abandonedBase(root, kept) {
  for (const c of releaseCandidates(root, kept)) {
    let own;
    if (c.kind === 'release') {
      own = releaseCommitOf(root, c.sha, c.x) !== null;
    } else {
      const rsha = parentOf(root, c.sha);
      const r = rsha === null ? null : releaseCommitOf(root, rsha, c.x);
      own = r !== null && testCommit(root, c.sha, 'development', rsha, r.spec).ok;
    }
    if (!own) continue;
    return isAncestor(root, c.sha, 'HEAD') ? null : c.sha;
  }
  return null;
}
/** The lines for every branch kept for this release (C2.14), or []. */
function keptBranchLines(root, branch) {
  const refs = (
    tryGit(root, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${branch}-kept-*`) ?? ''
  )
    .split('\n')
    .filter((l) => l !== '');
  const lines = [];
  for (const kept of refs) {
    const n = countCommits(root, `HEAD..${kept}`);
    if (n === 0) continue;
    const base = abandonedBase(root, kept);
    if (base !== null) {
      const m = countCommits(root, `${base}..${kept}`);
      if (m === 0) continue;
      lines.push(
        `A branch kept for this release is waiting: ${kept} holds ${m === 1 ? '1 commit' : `${m} commits`} after ${shortSha(root, base)} "${subjectOf(root, base)}", the last commit of the release abandoned before this one. Bring ${m === 1 ? 'it' : 'them'} back now (git rebase --rebase-merges --onto ${branch} ${shortSha(root, base)} ${kept}, then git switch ${branch} and git merge --ff-only ${kept}), then delete the branch (git branch -D ${kept}).`,
      );
      continue;
    }
    const merges = Number(gitSync(root, 'rev-list', '--merges', '--count', `HEAD..${kept}`));
    const back =
      merges > 0 ? `git merge --no-edit ${kept}` : `git cherry-pick --allow-empty HEAD..${kept}`;
    lines.push(
      `A branch kept for this release is waiting: ${kept} holds ${n === 1 ? '1 commit that is' : `${n} commits that are`} not on ${branch}. Bring ${n === 1 ? 'it' : 'them'} back now (${back}), then delete the branch (git branch -D ${kept}).`,
    );
  }
  return lines;
}
/** The lines every text that reports a prepared release prints after its first line. */
function followLines(root, version, devVersion, branch, files) {
  const lines = [];
  const unc = uncommittedLine(root, version, branch);
  if (unc !== null) lines.push(unc);
  lines.push(...keptBranchLines(root, branch));
  lines.push(...stashLines(root, branch, devVersion, files));
  return lines;
}

function printSuccess(root, journal, releaseCommit) {
  const short = shortSha(root, releaseCommit);
  const V = journal.version;
  const branch = journal.branch;
  console.log(
    `Prepared v${V} (not pushed or published yet): release commit ${short}, tag v${V}. Development continues at ${journal.devVersion}.`,
  );
  for (const line of followLines(root, V, journal.devVersion, branch, journal.files)) {
    console.log(line);
  }
  console.log('Next steps:');
  console.log(`  1. Push the branch:  git push -u origin ${branch}`);
  console.log(
    '  2. Open the release PR and merge it with a merge commit (not squash, not rebase), so the tagged commit is on main.',
  );
  console.log(`  3. Push the tag:     git switch main && git pull && git push origin v${V}`);
  console.log(
    '     Pushing the tag starts the Publish workflow. Push only this tag: --tags would push every local tag.',
  );
  console.log(
    `Before working on ${journal.devVersion}, run npm run build: packages/*/dist still holds the v${V} build.`,
  );
  process.exit(0);
}

// ── the failure path ───────────────────────────────────────────────────────────────────────────

const DIST_NOTE = (V) =>
  `packages/*/dist may still hold its v${V} build, so run npm run build before using this checkout.`;

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Point 4's text for a commit step whose commit failed the test. Printed only where the
 * failure path would otherwise print the cannot-continue text (the state is `unknown`). */
function printCommitStepFailure(root, journal, err) {
  const B = journal.branch;
  const kind = err.stepKind;
  const head = headSha(root);
  const headShort = shortSha(root, head);
  const headSubject = subjectOf(root, head);
  const anchor = stepAnchorOf(journal);
  const anchorShort = shortSha(root, anchor);
  const fromStart = kind === 'release';
  if (err.part === 2) {
    console.error(
      `Error: ${capitalize(commitChangedSentence(root, kind, err.sha, err.files))}: they changed while the commit ran, most likely in a git hook. Put ${B} back at ${anchorShort} ${resetHint(root, anchor)}, fix or remove whatever changed them, ${thenText(journal, fromStart)}`,
    );
    return;
  }
  const below = stepCommitBelowHead(root, journal);
  if (below !== null && below !== head) {
    const belowShort = shortSha(root, below);
    console.error(
      `Error: After the ${kind} commit step, ${B} is at ${headShort} "${headSubject}", not at the ${kind} commit ${belowShort}: something made another commit after it while the release ran, most likely a git hook. Put ${B} back at ${belowShort} ${resetHint(root, below)}, fix or remove what did it, then re-run: npm run release -- --resume`,
    );
    return;
  }
  console.error(
    `Error: After the ${kind} commit step, ${B} is at ${headShort} "${headSubject}", but the ${kind} commit must have the subject "${stepSubject(kind, journal.version)}" and the parent ${anchorShort}: something changed that commit or made another one while the release ran, most likely a git hook. Put ${B} back at ${anchorShort} ${resetHint(root, anchor)}, fix or remove what did it, ${thenText(journal, fromStart)}`,
  );
}

async function onFailure(root, journalPath, err) {
  const journal = readJournalOrExit(root, journalPath);
  const V = journal.version;
  const signal = err instanceof InterruptError ? err.signal : null;

  // The first comparison failed in phase 1: the bump comes first, so the release has written
  // nothing. Remove the journal, restore nothing (a file that changed is someone else's change).
  if (err.kind === 'before-bump' && journal.phase === 'release') {
    removeJournal(journalPath);
    const head = headSha(root);
    if (head !== journal.startSha) {
      const headShort = shortSha(root, head);
      console.error(
        `Error: The release of v${V} stopped before changing anything: HEAD moved while the release ran, from ${shortSha(root, journal.startSha)} to ${headShort} "${subjectOf(root, head)}". Re-run to release ${headShort}: npm run release -- --version ${V}`,
      );
    } else {
      const steps = [];
      if (err.links.length > 0) steps.push(putBackText(err.links));
      if (err.changed.length > 0) {
        steps.push(
          `commit, stash or discard ${err.links.length > 0 ? 'the rest' : 'what changed'} (git restore --staged --worktree -- ${err.changed.join(' ')} discards it)`,
        );
      }
      steps.push(`re-run: npm run release -- --version ${V}`);
      console.error(
        `Error: The release of v${V} stopped before changing anything: ${err.message}. ${capitalize(steps.join(', then '))}`,
      );
    }
    process.exit(1);
  }

  const state = readState(root, journal);

  if (state.name === 'nothing-committed' || state.name === 'moved') {
    const base = journal.startSha;
    const left = restoreOnlyReleaseChanges(root, base, journal, false);
    removeJournal(journalPath);
    const restored = restoredClause(root, base, journal, left);
    const dist = DIST_NOTE(V);
    if (state.name === 'nothing-committed') {
      if (signal !== null) {
        console.error(
          `Error: The release of v${V} was interrupted (${signal}). ${restored} ${dist} To release, re-run: npm run release -- --version ${V}`,
        );
      } else {
        console.error(
          `Error: The release of v${V} stopped: ${err.message}. ${restored} ${dist} Fix the cause, then re-run: npm run release -- --version ${V}`,
        );
      }
      process.exit(1);
    }
    const headShort = shortSha(root, state.head);
    const moved = `HEAD moved while the release ran, from ${shortSha(root, base)} to ${headShort} "${subjectOf(root, state.head)}"`;
    const onlyHead =
      (err.kind === 'before-bump' || err.kind === 'before-add') &&
      err.changed.length === 0 &&
      err.links.length === 0 &&
      err.headMoved;
    if (signal !== null) {
      console.error(
        `Error: The release of v${V} was interrupted (${signal}), and ${moved}. ${restored} ${dist} To release ${headShort}, re-run: npm run release -- --version ${V}`,
      );
    } else if (onlyHead) {
      console.error(
        `Error: The release of v${V} stopped: ${moved}. ${restored} ${dist} Re-run to release ${headShort}: npm run release -- --version ${V}`,
      );
    } else {
      console.error(
        `Error: The release of v${V} stopped: ${err.message}, and ${moved}. ${restored} ${dist} Fix the cause, then re-run to release ${headShort}: npm run release -- --version ${V}`,
      );
    }
    process.exit(1);
  }
  if (state.name === 'committed-untagged' || state.name === 'developed-untagged') {
    const why = signal !== null ? `the release was interrupted (${signal})` : err.message;
    const next = signal !== null ? 'Run' : 'Fix the cause, then run';
    console.error(
      `Error: The release commit for v${V} exists (${shortSha(root, state.releaseCommit)}), but it is not tagged: ${why}. ${next}: npm run release -- --resume`,
    );
    process.exit(1);
  }
  if (state.name === 'tagged') {
    const left = restoreOnlyReleaseChanges(root, state.releaseCommit, journal, true);
    const why = signal !== null ? `the release was interrupted (${signal})` : err.message;
    const leftFiles = left.filter((l) => !l.link).map((l) => l.file);
    const leftLinks = left.filter((l) => l.link).map((l) => l.file);
    let leftText = '';
    if (leftFiles.length > 0) {
      const one = leftFiles.length === 1;
      leftText = ` It left ${leftFiles.join(', ')} as ${one ? 'it is' : 'they are'}, since ${one ? 'it holds a change' : 'they hold changes'} the release did not make: --resume says how to keep or drop ${one ? 'it' : 'them'}.`;
    }
    const steps = [];
    if (signal === null) steps.push('fix the cause');
    if (leftLinks.length > 0) steps.push(putBackText(leftLinks));
    const next = steps.length > 0 ? `${capitalize(steps.join(', '))}, then run` : 'Run';
    console.error(
      `Error: v${V} is committed and tagged, but the development version is not committed: ${why}.${leftText} ${next}: npm run release -- --resume`,
    );
    process.exit(1);
  }
  if (state.name === 'done') {
    removeJournal(journalPath);
    printSuccess(root, journal, state.releaseCommit);
    return;
  }
  // unknown: restore nothing, keep the journal
  if (err.kind === 'commit') {
    printCommitStepFailure(root, journal, err);
  } else {
    printCannotContinue(root, journalPath, journal);
  }
  process.exit(1);
}

// ── the two phases ─────────────────────────────────────────────────────────────────────────────

async function enterAndRunPhase2(root, journalPath, journal, releaseSha) {
  const V = journal.version;
  const devV = journal.devVersion;
  const newJournal = { ...journal, phase: 'development', releaseSha };
  writeJournal(journalPath, newJournal);
  try {
    const texts = checkBeforeBump(root, newJournal, releaseSha);
    await step(`Setting every package to ${devV}`, () => bumpFiles(root, newJournal, texts, devV));
    await step('Staging the version files', () => stageStep(root, newJournal, releaseSha, devV));
    await step(`Committing chore: begin development after v${V}`, () =>
      commitStep(root, newJournal, 'development'),
    );
  } catch (e) {
    await onFailure(root, journalPath, e);
    return;
  }
  removeJournal(journalPath);
  printSuccess(root, newJournal, releaseSha);
}

async function runPhase1(root, journalPath, journal) {
  const V = journal.version;
  let releaseSha = null;
  try {
    const texts = checkBeforeBump(root, journal, journal.startSha);
    await step(`Setting every package to ${V}`, () => bumpFiles(root, journal, texts, V));
    await step('Building', () => run(root, 'npm', ['run', 'build'], 'the build'));
    await step('Staging the version files', () => stageStep(root, journal, journal.startSha, V));
    await step(`Committing chore: release v${V}`, async () => {
      releaseSha = await commitStep(root, journal, 'release');
    });
    await step(`Tagging v${V}`, () => tagStep(root, V, releaseSha));
  } catch (e) {
    await onFailure(root, journalPath, e);
    return;
  }
  await enterAndRunPhase2(root, journalPath, journal, releaseSha);
}

// ── the registry read (readable at entry-check time, and swappable in tests) ───────────────────
//
// The SAME parsing runs whether the result came from a real `npm view <name> versions --json`
// call or from a test fixture: `--registry-fixture` holds npm's RAW result per package
// (`{ exitCode, stdout, stderr }`, exactly what that real call produces), never a pre-parsed
// shape — so the parsing itself (E404 detection, the version list, the error reason) is exercised
// by the tests, not bypassed by them.

/** `{ kind: 'ok', versions: string[] }` or `{ kind: 'error', reason: string }`. An E404 (the
 * package, or this version of it, was never published) counts as `ok` with no versions — that is
 * fine, a brand new package has never been released. */
function parseRegistryResult(exitCode, stdout, stderr) {
  if (exitCode === 0) {
    const trimmed = (stdout ?? '').trim();
    const parsed = trimmed === '' ? [] : JSON.parse(trimmed);
    return { kind: 'ok', versions: Array.isArray(parsed) ? parsed : [parsed] };
  }
  try {
    const parsed = JSON.parse((stdout ?? '').trim());
    if (parsed?.error?.code === 'E404') return { kind: 'ok', versions: [] };
    if (parsed?.error?.code !== undefined) {
      return { kind: 'error', reason: `npm ${parsed.error.code}: ${parsed.error.summary}` };
    }
  } catch {
    // stdout was not npm's JSON error shape: fall through to the stderr/stdout fallback below.
  }
  return { kind: 'error', reason: firstLine((stderr ?? '') || (stdout ?? '')) };
}

function readPublishedVersions(root, name, fixturePath) {
  if (fixturePath !== null) {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));
    if (!(name in fixture)) {
      return { kind: 'error', reason: `the registry fixture has no entry for ${name}` };
    }
    const { exitCode, stdout = '', stderr = '' } = fixture[name];
    return parseRegistryResult(exitCode, stdout, stderr);
  }
  const result = spawnSync('npm', ['view', name, 'versions', '--json'], {
    cwd: root,
    encoding: 'utf-8',
  });
  return parseRegistryResult(result.status, result.stdout, result.stderr);
}

// ── the place check: `--resume` and entry check 1 act only on the branch the release ran on ────

function placeCheck(root, journal) {
  const B = journal.branch;
  const current = currentBranch(root);
  if (current === B) return;
  const V = journal.version;
  const opening = current === null ? 'HEAD is not on a branch' : `You are on ${current}`;
  if (tryGit(root, 'rev-parse', '-q', '--verify', `refs/heads/${B}`) !== null) {
    console.error(
      `Error: ${opening}, but the unfinished v${V} release ran on ${B}. Switch back to it (git switch ${B}), then re-run: npm run release -- --resume`,
    );
    process.exit(1);
  }
  const head = headSha(root);
  const keepsEverything = readState(root, journal).name !== 'unknown';
  const at = keepsEverything ? head : stepAnchorOf(journal);
  const short = shortSha(root, at);
  console.error(
    `Error: ${opening}, but the unfinished v${V} release ran on ${B}, which no longer exists. Recreate it at ${short} (git switch -c ${B} ${short}), then re-run: npm run release -- --resume`,
  );
  process.exit(1);
}

// ── an unfinished or a prepared release that no journal records ────────────────────────────────
//
// With no journal, HEAD can still be a commit of an unfinished release, or come after one: a
// journal deleted by hand, an abandon that stopped half-way, a finish by hand that stopped after
// its tag. And HEAD can be the development commit of a finished release, or come after it.

/** The files the release sets at `commit`, as a journal records them, or null when no release was
 * made from it: each `packages/*` whose `package.json` there has `exports` or `main`, its
 * `package.json` and `src/version.ts`, in directory order, then `package-lock.json`. */
function releaseFilesAt(root, commit) {
  const listing = tryGit(root, 'ls-tree', '--name-only', commit, 'packages/');
  if (listing === null) return null;
  const dirs = listing
    .split('\n')
    .filter((l) => l !== '')
    .map((p) => p.replace(/^packages\//, ''))
    .sort();
  const files = [];
  for (const dir of dirs) {
    const text = tryGitRaw(root, 'show', `${commit}:packages/${dir}/package.json`);
    if (text === null) continue;
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch {
      return null;
    }
    if (pkg === null || typeof pkg !== 'object') continue;
    if (pkg.exports === undefined && pkg.main === undefined) continue;
    files.push(`packages/${dir}/package.json`, `packages/${dir}/src/version.ts`);
  }
  if (files.length === 0) return null;
  files.push(LOCKFILE);
  return files;
}

/** The commits of a release on `tip`'s first-parent line, tip included, nearest first: each whose
 * subject is `chore: release v<x>` or `chore: begin development after v<x>`, with `<x>` final.
 * `--grep` matches any line of a message, so the subject decides. A release branch starts from
 * main, whose first-parent line holds no such commit (a release PR is merged with a merge
 * commit), so these are the branch's own: without `--first-parent`, once a release this script
 * made is merged into main, the next release branch would read that release as prepared there. */
function releaseCandidates(root, tip) {
  const listed =
    tryGit(
      root,
      'rev-list',
      '--first-parent',
      '-E',
      '--grep=^chore: (release|begin development after) v',
      tip,
    ) ?? '';
  const out = [];
  for (const sha of listed.split('\n').filter((l) => l !== '')) {
    const m = /^chore: (release|begin development after) v(.+)$/.exec(subjectOf(root, sha) ?? '');
    if (m === null || !isFinal(m[2])) continue;
    out.push({ sha, kind: m[1] === 'release' ? 'release' : 'development', x: m[2] });
  }
  return out;
}
/** A release commit of `x` that passes the test on its parent: `{ parent, spec }`, or null. */
function releaseCommitOf(root, sha, x) {
  const parent = parentOf(root, sha);
  if (parent === null) return null;
  const files = releaseFilesAt(root, parent);
  if (files === null) return null;
  const spec = { version: x, devVersion: devVersionAfter(x), files };
  return testCommit(root, sha, 'release', parent, spec).ok ? { parent, spec } : null;
}
/** Whether some ref reaches a development commit of `x` that passes the test on release commit `r`. */
function hasDevelopmentCommit(root, r, x, spec) {
  const all = (tryGit(root, 'rev-list', '--all', '--parents') ?? '').split('\n');
  for (const line of all) {
    const [sha, firstParent] = line.split(' ');
    if (firstParent === r && testCommit(root, sha, 'development', r, spec).ok) return true;
  }
  return false;
}
/**
 * The first commit of a release on `tip`'s line that passes the test decides. `null` names
 * nothing. Otherwise `{ kind: 'unfinished' | 'untagged' | 'prepared', x, itsSha, startSha, … }`.
 * `itsSha` is the commit HEAD is counted after.
 */
function findRelease(root, tip = 'HEAD') {
  for (const c of releaseCandidates(root, tip)) {
    if (c.kind === 'release') {
      const r = releaseCommitOf(root, c.sha, c.x);
      if (r === null) continue;
      if (tagCommit(root, c.x) !== c.sha) {
        return {
          kind: 'unfinished',
          x: c.x,
          itsSha: c.sha,
          startSha: r.parent,
          words: `, the release commit of v${c.x}, not tagged v${c.x}`,
        };
      }
      if (hasDevelopmentCommit(root, c.sha, c.x, r.spec)) return null;
      return {
        kind: 'unfinished',
        x: c.x,
        itsSha: c.sha,
        startSha: r.parent,
        words: `, the release commit of v${c.x}, tagged v${c.x}, with no development commit after it`,
      };
    }
    const rsha = parentOf(root, c.sha);
    if (rsha === null) continue;
    const r = releaseCommitOf(root, rsha, c.x);
    if (r === null) continue;
    const t = testCommit(root, c.sha, 'development', rsha, r.spec);
    if (!t.ok) {
      return {
        kind: 'unfinished',
        x: c.x,
        itsSha: c.sha,
        startSha: r.parent,
        words: `, which has the subject of the development commit after v${c.x} but holds changes the release does not make, in ${t.files.join(', ')}`,
      };
    }
    if (tagCommit(root, c.x) === rsha) {
      return { kind: 'prepared', x: c.x, itsSha: c.sha, releaseSha: rsha, startSha: r.parent };
    }
    return { kind: 'untagged', x: c.x, itsSha: c.sha, releaseSha: rsha, startSha: r.parent };
  }
  return null;
}
function commitsAfterText(root, itsSha) {
  const n = countCommits(root, `${itsSha}..HEAD`);
  if (n === 0) return { n, text: '' };
  return {
    n,
    text: `, ${n} ${n === 1 ? 'commit' : 'commits'} after ${shortSha(root, itsSha)} "${subjectOf(root, itsSha)}"`,
  };
}
function headDescription(root) {
  const head = headSha(root);
  return `HEAD is ${shortSha(root, head)} "${subjectOf(root, head)}"`;
}
function abandonWhereFor(root, found, journalPath, n) {
  const branch = currentBranch(root) ?? `release/v${found.x}`;
  return abandonWhere(root, {
    startSha: found.startSha,
    itsSha: found.itsSha,
    n,
    keptBranch: keptBranchName(branch, shortSha(root, headSha(root))),
    version: found.x,
    journalPath,
  });
}
/** `{ what, wayOut }` for an unfinished release (`what` starts with `HEAD is`), or for an untagged
 * one `{ what: words, wayOut: finish }`. */
function describeUnfinished(root, found, journalPath) {
  const after = commitsAfterText(root, found.itsSha);
  const where = abandonWhereFor(root, found, journalPath, after.n);
  const x = found.x;
  if (found.kind === 'unfinished') {
    return {
      what: `${headDescription(root)}${after.text}${found.words}`,
      wayOut: `Finish it by hand (Part B step 3, "To finish an unfinished release by hand"), then go on with Part B step 4. Or abandon it (Part B step 3, "To abandon an unfinished release"${where}), then re-run: npm run release -- --version ${x}`,
    };
  }
  const relShort = shortSha(root, found.releaseSha);
  const relSubject = subjectOf(root, found.releaseSha);
  let tag = `tag ${relShort} (git tag --no-sign v${x} ${relShort})`;
  if (tagExists(root, x)) {
    const at = tagCommit(root, x);
    const names = at === null ? 'no commit' : `${shortSha(root, at)} "${subjectOf(root, at)}"`;
    tag = `delete tag v${x}, which names ${names} (git tag -d v${x}), then ${tag}`;
  }
  const stay = after.n >= 1 ? '; the commits after its development commit stay as they are' : '';
  return {
    what: `${headDescription(root)}${after.text}, the development commit after v${x}, whose parent ${relShort} "${relSubject}" is not tagged v${x}`,
    wayOut: `Finish it: ${tag}, then go on with Part B step 4${stay}. Or abandon it (Part B step 3, "To abandon an unfinished release"${where}), then re-run: npm run release -- --version ${x}`,
  };
}
/** The file list a journal would record for the release set in this checkout. */
function filesForSet(set) {
  return set
    .flatMap((m) => [`${m.dir}/package.json`, `${m.dir}/src/version.ts`])
    .concat([LOCKFILE]);
}
function preparedWhere(root, found) {
  const after = countCommits(root, `${found.itsSha}..HEAD`);
  return after === 0
    ? 'HEAD is its development commit'
    : `HEAD is ${after} ${after === 1 ? 'commit' : 'commits'} after its development commit ${shortSha(root, found.itsSha)}`;
}
function printPreparedFollowLines(root, found) {
  const branch = currentBranch(root);
  if (branch === null) return;
  for (const line of followLines(
    root,
    found.x,
    devVersionAfter(found.x),
    branch,
    filesForSet(readReleaseSet(root)),
  )) {
    console.log(line);
  }
}

// ── --version: every entry check, before any write ─────────────────────────────────────────────

const CHOOSE_ANOTHER =
  'make a release branch named for it (Part B step 1) and give it a CHANGELOG section (Part B step 2).';

/** Entry check 8a: files the release can set the versions in. Refuses the first case that applies. */
function checkFilesTheReleaseSets(root, set, files) {
  const refuse = (text) => {
    console.error(text);
    process.exit(1);
  };
  const names = new Set(set.map((m) => m.name));
  const NPM_LOCK = 'npm install --package-lock-only --ignore-scripts --lockfile-version=3';
  const commitLock = `git add ${LOCKFILE} && git commit -m 'chore: write package-lock.json with npm' -- ${LOCKFILE}`;

  // An `npm-shrinkwrap.json` at the root: npm reads it instead of package-lock.json.
  if (existsSync(join(root, 'npm-shrinkwrap.json'))) {
    refuse(
      "Error: npm-shrinkwrap.json exists: npm reads it instead of package-lock.json, and the release sets versions only in package-lock.json. Remove it (git rm npm-shrinkwrap.json && git commit -m 'chore: remove npm-shrinkwrap.json'), then re-run.",
    );
  }

  // A file the release sets that is a symbolic link in the commit it releases: git holds a link as
  // the path it points to, not the content it reads.
  const headModes = readBase(root, 'HEAD', files);
  for (const f of files) {
    if (headModes.get(f).mode === '120000') {
      refuse(
        `Error: ${f} is a symbolic link, and the release writes the files it sets only as regular files. Replace the link with a regular file holding its content (cat ${f} > ${f}.tmp && mv ${f}.tmp ${f}), commit it (git commit -m 'chore: replace the link ${f} with its content' -- ${f}), then re-run.`,
      );
    }
  }

  // A file the release sets with CRLF line ends: the release writes LF.
  for (const f of files) {
    let text;
    try {
      text = readFileSync(join(root, f), 'utf-8');
    } catch {
      continue; // a missing file is left to the cases below
    }
    if (!text.includes('\r')) continue;
    const committed = tryGitRaw(root, 'show', `HEAD:${f}`);
    if (committed !== null && committed.includes('\r')) {
      refuse(
        `Error: ${f} has CRLF line ends in the commit you are releasing, and the release writes LF. Convert it to LF (tr -d '\\r' < ${f} > ${f}.lf && mv ${f}.lf ${f}), commit it (git commit -m 'chore: convert ${f} to LF line ends' -- ${f}), then re-run.`,
      );
    }
    refuse(
      `Error: ${f} has CRLF line ends, and the release writes LF. Make a checkout with LF line ends (git config core.autocrlf false, then git rm -r -q --cached . && git reset -q --hard), then re-run.`,
    );
  }

  // package-lock.json itself, read from the working tree.
  const problem = lockfileProblem(root, set);
  if (problem !== null) {
    const prefix = `Error: The release cannot set the versions in ${LOCKFILE}: ${problem.reason}.`;
    if (problem.cannotRepair) {
      const good = lastGoodLockfileCommit(root, set);
      if (good !== null) {
        const short = shortSha(root, good);
        refuse(
          `${prefix} Restore it from ${short}, the last commit that wrote a package-lock.json npm can start from (git checkout ${short} -- ${LOCKFILE}), then bring it up to date with npm (${NPM_LOCK}), commit it (${commitLock}), then re-run.`,
        );
      }
      refuse(
        `${prefix} No commit holds a package-lock.json npm can start from: write a new one with npm (rm -f ${LOCKFILE} && ${NPM_LOCK}), commit it (${commitLock}), then re-run.`,
      );
    }
    refuse(`${prefix} Write it with npm (${NPM_LOCK}), commit it (${commitLock}), then re-run.`);
  }

  // A dependency that would stop npm from using the repository's own copy of a released package.
  const manifests = [];
  const readManifest = (manifest) => {
    const path = join(root, manifest);
    if (!existsSync(path)) return null;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (e) {
      throw new Error(`${manifest} is not valid JSON (${e.message})`, { cause: e });
    }
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  };
  const rootManifest = readManifest('package.json');
  manifests.push(['package.json', rootManifest]);
  const lock = JSON.parse(readFileSync(join(root, LOCKFILE), 'utf-8'));
  for (const key of Object.keys(lock.packages ?? {})) {
    if (key === '' || key.includes('node_modules/')) continue;
    manifests.push([`${key}/package.json`, readManifest(`${key}/package.json`)]);
  }
  for (const [manifest, pkg] of manifests) {
    if (pkg === null) continue;
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const deps = pkg[field];
      if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) continue;
      for (const [name, spec] of Object.entries(deps)) {
        if (names.has(name) && spec !== '*') {
          refuse(
            `Error: ${manifest} depends on ${name} as ${JSON.stringify(spec)}. The release sets versions without npm, and npm keeps using the repository's own copy of a package it releases only while every dependency on it is "*": set it to "*", write the lockfile with npm (${NPM_LOCK}), commit both (git commit -m 'chore: depend on ${name} as "*"' -- ${manifest} ${LOCKFILE}), then re-run.`,
          );
        }
      }
    }
  }

  // An override naming a package the release sets: package-lock.json does not record overrides.
  const walk = (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    for (const [key, inner] of Object.entries(value)) {
      const at = key.indexOf('@', 1);
      const pkgName = key === '.' ? null : at === -1 ? key : key.slice(0, at);
      if (pkgName !== null && names.has(pkgName)) return pkgName;
      const deeper = walk(inner);
      if (deeper !== null) return deeper;
    }
    return null;
  };
  const named = walk(rootManifest?.overrides);
  if (named !== null) {
    refuse(
      `Error: The overrides in package.json name ${named}. The release sets versions without npm, and ${LOCKFILE} does not record overrides, so the release cannot tell how npm would resolve ${named} after the version changes: remove that override, write the lockfile with npm (${NPM_LOCK}), commit both (git commit -m 'chore: remove the override of ${named}' -- package.json ${LOCKFILE}), then re-run.`,
    );
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function linksWithoutEntry(packages, member) {
  const link = packages[`node_modules/${member.name}`];
  return isPlainObject(link) && link.link === true && !Object.hasOwn(packages, member.dir);
}
/** `{ reason, cannotRepair }` for a package-lock.json the release cannot set the versions in, or null. */
function lockfileProblem(root, set) {
  const path = join(root, LOCKFILE);
  if (!existsSync(path)) return { reason: 'it does not exist', cannotRepair: true };
  const text = readFileSync(path, 'utf-8');
  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    return { reason: 'it is not valid JSON', cannotRepair: true };
  }
  if (!isPlainObject(lock)) return { reason: 'it is not a JSON object', cannotRepair: true };
  const packages = isPlainObject(lock.packages) ? lock.packages : {};
  for (const m of set) {
    if (linksWithoutEntry(packages, m)) {
      return { reason: `it has no entry for ${m.dir}`, cannotRepair: true };
    }
  }
  if (lock.lockfileVersion !== 3) {
    return { reason: 'it is not lockfileVersion 3', cannotRepair: false };
  }
  if (text !== JSON.stringify(lock, null, 2) + '\n') {
    return {
      reason:
        "it is not in the form the release writes (JSON indented by two spaces, ending in one newline); npm writes it with the root package.json's indentation",
      cannotRepair: false,
    };
  }
  for (const m of set) {
    if (!Object.hasOwn(packages, m.dir)) {
      return { reason: `it has no entry for ${m.dir}`, cannotRepair: false };
    }
    const entry = packages[m.dir];
    if (!isPlainObject(entry) || entry.version !== m.version) {
      return {
        reason: `its entry for ${m.dir} does not record version ${m.version}, the version in ${m.dir}/package.json`,
        cannotRepair: false,
      };
    }
  }
  return null;
}
/** The last commit that wrote a package-lock.json npm can start from, or null. */
function lastGoodLockfileCommit(root, set) {
  const revs = (tryGit(root, 'rev-list', 'HEAD', '--', LOCKFILE) ?? '')
    .split('\n')
    .filter((l) => l !== '');
  for (const c of revs) {
    const text = tryGitRaw(root, 'show', `${c}:${LOCKFILE}`);
    if (text === null) continue;
    let lock;
    try {
      lock = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isPlainObject(lock)) continue;
    const packages = isPlainObject(lock.packages) ? lock.packages : {};
    if (set.some((m) => linksWithoutEntry(packages, m))) continue;
    return c;
  }
  return null;
}

async function runVersion(root, journalPath, V, registryFixturePath) {
  // 1. the journal exists
  if (existsSync(journalPath)) {
    const journal = readJournalOrExit(root, journalPath);
    placeCheck(root, journal);
    const state = readState(root, journal);
    if (state.name === 'unknown') {
      printCannotContinue(root, journalPath, journal);
    } else if (state.name === 'nothing-committed' || state.name === 'moved') {
      console.error(
        `Error: An earlier release of v${journal.version} stopped before its release commit, so nothing is committed. Run npm run release -- --resume to restore the files it changed, then re-run npm run release -- --version ${journal.version}.`,
      );
    } else {
      console.error(
        `Error: An earlier release of v${journal.version} did not finish: ${STATE_WORDS[state.name]}. Run: npm run release -- --resume`,
      );
    }
    process.exit(1);
  }

  // 1b/1c. no journal: HEAD can still be a commit of an unfinished release, or of a prepared one
  const found = findRelease(root);
  if (found !== null && (found.kind === 'unfinished' || found.kind === 'untagged')) {
    const d = describeUnfinished(root, found, journalPath);
    console.error(
      `Error: ${capitalize(d.what)}: its release is unfinished, and no release journal records it. ${d.wayOut}`,
    );
    process.exit(1);
  }
  if (found !== null && found.kind === 'prepared' && found.x === V) {
    console.log(
      `v${V} is already prepared here: its release commit ${shortSha(root, found.releaseSha)} is tagged v${V}, and ${preparedWhere(root, found)}. Nothing is left to run: go on with Part B step 4.`,
    );
    printPreparedFollowLines(root, found);
    process.exit(0);
  }

  // 2. V starts with v and a digit
  if (/^v\d/.test(V)) {
    console.error(
      `Error: Write the version without the leading v: npm run release -- --version ${V.slice(1)}`,
    );
    process.exit(1);
  }

  // 3. V is not final
  if (!isFinal(V)) {
    console.error(
      `Error: "${V}" is not a release version. Use MAJOR.MINOR.PATCH, with no prerelease or build suffix: the publish workflow publishes to npm's latest tag.`,
    );
    process.exit(1);
  }

  // 4. no branch (a detached HEAD); 5. the branch is main
  const branch = currentBranch(root);
  const suggestion =
    tryGit(root, 'rev-parse', '-q', '--verify', `refs/heads/release/v${V}`) !== null
      ? `git switch release/v${V} (it already exists)`
      : `git switch -c release/v${V}`;
  if (branch === null) {
    console.error(
      `Error: You are not on a branch. Run the release on its own branch: ${suggestion}, then re-run.`,
    );
    process.exit(1);
  }
  if (branch === 'main') {
    console.error(
      `Error: You are on main. Run the release on its own branch: ${suggestion}, then re-run.`,
    );
    process.exit(1);
  }

  // 6. the working tree is not clean (untrimmed, so the status column survives). The start of the
  // release is HEAD as read right here: the commit the entry checks read.
  const startSha = headSha(root);
  const dirty = porcelainLines(root);
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 10).map((l) => `  ${l}`);
    const extra = dirty.length - 10;
    const lines = ['Error: The working tree is not clean:', ...shown];
    if (extra > 0) lines.push(`  … and ${extra} more`);
    lines.push(
      'Commit, stash (git stash -u also stashes untracked files) or remove them, then re-run.',
    );
    if (dirty.some((l) => pathOfPorcelain(l) === 'CHANGELOG.md')) {
      lines.push(
        `CHANGELOG.md is one of them: commit it rather than stashing or removing it, since the release reads its "## [${V}]" section.`,
      );
    }
    console.error(lines.join('\n'));
    process.exit(1);
  }

  // 7. the checking line
  console.log(
    `→ Checking that v${V} can be released: the version files, publish.yml, CHANGELOG.md, and the tags here and on origin`,
  );

  // 8. checkRelease fails
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
  const files = filesForSet(set);

  // 8a. the files the release sets the versions in
  checkFilesTheReleaseSets(root, set, files);

  // 9. isAbove(V, S) is false
  if (!isAbove(V, S)) {
    console.error(`Error: ${V} is not above the current version ${S}. Choose a higher version.`);
    process.exit(1);
  }

  // 10. CHANGELOG.md has no "## [<V>]" section (a missing file counts as empty)
  const changelogPath = join(root, 'CHANGELOG.md');
  const changelogContent = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf-8') : '';
  const changelogLines = changelogContent.split('\n');
  if (!changelogLines.some((line) => line.startsWith(`## [${V}]`))) {
    const none = `Error: CHANGELOG.md has no "## [${V}]" section`;
    if (changelogLines.some((line) => line.startsWith('## [Unreleased]'))) {
      console.error(
        `${none}. Rename its "## [Unreleased]" heading to "## [${V}] — <YYYY-MM-DD>" and commit it (Part B step 2), then re-run.`,
      );
      process.exit(1);
    }
    const newest = changelogLines.find((line) => line.startsWith('## ['));
    const noHeading = `${none} and no "## [Unreleased]" heading.`;
    if (newest === undefined) {
      console.error(
        `${noHeading} Add a "## [${V}] — <YYYY-MM-DD>" section and commit it (Part B step 2), then re-run.`,
      );
    } else {
      const N = newest.slice(newest.indexOf('[') + 1, newest.indexOf(']'));
      if (isFinal(N) && !isAbove(N, S)) {
        console.error(
          `${noHeading} Its newest section is "${newest.trim()}", for ${N}, which is not above the current version ${S}: add a "## [${V}] — <YYYY-MM-DD>" section above it with this release's notes and commit it (Part B step 2), then re-run.`,
        );
      } else {
        console.error(
          `${noHeading} Its newest section is "${newest.trim()}": if it holds this release's notes, rename it to "## [${V}] — <YYYY-MM-DD>"; otherwise add that section. Commit it (Part B step 2), then re-run.`,
        );
      }
    }
    process.exit(1);
  }

  // 11. no origin remote; git ls-remote failing
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
  const lsRemote = tryGitCapture(
    root,
    'ls-remote',
    '--tags',
    'origin',
    `refs/tags/v${V}`,
    `refs/tags/v${V}^{}`,
  );
  if (lsRemote.error !== null) {
    console.error(
      `Error: Cannot read tags from origin: ${firstLine(lsRemote.error)}. Check that git ls-remote origin works, then re-run.`,
    );
    process.exit(1);
  }

  // 12. tag v<V> on origin (before the local tag check: a tag on origin is a pushed tag, never a
  // leftover from an abandoned local attempt). An annotated tag lists its own object on the first
  // line and the commit it points at on the second (`^{}`); the commit is what matters, and it
  // may be one this checkout does not hold.
  const remoteLines = lsRemote.output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const tagLine = remoteLines.find((l) => l.endsWith(`refs/tags/v${V}`));
  if (tagLine !== undefined) {
    const peeledLine = remoteLines.find((l) => l.endsWith(`refs/tags/v${V}^{}`));
    const sha = (peeledLine ?? tagLine).split(/\s+/)[0];
    const commit = tryGit(root, 'rev-parse', '--verify', '--quiet', `${sha}^{commit}`);
    if (commit !== null) {
      const notAtV = set.some((m) => {
        const text = tryGitRaw(root, 'show', `${commit}:${m.dir}/package.json`);
        if (text === null) return true;
        try {
          return JSON.parse(text).version !== V;
        } catch {
          return true;
        }
      });
      if (notAtV) {
        console.error(
          `Error: Tag v${V} already exists on origin, at ${shortSha(root, commit)} "${subjectOf(root, commit)}", whose packages are not all at ${V}: that is not a release commit of v${V}, and this script cannot release that version. Choose another version: ${CHOOSE_ANOTHER} v${V} is skipped, and origin keeps its tag.`,
        );
        process.exit(1);
      }
    }
    console.error(
      `Error: Tag v${V} already exists on origin, and a v* tag pushed there starts the Publish workflow: this script cannot release that version. If that tag's Publish run failed (see the Actions page, Part B step 6), re-run it (Part B step 9); otherwise choose another version: ${CHOOSE_ANOTHER}`,
    );
    process.exit(1);
  }

  // 13. tag v<V> only here
  if (tagExists(root, V)) {
    const at = tagCommit(root, V);
    const where = at === null ? '' : `, at ${shortSha(root, at)} "${subjectOf(root, at)}"`;
    console.error(
      `Error: Tag v${V} already exists in this repository${where}. If it is left from an abandoned attempt, delete it (git tag -d v${V}), then re-run: npm run release -- --version ${V}; otherwise choose another version: ${CHOOSE_ANOTHER}`,
    );
    process.exit(1);
  }

  // 14. the registry
  console.log('→ Reading the published versions from the npm registry');
  for (const m of published) {
    const registry = readPublishedVersions(root, m.name, registryFixturePath);
    if (registry.kind === 'error') {
      console.error(
        `Error: Cannot read ${m.name} from the npm registry (${registry.reason}). Check that npm view ${m.name} versions works, then re-run.`,
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
  const journal = {
    version: V,
    devVersion: devVersionAfter(V),
    phase: 'release',
    startSha,
    releaseSha: null,
    files,
    branch,
  };
  writeJournal(journalPath, journal);
  await runPhase1(root, journalPath, journal);
}

// ── --resume: read the journal, act on the state it and git describe ───────────────────────────

/** `--resume` with no journal: name an unfinished or a prepared release, or say there is none. */
function resumeWithoutJournal(root, journalPath) {
  const found = findRelease(root);
  if (found !== null && (found.kind === 'unfinished' || found.kind === 'untagged')) {
    const d = describeUnfinished(root, found, journalPath);
    console.error(
      `Error: There is no release journal to resume from, but ${d.what}: its release is unfinished. ${d.wayOut}`,
    );
    process.exit(1);
  }
  if (found !== null && found.kind === 'prepared') {
    console.log(
      `There is no unfinished release to resume: v${found.x} is prepared here (its release commit ${shortSha(root, found.releaseSha)} is tagged v${found.x}, and ${preparedWhere(root, found)}). Go on with Part B step 4.`,
    );
    printPreparedFollowLines(root, found);
    process.exit(0);
  }
  console.error('Error: There is no unfinished release to resume.');
  process.exit(1);
}

async function doResume(root, journalPath) {
  if (!existsSync(journalPath)) {
    resumeWithoutJournal(root, journalPath);
    return;
  }
  const journal = readJournalOrExit(root, journalPath);
  placeCheck(root, journal);
  const state = readState(root, journal);
  // a package.json that does not parse is named here (the catch-all prints the message)
  readReleaseSet(root);
  const V = journal.version;

  if (state.name === 'nothing-committed' || state.name === 'moved') {
    const base = journal.startSha;
    const held = heldChanges(root, base, journal);
    if (held.listed.length > 0) refuseResume(root, journal, state, base, held);
    restoreWithNotice(root, base, journal, journal.files, held.inspected);
    removeJournal(journalPath);
    const startShort = shortSha(root, base);
    const moved =
      state.name === 'moved'
        ? ` HEAD has moved since the release started, from ${startShort} to ${shortSha(root, state.head)} "${subjectOf(root, state.head)}", which does not change those files.`
        : '';
    const words = uncleanWords(porcelainLines(root));
    const unclean =
      words === null
        ? ''
        : ` This checkout also holds changes that are not committed, in ${words}, and the re-run needs a clean checkout: commit, stash or remove them.`;
    const last =
      state.name === 'moved'
        ? `Re-run to release ${shortSha(root, state.head)}: npm run release -- --version ${V}`
        : `Re-run: npm run release -- --version ${V}`;
    console.error(
      `Error: The unfinished v${V} release stopped before its release commit, so --resume cannot finish it. It restored the ${journal.files.length} files the release sets to their content at ${startShort}.${moved} packages/*/dist may still hold its v${V} build: run npm run build before using this checkout.${unclean} ${last}`,
    );
    process.exit(1);
  }
  if (state.name === 'committed-untagged' || state.name === 'tagged') {
    const base = state.releaseCommit;
    const held = heldChanges(root, base, journal);
    if (held.listed.length > 0) refuseResume(root, journal, state, base, held);
    if (differsFrom(root, base, journal.files)) {
      restoreWithNotice(root, base, journal, journal.files, held.inspected);
    }
    if (state.name === 'committed-untagged') {
      try {
        await step(`Tagging v${V}`, () => tagStep(root, V, state.releaseCommit));
      } catch (e) {
        await onFailure(root, journalPath, e);
        return;
      }
    }
    await enterAndRunPhase2(root, journalPath, journal, state.releaseCommit);
    return;
  }
  if (state.name === 'developed-untagged') {
    try {
      await step(`Tagging v${V}`, () => tagStep(root, V, state.releaseCommit));
    } catch (e) {
      await onFailure(root, journalPath, e);
      return;
    }
    removeJournal(journalPath);
    printSuccess(root, journal, state.releaseCommit);
    return;
  }
  if (state.name === 'done') {
    removeJournal(journalPath);
    printSuccess(root, journal, state.releaseCommit);
    return;
  }
  printCannotContinue(root, journalPath, journal);
  process.exit(1);
}

// ── entry ──────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

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
  if (hasVersionFlag && !hasResumeFlag) {
    console.error(
      'Error: --version needs a version: npm run release -- --version <MAJOR.MINOR.PATCH>',
    );
    process.exit(1);
  }
  console.error(`Error: ${USAGE}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`Error: The release script failed unexpectedly: ${err.message}`);
  process.exit(1);
});
