// The multi-copy layout (issue #620 PR-B): builds, in a temp folder and from the BUILT `dist`
// folders of the four packages, the install shapes npm produces when one project holds more than
// one copy of realm — then lets a test import, spawn and measure each copy on its own.
//
// This file is test support. It is NOT compiled into the package (`src/multi-copy/**` is excluded
// in `tsconfig.json`), so it never ships in `dist`; `typecheck:tests` and eslint still read it.
//
// What the layout holds (every `@sensigo/*` package is a COPY of the built files, never a link —
// a link would resolve back into the repository's own workspace, which is exactly what a real
// install does not do):
//
//   project/node_modules/@sensigo/realm        the PROJECT's core
//   project/node_modules/@sensigo/realm-cli    the project's realm-cli (its `./agent` entry)
//   cli/node_modules/@sensigo/realm-cli        the command that runs, with its OWN nested core
//   cli/node_modules/@sensigo/realm-mcp        … with its own nested core
//   cli/node_modules/@sensigo/realm-testing    … with its own nested core
//   other/node_modules/@sensigo/realm          the same files one patch ahead ("another release")
//   other/node_modules/@sensigo/realm-cli      … realm-cli one patch ahead
//   other/node_modules/@sensigo/realm-testing  … realm-testing one patch ahead
//
// There is no other-release realm-mcp: under exact pins a CLI never holds one.
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The repository root: this file is `packages/cli/src/multi-copy/layout.ts`. */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

type PackageKey = 'core' | 'cli' | 'mcp' | 'testing';

const PACKAGES: Record<PackageKey, { dir: string; name: string }> = {
  core: { dir: 'core', name: '@sensigo/realm' },
  cli: { dir: 'cli', name: '@sensigo/realm-cli' },
  mcp: { dir: 'mcp-server', name: '@sensigo/realm-mcp' },
  testing: { dir: 'testing', name: '@sensigo/realm-testing' },
};

/** One installed copy: its folder, and the version its `dist/version.js` reports. */
export interface Copy {
  /** The package folder, e.g. `<root>/project/node_modules/@sensigo/realm`. */
  dir: string;
  /** The version written into the copy's `dist/version.js` line. */
  version: string;
}

export interface Layout {
  /** The temp folder everything lives in. */
  root: string;
  /** The version the repository's packages carry now, read from `packages/core/src/version.ts`. */
  version: string;
  /** The same string with its patch number raised by one (another release). */
  otherVersion: string;
  /** The project's folder: its own core and realm-cli, and the place project code lives. */
  projectDir: string;
  project: { core: Copy; cli: Copy };
  /** The command that runs, each with a nested core of its own. */
  cli: {
    cli: Copy;
    cliCore: Copy;
    mcp: Copy;
    mcpCore: Copy;
    testing: Copy;
    testingCore: Copy;
  };
  /** One patch ahead. */
  other: { core: Copy; cli: Copy; testing: Copy };
  /** The folder the other-release copies are installed in; it is a project of its own. */
  otherDir: string;
  /** Imports a file of a copy by its path relative to the copy's folder (default: its entry). */
  load: <T = Record<string, unknown>>(copy: Copy, relative?: string) => Promise<T>;
  /** The absolute path of a file of a copy. */
  file: (copy: Copy, relative: string) => string;
  /** Removes the whole layout. */
  cleanup: () => Promise<void>;
}

/** Reads `export const VERSION = '<v>';` from a built `version.js`. */
async function readVersion(versionJs: string): Promise<string> {
  const text = await readFile(versionJs, 'utf8');
  const match = /^export const VERSION = '([^']+)';$/m.exec(text);
  if (match?.[1] === undefined) {
    throw new Error(`${versionJs} has no line \`export const VERSION = '<v>';\``);
  }
  return match[1];
}

/** `0.45.0` → `0.45.1`: a different release by raw string. Test helper only. */
function nextPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) throw new Error(`cannot raise the patch of '${version}'`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/** The repository's own folder for a package: `<repo>/packages/<dir>`. */
function repoPackageDir(key: PackageKey): string {
  return join(REPO_ROOT, 'packages', PACKAGES[key].dir);
}

/**
 * Where a third-party dependency of a realm package is found in the repository: the package's own
 * `node_modules` when it has one for it (core needs `ajv` 8; the root hoists `ajv` 6), the root's
 * otherwise. A copy gets a link to that real folder, so the dependency resolves its own
 * dependencies from where it really lives — the way an install would leave it.
 */
function thirdPartySource(key: PackageKey, dependency: string): string {
  const own = join(repoPackageDir(key), 'node_modules', dependency);
  if (existsSync(own)) return own;
  const hoisted = join(REPO_ROOT, 'node_modules', dependency);
  if (existsSync(hoisted)) return hoisted;
  throw new Error(`third-party dependency '${dependency}' of ${PACKAGES[key].name} not found`);
}

/**
 * Installs one copy of a built package into `<parent>/node_modules/@sensigo/<name>`: its
 * `package.json`, its JavaScript files (no maps, no declarations), and a link for each of its
 * third-party dependencies. `version` rewrites the one `VERSION` line of `dist/version.js`.
 */
async function installCopy(
  parent: string,
  key: PackageKey,
  baseVersion: string,
  version: string,
): Promise<Copy> {
  const source = repoPackageDir(key);
  if (!existsSync(join(source, 'dist', 'index.js'))) {
    throw new Error(`${PACKAGES[key].name} has no dist — run \`npm run build\` first`);
  }
  const dir = join(parent, 'node_modules', '@sensigo', PACKAGES[key].name.split('/')[1]!);
  await mkdir(dir, { recursive: true });
  await cp(join(source, 'dist'), join(dir, 'dist'), {
    recursive: true,
    filter: (path) => !/\.(map|d\.ts)$/.test(path),
  });

  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as {
    version: string;
    dependencies?: Record<string, string>;
  };
  if (version !== baseVersion) manifest.version = version;
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  if (version !== baseVersion) {
    const versionJs = join(dir, 'dist', 'version.js');
    const before = await readFile(versionJs, 'utf8');
    const after = before.replace(
      `export const VERSION = '${baseVersion}';`,
      `export const VERSION = '${version}';`,
    );
    if (after === before) throw new Error(`rewriting ${versionJs} changed nothing`);
    await writeFile(versionJs, after, 'utf8');
  }

  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (dependency.startsWith('@sensigo/')) continue;
    const link = join(dir, 'node_modules', dependency);
    await mkdir(dirname(link), { recursive: true });
    await symlink(thirdPartySource(key, dependency), link, 'dir');
  }
  return { dir, version };
}

/** Builds the layout in a fresh temp folder. */
export async function buildLayout(): Promise<Layout> {
  const version = await readVersion(join(repoPackageDir('core'), 'dist', 'version.js'));
  const otherVersion = nextPatch(version);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'realm-multi-copy-')));
  const base = (key: PackageKey, parent: string): Promise<Copy> =>
    installCopy(parent, key, version, version);
  const ahead = (key: PackageKey, parent: string): Promise<Copy> =>
    installCopy(parent, key, version, otherVersion);

  // The project: its own core, and the realm-cli whose `./agent` entry its provider code imports.
  const projectDir = join(root, 'project');
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, 'package.json'),
    JSON.stringify({ name: 'multi-copy-project', private: true, type: 'module' }) + '\n',
    'utf8',
  );
  const projectCore = await base('core', projectDir);
  const projectCli = await base('cli', projectDir);

  // The command that runs: each of its three realm packages brings a core of its own, nested.
  const cliTree = join(root, 'cli');
  const cliCli = await base('cli', cliTree);
  const cliCliCore = await base('core', cliCli.dir);
  const cliMcp = await base('mcp', cliTree);
  const cliMcpCore = await base('core', cliMcp.dir);
  const cliTesting = await base('testing', cliTree);
  const cliTestingCore = await base('core', cliTesting.dir);

  // Another release: the same files one patch ahead. realm-testing and realm-cli there find the
  // other-release core one level up, as a flat install would leave it.
  const otherTree = join(root, 'other');
  await mkdir(otherTree, { recursive: true });
  await writeFile(
    join(otherTree, 'package.json'),
    JSON.stringify({ name: 'multi-copy-other', private: true, type: 'module' }) + '\n',
    'utf8',
  );
  const otherCore = await ahead('core', otherTree);
  const otherCli = await ahead('cli', otherTree);
  const otherTesting = await ahead('testing', otherTree);

  const file = (copy: Copy, relative: string): string => join(copy.dir, relative);
  return {
    root,
    version,
    otherVersion,
    projectDir,
    project: { core: projectCore, cli: projectCli },
    cli: {
      cli: cliCli,
      cliCore: cliCliCore,
      mcp: cliMcp,
      mcpCore: cliMcpCore,
      testing: cliTesting,
      testingCore: cliTestingCore,
    },
    other: { core: otherCore, cli: otherCli, testing: otherTesting },
    otherDir: otherTree,
    file,
    load: <T = Record<string, unknown>>(copy: Copy, relative = 'dist/index.js'): Promise<T> =>
      import(pathToFileURL(file(copy, relative)).href) as Promise<T>,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs `node <args>` with a minimal environment — `PATH` and a `HOME` the caller names, nothing
 * else from this process — so the child can neither read the real `~/.realm` nor print a secret
 * the parent holds. A timeout bounds it; the caller decides what a non-zero status means.
 */
export function runNode(
  args: string[],
  options: { cwd: string; home: string; timeoutMs?: number },
): SpawnResult {
  const result = spawnSync(process.execPath, args, {
    cwd: options.cwd,
    env: { PATH: process.env['PATH'] ?? '', HOME: options.home },
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A failed child's whole story, for an assertion message: exit code, stdout, stderr. */
export function describeSpawn(result: SpawnResult): string {
  return `exit ${String(result.status)}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
}

/**
 * Imports `entries` in a fresh child process with a resolve hook that records every file the
 * module system resolves, and returns those file URLs. The test uses it to prove that no copy
 * silently loaded a realm module from the repository's own workspace.
 */
export async function recordResolvedFiles(layout: Layout, entries: string[]): Promise<string[]> {
  const hooks = join(layout.root, 'record-hooks.mjs');
  const script = join(layout.root, 'record-entries.mjs');
  const log = join(layout.root, 'resolved.log');
  await writeFile(
    hooks,
    [
      "import { appendFileSync } from 'node:fs';",
      'let log = null;',
      'export function initialize(data) { log = data.log; }',
      'export async function resolve(specifier, context, nextResolve) {',
      '  const resolved = await nextResolve(specifier, context);',
      "  if (log !== null && resolved.url.startsWith('file:')) appendFileSync(log, resolved.url + '\\n');",
      '  return resolved;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    script,
    [
      "import { register } from 'node:module';",
      "import { pathToFileURL } from 'node:url';",
      `register(${JSON.stringify(pathToFileURL(hooks).href)}, { parentURL: import.meta.url, data: { log: ${JSON.stringify(log)} } });`,
      `for (const entry of ${JSON.stringify(entries)}) await import(pathToFileURL(entry).href);`,
      '',
    ].join('\n'),
    'utf8',
  );
  const result = runNode([script], { cwd: layout.root, home: layout.root });
  if (result.status !== 0) {
    throw new Error(`recording the resolved files failed:\n${describeSpawn(result)}`);
  }
  const text = existsSync(log) ? await readFile(log, 'utf8') : '';
  return [...new Set(text.split('\n').filter((line) => line.length > 0))];
}
