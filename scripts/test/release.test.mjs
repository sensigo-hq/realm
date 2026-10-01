// scripts/test/release.test.mjs — issue #620 PR-A (D11 RL1-RL76). A synthetic monorepo like
// reference/setup.sh: four packages with src/version.ts and "*" internal dependencies, a private
// engine-tests without an entry, a publish.yml checkRelease accepts, a root build script
// (build.cjs, committed in the base commit) that does whatever the cell's BUILD_* variables ask
// and then writes a marker file OUTSIDE the working tree and sleeps BUILD_MS milliseconds, a bare
// repository as origin, and a registry fixture (every package unpublished unless a cell says
// otherwise).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  openSync,
  unlinkSync,
  symlinkSync,
  readlinkSync,
  lstatSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  makeTempDir,
  removeTempDir,
  makeIsolatedEnv,
  scriptPath,
  runNode,
  publishYmlFor,
  readPkgVersion,
} from './helpers.mjs';

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim();
const REAL_NPM = execFileSync('sh', ['-c', 'command -v npm'], { encoding: 'utf-8' }).trim();

function git(cwd, env, ...args) {
  return execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
/** Untrimmed: `git status --porcelain` starts with a space for an unstaged change. */
function gitRaw(cwd, env, ...args) {
  return execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function tryGit(cwd, env, ...args) {
  try {
    return git(cwd, env, ...args);
  } catch {
    return null;
  }
}
function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf-8'));
}
function writeJson(p, obj) {
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

const DEPS = {
  core: [],
  'mcp-server': ['core'],
  testing: ['core'],
  cli: ['core', 'mcp-server', 'testing'],
};

/** The nine files the release sets in the fixture, in the journal's order (by directory). */
const FILES = [
  'packages/cli/package.json',
  'packages/cli/src/version.ts',
  'packages/core/package.json',
  'packages/core/src/version.ts',
  'packages/mcp-server/package.json',
  'packages/mcp-server/src/version.ts',
  'packages/testing/package.json',
  'packages/testing/src/version.ts',
  'package-lock.json',
];

/**
 * The fixture's build script. Before anything else, in this order, it does what the cell's BUILD_*
 * variables ask (an edit to a version file, a staged edit, a lockfile edit, a chmod, a symbolic
 * link, a commit, a failure); then it writes BUILD_MARKER (if set) and sleeps BUILD_MS.
 */
const BUILD_SCRIPT = `const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const env = process.env;
function editJson(file, edit) {
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(obj);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\\n');
}
if (env.BUILD_EDIT) editJson('packages/core/package.json', (o) => { o.description = env.BUILD_EDIT; });
if (env.BUILD_EDIT_CLI) editJson('packages/cli/package.json', (o) => { o.description = env.BUILD_EDIT_CLI; });
if (env.BUILD_STAGE_EDIT) {
  const file = 'packages/core/package.json';
  const before = fs.readFileSync(file, 'utf8');
  editJson(file, (o) => { o.description = env.BUILD_STAGE_EDIT; });
  execFileSync('git', ['add', file]);
  fs.writeFileSync(file, before);
}
if (env.BUILD_LOCK_EDIT) editJson('package-lock.json', (o) => { o['x-edited-during-the-build'] = true; });
if (env.BUILD_EDIT_OTHER) editJson('packages/engine-tests/package.json', (o) => { o.dependencies = { '@q/core': '*' }; });
if (env.BUILD_CHMOD) fs.chmodSync('packages/core/package.json', 0o755);
if (env.BUILD_LINK) {
  for (const file of env.BUILD_LINK.split(',')) {
    const copy = path.join(env.HOME, 'outside-' + file.replaceAll('/', '_'));
    fs.copyFileSync(file, copy);
    fs.unlinkSync(file);
    fs.symlinkSync(copy, file);
  }
}
if (env.BUILD_COMMIT) execFileSync('git', ['commit', '-q', '--allow-empty', '-m', env.BUILD_COMMIT]);
if (env.BUILD_COMMIT_ALL) execFileSync('git', ['commit', '-q', '-am', env.BUILD_COMMIT_ALL]);
if (env.BUILD_FAIL) process.exit(Number(env.BUILD_FAIL));
if (env.BUILD_MARKER) fs.writeFileSync(env.BUILD_MARKER, String(process.pid));
setTimeout(() => process.exit(0), Number(env.BUILD_MS || 0));
`;

/** `npm install --package-lock-only` writes the fixture's lockfile. This machine's npm sometimes
 * segfaults (SIGSEGV) while it runs; try again before giving up, since a crash there is the
 * machine's, never the cell's. */
function writeLockfile(root, env) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
        cwd: root,
        env,
        stdio: 'ignore',
      });
      return;
    } catch (e) {
      lastError = e;
      if (e.signal !== 'SIGSEGV') throw e;
    }
  }
  throw lastError;
}

/**
 * Build the RL fixture. Returns `{ root, home, env, origin, journalPath, registry, start, … }`
 * with methods `git`, `gitRaw`, `tryGit`, `version`, `resume` and `cleanup`.
 */
function buildFixture(prefix, { version = '0.45.0', withOrigin = true } = {}) {
  const { home, env } = makeIsolatedEnv(prefix);
  const root = makeTempDir(`${prefix}-mono`);

  writeJson(join(root, 'package.json'), {
    name: 'mono',
    private: true,
    workspaces: ['packages/*'],
    scripts: { build: 'node build.cjs' },
  });
  writeFileSync(join(root, 'build.cjs'), BUILD_SCRIPT);
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');

  for (const [dir, deps] of Object.entries(DEPS)) {
    mkdirSync(join(root, 'packages', dir, 'src'), { recursive: true });
    writeJson(join(root, 'packages', dir, 'package.json'), {
      name: `@q/${dir}`,
      version,
      main: './dist/index.js',
      dependencies: Object.fromEntries(deps.map((d) => [`@q/${d}`, '*'])),
    });
    writeFileSync(
      join(root, 'packages', dir, 'src', 'version.ts'),
      `export const VERSION = '${version}';\n`,
    );
  }
  mkdirSync(join(root, 'packages', 'engine-tests'), { recursive: true });
  writeJson(join(root, 'packages', 'engine-tests', 'package.json'), {
    name: '@q/engine-tests',
    version: '0.0.0',
    private: true,
  });

  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(root, '.github', 'workflows', 'publish.yml'),
    publishYmlFor(['core', 'mcp-server', 'testing', 'cli']),
  );

  // the script refuses without a "## [<V>]" CHANGELOG section — sections for both versions the
  // cells release (0.46.0, and the follow-on release 0.46.1).
  writeFileSync(
    join(root, 'CHANGELOG.md'),
    '# Changelog\n\n## [0.46.1] — 2026-01-02\n\n## [0.46.0] — 2026-01-01\n',
  );

  writeLockfile(root, env);

  git(root, env, 'init', '-q', '.');
  git(root, env, 'add', '-A');
  git(root, env, 'commit', '-q', '-m', 'base');
  git(root, env, 'tag', '--no-sign', 'base-point');
  // the isolated git config's default branch is `main`, which the script refuses to release
  // from — every fixture releases from its own branch, as a real releaser would.
  git(root, env, 'switch', '-c', 'release/test');

  let origin = null;
  if (withOrigin) {
    origin = makeTempDir(`${prefix}-origin`);
    execFileSync('git', ['init', '-q', '--bare', origin], { env });
    git(root, env, 'remote', 'add', 'origin', origin);
  }

  const journalRel = join(git(root, env, 'rev-parse', '--git-dir'), 'realm-release.json');
  const journalPath = journalRel.startsWith('/') ? journalRel : join(root, journalRel);
  const registry = makeRegistryFixture(home);
  const start = git(root, env, 'rev-parse', 'HEAD');

  const fx = {
    root,
    home,
    env,
    origin,
    journalPath,
    registry,
    start,
    startShort: git(root, env, 'rev-parse', '--short', start),
    git: (...a) => git(root, env, ...a),
    gitRaw: (...a) => gitRaw(root, env, ...a),
    tryGit: (...a) => tryGit(root, env, ...a),
    short: (rev) => git(root, env, 'rev-parse', '--short', rev),
    /** `--version <v>` with the registry fixture; `extra` is layered onto the environment. */
    version: (v = '0.46.0', extra = {}) =>
      releaseSync(
        root,
        env,
        ['--root', root, '--version', v, '--registry-fixture', registry],
        extra,
      ),
    resume: (extra = {}) => releaseSync(root, env, ['--root', root, '--resume'], extra),
    cleanup: () => cleanup(root, home, origin),
  };
  return fx;
}

/**
 * `--registry-fixture` holds npm's RAW result per package (`{ exitCode, stdout, stderr }`,
 * exactly what `npm view <name> versions --json` produces), so the same parsing that a real call
 * goes through runs on the fixture too. `rawResultFor` translates each cell's override
 * (`{ versions: [...] }`, `{ error: 'E404' }`, `{ error: 'ETIMEDOUT: request timed out' }`) into
 * the shape captured from the real registry on 2026-09-30.
 */
function rawResultFor(name, override) {
  if (override.versions !== undefined) {
    return { exitCode: 0, stdout: JSON.stringify(override.versions, null, 2), stderr: '' };
  }
  if (override.error === 'E404') {
    const encodedName = name.replaceAll('/', '%2f'); // every '/', not only the first
    return {
      exitCode: 1,
      stdout: JSON.stringify(
        {
          error: {
            code: 'E404',
            summary: `Not Found - GET https://registry.npmjs.org/${encodedName} - Not found`,
          },
        },
        null,
        2,
      ),
      stderr: 'npm error code E404\n',
    };
  }
  // any other override string is "CODE: summary" — the shape every non-E404 override the cells
  // pass uses (e.g. "ETIMEDOUT: request timed out").
  const m = /^([A-Z0-9_]+): (.+)$/.exec(override.error);
  const code = m ? m[1] : 'EUNKNOWN';
  const summary = m ? m[2] : override.error;
  return {
    exitCode: 1,
    stdout: JSON.stringify({ error: { code, summary } }, null, 2),
    stderr: `npm error code ${code}\n`,
  };
}

/** A registry fixture where every package is unpublished (E404) except when overridden. Written
 * OUTSIDE the git repo root, so it never dirties the working tree. */
function makeRegistryFixture(home, overrides = {}) {
  const names = ['@q/core', '@q/mcp-server', '@q/testing', '@q/cli'];
  const fixture = {};
  for (const name of names)
    fixture[name] = rawResultFor(name, overrides[name] ?? { error: 'E404' });
  const p = join(home, 'registry-fixture.json');
  writeJson(p, fixture);
  return p;
}

function releaseSync(root, env, args, extra = {}) {
  return runNode(scriptPath('release.mjs'), args, { cwd: root, env: { ...env, ...extra } });
}

function cleanup(...dirs) {
  for (const d of dirs) if (d) removeTempDir(d);
}

/** What "nothing changed" means in a refusal leg: the same HEAD, the same branch, the same
 * `git status --porcelain`, the same tags, and the same journal bytes (or no journal). */
function snapshot(fx) {
  return {
    head: fx.git('rev-parse', 'HEAD'),
    branch: fx.tryGit('symbolic-ref', '--quiet', '--short', 'HEAD'),
    porcelain: fx.gitRaw('status', '--porcelain'),
    tags: fx.gitRaw('tag'),
    journal: existsSync(fx.journalPath) ? readFileSync(fx.journalPath, 'utf-8') : null,
  };
}
function assertNothingChanged(fx, before, label = '') {
  assert.deepEqual(snapshot(fx), before, `something changed ${label}`);
}

/** The lines of a script's output, for cells where git's or npm's own lines are there too. */
function lines(text) {
  return text.split('\n').filter((l) => l !== '');
}
/** Assert a refusal: exit 1, and `expected` as one whole line of stderr (or the whole of it). */
function assertRefusal(r, expected, { whole = true } = {}) {
  assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  if (whole) assert.equal(r.stderr.trimEnd(), expected);
  else assert.ok(lines(r.stderr).includes(expected), `stderr: ${r.stderr}`);
}

/**
 * The whole success text (every stdout line from `Prepared` to the end). `extra`: the lines
 * C2.9, C2.14 and C2.10 print between the first line and `Next steps:`, when the cell expects them.
 */
function successLines(
  fx,
  { V = '0.46.0', dev = '0.46.1-dev.0', branch = 'release/test', extra = [] } = {},
) {
  const sha = fx.short(`v${V}^{commit}`);
  return [
    `Prepared v${V} (not pushed or published yet): release commit ${sha}, tag v${V}. Development continues at ${dev}.`,
    ...extra,
    'Next steps:',
    `  1. Push the branch:  git push -u origin ${branch}`,
    '  2. Open the release PR and merge it with a merge commit (not squash, not rebase), so the tagged commit is on main.',
    `  3. Push the tag:     git switch main && git pull && git push origin v${V}`,
    '     Pushing the tag starts the Publish workflow. Push only this tag: --tags would push every local tag.',
    `Before working on ${dev}, run npm run build: packages/*/dist still holds the v${V} build.`,
  ];
}
function stdoutFrom(r, firstPrefix) {
  const all = r.stdout.split('\n');
  const at = all.findIndex((l) => l.startsWith(firstPrefix));
  assert.notEqual(at, -1, `no line starting ${firstPrefix} in stdout: ${r.stdout}`);
  return all.slice(at).filter((l, i, a) => !(l === '' && i === a.length - 1));
}
function assertSuccess(fx, r, opts = {}) {
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.deepEqual(stdoutFrom(r, 'Prepared'), successLines(fx, opts));
}

/** Edit a JSON file: parse, change, write back with the release's own formatting. */
function editJson(path, edit) {
  const obj = readJson(path);
  edit(obj);
  writeJson(path, obj);
}
/** RL28's edit: a last key `description` in packages/core/package.json, not committed. */
function editCoreDescription(fx, value = 'edited while the release was stopped') {
  editJson(join(fx.root, 'packages', 'core', 'package.json'), (o) => {
    o.description = value;
  });
}
/** The text between `after` and `before` in `text` (the command a message prints). */
function between(text, after, before) {
  const from = text.indexOf(after);
  assert.notEqual(from, -1, `no ${JSON.stringify(after)} in: ${text}`);
  const start = from + after.length;
  const to = text.indexOf(before, start);
  assert.notEqual(to, -1, `no ${JSON.stringify(before)} after it in: ${text}`);
  return text.slice(start, to);
}
/** Run a command a message printed, as printed, with `sh -c` in the fixture. */
function runPrinted(fx, command, extraEnv = {}) {
  return execFileSync('sh', ['-c', command], {
    cwd: fx.root,
    env: { ...fx.env, ...extraEnv },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function commitAll(fx, message) {
  fx.git('-c', 'commit.gpgsign=false', 'commit', '-q', '-am', message);
}

// ── signal-test infrastructure ────────────────────────────────────────────────────────────────
// "Signal the release process only after its marker file exists. Start the release in its own
// process group (detached: true) with its output redirected to files, never pipes, and wait for
// its exit event: after a SIGKILL its children (the build, a hook's git commit) live on and hold
// what they inherited, so a harness that waits for the pipes to close hangs. Kill the whole group
// at the end of each signal case." A marker can follow a build and a lockfile write, so the waits
// default to 60 s: a timeout only bounds a hang.

async function waitForFile(path, timeoutMs = 60000) {
  const start = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function waitForFileGone(path, timeoutMs = 60000) {
  const start = Date.now();
  while (existsSync(path)) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`timed out waiting for ${path} to be removed`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Spawn release.mjs detached, in its own process group, with stdout/stderr redirected to files
 * (never pipes — a piped child that outlives the parent hangs a harness waiting for the pipe to
 * close). Returns `{ child, outFile, errFile, waitExit(), killPid(sig), killGroup(sig) }`.
 */
function spawnReleaseDetached(root, env, args, envOverrides = {}) {
  const outFile = join(root, '..', `out-${process.pid}-${Date.now()}-${Math.random()}.log`);
  const errFile = join(root, '..', `err-${process.pid}-${Date.now()}-${Math.random()}.log`);
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  const child = spawn('node', [scriptPath('release.mjs'), ...args], {
    cwd: root,
    env: { ...env, ...envOverrides },
    detached: true,
    stdio: ['ignore', outFd, errFd],
  });
  let exited = false;
  let exitCode = null;
  let exitSignal = null;
  child.on('exit', (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
  });
  return {
    child,
    outFile,
    errFile,
    async waitExit(timeoutMs = 60000) {
      const start = Date.now();
      while (!exited) {
        if (Date.now() - start > timeoutMs)
          throw new Error('timed out waiting for release.mjs to exit');
        await new Promise((r) => setTimeout(r, 20));
      }
      return { code: exitCode, signal: exitSignal };
    },
    killPid(sig) {
      try {
        process.kill(child.pid, sig);
      } catch {
        // already gone
      }
    },
    killGroup(sig) {
      try {
        process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    },
  };
}
function readOut(handle) {
  return existsSync(handle.outFile) ? readFileSync(handle.outFile, 'utf-8') : '';
}
function readErr(handle) {
  return existsSync(handle.errFile) ? readFileSync(handle.errFile, 'utf-8') : '';
}
function cleanupSignalFiles(handle) {
  for (const f of [handle.outFile, handle.errFile]) {
    try {
      unlinkSync(f);
    } catch {
      // already gone
    }
  }
}

// ── the cells' shared set-ups ──────────────────────────────────────────────────────────────────

/** The journal the script writes at entry for 0.46.0 at HEAD on release/test, with the fixture's
 * nine files; `overrides` are applied on top. For cells about the journal itself (RL16, RL29), or
 * where no step of a real run reaches the state cheaply (RL30, RL38). */
function writeJournal(fx, overrides = {}) {
  const journal = {
    version: '0.46.0',
    devVersion: '0.46.1-dev.0',
    phase: 'release',
    startSha: fx.git('rev-parse', 'HEAD'),
    releaseSha: null,
    files: FILES,
    branch: 'release/test',
    ...overrides,
  };
  writeFileSync(fx.journalPath, JSON.stringify(journal, null, 2) + '\n');
  return journal;
}

/** RL11's steps: start `--version 0.46.0` detached with a 4 s build (and the build's variables in
 * `extra`), SIGKILL the release process once the build's marker exists, and wait for it to exit. */
async function crashDuringBuild(fx, extra = {}) {
  const marker = join(fx.home, 'build-marker');
  const handle = spawnReleaseDetached(
    fx.root,
    fx.env,
    ['--root', fx.root, '--version', '0.46.0', '--registry-fixture', fx.registry],
    { BUILD_MARKER: marker, BUILD_MS: '4000', ...extra },
  );
  try {
    await waitForFile(marker);
    handle.killPid('SIGKILL'); // uncatchable: release.mjs dies with NO handler running
    await handle.waitExit();
  } finally {
    handle.killGroup('SIGKILL');
    cleanupSignalFiles(handle);
  }
}

/** A commit-msg hook that refuses the development commit: the release commit and its tag stand
 * (the `tagged` state). Runs `--version 0.46.0`, asserts exit 1, and removes the hook. */
function failDevCommit(fx) {
  const hookPath = join(fx.root, '.git', 'hooks', 'commit-msg');
  writeFileSync(
    hookPath,
    '#!/bin/sh\nif grep -q "^chore: begin development" "$1"; then echo "refused" >&2; exit 1; fi\nexit 0\n',
  );
  chmodSync(hookPath, 0o755);
  const r = fx.version();
  assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  unlinkSync(hookPath);
  return r;
}

/** The stale tag-ref lock: the tag step fails after the release commit (the `committed-untagged`
 * state). Runs `--version 0.46.0`, asserts exit 1, and returns the lock's path. */
function failTagging(fx) {
  const lock = join(fx.root, '.git', 'refs', 'tags', 'v0.46.0.lock');
  mkdirSync(join(fx.root, '.git', 'refs', 'tags'), { recursive: true });
  writeFileSync(lock, '');
  const r = fx.version();
  assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return lock;
}

/** RL14's post-commit hook with SIGKILL instead of SIGINT: once the development commit is made,
 * it kills the release process, releases the hook, waits for `index.lock` to go and removes the
 * hook. The journal remains, in phase `development`, at the development commit. */
async function leaveDoneJournal(fx) {
  const marker = join(fx.home, 'postcommit-marker');
  const releaseFile = join(fx.home, 'postcommit-release');
  const hookPath = join(fx.root, '.git', 'hooks', 'post-commit');
  writeFileSync(
    hookPath,
    [
      '#!/bin/sh',
      'MSG="$(git log -1 --format=%s)"',
      'case "$MSG" in',
      '  "chore: begin development"*)',
      '    touch "$MARKER_FILE"',
      '    while [ ! -f "$RELEASE_FILE" ]; do sleep 0.02; done',
      '    ;;',
      'esac',
      'exit 0',
    ].join('\n') + '\n',
  );
  chmodSync(hookPath, 0o755);
  const handle = spawnReleaseDetached(
    fx.root,
    fx.env,
    ['--root', fx.root, '--version', '0.46.0', '--registry-fixture', fx.registry],
    { MARKER_FILE: marker, RELEASE_FILE: releaseFile },
  );
  try {
    await waitForFile(marker); // the development commit has landed; the hook is now blocked
    handle.killPid('SIGKILL');
    await handle.waitExit();
    writeFileSync(releaseFile, '');
    await waitForFileGone(join(fx.root, '.git', 'index.lock'));
  } finally {
    handle.killGroup('SIGKILL');
    cleanupSignalFiles(handle);
    unlinkSync(hookPath);
  }
}

/** A directory of shims, returned as the `PATH` to pass to ONE release run.
 * `wrappers`: `sh` wrappers for `npm` and `git`, before the real PATH. `bare`: only `node` and
 * `git`, so there is no npm. */
function makeShimDir(fx, kind) {
  const dir = join(fx.home, `shims-${kind}`);
  mkdirSync(dir, { recursive: true });
  if (kind === 'bare') {
    symlinkSync(process.execPath, join(dir, 'node'));
    symlinkSync(REAL_GIT, join(dir, 'git'));
    return dir;
  }
  const phase =
    'phase=release\ncase "$(grep \'"version"\' packages/core/package.json 2>/dev/null)" in *-dev.*) phase=development ;; esac\n';
  writeFileSync(
    join(dir, 'npm'),
    [
      '#!/bin/sh',
      phase.trimEnd(),
      'case "$1" in',
      '  install) echo "npm error test: the release must not run npm install" >&2; exit 97 ;;',
      '  run) if [ "$KILL_NPM_RUN" = "$phase" ]; then kill -TERM $$; fi ;;',
      'esac',
      `exec ${REAL_NPM} "$@"`,
    ].join('\n') + '\n',
  );
  const breakCases = [
    "    package-lock.json) printf '{\\n' > package-lock.json ;;",
    "    packages/core/src/version.ts) printf 'export const VERSION = 1;\\n' > packages/core/src/version.ts ;;",
    `    README.md) printf 'readme\\n' > README.md; ${REAL_GIT} add README.md ;;`,
    `    staged) cp packages/core/package.json "$HOME/prev-package.json"; printf 'staged meanwhile\\n' >> packages/core/package.json; ${REAL_GIT} add packages/core/package.json; cp "$HOME/prev-package.json" packages/core/package.json ;;`,
    '    link) cp packages/core/src/version.ts "$HOME/outside-version.ts"; rm packages/core/src/version.ts; ln -s "$HOME/outside-version.ts" packages/core/src/version.ts ;;',
    '    link-and-edit) cp packages/core/src/version.ts "$HOME/outside-version.ts"; rm packages/core/src/version.ts; ln -s "$HOME/outside-version.ts" packages/core/src/version.ts; printf \'edited meanwhile\\n\' >> packages/core/package.json ;;',
  ];
  writeFileSync(
    join(dir, 'git'),
    [
      '#!/bin/sh',
      phase.trimEnd(),
      'if [ "$1" = add ] && [ "$FAIL_GIT_ADD" = "$phase" ]; then',
      '  echo "fatal: git add refused in the $phase phase (test)" >&2; exit 128',
      'fi',
      'if [ "$1" = ls-remote ] && [ -n "$LS_REMOTE_BREAK" ] && [ ! -f "$HOME/ls-remote-done" ]; then',
      '  touch "$HOME/ls-remote-done"',
      '  case "$LS_REMOTE_BREAK" in',
      ...breakCases,
      '  esac',
      '  if [ -n "$LS_REMOTE_COMMIT" ]; then',
      `    ${REAL_GIT} -c commit.gpgsign=false commit -q -am "a commit made meanwhile"`,
      '  fi',
      'fi',
      `exec ${REAL_GIT} "$@"`,
    ].join('\n') + '\n',
  );
  chmodSync(join(dir, 'npm'), 0o755);
  chmodSync(join(dir, 'git'), 0o755);
  return `${dir}:${fx.env.PATH}`;
}

// ── RL1 happy path ─────────────────────────────────────────────────────────────────────────

test('RL1 — happy path, 0.45.0 -> 0.46.0', () => {
  const fx = buildFixture('rl1');
  try {
    const r = fx.version();
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);

    // the exact progress lines, in order: the release never runs npm install, so there is no
    // lockfile step, and the registry read has its own line.
    const arrowLines = r.stdout.split('\n').filter((l) => l.startsWith('→ '));
    assert.deepEqual(arrowLines, [
      '→ Checking that v0.46.0 can be released: the version files, publish.yml, CHANGELOG.md, and the tags here and on origin',
      '→ Reading the published versions from the npm registry',
      '→ Setting every package to 0.46.0',
      '→ Building',
      '→ Staging the version files',
      '→ Committing chore: release v0.46.0',
      '→ Tagging v0.46.0',
      '→ Setting every package to 0.46.1-dev.0',
      '→ Staging the version files',
      '→ Committing chore: begin development after v0.46.0',
    ]);
    // every line of the success text, in order
    assert.deepEqual(stdoutFrom(r, 'Prepared'), successLines(fx));

    // two new commits
    const log = fx.git('log', '--format=%s', '-3');
    assert.deepEqual(log.split('\n'), [
      'chore: begin development after v0.46.0',
      'chore: release v0.46.0',
      'base',
    ]);
    // tag v0.46.0 is lightweight and points at the release commit
    assert.equal(fx.git('cat-file', '-t', 'v0.46.0'), 'commit');
    const releaseCommit = fx.git('rev-list', '-n1', 'v0.46.0');
    assert.equal(fx.git('log', '-1', '--format=%s', releaseCommit), 'chore: release v0.46.0');
    // its tree has 0.46.0 in every package.json and src/version.ts
    for (const dir of ['core', 'mcp-server', 'testing', 'cli']) {
      const pkgAtRelease = fx.git('show', `${releaseCommit}:packages/${dir}/package.json`);
      assert.equal(JSON.parse(pkgAtRelease).version, '0.46.0');
      const vtsAtRelease = fx.git('show', `${releaseCommit}:packages/${dir}/src/version.ts`);
      assert.match(vtsAtRelease, /VERSION = '0\.46\.0'/);
    }
    // HEAD has 0.46.1-dev.0 in all of them
    for (const dir of ['core', 'mcp-server', 'testing', 'cli']) {
      assert.equal(readPkgVersion(fx.root, dir), '0.46.1-dev.0');
      const vts = readFileSync(join(fx.root, 'packages', dir, 'src', 'version.ts'), 'utf-8');
      assert.match(vts, /VERSION = '0\.46\.1-dev\.0'/);
    }
    // working tree clean
    assert.equal(fx.git('status', '--porcelain'), '');
    // engine-tests untouched
    assert.equal(
      readJson(join(fx.root, 'packages', 'engine-tests', 'package.json')).version,
      '0.0.0',
    );
    // no journal
    assert.equal(existsSync(fx.journalPath), false);
  } finally {
    fx.cleanup();
  }
});

// ── RL2 prerelease refused; RL3 same/downgrade refused ──────────────────────────────────────

test('RL2 — 0.47.0-rc.1 is refused; nothing is written', () => {
  const fx = buildFixture('rl2');
  try {
    const before = snapshot(fx);
    const r = fx.version('0.47.0-rc.1');
    assertRefusal(
      r,
      `Error: "0.47.0-rc.1" is not a release version. Use MAJOR.MINOR.PATCH, with no prerelease or build suffix: the publish workflow publishes to npm's latest tag.`,
    );
    assertNothingChanged(fx, before);
  } finally {
    fx.cleanup();
  }
});

test('RL3 — 0.45.0 (same) and 0.44.9 (downgrade) are refused', () => {
  for (const v of ['0.45.0', '0.44.9']) {
    const fx = buildFixture('rl3');
    try {
      const before = snapshot(fx);
      const r = fx.version(v);
      assertRefusal(
        r,
        `Error: ${v} is not above the current version 0.45.0. Choose a higher version.`,
      );
      assertNothingChanged(fx, before, `v=${v}`);
    } finally {
      fx.cleanup();
    }
  }
});

// ── RL4 from a dev-version tree ───────────────────────────────────────────────────────────────

test('RL4 — from a tree at 0.46.1-dev.0: 0.46.1 is accepted; 0.46.0 is refused', () => {
  const fx = buildFixture('rl4', { version: '0.46.1-dev.0' });
  try {
    const refused = fx.version('0.46.0');
    assertRefusal(
      refused,
      'Error: 0.46.0 is not above the current version 0.46.1-dev.0. Choose a higher version.',
    );

    const accepted = fx.version('0.46.1');
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(readPkgVersion(fx.root, 'core'), '0.46.2-dev.0');
  } finally {
    fx.cleanup();
  }
});

// ── RL5 tag-existence refusals ─────────────────────────────────────────────────────────────────

const CHOOSE_ANOTHER =
  'make a release branch named for it (Part B step 1) and give it a CHANGELOG section (Part B step 2).';

function originTagText(commitShort, subject) {
  return `Error: Tag v0.46.0 already exists on origin, at ${commitShort} "${subject}", whose packages are not all at 0.46.0: that is not a release commit of v0.46.0, and this script cannot release that version. Choose another version: ${CHOOSE_ANOTHER} v0.46.0 is skipped, and origin keeps its tag.`;
}
const ORIGIN_TAG_PUBLISH_TEXT = `Error: Tag v0.46.0 already exists on origin, and a v* tag pushed there starts the Publish workflow: this script cannot release that version. If that tag's Publish run failed (see the Actions page, Part B step 6), re-run it (Part B step 9); otherwise choose another version: ${CHOOSE_ANOTHER}`;

test('RL5 — refused: local tag; tag on origin; no origin remote; unreadable origin', () => {
  {
    // a local tag at a commit, and one that names a tree
    const fx = buildFixture('rl5a');
    try {
      fx.git('tag', '--no-sign', 'v0.46.0', 'base-point');
      const before = snapshot(fx);
      const r = fx.version();
      assertRefusal(
        r,
        `Error: Tag v0.46.0 already exists in this repository, at ${fx.short('base-point')} "base". If it is left from an abandoned attempt, delete it (git tag -d v0.46.0), then re-run: npm run release -- --version 0.46.0; otherwise choose another version: ${CHOOSE_ANOTHER}`,
      );
      assertNothingChanged(fx, before);

      fx.git('tag', '-d', 'v0.46.0');
      fx.git('tag', '--no-sign', 'v0.46.0', 'HEAD^{tree}');
      const before2 = snapshot(fx);
      const r2 = fx.version();
      assertRefusal(
        r2,
        `Error: Tag v0.46.0 already exists in this repository. If it is left from an abandoned attempt, delete it (git tag -d v0.46.0), then re-run: npm run release -- --version 0.46.0; otherwise choose another version: ${CHOOSE_ANOTHER}`,
      );
      assertNothingChanged(fx, before2);
    } finally {
      fx.cleanup();
    }
  }
  {
    // origin holds v0.46.0 at the fixture's base-point (packages at 0.45.0)
    const fx = buildFixture('rl5b');
    try {
      execFileSync('git', ['push', 'origin', 'base-point:refs/tags/v0.46.0'], {
        cwd: fx.root,
        env: fx.env,
        stdio: 'ignore',
      });
      const before = snapshot(fx);
      const r = fx.version();
      assertRefusal(r, originTagText(fx.short('base-point'), 'base'));
      assertNothingChanged(fx, before);
    } finally {
      fx.cleanup();
    }
  }
  {
    // the tag exists BOTH locally and on origin — the origin check runs first, so this must get
    // the origin text, never the local "git tag -d" hint.
    const fx = buildFixture('rl5e');
    try {
      fx.git('tag', '--no-sign', 'v0.46.0', 'base-point');
      execFileSync('git', ['push', 'origin', 'v0.46.0'], {
        cwd: fx.root,
        env: fx.env,
        stdio: 'ignore',
      });
      const before = snapshot(fx);
      const r = fx.version();
      assertRefusal(r, originTagText(fx.short('base-point'), 'base'));
      assert.doesNotMatch(r.stderr, /git tag -d/);
      assertNothingChanged(fx, before);
    } finally {
      fx.cleanup();
    }
  }
  {
    // an annotated tag, pushed from here and deleted here: the commit, not the tag's object
    const fx = buildFixture('rl5f');
    try {
      fx.git('tag', '--no-sign', '-a', '-m', 'by hand', 'v0.46.0', 'base-point');
      execFileSync('git', ['push', 'origin', 'v0.46.0'], {
        cwd: fx.root,
        env: fx.env,
        stdio: 'ignore',
      });
      fx.git('tag', '-d', 'v0.46.0');
      const before = snapshot(fx);
      const r = fx.version();
      assertRefusal(r, originTagText(fx.short('base-point'), 'base'));
      assertNothingChanged(fx, before);
    } finally {
      fx.cleanup();
    }
  }
  {
    // an annotated tag made in ANOTHER clone of the fixture: this checkout does not hold its
    // object, so the commit comes from the `^{}` line (with the first pattern alone, git
    // ls-remote lists only the tag object, and this leg would get the second text)
    const fx = buildFixture('rl5g');
    const other = makeTempDir('rl5g-clone');
    try {
      execFileSync('git', ['clone', '-q', fx.root, join(other, 'c')], {
        env: fx.env,
        stdio: 'ignore',
      });
      const c = join(other, 'c');
      git(c, fx.env, 'tag', '--no-sign', '-a', '-m', 'made elsewhere', 'v0.46.0', 'base-point');
      const object = git(c, fx.env, 'rev-parse', 'v0.46.0');
      git(c, fx.env, 'push', fx.origin, 'v0.46.0');
      assert.equal(fx.tryGit('cat-file', '-t', object), null, 'the fixture must not hold the tag');
      const before = snapshot(fx);
      const r = fx.version();
      assertRefusal(r, originTagText(fx.short('base-point'), 'base'));
      assertNothingChanged(fx, before);
    } finally {
      cleanup(other);
      fx.cleanup();
    }
  }
  {
    // origin's tag names a release commit this checkout holds: a finished release, its tag
    // pushed to origin, then deleted here and the branch reset to the start
    const fx = buildFixture('rl5h');
    try {
      assertSuccess(fx, fx.version());
      execFileSync('git', ['push', 'origin', 'v0.46.0'], {
        cwd: fx.root,
        env: fx.env,
        stdio: 'ignore',
      });
      fx.git('tag', '-d', 'v0.46.0');
      fx.git('reset', '--hard', fx.start);
      const before = snapshot(fx);
      const r = fx.version();
      assertRefusal(r, ORIGIN_TAG_PUBLISH_TEXT);
      assertNothingChanged(fx, before);
    } finally {
      fx.cleanup();
    }
  }
  {
    // origin's tag names a commit this checkout does not hold: a tag pushed from another clone
    const fx = buildFixture('rl5i');
    const other = makeTempDir('rl5i-clone');
    try {
      execFileSync('git', ['clone', '-q', fx.root, join(other, 'c')], {
        env: fx.env,
        stdio: 'ignore',
      });
      const c = join(other, 'c');
      git(c, fx.env, 'commit', '-q', '--allow-empty', '-m', 'elsewhere');
      git(c, fx.env, 'tag', '--no-sign', 'v0.46.0');
      git(c, fx.env, 'push', fx.origin, 'v0.46.0');
      const before = snapshot(fx);
      const r = fx.version();
      assertRefusal(r, ORIGIN_TAG_PUBLISH_TEXT);
      assertNothingChanged(fx, before);
    } finally {
      cleanup(other);
      fx.cleanup();
    }
  }
  {
    const fx = buildFixture('rl5c', { withOrigin: false });
    try {
      const before = snapshot(fx);
      const r = fx.version();
      assertRefusal(
        r,
        'Error: This repository has no origin remote, so the release cannot be pushed. Add it (git remote add origin <url>), then re-run.',
      );
      assertNothingChanged(fx, before);
    } finally {
      fx.cleanup();
    }
  }
  {
    const fx = buildFixture('rl5d');
    try {
      fx.git('remote', 'set-url', 'origin', '/nonexistent/path/for/test.git');
      const r = fx.version();
      assert.equal(r.status, 1);
      assert.match(
        r.stderr,
        /^Error: Cannot read tags from origin: .+\. Check that git ls-remote origin works, then re-run\./,
      );
    } finally {
      fx.cleanup();
    }
  }
});

// ── RL6 registry refusals ───────────────────────────────────────────────────────────────────

test('RL6 — refused: already published; above highest published; registry error. Accepted: E404 for one package.', () => {
  {
    const fx = buildFixture('rl6a');
    try {
      const registry = makeRegistryFixture(fx.home, {
        '@q/core': { versions: ['0.44.0', '0.46.0'] },
      });
      const r = releaseSync(fx.root, fx.env, [
        '--root',
        fx.root,
        '--version',
        '0.46.0',
        '--registry-fixture',
        registry,
      ]);
      assert.equal(r.status, 1);
      assert.match(
        r.stderr,
        /^Error: @q\/core@0\.46\.0 is already published\. Choose another version\./,
      );
    } finally {
      fx.cleanup();
    }
  }
  {
    const fx = buildFixture('rl6b');
    try {
      // a prerelease ABOVE the highest final must be ignored (0.48.0-rc.1)
      const registry = makeRegistryFixture(fx.home, {
        '@q/core': { versions: ['0.44.0', '0.47.0', '0.48.0-rc.1'] },
      });
      const r = releaseSync(fx.root, fx.env, [
        '--root',
        fx.root,
        '--version',
        '0.46.0',
        '--registry-fixture',
        registry,
      ]);
      assert.equal(r.status, 1);
      assert.match(
        r.stderr,
        /^Error: 0\.46\.0 is not above @q\/core's highest published version 0\.47\.0\. Choose a higher version\./,
      );
    } finally {
      fx.cleanup();
    }
  }
  {
    const fx = buildFixture('rl6c');
    try {
      const registry = makeRegistryFixture(fx.home, {
        '@q/core': { error: 'ETIMEDOUT: request timed out' },
      });
      const r = releaseSync(fx.root, fx.env, [
        '--root',
        fx.root,
        '--version',
        '0.46.0',
        '--registry-fixture',
        registry,
      ]);
      assert.equal(r.status, 1);
      assert.match(
        r.stderr,
        /^Error: Cannot read @q\/core from the npm registry \(npm ETIMEDOUT: request timed out\)\. Check that npm view @q\/core versions works, then re-run\./,
      );
    } finally {
      fx.cleanup();
    }
  }
  {
    // Accepted: E404 for one package plus real versions for others
    const fx = buildFixture('rl6d');
    try {
      const registry = makeRegistryFixture(fx.home, {
        '@q/core': { error: 'E404' },
        '@q/mcp-server': { versions: ['0.10.0'] },
      });
      const r = releaseSync(fx.root, fx.env, [
        '--root',
        fx.root,
        '--version',
        '0.46.0',
        '--registry-fixture',
        registry,
      ]);
      assert.equal(r.status, 0, r.stderr);
      // assert the success line itself, not only exit 0 — with phase 2 removed it still exited 0.
      assert.match(
        r.stdout,
        /^Prepared v0\.46\.0 \(not pushed or published yet\): release commit [0-9a-f]+, tag v0\.46\.0\. Development continues at 0\.46\.1-dev\.0\.$/m,
      );
    } finally {
      fx.cleanup();
    }
  }
});

// ── RL7 dirty tree / checkRelease failure ───────────────────────────────────────────────────

test('RL7 — refused: a dirty tree; a tree that fails checkRelease', () => {
  {
    const fx = buildFixture('rl7a');
    try {
      writeFileSync(join(fx.root, 'packages', 'core', 'README.md'), 'dirty\n');
      const r = fx.version();
      // the full listing text, naming the one untracked file (its porcelain status column
      // preserved — the message reads it untrimmed); no CHANGELOG line.
      assert.equal(
        r.stderr.trim(),
        'Error: The working tree is not clean:\n' +
          '  ?? packages/core/README.md\n' +
          'Commit, stash (git stash -u also stashes untracked files) or remove them, then re-run.',
      );
    } finally {
      fx.cleanup();
    }
  }
  {
    // twelve untracked files: ten listed, then `… and 2 more`
    const fx = buildFixture('rl7c');
    try {
      const names = Array.from({ length: 12 }, (_, i) => `f${String(i + 1).padStart(2, '0')}.txt`);
      for (const n of names) writeFileSync(join(fx.root, 'packages', 'core', n), 'x\n');
      const r = fx.version();
      assert.equal(
        r.stderr.trim(),
        [
          'Error: The working tree is not clean:',
          ...names.slice(0, 10).map((n) => `  ?? packages/core/${n}`),
          '  … and 2 more',
          'Commit, stash (git stash -u also stashes untracked files) or remove them, then re-run.',
        ].join('\n'),
      );
    } finally {
      fx.cleanup();
    }
  }
  {
    // CHANGELOG.md modified and not committed: its own closing line
    const fx = buildFixture('rl7d');
    try {
      writeFileSync(
        join(fx.root, 'CHANGELOG.md'),
        '# Changelog\n\n## [0.46.1] — 2026-01-02\n\n## [0.46.0] — 2026-01-01\n\nmore\n',
      );
      const r = fx.version();
      assert.equal(
        r.stderr.trim(),
        [
          'Error: The working tree is not clean:',
          '   M CHANGELOG.md',
          'Commit, stash (git stash -u also stashes untracked files) or remove them, then re-run.',
          'CHANGELOG.md is one of them: commit it rather than stashing or removing it, since the release reads its "## [0.46.0]" section.',
        ].join('\n'),
      );
    } finally {
      fx.cleanup();
    }
  }
  {
    const fx = buildFixture('rl7b');
    try {
      // a src/version.ts that differs from its package.json
      writeFileSync(
        join(fx.root, 'packages', 'core', 'src', 'version.ts'),
        "export const VERSION = '0.44.0';\n",
      );
      fx.git('add', '-A');
      fx.git('commit', '-q', '-m', 'break it');
      const r = fx.version();
      assert.equal(r.status, 1);
      assert.match(r.stderr, /^Error: The release checks failed:/);
      assert.match(
        r.stderr,
        /packages\/core\/src\/version\.ts says 0\.44\.0, but packages\/core\/package\.json says 0\.45\.0\. Set packages\/core\/src\/version\.ts to '0\.45\.0', commit, then re-run\./,
      );
      assert.match(r.stderr, /Fix these, then re-run\.$/m);
    } finally {
      fx.cleanup();
    }
  }
});

// ── RL8 — commit fails (signing with a key that does not exist) ─────────────────────────────

const DIST = (V) =>
  `packages/*/dist may still hold its v${V} build, so run npm run build before using this checkout.`;

test('RL8 — the commit fails (signing with a key that does not exist): exit 1; clean; no journal; a re-run then succeeds', () => {
  const fx = buildFixture('rl8');
  try {
    const failingEnv = {
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'commit.gpgSign',
      GIT_CONFIG_VALUE_0: 'true',
      GIT_CONFIG_KEY_1: 'gpg.format',
      GIT_CONFIG_VALUE_1: 'ssh',
      GIT_CONFIG_KEY_2: 'user.signingkey',
      GIT_CONFIG_VALUE_2: '/nonexistent/key.pub',
    };
    const r = fx.version('0.46.0', failingEnv);
    assertRefusal(
      r,
      `Error: The release of v0.46.0 stopped: the commit failed (exit 128; its message is above). Every tracked file it changed is restored; ${DIST('0.46.0')} Fix the cause, then re-run: npm run release -- --version 0.46.0`,
      { whole: false },
    );
    // git status --porcelain is empty (working tree AND index)
    assert.equal(fx.git('status', '--porcelain'), '');
    assert.equal(existsSync(fx.journalPath), false);

    // re-run then succeeds (without the failing signing config)
    const r2 = fx.version();
    assertSuccess(fx, r2);
    assert.equal(existsSync(fx.journalPath), false);
  } finally {
    fx.cleanup();
  }
});

// ── RL15 / RL16 — --resume edge cases ────────────────────────────────────────────────────────

test('RL15 — --resume with no journal: exit 1 with its text', () => {
  const fx = buildFixture('rl15');
  try {
    const r = fx.resume();
    assertRefusal(r, 'Error: There is no unfinished release to resume.');
  } finally {
    fx.cleanup();
  }
});

test('RL16 — a journal whose state is unknown: refused with the cannot-continue text; nothing changes', () => {
  const fx = buildFixture('rl16');
  try {
    writeJournal(fx, {
      version: '0.99.9',
      devVersion: '0.99.10-dev.0',
      files: ['packages/core/package.json'],
    });
    // an extra commit made after the journal was written, changing the journal's one file — so
    // HEAD no longer matches startSha, and it is not the release commit either (a commit that
    // changed no journal file would be the `moved` state)
    editCoreDescription(fx, 'changed after the journal was written');
    commitAll(fx, 'a commit that changes a file the release sets');

    const before = snapshot(fx);
    const head = fx.short('HEAD');
    const r = fx.resume();
    assertRefusal(
      r,
      `Error: The unfinished v0.99.9 release cannot continue from here: release/test is at ${head} "a commit that changes a file the release sets". It can start again from ${fx.startShort}, where it started: put release/test back there (git reset ${fx.startShort} keeps the current files, with the differences unstaged), then run npm run release -- --resume to put back the files the release changed, and re-run: npm run release -- --version 0.99.9. The reset takes ${head} off release/test; its changes stay in your files, uncommitted.`,
    );
    assertNothingChanged(fx, before);
    assert.equal(existsSync(fx.journalPath), true, 'journal must be left untouched');
  } finally {
    fx.cleanup();
  }
});

// ── RL9 — SIGTERM to the release process during the build ───────────────────────────────────

/** SIGTERM the release while its build sleeps; `buildEnv` is the build's own variables. */
async function interruptDuringBuild(prefix, buildEnv, check) {
  const fx = buildFixture(prefix);
  const marker = join(fx.home, 'build-marker');
  const handle = spawnReleaseDetached(
    fx.root,
    fx.env,
    ['--root', fx.root, '--version', '0.46.0', '--registry-fixture', fx.registry],
    { BUILD_MARKER: marker, BUILD_MS: '4000', ...buildEnv },
  );
  try {
    await waitForFile(marker);
    handle.killPid('SIGTERM');
    const { code } = await handle.waitExit();
    assert.equal(code, 1, `stdout: ${readOut(handle)}\nstderr: ${readErr(handle)}`);
    const err = lines(readErr(handle));
    assert.ok(
      err.includes('Interrupt received (SIGTERM): stopping the current step, then cleaning up.'),
      readErr(handle),
    );
    check(fx, err);
  } finally {
    handle.killGroup('SIGKILL');
    cleanupSignalFiles(handle);
    fx.cleanup();
  }
}

test('RL9 — SIGTERM to the release process during the build: exit 1; restored; clean; no journal', async () => {
  await interruptDuringBuild('rl9', {}, (fx, err) => {
    assert.ok(
      err.includes(
        `Error: The release of v0.46.0 was interrupted (SIGTERM). Every tracked file it changed is restored; ${DIST('0.46.0')} To release, re-run: npm run release -- --version 0.46.0`,
      ),
      err.join('\n'),
    );
    assert.equal(fx.git('status', '--porcelain'), '');
    assert.equal(existsSync(fx.journalPath), false);
  });
  // a file that also holds a change the release did not make is left as it is, and named
  await interruptDuringBuild('rl9b', { BUILD_EDIT: 'edited during the build' }, (fx, err) => {
    assert.ok(
      err.includes(
        `Error: The release of v0.46.0 was interrupted (SIGTERM). Every tracked file it changed is restored, except packages/core/package.json, which also holds a change the release did not make and is left as it is: set the version in it to 0.45.0, and commit or set aside the rest; ${DIST('0.46.0')} To release, re-run: npm run release -- --version 0.46.0`,
      ),
      err.join('\n'),
    );
    assert.equal(fx.gitRaw('status', '--porcelain'), ' M packages/core/package.json\n');
  });
});

// ── RL10 — the tag step fails after the commit (a stuck ref lock); --resume finishes ────────

test('RL10 — the tag step fails (a stale ref lock): exit 1 naming --resume; the journal stays; remove the lock, run --resume: RL1 end state', () => {
  const fx = buildFixture('rl10');
  try {
    const lock = failTagging(fx);
    assert.equal(existsSync(fx.journalPath), true);
    const releaseShort = fx.short('HEAD');
    // the failed run's own text
    const first = fx.version();
    assertRefusal(
      first,
      'Error: An earlier release of v0.46.0 did not finish: the release commit exists, but it is not tagged. Run: npm run release -- --resume',
    );

    // --resume with the lock still there: its only progress line is `→ Tagging v0.46.0`
    const stuck = fx.resume();
    assert.equal(stuck.status, 1);
    assert.deepEqual(
      stuck.stdout.split('\n').filter((l) => l.startsWith('→ ')),
      ['→ Tagging v0.46.0'],
    );
    assert.ok(
      lines(stuck.stderr).includes(
        `Error: The release commit for v0.46.0 exists (${releaseShort}), but it is not tagged: tagging failed (exit 128; its message is above). Fix the cause, then run: npm run release -- --resume`,
      ),
      stuck.stderr,
    );
    assert.equal(existsSync(fx.journalPath), true);
    assert.equal(fx.tryGit('rev-parse', '-q', '--verify', 'refs/tags/v0.46.0'), null);

    // remove the lock, run --resume
    unlinkSync(lock);
    const r2 = fx.resume();
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(
      r2.stdout.split('\n').filter((l) => l.startsWith('→ ')),
      [
        '→ Tagging v0.46.0',
        '→ Setting every package to 0.46.1-dev.0',
        '→ Staging the version files',
        '→ Committing chore: begin development after v0.46.0',
      ],
    );
    assert.deepEqual(stdoutFrom(r2, 'Prepared'), successLines(fx));
    assert.equal(readPkgVersion(fx.root, 'core'), '0.46.1-dev.0');
    assert.equal(fx.git('status', '--porcelain'), '');
    assert.equal(existsSync(fx.journalPath), false);
  } finally {
    fx.cleanup();
  }
});

// ── RL11 — SIGKILL during the build; --resume restores; a re-run reaches RL1's end state ────

test('RL11 — SIGKILL during the build: the journal stays; --version refused naming --resume; --resume restores and says to re-run; the re-run reaches RL1 end state', async () => {
  const fx = buildFixture('rl11');
  try {
    await crashDuringBuild(fx);
    assert.equal(existsSync(fx.journalPath), true, 'the journal must survive an uncatchable crash');

    const versionAttempt = fx.version();
    assertRefusal(
      versionAttempt,
      'Error: An earlier release of v0.46.0 stopped before its release commit, so nothing is committed. Run npm run release -- --resume to restore the files it changed, then re-run npm run release -- --version 0.46.0.',
    );

    // the branch is gone: --resume names where to recreate it
    fx.git('switch', '-c', 'other');
    fx.git('branch', '-D', 'release/test');
    const gone = fx.resume();
    assertRefusal(
      gone,
      `Error: You are on other, but the unfinished v0.46.0 release ran on release/test, which no longer exists. Recreate it at ${fx.startShort} (git switch -c release/test ${fx.startShort}), then re-run: npm run release -- --resume`,
    );
    runPrinted(fx, `git switch -c release/test ${fx.startShort}`);

    const resumeAttempt = fx.resume();
    // nothing was released, so --resume exits 1 and says so on stderr
    assert.equal(resumeAttempt.status, 1, resumeAttempt.stdout);
    assert.equal(resumeAttempt.stdout, '');
    assert.equal(
      resumeAttempt.stderr.trimEnd(),
      `Error: The unfinished v0.46.0 release stopped before its release commit, so --resume cannot finish it. It restored the 9 files the release sets to their content at ${fx.startShort}. packages/*/dist may still hold its v0.46.0 build: run npm run build before using this checkout. Re-run: npm run release -- --version 0.46.0`,
    );
    assert.equal(existsSync(fx.journalPath), false);
    assert.equal(fx.git('status', '--porcelain'), '');

    const reRun = fx.version();
    assert.equal(reRun.status, 0, reRun.stderr);
    assert.equal(readPkgVersion(fx.root, 'core'), '0.46.1-dev.0');
  } finally {
    fx.cleanup();
  }
});

// ── RL12 — the development commit fails (a commit-msg hook rejects it); --resume finishes ───

test('RL12 — the development commit fails (a commit-msg hook rejects it): exit 1 naming --resume; the release commit and tag stand. Remove the hook, run --resume: RL1 end state', () => {
  const fx = buildFixture('rl12');
  try {
    const hookPath = join(fx.root, '.git', 'hooks', 'commit-msg');
    writeFileSync(
      hookPath,
      '#!/bin/sh\nif grep -q "^chore: begin development" "$1"; then echo "refused" >&2; exit 1; fi\nexit 0\n',
    );
    chmodSync(hookPath, 0o755);

    const r = fx.version();
    assert.equal(r.status, 1);
    assert.ok(
      lines(r.stderr).includes(
        'Error: v0.46.0 is committed and tagged, but the development version is not committed: the commit failed (exit 1; its message is above). Fix the cause, then run: npm run release -- --resume',
      ),
      r.stderr,
    );
    // the release commit and tag stand
    assert.equal(fx.git('cat-file', '-t', 'v0.46.0'), 'commit');
    const releaseCommit = fx.git('rev-list', '-n1', 'v0.46.0');
    assert.equal(fx.git('log', '-1', '--format=%s', releaseCommit), 'chore: release v0.46.0');
    assert.equal(existsSync(fx.journalPath), true);
    // right after the failed dev commit, the tagged-state restore must have run — the bumped
    // dev-version edits are gone from both the worktree and the index.
    assert.equal(fx.git('status', '--porcelain'), '');

    // the same state, named by the next `--version` run
    const again = fx.version();
    assertRefusal(
      again,
      'Error: An earlier release of v0.46.0 did not finish: the release is tagged; the development version is not committed. Run: npm run release -- --resume',
    );

    unlinkSync(hookPath);
    // an unrelated staged file must survive the resume's dev commit untouched — proving the
    // commit is scoped by `-- <files>`, never "whatever happens to be staged".
    writeFileSync(join(fx.root, 'unrelated.txt'), 'unrelated\n');
    fx.git('add', 'unrelated.txt');

    const r2 = fx.resume();
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(
      stdoutFrom(r2, 'Prepared'),
      successLines(fx, {
        extra: [
          'This checkout also holds changes that are not committed, in added unrelated.txt: they are not part of v0.46.0. Commit them on release/test if the release PR should carry them.',
        ],
      }),
    );
    assert.equal(readPkgVersion(fx.root, 'core'), '0.46.1-dev.0');
    assert.equal(existsSync(fx.journalPath), false);

    // the development commit names exactly the 9 version files, not the unrelated one
    const devCommit = fx.git('rev-parse', 'HEAD');
    const devCommitFiles = fx
      .git('diff-tree', '--no-commit-id', '--name-only', '-r', devCommit)
      .split('\n')
      .filter(Boolean)
      .sort();
    assert.deepEqual(devCommitFiles, [...FILES].sort());
    // the unrelated file is still staged, untouched by the development commit
    assert.equal(fx.git('status', '--porcelain', '--', 'unrelated.txt'), 'A  unrelated.txt');
  } finally {
    fx.cleanup();
  }
});

// ── RL13 — SIGKILL during the development phase; --resume restores and finishes ─────────────
//
// The commit-msg hook writes MARKER_FILE the first time it sees the "begin development" message,
// then blocks until RELEASE_FILE exists, then exits 1 (so THAT commit attempt fails cleanly). On
// a second invocation (the --resume retry) it sees MARKER_FILE already exists and lets the commit
// through. SIGKILL targets release.mjs's own pid, not the group: its child `git commit` — and the
// hook it is waiting on — are ORPHANED, still holding .git/index.lock, until the test creates
// RELEASE_FILE and the hook (finally) exits.

test('RL13 — SIGKILL during the development phase: the journal says development; --resume restores the phase-2 edits and finishes: RL1 end state', async () => {
  const fx = buildFixture('rl13');
  const marker = join(fx.home, 'hook-marker');
  const releaseFile = join(fx.home, 'hook-release');

  const hookPath = join(fx.root, '.git', 'hooks', 'commit-msg');
  writeFileSync(
    hookPath,
    [
      '#!/bin/sh',
      'if grep -q "^chore: begin development" "$1"; then',
      '  if [ ! -f "$MARKER_FILE" ]; then',
      '    touch "$MARKER_FILE"',
      '    while [ ! -f "$RELEASE_FILE" ]; do sleep 0.02; done',
      '    exit 1',
      '  fi',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
  );
  chmodSync(hookPath, 0o755);

  const handle = spawnReleaseDetached(
    fx.root,
    fx.env,
    ['--root', fx.root, '--version', '0.46.0', '--registry-fixture', fx.registry],
    { MARKER_FILE: marker, RELEASE_FILE: releaseFile },
  );
  try {
    await waitForFile(marker); // the hook is now blocked inside the (still in-flight) dev commit
    handle.killPid('SIGKILL'); // release.mjs dies uncatchably; git commit + its hook are orphaned
    await handle.waitExit();

    const journal = JSON.parse(readFileSync(fx.journalPath, 'utf-8'));
    assert.equal(journal.phase, 'development');

    // unblock the orphaned hook so its `git commit` aborts cleanly and releases index.lock
    writeFileSync(releaseFile, '');
    await waitForFileGone(join(fx.root, '.git', 'index.lock'));

    // the hook fires again on the retried commit; it must see the SAME MARKER_FILE (already
    // created) to recognise this as the retry and let the commit through instead of blocking again.
    const resumeAttempt = fx.resume({ MARKER_FILE: marker, RELEASE_FILE: releaseFile });
    assertSuccess(fx, resumeAttempt);
    assert.equal(readPkgVersion(fx.root, 'core'), '0.46.1-dev.0');
    assert.equal(fx.git('status', '--porcelain'), '');
    assert.equal(existsSync(fx.journalPath), false);
    const log = fx.git('log', '--format=%s', '-3');
    assert.deepEqual(log.split('\n'), [
      'chore: begin development after v0.46.0',
      'chore: release v0.46.0',
      'base',
    ]);
  } finally {
    handle.killGroup('SIGKILL');
    cleanupSignalFiles(handle);
    fx.cleanup();
  }
});

// ── RL14 — SIGINT after the development commit (phase released) ────────────────────────────
//
// A post-commit hook fires AFTER the commit object and ref update already exist. It writes a
// marker and then blocks on RELEASE_FILE. The test sends SIGINT to release.mjs; its own handler
// forwards SIGINT to the (still-running, hook-blocked) `git commit` child, which — having no
// SIGINT handler of its own — dies immediately, orphaning the hook. Because the commit was
// already durably made before the hook ever started, readState() finds `done` regardless of how
// the `git commit` child's own exit looked to release.mjs — the release is intact, exit 0.

test('RL14 — SIGINT after the development commit: exit 0; the release is intact', async () => {
  const fx = buildFixture('rl14');
  const marker = join(fx.home, 'postcommit-marker');
  const releaseFile = join(fx.home, 'postcommit-release');

  const hookPath = join(fx.root, '.git', 'hooks', 'post-commit');
  writeFileSync(
    hookPath,
    [
      '#!/bin/sh',
      'MSG="$(git log -1 --format=%s)"',
      'case "$MSG" in',
      '  "chore: begin development"*)',
      '    touch "$MARKER_FILE"',
      '    while [ ! -f "$RELEASE_FILE" ]; do sleep 0.02; done',
      '    ;;',
      'esac',
      'exit 0',
    ].join('\n') + '\n',
  );
  chmodSync(hookPath, 0o755);

  const handle = spawnReleaseDetached(
    fx.root,
    fx.env,
    ['--root', fx.root, '--version', '0.46.0', '--registry-fixture', fx.registry],
    { MARKER_FILE: marker, RELEASE_FILE: releaseFile },
  );
  try {
    await waitForFile(marker); // the dev commit has landed; the hook is now blocked
    handle.killPid('SIGINT');
    // release the (now-orphaned, if SIGINT killed `git commit` outright) hook so nothing lingers
    writeFileSync(releaseFile, '');
    const { code } = await handle.waitExit();
    assert.equal(code, 0, `stdout: ${readOut(handle)}\nstderr: ${readErr(handle)}`);
    assert.match(
      readOut(handle),
      /^Prepared v0\.46\.0 \(not pushed or published yet\): release commit [0-9a-f]+, tag v0\.46\.0\. Development continues at 0\.46\.1-dev\.0\.$/m,
    );
    assert.equal(existsSync(fx.journalPath), false);
    const log = fx.git('log', '--format=%s', '-3');
    assert.deepEqual(log.split('\n'), [
      'chore: begin development after v0.46.0',
      'chore: release v0.46.0',
      'base',
    ]);
    assert.equal(readPkgVersion(fx.root, 'core'), '0.46.1-dev.0');
  } finally {
    handle.killGroup('SIGKILL');
    cleanupSignalFiles(handle);
    fx.cleanup();
  }
});

// ── RL17-RL21 — entry checks, and --help ─────────────────────────────────────────────────────

test('RL17 — on main: refused with its text', () => {
  const fx = buildFixture('rl17');
  try {
    fx.git('switch', 'main');
    const before = snapshot(fx);
    const r = fx.version();
    assertRefusal(
      r,
      'Error: You are on main. Run the release on its own branch: git switch -c release/v0.46.0, then re-run.',
    );
    assertNothingChanged(fx, before);
    // the branch already exists: the suggestion switches to it
    fx.git('branch', 'release/v0.46.0');
    const r2 = fx.version();
    assertRefusal(
      r2,
      'Error: You are on main. Run the release on its own branch: git switch release/v0.46.0 (it already exists), then re-run.',
    );
    assertNothingChanged(fx, before);
  } finally {
    fx.cleanup();
  }
});

test('RL18 — a detached HEAD: refused with its text', () => {
  const fx = buildFixture('rl18');
  try {
    fx.git('checkout', '-q', '--detach', 'HEAD');
    const before = snapshot(fx);
    const r = fx.version();
    assertRefusal(
      r,
      'Error: You are not on a branch. Run the release on its own branch: git switch -c release/v0.46.0, then re-run.',
    );
    assertNothingChanged(fx, before);
    fx.git('branch', 'release/v0.46.0');
    const r2 = fx.version();
    assertRefusal(
      r2,
      'Error: You are not on a branch. Run the release on its own branch: git switch release/v0.46.0 (it already exists), then re-run.',
    );
    assertNothingChanged(fx, before);
  } finally {
    fx.cleanup();
  }
});

test('RL19 — v0.46.0: refused with the leading-v text', () => {
  const fx = buildFixture('rl19');
  try {
    const before = snapshot(fx);
    const r = fx.version('v0.46.0');
    assertRefusal(
      r,
      'Error: Write the version without the leading v: npm run release -- --version 0.46.0',
    );
    assertNothingChanged(fx, before);
  } finally {
    fx.cleanup();
  }
});

test('RL20 — a committed CHANGELOG.md with no section for the version: refused with its text', () => {
  const sections = [
    // only `## [Unreleased]`
    [
      '# Changelog\n\n## [Unreleased]\n',
      'Error: CHANGELOG.md has no "## [0.46.0]" section. Rename its "## [Unreleased]" heading to "## [0.46.0] — <YYYY-MM-DD>" and commit it (Part B step 2), then re-run.',
    ],
    // a newest section for a version not above the current one (0.45.0)
    [
      '# Changelog\n\n## [0.45.0] — 2026-01-01\n',
      'Error: CHANGELOG.md has no "## [0.46.0]" section and no "## [Unreleased]" heading. Its newest section is "## [0.45.0] — 2026-01-01", for 0.45.0, which is not above the current version 0.45.0: add a "## [0.46.0] — <YYYY-MM-DD>" section above it with this release\'s notes and commit it (Part B step 2), then re-run.',
    ],
    // any other newest section
    [
      '# Changelog\n\n## [0.45.5] — 2026-01-01\n',
      'Error: CHANGELOG.md has no "## [0.46.0]" section and no "## [Unreleased]" heading. Its newest section is "## [0.45.5] — 2026-01-01": if it holds this release\'s notes, rename it to "## [0.46.0] — <YYYY-MM-DD>"; otherwise add that section. Commit it (Part B step 2), then re-run.',
    ],
    // a heading that is no version: never the first text, and never a crash
    [
      '# Changelog\n\n## [next] — draft\n',
      'Error: CHANGELOG.md has no "## [0.46.0]" section and no "## [Unreleased]" heading. Its newest section is "## [next] — draft": if it holds this release\'s notes, rename it to "## [0.46.0] — <YYYY-MM-DD>"; otherwise add that section. Commit it (Part B step 2), then re-run.',
    ],
    // no section at all
    [
      '# Changelog\n',
      'Error: CHANGELOG.md has no "## [0.46.0]" section and no "## [Unreleased]" heading. Add a "## [0.46.0] — <YYYY-MM-DD>" section and commit it (Part B step 2), then re-run.',
    ],
  ];
  for (const [content, expected] of sections) {
    const fx = buildFixture('rl20');
    try {
      writeFileSync(join(fx.root, 'CHANGELOG.md'), content);
      fx.git('add', '-A');
      fx.git('commit', '-q', '-m', 'changelog: the cell');
      const before = snapshot(fx);
      const r = fx.version();
      assertRefusal(r, expected);
      assertNothingChanged(fx, before, JSON.stringify(content));
    } finally {
      fx.cleanup();
    }
  }
});

const HELP_LINES = [
  'Usage: npm run release -- --version <MAJOR.MINOR.PATCH>, or npm run release -- --resume',
  '  --version <V>  Release V: set every package to it, build, commit and tag the release, then commit the next development version. Nothing is pushed or published.',
  '  --resume       Finish a release that stopped after its release commit. For one that stopped before it, restore its files and exit 1, since nothing was released: run --version again.',
];

test('RL21 — --help: exit 0, and stdout is exactly the three help lines; a missing value and no flag are refused', () => {
  const fx = buildFixture('rl21');
  try {
    const r = releaseSync(fx.root, fx.env, ['--root', fx.root, '--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trimEnd(), HELP_LINES.join('\n'));

    const noValue = releaseSync(fx.root, fx.env, ['--root', fx.root, '--version']);
    assertRefusal(
      noValue,
      'Error: --version needs a version: npm run release -- --version <MAJOR.MINOR.PATCH>',
    );
    const noFlag = releaseSync(fx.root, fx.env, ['--root', fx.root]);
    assertRefusal(
      noFlag,
      'Error: Usage: npm run release -- --version <MAJOR.MINOR.PATCH>, or npm run release -- --resume',
    );
  } finally {
    fx.cleanup();
  }
});

// ── RL22-RL30 — where and how a release may continue ─────────────────────────────────────────

const SWITCH_BACK =
  'Switch back to it (git switch release/test), then re-run: npm run release -- --resume';

test('RL22 — --resume from a detached HEAD is refused; switching back finishes', () => {
  const fx = buildFixture('rl22');
  try {
    failDevCommit(fx);
    fx.git('checkout', '-q', '--detach');
    const before = snapshot(fx);
    const r = fx.resume();
    assertRefusal(
      r,
      `Error: HEAD is not on a branch, but the unfinished v0.46.0 release ran on release/test. ${SWITCH_BACK}`,
    );
    assertNothingChanged(fx, before);
    assert.equal(fx.git('log', '--format=%s').includes('chore: begin development'), false);

    fx.git('switch', 'release/test');
    const ok = fx.resume();
    assertSuccess(fx, ok);
    assert.ok(ok.stdout.includes('git push -u origin release/test'));
  } finally {
    fx.cleanup();
  }
});

test('RL23 — --resume on main, moved to the release commit, is refused, as is --version; switching back finishes', () => {
  const fx = buildFixture('rl23');
  try {
    const lock = failTagging(fx);
    unlinkSync(lock);
    fx.git('branch', '-f', 'main', 'HEAD');
    fx.git('switch', 'main');
    const before = snapshot(fx);
    const text = `Error: You are on main, but the unfinished v0.46.0 release ran on release/test. ${SWITCH_BACK}`;
    assertRefusal(fx.resume(), text);
    assert.equal(fx.tryGit('rev-parse', '-q', '--verify', 'refs/tags/v0.46.0'), null);
    assertRefusal(fx.version(), text);
    assertNothingChanged(fx, before);

    fx.git('switch', 'release/test');
    assertSuccess(fx, fx.resume());
  } finally {
    fx.cleanup();
  }
});

test("RL24 — a finished release's journal, with its branch deleted", async () => {
  const fx = buildFixture('rl24');
  try {
    await leaveDoneJournal(fx);
    const dev = fx.short('HEAD');
    assertRefusal(
      fx.version(),
      'Error: An earlier release of v0.46.0 did not finish: every commit exists; only the journal is left. Run: npm run release -- --resume',
    );
    fx.git('switch', '-c', 'other');
    fx.git('branch', '-D', 'release/test');
    assertRefusal(
      fx.resume(),
      `Error: You are on other, but the unfinished v0.46.0 release ran on release/test, which no longer exists. Recreate it at ${dev} (git switch -c release/test ${dev}), then re-run: npm run release -- --resume`,
    );
    fx.git('switch', '-c', 'release/test', dev);
    assertSuccess(fx, fx.resume());
    assert.equal(existsSync(fx.journalPath), false);
    const subjects = fx.git('log', '--format=%s').split('\n');
    assert.equal(subjects.filter((s) => s === 'chore: begin development after v0.46.0').length, 1);
  } finally {
    fx.cleanup();
  }
});

test('RL25 — phase release, a commit after a crash: released when it changes no file the release sets, taken off when it does', async () => {
  const nothingCommittedText = (V = '0.46.0') =>
    `Error: An earlier release of v${V} stopped before its release commit, so nothing is committed. Run npm run release -- --resume to restore the files it changed, then re-run npm run release -- --version ${V}.`;
  const restoredText = (start, tail) =>
    `Error: The unfinished v0.46.0 release stopped before its release commit, so --resume cannot finish it. It restored the 9 files the release sets to their content at ${start}.${tail}`;
  const DIST_RESTORED =
    ' packages/*/dist may still hold its v0.46.0 build: run npm run build before using this checkout.';

  {
    // 1. an empty commit: nothing the release sets changed, so the release can run again from it
    const fx = buildFixture('rl25a');
    try {
      await crashDuringBuild(fx);
      fx.git('commit', '--allow-empty', '-q', '-m', 'an extra commit');
      const extra = fx.short('HEAD');
      const before = snapshot(fx);
      assertRefusal(fx.version(), nothingCommittedText());
      assertNothingChanged(fx, before);
      const r = fx.resume();
      assert.equal(r.status, 1);
      assert.equal(r.stdout, '');
      assert.equal(
        r.stderr.trimEnd(),
        restoredText(
          fx.startShort,
          ` HEAD has moved since the release started, from ${fx.startShort} to ${extra} "an extra commit", which does not change those files.${DIST_RESTORED} Re-run to release ${extra}: npm run release -- --version 0.46.0`,
        ),
      );
      assert.equal(fx.git('status', '--porcelain'), '');
      assert.equal(existsSync(fx.journalPath), false);
      assertSuccess(fx, fx.version());
      assert.equal(fx.git('rev-parse', 'v0.46.0^'), fx.git('rev-parse', 'HEAD~2'));
      assert.equal(fx.git('log', '-1', '--format=%s', 'v0.46.0^'), 'an extra commit');
    } finally {
      fx.cleanup();
    }
  }
  {
    // 2. a commit that takes the release's own changes: taken off the branch
    const fx = buildFixture('rl25b');
    try {
      await crashDuringBuild(fx);
      commitAll(fx, 'an extra commit of every change');
      const extra = fx.short('HEAD');
      const before = snapshot(fx);
      assertRefusal(
        fx.resume(),
        `Error: The unfinished v0.46.0 release cannot continue from here: release/test is at ${extra} "an extra commit of every change". It can start again from ${fx.startShort}, where it started: put release/test back there (git reset ${fx.startShort} keeps the current files, with the differences unstaged), then run npm run release -- --resume to put back the files the release changed, and re-run: npm run release -- --version 0.46.0. The reset takes ${extra} off release/test; its changes stay in your files, uncommitted.`,
      );
      assertNothingChanged(fx, before);
      fx.git('reset', fx.startShort);
      const r = fx.resume();
      assert.equal(r.status, 1);
      assert.equal(
        r.stderr.trimEnd(),
        restoredText(fx.startShort, `${DIST_RESTORED} Re-run: npm run release -- --version 0.46.0`),
      );
      assertSuccess(fx, fx.version());
    } finally {
      fx.cleanup();
    }
  }
  {
    // 3. the branch put back by hand to before the start
    const fx = buildFixture('rl25c');
    try {
      writeFileSync(
        join(fx.root, 'CHANGELOG.md'),
        '# Changelog\n\n## [0.46.1] — 2026-01-02\n\n## [0.46.0] — 2026-01-01\n\na line\n',
      );
      commitAll(fx, 'a second commit');
      const start = fx.short('HEAD');
      const base = fx.short('HEAD~1');
      await crashDuringBuild(fx);
      fx.git('reset', '--keep', 'HEAD~1');
      const before = snapshot(fx);
      assertRefusal(
        fx.resume(),
        `Error: The unfinished v0.46.0 release cannot continue from here: release/test is at ${base} "base", before ${start}, where it started. It can start again from there: move release/test forward to it (git reset --keep ${start} brings its files too, and refuses rather than overwrite a change of yours), then run npm run release -- --resume to put back the files the release changed, and re-run: npm run release -- --version 0.46.0. To abandon the release instead: delete its journal (rm ${fx.journalPath}), then re-run: npm run release -- --version 0.46.0`,
      );
      assertNothingChanged(fx, before);
      fx.git('reset', '--keep', start);
      const r = fx.resume();
      assert.equal(r.status, 1);
      assert.equal(
        r.stderr.trimEnd(),
        restoredText(start, `${DIST_RESTORED} Re-run: npm run release -- --version 0.46.0`),
      );
      assertSuccess(fx, fx.version());
    } finally {
      fx.cleanup();
    }
  }
  {
    // 4. an empty commit, then a change of the releaser's to a file the release sets
    const fx = buildFixture('rl25d');
    try {
      await crashDuringBuild(fx);
      fx.git('commit', '--allow-empty', '-q', '-m', 'an extra commit');
      const extra = fx.short('HEAD');
      editCoreDescription(fx);
      const before = snapshot(fx);
      const refused = fx.resume();
      assert.equal(refused.status, 1);
      assert.equal(
        refused.stderr.trimEnd(),
        [
          'Error: Resuming would overwrite changes the release did not make, in:',
          '  packages/core/package.json',
          'To keep them: set the version in that file to 0.45.0, set them aside (git stash push -- packages/core/package.json), re-run npm run release -- --resume, then npm run release -- --version 0.46.0, and bring them back once that finishes (git stash pop; if that conflicts, keep version 0.46.1-dev.0 and your other changes in that file, then run git restore --staged -- packages/core/package.json and git stash drop).',
          'To drop them: git restore --staged --worktree -- packages/core/package.json, then re-run: npm run release -- --resume',
        ].join('\n'),
      );
      assertNothingChanged(fx, before);
      fx.git('restore', '--staged', '--worktree', '--', 'packages/core/package.json');
      // `--resume` only puts files back: it exits 1, nothing was released (C2.11)
      const r = fx.resume();
      assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.ok(r.stderr.includes(`Re-run to release ${extra}: `), r.stderr);
      assertSuccess(fx, fx.version());
    } finally {
      fx.cleanup();
    }
  }
});

test('RL26 — phase development, an extra commit after the release commit', () => {
  const fx = buildFixture('rl26');
  try {
    failDevCommit(fx);
    const release = fx.short('HEAD');
    writeFileSync(
      join(fx.root, 'CHANGELOG.md'),
      '# Changelog\n\n## [0.46.1] — 2026-01-02\n\n## [0.46.0] — 2026-01-01\n\na typo fixed\n',
    );
    commitAll(fx, 'docs: fix changelog typo');
    const extra = fx.short('HEAD');
    const text = `Error: The unfinished v0.46.0 release cannot continue from here: release/test is at ${extra} "docs: fix changelog typo". It can continue from ${release}, its release commit: put release/test back there (git reset ${release} keeps the current files, with the differences unstaged), then re-run: npm run release -- --resume. The reset takes ${extra} off release/test; its changes stay in your files, uncommitted, and are not part of v0.46.0. To abandon the release instead: Part B step 3, "To abandon an unfinished release": put the branch back at ${fx.startShort} "base", where it started (git reset --keep ${fx.startShort} brings its files too, and refuses rather than overwrite a change of yours), which takes the 1 commit after ${release} off it too (to keep it, run git branch release/test-kept-${extra} ${extra} first: when the release has run again, its text says how to bring it back), then delete its tag (git tag -d v0.46.0), then its journal (rm ${fx.journalPath}), then re-run: npm run release -- --version 0.46.0`;
    const before = snapshot(fx);
    assertRefusal(fx.version(), text);
    assertRefusal(fx.resume(), text);
    assertNothingChanged(fx, before);

    fx.git('reset', release);
    const r = fx.resume();
    assert.deepEqual(
      stdoutFrom(r, 'Prepared'),
      successLines(fx, {
        extra: [
          'This checkout also holds changes that are not committed, in modified CHANGELOG.md: they are not part of v0.46.0. Commit them on release/test if the release PR should carry them.',
        ],
      }),
    );
    assert.equal(r.status, 0);
    assert.equal(fx.gitRaw('status', '--porcelain'), ' M CHANGELOG.md\n');
  } finally {
    fx.cleanup();
  }
});

const MOVED_TAG = (base, release) =>
  `Error: The unfinished v0.46.0 release cannot continue from here: tag v0.46.0 points at ${base}, not at its release commit ${release}. Delete the tag (git tag -d v0.46.0), then re-run npm run release -- --resume: it tags ${release}.`;
const NOT_TAGGED_YET =
  'Error: An earlier release of v0.46.0 did not finish: the release commit exists, but it is not tagged. Run: npm run release -- --resume';

test('RL27 — the release tag deleted, moved or annotated', async () => {
  const taggingFailed = (sha) =>
    `Error: The release commit for v0.46.0 exists (${sha}), but it is not tagged: tagging failed (exit 128; its message is above). Fix the cause, then run: npm run release -- --resume`;
  const progress = (r) => r.stdout.split('\n').filter((l) => l.startsWith('→ '));
  {
    // deleted, before the development commit
    const fx = buildFixture('rl27a');
    try {
      failDevCommit(fx);
      fx.git('tag', '-d', 'v0.46.0');
      assertRefusal(fx.version(), NOT_TAGGED_YET);
      const r = fx.resume();
      assert.equal(progress(r)[0], '→ Tagging v0.46.0');
      assertSuccess(fx, r);
    } finally {
      fx.cleanup();
    }
  }
  {
    // deleted, after the development commit
    const fx = buildFixture('rl27b');
    try {
      await leaveDoneJournal(fx);
      const release = fx.short('HEAD~1');
      fx.git('tag', '-d', 'v0.46.0');
      assertRefusal(
        fx.version(),
        'Error: An earlier release of v0.46.0 did not finish: the development version is committed, but the release is not tagged. Run: npm run release -- --resume',
      );
      const lock = join(fx.root, '.git', 'refs', 'tags', 'v0.46.0.lock');
      mkdirSync(join(fx.root, '.git', 'refs', 'tags'), { recursive: true });
      writeFileSync(lock, '');
      const stuck = fx.resume();
      assertRefusal(stuck, taggingFailed(release), { whole: false });
      assert.equal(existsSync(fx.journalPath), true);
      unlinkSync(lock);
      const r = fx.resume();
      assert.deepEqual(progress(r), ['→ Tagging v0.46.0']);
      assertSuccess(fx, r);
      assert.equal(fx.short('v0.46.0^{commit}'), release);
      assert.equal(existsSync(fx.journalPath), false);
      assert.equal(
        fx
          .git('log', '--format=%s')
          .split('\n')
          .filter((s) => s.startsWith('chore: begin development')).length,
        1,
      );
    } finally {
      fx.cleanup();
    }
  }
  {
    // moved
    const fx = buildFixture('rl27c');
    try {
      failDevCommit(fx);
      const release = fx.short('HEAD');
      fx.git('tag', '-f', '--no-sign', 'v0.46.0', 'base-point');
      assertRefusal(fx.resume(), MOVED_TAG(fx.short('base-point'), release));
      fx.git('tag', '-d', 'v0.46.0');
      assertSuccess(fx, fx.resume());
      assert.equal(fx.short('v0.46.0^{commit}'), release);
    } finally {
      fx.cleanup();
    }
  }
  {
    // moved, in phase release
    const fx = buildFixture('rl27d');
    try {
      const lock = failTagging(fx);
      unlinkSync(lock);
      const release = fx.short('HEAD');
      fx.git('tag', '--no-sign', 'v0.46.0', 'base-point');
      assertRefusal(fx.resume(), MOVED_TAG(fx.short('base-point'), release));
      fx.git('tag', '-d', 'v0.46.0');
      const r = fx.resume();
      assert.equal(progress(r)[0], '→ Tagging v0.46.0');
      assertSuccess(fx, r);
      assert.equal(fx.short('v0.46.0^{commit}'), release);
    } finally {
      fx.cleanup();
    }
  }
  {
    // moved, after the development commit
    const fx = buildFixture('rl27e');
    try {
      await leaveDoneJournal(fx);
      const release = fx.short('HEAD~1');
      fx.git('tag', '-f', '--no-sign', 'v0.46.0', 'base-point');
      assertRefusal(fx.resume(), MOVED_TAG(fx.short('base-point'), release));
      fx.git('tag', '-d', 'v0.46.0');
      const r = fx.resume();
      assert.equal(progress(r)[0], '→ Tagging v0.46.0');
      assertSuccess(fx, r);
      assert.equal(
        fx
          .git('log', '--format=%s')
          .split('\n')
          .filter((s) => s.startsWith('chore: begin development')).length,
        1,
      );
    } finally {
      fx.cleanup();
    }
  }
  {
    // annotated at the release commit
    const fx = buildFixture('rl27f');
    try {
      failDevCommit(fx);
      const release = fx.git('rev-parse', 'HEAD');
      fx.git('tag', '-f', '-a', '-m', 'annotated', '--no-sign', 'v0.46.0', release);
      assertSuccess(fx, fx.resume());
    } finally {
      fx.cleanup();
    }
  }
});

// `--resume`'s refusal of a change the release did not make, built the way every cell that asserts it
// builds it (RL28 first).
const STASH_CONFLICT = (files, each) =>
  `git stash pop; if that conflicts, keep version 0.46.1-dev.0 and your other changes in ${each}, then run git restore --staged -- ${files} and git stash drop`;
const refusalText = (first, files, keep) =>
  [
    first,
    ...files.map((f) => `  ${f}`),
    `To keep them: ${keep}`,
    `To drop them: git restore --staged --worktree -- ${files.join(' ')}, then re-run: npm run release -- --resume`,
  ].join('\n');
const TAGGED_KEEP = (into, files, each) =>
  `${into}set them aside (git stash push -- ${files}), re-run npm run release -- --resume, then bring them back after it finishes (${STASH_CONFLICT(files, each)}).`;
const NOTHING_KEEP = (files, each) =>
  `set the version in ${each} to 0.45.0, set them aside (git stash push -- ${files}), re-run npm run release -- --resume, then npm run release -- --version 0.46.0, and bring them back once that finishes (${STASH_CONFLICT(files, each)}).`;
const OVERWRITE = 'Error: Resuming would overwrite changes the release did not make, in:';

test('RL28 — --resume never overwrites, or commits, a change the release did not make', async () => {
  const corePath = 'packages/core/package.json';

  {
    // `tagged`, kept
    const fx = buildFixture('rl28a');
    try {
      failDevCommit(fx);
      editCoreDescription(fx);
      const before = snapshot(fx);
      const r = fx.resume();
      assert.equal(r.status, 1);
      assert.equal(
        r.stderr.trimEnd(),
        refusalText(OVERWRITE, [corePath], TAGGED_KEEP('', corePath, 'that file')),
      );
      assertNothingChanged(fx, before);
      assert.equal(
        readJson(join(fx.root, corePath)).description,
        'edited while the release was stopped',
      );

      fx.git('stash', 'push', '--', corePath);
      const ok = fx.resume();
      assert.deepEqual(
        stdoutFrom(ok, 'Prepared'),
        successLines(fx, {
          extra: [
            `A stash made on release/test, which holds ${corePath}, is waiting: if it holds changes you set aside for this release, bring them back now (git stash pop; if that conflicts, keep version 0.46.1-dev.0 and your other changes in ${corePath}, then run git restore --staged -- ${corePath} and git stash drop).`,
          ],
        }),
      );
      fx.git('stash', 'pop');
      const pkg = readJson(join(fx.root, corePath));
      assert.equal(pkg.description, 'edited while the release was stopped');
      assert.equal(pkg.version, '0.46.1-dev.0');
    } finally {
      fx.cleanup();
    }
  }
  {
    // `tagged`, staged: the change is only in the index
    const fx = buildFixture('rl28b');
    try {
      failDevCommit(fx);
      editCoreDescription(fx);
      fx.git('add', corePath);
      writeFileSync(join(fx.root, corePath), fx.git('show', `HEAD:${corePath}`) + '\n');
      const before = snapshot(fx);
      const r = fx.resume();
      assert.equal(r.status, 1);
      assert.equal(
        r.stderr.trimEnd(),
        refusalText(
          OVERWRITE,
          [corePath],
          TAGGED_KEEP(
            `put the changes that are only staged into their files (git restore -- ${corePath}), `,
            corePath,
            'that file',
          ),
        ),
      );
      assertNothingChanged(fx, before);
      assert.ok(fx.git('show', `:${corePath}`).includes('edited while the release was stopped'));

      fx.git('restore', '--', corePath);
      fx.git('stash', 'push', '--', corePath);
      const ok = fx.resume();
      assert.equal(ok.status, 0, ok.stderr);
      assert.ok(
        ok.stdout.includes('A stash made on release/test, which holds packages/core/package.json'),
      );
      fx.git('stash', 'pop');
      const pkg = readJson(join(fx.root, corePath));
      assert.equal(pkg.description, 'edited while the release was stopped');
      assert.equal(pkg.version, '0.46.1-dev.0');
    } finally {
      fx.cleanup();
    }
  }
  {
    // `committed-untagged`, dropped
    const fx = buildFixture('rl28c');
    try {
      const lock = failTagging(fx);
      unlinkSync(lock);
      editCoreDescription(fx);
      const before = snapshot(fx);
      const r = fx.resume();
      assert.equal(r.status, 1);
      assert.equal(
        r.stderr.trimEnd(),
        refusalText(
          'Error: Resuming would commit changes the release did not make into the development commit, in:',
          [corePath],
          TAGGED_KEEP('', corePath, 'that file'),
        ),
      );
      assertNothingChanged(fx, before);
      assert.equal(fx.tryGit('rev-parse', '-q', '--verify', 'refs/tags/v0.46.0'), null);
      fx.git('restore', '--staged', '--worktree', '--', corePath);
      assertSuccess(fx, fx.resume());
    } finally {
      fx.cleanup();
    }
  }
  {
    // `nothing-committed`, kept: the edit goes on top of the bumped file
    const fx = buildFixture('rl28d');
    try {
      await crashDuringBuild(fx);
      editCoreDescription(fx);
      const before = snapshot(fx);
      const r = fx.resume();
      assert.equal(r.status, 1);
      assert.equal(
        r.stderr.trimEnd(),
        refusalText(OVERWRITE, [corePath], NOTHING_KEEP(corePath, 'that file')),
      );
      assertNothingChanged(fx, before);
      assert.equal(
        readJson(join(fx.root, corePath)).description,
        'edited while the release was stopped',
      );

      editJson(join(fx.root, corePath), (o) => {
        o.version = '0.45.0';
      });
      fx.git('stash', 'push', '--', corePath);
      const restored = fx.resume();
      assert.equal(restored.status, 1);
      assert.ok(restored.stderr.includes('It restored the 9 files the release sets'));
      const ok = fx.version();
      assert.deepEqual(
        stdoutFrom(ok, 'Prepared'),
        successLines(fx, {
          extra: [
            `A stash made on release/test, which holds ${corePath}, is waiting: if it holds changes you set aside for this release, bring them back now (git stash pop; if that conflicts, keep version 0.46.1-dev.0 and your other changes in ${corePath}, then run git restore --staged -- ${corePath} and git stash drop).`,
          ],
        }),
      );
      fx.git('stash', 'pop');
      const pkg = readJson(join(fx.root, corePath));
      assert.equal(pkg.description, 'edited while the release was stopped');
      assert.equal(pkg.version, '0.46.1-dev.0');
    } finally {
      fx.cleanup();
    }
  }
  {
    // `tagged`, two files, dropped
    const fx = buildFixture('rl28e');
    try {
      failDevCommit(fx);
      const cliPath = 'packages/cli/package.json';
      editCoreDescription(fx);
      editJson(join(fx.root, cliPath), (o) => {
        o.description = 'edited while the release was stopped';
      });
      const both = `${cliPath} ${corePath}`;
      const r = fx.resume();
      assert.equal(r.status, 1);
      assert.equal(
        r.stderr.trimEnd(),
        refusalText(OVERWRITE, [cliPath, corePath], TAGGED_KEEP('', both, 'each file')),
      );
      runPrinted(fx, between(r.stderr, 'To drop them: ', ', then re-run'));
      assertSuccess(fx, fx.resume());
      for (const p of [cliPath, corePath]) {
        assert.equal(readJson(join(fx.root, p)).description, undefined);
      }
    } finally {
      fx.cleanup();
    }
  }
});

function journalRefusal(fx, reason, { headSubject = 'base', word = fx.journalPath } = {}) {
  return `Error: The release journal ${fx.journalPath} ${reason}. HEAD is ${fx.short('HEAD')} "${headSubject}": finish the release by hand (Part B step 3, "To finish an unfinished release by hand") or abandon it (Part B step 3, "To abandon an unfinished release"); either one deletes the journal (rm ${word}).`;
}
function nothingLeftText(fx, reason, word = fx.journalPath) {
  return `Error: The release journal ${fx.journalPath} no longer matches this repository: ${reason}. HEAD is ${fx.short('HEAD')}, where that release started, tag v0.46.0 does not exist, and the files it sets are unchanged, so nothing of it is left here: delete the journal (rm ${word}), then re-run: npm run release -- --version 0.46.0`;
}

test('RL29 — a journal that cannot be read, or no longer matches the repository, is refused, naming what is left of the release', () => {
  const GONE = '1234567890123456789012345678901234567890';
  {
    const fx = buildFixture('rl29a');
    try {
      const refuse = (reason) => {
        const before = snapshot(fx);
        assertRefusal(fx.resume(), journalRefusal(fx, `cannot be read: ${reason}`));
        assertNothingChanged(fx, before, reason);
      };
      // an empty file, through `--version` too
      writeFileSync(fx.journalPath, '');
      refuse('it is empty');
      assertRefusal(fx.version(), journalRefusal(fx, 'cannot be read: it is empty'));
      writeFileSync(fx.journalPath, '{');
      refuse('it is not valid JSON');
      writeFileSync(fx.journalPath, '[]\n');
      refuse('it is not a JSON object');
      // one leg per rule of the journal's fields
      const invalid = [
        ['version', { version: 'v0.46.0' }],
        ['devVersion', { devVersion: '' }],
        ['phase', { phase: 'done' }],
        ['startSha', { startSha: 'abc' }],
        ['releaseSha', { releaseSha: 'abc' }],
        ['releaseSha', { phase: 'development', releaseSha: null }],
        ['files', { files: [] }],
        ['branch', { branch: 'main' }],
      ];
      for (const [field, overrides] of invalid) {
        writeJournal(fx, overrides);
        refuse(`its ${field} field is missing or not valid`);
      }
      // commit legs
      for (const startSha of [GONE, fx.git('rev-parse', 'HEAD:CHANGELOG.md')]) {
        writeJournal(fx, { startSha });
        const before = snapshot(fx);
        assertRefusal(
          fx.resume(),
          journalRefusal(
            fx,
            'no longer matches this repository: the commit it records as the start of the release is not in this repository',
          ),
        );
        assertNothingChanged(fx, before);
      }
      // nothing of the release is left: HEAD is the start, no tag, the files are unchanged
      writeJournal(fx, { phase: 'development', releaseSha: GONE });
      {
        const before = snapshot(fx);
        assertRefusal(
          fx.resume(),
          nothingLeftText(fx, 'the release commit of v0.46.0 it records is not in this repository'),
        );
        assertNothingChanged(fx, before);
      }
      writeJournal(fx, { phase: 'development', releaseSha: fx.git('rev-parse', 'HEAD') });
      {
        const before = snapshot(fx);
        assertRefusal(
          fx.resume(),
          nothingLeftText(
            fx,
            `the commit it records as the release commit of v0.46.0 (${fx.short('HEAD')}) is not that commit`,
          ),
        );
        assertNothingChanged(fx, before);
      }
    } finally {
      fx.cleanup();
    }
  }
  {
    // a checkout whose path holds a space: the printed rm names the journal in quotes and works
    const fx = buildFixture('rl29 space');
    try {
      const quoted = `'${fx.journalPath}'`;
      writeFileSync(fx.journalPath, '');
      const r = fx.resume();
      assertRefusal(r, journalRefusal(fx, 'cannot be read: it is empty', { word: quoted }));
      writeJournal(fx, { phase: 'development', releaseSha: GONE });
      const r2 = fx.resume();
      assertRefusal(
        r2,
        nothingLeftText(
          fx,
          'the release commit of v0.46.0 it records is not in this repository',
          quoted,
        ),
      );
      runPrinted(fx, `rm ${between(r2.stderr, '(rm ', '), then re-run')}`);
      // `rm <quoted path>` removes the journal
      assert.equal(existsSync(fx.journalPath), false);
    } finally {
      fx.cleanup();
    }
  }
  {
    // the three facts the nothing-left text rests on, each false in turn
    const fx = buildFixture('rl29c');
    try {
      const gone = () => writeJournal(fx, { phase: 'development', releaseSha: GONE });
      const reason = 'the release commit of v0.46.0 it records is not in this repository';
      const byHand = (subject = 'base') =>
        journalRefusal(fx, `no longer matches this repository: ${reason}`, {
          headSubject: subject,
        });
      gone();
      fx.git('tag', '--no-sign', 'v0.46.0');
      assertRefusal(fx.resume(), byHand());
      fx.git('tag', '-d', 'v0.46.0');
      fx.git('tag', '--no-sign', 'v0.46.0', 'HEAD^{tree}');
      assertRefusal(fx.resume(), byHand());
      fx.git('tag', '-d', 'v0.46.0');
      editCoreDescription(fx);
      assertRefusal(fx.resume(), byHand());
      fx.git('restore', '--staged', '--worktree', '--', 'packages/core/package.json');
      fx.git('commit', '--allow-empty', '-q', '-m', 'a commit after the start');
      assertRefusal(fx.resume(), byHand('a commit after the start'));
      // back at the start: the nothing-left text again; do as it says
      fx.git('reset', '--hard', fx.start);
      assertRefusal(fx.resume(), nothingLeftText(fx, reason));
      unlinkSync(fx.journalPath);
      assertSuccess(fx, fx.version());
    } finally {
      fx.cleanup();
    }
  }
});

test("RL30 — a failed restore shows git's message, and the journal stays", () => {
  const fx = buildFixture('rl30');
  try {
    writeJournal(fx);
    const lock = join(fx.root, '.git', 'index.lock');
    writeFileSync(lock, '');
    const r = fx.resume();
    assert.equal(r.status, 1);
    const err = lines(r.stderr);
    const fatal = err.findIndex((l) => l.startsWith('fatal: Unable to create'));
    assert.notEqual(fatal, -1, r.stderr);
    assert.equal(
      err[err.length - 1],
      "Error: Restoring the files failed (git's message is above). Fix the cause, then run: npm run release -- --resume",
    );
    assert.ok(fatal < err.length - 1);
    assert.equal(existsSync(fx.journalPath), true);

    unlinkSync(lock);
    const ok = fx.resume();
    assert.equal(ok.status, 1);
    assert.equal(
      ok.stderr.trimEnd(),
      `Error: The unfinished v0.46.0 release stopped before its release commit, so --resume cannot finish it. It restored the 9 files the release sets to their content at ${fx.startShort}. packages/*/dist may still hold its v0.46.0 build: run npm run build before using this checkout. Re-run: npm run release -- --version 0.46.0`,
    );
  } finally {
    fx.cleanup();
  }
});

// ── RL31-RL43 — a step fails, is stopped, or finds a change the release did not make ─────────

const progressLines = (r) => r.stdout.split('\n').filter((l) => l.startsWith('→ '));
const STOPPED = (reason) =>
  `Error: The release of v0.46.0 stopped: ${reason}. Every tracked file it changed is restored; ${DIST('0.46.0')} Fix the cause, then re-run: npm run release -- --version 0.46.0`;
const EXCEPT_CORE =
  'Every tracked file it changed is restored, except packages/core/package.json, which also holds a change the release did not make and is left as it is: set the version in it to 0.45.0, and commit or set aside the rest;';
const STOPPED_EXCEPT_CORE = (reason) =>
  `Error: The release of v0.46.0 stopped: ${reason}. ${EXCEPT_CORE} ${DIST('0.46.0')} Fix the cause, then re-run: npm run release -- --version 0.46.0`;
const LOCK_NOTICE =
  'package-lock.json held changes the release did not make; it is restored, so they are gone. If they came from npm install, run it again after the release.';
const CHANGED_CORE = 'packages/core/package.json changed while the release ran';

function assertNoRelease(fx) {
  assert.equal(fx.tryGit('rev-parse', '-q', '--verify', 'refs/tags/v0.46.0'), null);
  assert.equal(fx.git('log', '--format=%s').includes('chore: release'), false);
  assert.equal(existsSync(fx.journalPath), false);
}

test("RL31 — a step's command cannot start", () => {
  const fx = buildFixture('rl31');
  try {
    const path = makeShimDir(fx, 'bare');
    const r = fx.version('0.46.0', { PATH: path });
    assertRefusal(r, STOPPED('the build could not start (spawn npm ENOENT)'), { whole: false });
    assert.equal(fx.git('status', '--porcelain'), '');
    assert.equal(existsSync(fx.journalPath), false);
  } finally {
    fx.cleanup();
  }
});

test('RL32 — the build fails', () => {
  const fx = buildFixture('rl32');
  try {
    const r = fx.version('0.46.0', { BUILD_FAIL: '3' });
    assertRefusal(r, STOPPED('the build failed (exit 3; its message is above)'), { whole: false });
    assert.equal(fx.git('status', '--porcelain'), '');
    assert.equal(existsSync(fx.journalPath), false);
  } finally {
    fx.cleanup();
  }
});

test('RL33 — staging fails', () => {
  {
    const fx = buildFixture('rl33a');
    try {
      const path = makeShimDir(fx, 'wrappers');
      const r = fx.version('0.46.0', { PATH: path, FAIL_GIT_ADD: 'release' });
      assertRefusal(
        r,
        STOPPED('staging the version files failed (exit 128; its message is above)'),
        {
          whole: false,
        },
      );
      assert.equal(fx.git('status', '--porcelain'), '');
      assert.equal(existsSync(fx.journalPath), false);
    } finally {
      fx.cleanup();
    }
  }
  {
    const fx = buildFixture('rl33b');
    try {
      const path = makeShimDir(fx, 'wrappers');
      const r = fx.version('0.46.0', { PATH: path, FAIL_GIT_ADD: 'development' });
      assertRefusal(
        r,
        'Error: v0.46.0 is committed and tagged, but the development version is not committed: staging the version files failed (exit 128; its message is above). Fix the cause, then run: npm run release -- --resume',
        { whole: false },
      );
      assertSuccess(fx, fx.resume());
    } finally {
      fx.cleanup();
    }
  }
});

// RL34 — removed: phase 2 runs no npm command; RL33's development leg pins the phase-2 failure form.

test('RL35 — a step is stopped by a signal the release itself never received', () => {
  const fx = buildFixture('rl35');
  try {
    const path = makeShimDir(fx, 'wrappers');
    const r = fx.version('0.46.0', { PATH: path, KILL_NPM_RUN: 'release' });
    assertRefusal(r, STOPPED('the build was stopped by SIGTERM'), { whole: false });
    assert.equal(fx.git('status', '--porcelain'), '');
    assert.equal(existsSync(fx.journalPath), false);
  } finally {
    fx.cleanup();
  }
});

/** SIGINT the release while a hook blocks inside the step it is in; returns the stderr lines. */
async function interruptInHook(fx, hookName, hookBody, { afterExit }) {
  const marker = join(fx.home, `${hookName}-marker`);
  const releaseFile = join(fx.home, `${hookName}-release`);
  const hookPath = join(fx.root, '.git', 'hooks', hookName);
  writeFileSync(hookPath, hookBody);
  chmodSync(hookPath, 0o755);
  const handle = spawnReleaseDetached(
    fx.root,
    fx.env,
    ['--root', fx.root, '--version', '0.46.0', '--registry-fixture', fx.registry],
    { MARKER_FILE: marker, RELEASE_FILE: releaseFile },
  );
  try {
    await waitForFile(marker);
    handle.killPid('SIGINT');
    const { code } = await handle.waitExit();
    const err = lines(readErr(handle));
    writeFileSync(releaseFile, ''); // release the hook
    await afterExit();
    return { code, err, out: readOut(handle) };
  } finally {
    handle.killGroup('SIGKILL');
    cleanupSignalFiles(handle);
    unlinkSync(hookPath);
  }
}

test('RL36 — interrupted while tagging', async () => {
  const fx = buildFixture('rl36');
  try {
    const hook = [
      '#!/bin/sh',
      'if [ "$1" = prepared ]; then',
      '  while read old new ref; do',
      '    case "$ref" in',
      '      refs/tags/v*)',
      '        touch "$MARKER_FILE"',
      '        while [ ! -f "$RELEASE_FILE" ]; do sleep 0.02; done',
      '        ;;',
      '    esac',
      '  done',
      'fi',
      'exit 0',
    ].join('\n');
    const { code, err } = await interruptInHook(fx, 'reference-transaction', hook + '\n', {
      afterExit: async () => {
        await waitForFileGone(join(fx.root, '.git', 'refs', 'tags', 'v0.46.0.lock'));
      },
    });
    assert.equal(code, 1, err.join('\n'));
    assert.ok(
      err.includes('Interrupt received (SIGINT): stopping the current step, then cleaning up.'),
    );
    assert.ok(
      err.includes(
        `Error: The release commit for v0.46.0 exists (${fx.short('HEAD')}), but it is not tagged: the release was interrupted (SIGINT). Run: npm run release -- --resume`,
      ),
      err.join('\n'),
    );
    assert.equal(fx.tryGit('rev-parse', '-q', '--verify', 'refs/tags/v0.46.0'), null);

    const r = fx.resume();
    assert.equal(progressLines(r)[0], '→ Tagging v0.46.0');
    assertSuccess(fx, r);
  } finally {
    fx.cleanup();
  }
});

test('RL37 — interrupted during the development commit', async () => {
  const fx = buildFixture('rl37');
  try {
    const hook = [
      '#!/bin/sh',
      'if grep -q "^chore: begin development" "$1"; then',
      '  touch "$MARKER_FILE"',
      '  while [ ! -f "$RELEASE_FILE" ]; do sleep 0.02; done',
      '  exit 1',
      'fi',
      'exit 0',
    ].join('\n');
    const { code, err } = await interruptInHook(fx, 'commit-msg', hook + '\n', {
      afterExit: async () => {
        await waitForFileGone(join(fx.root, '.git', 'index.lock'));
      },
    });
    assert.equal(code, 1, err.join('\n'));
    assert.ok(
      err.includes('Interrupt received (SIGINT): stopping the current step, then cleaning up.'),
    );
    assert.ok(
      err.includes(
        'Error: v0.46.0 is committed and tagged, but the development version is not committed: the release was interrupted (SIGINT). Run: npm run release -- --resume',
      ),
      err.join('\n'),
    );
    assertSuccess(fx, fx.resume());
  } finally {
    fx.cleanup();
  }
});

test('RL38 — the catch-all names the file', () => {
  const fx = buildFixture('rl38');
  try {
    writeJournal(fx);
    writeFileSync(join(fx.root, 'packages', 'engine-tests', 'package.json'), '{ "name": ');
    const r = fx.resume();
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /^Error: The release script failed unexpectedly: packages\/engine-tests\/package\.json is not valid JSON \(.+\)$/m,
    );
  } finally {
    fx.cleanup();
  }
});

test('RL38b — entry check 8a names a manifest that does not parse', () => {
  const fx = buildFixture('rl38b');
  try {
    writeFileSync(join(fx.root, 'package.json'), '{ "name": ');
    commitAll(fx, 'a broken root package.json');
    const before = snapshot(fx);
    const r = fx.version();
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /^Error: The release script failed unexpectedly: package\.json is not valid JSON \(.+\)$/m,
    );
    assertNothingChanged(fx, before);
  } finally {
    fx.cleanup();
  }
});

test('RL39 — a failed release leaves a file it did not only change as it is', () => {
  const fx = buildFixture('rl39');
  try {
    const r = fx.version('0.46.0', { BUILD_EDIT: 'edited during the build', BUILD_FAIL: '3' });
    assertRefusal(r, STOPPED_EXCEPT_CORE('the build failed (exit 3; its message is above)'), {
      whole: false,
    });
    const pkg = readJson(join(fx.root, 'packages', 'core', 'package.json'));
    assert.equal(pkg.description, 'edited during the build');
    assert.equal(pkg.version, '0.46.0');
    assert.equal(fx.gitRaw('status', '--porcelain'), ' M packages/core/package.json\n');
    assert.equal(existsSync(fx.journalPath), false);

    // do as it says: set the version back, set the change aside, run the release again
    editJson(join(fx.root, 'packages', 'core', 'package.json'), (o) => {
      o.version = '0.45.0';
    });
    assert.equal(
      fx.git('diff', '--stat', '--', 'packages/core/package.json').includes('1 file'),
      true,
    );
    fx.git('stash', 'push', '--', 'packages/core/package.json');
    const ok = fx.version();
    assert.deepEqual(
      stdoutFrom(ok, 'Prepared'),
      successLines(fx, {
        extra: [
          'A stash made on release/test, which holds packages/core/package.json, is waiting: if it holds changes you set aside for this release, bring them back now (git stash pop; if that conflicts, keep version 0.46.1-dev.0 and your other changes in packages/core/package.json, then run git restore --staged -- packages/core/package.json and git stash drop).',
        ],
      }),
    );
    fx.git('stash', 'pop');
    assert.equal(
      readJson(join(fx.root, 'packages', 'core', 'package.json')).description,
      'edited during the build',
    );
  } finally {
    fx.cleanup();
  }
});

test('RL40 — nothing reaches the release commit that the release did not write', () => {
  {
    const fx = buildFixture('rl40a');
    try {
      const r = fx.version('0.46.0', { BUILD_EDIT: 'edited during the build' });
      assertRefusal(r, STOPPED_EXCEPT_CORE(CHANGED_CORE), { whole: false });
      assert.equal(progressLines(r).at(-1), '→ Staging the version files');
      assertNoRelease(fx);
      assert.equal(
        readJson(join(fx.root, 'packages', 'core', 'package.json')).description,
        'edited during the build',
      );
    } finally {
      fx.cleanup();
    }
  }
  {
    const fx = buildFixture('rl40b');
    try {
      const r = fx.version('0.46.0', {
        BUILD_EDIT: 'edited during the build',
        BUILD_EDIT_CLI: 'edited during the build',
      });
      assertRefusal(
        r,
        `Error: The release of v0.46.0 stopped: packages/cli/package.json, packages/core/package.json changed while the release ran. Every tracked file it changed is restored, except packages/cli/package.json, packages/core/package.json, which also hold changes the release did not make and are left as they are: set the version in each to 0.45.0, and commit or set aside the rest; ${DIST('0.46.0')} Fix the cause, then re-run: npm run release -- --version 0.46.0`,
        { whole: false },
      );
      for (const dir of ['cli', 'core']) {
        assert.equal(
          readJson(join(fx.root, 'packages', dir, 'package.json')).description,
          'edited during the build',
        );
      }
      assertNoRelease(fx);
    } finally {
      fx.cleanup();
    }
  }
});

test('RL41 — nor, through the lockfile, a change to a file the release does not set', () => {
  const lockHasNoDeps = (fx, rev) =>
    JSON.parse(fx.git('show', `${rev}:package-lock.json`)).packages['packages/engine-tests']
      .dependencies === undefined;
  {
    const fx = buildFixture('rl41a');
    try {
      const r = fx.version('0.46.0', { BUILD_EDIT_OTHER: '1' });
      assert.deepEqual(
        stdoutFrom(r, 'Prepared'),
        successLines(fx, {
          extra: [
            'This checkout also holds changes that are not committed, in modified packages/engine-tests/package.json: they are not part of v0.46.0. Commit them on release/test if the release PR should carry them.',
          ],
        }),
      );
      assert.equal(lockHasNoDeps(fx, 'v0.46.0'), true);
      assert.equal(lockHasNoDeps(fx, 'HEAD'), true);
      assert.equal(fx.gitRaw('status', '--porcelain'), ' M packages/engine-tests/package.json\n');
    } finally {
      fx.cleanup();
    }
  }
  {
    const fx = buildFixture('rl41b');
    try {
      failDevCommit(fx);
      editJson(join(fx.root, 'packages', 'engine-tests', 'package.json'), (o) => {
        o.dependencies = { '@q/core': '*' };
      });
      writeFileSync(join(fx.root, '.npmrc'), 'lockfile-version=2\n');
      const r = fx.resume();
      assert.deepEqual(
        stdoutFrom(r, 'Prepared'),
        successLines(fx, {
          extra: [
            'This checkout also holds changes that are not committed, in modified packages/engine-tests/package.json, untracked .npmrc: they are not part of v0.46.0. Commit them on release/test if the release PR should carry them.',
          ],
        }),
      );
      assert.equal(JSON.parse(fx.git('show', 'HEAD:package-lock.json')).lockfileVersion, 3);
      assert.equal(lockHasNoDeps(fx, 'HEAD'), true);
      assert.equal(
        fx.gitRaw('status', '--porcelain'),
        ' M packages/engine-tests/package.json\n?? .npmrc\n',
      );
    } finally {
      fx.cleanup();
    }
  }
});

test('RL42 — nor a change that is only staged', () => {
  const fx = buildFixture('rl42');
  try {
    const r = fx.version('0.46.0', { BUILD_STAGE_EDIT: 'staged during the build' });
    assertRefusal(r, STOPPED_EXCEPT_CORE(CHANGED_CORE), { whole: false });
    assert.ok(fx.git('show', ':packages/core/package.json').includes('staged during the build'));
    assertNoRelease(fx);
  } finally {
    fx.cleanup();
  }
});

test('RL43 — nor a change to the lockfile', () => {
  const fx = buildFixture('rl43');
  try {
    const r = fx.version('0.46.0', { BUILD_LOCK_EDIT: '1' });
    assert.equal(r.status, 1);
    const err = lines(r.stderr);
    const notice = err.indexOf(LOCK_NOTICE);
    assert.notEqual(notice, -1, r.stderr);
    assert.equal(
      err[notice + 1],
      STOPPED('package-lock.json changed while the release ran'),
      r.stderr,
    );
    assertNoRelease(fx);
    assert.equal(fx.git('status', '--porcelain'), '');
  } finally {
    fx.cleanup();
  }
});

// ── RL44-RL47 — the files the release sets the versions in ───────────────────────────────────

const NPM_LOCK = 'npm install --package-lock-only --ignore-scripts --lockfile-version=3';
const COMMIT_LOCK =
  "git add package-lock.json && git commit -m 'chore: write package-lock.json with npm' -- package-lock.json";
const LOCK = 'package-lock.json';
const lockPath = (fx) => join(fx.root, LOCK);
const lockText = (lock, indent = 2) => JSON.stringify(lock, null, indent) + '\n';

/** Commit everything the leg changed (a new file included), signing off. */
function commitLeg(fx, message = 'the leg') {
  fx.git('add', '-A');
  fx.git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
}
const lockRestoreText = (reason, short) =>
  `Error: The release cannot set the versions in ${LOCK}: ${reason}. Restore it from ${short}, the last commit that wrote a package-lock.json npm can start from (git checkout ${short} -- ${LOCK}), then bring it up to date with npm (${NPM_LOCK}), commit it (${COMMIT_LOCK}), then re-run.`;
const lockNpmText = (reason) =>
  `Error: The release cannot set the versions in ${LOCK}: ${reason}. Write it with npm (${NPM_LOCK}), commit it (${COMMIT_LOCK}), then re-run.`;
const lockNoCommitText = (reason) =>
  `Error: The release cannot set the versions in ${LOCK}: ${reason}. No commit holds a package-lock.json npm can start from: write a new one with npm (rm -f ${LOCK} && ${NPM_LOCK}), commit it (${COMMIT_LOCK}), then re-run.`;
const dependencyText = (manifest, name, spec) =>
  `Error: ${manifest} depends on ${name} as ${spec}. The release sets versions without npm, and npm keeps using the repository's own copy of a package it releases only while every dependency on it is "*": set it to "*", write the lockfile with npm (${NPM_LOCK}), commit both (git commit -m 'chore: depend on ${name} as "*"' -- ${manifest} ${LOCK}), then re-run.`;
const linkText = (f) =>
  `Error: ${f} is a symbolic link, and the release writes the files it sets only as regular files. Replace the link with a regular file holding its content (cat ${f} > ${f}.tmp && mv ${f}.tmp ${f}), commit it (git commit -m 'chore: replace the link ${f} with its content' -- ${f}), then re-run.`;
const crlfCommitText = (f) =>
  `Error: ${f} has CRLF line ends in the commit you are releasing, and the release writes LF. Convert it to LF (tr -d '\\r' < ${f} > ${f}.lf && mv ${f}.lf ${f}), commit it (git commit -m 'chore: convert ${f} to LF line ends' -- ${f}), then re-run.`;
const crlfCheckoutText = (f) =>
  `Error: ${f} has CRLF line ends, and the release writes LF. Make a checkout with LF line ends (git config core.autocrlf false, then git rm -r -q --cached . && git reset -q --hard), then re-run.`;

test('RL44 — files the release cannot set the versions in are refused at entry', () => {
  const legs = [
    // 1
    {
      change: (fx) => fx.git('rm', '-q', LOCK),
      expected: (fx) => lockRestoreText('it does not exist', fx.short('HEAD~1')),
    },
    // 2
    {
      change: (fx) => writeFileSync(lockPath(fx), '[]\n'),
      expected: (fx) => lockRestoreText('it is not a JSON object', fx.short('HEAD~1')),
    },
    // 3
    {
      change: (fx) => writeFileSync(lockPath(fx), '{\n'),
      expected: (fx) => lockRestoreText('it is not valid JSON', fx.short('HEAD~1')),
    },
    // 4
    {
      change: (fx) => {
        const lock = readJson(lockPath(fx));
        lock.lockfileVersion = 2;
        writeFileSync(lockPath(fx), lockText(lock));
      },
      expected: () => lockNpmText('it is not lockfileVersion 3'),
    },
    // 5
    {
      change: (fx) => writeFileSync(lockPath(fx), lockText(readJson(lockPath(fx)), 4)),
      expected: () =>
        lockNpmText(
          "it is not in the form the release writes (JSON indented by two spaces, ending in one newline); npm writes it with the root package.json's indentation",
        ),
    },
    // 6
    {
      change: (fx) => {
        const lock = readJson(lockPath(fx));
        delete lock.packages['packages/testing'];
        writeFileSync(lockPath(fx), lockText(lock));
      },
      expected: (fx) => lockRestoreText('it has no entry for packages/testing', fx.short('HEAD~1')),
    },
    // 7
    {
      change: (fx) => {
        const lock = readJson(lockPath(fx));
        lock.packages['packages/core'].version = '0.44.0';
        writeFileSync(lockPath(fx), lockText(lock));
      },
      expected: () =>
        lockNpmText(
          'its entry for packages/core does not record version 0.45.0, the version in packages/core/package.json',
        ),
    },
    // 8
    {
      change: (fx) =>
        editJson(join(fx.root, 'packages', 'cli', 'package.json'), (o) => {
          o.dependencies['@q/core'] = '^0.45.0';
        }),
      expected: () => dependencyText('packages/cli/package.json', '@q/core', '"^0.45.0"'),
    },
    // 9
    {
      change: (fx) =>
        editJson(join(fx.root, 'package.json'), (o) => {
          o.devDependencies = { '@q/testing': '^0.45.0' };
        }),
      expected: () => dependencyText('package.json', '@q/testing', '"^0.45.0"'),
    },
    // 10: @q/engine-tests is not released, so the walk reaches @q/core one level down
    {
      change: (fx) => {
        editJson(join(fx.root, 'packages', 'engine-tests', 'package.json'), (o) => {
          o.dependencies = { '@q/core': '*' };
        });
        editJson(join(fx.root, 'package.json'), (o) => {
          o.overrides = { '@q/engine-tests': { '@q/core': '0.45.0' } };
        });
      },
      expected: () =>
        `Error: The overrides in package.json name @q/core. The release sets versions without npm, and package-lock.json does not record overrides, so the release cannot tell how npm would resolve @q/core after the version changes: remove that override, write the lockfile with npm (${NPM_LOCK}), commit both (git commit -m 'chore: remove the override of @q/core' -- package.json package-lock.json), then re-run.`,
    },
    // 11
    {
      change: (fx) => copyFileSync(lockPath(fx), join(fx.root, 'npm-shrinkwrap.json')),
      expected: () =>
        "Error: npm-shrinkwrap.json exists: npm reads it instead of package-lock.json, and the release sets versions only in package-lock.json. Remove it (git rm npm-shrinkwrap.json && git commit -m 'chore: remove npm-shrinkwrap.json'), then re-run.",
    },
    // 12
    {
      change: (fx) =>
        editJson(join(fx.root, 'packages', 'testing', 'package.json'), (o) => {
          o.peerDependencies = { '@q/core': '^0.45.0' };
        }),
      expected: () => dependencyText('packages/testing/package.json', '@q/core', '"^0.45.0"'),
    },
    // 13: a lockfile entry with no directory is skipped, not read
    {
      change: (fx) => {
        const lock = readJson(lockPath(fx));
        const packages = {};
        for (const [key, value] of Object.entries(lock.packages)) {
          if (key === 'packages/cli') packages['packages/aa-gone'] = { version: '0.0.0' };
          packages[key] = value;
        }
        lock.packages = packages;
        writeFileSync(lockPath(fx), lockText(lock));
        editJson(join(fx.root, 'packages', 'cli', 'package.json'), (o) => {
          o.dependencies['@q/core'] = '^0.45.0';
        });
      },
      expected: () => dependencyText('packages/cli/package.json', '@q/core', '"^0.45.0"'),
    },
    // 14: CRLF line ends committed in a version file
    {
      change: (fx) => {
        const p = join(fx.root, 'packages', 'core', 'src', 'version.ts');
        writeFileSync(p, readFileSync(p, 'utf-8').replaceAll('\n', '\r\n'));
      },
      commit: (fx) => {
        fx.git('add', '-A');
        fx.git(
          '-c',
          'core.autocrlf=false',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-q',
          '-m',
          'crlf',
        );
      },
      expected: () => crlfCommitText('packages/core/src/version.ts'),
    },
    // 15: the same for the lockfile
    {
      change: (fx) =>
        writeFileSync(lockPath(fx), readFileSync(lockPath(fx), 'utf-8').replaceAll('\n', '\r\n')),
      commit: (fx) => {
        fx.git('add', '-A');
        fx.git(
          '-c',
          'core.autocrlf=false',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-q',
          '-m',
          'crlf',
        );
      },
      expected: () => crlfCommitText(LOCK),
    },
    // 16: a spec that is not a string is printed as JSON
    {
      change: (fx) =>
        editJson(join(fx.root, 'packages', 'cli', 'package.json'), (o) => {
          o.dependencies['@q/core'] = 1;
        }),
      expected: () => dependencyText('packages/cli/package.json', '@q/core', '1'),
    },
  ];
  assert.equal(legs.length, 16);
  legs.forEach((leg, i) => {
    const fx = buildFixture(`rl44-${i + 1}`);
    try {
      leg.change(fx);
      (leg.commit ?? commitLeg)(fx);
      assert.equal(fx.git('status', '--porcelain'), '', `leg ${i + 1}: the tree must be clean`);
      const before = snapshot(fx);
      const r = fx.version();
      assertRefusal(r, leg.expected(fx));
      assertNothingChanged(fx, before, `leg ${i + 1}`);
    } finally {
      fx.cleanup();
    }
  });
});

test('RL45 — every restore before phase 2 puts the lockfile back, and says so', () => {
  const addKey = (fx) =>
    editJson(lockPath(fx), (o) => {
      o['x-edited-while-stopped'] = true;
    });
  const check = (fx, r) => {
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(lines(r.stderr).includes(LOCK_NOTICE), r.stderr);
    assert.deepEqual(stdoutFrom(r, 'Prepared'), successLines(fx));
    assert.equal(fx.git('status', '--porcelain'), '');
  };
  {
    // committed-untagged
    const fx = buildFixture('rl45a');
    try {
      unlinkSync(failTagging(fx));
      addKey(fx);
      const r = fx.resume();
      check(fx, r);
      assert.equal(JSON.parse(fx.git('show', `HEAD:${LOCK}`))['x-edited-while-stopped'], undefined);
    } finally {
      fx.cleanup();
    }
  }
  {
    // tagged
    const fx = buildFixture('rl45b');
    try {
      failDevCommit(fx);
      addKey(fx);
      const r = fx.resume();
      check(fx, r);
      assert.equal(JSON.parse(fx.git('show', `HEAD:${LOCK}`))['x-edited-while-stopped'], undefined);
    } finally {
      fx.cleanup();
    }
  }
  {
    // the lockfile's mode alone is a change the release did not make
    const fx = buildFixture('rl45c');
    try {
      failDevCommit(fx);
      chmodSync(lockPath(fx), 0o755);
      const r = fx.resume();
      check(fx, r);
      assert.match(fx.git('ls-tree', 'HEAD', '--', LOCK), /^100644 /);
    } finally {
      fx.cleanup();
    }
  }
});

test('RL46 — the decision to restore reads the index too', () => {
  const fx = buildFixture('rl46');
  try {
    failDevCommit(fx);
    const file = join(fx.root, 'packages', 'core', 'package.json');
    editJson(file, (o) => {
      o.version = '0.46.1-dev.0';
    });
    fx.git('add', 'packages/core/package.json');
    writeFileSync(file, fx.gitRaw('show', 'HEAD:packages/core/package.json'));
    // the index holds one of the release's contents, so --resume lets it through, and the restore
    // puts it back before phase 2
    assertSuccess(fx, fx.resume());
  } finally {
    fx.cleanup();
  }
});

test("RL47 — the lockfile the release commits is npm's own", () => {
  // A red RL47 after an npm upgrade means npm changed how it writes this lockfile, and the
  // release's own transformation of it (one `version` per package it sets) must follow.
  const fx = buildFixture('rl47');
  try {
    assertSuccess(fx, fx.version());
    const userConfig = join(fx.home, 'npmrc-user');
    const globalConfig = join(fx.home, 'npmrc-global');
    writeFileSync(userConfig, '');
    writeFileSync(globalConfig, '');
    for (const rev of ['v0.46.0', 'HEAD']) {
      const holder = makeTempDir('rl47-clone');
      try {
        const clone = join(holder, 'c');
        execFileSync('git', ['clone', '-q', fx.root, clone], { env: fx.env, stdio: 'ignore' });
        git(clone, fx.env, 'checkout', '-q', '--detach', rev);
        const npmEnv = {
          ...fx.env,
          npm_config_userconfig: userConfig,
          npm_config_globalconfig: globalConfig,
        };
        let attempts = 0;
        for (;;) {
          try {
            execFileSync(
              'npm',
              ['install', '--package-lock-only', '--ignore-scripts', '--offline'],
              {
                cwd: clone,
                env: npmEnv,
                stdio: 'ignore',
              },
            );
            break;
          } catch (e) {
            if (e.signal !== 'SIGSEGV' || ++attempts >= 4) throw e;
          }
        }
        assert.equal(
          readFileSync(join(clone, LOCK), 'utf-8'),
          fx.gitRaw('show', `${rev}:${LOCK}`),
          `npm would write a different lockfile at ${rev}`,
        );
      } finally {
        cleanup(holder);
      }
    }
  } finally {
    fx.cleanup();
  }
});

// ── RL48-RL59 — hooks, links, modes: nothing the release did not write is tagged ──────────────

const NODE_EDIT_CORE = (description) =>
  `node -e "const fs=require('fs');const f='packages/core/package.json';const o=JSON.parse(fs.readFileSync(f,'utf8'));o.description='${description}';fs.writeFileSync(f,JSON.stringify(o,null,2)+'\\n')"`;
function installHook(fx, name, body) {
  const hookPath = join(fx.root, '.git', 'hooks', name);
  writeFileSync(hookPath, `#!/bin/sh\n${body}\n`);
  chmodSync(hookPath, 0o755);
  return () => unlinkSync(hookPath);
}
/** A post-commit hook that runs `body` for a commit whose subject starts with `prefix`. */
function postCommitFor(fx, prefix, body) {
  return installHook(
    fx,
    'post-commit',
    `case "$(git log -1 --format=%s)" in\n  "${prefix}"*) ${body} ;;\nesac\nexit 0`,
  );
}
const TAGGED_HEAD =
  'Error: v0.46.0 is committed and tagged, but the development version is not committed:';
const LEFT_CORE =
  'It left packages/core/package.json as it is, since it holds a change the release did not make: --resume says how to keep or drop it.';

test('RL48 — a hook of the release commit changes a version file: phase 2 refuses it first', () => {
  const fx = buildFixture('rl48');
  try {
    postCommitFor(fx, 'chore: release', NODE_EDIT_CORE('edited by a hook'));
    const r = fx.version();
    assertRefusal(
      r,
      `${TAGGED_HEAD} ${CHANGED_CORE}. ${LEFT_CORE} Fix the cause, then run: npm run release -- --resume`,
      { whole: false },
    );
    assert.equal(fx.git('log', '-1', '--format=%s'), 'chore: release v0.46.0');
    assert.equal(
      readJson(join(fx.root, 'packages', 'core', 'package.json')).description,
      'edited by a hook',
    );
  } finally {
    fx.cleanup();
  }
});

const PRE_COMMIT_RELEASE = (extra = '') =>
  `case "$(git show :packages/core/package.json)" in\n  *-dev.*) ;;\n  *) ${NODE_EDIT_CORE('edited by a hook')} && git add packages/core/package.json${extra} ;;\nesac\nexit 0`;

test('RL49 — a pre-commit hook puts a change into the release commit', () => {
  const fx = buildFixture('rl49');
  try {
    installHook(fx, 'pre-commit', PRE_COMMIT_RELEASE());
    const r = fx.version();
    const rel = fx.short('HEAD');
    const start = fx.startShort;
    const step1 = (files) =>
      `Error: The release commit ${rel} holds changes the release did not make (${files}): they changed while the commit ran, most likely in a git hook. Put release/test back at ${start} (git reset ${start} keeps the current files, with the differences unstaged), fix or remove whatever changed them, then run npm run release -- --resume to put back the files the release changed, and re-run: npm run release -- --version 0.46.0`;
    assertRefusal(r, step1('packages/core/package.json'), { whole: false });
    assert.equal(fx.tryGit('rev-parse', '-q', '--verify', 'refs/tags/v0.46.0'), null);
    assert.equal(existsSync(fx.journalPath), true);

    // remove the hook: --resume now refuses the commit
    unlinkSync(join(fx.root, '.git', 'hooks', 'pre-commit'));
    const cannot = `Error: The unfinished v0.46.0 release cannot continue from here: release/test is at ${rel} "chore: release v0.46.0". It can start again from ${start}, where it started: put release/test back there (git reset ${start} keeps the current files, with the differences unstaged), then run npm run release -- --resume to put back the files the release changed, and re-run: npm run release -- --version 0.46.0. The reset takes ${rel} off release/test; its changes stay in your files, uncommitted.`;
    assertRefusal(fx.resume(), cannot);
    assert.equal(fx.tryGit('rev-parse', '-q', '--verify', 'refs/tags/v0.46.0'), null);

    // a tag elsewhere: the commit fails the release commit's test, so the moved-tag text does not apply
    fx.git('tag', '--no-sign', 'v0.46.0', 'base-point');
    const before = snapshot(fx);
    assertRefusal(fx.resume(), cannot);
    assertNothingChanged(fx, before);
    fx.git('tag', '-d', 'v0.46.0');

    // put the branch back: the hook's change is in the files, and --resume refuses to overwrite it
    fx.git('reset', start);
    assertRefusal(
      fx.resume(),
      refusalText(
        OVERWRITE,
        ['packages/core/package.json'],
        NOTHING_KEEP('packages/core/package.json', 'that file'),
      ),
    );

    // keep the hook's change as that refusal says
    editJson(join(fx.root, 'packages', 'core', 'package.json'), (o) => {
      o.version = '0.45.0';
    });
    fx.git('stash', 'push', '--', 'packages/core/package.json');
    const restored = fx.resume();
    assert.equal(restored.status, 1);
    assert.ok(restored.stderr.includes('It restored the 9 files the release sets'));
    const ok = fx.version();
    assert.deepEqual(
      stdoutFrom(ok, 'Prepared'),
      successLines(fx, {
        extra: [
          'A stash made on release/test, which holds packages/core/package.json, is waiting: if it holds changes you set aside for this release, bring them back now (git stash pop; if that conflicts, keep version 0.46.1-dev.0 and your other changes in packages/core/package.json, then run git restore --staged -- packages/core/package.json and git stash drop).',
        ],
      }),
    );
    fx.git('stash', 'pop');
    // only the hook's change came back, and the version is the development version
    assert.equal(fx.gitRaw('status', '--porcelain'), ' M packages/core/package.json\n');
    const pkg = readJson(join(fx.root, 'packages', 'core', 'package.json'));
    assert.equal(pkg.version, '0.46.1-dev.0');
    assert.equal(pkg.description, 'edited by a hook');
  } finally {
    fx.cleanup();
  }
});

test('RL49b — a pre-commit hook stages a file outside the journal into the release commit', () => {
  const fx = buildFixture('rl49b');
  try {
    installHook(
      fx,
      'pre-commit',
      PRE_COMMIT_RELEASE(' && echo hi > hook-added.txt && git add hook-added.txt'),
    );
    const r = fx.version();
    const rel = fx.short('HEAD');
    assertRefusal(
      r,
      `Error: The release commit ${rel} holds changes the release did not make (packages/core/package.json, hook-added.txt): they changed while the commit ran, most likely in a git hook. Put release/test back at ${fx.startShort} (git reset ${fx.startShort} keeps the current files, with the differences unstaged), fix or remove whatever changed them, then run npm run release -- --resume to put back the files the release changed, and re-run: npm run release -- --version 0.46.0`,
      { whole: false },
    );
    assert.equal(fx.tryGit('rev-parse', '-q', '--verify', 'refs/tags/v0.46.0'), null);
  } finally {
    fx.cleanup();
  }
});

test('RL50 — a pre-commit hook puts a change into the development commit', () => {
  const fx = buildFixture('rl50');
  try {
    installHook(
      fx,
      'pre-commit',
      `case "$(git show :packages/core/package.json)" in\n  *-dev.*) node -e "const fs=require('fs');const o=JSON.parse(fs.readFileSync('package-lock.json','utf8'));o['x-hook']=true;fs.writeFileSync('package-lock.json',JSON.stringify(o,null,2)+'\\n')" && git add package-lock.json ;;\nesac\nexit 0`,
    );
    const r = fx.version();
    const dev = fx.short('HEAD');
    const rel = fx.short('HEAD~1');
    assertRefusal(
      r,
      `Error: The development commit ${dev} holds changes the release did not make (package-lock.json): they changed while the commit ran, most likely in a git hook. Put release/test back at ${rel} (git reset ${rel} keeps the current files, with the differences unstaged), fix or remove whatever changed them, then re-run: npm run release -- --resume`,
      { whole: false },
    );
    assert.equal(existsSync(fx.journalPath), true);

    unlinkSync(join(fx.root, '.git', 'hooks', 'pre-commit'));
    fx.git('reset', rel);
    const ok = fx.resume();
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(lines(ok.stderr).includes(LOCK_NOTICE), ok.stderr);
    assert.deepEqual(stdoutFrom(ok, 'Prepared'), successLines(fx));
    assert.equal(JSON.parse(fx.git('show', `HEAD:${LOCK}`))['x-hook'], undefined);
  } finally {
    fx.cleanup();
  }
});

test("RL51 — a package directory added while the release was stopped is not the release's", () => {
  const fx = buildFixture('rl51');
  try {
    failDevCommit(fx);
    mkdirSync(join(fx.root, 'packages', 'zz', 'src'), { recursive: true });
    writeJson(join(fx.root, 'packages', 'zz', 'package.json'), {
      name: '@q/zz',
      version: '0.46.0',
      main: './dist/index.js',
    });
    writeFileSync(
      join(fx.root, 'packages', 'zz', 'src', 'version.ts'),
      "export const VERSION = '0.46.0';\n",
    );
    const r = fx.resume();
    assert.deepEqual(
      stdoutFrom(r, 'Prepared'),
      successLines(fx, {
        extra: [
          'This checkout also holds changes that are not committed, in untracked packages/zz/: they are not part of v0.46.0. Commit them on release/test if the release PR should carry them.',
        ],
      }),
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readJson(join(fx.root, 'packages', 'zz', 'package.json')).version, '0.46.0');
    assert.equal(fx.gitRaw('status', '--porcelain'), '?? packages/zz/\n');
  } finally {
    fx.cleanup();
  }
});

const AFTER_STEP = (kind, head, headSubject, commit) =>
  `Error: After the ${kind} commit step, release/test is at ${head} "${headSubject}", not at the ${kind} commit ${commit}: something made another commit after it while the release ran, most likely a git hook. Put release/test back at ${commit} (git reset ${commit} keeps the current files, with the differences unstaged), fix or remove what did it, then re-run: npm run release -- --resume`;
const hookCommit = (message) =>
  `git -c commit.gpgsign=false commit -q --allow-empty -m "${message}"`;

test('RL52 — HEAD after a commit step is not the commit the step made: nothing is tagged', () => {
  const noTag = (fx) =>
    assert.equal(fx.tryGit('rev-parse', '-q', '--verify', 'refs/tags/v0.46.0'), null);
  const abandonKeep = (fx, itsShort, headShort, withTag) =>
    `Part B step 3, "To abandon an unfinished release": put the branch back at ${fx.startShort} "base", where it started (git reset --keep ${fx.startShort} brings its files too, and refuses rather than overwrite a change of yours), which takes the 1 commit after ${itsShort} off it too (to keep it, run git branch release/test-kept-${headShort} ${headShort} first: when the release has run again, its text says how to bring it back), then ${withTag ? 'delete its tag (git tag -d v0.46.0), then its journal' : 'delete its journal'} (rm ${fx.journalPath}), then re-run: npm run release -- --version 0.46.0`;
  const continueText = (fx, kind, head, headSubject, its, withTag) =>
    `Error: The unfinished v0.46.0 release cannot continue from here: release/test is at ${head} "${headSubject}". It can continue from ${its}, its ${kind} commit: put release/test back there (git reset ${its} keeps the current files, with the differences unstaged), then re-run: npm run release -- --resume. The reset takes ${head} off release/test; its changes stay in your files, uncommitted, and are not part of v0.46.0. To abandon the release instead: ${abandonKeep(fx, its, head, withTag)}`;
  {
    // 1. another commit after the release commit
    const fx = buildFixture('rl52a');
    try {
      const remove = postCommitFor(fx, 'chore: release v0.46.0', hookCommit('made by a hook'));
      const r = fx.version();
      const head = fx.short('HEAD');
      const rel = fx.short('HEAD~1');
      assertRefusal(r, AFTER_STEP('release', head, 'made by a hook', rel), { whole: false });
      noTag(fx);
      assert.equal(existsSync(fx.journalPath), true);
      remove();
      const before = snapshot(fx);
      assertRefusal(fx.resume(), continueText(fx, 'release', head, 'made by a hook', rel, false));
      assertNothingChanged(fx, before);
      fx.git('reset', rel);
      const ok = fx.resume();
      assertSuccess(fx, ok);
      assert.equal(fx.short('v0.46.0^{commit}'), rel);
      assert.equal(
        ok.stdout.includes('→ Building'),
        false,
        'the release went on from its own commit',
      );
    } finally {
      fx.cleanup();
    }
  }
  {
    // 2. the subject rewritten
    const fx = buildFixture('rl52b');
    try {
      installHook(
        fx,
        'prepare-commit-msg',
        'case "$(head -n1 "$1")" in\n  "chore: release"*) { printf \'[REL] \'; cat "$1"; } > "$1.new" && mv "$1.new" "$1" ;;\nesac\nexit 0',
      );
      const r = fx.version();
      const head = fx.short('HEAD');
      assert.equal(
        fx.git('rev-parse', 'HEAD~1'),
        fx.start,
        "one commit was made, and it is not the release's",
      );
      assertRefusal(
        r,
        `Error: After the release commit step, release/test is at ${head} "[REL] chore: release v0.46.0", but the release commit must have the subject "chore: release v0.46.0" and the parent ${fx.startShort}: something changed that commit or made another one while the release ran, most likely a git hook. Put release/test back at ${fx.startShort} (git reset ${fx.startShort} keeps the current files, with the differences unstaged), fix or remove what did it, then run npm run release -- --resume to put back the files the release changed, and re-run: npm run release -- --version 0.46.0`,
        { whole: false },
      );
      noTag(fx);
      assert.equal(existsSync(fx.journalPath), true);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 3. another commit with the release commit's own subject
    const fx = buildFixture('rl52c');
    try {
      postCommitFor(
        fx,
        'chore: release v0.46.0',
        `if [ -z "$IN_HOOK" ]; then IN_HOOK=1 ${hookCommit('chore: release v0.46.0')}; fi`,
      );
      const r = fx.version();
      const head = fx.short('HEAD');
      const rel = fx.short('HEAD~1');
      assert.equal(fx.git('rev-parse', 'HEAD~2'), fx.start);
      assertRefusal(r, AFTER_STEP('release', head, 'chore: release v0.46.0', rel), {
        whole: false,
      });
      noTag(fx);
      assert.equal(existsSync(fx.journalPath), true);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 4. the branch put back by a hook
    const fx = buildFixture('rl52d');
    try {
      postCommitFor(fx, 'chore: release v0.46.0', 'git reset -q --soft HEAD~1');
      const r = fx.version();
      assertRefusal(
        r,
        STOPPED(
          "after the commit step, HEAD does not have the subject and parent the step's commit must have",
        ),
        { whole: false },
      );
      assert.equal(fx.git('status', '--porcelain'), '');
      assert.equal(existsSync(fx.journalPath), false);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 5. another commit after the development commit
    const fx = buildFixture('rl52e');
    try {
      const remove = postCommitFor(
        fx,
        'chore: begin development after v0.46.0',
        hookCommit('made by a hook'),
      );
      const r = fx.version();
      const head = fx.short('HEAD');
      const dev = fx.short('HEAD~1');
      const rel = fx.short('HEAD~2');
      assert.equal(fx.short('v0.46.0^{commit}'), rel);
      assertRefusal(r, AFTER_STEP('development', head, 'made by a hook', dev), { whole: false });
      remove();
      const before = snapshot(fx);
      assertRefusal(
        fx.resume(),
        continueText(fx, 'development', head, 'made by a hook', dev, true),
      );
      assertNothingChanged(fx, before);
      fx.git('reset', dev);
      assertSuccess(fx, fx.resume());
    } finally {
      fx.cleanup();
    }
  }
  {
    // 6. after the release commit, untagged, a commit on top
    const fx = buildFixture('rl52f');
    try {
      unlinkSync(failTagging(fx));
      const rel = fx.short('HEAD');
      writeFileSync(join(fx.root, 'notes.txt'), 'notes\n');
      fx.git('add', 'notes.txt');
      fx.git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'a commit after it');
      const head = fx.short('HEAD');
      const before = snapshot(fx);
      assertRefusal(
        fx.resume(),
        continueText(fx, 'release', head, 'a commit after it', rel, false),
      );
      assertNothingChanged(fx, before);
      fx.git('reset', rel);
      const ok = fx.resume();
      assert.deepEqual(
        stdoutFrom(ok, 'Prepared'),
        successLines(fx, {
          extra: [
            'This checkout also holds changes that are not committed, in untracked notes.txt: they are not part of v0.46.0. Commit them on release/test if the release PR should carry them.',
          ],
        }),
      );
    } finally {
      fx.cleanup();
    }
  }
});

test('RL53 — a hook of the release commit leaves a file the bump cannot transform: phase 2 refuses it first', () => {
  {
    const fx = buildFixture('rl53a');
    try {
      postCommitFor(fx, 'chore: release', "printf '{\\n' > package-lock.json");
      const r = fx.version();
      assert.equal(r.status, 1);
      const err = lines(r.stderr);
      const at = err.indexOf(LOCK_NOTICE);
      assert.notEqual(at, -1, r.stderr);
      assert.equal(
        err[at + 1],
        `${TAGGED_HEAD} package-lock.json changed while the release ran. Fix the cause, then run: npm run release -- --resume`,
      );
      assert.equal(progressLines(r).at(-1), '→ Tagging v0.46.0');
      assert.equal(fx.git('log', '-1', '--format=%s'), 'chore: release v0.46.0');
    } finally {
      fx.cleanup();
    }
  }
  {
    const fx = buildFixture('rl53b');
    try {
      postCommitFor(
        fx,
        'chore: release',
        "printf 'export const VERSION = 1;\\n' > packages/core/src/version.ts",
      );
      const r = fx.version();
      assert.equal(r.status, 1);
      assert.equal(
        r.stderr.trimEnd(),
        `${TAGGED_HEAD} packages/core/src/version.ts changed while the release ran. It left packages/core/src/version.ts as it is, since it holds a change the release did not make: --resume says how to keep or drop it. Fix the cause, then run: npm run release -- --resume`,
      );
      assert.equal(progressLines(r).at(-1), '→ Tagging v0.46.0');
      assert.equal(fx.git('log', '-1', '--format=%s'), 'chore: release v0.46.0');
    } finally {
      fx.cleanup();
    }
  }
});

const BEFORE_CHANGING = (what) =>
  `Error: The release of v0.46.0 stopped before changing anything: ${what}`;
const registryLine = '→ Reading the published versions from the npm registry';
const discardText = (file) =>
  `Commit, stash or discard what changed (git restore --staged --worktree -- ${file} discards it), then re-run: npm run release -- --version 0.46.0`;

test("RL54 — phase 1's bump reads only what the entry checks read", () => {
  {
    const fx = buildFixture('rl54a');
    try {
      const path = makeShimDir(fx, 'wrappers');
      const r = fx.version('0.46.0', {
        PATH: path,
        LS_REMOTE_BREAK: 'packages/core/src/version.ts',
      });
      assert.equal(r.status, 1);
      assert.equal(
        r.stderr.trimEnd(),
        BEFORE_CHANGING(
          `packages/core/src/version.ts changed while the release ran. ${discardText('packages/core/src/version.ts')}`,
        ),
      );
      assert.equal(progressLines(r).at(-1), registryLine);
      assert.equal(
        readFileSync(join(fx.root, 'packages', 'core', 'src', 'version.ts'), 'utf-8'),
        'export const VERSION = 1;\n',
      );
      assert.equal(fx.gitRaw('status', '--porcelain'), ' M packages/core/src/version.ts\n');
      assert.equal(existsSync(fx.journalPath), false);
    } finally {
      fx.cleanup();
    }
  }
  {
    const fx = buildFixture('rl54b');
    try {
      const path = makeShimDir(fx, 'wrappers');
      const r = fx.version('0.46.0', { PATH: path, LS_REMOTE_BREAK: 'package-lock.json' });
      assert.equal(r.status, 1);
      assert.equal(
        r.stderr.trimEnd(),
        BEFORE_CHANGING(
          `package-lock.json changed while the release ran. ${discardText('package-lock.json')}`,
        ),
      );
      assert.equal(readFileSync(lockPath(fx), 'utf-8'), '{\n');
      assert.equal(fx.gitRaw('status', '--porcelain'), ' M package-lock.json\n');
      assert.equal(existsSync(fx.journalPath), false);
    } finally {
      fx.cleanup();
    }
  }
  {
    const fx = buildFixture('rl54c');
    try {
      const path = makeShimDir(fx, 'wrappers');
      const r = fx.version('0.46.0', { PATH: path, LS_REMOTE_BREAK: 'staged' });
      assert.equal(r.status, 1);
      assert.equal(
        r.stderr.trimEnd(),
        BEFORE_CHANGING(
          `packages/core/package.json changed while the release ran. ${discardText('packages/core/package.json')}`,
        ),
      );
      assert.equal(progressLines(r).at(-1), registryLine);
      assert.ok(fx.gitRaw('show', ':packages/core/package.json').endsWith('staged meanwhile\n'));
      assert.equal(
        readFileSync(join(fx.root, 'packages', 'core', 'package.json'), 'utf-8'),
        fx.gitRaw('show', 'HEAD:packages/core/package.json'),
      );
      assert.equal(existsSync(fx.journalPath), false);
    } finally {
      fx.cleanup();
    }
  }
});

test('RL55 — the start is the commit the entry checks read', () => {
  const fx = buildFixture('rl55');
  try {
    const path = makeShimDir(fx, 'wrappers');
    const r = fx.version('0.46.0', {
      PATH: path,
      LS_REMOTE_BREAK: 'packages/core/src/version.ts',
      LS_REMOTE_COMMIT: '1',
    });
    const head = fx.short('HEAD');
    assert.equal(
      r.stderr.trimEnd(),
      BEFORE_CHANGING(
        `HEAD moved while the release ran, from ${fx.startShort} to ${head} "a commit made meanwhile". Re-run to release ${head}: npm run release -- --version 0.46.0`,
      ),
    );
    assert.equal(r.status, 1);
    assertNoRelease(fx);
    assert.equal(fx.git('status', '--porcelain'), '');
  } finally {
    fx.cleanup();
  }
});

test("RL56 — a pre-commit hook changes only a journal file's mode: nothing is tagged", () => {
  const fx = buildFixture('rl56');
  try {
    installHook(
      fx,
      'pre-commit',
      'case "$(git show :packages/core/package.json)" in\n  *-dev.*) ;;\n  *) chmod +x packages/core/package.json && git add packages/core/package.json ;;\nesac\nexit 0',
    );
    const r = fx.version();
    const rel = fx.short('HEAD');
    assertRefusal(
      r,
      `Error: The release commit ${rel} holds changes the release did not make (packages/core/package.json): they changed while the commit ran, most likely in a git hook. Put release/test back at ${fx.startShort} (git reset ${fx.startShort} keeps the current files, with the differences unstaged), fix or remove whatever changed them, then run npm run release -- --resume to put back the files the release changed, and re-run: npm run release -- --version 0.46.0`,
      { whole: false },
    );
    assert.equal(fx.tryGit('rev-parse', '-q', '--verify', 'refs/tags/v0.46.0'), null);
    assert.equal(existsSync(fx.journalPath), true);
  } finally {
    fx.cleanup();
  }
});

test('RL57 — a commit made while the entry checks read origin, outside the journal: nothing changed, and the re-run releases it', () => {
  const fx = buildFixture('rl57');
  try {
    const path = makeShimDir(fx, 'wrappers');
    const r = fx.version('0.46.0', {
      PATH: path,
      LS_REMOTE_BREAK: 'README.md',
      LS_REMOTE_COMMIT: '1',
    });
    const head = fx.short('HEAD');
    assert.equal(fx.git('log', '-1', '--format=%s'), 'a commit made meanwhile');
    assert.equal(
      r.stderr.trimEnd(),
      BEFORE_CHANGING(
        `HEAD moved while the release ran, from ${fx.startShort} to ${head} "a commit made meanwhile". Re-run to release ${head}: npm run release -- --version 0.46.0`,
      ),
    );
    assert.equal(r.status, 1);
    assertNoRelease(fx);
    assert.equal(fx.git('status', '--porcelain'), '');

    const ok = fx.version();
    assertSuccess(fx, ok);
    assert.equal(fx.short('v0.46.0^'), head);
  } finally {
    fx.cleanup();
  }
});

test('RL58 — a root package.json that is missing or not an object names no overrides', () => {
  for (const how of ['null', 'removed']) {
    const fx = buildFixture(`rl58-${how}`);
    try {
      if (how === 'null') writeFileSync(join(fx.root, 'package.json'), 'null\n');
      else fx.git('rm', '-q', 'package.json');
      commitLeg(fx);
      const r = fx.version();
      assert.equal(r.status, 1);
      assert.equal(r.stderr.includes('failed unexpectedly'), false, r.stderr);
      assert.match(
        r.stderr,
        /^Error: The release of v0\.46\.0 stopped: the build failed \(exit \d+; its message is above\)\./m,
      );
      assert.equal(fx.git('status', '--porcelain'), '');
      assert.equal(existsSync(fx.journalPath), false);
    } finally {
      fx.cleanup();
    }
  }
});

test('RL59 — a mode change the release did not make is a change it did not make', () => {
  const corePkg = 'packages/core/package.json';
  {
    // 1. a chmod during the build
    const fx = buildFixture('rl59a');
    try {
      const r = fx.version('0.46.0', { BUILD_CHMOD: '1' });
      assertRefusal(r, STOPPED_EXCEPT_CORE(CHANGED_CORE), { whole: false });
      assert.equal(progressLines(r).at(-1), '→ Staging the version files');
      assert.equal(fx.git('rev-parse', 'HEAD'), fx.start);
      assert.equal(existsSync(fx.journalPath), false);
      assert.match(fx.git('diff', '--summary', '--', corePkg), /mode change 100644 => 100755/);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 2. --resume refuses a mode change, and a restore puts it back
    const fx = buildFixture('rl59b');
    try {
      failDevCommit(fx);
      chmodSync(join(fx.root, corePkg), 0o755);
      const before = snapshot(fx);
      assertRefusal(
        fx.resume(),
        refusalText(OVERWRITE, [corePkg], TAGGED_KEEP('', corePkg, 'that file')),
      );
      assertNothingChanged(fx, before);
      fx.git('restore', '--staged', '--worktree', '--', corePkg);
      assertSuccess(fx, fx.resume());
      assert.match(fx.git('ls-tree', 'HEAD', '--', corePkg), /^100644 /);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 3. a hook of the release commit makes a version file executable
    const fx = buildFixture('rl59c');
    try {
      postCommitFor(fx, 'chore: release', `chmod +x ${corePkg}`);
      const r = fx.version();
      assertRefusal(
        r,
        `${TAGGED_HEAD} ${CHANGED_CORE}. ${LEFT_CORE} Fix the cause, then run: npm run release -- --resume`,
        { whole: false },
      );
      assert.equal(fx.git('log', '-1', '--format=%s'), 'chore: release v0.46.0');
      assert.match(fx.git('ls-tree', 'HEAD', '--', corePkg), /^100644 /);
      assert.match(fx.git('diff', '--summary'), /mode change 100644 => 100755/);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 4. a hook of the release commit replaces a version file with a symbolic link
    const fx = buildFixture('rl59d');
    try {
      const copy = join(fx.home, 'outside-version.ts');
      const versionTs = 'packages/core/src/version.ts';
      postCommitFor(
        fx,
        'chore: release',
        `cp ${versionTs} "${copy}" && rm ${versionTs} && ln -s "${copy}" ${versionTs}`,
      );
      const r = fx.version();
      assertRefusal(
        r,
        `${TAGGED_HEAD} ${versionTs} was replaced by a symbolic link while the release ran. Fix the cause, put back the file the link replaced (git restore --staged --worktree -- ${versionTs}), then run: npm run release -- --resume`,
        { whole: false },
      );
      assert.equal(fx.git('log', '-1', '--format=%s'), 'chore: release v0.46.0');
      assert.equal(readFileSync(copy, 'utf-8'), "export const VERSION = '0.46.0';\n");
      assert.equal(lstatSync(join(fx.root, versionTs)).isSymbolicLink(), true);

      const before = snapshot(fx);
      const refused = fx.resume();
      assert.equal(refused.status, 1);
      assert.equal(
        refused.stderr.trimEnd(),
        [
          'Error: Resuming would overwrite a symbolic link that replaced a file the release sets, in:',
          `  ${versionTs}`,
          `A file the release sets cannot be kept as a link: put back the file the link replaced (git restore --staged --worktree -- ${versionTs}), then re-run: npm run release -- --resume`,
        ].join('\n'),
      );
      assertNothingChanged(fx, before);
      runPrinted(fx, between(refused.stderr, 'replaced (', '), then re-run'));
      assertSuccess(fx, fx.resume());
      assert.equal(readFileSync(copy, 'utf-8'), "export const VERSION = '0.46.0';\n");
      assert.equal(lstatSync(join(fx.root, versionTs)).isSymbolicLink(), false);
      assert.equal(
        readFileSync(join(fx.root, versionTs), 'utf-8'),
        "export const VERSION = '0.46.1-dev.0';\n",
      );
    } finally {
      fx.cleanup();
    }
  }
});

// ── RL60-RL62 — lockfile remedies, signed commits, untracked files ───────────────────────────

test('RL60 — a lockfile npm cannot repair is restored from the commit the refusal names', () => {
  {
    // 1. broken in two commits in a row: the commit named is not the newest that changed the file
    const fx = buildFixture('rl60a');
    try {
      const lock = readJson(lockPath(fx));
      delete lock.packages['packages/testing'];
      writeFileSync(lockPath(fx), lockText(lock));
      commitAll(fx, 'break the lockfile');
      lock.packages['packages/core'].license = 'MIT';
      writeFileSync(lockPath(fx), lockText(lock));
      commitAll(fx, 'change the broken lockfile again');
      const before = snapshot(fx);
      const r = fx.version();
      assertRefusal(
        r,
        lockRestoreText('it has no entry for packages/testing', fx.short('base-point')),
      );
      assertNothingChanged(fx, before);
      // follow it: the printed checkout and the printed commit (the npm step is left out: the
      // restored lockfile is current here, and no cell runs npm)
      runPrinted(fx, between(r.stderr, 'npm can start from (', '), then bring it up to date'));
      runPrinted(fx, between(r.stderr, 'commit it (', '), then re-run.'));
      assert.equal(fx.git('status', '--porcelain'), '');
      assertSuccess(fx, fx.version());
    } finally {
      fx.cleanup();
    }
  }
  {
    // 2. neither the entry nor the link: npm adds both
    const fx = buildFixture('rl60b');
    try {
      const lock = readJson(lockPath(fx));
      delete lock.packages['packages/testing'];
      delete lock.packages['node_modules/@q/testing'];
      writeFileSync(lockPath(fx), lockText(lock));
      commitAll(fx, 'drop testing from the lockfile');
      assertRefusal(fx.version(), lockNpmText('it has no entry for packages/testing'));
    } finally {
      fx.cleanup();
    }
  }
  {
    // 3. no commit holds a lockfile npm can start from
    const fx = buildFixture('rl60c');
    try {
      writeFileSync(lockPath(fx), '{\n');
      fx.git('add', '-A');
      fx.git('-c', 'commit.gpgsign=false', 'commit', '-q', '--amend', '-m', 'base');
      assertRefusal(fx.version(), lockNoCommitText('it is not valid JSON'));
    } finally {
      fx.cleanup();
    }
  }
});

test('RL61 — signed commits with log.showSignature set: every subject is read without the verdict', () => {
  const fx = buildFixture('rl61');
  try {
    const key = join(fx.home, 'signing-key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key, '-C', 'rl61'], {
      stdio: 'ignore',
    });
    for (const [k, v] of [
      ['gpg.format', 'ssh'],
      ['user.signingkey', key],
      ['commit.gpgsign', 'true'],
      ['log.showSignature', 'true'],
    ]) {
      fx.git('config', k, v);
    }
    failDevCommit(fx);
    const release = fx.short('HEAD');
    assert.match(fx.git('cat-file', 'commit', 'v0.46.0^{commit}'), /^gpgsig /m);
    assert.notEqual(fx.git('log', '-1', '--format=%s').split('\n').length, 1, 'the subject alone');

    fx.git('commit', '--allow-empty', '-q', '-m', 'a signed commit after it');
    const head = fx.short('HEAD');
    const before = snapshot(fx);
    const r = fx.resume();
    assert.equal(r.status, 1);
    assertRefusal(
      r,
      `Error: The unfinished v0.46.0 release cannot continue from here: release/test is at ${head} "a signed commit after it". It can continue from ${release}, its release commit: put release/test back there (git reset ${release} keeps the current files, with the differences unstaged), then re-run: npm run release -- --resume. The reset takes ${head} off release/test; its changes stay in your files, uncommitted, and are not part of v0.46.0. To abandon the release instead: Part B step 3, "To abandon an unfinished release": put the branch back at ${fx.startShort} "base", where it started (git reset --keep ${fx.startShort} brings its files too, and refuses rather than overwrite a change of yours), which takes the 1 commit after ${release} off it too (to keep it, run git branch release/test-kept-${head} ${head} first: when the release has run again, its text says how to bring it back), then delete its tag (git tag -d v0.46.0), then its journal (rm ${fx.journalPath}), then re-run: npm run release -- --version 0.46.0`,
    );
    assertNothingChanged(fx, before);

    fx.git('reset', release);
    assertSuccess(fx, fx.resume());
    assert.match(
      fx.git('cat-file', 'commit', 'HEAD'),
      /^gpgsig /m,
      'the development commit is signed too',
    );

    // the only place the script asks git for a commit message
    const source = readFileSync(scriptPath('release.mjs'), 'utf-8');
    assert.equal((source.match(/'log'/g) ?? []).length, 1);
  } finally {
    fx.cleanup();
  }
});

test('RL62 — with status.showUntrackedFiles=no, the clean-tree check still sees untracked files', () => {
  const fx = buildFixture('rl62');
  try {
    fx.git('config', 'status.showUntrackedFiles', 'no');
    writeFileSync(join(fx.root, 'packages', 'core', 'src', 'extra.ts'), 'export const x = 1;\n');
    const before = snapshot(fx);
    const r = fx.version();
    assertRefusal(
      r,
      [
        'Error: The working tree is not clean:',
        '  ?? packages/core/src/extra.ts',
        'Commit, stash (git stash -u also stashes untracked files) or remove them, then re-run.',
      ].join('\n'),
    );
    assertNothingChanged(fx, before);
  } finally {
    fx.cleanup();
  }
});

// ── RL63 — the branch put back before the release commit ────────────────────────────────────

const FORWARD = (b) =>
  `(git reset --keep ${b} brings its files too, and refuses rather than overwrite a change of yours)`;
/** The text for a branch put back before the release commit (HEAD is before the anchor). */
function beforeText(fx, { head, headSubject = 'base', rel, left = '', abandon, V = '0.46.0' }) {
  return `Error: The unfinished v${V} release cannot continue from here: release/test is at ${head} "${headSubject}", before ${rel}, its release commit.${left} It can continue from there: move release/test forward to it ${FORWARD(rel)}, then re-run: npm run release -- --resume. To abandon the release instead: ${abandon}, then re-run: npm run release -- --version ${V}`;
}
/** The text for a branch put back and committed on: a line that does not hold the release commit. */
function otherLineText(fx, { head, headSubject, rel, n, abandon, V = '0.46.0' }) {
  const kept = `release/test-kept-${head}`;
  const taken =
    n === 1
      ? `${head} off it, with its changes`
      : `${n} commits off it, ${head} the newest, with their changes`;
  const them = n === 1 ? 'it' : 'them';
  const included = n === 1 ? 'that commit' : `those ${n} commits`;
  return `Error: The unfinished v${V} release cannot continue from here: release/test is at ${head} "${headSubject}", on a line that does not hold ${rel}, its release commit. Moving release/test there takes ${taken}. It can continue from there: keep ${them} on a branch (git branch ${kept} ${head}), move release/test to ${rel} ${FORWARD(rel)}, then re-run: npm run release -- --resume; when the release has finished, its text says how to bring ${them} back. To abandon the release instead and release from ${head}, ${included} included: ${abandon}, then re-run: npm run release -- --version ${V}`;
}
const BOTH = (fx, V = '0.46.0') =>
  `delete its tag (git tag -d v${V}), then its journal (rm ${fx.journalPath})`;
const JOURNAL_ONLY = (fx) => `delete its journal (rm ${fx.journalPath})`;
/** The two commands of the refusal's "It can continue from there:" sentence, as printed. */
function printedMoveCommands(stderr, rel) {
  return [
    between(stderr, ' on a branch (', ')'),
    between(stderr, `move release/test to ${rel} (`, ' brings'),
  ];
}
/** C2.14's two commands, as printed. */
function printedKeptCommands(stdout) {
  return [between(stdout, ' back now (', ')'), between(stdout, 'then delete the branch (', ')')];
}

test('RL63 — the branch put back before the release commit: move it forward, or abandon the release', () => {
  const GONE_TEXT = 'its release commit';
  void GONE_TEXT;
  {
    // 1. put back to the start, the tag deleted
    const fx = buildFixture('rl63a');
    try {
      failDevCommit(fx);
      const rel = fx.short('HEAD');
      fx.git('reset', '--hard', fx.start);
      fx.git('tag', '-d', 'v0.46.0');
      const before = snapshot(fx);
      const text = beforeText(fx, { head: fx.startShort, rel, abandon: JOURNAL_ONLY(fx) });
      assertRefusal(fx.resume(), text);
      assertRefusal(fx.version(), text);
      assertNothingChanged(fx, before);
      fx.git('reset', '--keep', rel);
      assertSuccess(fx, fx.resume());
      assert.equal(fx.short('v0.46.0^{commit}'), rel);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 2. the tag kept: the abandon names the tag and the journal
    const fx = buildFixture('rl63b');
    try {
      failDevCommit(fx);
      const rel = fx.short('HEAD');
      fx.git('reset', '--hard', fx.start);
      const before = snapshot(fx);
      assertRefusal(fx.resume(), beforeText(fx, { head: fx.startShort, rel, abandon: BOTH(fx) }));
      assertNothingChanged(fx, before);
      fx.git('tag', '-d', 'v0.46.0');
      unlinkSync(fx.journalPath);
      assertSuccess(fx, fx.version());
    } finally {
      fx.cleanup();
    }
  }
  {
    // 3. two commits after the release commit
    const fx = buildFixture('rl63c');
    try {
      failDevCommit(fx);
      const rel = fx.short('HEAD');
      fx.git('commit', '--allow-empty', '-q', '-m', 'an empty commit');
      writeFileSync(
        join(fx.root, 'CHANGELOG.md'),
        '# Changelog\n\n## [0.46.1] — 2026-01-02\n\n## [0.46.0] — 2026-01-01\n\na typo fixed\n',
      );
      commitAll(fx, 'docs: fix changelog typo');
      const head = fx.short('HEAD');
      const before = snapshot(fx);
      assertRefusal(
        fx.resume(),
        `Error: The unfinished v0.46.0 release cannot continue from here: release/test is at ${head} "docs: fix changelog typo". It can continue from ${rel}, its release commit: put release/test back there (git reset ${rel} keeps the current files, with the differences unstaged), then re-run: npm run release -- --resume. The reset takes 2 commits off release/test, ${head} the newest; their changes stay in your files, uncommitted, and are not part of v0.46.0. To abandon the release instead: Part B step 3, "To abandon an unfinished release": put the branch back at ${fx.startShort} "base", where it started ${FORWARD(fx.startShort)}, which takes the 2 commits after ${rel} off it too (to keep them, run git branch release/test-kept-${head} ${head} first: when the release has run again, its text says how to bring them back), then ${BOTH(fx)}, then re-run: npm run release -- --version 0.46.0`,
      );
      assertNothingChanged(fx, before);
      fx.git('reset', rel);
      const ok = fx.resume();
      assert.deepEqual(
        stdoutFrom(ok, 'Prepared'),
        successLines(fx, {
          extra: [
            'This checkout also holds changes that are not committed, in modified CHANGELOG.md: they are not part of v0.46.0. Commit them on release/test if the release PR should carry them.',
          ],
        }),
      );
    } finally {
      fx.cleanup();
    }
  }
  {
    // 4. a path with a space and a quote: the printed rm quotes the journal's path
    const fx = buildFixture("rl63 it's");
    try {
      failDevCommit(fx);
      fx.git('reset', '--hard', fx.start);
      const word = `'${fx.journalPath.replaceAll("'", "'\\''")}'`;
      const r = fx.resume();
      assert.equal(r.status, 1);
      assert.ok(
        r.stderr.includes(`delete its tag (git tag -d v0.46.0), then its journal (rm ${word})`),
        r.stderr,
      );
      runPrinted(
        fx,
        between(
          r.stderr,
          'To abandon the release instead: delete its tag (',
          '), then its journal',
        ),
      );
      const r2 = fx.resume();
      assert.equal(r2.status, 1);
      assert.ok(
        r2.stderr.includes(`To abandon the release instead: delete its journal (rm ${word})`),
        r2.stderr,
      );
      runPrinted(fx, `rm ${word}`);
      assert.equal(existsSync(fx.journalPath), false);
      assertSuccess(fx, fx.version());
    } finally {
      fx.cleanup();
    }
  }
  {
    // 5. put back to the start and committed on: a line that does not hold the release commit
    const fx = buildFixture('rl63e');
    try {
      failDevCommit(fx);
      const rel = fx.short('HEAD');
      fx.git('reset', '--hard', fx.start);
      writeFileSync(join(fx.root, 'notes.md'), 'notes\n');
      fx.git('add', 'notes.md');
      fx.git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fix something');
      const head = fx.short('HEAD');
      const before = snapshot(fx);
      const r = fx.resume();
      assertRefusal(
        r,
        otherLineText(fx, { head, headSubject: 'fix something', rel, n: 1, abandon: BOTH(fx) }),
      );
      assertNothingChanged(fx, before);
      for (const c of printedMoveCommands(r.stderr, rel)) runPrinted(fx, c);
      const ok = fx.resume();
      const keptLine = `A branch kept for this release is waiting: release/test-kept-${head} holds 1 commit that is not on release/test. Bring it back now (git cherry-pick --allow-empty HEAD..release/test-kept-${head}), then delete the branch (git branch -D release/test-kept-${head}).`;
      assert.deepEqual(stdoutFrom(ok, 'Prepared'), successLines(fx, { extra: [keptLine] }));
      const again = fx.resume();
      assert.equal(again.status, 0);
      assert.ok(lines(again.stdout).includes(keptLine), again.stdout);
      for (const c of printedKeptCommands(again.stdout)) runPrinted(fx, c);
      assert.equal(readFileSync(join(fx.root, 'notes.md'), 'utf-8'), 'notes\n');
      assert.equal(fx.git('log', '-1', '--format=%s'), 'fix something');
      assert.equal(
        fx.git('log', '-1', '--format=%s', 'HEAD~1'),
        'chore: begin development after v0.46.0',
      );
      assert.equal(
        fx.tryGit('rev-parse', '-q', '--verify', `refs/heads/release/test-kept-${head}`),
        null,
      );
      const last = fx.resume();
      assert.equal(last.status, 0);
      assert.equal(last.stdout.includes('A branch kept for this release'), false);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 6. two empty commits on a line that does not hold the release commit
    const fx = buildFixture('rl63f');
    try {
      failDevCommit(fx);
      const rel = fx.short('HEAD');
      fx.git('reset', '--hard', fx.start);
      fx.git('commit', '--allow-empty', '-q', '-m', 'fix something');
      fx.git('commit', '--allow-empty', '-q', '-m', 'fix another thing');
      const head = fx.short('HEAD');
      const before = snapshot(fx);
      const r = fx.resume();
      assertRefusal(
        r,
        otherLineText(fx, { head, headSubject: 'fix another thing', rel, n: 2, abandon: BOTH(fx) }),
      );
      assertNothingChanged(fx, before);
      for (const c of printedMoveCommands(r.stderr, rel)) runPrinted(fx, c);
      const ok = fx.resume();
      const keptLine = `A branch kept for this release is waiting: release/test-kept-${head} holds 2 commits that are not on release/test. Bring them back now (git cherry-pick --allow-empty HEAD..release/test-kept-${head}), then delete the branch (git branch -D release/test-kept-${head}).`;
      assert.deepEqual(stdoutFrom(ok, 'Prepared'), successLines(fx, { extra: [keptLine] }));
      for (const c of printedKeptCommands(ok.stdout)) runPrinted(fx, c);
      assert.deepEqual(fx.git('log', '--format=%s', '-3').split('\n'), [
        'fix another thing',
        'fix something',
        'chore: begin development after v0.46.0',
      ]);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 7. the tag names a tree
    const fx = buildFixture('rl63g');
    try {
      failDevCommit(fx);
      const rel = fx.short('HEAD');
      fx.git('reset', '--hard', fx.start);
      fx.git('tag', '-d', 'v0.46.0');
      fx.git('tag', '--no-sign', 'v0.46.0', 'HEAD^{tree}');
      const before = snapshot(fx);
      assertRefusal(fx.resume(), beforeText(fx, { head: fx.startShort, rel, abandon: BOTH(fx) }));
      assertNothingChanged(fx, before);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 8. a merge among the commits: git refuses to cherry-pick it, and the line says merge
    const fx = buildFixture('rl63h');
    try {
      failDevCommit(fx);
      const rel = fx.short('HEAD');
      fx.git('reset', '--hard', fx.start);
      fx.git('switch', '-q', '-c', 'side');
      writeFileSync(join(fx.root, 'side.md'), 'side\n');
      fx.git('add', 'side.md');
      fx.git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'side work');
      fx.git('switch', '-q', 'release/test');
      fx.git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
      const head = fx.short('HEAD');
      const before = snapshot(fx);
      const r = fx.resume();
      assertRefusal(
        r,
        otherLineText(fx, { head, headSubject: 'merge side', rel, n: 2, abandon: BOTH(fx) }),
      );
      assertNothingChanged(fx, before);
      for (const c of printedMoveCommands(r.stderr, rel)) runPrinted(fx, c);
      const ok = fx.resume();
      const keptLine = `A branch kept for this release is waiting: release/test-kept-${head} holds 2 commits that are not on release/test. Bring them back now (git merge --no-edit release/test-kept-${head}), then delete the branch (git branch -D release/test-kept-${head}).`;
      assert.deepEqual(stdoutFrom(ok, 'Prepared'), successLines(fx, { extra: [keptLine] }));
      const [merge, branchDelete] = printedKeptCommands(ok.stdout);
      runPrinted(fx, merge);
      const again = fx.resume();
      assert.equal(again.status, 0);
      assert.equal(again.stdout.includes('A branch kept for this release'), false);
      runPrinted(fx, branchDelete);
      assert.equal(readFileSync(join(fx.root, 'side.md'), 'utf-8'), 'side\n');
      assert.equal(
        fx.git('log', '-1', '--format=%s', 'HEAD^1'),
        'chore: begin development after v0.46.0',
      );
      assert.equal(fx.git('log', '-1', '--format=%s', 'HEAD^2'), 'merge side');
    } finally {
      fx.cleanup();
    }
  }
  {
    // 9. a reset that kept the files: the release's own changes are still in them
    const leftOwn = (files) =>
      ` The files the release sets hold its own changes, uncommitted, in ${files.join(', ')} (a reset that kept the files left them there): whichever way you take below, put them back first (git restore --staged --worktree -- ${files.join(' ')}).`;
    {
      const fx = buildFixture('rl63i1');
      try {
        failDevCommit(fx);
        const rel = fx.short('HEAD');
        fx.git('reset', fx.start);
        const before = snapshot(fx);
        const r = fx.resume();
        assertRefusal(
          r,
          beforeText(fx, { head: fx.startShort, rel, left: leftOwn(FILES), abandon: BOTH(fx) }),
        );
        assertNothingChanged(fx, before);
        runPrinted(fx, between(r.stderr, 'put them back first (', ').'));
        assert.equal(fx.git('status', '--porcelain'), '');
        runPrinted(fx, between(r.stderr, `move release/test forward to it (`, ' brings'));
        assertSuccess(fx, fx.resume());
      } finally {
        fx.cleanup();
      }
    }
    {
      // a change of the releaser's in a file: it is set aside, with its version set back
      const fx = buildFixture('rl63i2');
      try {
        failDevCommit(fx);
        const rel = fx.short('HEAD');
        fx.git('reset', fx.start);
        editCoreDescription(fx, 'my own change');
        const eight = FILES.filter((f) => f !== 'packages/core/package.json');
        const yours = ` packages/core/package.json holds a change the release did not make: whichever way you take below, set the version in that file to 0.45.0 and set it aside first (git stash push -- packages/core/package.json); when the release has run, its text names that stash and how to bring it back.`;
        const r = fx.resume();
        assertRefusal(
          r,
          beforeText(fx, {
            head: fx.startShort,
            rel,
            left: leftOwn(eight) + yours,
            abandon: BOTH(fx),
          }),
        );
        runPrinted(fx, between(r.stderr, 'put them back first (', ').'));
        editJson(join(fx.root, 'packages', 'core', 'package.json'), (o) => {
          o.version = '0.45.0';
        });
        runPrinted(fx, between(r.stderr, 'set it aside first (', '); when the release has run'));
        runPrinted(fx, between(r.stderr, `move release/test forward to it (`, ' brings'));
        const ok = fx.resume();
        assert.deepEqual(
          stdoutFrom(ok, 'Prepared'),
          successLines(fx, {
            extra: [
              'A stash made on release/test, which holds packages/core/package.json, is waiting: if it holds changes you set aside for this release, bring them back now (git stash pop; if that conflicts, keep version 0.46.1-dev.0 and your other changes in packages/core/package.json, then run git restore --staged -- packages/core/package.json and git stash drop).',
            ],
          }),
        );
        fx.git('stash', 'pop');
        const pkg = readJson(join(fx.root, 'packages', 'core', 'package.json'));
        assert.equal(pkg.description, 'my own change');
        assert.equal(pkg.version, '0.46.1-dev.0');
      } finally {
        fx.cleanup();
      }
    }
    {
      // a key added to the lockfile: put back, never kept
      const fx = buildFixture('rl63i3');
      try {
        failDevCommit(fx);
        const rel = fx.short('HEAD');
        fx.git('reset', fx.start);
        editJson(lockPath(fx), (o) => {
          o['x-edited-while-stopped'] = true;
        });
        const eight = FILES.filter((f) => f !== LOCK);
        const lockSentence = ` package-lock.json holds changes the release did not make, and npm owns the rest of it: whichever way you take below, put it back first too (git restore --staged --worktree -- package-lock.json); if they came from npm install, run it again after the release.`;
        const r = fx.resume();
        assertRefusal(
          r,
          beforeText(fx, {
            head: fx.startShort,
            rel,
            left: leftOwn(eight) + lockSentence,
            abandon: BOTH(fx),
          }),
        );
        runPrinted(fx, between(r.stderr, 'put them back first (', ').'));
        runPrinted(fx, between(r.stderr, 'put it back first too (', '); if they came from'));
        runPrinted(fx, between(r.stderr, `move release/test forward to it (`, ' brings'));
        assertSuccess(fx, fx.resume());
        assert.equal(
          JSON.parse(fx.git('show', `HEAD:${LOCK}`))['x-edited-while-stopped'],
          undefined,
        );
        assert.equal(readJson(lockPath(fx))['x-edited-while-stopped'], undefined);
      } finally {
        fx.cleanup();
      }
    }
  }
  {
    // 10. a finished release, then a second release stopped, put back onto the first's development commit
    const fx = buildFixture('rl63j');
    try {
      assertSuccess(fx, fx.version());
      const dev0 = fx.git('rev-parse', 'HEAD');
      const hookPath = join(fx.root, '.git', 'hooks', 'commit-msg');
      writeFileSync(
        hookPath,
        '#!/bin/sh\nif grep -q "^chore: begin development" "$1"; then echo "refused" >&2; exit 1; fi\nexit 0\n',
      );
      chmodSync(hookPath, 0o755);
      assert.equal(fx.version('0.46.1').status, 1);
      unlinkSync(hookPath);
      const rel1 = fx.short('HEAD');
      fx.git('reset', '--hard', dev0);
      writeFileSync(join(fx.root, 'notes.md'), 'notes\n');
      fx.git('add', 'notes.md');
      fx.git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fix something');
      const head = fx.short('HEAD');
      const r = fx.resume();
      assertRefusal(
        r,
        otherLineText(fx, {
          head,
          headSubject: 'fix something',
          rel: rel1,
          n: 1,
          abandon: BOTH(fx, '0.46.1'),
          V: '0.46.1',
        }),
      );
      for (const c of printedMoveCommands(r.stderr, rel1)) runPrinted(fx, c);
      const ok = fx.resume();
      assert.equal(ok.status, 0, ok.stderr);
      assert.ok(
        lines(ok.stdout).some((l) =>
          l.startsWith('Prepared v0.46.1 (not pushed or published yet)'),
        ),
        ok.stdout,
      );
      // the kept line also holds v0.46.0's commits, which HEAD holds: no release on it was abandoned
      const keptLine = `A branch kept for this release is waiting: release/test-kept-${head} holds 1 commit that is not on release/test. Bring it back now (git cherry-pick --allow-empty HEAD..release/test-kept-${head}), then delete the branch (git branch -D release/test-kept-${head}).`;
      assert.ok(lines(ok.stdout).includes(keptLine), ok.stdout);
      assert.equal(ok.stdout.includes('abandoned before this one'), false);
      for (const c of printedKeptCommands(ok.stdout)) runPrinted(fx, c);
      assert.equal(fx.git('log', '-1', '--format=%s'), 'fix something');
      assert.equal(
        fx.git('log', '-1', '--format=%s', 'HEAD~1'),
        'chore: begin development after v0.46.1',
      );
    } finally {
      fx.cleanup();
    }
  }
});

// ── RL64-RL65 — stash lines, and the line about uncommitted changes ─────────────────────────

test('RL64 — the success text points at every stash made on the branch, the oldest first', () => {
  const corePath = 'packages/core/package.json';
  const cliPath = 'packages/cli/package.json';
  {
    const fx = buildFixture('rl64a');
    try {
      failDevCommit(fx);
      editCoreDescription(fx);
      fx.git('stash', 'push', '--', corePath);
      fx.git('switch', '-q', '-c', 'other');
      writeFileSync(
        join(fx.root, 'CHANGELOG.md'),
        `${readFileSync(join(fx.root, 'CHANGELOG.md'), 'utf-8')}\nmore\n`,
      );
      fx.git('stash', 'push', '--', 'CHANGELOG.md');
      fx.git('switch', '-q', 'release/test');
      const r = fx.resume();
      assert.deepEqual(
        stdoutFrom(r, 'Prepared'),
        successLines(fx, {
          extra: [
            `A stash made on release/test, which holds ${corePath}, is waiting: if it holds changes you set aside for this release, bring them back now (git stash pop stash@{1}; if that conflicts, keep version 0.46.1-dev.0 and your other changes in ${corePath}, then run git restore --staged -- ${corePath} and git stash drop stash@{1}).`,
          ],
        }),
      );
      fx.git('stash', 'pop', 'stash@{1}');
      assert.equal(
        readJson(join(fx.root, corePath)).description,
        'edited while the release was stopped',
      );
    } finally {
      fx.cleanup();
    }
  }
  {
    // only a stash made on another branch: no line
    const fx = buildFixture('rl64b');
    try {
      failDevCommit(fx);
      fx.git('switch', '-q', '-c', 'other');
      writeFileSync(
        join(fx.root, 'CHANGELOG.md'),
        `${readFileSync(join(fx.root, 'CHANGELOG.md'), 'utf-8')}\nmore\n`,
      );
      fx.git('stash', 'push', '--', 'CHANGELOG.md');
      fx.git('switch', '-q', 'release/test');
      assertSuccess(fx, fx.resume());
    } finally {
      fx.cleanup();
    }
  }
  {
    const fx = buildFixture('rl64c');
    try {
      failDevCommit(fx);
      editCoreDescription(fx);
      editJson(join(fx.root, cliPath), (o) => {
        o.description = 'edited while the release was stopped';
      });
      fx.git('stash', 'push', '--', corePath, cliPath);
      fx.git('switch', '-q', '-c', 'other');
      writeFileSync(join(fx.root, '.gitignore'), 'node_modules\nmore\n');
      fx.git('stash', 'push', '--', '.gitignore');
      fx.git('switch', '-q', 'release/test');
      const changelog = join(fx.root, 'CHANGELOG.md');
      writeFileSync(changelog, `${readFileSync(changelog, 'utf-8')}\nmore\n`);
      fx.git('stash', 'push', '--', 'CHANGELOG.md');
      writeFileSync(join(fx.root, 'notes.txt'), 'notes\n');
      fx.git('stash', 'push', '-u', '--', 'notes.txt');
      fx.git('config', 'stash.showIncludeUntracked', 'true');
      const r = fx.resume();
      assert.equal(r.status, 0, r.stderr);
      const at = r.stdout.split('\n');
      const next = at.indexOf('Next steps:');
      assert.deepEqual(at.slice(next - 4, next), [
        '3 stashes made on release/test are waiting: if they hold changes you set aside for this release, bring them back now, the oldest first:',
        `  git stash pop stash@{3}, which holds ${cliPath}, ${corePath} (if that conflicts, keep version 0.46.1-dev.0 and your other changes in each conflicted file, then run git restore --staged -- ${cliPath} ${corePath} and git stash drop stash@{3})`,
        '  git stash pop stash@{1}, which holds CHANGELOG.md',
        '  git stash pop stash@{0}, which holds untracked notes.txt',
      ]);
      fx.git('stash', 'pop', 'stash@{3}');
      fx.git('stash', 'pop', 'stash@{1}');
      fx.git('stash', 'pop', 'stash@{0}');
      for (const p of [corePath, cliPath]) {
        assert.equal(
          readJson(join(fx.root, p)).description,
          'edited while the release was stopped',
        );
      }
      assert.ok(readFileSync(changelog, 'utf-8').endsWith('\nmore\n'));
      assert.equal(readFileSync(join(fx.root, 'notes.txt'), 'utf-8'), 'notes\n');
      assert.equal(fx.git('stash', 'list').split('\n').length, 1);
      assert.match(fx.git('stash', 'list'), /WIP on other:/);
    } finally {
      fx.cleanup();
    }
  }
});

test('RL65 — the line about uncommitted changes names at most ten paths', () => {
  {
    const fx = buildFixture('rl65a');
    try {
      failDevCommit(fx);
      const names = Array.from({ length: 12 }, (_, i) => `x${String(i + 1).padStart(2, '0')}.txt`);
      for (const n of names) writeFileSync(join(fx.root, n), 'x\n');
      const r = fx.resume();
      assert.deepEqual(
        stdoutFrom(r, 'Prepared'),
        successLines(fx, {
          extra: [
            `This checkout also holds changes that are not committed, in ${names
              .slice(0, 10)
              .map((n) => `untracked ${n}`)
              .join(
                ', ',
              )} and 2 more: they are not part of v0.46.0. Commit them on release/test if the release PR should carry them.`,
          ],
        }),
      );
    } finally {
      fx.cleanup();
    }
  }
  {
    // every kind of path carries its word: modified, renamed, copied, added
    const fx = buildFixture('rl65b');
    try {
      writeFileSync(join(fx.root, 'a.md'), 'alpha 1\nalpha 2\nalpha 3\nalpha 4\n');
      writeFileSync(join(fx.root, 'k.md'), 'kilo 1\nkilo 2\nkilo 3\nkilo 4\n');
      commitLeg(fx, 'two files');
      failDevCommit(fx);
      fx.git('config', 'status.renames', 'copies');
      fx.git('mv', 'a.md', 'a2.md');
      writeFileSync(join(fx.root, 'k2.md'), 'kilo 1\nkilo 2\nkilo 3\nkilo 4\n');
      writeFileSync(join(fx.root, 'k.md'), 'kilo 1\nkilo 2\nkilo 3\nkilo 4\nkilo 5\n');
      writeFileSync(join(fx.root, 'new.md'), 'new\n');
      fx.git('add', 'k.md', 'k2.md', 'new.md');
      writeFileSync(
        join(fx.root, 'CHANGELOG.md'),
        `${readFileSync(join(fx.root, 'CHANGELOG.md'), 'utf-8')}\nmore\n`,
      );
      const r = fx.resume();
      assert.deepEqual(
        stdoutFrom(r, 'Prepared'),
        successLines(fx, {
          extra: [
            'This checkout also holds changes that are not committed, in modified CHANGELOG.md, renamed a.md -> a2.md, modified k.md, copied k.md -> k2.md, added new.md: they are not part of v0.46.0. Commit them on release/test if the release PR should carry them.',
          ],
        }),
      );
    } finally {
      fx.cleanup();
    }
  }
});

test('RL66 — a lockfile npm cannot start from gets the restore text, whatever else is wrong with it', () => {
  const worsen = [
    (fx) => writeFileSync(lockPath(fx), readFileSync(lockPath(fx), 'utf-8') + '\n'),
    (fx) => {
      const lock = readJson(lockPath(fx));
      lock.lockfileVersion = 2;
      writeFileSync(lockPath(fx), lockText(lock));
    },
    (fx) => {
      const lock = readJson(lockPath(fx));
      lock.packages['packages/core'].version = '0.44.0';
      writeFileSync(lockPath(fx), lockText(lock));
    },
  ];
  for (const [i, worse] of worsen.entries()) {
    const fx = buildFixture(`rl66-${i + 1}`);
    try {
      const lock = readJson(lockPath(fx));
      delete lock.packages['packages/testing'];
      writeFileSync(lockPath(fx), lockText(lock));
      worse(fx);
      commitLeg(fx, 'break the lockfile');
      const before = snapshot(fx);
      const r = fx.version();
      assertRefusal(
        r,
        lockRestoreText('it has no entry for packages/testing', fx.short('base-point')),
      );
      assertNothingChanged(fx, before);
      runPrinted(fx, between(r.stderr, 'npm can start from (', '), then bring it up to date'));
      runPrinted(fx, between(r.stderr, 'commit it (', '), then re-run.'));
      assert.equal(fx.git('status', '--porcelain'), '');
      assertSuccess(fx, fx.version());
    } finally {
      fx.cleanup();
    }
  }
});

// ── RL67 — a symbolic link where a version file was ──────────────────────────────────────────

test('RL67 — a file the release sets replaced by a symbolic link is only ever put back', () => {
  const versionTs = 'packages/core/src/version.ts';
  const cliVersionTs = 'packages/cli/src/version.ts';
  const restore = (files) => `git restore --staged --worktree -- ${files.join(' ')}`;
  {
    // 1. a link made during the build
    const fx = buildFixture('rl67a');
    try {
      const r = fx.version('0.46.0', { BUILD_LINK: versionTs });
      assert.equal(r.status, 1);
      assert.equal(
        r.stderr.trimEnd(),
        `Error: The release of v0.46.0 stopped: ${versionTs} was replaced by a symbolic link while the release ran. Every tracked file it changed is restored, except ${versionTs}, which also holds a change the release did not make and is left as it is: put back the file the link replaced (${restore([versionTs])}); ${DIST('0.46.0')} Fix the cause, then re-run: npm run release -- --version 0.46.0`,
      );
      assert.equal(lstatSync(join(fx.root, versionTs)).isSymbolicLink(), true);
      runPrinted(fx, between(r.stderr, 'the link replaced (', '); packages'));
      assert.equal(fx.git('status', '--porcelain'), '');
      assertSuccess(fx, fx.version());
      assert.equal(
        readFileSync(join(fx.home, 'outside-packages_core_src_version.ts'), 'utf-8'),
        "export const VERSION = '0.46.0';\n",
      );
    } finally {
      fx.cleanup();
    }
  }
  {
    // 2. a link and an edit
    const fx = buildFixture('rl67b');
    try {
      const r = fx.version('0.46.0', {
        BUILD_EDIT: 'edited during the build',
        BUILD_LINK: versionTs,
      });
      assert.equal(r.status, 1);
      assert.equal(
        r.stderr.trimEnd(),
        `Error: The release of v0.46.0 stopped: packages/core/package.json changed, and ${versionTs} was replaced by a symbolic link while the release ran. Every tracked file it changed is restored, except packages/core/package.json, ${versionTs}, which also hold changes the release did not make and are left as they are: put back the file the link replaced (${restore([versionTs])}), set the version in the other to 0.45.0, and commit or set aside the rest; ${DIST('0.46.0')} Fix the cause, then re-run: npm run release -- --version 0.46.0`,
      );
    } finally {
      fx.cleanup();
    }
  }
  {
    // 3. two links
    const fx = buildFixture('rl67c');
    try {
      const r = fx.version('0.46.0', { BUILD_LINK: `${cliVersionTs},${versionTs}` });
      assert.equal(r.status, 1);
      assert.equal(
        r.stderr.trimEnd(),
        `Error: The release of v0.46.0 stopped: ${cliVersionTs} was replaced by a symbolic link, and ${versionTs} was replaced by a symbolic link while the release ran. Every tracked file it changed is restored, except ${cliVersionTs}, ${versionTs}, which also hold changes the release did not make and are left as they are: put back the file each link replaced (${restore([cliVersionTs, versionTs])}); ${DIST('0.46.0')} Fix the cause, then re-run: npm run release -- --version 0.46.0`,
      );
      runPrinted(fx, between(r.stderr, 'each link replaced (', '); packages'));
      assert.equal(fx.git('status', '--porcelain'), '');
      assertSuccess(fx, fx.version());
    } finally {
      fx.cleanup();
    }
  }
  {
    // 4. a link made while the entry checks read origin: the release has written nothing
    const fx = buildFixture('rl67d');
    try {
      const path = makeShimDir(fx, 'wrappers');
      const r = fx.version('0.46.0', { PATH: path, LS_REMOTE_BREAK: 'link' });
      assert.equal(r.status, 1);
      assert.equal(
        r.stderr.trimEnd(),
        BEFORE_CHANGING(
          `${versionTs} was replaced by a symbolic link while the release ran. Put back the file the link replaced (${restore([versionTs])}), then re-run: npm run release -- --version 0.46.0`,
        ),
      );
      runPrinted(fx, between(r.stderr, 'the link replaced (', '), then re-run'));
      assert.equal(fx.git('status', '--porcelain'), '');
      assertSuccess(fx, fx.version());
      assert.equal(
        readFileSync(join(fx.home, 'outside-version.ts'), 'utf-8'),
        "export const VERSION = '0.45.0';\n",
      );
    } finally {
      fx.cleanup();
    }
  }
  {
    // 5. a link and an edit while the entry checks read origin
    const fx = buildFixture('rl67e');
    try {
      const path = makeShimDir(fx, 'wrappers');
      const r = fx.version('0.46.0', { PATH: path, LS_REMOTE_BREAK: 'link-and-edit' });
      assert.equal(r.status, 1);
      assert.equal(
        r.stderr.trimEnd(),
        BEFORE_CHANGING(
          `packages/core/package.json changed, and ${versionTs} was replaced by a symbolic link while the release ran. Put back the file the link replaced (${restore([versionTs])}), then commit, stash or discard the rest (${restore(['packages/core/package.json'])} discards it), then re-run: npm run release -- --version 0.46.0`,
        ),
      );
    } finally {
      fx.cleanup();
    }
  }
  {
    // 6. --resume: a link comes first, alone; then the edit
    const fx = buildFixture('rl67f');
    try {
      failDevCommit(fx);
      editCoreDescription(fx);
      const copy = join(fx.home, 'outside-version.ts');
      copyFileSync(join(fx.root, versionTs), copy);
      unlinkSync(join(fx.root, versionTs));
      symlinkSync(copy, join(fx.root, versionTs));
      const before = snapshot(fx);
      const r = fx.resume();
      assert.equal(r.status, 1);
      assert.equal(
        r.stderr.trimEnd(),
        [
          'Error: Resuming would overwrite a symbolic link that replaced a file the release sets, in:',
          `  ${versionTs}`,
          `A file the release sets cannot be kept as a link: put back the file the link replaced (${restore([versionTs])}), then re-run: npm run release -- --resume`,
        ].join('\n'),
      );
      assertNothingChanged(fx, before);
      runPrinted(fx, between(r.stderr, 'the link replaced (', '), then re-run'));
      assertRefusal(
        fx.resume(),
        refusalText(
          OVERWRITE,
          ['packages/core/package.json'],
          TAGGED_KEEP('', 'packages/core/package.json', 'that file'),
        ),
      );
      fx.git('restore', '--staged', '--worktree', '--', 'packages/core/package.json');
      assertSuccess(fx, fx.resume());
      assert.equal(readFileSync(copy, 'utf-8'), "export const VERSION = '0.46.0';\n");
    } finally {
      fx.cleanup();
    }
  }
});

// ── RL68 — a link or CRLF line ends at entry: a remedy that works ────────────────────────────

test('RL68 — a file the release sets that is a symbolic link, or has CRLF line ends, is refused at entry with a remedy that works', () => {
  {
    const fx = buildFixture('rl68a');
    try {
      const versionTs = 'packages/core/src/version.ts';
      const copy = join(fx.home, 'outside-version.ts');
      copyFileSync(join(fx.root, versionTs), copy);
      unlinkSync(join(fx.root, versionTs));
      symlinkSync(copy, join(fx.root, versionTs));
      commitLeg(fx, 'a link');
      const before = snapshot(fx);
      const r = fx.version();
      assertRefusal(r, linkText(versionTs));
      assertNothingChanged(fx, before);
      runPrinted(fx, between(r.stderr, 'holding its content (', '), commit it'));
      runPrinted(fx, between(r.stderr, 'commit it (', '), then re-run.'));
      assert.equal(fx.git('status', '--porcelain'), '');
      assertSuccess(fx, fx.version());
      assert.equal(readFileSync(copy, 'utf-8'), "export const VERSION = '0.45.0';\n");
    } finally {
      fx.cleanup();
    }
  }
  {
    const fx = buildFixture('rl68b');
    try {
      const f = 'packages/core/src/version.ts';
      writeFileSync(
        join(fx.root, f),
        readFileSync(join(fx.root, f), 'utf-8').replaceAll('\n', '\r\n'),
      );
      fx.git('add', '-A');
      fx.git(
        '-c',
        'core.autocrlf=false',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '-m',
        'crlf',
      );
      const before = snapshot(fx);
      const r = fx.version();
      assertRefusal(r, crlfCommitText(f));
      assertNothingChanged(fx, before);
      runPrinted(fx, between(r.stderr, 'Convert it to LF (', '), commit it'));
      runPrinted(fx, between(r.stderr, 'commit it (', '), then re-run.'));
      assert.equal(fx.git('status', '--porcelain'), '');
      assertSuccess(fx, fx.version());
    } finally {
      fx.cleanup();
    }
  }
  {
    const fx = buildFixture('rl68c');
    try {
      fx.git('config', 'core.autocrlf', 'true');
      fx.git('rm', '-r', '-q', '--cached', '.');
      fx.git('reset', '-q', '--hard');
      assert.ok(
        readFileSync(join(fx.root, 'packages', 'cli', 'package.json'), 'utf-8').includes('\r\n'),
      );
      assert.equal(fx.git('status', '--porcelain'), '');
      const before = snapshot(fx);
      const r = fx.version();
      assertRefusal(r, crlfCheckoutText('packages/cli/package.json'));
      assertNothingChanged(fx, before);
      const printed = between(r.stderr, 'Make a checkout with LF line ends (', '), then re-run.');
      for (const part of printed.split(', then ')) runPrinted(fx, part);
      assertSuccess(fx, fx.version());
    } finally {
      fx.cleanup();
    }
  }
});

// ── RL69-RL71 ───────────────────────────────────────────────────────────────────────────────

test('RL69 — HEAD moved while the build ran', async () => {
  const MOVED = (start, head) =>
    `HEAD moved while the release ran, from ${start} to ${head} "a commit made during the build"`;
  const restoredOnly = `Every tracked file it changed is restored; ${DIST('0.46.0')}`;
  {
    // 1.
    const fx = buildFixture('rl69a');
    try {
      const r = fx.version('0.46.0', { BUILD_COMMIT: 'a commit made during the build' });
      const head = fx.short('HEAD');
      assert.equal(r.status, 1);
      assert.equal(progressLines(r).at(-1), '→ Staging the version files');
      assert.equal(
        r.stderr.trimEnd(),
        `Error: The release of v0.46.0 stopped: ${MOVED(fx.startShort, head)}. ${restoredOnly} Re-run to release ${head}: npm run release -- --version 0.46.0`,
      );
      assert.equal(fx.git('status', '--porcelain'), '');
      assertNoRelease(fx);
      assertSuccess(fx, fx.version());
      assert.equal(fx.short('v0.46.0^'), head);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 2.
    const fx = buildFixture('rl69b');
    try {
      const r = fx.version('0.46.0', {
        BUILD_COMMIT: 'a commit made during the build',
        BUILD_FAIL: '3',
      });
      const head = fx.short('HEAD');
      assert.equal(r.status, 1);
      assert.ok(
        lines(r.stderr).includes(
          `Error: The release of v0.46.0 stopped: the build failed (exit 3; its message is above), and ${MOVED(fx.startShort, head)}. ${restoredOnly} Fix the cause, then re-run to release ${head}: npm run release -- --version 0.46.0`,
        ),
        r.stderr,
      );
      assert.equal(fx.git('status', '--porcelain'), '');
      assert.equal(existsSync(fx.journalPath), false);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 3. interrupted
    await interruptDuringBuild(
      'rl69c',
      { BUILD_COMMIT: 'a commit made during the build' },
      (fx, err) => {
        const head = fx.short('HEAD');
        assert.ok(
          err.includes(
            `Error: The release of v0.46.0 was interrupted (SIGTERM), and ${MOVED(fx.startShort, head)}. ${restoredOnly} To release ${head}, re-run: npm run release -- --version 0.46.0`,
          ),
          err.join('\n'),
        );
        assert.equal(fx.git('status', '--porcelain'), '');
        assert.equal(existsSync(fx.journalPath), false);
      },
    );
  }
  {
    // 4. a commit that takes the release's own changes: the cannot-continue text
    const fx = buildFixture('rl69d');
    try {
      const r = fx.version('0.46.0', { BUILD_COMMIT_ALL: 'a commit of every change' });
      const head = fx.short('HEAD');
      assert.equal(r.status, 1);
      assert.equal(
        r.stderr.trimEnd(),
        `Error: The unfinished v0.46.0 release cannot continue from here: release/test is at ${head} "a commit of every change". It can start again from ${fx.startShort}, where it started: put release/test back there (git reset ${fx.startShort} keeps the current files, with the differences unstaged), then run npm run release -- --resume to put back the files the release changed, and re-run: npm run release -- --version 0.46.0. The reset takes ${head} off release/test; its changes stay in your files, uncommitted.`,
      );
      assert.equal(existsSync(fx.journalPath), true);
      assert.equal(fx.tryGit('rev-parse', '-q', '--verify', 'refs/tags/v0.46.0'), null);
      fx.git('reset', fx.startShort);
      const restored = fx.resume();
      assert.equal(restored.status, 1);
      assert.ok(restored.stderr.includes('It restored the 9 files the release sets'));
      assertSuccess(fx, fx.version());
    } finally {
      fx.cleanup();
    }
  }
  {
    // 5. something else is uncommitted
    const fx = buildFixture('rl69e');
    try {
      const r = fx.version('0.46.0', {
        BUILD_COMMIT: 'a commit made during the build',
        BUILD_EDIT_OTHER: '1',
      });
      const head = fx.short('HEAD');
      assert.equal(r.status, 1);
      assert.equal(
        r.stderr.trimEnd(),
        `Error: The release of v0.46.0 stopped: ${MOVED(fx.startShort, head)}. Every tracked file it changed is restored; this checkout also holds changes that are not committed, in modified packages/engine-tests/package.json, and the re-run needs a clean checkout: commit, stash or remove them; ${DIST('0.46.0')} Re-run to release ${head}: npm run release -- --version 0.46.0`,
      );
    } finally {
      fx.cleanup();
    }
  }
  {
    // 6. a file changed and HEAD moved: the staging step checks the files before HEAD
    const fx = buildFixture('rl69f');
    try {
      const r = fx.version('0.46.0', {
        BUILD_COMMIT: 'a commit made during the build',
        BUILD_EDIT: 'edited during the build',
      });
      const head = fx.short('HEAD');
      assert.equal(r.status, 1);
      assert.equal(
        r.stderr.trimEnd(),
        `Error: The release of v0.46.0 stopped: ${CHANGED_CORE}, and ${MOVED(fx.startShort, head)}. ${EXCEPT_CORE} ${DIST('0.46.0')} Fix the cause, then re-run to release ${head}: npm run release -- --version 0.46.0`,
      );
      assert.equal(existsSync(fx.journalPath), false);
    } finally {
      fx.cleanup();
    }
  }
});

test('RL70 — after a restore, the text that says to re-run names what else is uncommitted', async () => {
  {
    const fx = buildFixture('rl70a');
    try {
      const r = fx.version('0.46.0', { BUILD_EDIT_OTHER: '1', BUILD_FAIL: '3' });
      assert.equal(r.status, 1);
      assert.ok(
        lines(r.stderr).includes(
          `Error: The release of v0.46.0 stopped: the build failed (exit 3; its message is above). Every tracked file it changed is restored; this checkout also holds changes that are not committed, in modified packages/engine-tests/package.json, and the re-run needs a clean checkout: commit, stash or remove them; ${DIST('0.46.0')} Fix the cause, then re-run: npm run release -- --version 0.46.0`,
        ),
        r.stderr,
      );
    } finally {
      fx.cleanup();
    }
  }
  {
    const fx = buildFixture('rl70b');
    try {
      await crashDuringBuild(fx, { BUILD_EDIT_OTHER: '1' });
      const r = fx.resume();
      assert.equal(r.status, 1);
      assert.equal(r.stdout, '');
      assert.equal(
        r.stderr.trimEnd(),
        `Error: The unfinished v0.46.0 release stopped before its release commit, so --resume cannot finish it. It restored the 9 files the release sets to their content at ${fx.startShort}. packages/*/dist may still hold its v0.46.0 build: run npm run build before using this checkout. This checkout also holds changes that are not committed, in modified packages/engine-tests/package.json, and the re-run needs a clean checkout: commit, stash or remove them. Re-run: npm run release -- --version 0.46.0`,
      );
    } finally {
      fx.cleanup();
    }
  }
});

test('RL71 — the success text says what to do when bringing the stash back conflicts', () => {
  {
    const fx = buildFixture('rl71a');
    try {
      failDevCommit(fx);
      const versionTs = join(fx.root, 'packages', 'core', 'src', 'version.ts');
      writeFileSync(
        versionTs,
        "export const VERSION = '0.46.0';\nexport const EDITED = 'while the release was stopped';\n",
      );
      fx.git('stash', 'push', '--', 'packages/core/src/version.ts');
      const r = fx.resume();
      const vts = 'packages/core/src/version.ts';
      assert.deepEqual(
        stdoutFrom(r, 'Prepared'),
        successLines(fx, {
          extra: [
            `A stash made on release/test, which holds ${vts}, is waiting: if it holds changes you set aside for this release, bring them back now (git stash pop; if that conflicts, keep version 0.46.1-dev.0 and your other changes in ${vts}, then run git restore --staged -- ${vts} and git stash drop).`,
          ],
        }),
      );
      assert.throws(
        () => fx.git('stash', 'pop'),
        'the pop must conflict, or this leg tests nothing',
      );
      writeFileSync(
        versionTs,
        "export const VERSION = '0.46.1-dev.0';\nexport const EDITED = 'while the release was stopped';\n",
      );
      const clause = between(r.stdout, 'then run ', ').');
      const [restoreCommand, dropCommand] = clause.split(' and ');
      runPrinted(fx, restoreCommand);
      runPrinted(fx, dropCommand);
      assert.equal(fx.gitRaw('status', '--porcelain'), ' M packages/core/src/version.ts\n');
      assert.equal(fx.git('stash', 'list'), '');
    } finally {
      fx.cleanup();
    }
  }
  {
    const fx = buildFixture('rl71b');
    try {
      failDevCommit(fx);
      writeFileSync(join(fx.root, 'notes.txt'), 'notes\n');
      fx.git('stash', 'push', '-u', '--', 'notes.txt');
      fx.git('config', 'stash.showIncludeUntracked', 'true');
      const r = fx.resume();
      assert.deepEqual(
        stdoutFrom(r, 'Prepared'),
        successLines(fx, {
          extra: [
            'A stash made on release/test, which holds untracked notes.txt, is waiting: if it holds changes you set aside for this release, bring them back now (git stash pop).',
          ],
        }),
      );
    } finally {
      fx.cleanup();
    }
  }
});

// ── RL72-RL76 — an unfinished or prepared release no journal records ──────────────────────────

const RESET_KEEP = (s) =>
  `(git reset --keep ${s} brings its files too, and refuses rather than overwrite a change of yours)`;
/** C1.14's `<where>`, for a release that started at `start` (`base`). */
const putBack = (start, tail = '') =>
  `: put the branch back at ${start} "base", where it started ${RESET_KEEP(start)}${tail}`;
/** `, which takes <the commits> after <after> off it too (to keep <them>, run …)`. */
function takesOff({ n, after, head, branch = 'release/test' }) {
  const the = n === 1 ? 'the 1 commit' : `the ${n} commits`;
  const them = n === 1 ? 'it' : 'them';
  const back = n === 1 ? 'it' : 'them';
  return `, which takes ${the} after ${after} off it too (to keep ${them}, run git branch ${branch}-kept-${head} ${head} first: when the release has run again, its text says how to bring ${back} back)`;
}
const WAY_OUT = (where, x = '0.46.0') =>
  `Finish it by hand (Part B step 3, "To finish an unfinished release by hand"), then go on with Part B step 4. Or abandon it (Part B step 3, "To abandon an unfinished release"${where}), then re-run: npm run release -- --version ${x}`;
const FINISH = (tag, stay, where, x = '0.46.0') =>
  `Finish it: ${tag}, then go on with Part B step 4${stay}. Or abandon it (Part B step 3, "To abandon an unfinished release"${where}), then re-run: npm run release -- --version ${x}`;
const capital = (s) => s[0].toUpperCase() + s.slice(1);
const RESUME_NAMES = (what, out) =>
  `Error: There is no release journal to resume from, but ${what}: its release is unfinished. ${out}`;
const VERSION_NAMES = (what, out) =>
  `Error: ${capital(what)}: its release is unfinished, and no release journal records it. ${out}`;
const NO_RELEASE = 'Error: There is no unfinished release to resume.';
const PREPARED_RESUME = (rel, where, V = '0.46.0') =>
  `There is no unfinished release to resume: v${V} is prepared here (its release commit ${rel} is tagged v${V}, and ${where}). Go on with Part B step 4.`;
const PREPARED_VERSION = (rel, where, V = '0.46.0') =>
  `v${V} is already prepared here: its release commit ${rel} is tagged v${V}, and ${where}. Nothing is left to run: go on with Part B step 4.`;
const AFTER_DEV = (n, dev) =>
  n === 0
    ? 'HEAD is its development commit'
    : `HEAD is ${n} commit${n === 1 ? '' : 's'} after its development commit ${dev}`;
const RELEASE_SUBJECT = 'chore: release v0.46.0';
const DEV_SUBJECT = 'chore: begin development after v0.46.0';
const emptyCommit = (fx, message) =>
  fx.git('-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', message);

/** A finished release (the success text), then its three shorts: `{ rel, dev }`. */
function finishRelease(fx) {
  assertSuccess(fx, fx.version());
  assert.equal(existsSync(fx.journalPath), false, 'a finished release leaves no journal');
  return { rel: fx.short('HEAD~1'), dev: fx.short('HEAD') };
}
/** Exit 0, nothing on stderr, and `stdout` as the whole of the lines printed. */
function assertPrinted(r, expected) {
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stderr, '');
  assert.deepEqual(lines(r.stdout), expected);
}
function assertPreparedNow(fx, r) {
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.ok(
    lines(r.stdout).some((l) => l.startsWith('Prepared v0.46.1 (not pushed or published yet)')),
    r.stdout,
  );
}

test('RL72 — HEAD is a commit of an unfinished release no journal records: refused, naming it, where it started and both ways out', () => {
  {
    // 1. the fourth walk's half-done abandon
    const fx = buildFixture('rl72a');
    try {
      failDevCommit(fx);
      const rel = fx.short('HEAD');
      fx.git('tag', '-d', 'v0.46.0');
      unlinkSync(fx.journalPath);
      const what = `HEAD is ${rel} "${RELEASE_SUBJECT}", the release commit of v0.46.0, not tagged v0.46.0`;
      const out = WAY_OUT(putBack(fx.startShort));
      const before = snapshot(fx);
      assertRefusal(fx.resume(), RESUME_NAMES(what, out));
      assertRefusal(fx.version(), VERSION_NAMES(what, out));
      assertRefusal(fx.version('0.46.1'), VERSION_NAMES(what, out));
      assertNothingChanged(fx, before);
      writeFileSync(join(fx.root, 'notes.txt'), 'notes\n');
      const dirty = snapshot(fx);
      assertRefusal(fx.resume(), RESUME_NAMES(what, out));
      assertRefusal(fx.version(), VERSION_NAMES(what, out));
      assertNothingChanged(fx, dirty);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 2. only the tag is missing
    const fx = buildFixture('rl72b');
    try {
      const { rel, dev } = finishRelease(fx);
      fx.git('tag', '-d', 'v0.46.0');
      const words = `HEAD is ${dev} "${DEV_SUBJECT}", the development commit after v0.46.0, whose parent ${rel} "${RELEASE_SUBJECT}" is not tagged v0.46.0`;
      const tagCommand = `git tag --no-sign v0.46.0 ${rel}`;
      const finish = FINISH(`tag ${rel} (${tagCommand})`, '', putBack(fx.startShort));
      const before = snapshot(fx);
      assertRefusal(fx.resume(), RESUME_NAMES(words, finish));
      assertRefusal(fx.version('0.46.1'), VERSION_NAMES(words, finish));
      assertNothingChanged(fx, before);

      // a tag naming another commit
      fx.git('tag', '--no-sign', 'v0.46.0', fx.startShort);
      const deleteTag = 'git tag -d v0.46.0';
      const finish2 = FINISH(
        `delete tag v0.46.0, which names ${fx.startShort} "base" (${deleteTag}), then tag ${rel} (${tagCommand})`,
        '',
        putBack(fx.startShort, `, then delete its tag (${deleteTag})`),
      );
      assertRefusal(fx.resume(), RESUME_NAMES(words, finish2));

      // a tag that names a tree
      fx.git('tag', '-f', '--no-sign', 'v0.46.0', 'HEAD^{tree}');
      const finish3 = FINISH(
        `delete tag v0.46.0, which names no commit (${deleteTag}), then tag ${rel} (${tagCommand})`,
        '',
        putBack(fx.startShort, `, then delete its tag (${deleteTag})`),
      );
      const r3 = fx.resume();
      assertRefusal(r3, RESUME_NAMES(words, finish3));
      // the printed tag commands, each inside `(git tag …)`, run as printed
      runPrinted(
        fx,
        between(r3.stderr, 'delete tag v0.46.0, which names no commit (', '), then tag'),
      );
      runPrinted(fx, between(r3.stderr, `then tag ${rel} (`, '), then go on'));
      assertPrinted(fx.resume(), [PREPARED_RESUME(rel, AFTER_DEV(0, dev))]);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 3. two empty commits on base: the second fails the test on its parent
    const fx = buildFixture('rl72c');
    try {
      emptyCommit(fx, 'an unrelated commit');
      emptyCommit(fx, DEV_SUBJECT);
      const before = snapshot(fx);
      assertRefusal(fx.resume(), NO_RELEASE);
      assertNothingChanged(fx, before);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 4. a finished release: prepared, exit 0; then a branch at its release commit
    const fx = buildFixture('rl72d');
    try {
      const { rel, dev } = finishRelease(fx);
      const before = snapshot(fx);
      const r = fx.resume();
      assertPrinted(r, [PREPARED_RESUME(rel, AFTER_DEV(0, dev))]);
      const v = fx.version();
      assertPrinted(v, [PREPARED_VERSION(rel, AFTER_DEV(0, dev))]);
      assertNothingChanged(fx, before);
      fx.git('switch', '-q', '-c', 'release/next', 'v0.46.0');
      assertPreparedNow(fx, fx.version('0.46.1'));
    } finally {
      fx.cleanup();
    }
  }
  {
    // 5. the next release starts from the development commit
    const fx = buildFixture('rl72e');
    try {
      finishRelease(fx);
      assertPreparedNow(fx, fx.version('0.46.1'));
    } finally {
      fx.cleanup();
    }
  }
  {
    // 6. a tag on a commit that is no release commit, then a development subject; then a version that is not final
    const fx = buildFixture('rl72f');
    try {
      fx.git('tag', '--no-sign', 'v0.46.0');
      emptyCommit(fx, DEV_SUBJECT);
      assertRefusal(fx.resume(), NO_RELEASE);
      emptyCommit(fx, 'chore: release v0.47');
      const before = snapshot(fx);
      assertRefusal(fx.resume(), NO_RELEASE);
      assertNothingChanged(fx, before);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 7. the seventh and eighth walks' states
    const fx = buildFixture('rl72g');
    try {
      const { rel, dev } = finishRelease(fx);
      emptyCommit(fx, 'a commit on top');
      const head = fx.short('HEAD');
      fx.git('tag', '-d', 'v0.46.0');
      const words = `HEAD is ${head} "a commit on top", 1 commit after ${dev} "${DEV_SUBJECT}", the development commit after v0.46.0, whose parent ${rel} "${RELEASE_SUBJECT}" is not tagged v0.46.0`;
      const tagCommand = `git tag --no-sign v0.46.0 ${rel}`;
      const finish = FINISH(
        `tag ${rel} (${tagCommand})`,
        '; the commits after its development commit stay as they are',
        putBack(fx.startShort, takesOff({ n: 1, after: dev, head })),
      );
      const before = snapshot(fx);
      assertRefusal(fx.resume(), RESUME_NAMES(words, finish));
      assertRefusal(fx.version(), VERSION_NAMES(words, finish));
      assertRefusal(fx.version('0.46.1'), VERSION_NAMES(words, finish));
      assertNothingChanged(fx, before);
      runPrinted(fx, tagCommand);
      assert.equal(fx.short('HEAD'), head);
      assertPrinted(fx.resume(), [PREPARED_RESUME(rel, AFTER_DEV(1, dev))]);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 8. two commits after the release commit; then a detached HEAD
    const fx = buildFixture('rl72h');
    try {
      failDevCommit(fx);
      const rel = fx.short('HEAD');
      fx.git('tag', '-d', 'v0.46.0');
      unlinkSync(fx.journalPath);
      emptyCommit(fx, 'a commit on top');
      emptyCommit(fx, 'another commit on top');
      const head = fx.short('HEAD');
      const what = `HEAD is ${head} "another commit on top", 2 commits after ${rel} "${RELEASE_SUBJECT}", the release commit of v0.46.0, not tagged v0.46.0`;
      const out = (branch) =>
        WAY_OUT(putBack(fx.startShort, takesOff({ n: 2, after: rel, head, branch })));
      const before = snapshot(fx);
      assertRefusal(fx.resume(), RESUME_NAMES(what, out('release/test')));
      assertRefusal(fx.version(), VERSION_NAMES(what, out('release/test')));
      assertNothingChanged(fx, before);
      fx.git('checkout', '-q', '--detach');
      const detached = snapshot(fx);
      assertRefusal(fx.resume(), RESUME_NAMES(what, out('release/v0.46.0')));
      assertNothingChanged(fx, detached);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 9. a tagged release commit with no development commit
    const fx = buildFixture('rl72i');
    try {
      failDevCommit(fx);
      const rel = fx.short('HEAD');
      unlinkSync(fx.journalPath);
      const deleteTag = ', then delete its tag (git tag -d v0.46.0)';
      const what = `HEAD is ${rel} "${RELEASE_SUBJECT}", the release commit of v0.46.0, tagged v0.46.0, with no development commit after it`;
      const out = WAY_OUT(putBack(fx.startShort, deleteTag));
      const before = snapshot(fx);
      assertRefusal(fx.resume(), RESUME_NAMES(what, out));
      assertRefusal(fx.version(), VERSION_NAMES(what, out));
      assertRefusal(fx.version('0.46.1'), VERSION_NAMES(what, out));
      assertNothingChanged(fx, before);
      emptyCommit(fx, 'a commit on top');
      const head = fx.short('HEAD');
      const what2 = `HEAD is ${head} "a commit on top", 1 commit after ${rel} "${RELEASE_SUBJECT}", the release commit of v0.46.0, tagged v0.46.0, with no development commit after it`;
      const out2 = WAY_OUT(
        putBack(fx.startShort, takesOff({ n: 1, after: rel, head }) + deleteTag),
      );
      assertRefusal(fx.resume(), RESUME_NAMES(what2, out2));
      assertRefusal(fx.version(), VERSION_NAMES(what2, out2));
    } finally {
      fx.cleanup();
    }
  }
  {
    // 10. a finished release with a commit on top: prepared, with the changes that are not committed named
    const fx = buildFixture('rl72j');
    try {
      const { rel, dev } = finishRelease(fx);
      writeFileSync(join(fx.root, 'old.md'), 'old\n');
      fx.git('add', 'old.md');
      fx.git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'a commit on top');
      const where = AFTER_DEV(1, dev);
      const before = snapshot(fx);
      assertPrinted(fx.resume(), [PREPARED_RESUME(rel, where)]);
      assertPrinted(fx.version(), [PREPARED_VERSION(rel, where)]);
      assertNothingChanged(fx, before);

      const changelog = join(fx.root, 'CHANGELOG.md');
      writeFileSync(changelog, `${readFileSync(changelog, 'utf-8')}\nmore\n`);
      fx.git('stash', 'push', '-q', '--', 'CHANGELOG.md');
      writeFileSync(join(fx.root, 'notes.txt'), 'notes\n');
      unlinkSync(join(fx.root, 'old.md'));
      const extra = [
        'This checkout also holds changes that are not committed, in deleted old.md, untracked notes.txt: they are not part of v0.46.0. Commit them on release/test if the release PR should carry them.',
        'A stash made on release/test, which holds CHANGELOG.md, is waiting: if it holds changes you set aside for this release, bring them back now (git stash pop).',
      ];
      const dirty = snapshot(fx);
      assertPrinted(fx.resume(), [PREPARED_RESUME(rel, where), ...extra]);
      assertPrinted(fx.version(), [PREPARED_VERSION(rel, where), ...extra]);
      assertNothingChanged(fx, dirty);

      unlinkSync(join(fx.root, 'notes.txt'));
      fx.git('checkout', '--', 'old.md');
      fx.git('stash', 'drop', '-q');
      assertPreparedNow(fx, fx.version('0.46.1'));
    } finally {
      fx.cleanup();
    }
  }
});

// ── RL73 — Part B step 3, item 5 ─────────────────────────────────────────────────────────────

const INSTRUCTIONS_FILE = join(
  scriptPath('release.mjs'),
  '..',
  '..',
  '.github',
  'instructions',
  'pre-publication.instructions.md',
);
/** Item 5's `bash` block (its lines with the three-space indent removed) and the commit command. */
function itemFive() {
  const all = readFileSync(INSTRUCTIONS_FILE, 'utf-8').split('\n');
  const five = all.findIndex((l) => l.startsWith('5. At `chore: release v<version>`'));
  const six = all.findIndex((l, i) => i > five && l.startsWith('6. '));
  assert.ok(five !== -1 && six > five, 'item 5 and item 6');
  const item = all.slice(five, six);
  const open = item.findIndex((l) => l === '   ```bash');
  assert.notEqual(open, -1, 'item 5 has no bash block');
  const close = item.findIndex((l, i) => i > open && l === '   ```');
  assert.ok(close > open, 'the bash block closes');
  const block = item.slice(open + 1, close).map((l) => l.replace(/^ {3}/, ''));
  assert.equal(block.at(-1), "'", "the block's last line is '");
  assert.equal(/X\.Y\.Z/.test(block.join('\n')), false, 'the block holds no X.Y.Z');
  const after = item.slice(close + 1).join('\n');
  const m = /Commit only those files: `([^`]+)`/.exec(after);
  assert.ok(m, 'the commit command follows the block, before item 6');
  return { block: block.join('\n'), commit: m[1] };
}
function runBlock(fx, block) {
  return spawnSync('sh', ['-c', block], { cwd: fx.root, env: fx.env, encoding: 'utf-8' });
}

test('RL73 — Part B step 3 item 5 sets the development version exactly as the release does', () => {
  const { block, commit } = itemFive();
  const commitCommand = commit.replace('<version>', '0.46.0');
  const atHead = (fx) => FILES.map((f) => readFileSync(join(fx.root, f), 'utf-8'));
  const first = buildFixture('rl73a');
  const second = buildFixture('rl73b');
  const third = buildFixture('rl73c');
  try {
    // the block and the commit command by hand, then the script's own --resume
    failDevCommit(first);
    unlinkSync(first.journalPath);
    const r = runBlock(first, block);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'Set 4 packages to 0.46.1-dev.0.');
    runPrinted(first, commitCommand);
    failDevCommit(second);
    assertSuccess(second, second.resume());
    for (const fx of [first, second]) {
      assert.equal(fx.git('log', '-1', '--format=%s'), DEV_SUBJECT);
      assert.equal(fx.git('status', '--porcelain'), '');
    }
    const names = (fx) => fx.git('diff', '--name-only', 'HEAD~1', 'HEAD').split('\n');
    assert.deepEqual(names(first), names(second));
    assert.equal(names(first).length, 9);
    assert.deepEqual(atHead(first), atHead(second));

    // at the development commit the block refuses, and writes nothing
    const before = snapshot(second);
    const again = runBlock(second, block);
    assert.equal(again.status, 1);
    assert.equal(
      again.stderr.trimEnd(),
      'The packages are at 0.46.1-dev.0, not a released version: run this at the release commit (item 5).',
    );
    assertNothingChanged(second, before);

    // a change of the releaser's in each kind of file the commit takes
    failDevCommit(third);
    unlinkSync(third.journalPath);
    const touched = [
      'package-lock.json',
      'packages/cli/package.json',
      'packages/core/src/version.ts',
    ];
    for (const f of touched)
      writeFileSync(join(third.root, f), `${readFileSync(join(third.root, f), 'utf-8')}\n`);
    const contents = touched.map((f) => readFileSync(join(third.root, f), 'utf-8'));
    const dirty = snapshot(third);
    const held = runBlock(third, block);
    assert.equal(held.status, 1);
    assert.equal(
      held.stderr.trimEnd(),
      [
        'These files hold changes that are not committed, which the commit of item 5 would take:',
        'package-lock.json',
        'packages/cli/package.json',
        'packages/core/src/version.ts',
        'Set them aside first (git stash push -- package-lock.json packages/cli/package.json packages/core/src/version.ts), then run this command again; item 7 brings them back.',
      ].join('\n'),
    );
    assert.deepEqual(
      touched.map((f) => readFileSync(join(third.root, f), 'utf-8')),
      contents,
    );
    assertNothingChanged(third, dirty);
    assert.equal(
      third.gitRaw('status', '--porcelain'),
      ' M package-lock.json\n M packages/cli/package.json\n M packages/core/src/version.ts\n',
    );
  } finally {
    first.cleanup();
    second.cleanup();
    third.cleanup();
  }
});

// ── RL74 — only the branch's own first-parent line; commits counted as git log lists them ────

test('RL74 — the commits of a release the script finds are the branch own, and HEAD is counted after one as git log lists it', () => {
  {
    // 1. a release PR merged with a merge commit: the next release branch made from the merge
    const fx = buildFixture('rl74a');
    try {
      finishRelease(fx);
      fx.git('switch', '-q', '-c', 'merged', fx.startShort);
      fx.git(
        'merge',
        '-q',
        '--no-ff',
        '-m',
        'Merge pull request #1 from release/test',
        'release/test',
      );
      fx.git('switch', '-q', '-c', 'release/next');
      const before = snapshot(fx);
      assertRefusal(fx.resume(), NO_RELEASE);
      assertNothingChanged(fx, before);
      assertPreparedNow(fx, fx.version('0.46.1'));
    } finally {
      fx.cleanup();
    }
  }
  {
    // 2. a merge among the commits after the development commit: three, as git log lists them
    const fx = buildFixture('rl74b');
    try {
      const { rel, dev } = finishRelease(fx);
      fx.git('switch', '-q', '-c', 'side');
      emptyCommit(fx, 'side one');
      emptyCommit(fx, 'side two');
      fx.git('switch', '-q', 'release/test');
      fx.git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
      assert.equal(fx.git('log', '--oneline', `${dev}..HEAD`).split('\n').length, 3);
      const before = snapshot(fx);
      assertPrinted(fx.resume(), [PREPARED_RESUME(rel, AFTER_DEV(3, dev))]);
      assertNothingChanged(fx, before);
    } finally {
      fx.cleanup();
    }
  }
});

// ── RL75 — a commit is a commit of a release only if it holds what the release writes ───────

test('RL75 — with no journal, a commit is a commit of a release only if it holds what the release writes', () => {
  const DELETE_TAG = ', then delete its tag (git tag -d v0.46.0)';
  const AMENDED = "export const VERSION = '0.46.9-dev.0';\n";
  const amendDevelopmentCommit = (fx) => {
    writeFileSync(join(fx.root, 'packages', 'cli', 'src', 'version.ts'), AMENDED);
    fx.git(
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--amend',
      '--no-edit',
      '--',
      'packages/cli/src/version.ts',
    );
  };
  {
    // 1. a development commit amended to a VERSION the release never writes
    const fx = buildFixture('rl75a');
    try {
      finishRelease(fx);
      amendDevelopmentCommit(fx);
      const head = fx.short('HEAD');
      const what = `HEAD is ${head} "${DEV_SUBJECT}", which has the subject of the development commit after v0.46.0 but holds changes the release does not make, in packages/cli/src/version.ts`;
      const out = WAY_OUT(putBack(fx.startShort, DELETE_TAG));
      const before = snapshot(fx);
      assertRefusal(fx.resume(), RESUME_NAMES(what, out));
      assertRefusal(fx.version(), VERSION_NAMES(what, out));
      assertNothingChanged(fx, before);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 2. two empty commits carrying the release's subjects, the first tagged
    const fx = buildFixture('rl75b');
    try {
      emptyCommit(fx, RELEASE_SUBJECT);
      const fake = fx.short('HEAD');
      fx.git('tag', '--no-sign', 'v0.46.0');
      emptyCommit(fx, DEV_SUBJECT);
      const before = snapshot(fx);
      assertRefusal(fx.resume(), NO_RELEASE);
      assertRefusal(
        fx.version(),
        `Error: Tag v0.46.0 already exists in this repository, at ${fake} "${RELEASE_SUBJECT}". If it is left from an abandoned attempt, delete it (git tag -d v0.46.0), then re-run: npm run release -- --version 0.46.0; otherwise choose another version: ${CHOOSE_ANOTHER}`,
      );
      assertNothingChanged(fx, before);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 3. the only development commit on the release commit fails the test, and no ref reaches it
    const fx = buildFixture('rl75c');
    try {
      const { rel } = finishRelease(fx);
      fx.git('switch', '-q', '-c', 'side');
      amendDevelopmentCommit(fx);
      fx.git('switch', '-q', 'release/test');
      fx.git('reset', '-q', '--hard', rel);
      fx.git('reflog', 'expire', '--expire=now', '--all');
      const what = `HEAD is ${rel} "${RELEASE_SUBJECT}", the release commit of v0.46.0, tagged v0.46.0, with no development commit after it`;
      const before = snapshot(fx);
      assertRefusal(fx.resume(), RESUME_NAMES(what, WAY_OUT(putBack(fx.startShort, DELETE_TAG))));
      assertNothingChanged(fx, before);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 4. a release commit reworded: it holds what the release writes but not its subject
    const fx = buildFixture('rl75d');
    try {
      finishRelease(fx);
      const releaseTree = fx.git('rev-parse', 'HEAD~1^{tree}');
      const developmentTree = fx.git('rev-parse', 'HEAD^{tree}');
      const reworded = fx.git('commit-tree', releaseTree, '-p', fx.start, '-m', 'release v0.46.0');
      const second = fx.git('commit-tree', developmentTree, '-p', reworded, '-m', DEV_SUBJECT);
      fx.git('reset', '-q', '--hard', second);
      fx.git('tag', '-f', '--no-sign', 'v0.46.0', reworded);
      const before = snapshot(fx);
      assertRefusal(fx.resume(), NO_RELEASE);
      assertNothingChanged(fx, before);
    } finally {
      fx.cleanup();
    }
  }
  {
    // 5. an empty commit with the development subject on top: the search goes on below it
    const fx = buildFixture('rl75e');
    try {
      const { rel, dev } = finishRelease(fx);
      emptyCommit(fx, DEV_SUBJECT);
      const where = AFTER_DEV(1, dev);
      const before = snapshot(fx);
      assertPrinted(fx.resume(), [PREPARED_RESUME(rel, where)]);
      assertPrinted(fx.version(), [PREPARED_VERSION(rel, where)]);
      assertNothingChanged(fx, before);
    } finally {
      fx.cleanup();
    }
  }
});

// ── RL76 — the abandon keeps commits of yours, and the success text brings them back ────────

test('RL76 — the abandon keeps commits of yours made after the release own on the branch the script names, and the success text brings them back', () => {
  const text = readFileSync(INSTRUCTIONS_FILE, 'utf-8').split('\n');
  const abandon = text.findIndex((l) => l.startsWith('_To abandon an unfinished release_'));
  const finish = text.findIndex((l, i) => i > abandon && l.startsWith('_To finish'));
  assert.ok(abandon !== -1 && finish > abandon, 'the abandon part and the finish part');
  const part = text[abandon];
  assert.ok(
    part.includes(
      "when the branch was put back by hand before the release commit, and maybe committed on since, the script's message names its own commands for abandoning it",
    ),
    part,
  );
  assert.ok(part.endsWith('Otherwise run these one at a time, in this order:'), part);
  const items = text.slice(abandon + 1, finish).filter((l) => /^[1-4]\. /.test(l));
  assert.equal(items.length, 4);
  assert.ok(items[0].includes('`git branch release/v<version>-kept-<commit> <commit>`'), items[0]);
  assert.ok(items[1].includes('`git reset --keep <your changelog commit>`'), items[1]);
  assert.ok(items[2].includes('`git tag -d v<version>`'), items[2]);
  assert.ok(items[2].includes('`rm -f "$(git rev-parse --git-dir)/realm-release.json"`'), items[2]);
  assert.ok(items[3].includes('`npm run release -- --version <version>`'), items[3]);
  const removeJournal =
    between(items[2], '`rm -f ', 'realm-release.json"`') + 'realm-release.json"';

  for (const withMerge of [false, true]) {
    const fx = buildFixture(`rl76${withMerge ? 'b' : 'a'}`);
    try {
      const { dev } = finishRelease(fx);
      if (withMerge) {
        fx.git('switch', '-q', '-c', 'side', fx.startShort);
        writeFileSync(join(fx.root, 'side.md'), 'side\n');
        fx.git('add', 'side.md');
        fx.git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'add side');
        fx.git('switch', '-q', 'release/test');
        fx.git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
      }
      emptyCommit(fx, 'a commit on top');
      const head = fx.short('HEAD');
      fx.git('tag', '-d', 'v0.46.0');
      const n = withMerge ? 3 : 1;
      const them = n === 1 ? 'it' : 'them';
      const r = fx.resume();
      assert.equal(r.status, 1, r.stderr);
      const phrase = `which takes the ${n === 1 ? '1 commit' : `${n} commits`} after ${dev} off it too (to keep ${them}, run git branch release/test-kept-${head} ${head} first: when the release has run again, its text says how to bring ${them} back)`;
      assert.ok(r.stderr.includes(phrase), r.stderr);

      // the four items as written
      runPrinted(fx, between(r.stderr, `to keep ${them}, run `, ' first:'));
      runPrinted(fx, `git reset --keep ${fx.startShort}`);
      assert.equal(fx.tryGit('rev-parse', '-q', '--verify', 'refs/tags/v0.46.0'), null);
      runPrinted(fx, `rm -f ${removeJournal}`);
      const kept = `release/test-kept-${head}`;
      const keptLine = `A branch kept for this release is waiting: ${kept} holds ${n === 1 ? '1 commit' : `${n} commits`} after ${dev} "${DEV_SUBJECT}", the last commit of the release abandoned before this one. Bring ${them} back now (git rebase --rebase-merges --onto release/test ${dev} ${kept}, then git switch release/test and git merge --ff-only ${kept}), then delete the branch (git branch -D ${kept}).`;
      const ok = fx.version();
      assert.equal(ok.status, 0, ok.stderr);
      assert.deepEqual(stdoutFrom(ok, 'Prepared'), successLines(fx, { extra: [keptLine] }));
      const newDev = fx.short('HEAD');

      // its four commands as printed
      runPrinted(fx, between(ok.stdout, ' back now (', `${kept}, then git switch`) + kept);
      const switchAndMerge = between(ok.stdout, `${kept}, then `, '), then delete the branch');
      const [switchCommand, mergeCommand] = switchAndMerge.split(' and ');
      runPrinted(fx, switchCommand);
      runPrinted(fx, mergeCommand);
      runPrinted(fx, between(ok.stdout, 'then delete the branch (', ').'));

      assert.equal(fx.git('symbolic-ref', '--short', 'HEAD'), 'release/test');
      assert.equal(fx.git('log', '-1', '--format=%s'), 'a commit on top');
      assert.equal(fx.git('rev-list', '--count', `${newDev}..HEAD`), String(n));
      if (withMerge) {
        assert.equal(fx.git('rev-list', '--merges', '--count', `${newDev}..HEAD`), '1');
        assert.equal(readFileSync(join(fx.root, 'side.md'), 'utf-8'), 'side\n');
      }
      assert.equal(fx.tryGit('rev-parse', '-q', '--verify', `refs/heads/${kept}`), null);
      assertPrinted(fx.resume(), [
        PREPARED_RESUME(fx.short('v0.46.0^{commit}'), AFTER_DEV(n, newDev)),
      ]);
    } finally {
      fx.cleanup();
    }
  }
});
