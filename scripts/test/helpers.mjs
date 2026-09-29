// scripts/test/helpers.mjs — issue #620 PR-A (D11). Shared fixture helpers for the release
// scripts' tests. Every test builds its fixtures in a temporary directory and removes it.
//
// Isolation: every helper here that touches git or npm sets `GIT_CONFIG_GLOBAL` to a file the
// test writes (`user.name`/`user.email`, `tag.gpgSign = true` — so `--no-sign` is genuinely
// exercised — and `commit.gpgSign = false`), `GIT_CONFIG_NOSYSTEM=1`, `HOME` to a temporary
// directory, and strips every inherited `npm_*`/`GIT_*` variable a caller does not explicitly set.
// This machine's own global git config signs commits and tags; without this, every test here
// would hang on a GPG prompt or fail signing with no key.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/** A fresh temporary directory under the OS temp dir, prefixed for easy identification. */
export function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `realm-${prefix}-`));
}

/** Remove a temporary directory tree, tolerating it already being gone. */
export function removeTempDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * An environment object with every inherited `npm_*`/`GIT_*` variable stripped, then the given
 * overrides applied on top. Use for every spawned git/npm/node child in these tests.
 */
export function cleanEnv(overrides = {}) {
  const base = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('npm_') || k.startsWith('GIT_')) continue;
    base[k] = v;
  }
  return { ...base, ...overrides };
}

/** Write a global gitconfig at `<homeDir>/gitconfig` (tag signing ON, commit signing OFF) and
 * return its path. */
export function writeGitConfig(homeDir) {
  const configPath = join(homeDir, 'gitconfig');
  writeFileSync(
    configPath,
    [
      '[user]',
      '  name = Realm Test',
      '  email = realm-test@example.invalid',
      '[tag]',
      '  gpgSign = true',
      '[commit]',
      '  gpgSign = false',
      '[init]',
      '  defaultBranch = main',
    ].join('\n') + '\n',
  );
  return configPath;
}

/**
 * `{ home, env }`: a fresh temp HOME with a global gitconfig, and the clean, isolated environment
 * every git/npm/node call in these tests should use. `overrides` layers on top (for example a
 * per-test `GIT_CONFIG_COUNT` override, or `RELEASE_ROOT`-style test-only env is never needed
 * here since every script takes `--root` directly).
 */
export function makeIsolatedEnv(prefix, overrides = {}) {
  const home = makeTempDir(`${prefix}-home`);
  const configPath = writeGitConfig(home);
  const env = cleanEnv({
    GIT_CONFIG_GLOBAL: configPath,
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: home,
    ...overrides,
  });
  return { home, env };
}

function git(cwd, env, ...args) {
  return execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const DEPS = {
  core: [],
  'mcp-server': ['core'],
  testing: ['core'],
  cli: ['core', 'mcp-server', 'testing'],
};

/**
 * The `.github/workflows/publish.yml` body a fixture monorepo needs to pass `checkRelease`: a
 * restore loop naming `dirs` and one publish step per member of `dirs`, in `order` (defaulting to
 * `dirs` itself). Matches the real publish.yml's two shapes covered by `parsePublishYml` — this
 * one uses the block `run: |` form (D7's shape).
 */
export function publishYmlFor(dirs, order = dirs, scope = '@q') {
  const loop = `          for p in ${dirs.join(' ')}; do\n            echo restore $p\n          done`;
  const steps = order
    .map(
      (d) => `      - name: Publish ${scope}/${d}
        working-directory: packages/${d}
        run: |
          npm publish --provenance
`,
    )
    .join('');
  return `name: Publish
jobs:
  build:
    steps:
      - name: Restore dist
        run: |
${loop}
  publish:
    steps:
${steps}`;
}

/**
 * Build a synthetic monorepo fixture matching realm's own shape: `core`, `mcp-server`, `testing`,
 * `cli` (mcp-server/testing depend on core; cli depends on all three), a private `engine-tests`
 * with neither `exports` nor `main`, a `publish.yml` `checkRelease` accepts, and a git repo with
 * one commit. `buildMs`: the root `build` script sleeps this many milliseconds before exiting 0
 * (0 = instant). Returns `{ root, home, env, origin }` (`origin` is a bare repo path already
 * added as the `origin` remote, unless `withOrigin` is false).
 */
export function buildMonorepo(prefix, { version = '0.45.0', buildMs = 0, withOrigin = true } = {}) {
  const { home, env } = makeIsolatedEnv(prefix);
  const root = makeTempDir(`${prefix}-mono`);

  const rootPkg = {
    name: 'mono',
    private: true,
    workspaces: ['packages/*'],
    scripts: {
      build:
        buildMs > 0
          ? `node -e "setTimeout(()=>process.exit(0),${buildMs})"`
          : 'node -e "process.exit(0)"',
    },
  };
  writeFileSync(join(root, 'package.json'), JSON.stringify(rootPkg, null, 2) + '\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');

  for (const [dir, deps] of Object.entries(DEPS)) {
    mkdirSync(join(root, 'packages', dir, 'src'), { recursive: true });
    const pkg = {
      name: `@q/${dir}`,
      version,
      main: './dist/index.js',
      dependencies: Object.fromEntries(deps.map((d) => [`@q/${d}`, '*'])),
    };
    writeFileSync(join(root, 'packages', dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    writeFileSync(
      join(root, 'packages', dir, 'src', 'version.ts'),
      `export const VERSION = '${version}';\n`,
    );
  }
  mkdirSync(join(root, 'packages', 'engine-tests'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'engine-tests', 'package.json'),
    JSON.stringify({ name: '@q/engine-tests', version: '0.0.0', private: true }, null, 2) + '\n',
  );

  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(root, '.github', 'workflows', 'publish.yml'),
    publishYmlFor(['core', 'mcp-server', 'testing', 'cli']),
  );

  spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
    cwd: root,
    env,
    stdio: 'ignore',
  });

  git(root, env, 'init', '-q', '.');
  git(root, env, 'add', '-A');
  git(root, env, 'commit', '-q', '-m', 'base');
  git(root, env, 'tag', '--no-sign', 'base-point');

  let origin = null;
  if (withOrigin) {
    origin = makeTempDir(`${prefix}-origin`);
    execFileSync('git', ['init', '-q', '--bare', origin], { env });
    git(root, env, 'remote', 'add', 'origin', origin);
  }

  return { root, home, env, origin };
}

/** Read a package's `version` field from the fixture tree. */
export function readPkgVersion(root, dir) {
  const pkgPath = join(root, 'packages', dir, 'package.json');
  return JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
}

const SCRIPTS_DIR = new URL('..', import.meta.url).pathname;

/** Absolute path to a script under `scripts/`, e.g. `scriptPath('release.mjs')`. */
export function scriptPath(name) {
  return join(SCRIPTS_DIR, name);
}

/** Run a script with `node`, capturing stdout/stderr/status. Never throws on a non-zero exit. */
export function runNode(scriptFile, args, { cwd, env }) {
  return spawnSync('node', [scriptFile, ...args], { cwd, env, encoding: 'utf-8' });
}
