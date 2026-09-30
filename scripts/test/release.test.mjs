// scripts/test/release.test.mjs — issue #620 PR-A (D11 RL1-RL16). A synthetic monorepo like
// reference/setup.sh: four packages with src/version.ts and "*" internal dependencies, a private
// engine-tests without an entry, a publish.yml checkRelease accepts, a root build script that
// writes a marker file OUTSIDE the working tree when it starts and then sleeps BUILD_MS
// milliseconds, a bare repository as origin, and a registry fixture (a prerelease above the
// highest final, 0.48.0-rc.1, per RL6).

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
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import {
  makeTempDir,
  removeTempDir,
  makeIsolatedEnv,
  scriptPath,
  runNode,
  publishYmlFor,
  readPkgVersion,
} from './helpers.mjs';

function git(cwd, env, ...args) {
  return execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
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

/**
 * Build the RL fixture. The root `build` script writes `process.env.BUILD_MARKER` (if set) the
 * instant it starts, then sleeps `process.env.BUILD_MS` (default 0) ms. Returns
 * `{ root, home, env, origin, journalPath }`.
 */
function buildFixture(prefix, { version = '0.45.0', withOrigin = true } = {}) {
  const { home, env } = makeIsolatedEnv(prefix);
  const root = makeTempDir(`${prefix}-mono`);

  const buildScript =
    'node -e "if(process.env.BUILD_MARKER)require(\'fs\').writeFileSync(process.env.BUILD_MARKER,String(process.pid));setTimeout(()=>process.exit(0),Number(process.env.BUILD_MS||0))"';
  writeJson(join(root, 'package.json'), {
    name: 'mono',
    private: true,
    workspaces: ['packages/*'],
    scripts: { build: buildScript },
  });
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

  // C1 item 10: the script now refuses without a "## [<V>]" CHANGELOG section — sections for both
  // versions the cells release (0.46.0, and RL4's follow-on release 0.46.1).
  writeFileSync(
    join(root, 'CHANGELOG.md'),
    '# Changelog\n\n## [0.46.1] — 2026-01-02\n\n## [0.46.0] — 2026-01-01\n',
  );

  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
    cwd: root,
    env,
    stdio: 'ignore',
  });

  git(root, env, 'init', '-q', '.');
  git(root, env, 'add', '-A');
  git(root, env, 'commit', '-q', '-m', 'base');
  git(root, env, 'tag', '--no-sign', 'base-point');
  // the isolated git config's default branch is `main`, which the script now refuses to release
  // from — every fixture releases from its own branch, as a real releaser would.
  git(root, env, 'switch', '-c', 'release/test');

  let origin = null;
  if (withOrigin) {
    origin = makeTempDir(`${prefix}-origin`);
    execFileSync('git', ['init', '-q', '--bare', origin], { env });
    git(root, env, 'remote', 'add', 'origin', origin);
  }

  const journalPath = join(git(root, env, 'rev-parse', '--git-dir'), 'realm-release.json');
  const absoluteJournalPath = journalPath.startsWith('/') ? journalPath : join(root, journalPath);

  return { root, home, env, origin, journalPath: absoluteJournalPath };
}

/**
 * `--registry-fixture` now holds npm's RAW result per package (`{ exitCode, stdout, stderr }`,
 * exactly what `npm view <name> versions --json` produces), so the same parsing that a real call
 * goes through runs on the fixture too. `rawResultFor` translates each cell's override (unchanged
 * from before: `{ versions: [...] }`, `{ error: 'E404' }`, `{ error: 'ETIMEDOUT: request timed
 * out' }`) into the shape captured from the real registry on 2026-09-30.
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

function state(root, env) {
  const porcelain = git(root, env, 'status', '--porcelain');
  const head = tryGit(root, env, 'log', '-1', '--format=%s');
  const tags = tryGit(root, env, 'tag');
  return {
    porcelain,
    headSubject: head,
    tags: tags ? tags.split('\n').filter((t) => t && t !== 'base-point') : [],
  };
}

function releaseSync(root, env, args, extra = {}) {
  return runNode(scriptPath('release.mjs'), args, { cwd: root, env: { ...env, ...extra } });
}

function cleanup(...dirs) {
  for (const d of dirs) if (d) removeTempDir(d);
}

// ── signal-test infrastructure ────────────────────────────────────────────────────────────────
// "Signal the release process only after its marker file exists. Start the release in its own
// process group (detached: true) with its output redirected to files, never pipes, and wait for
// its exit event: after a SIGKILL its children (the build, a hook's git commit) live on and hold
// what they inherited, so a harness that waits for the pipes to close hangs. Kill the whole group
// at the end of each signal case."

async function waitForFile(path, timeoutMs = 10000) {
  const start = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function waitForFileGone(path, timeoutMs = 10000) {
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
  const outFile = join(root, '..', `out-${process.pid}-${Date.now()}.log`);
  const errFile = join(root, '..', `err-${process.pid}-${Date.now()}.log`);
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
    async waitExit(timeoutMs = 15000) {
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

// ── RL1 happy path ─────────────────────────────────────────────────────────────────────────

test('RL1 — happy path, 0.45.0 -> 0.46.0', () => {
  const { root, home, env, origin } = buildFixture('rl1');
  try {
    const fixture = makeRegistryFixture(home);
    const r = releaseSync(root, env, [
      '--root',
      root,
      '--version',
      '0.46.0',
      '--registry-fixture',
      fixture,
    ]);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);

    // C1 items 7/9: the exact progress lines, in order, and no leaked npm "up to date" summary
    // (C1 item 8 — the lockfile sync hides its own stdout).
    const arrowLines = r.stdout.split('\n').filter((l) => l.startsWith('→ '));
    assert.deepEqual(arrowLines, [
      '→ Checking that v0.46.0 can be released: the version files, publish.yml, CHANGELOG.md, the tags here and on origin, and the npm registry',
      '→ Setting every package to 0.46.0',
      '→ Syncing the lockfile',
      '→ Building',
      '→ Staging the version files',
      '→ Committing chore: release v0.46.0',
      '→ Tagging v0.46.0',
      '→ Setting every package to 0.46.1-dev.0',
      '→ Syncing the lockfile',
      '→ Staging the version files',
      '→ Committing chore: begin development after v0.46.0',
    ]);
    assert.doesNotMatch(r.stdout, /up to date/);

    // two new commits
    const log = git(root, env, 'log', '--format=%s', '-3');
    assert.deepEqual(log.split('\n'), [
      'chore: begin development after v0.46.0',
      'chore: release v0.46.0',
      'base',
    ]);
    // tag v0.46.0 is lightweight and points at the release commit
    assert.equal(git(root, env, 'cat-file', '-t', 'v0.46.0'), 'commit');
    const releaseCommit = git(root, env, 'rev-list', '-n1', 'v0.46.0');
    const releaseCommitSubject = git(root, env, 'log', '-1', '--format=%s', releaseCommit);
    assert.equal(releaseCommitSubject, 'chore: release v0.46.0');
    // its tree has 0.46.0 in every package.json and src/version.ts
    for (const dir of ['core', 'mcp-server', 'testing', 'cli']) {
      const pkgAtRelease = git(root, env, 'show', `${releaseCommit}:packages/${dir}/package.json`);
      assert.equal(JSON.parse(pkgAtRelease).version, '0.46.0');
      const vtsAtRelease = git(
        root,
        env,
        'show',
        `${releaseCommit}:packages/${dir}/src/version.ts`,
      );
      assert.match(vtsAtRelease, /VERSION = '0\.46\.0'/);
    }
    // HEAD has 0.46.1-dev.0 in all of them
    for (const dir of ['core', 'mcp-server', 'testing', 'cli']) {
      assert.equal(readPkgVersion(root, dir), '0.46.1-dev.0');
      const vts = readFileSync(join(root, 'packages', dir, 'src', 'version.ts'), 'utf-8');
      assert.match(vts, /VERSION = '0\.46\.1-dev\.0'/);
    }
    // working tree clean
    assert.equal(git(root, env, 'status', '--porcelain'), '');
    // engine-tests untouched
    assert.equal(readJson(join(root, 'packages', 'engine-tests', 'package.json')).version, '0.0.0');
    // no journal
    assert.equal(
      existsSync(join(git(root, env, 'rev-parse', '--git-dir'), 'realm-release.json')),
      false,
    );
  } finally {
    cleanup(root, home, origin);
  }
});

// ── RL2 prerelease refused; RL3 same/downgrade refused ──────────────────────────────────────

test('RL2 — 0.47.0-rc.1 is refused; nothing is written', () => {
  const { root, home, env, origin } = buildFixture('rl2');
  try {
    const before = state(root, env);
    const fixture = makeRegistryFixture(home);
    const r = releaseSync(root, env, [
      '--root',
      root,
      '--version',
      '0.47.0-rc.1',
      '--registry-fixture',
      fixture,
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^Error: "0\.47\.0-rc\.1" is not a release version\./);
    assert.deepEqual(state(root, env), before);
  } finally {
    cleanup(root, home, origin);
  }
});

test('RL3 — 0.45.0 (same) and 0.44.9 (downgrade) are refused', () => {
  for (const v of ['0.45.0', '0.44.9']) {
    const { root, home, env, origin } = buildFixture('rl3');
    try {
      const before = state(root, env);
      const fixture = makeRegistryFixture(home);
      const r = releaseSync(root, env, [
        '--root',
        root,
        '--version',
        v,
        '--registry-fixture',
        fixture,
      ]);
      assert.equal(r.status, 1, `v=${v}`);
      assert.match(
        r.stderr,
        /is not above the current version 0\.45\.0\. Choose a higher version\./,
      );
      assert.deepEqual(state(root, env), before, `v=${v}`);
    } finally {
      cleanup(root, home, origin);
    }
  }
});

// ── RL4 from a dev-version tree ───────────────────────────────────────────────────────────────

test('RL4 — from a tree at 0.46.1-dev.0: 0.46.1 is accepted; 0.46.0 is refused', () => {
  const { root, home, env, origin } = buildFixture('rl4', { version: '0.46.1-dev.0' });
  try {
    const fixture = makeRegistryFixture(home);
    const refused = releaseSync(root, env, [
      '--root',
      root,
      '--version',
      '0.46.0',
      '--registry-fixture',
      fixture,
    ]);
    assert.equal(refused.status, 1);
    assert.match(
      refused.stderr,
      /0\.46\.0 is not above the current version 0\.46\.1-dev\.0\. Choose a higher version\./,
    );

    const accepted = releaseSync(root, env, [
      '--root',
      root,
      '--version',
      '0.46.1',
      '--registry-fixture',
      fixture,
    ]);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(readPkgVersion(root, 'core'), '0.46.2-dev.0');
  } finally {
    cleanup(root, home, origin);
  }
});

// ── RL5 tag-existence refusals ─────────────────────────────────────────────────────────────────

test('RL5 — refused: local tag; tag on origin; no origin remote; unreadable origin', () => {
  {
    const { root, home, env, origin } = buildFixture('rl5a');
    try {
      git(root, env, 'tag', '--no-sign', 'v0.46.0', 'base-point');
      const fixture = makeRegistryFixture(home);
      const r = releaseSync(root, env, [
        '--root',
        root,
        '--version',
        '0.46.0',
        '--registry-fixture',
        fixture,
      ]);
      assert.equal(r.status, 1);
      assert.match(
        r.stderr,
        /Tag v0\.46\.0 already exists in this repository\. If it is left from an abandoned attempt, delete it \(git tag -d v0\.46\.0\); otherwise choose another version\./,
      );
    } finally {
      cleanup(root, home, origin);
    }
  }
  {
    const { root, home, env, origin } = buildFixture('rl5b');
    try {
      execFileSync('git', ['push', 'origin', 'base-point:refs/tags/v0.46.0'], {
        cwd: root,
        env,
        stdio: 'ignore',
      });
      const fixture = makeRegistryFixture(home);
      const r = releaseSync(root, env, [
        '--root',
        root,
        '--version',
        '0.46.0',
        '--registry-fixture',
        fixture,
      ]);
      assert.equal(r.status, 1);
      assert.match(
        r.stderr,
        /Tag v0\.46\.0 already exists on origin: v0\.46\.0 is already released\. Choose another version\./,
      );
    } finally {
      cleanup(root, home, origin);
    }
  }
  {
    // C1 item 12 (K7): the tag exists BOTH locally and on origin — the origin check runs first,
    // so this must get the origin text, never the local "git tag -d" hint.
    const { root, home, env, origin } = buildFixture('rl5e');
    try {
      git(root, env, 'tag', '--no-sign', 'v0.46.0', 'base-point');
      execFileSync('git', ['push', 'origin', 'v0.46.0'], { cwd: root, env, stdio: 'ignore' });
      const fixture = makeRegistryFixture(home);
      const r = releaseSync(root, env, [
        '--root',
        root,
        '--version',
        '0.46.0',
        '--registry-fixture',
        fixture,
      ]);
      assert.equal(r.status, 1);
      assert.match(
        r.stderr,
        /Tag v0\.46\.0 already exists on origin: v0\.46\.0 is already released\. Choose another version\./,
      );
      assert.doesNotMatch(r.stderr, /git tag -d/);
    } finally {
      cleanup(root, home, origin);
    }
  }
  {
    const { root, home, env } = buildFixture('rl5c', { withOrigin: false });
    try {
      const fixture = makeRegistryFixture(home);
      const r = releaseSync(root, env, [
        '--root',
        root,
        '--version',
        '0.46.0',
        '--registry-fixture',
        fixture,
      ]);
      assert.equal(r.status, 1);
      assert.match(
        r.stderr,
        /This repository has no origin remote, so the release cannot be pushed\. Add it \(git remote add origin <url>\), then re-run\./,
      );
    } finally {
      cleanup(root, home);
    }
  }
  {
    const { root, home, env, origin } = buildFixture('rl5d');
    try {
      git(root, env, 'remote', 'set-url', 'origin', '/nonexistent/path/for/test.git');
      const fixture = makeRegistryFixture(home);
      const r = releaseSync(root, env, [
        '--root',
        root,
        '--version',
        '0.46.0',
        '--registry-fixture',
        fixture,
      ]);
      assert.equal(r.status, 1);
      assert.match(
        r.stderr,
        /^Error: Cannot read tags from origin: .+\. Check that git ls-remote origin works, then re-run\./,
      );
    } finally {
      cleanup(root, home, origin);
    }
  }
});

// ── RL6 registry refusals ───────────────────────────────────────────────────────────────────

test('RL6 — refused: already published; above highest published; registry error. Accepted: E404 for one package.', () => {
  {
    const { root, home, env, origin } = buildFixture('rl6a');
    try {
      const fixture = makeRegistryFixture(home, { '@q/core': { versions: ['0.44.0', '0.46.0'] } });
      const r = releaseSync(root, env, [
        '--root',
        root,
        '--version',
        '0.46.0',
        '--registry-fixture',
        fixture,
      ]);
      assert.equal(r.status, 1);
      assert.match(
        r.stderr,
        /^Error: @q\/core@0\.46\.0 is already published\. Choose another version\./,
      );
    } finally {
      cleanup(root, home, origin);
    }
  }
  {
    const { root, home, env, origin } = buildFixture('rl6b');
    try {
      // a prerelease ABOVE the highest final must be ignored (0.48.0-rc.1)
      const fixture = makeRegistryFixture(home, {
        '@q/core': { versions: ['0.44.0', '0.47.0', '0.48.0-rc.1'] },
      });
      const r = releaseSync(root, env, [
        '--root',
        root,
        '--version',
        '0.46.0',
        '--registry-fixture',
        fixture,
      ]);
      assert.equal(r.status, 1);
      assert.match(
        r.stderr,
        /^Error: 0\.46\.0 is not above @q\/core's highest published version 0\.47\.0\. Choose a higher version\./,
      );
    } finally {
      cleanup(root, home, origin);
    }
  }
  {
    const { root, home, env, origin } = buildFixture('rl6c');
    try {
      const fixture = makeRegistryFixture(home, {
        '@q/core': { error: 'ETIMEDOUT: request timed out' },
      });
      const r = releaseSync(root, env, [
        '--root',
        root,
        '--version',
        '0.46.0',
        '--registry-fixture',
        fixture,
      ]);
      assert.equal(r.status, 1);
      assert.match(
        r.stderr,
        /^Error: Cannot read @q\/core from the npm registry \(npm ETIMEDOUT: request timed out\)\. Check that npm view @q\/core versions works, then re-run\./,
      );
    } finally {
      cleanup(root, home, origin);
    }
  }
  {
    // Accepted: E404 for one package (the default fixture is all-E404) plus real versions for others
    const { root, home, env, origin } = buildFixture('rl6d');
    try {
      const fixture = makeRegistryFixture(home, {
        '@q/core': { error: 'E404' },
        '@q/mcp-server': { versions: ['0.10.0'] },
      });
      const r = releaseSync(root, env, [
        '--root',
        root,
        '--version',
        '0.46.0',
        '--registry-fixture',
        fixture,
      ]);
      assert.equal(r.status, 0, r.stderr);
      // C6: RL6's accepted leg must assert the success line, not only exit 0 — with phase 2
      // removed (K10) it still exited 0, so this is the discriminating assertion (mutant K10).
      assert.match(
        r.stdout,
        /^Prepared v0\.46\.0 \(not pushed or published yet\): release commit [0-9a-f]+, tag v0\.46\.0\. Development continues at 0\.46\.1-dev\.0\.$/m,
      );
    } finally {
      cleanup(root, home, origin);
    }
  }
});

// ── RL7 dirty tree / checkRelease failure ───────────────────────────────────────────────────

test('RL7 — refused: a dirty tree; a tree that fails checkRelease', () => {
  {
    const { root, home, env, origin } = buildFixture('rl7a');
    try {
      writeFileSync(join(root, 'packages', 'core', 'README.md'), 'dirty\n');
      const fixture = makeRegistryFixture(home);
      const r = releaseSync(root, env, [
        '--root',
        root,
        '--version',
        '0.46.0',
        '--registry-fixture',
        fixture,
      ]);
      assert.equal(r.status, 1);
      // C1 item 6 / C6: the full listing text, naming the one untracked file (its porcelain
      // status column preserved — the message reads it untrimmed).
      assert.equal(
        r.stderr.trim(),
        'Error: The working tree is not clean:\n' +
          '  ?? packages/core/README.md\n' +
          'Commit, stash (git stash -u also stashes untracked files) or remove them, then re-run.',
      );
    } finally {
      cleanup(root, home, origin);
    }
  }
  {
    const { root, home, env, origin } = buildFixture('rl7b');
    try {
      // a src/version.ts that differs from its package.json
      writeFileSync(
        join(root, 'packages', 'core', 'src', 'version.ts'),
        "export const VERSION = '0.44.0';\n",
      );
      git(root, env, 'add', '-A');
      git(root, env, 'commit', '-q', '-m', 'break it');
      const fixture = makeRegistryFixture(home);
      const r = releaseSync(root, env, [
        '--root',
        root,
        '--version',
        '0.46.0',
        '--registry-fixture',
        fixture,
      ]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /^Error: The release checks failed:/);
      assert.match(
        r.stderr,
        /packages\/core\/src\/version\.ts says 0\.44\.0, but packages\/core\/package\.json says 0\.45\.0\. Set packages\/core\/src\/version\.ts to '0\.45\.0', commit, then re-run\./,
      );
      assert.match(r.stderr, /Fix these, then re-run\.$/m);
    } finally {
      cleanup(root, home, origin);
    }
  }
});

// ── RL8 — commit fails (signing with a key that does not exist) ─────────────────────────────

test('RL8 — the commit fails (signing with a key that does not exist): exit 1; clean; no journal; a re-run then succeeds', () => {
  const { root, home, env, origin } = buildFixture('rl8');
  try {
    const fixture = makeRegistryFixture(home);
    const failingEnv = {
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'commit.gpgSign',
      GIT_CONFIG_VALUE_0: 'true',
      GIT_CONFIG_KEY_1: 'gpg.format',
      GIT_CONFIG_VALUE_1: 'ssh',
      GIT_CONFIG_KEY_2: 'user.signingkey',
      GIT_CONFIG_VALUE_2: '/nonexistent/key.pub',
    };
    const r = releaseSync(
      root,
      env,
      ['--root', root, '--version', '0.46.0', '--registry-fixture', fixture],
      failingEnv,
    );
    assert.equal(r.status, 1);
    // git status --porcelain is empty (working tree AND index)
    assert.equal(git(root, env, 'status', '--porcelain'), '');
    assert.equal(
      existsSync(join(git(root, env, 'rev-parse', '--git-dir'), 'realm-release.json')),
      false,
    );

    // re-run then succeeds (without the failing signing config)
    const r2 = releaseSync(root, env, [
      '--root',
      root,
      '--version',
      '0.46.0',
      '--registry-fixture',
      fixture,
    ]);
    assert.equal(r2.status, 0, r2.stderr);
    // C6: assert the success line itself, and that no journal remains — with phase 2 removed
    // (K10) the re-run still exited 0, so this is the discriminating assertion.
    assert.match(
      r2.stdout,
      /^Prepared v0\.46\.0 \(not pushed or published yet\): release commit [0-9a-f]+, tag v0\.46\.0\. Development continues at 0\.46\.1-dev\.0\.$/m,
    );
    assert.equal(
      existsSync(join(git(root, env, 'rev-parse', '--git-dir'), 'realm-release.json')),
      false,
    );
  } finally {
    cleanup(root, home, origin);
  }
});

// ── RL15 / RL16 — --resume edge cases ────────────────────────────────────────────────────────

test('RL15 — --resume with no journal: exit 1 with its text', () => {
  const { root, home, env, origin } = buildFixture('rl15');
  try {
    const r = releaseSync(root, env, ['--root', root, '--resume']);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.trim(), 'Error: There is no unfinished release to resume.');
  } finally {
    cleanup(root, home, origin);
  }
});

test('RL16 — a journal whose state is unknown: refused with the unknown text; nothing changes', () => {
  const { root, home, env, origin, journalPath } = buildFixture('rl16');
  try {
    const startSha = git(root, env, 'rev-parse', 'HEAD');
    writeJson(journalPath, {
      version: '0.99.9',
      devVersion: '0.99.10-dev.0',
      phase: 'release',
      startSha,
      releaseSha: null,
      files: ['packages/core/package.json'],
    });
    // an extra commit made after the journal was written — so HEAD no longer matches
    // startSha, and it's not the release commit either.
    writeFileSync(join(root, 'packages', 'core', 'README.md'), 'extra\n');
    git(root, env, 'add', '-A');
    git(root, env, 'commit', '-q', '-m', 'unrelated commit after journal written');

    const before = state(root, env);
    const r = releaseSync(root, env, ['--root', root, '--resume']);
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /^Error: The release journal describes v0\.99\.9, started at [0-9a-f]+, but this checkout matches none of its steps \(HEAD is [0-9a-f]+\)\. Inspect the history, then delete .+realm-release\.json\.$/m,
    );
    assert.deepEqual(state(root, env), before);
    assert.equal(existsSync(journalPath), true, 'journal must be left untouched');
  } finally {
    cleanup(root, home, origin);
  }
});

// ── RL9 — SIGTERM to the release process during the build ───────────────────────────────────

test('RL9 — SIGTERM to the release process during the build: exit 1; restored; clean; no journal', async () => {
  const { root, home, env, origin, journalPath } = buildFixture('rl9');
  const marker = join(home, 'build-marker');
  const fixture = makeRegistryFixture(home);
  const handle = spawnReleaseDetached(
    root,
    env,
    ['--root', root, '--version', '0.46.0', '--registry-fixture', fixture],
    {
      BUILD_MARKER: marker,
      BUILD_MS: '4000',
    },
  );
  try {
    await waitForFile(marker);
    handle.killPid('SIGTERM');
    const { code } = await handle.waitExit();
    assert.equal(code, 1, `stdout: ${readOut(handle)}\nstderr: ${readErr(handle)}`);
    assert.match(
      readErr(handle),
      /^Error: The release of v0\.46\.0 was interrupted \(SIGTERM\)\. Every tracked file it changed is restored; packages\/\*\/dist may still hold its v0\.46\.0 build, so run npm run build before using this checkout\. To release, re-run: npm run release -- --version 0\.46\.0$/m,
    );
    assert.equal(git(root, env, 'status', '--porcelain'), '');
    assert.equal(existsSync(journalPath), false);
  } finally {
    handle.killGroup('SIGKILL');
    cleanupSignalFiles(handle);
    cleanup(root, home, origin);
  }
});

// ── RL10 — the tag step fails after the commit (a stuck ref lock); --resume finishes ────────

test('RL10 — the tag step fails (a stale ref lock): exit 1 naming --resume; the journal stays; remove the lock, run --resume: RL1 end state', () => {
  const { root, home, env, origin, journalPath } = buildFixture('rl10');
  try {
    const fixture = makeRegistryFixture(home);
    const gitDir = git(root, env, 'rev-parse', '--git-dir');
    const absGitDir = gitDir.startsWith('/') ? gitDir : join(root, gitDir);
    mkdirSync(join(absGitDir, 'refs', 'tags'), { recursive: true });
    writeFileSync(join(absGitDir, 'refs', 'tags', 'v0.46.0.lock'), '');

    const r = releaseSync(root, env, [
      '--root',
      root,
      '--version',
      '0.46.0',
      '--registry-fixture',
      fixture,
    ]);
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /^Error: The release commit for v0\.46\.0 exists \([0-9a-f]+\), but it is not tagged: tagging failed \(exit \d+; its message is above\)\. Fix the cause, then run: npm run release -- --resume$/m,
    );
    assert.equal(existsSync(journalPath), true);

    // remove the lock, run --resume
    unlinkSync(join(absGitDir, 'refs', 'tags', 'v0.46.0.lock'));
    const r2 = releaseSync(root, env, ['--root', root, '--resume']);
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(
      r2.stdout,
      /^Prepared v0\.46\.0 \(not pushed or published yet\): release commit [0-9a-f]+, tag v0\.46\.0\. Development continues at 0\.46\.1-dev\.0\.$/m,
    );
    assert.equal(readPkgVersion(root, 'core'), '0.46.1-dev.0');
    assert.equal(git(root, env, 'status', '--porcelain'), '');
    assert.equal(existsSync(journalPath), false);
  } finally {
    cleanup(root, home, origin);
  }
});

// ── RL11 — SIGKILL during the build; --resume restores; a re-run reaches RL1's end state ────

test('RL11 — SIGKILL during the build: the journal stays; --version refused naming --resume; --resume restores and says to re-run; the re-run reaches RL1 end state', async () => {
  const { root, home, env, origin, journalPath } = buildFixture('rl11');
  const marker = join(home, 'build-marker');
  const fixture = makeRegistryFixture(home);
  const handle = spawnReleaseDetached(
    root,
    env,
    ['--root', root, '--version', '0.46.0', '--registry-fixture', fixture],
    {
      BUILD_MARKER: marker,
      BUILD_MS: '4000',
    },
  );
  try {
    await waitForFile(marker);
    handle.killPid('SIGKILL'); // uncatchable: release.mjs dies with NO handler running
    await handle.waitExit();
    assert.equal(existsSync(journalPath), true, 'the journal must survive an uncatchable crash');

    const versionAttempt = releaseSync(root, env, [
      '--root',
      root,
      '--version',
      '0.46.0',
      '--registry-fixture',
      fixture,
    ]);
    assert.equal(versionAttempt.status, 1);
    // C1 item 2 / C6: the new nothing-committed journal-refusal text.
    assert.match(
      versionAttempt.stderr,
      /^Error: An earlier release of v0\.46\.0 stopped before its release commit, so nothing is committed\. Run npm run release -- --resume to restore the files it changed, then re-run npm run release -- --version 0\.46\.0\.$/m,
    );

    const resumeAttempt = releaseSync(root, env, ['--root', root, '--resume']);
    assert.equal(resumeAttempt.status, 0, resumeAttempt.stderr);
    // C1 item 5: the restored text names the file count (9 = 4 packages × 2 files + the lockfile).
    assert.match(
      resumeAttempt.stdout,
      /^Restored the 9 files the unfinished v0\.46\.0 release changed\. packages\/\*\/dist may still hold its v0\.46\.0 build: run npm run build before using this checkout\. Re-run: npm run release -- --version 0\.46\.0$/m,
    );
    assert.equal(existsSync(journalPath), false);
    assert.equal(git(root, env, 'status', '--porcelain'), '');

    const reRun = releaseSync(root, env, [
      '--root',
      root,
      '--version',
      '0.46.0',
      '--registry-fixture',
      fixture,
    ]);
    assert.equal(reRun.status, 0, reRun.stderr);
    assert.equal(readPkgVersion(root, 'core'), '0.46.1-dev.0');
  } finally {
    handle.killGroup('SIGKILL');
    cleanupSignalFiles(handle);
    cleanup(root, home, origin);
  }
});

// ── RL12 — the development commit fails (a commit-msg hook rejects it); --resume finishes ───

test('RL12 — the development commit fails (a commit-msg hook rejects it): exit 1 naming --resume; the release commit and tag stand. Remove the hook, run --resume: RL1 end state', () => {
  const { root, home, env, origin, journalPath } = buildFixture('rl12');
  try {
    const fixture = makeRegistryFixture(home);
    const hookPath = join(root, '.git', 'hooks', 'commit-msg');
    writeFileSync(
      hookPath,
      '#!/bin/sh\nif grep -q "^chore: begin development" "$1"; then echo "refused" >&2; exit 1; fi\nexit 0\n',
    );
    chmodSync(hookPath, 0o755);

    const r = releaseSync(root, env, [
      '--root',
      root,
      '--version',
      '0.46.0',
      '--registry-fixture',
      fixture,
    ]);
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /^Error: v0\.46\.0 is committed and tagged, but the development version is not committed: the commit failed \(exit \d+; its message is above\)\. Fix the cause, then run: npm run release -- --resume$/m,
    );
    // the release commit and tag stand
    assert.equal(git(root, env, 'cat-file', '-t', 'v0.46.0'), 'commit');
    const releaseCommit = git(root, env, 'rev-list', '-n1', 'v0.46.0');
    assert.equal(
      git(root, env, 'log', '-1', '--format=%s', releaseCommit),
      'chore: release v0.46.0',
    );
    assert.equal(existsSync(journalPath), true);
    // C6 / M10 & K9: right after the failed dev commit, the tagged-state restore must have run —
    // the bumped dev-version edits are gone from both the worktree and the index.
    assert.equal(git(root, env, 'status', '--porcelain'), '');

    unlinkSync(hookPath);
    // C6 / K8: an unrelated staged file must survive the resume's dev commit untouched — proving
    // the commit is scoped by `-- <files>`, never "whatever happens to be staged".
    writeFileSync(join(root, 'unrelated.txt'), 'unrelated\n');
    git(root, env, 'add', 'unrelated.txt');

    const r2 = releaseSync(root, env, ['--root', root, '--resume']);
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(
      r2.stdout,
      /^Prepared v0\.46\.0 \(not pushed or published yet\): release commit [0-9a-f]+, tag v0\.46\.0\. Development continues at 0\.46\.1-dev\.0\.$/m,
    );
    assert.equal(readPkgVersion(root, 'core'), '0.46.1-dev.0');
    assert.equal(existsSync(journalPath), false);

    // the development commit names exactly the 9 version files, not the unrelated one
    const devCommit = git(root, env, 'rev-parse', 'HEAD');
    const devCommitFiles = git(
      root,
      env,
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      devCommit,
    )
      .split('\n')
      .filter(Boolean)
      .sort();
    assert.deepEqual(devCommitFiles, [
      'package-lock.json',
      'packages/cli/package.json',
      'packages/cli/src/version.ts',
      'packages/core/package.json',
      'packages/core/src/version.ts',
      'packages/mcp-server/package.json',
      'packages/mcp-server/src/version.ts',
      'packages/testing/package.json',
      'packages/testing/src/version.ts',
    ]);
    // the unrelated file is still staged, untouched by the development commit
    assert.equal(
      git(root, env, 'status', '--porcelain', '--', 'unrelated.txt'),
      'A  unrelated.txt',
    );
  } finally {
    cleanup(root, home, origin);
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
  const { root, home, env, origin, journalPath } = buildFixture('rl13');
  const marker = join(home, 'hook-marker');
  const releaseFile = join(home, 'hook-release');
  const fixture = makeRegistryFixture(home);

  const hookPath = join(root, '.git', 'hooks', 'commit-msg');
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
    root,
    env,
    ['--root', root, '--version', '0.46.0', '--registry-fixture', fixture],
    { MARKER_FILE: marker, RELEASE_FILE: releaseFile },
  );
  try {
    await waitForFile(marker); // the hook is now blocked inside the (still in-flight) dev commit
    handle.killPid('SIGKILL'); // release.mjs dies uncatchably; git commit + its hook are orphaned
    await handle.waitExit();

    const journal = JSON.parse(readFileSync(journalPath, 'utf-8'));
    assert.equal(journal.phase, 'development');

    // unblock the orphaned hook so its `git commit` aborts cleanly and releases index.lock
    writeFileSync(releaseFile, '');
    const gitDir = git(root, env, 'rev-parse', '--git-dir');
    const absGitDir = gitDir.startsWith('/') ? gitDir : join(root, gitDir);
    await waitForFileGone(join(absGitDir, 'index.lock'));

    // the hook fires again on the retried commit; it must see the SAME MARKER_FILE (already
    // created) to recognise this as the retry and let the commit through instead of blocking again.
    const resumeAttempt = releaseSync(root, env, ['--root', root, '--resume'], {
      MARKER_FILE: marker,
      RELEASE_FILE: releaseFile,
    });
    assert.equal(
      resumeAttempt.status,
      0,
      `stdout: ${resumeAttempt.stdout}\nstderr: ${resumeAttempt.stderr}`,
    );
    assert.match(
      resumeAttempt.stdout,
      /^Prepared v0\.46\.0 \(not pushed or published yet\): release commit [0-9a-f]+, tag v0\.46\.0\. Development continues at 0\.46\.1-dev\.0\.$/m,
    );
    assert.equal(readPkgVersion(root, 'core'), '0.46.1-dev.0');
    assert.equal(git(root, env, 'status', '--porcelain'), '');
    assert.equal(existsSync(journalPath), false);
    const log = git(root, env, 'log', '--format=%s', '-3');
    assert.deepEqual(log.split('\n'), [
      'chore: begin development after v0.46.0',
      'chore: release v0.46.0',
      'base',
    ]);
  } finally {
    handle.killGroup('SIGKILL');
    cleanupSignalFiles(handle);
    cleanup(root, home, origin);
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
  const { root, home, env, origin, journalPath } = buildFixture('rl14');
  const marker = join(home, 'postcommit-marker');
  const releaseFile = join(home, 'postcommit-release');
  const fixture = makeRegistryFixture(home);

  const hookPath = join(root, '.git', 'hooks', 'post-commit');
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
    root,
    env,
    ['--root', root, '--version', '0.46.0', '--registry-fixture', fixture],
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
    assert.equal(existsSync(journalPath), false);
    const log = git(root, env, 'log', '--format=%s', '-3');
    assert.deepEqual(log.split('\n'), [
      'chore: begin development after v0.46.0',
      'chore: release v0.46.0',
      'base',
    ]);
    assert.equal(readPkgVersion(root, 'core'), '0.46.1-dev.0');
  } finally {
    handle.killGroup('SIGKILL');
    cleanupSignalFiles(handle);
    cleanup(root, home, origin);
  }
});

// ── RL17-RL21 — new entry checks (the correction, C1 items 1.4/1.5/1.2/1.10, and --help) ─────

test('RL17 — on main: refused with its text', () => {
  const { root, home, env, origin } = buildFixture('rl17');
  try {
    git(root, env, 'switch', 'main');
    const before = state(root, env);
    const fixture = makeRegistryFixture(home);
    const r = releaseSync(root, env, [
      '--root',
      root,
      '--version',
      '0.46.0',
      '--registry-fixture',
      fixture,
    ]);
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /^Error: You are on main\. Run the release on its own branch: git switch -c release\/v0\.46\.0, then re-run\.$/m,
    );
    assert.deepEqual(state(root, env), before);
  } finally {
    cleanup(root, home, origin);
  }
});

test('RL18 — a detached HEAD: refused with its text', () => {
  const { root, home, env, origin } = buildFixture('rl18');
  try {
    git(root, env, 'checkout', '-q', '--detach', 'HEAD');
    const before = state(root, env);
    const fixture = makeRegistryFixture(home);
    const r = releaseSync(root, env, [
      '--root',
      root,
      '--version',
      '0.46.0',
      '--registry-fixture',
      fixture,
    ]);
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /^Error: You are not on a branch\. Run the release on its own branch: git switch -c release\/v0\.46\.0, then re-run\.$/m,
    );
    assert.deepEqual(state(root, env), before);
  } finally {
    cleanup(root, home, origin);
  }
});

test('RL19 — v0.46.0: refused with the leading-v text', () => {
  const { root, home, env, origin } = buildFixture('rl19');
  try {
    const before = state(root, env);
    const fixture = makeRegistryFixture(home);
    const r = releaseSync(root, env, [
      '--root',
      root,
      '--version',
      'v0.46.0',
      '--registry-fixture',
      fixture,
    ]);
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /^Error: Write the version without the leading v: npm run release -- --version 0\.46\.0$/m,
    );
    assert.deepEqual(state(root, env), before);
  } finally {
    cleanup(root, home, origin);
  }
});

test('RL20 — a committed CHANGELOG.md whose only section is ## [Unreleased]: refused with its text', () => {
  const { root, home, env, origin } = buildFixture('rl20');
  try {
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n');
    git(root, env, 'add', '-A');
    git(root, env, 'commit', '-q', '-m', 'changelog: only unreleased');
    const before = state(root, env);
    const fixture = makeRegistryFixture(home);
    const r = releaseSync(root, env, [
      '--root',
      root,
      '--version',
      '0.46.0',
      '--registry-fixture',
      fixture,
    ]);
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /^Error: CHANGELOG\.md has no "## \[0\.46\.0\]" section\. Rename its "## \[Unreleased\]" heading to "## \[0\.46\.0\] — <YYYY-MM-DD>" and commit it \(Part B step 2\), then re-run\.$/m,
    );
    assert.deepEqual(state(root, env), before);
  } finally {
    cleanup(root, home, origin);
  }
});

test('RL21 — --help: exit 0, and stdout is exactly the usage line', () => {
  const { root, home, env, origin } = buildFixture('rl21');
  try {
    const r = releaseSync(root, env, ['--root', root, '--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout.trim(),
      'Usage: npm run release -- --version <MAJOR.MINOR.PATCH>, or npm run release -- --resume',
    );
  } finally {
    cleanup(root, home, origin);
  }
});
