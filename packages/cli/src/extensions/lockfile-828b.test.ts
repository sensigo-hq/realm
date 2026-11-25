// lockfile-828b.test.ts — #828 unit 1 PR B: the project's lockfile in the code fingerprint (prompt
// feat-828-u1-pr-b-lockfile.md rev 2.1, with rev 3.1's items 4–7). Checks 6, 9(a)–(k), 15, 16, 16b and
// 17, the cells for rules 4 and 5, `clearCodeHashes`, the drift warning's clause (check 11's
// warning cell), and the Words. Inspect's lines are in commands/inspect.test.ts, `realm run
// advance`'s in commands/docs-pages-625-acting.test.ts, the comparison in core
// (engine/lockfile-fit-828b.test.ts).
//
// The loader cells go through real `loadProjectExtensions` calls on a temp project with a
// `realm.yaml`; a second load is shown to rebuild by a new registry object. Each temp root holds a
// `.git` folder, so the lockfile's walk stops there and never reads the machine's own folders above
// it (9(k) has none, on purpose, and a temporary HOME instead).
//
// Every assertion carries (1) the change that turns it red and (2) what it prints when it fails.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { lockfileNow, sha256Hex } from '@sensigo/realm-mcp/code-hashes';
import { loadProjectExtensions, clearProjectExtensionsCache } from './load-project-extensions.js';
import { lockfileDiffers, recomputeIdentity } from './extension-identity.js';
import { resolveRunAttach } from '../agent/run-attach.js';
import { declared } from '../test-support/declared.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');

let root: string;
let counter = 0;

beforeEach(() => {
  clearProjectExtensionsCache();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'realm-828b-lock-')));
  mkdirSync(join(root, '.git'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const unique = (stem: string): string => `${stem}-${Date.now()}-${counter++}`;
const sha = (text: string): string => sha256Hex(text);
/** The member's hash, by rev 3.1 item 4: the lines `<path>\0<sha256 of the bytes>`, joined. */
const memberHash = (files: Array<[string, string]>): string =>
  sha(files.map(([path, bytes]) => `${path}\u0000${sha(bytes)}`).join('\n'));

/** Writes `text` to `<root>/<rel>`, making its folders. */
function put(rel: string, text: string): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** A project folder under `root`: its `package.json` and `realm.yaml`. */
function project(rel: string, manifest = 'version: 1\n'): string {
  put(join(rel, 'package.json'), JSON.stringify({ type: 'module', version: '1.0.0' }));
  put(join(rel, 'realm.yaml'), manifest);
  return join(root, rel);
}

/** A workflow-declared module source: a default export with one handler. */
const moduleSource = (handler: string): string =>
  `export default { handlers: { ${handler}: { id: '${handler}', execute: async () => ({ data: {} }) } } };\n`;

/** A definition anchored at `folder`, declaring `extensions` relative to it. */
function definition(folder: string, extensions: string[] = []): WorkflowDefinition {
  return {
    id: `wf-828b-${counter++}`,
    name: 'Lockfile WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { s1: { description: 'step', execution: 'agent' } },
    origin: 'human',
    source_dir: folder,
    trust_root: folder,
    ...(extensions.length > 0 ? { extensions } : {}),
  };
}

/** The lockfile member a load of `folder`'s project records. */
async function lockfileOf(folder: string): Promise<unknown> {
  return (await loadProjectExtensions(definition(folder))).registry.identity?.lockfile;
}

describe('#828 PR B — check 6: the lockfile once over a rebuild', () => {
  it('package-lock.json changed between the loads: the rebuilt identity keeps the first sha256', async () => {
    const dir = project('p');
    const L1 = '{"tag":"L1"}\n';
    put('p/package-lock.json', L1);
    const name = unique('m');
    put(`p/ext/${name}.js`, moduleSource(`h_${counter}`));
    const def = definition(dir, [`./ext/${name}.js`]);
    const one = await loadProjectExtensions(def);
    put('p/package-lock.json', '{"tag":"L2"}\n');
    put('p/.env', 'ROTATED=1\n');
    const two = await loadProjectExtensions(def);
    // (1) red when the rebuild reads the lockfile again (L2's hash); (2) prints whether it rebuilt
    //     and the member.
    expect({
      rebuilt: two.registry !== one.registry,
      lockfile: two.registry.identity?.lockfile,
    }).toEqual({
      rebuilt: true,
      lockfile: { files: ['package-lock.json'], sha256: memberHash([['package-lock.json', L1]]) },
    });
  });
});

describe('#828 PR B — check 9: where the lockfile is found', () => {
  it('(a) package-lock.json in the project folder', async () => {
    const dir = project('p');
    const L = '{"lockfileVersion":3}\n';
    put('p/package-lock.json', L);
    // (1) red when no member is written, or its hash is not rule 4's; (2) prints the member.
    expect(await lockfileOf(dir)).toEqual({
      files: ['package-lock.json'],
      sha256: memberHash([['package-lock.json', L]]),
    });
  });

  it("(b) Realm's own case: a project with package.json and no lockfile, the workspace root two folders up holds package-lock.json", async () => {
    const dir = project('packages/p');
    const L = '{"root":true}\n';
    put('package-lock.json', L);
    // (1) red when only the project's folder is looked in; (2) prints the member.
    expect(await lockfileOf(dir)).toEqual({
      files: ['../../package-lock.json'],
      sha256: memberHash([['../../package-lock.json', L]]),
    });
  });

  it('(c) the same with pnpm-workspace.yaml and pnpm-lock.yaml', async () => {
    const dir = project('packages/p');
    put('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
    const L = 'lockfileVersion: 9.0\n';
    put('pnpm-lock.yaml', L);
    // (1) red when only the project's folder is looked in, or pnpm's name is not one; (2) prints it.
    expect(await lockfileOf(dir)).toEqual({
      files: ['../../pnpm-lock.yaml'],
      sha256: memberHash([['../../pnpm-lock.yaml', L]]),
    });
  });

  it("(d) a sub-folder with realm.yaml and its own package.json, inside an app whose root holds package-lock.json and .git: the root's", async () => {
    const dir = project('sub');
    const L = '{"app":true}\n';
    put('package-lock.json', L);
    // (1) red when the walk stops at the sub-folder's package.json; (2) prints the member.
    expect(await lockfileOf(dir)).toEqual({
      files: ['../package-lock.json'],
      sha256: memberHash([['../package-lock.json', L]]),
    });
  });

  it('(e) no lockfile up to a .git folder: none found, even with package-lock.json in the folder above it', async () => {
    // The repository is `root/repo`; the folder above it (root) holds a lockfile.
    mkdirSync(join(root, 'repo', '.git'), { recursive: true });
    const dir = project('repo/p');
    put('package-lock.json', '{"above":true}\n');
    // (1) red when the walk goes past the first .git folder; (2) prints the member.
    expect(await lockfileOf(dir)).toEqual({ absent: 'none_found' });
  });

  it('(f) npm-shrinkwrap.json beside package-lock.json: only the shrinkwrap', async () => {
    const dir = project('p');
    const S = '{"shrinkwrap":true}\n';
    put('p/npm-shrinkwrap.json', S);
    put('p/package-lock.json', '{"lock":true}\n');
    // (1) red when both npm files are taken; (2) prints the member.
    expect(await lockfileOf(dir)).toEqual({
      files: ['npm-shrinkwrap.json'],
      sha256: memberHash([['npm-shrinkwrap.json', S]]),
    });
  });

  it('(g) package-lock.json beside yarn.lock: both, sorted, one hash', async () => {
    const dir = project('p');
    const N = '{"npm":true}\n';
    const Y = '# yarn lockfile v1\n';
    put('p/yarn.lock', Y);
    put('p/package-lock.json', N);
    // (1) red when only the first file is taken, or they are not sorted; (2) prints the member.
    expect(await lockfileOf(dir)).toEqual({
      files: ['package-lock.json', 'yarn.lock'],
      sha256: memberHash([
        ['package-lock.json', N],
        ['yarn.lock', Y],
      ]),
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    '(h) an unreadable lockfile (mode 000): files and unreadable, and the load does not fail',
    async () => {
      const dir = project('p');
      const lock = put('p/package-lock.json', '{"secret":true}\n');
      chmodSync(lock, 0o000);
      try {
        // (1) red when the read error escapes (the load fails) or the file is taken as absent; (2)
        //     prints the member.
        expect(await lockfileOf(dir)).toEqual({
          files: ['package-lock.json'],
          absent: 'unreadable',
        });
      } finally {
        chmodSync(lock, 0o644);
      }
    },
  );

  it('(i) a definition with no trust_root: the lockfile is found from projectDir, and the identity has no signals (rule 5)', async () => {
    const dir = project('p');
    put('p/.git/HEAD', 'ref: refs/heads/main\n');
    put('p/.git/refs/heads/main', 'f'.repeat(40) + '\n');
    const L = '{"projectDir":true}\n';
    put('p/package-lock.json', L);
    const def: WorkflowDefinition = {
      id: `wf-828b-${counter++}`,
      name: 'No trust root',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { s1: { description: 'step', execution: 'agent' } },
      origin: 'agent',
    };
    const identity = (await loadProjectExtensions(def, { projectDir: dir })).registry.identity;
    // (1) red when no member is written without a trust_root, or the signals are keyed by the
    //     lockfile's start (projectDir) and read; (2) prints the member and the signals.
    expect({ lockfile: identity?.lockfile, signals: identity?.signals }).toEqual({
      lockfile: { files: ['package-lock.json'], sha256: memberHash([['package-lock.json', L]]) },
      signals: undefined,
    });
  });

  it('(j) a symlinked lockfile is read through the link; a dangling link is absent; a project folder reached through a link walks from its real path', async () => {
    // Through the link: the bytes are the target's.
    const linked = project('linked');
    const T = '{"target":true}\n';
    put('targets/lock.json', T);
    symlinkSync(join(root, 'targets', 'lock.json'), join(linked, 'package-lock.json'));
    const throughLink = await lockfileOf(linked);
    // A dangling link: absent.
    const dangling = project('dangling');
    symlinkSync(join(root, 'nowhere.json'), join(dangling, 'package-lock.json'));
    const absent = await lockfileOf(dangling);
    // A project folder reached through a link: its real path is `real/proj`, whose parent holds the
    // lockfile; the link's own parent (root, with .git) holds none.
    project('real/proj');
    const R = '{"real":true}\n';
    put('real/package-lock.json', R);
    symlinkSync(join(root, 'real', 'proj'), join(root, 'via'));
    const viaLink = await lockfileOf(join(root, 'via'));
    // (1) red when the link is skipped, or the logical path is walked (none found from `via`); (2)
    //     prints the three members.
    expect({ throughLink, absent, viaLink }).toEqual({
      throughLink: { files: ['package-lock.json'], sha256: memberHash([['package-lock.json', T]]) },
      absent: { absent: 'none_found' },
      viaLink: {
        files: ['../package-lock.json'],
        sha256: memberHash([['../package-lock.json', R]]),
      },
    });
  });

  it("(k) outside a repository, a package-lock.json in the user's home folder is not taken for a project below it", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'realm-828b-home-')));
    const savedHome = process.env['HOME'];
    try {
      const home = join(outside, 'home');
      mkdirSync(join(home, 'proj'), { recursive: true });
      writeFileSync(join(home, 'package-lock.json'), '{"home":true}\n');
      writeFileSync(join(home, 'proj', 'package.json'), JSON.stringify({ type: 'module' }));
      writeFileSync(join(home, 'proj', 'realm.yaml'), 'version: 1\n');
      process.env['HOME'] = home;
      // (1) red when the home folder is searched; (2) prints the member.
      expect(await lockfileOf(join(home, 'proj'))).toEqual({ absent: 'none_found' });
    } finally {
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('#828 PR B — rules 4 and 5, and clearCodeHashes', () => {
  it('rule 4: --extensions-module on a definition with no trust_root, loaded with no projectDir: none_found', async () => {
    const mod = put(`ext/${unique('override')}.js`, moduleSource(`h_${counter}`));
    put('package-lock.json', '{"near":true}\n');
    const def: WorkflowDefinition = {
      id: `wf-828b-${counter++}`,
      name: 'No anchor',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { s1: { description: 'step', execution: 'agent' } },
      origin: 'agent',
    };
    const identity = (await loadProjectExtensions(def, { overrideModule: mod })).registry.identity;
    // (1) red when no member is written (a missing member reads as "recorded before this unit"); (2)
    //     prints the identity's override flag and member.
    expect({ override: identity?.override_active, lockfile: identity?.lockfile }).toEqual({
      override: true,
      lockfile: { absent: 'none_found' },
    });
  });

  it('clearCodeHashes forgets the kept lockfile, as a new process starts with none', async () => {
    const dir = project('p');
    put('p/package-lock.json', '{"tag":"L1"}\n');
    await lockfileOf(dir);
    const L2 = '{"tag":"L2"}\n';
    put('p/package-lock.json', L2);
    put('p/.env', 'ROTATED=1\n');
    clearProjectExtensionsCache();
    // (1) red when clearCodeHashes leaves the lockfile maps (L1's hash); (2) prints the member.
    expect(await lockfileOf(dir)).toEqual({
      files: ['package-lock.json'],
      sha256: memberHash([['package-lock.json', L2]]),
    });
  });
});

describe('#828 PR B — checks 15, 16, 16b and 17: when the lockfile is read', () => {
  it('check 15: a TypeScript module (the real jiti) fails on a missing package; the lockfile changes and the package is added; the retry keeps the FIRST lockfile, and --check-drift says it DIFFERS', async () => {
    const dir = project('p');
    const L1 = '{"tag":"L1"}\n';
    put('p/package-lock.json', L1);
    // The project's node_modules: the repo's real jiti linked in, and another package, so the folder
    // exists when the import fails (every real project).
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    symlinkSync(join(REPO, 'node_modules', 'jiti'), join(dir, 'node_modules', 'jiti'));
    put(
      'p/node_modules/other/package.json',
      JSON.stringify({ name: 'other', version: '1.0.0', main: 'index.js' }),
    );
    put('p/node_modules/other/index.js', 'module.exports = 1;\n');
    const pkg = unique('pq');
    const name = unique('m');
    put(
      `p/ext/${name}.ts`,
      `import { value } from '${pkg}';\nexport default { handlers: { h_${counter}: { id: 'h_${counter}', execute: async () => ({ data: { value } }) } } };\n`,
    );
    const def = definition(dir, [`./ext/${name}.ts`]);
    const first = await loadProjectExtensions(def).then(
      () => 'loaded',
      () => 'failed',
    );
    put('p/package-lock.json', '{"tag":"L2"}\n');
    put(
      `p/node_modules/${pkg}/package.json`,
      JSON.stringify({ name: pkg, version: '1.0.0', main: 'lib/i.js' }),
    );
    put(`p/node_modules/${pkg}/lib/i.js`, 'exports.value = 1;\n');
    const retry = (await loadProjectExtensions(def)).registry.identity!;
    const recomputed = recomputeIdentity(retry);
    const drift = recomputed.comparable ? recomputed.lockfile : undefined;
    // (1) red when the lockfile is read again after the import failure (the retry names L2 and the
    //     recompute says the same); (2) prints the first outcome, the member and the recompute.
    expect({
      first,
      format: retry.modules[0]?.format,
      lockfile: retry.lockfile,
      differs: drift?.current !== undefined && lockfileDiffers(drift.recorded, drift.current),
    }).toEqual({
      first: 'failed',
      format: 'ts-jiti',
      lockfile: { files: ['package-lock.json'], sha256: memberHash([['package-lock.json', L1]]) },
      differs: true,
    });
  }, 60_000);

  it("check 16: two workflows of one project; X loads, the lockfile changes, Y's first load records X's first value", async () => {
    const dir = project('p');
    const L1 = '{"tag":"L1"}\n';
    put('p/package-lock.json', L1);
    const x = unique('x');
    const y = unique('y');
    put(`p/ext/${x}.js`, moduleSource(`hx_${counter}`));
    put(`p/ext2/${y}.js`, moduleSource(`hy_${counter}`));
    await loadProjectExtensions(definition(dir, [`./ext/${x}.js`]));
    put('p/package-lock.json', '{"tag":"L2"}\n');
    const Y = (await loadProjectExtensions(definition(dir, [`./ext2/${y}.js`]))).registry.identity;
    // (1) red when the lockfile is read per load (Y names L2); (2) prints Y's member.
    expect(Y?.lockfile).toEqual({
      files: ['package-lock.json'],
      sha256: memberHash([['package-lock.json', L1]]),
    });
  });

  it('check 16b: two projects of one workspace at two depths; X (project a) loads, the lockfile changes, Y (project packages/b) records the FIRST bytes under its own path', async () => {
    const L1 = '{"tag":"L1"}\n';
    put('package-lock.json', L1);
    const a = project('a');
    const b = project('packages/b');
    const x = unique('x');
    const y = unique('y');
    put(`a/ext/${x}.js`, moduleSource(`hx_${counter}`));
    put(`packages/b/ext/${y}.js`, moduleSource(`hy_${counter}`));
    const X = (await loadProjectExtensions(definition(a, [`./ext/${x}.js`]))).registry.identity;
    put('package-lock.json', '{"tag":"L2"}\n');
    const Y = (await loadProjectExtensions(definition(b, [`./ext/${y}.js`]))).registry.identity;
    // (1) red when the value is kept by trust root (Y hashes L2), or the member is shared whole
    //     across projects (Y's files name a's path, `../package-lock.json`); (2) prints both members.
    expect({ X: X?.lockfile, Y: Y?.lockfile }).toEqual({
      X: { files: ['../package-lock.json'], sha256: memberHash([['../package-lock.json', L1]]) },
      Y: {
        files: ['../../package-lock.json'],
        sha256: memberHash([['../../package-lock.json', L1]]),
      },
    });
  });

  it('check 17: a catalog use:-only manifest (no first import); package-lock.json and .env change; it rebuilds; both identities hold the first value', async () => {
    const dir = project('p', 'version: 1\nadapters:\n  store:\n    use: mock\n');
    const L1 = '{"tag":"L1"}\n';
    put('p/package-lock.json', L1);
    put('p/.env', 'A=1\n');
    const def = definition(dir);
    const one = await loadProjectExtensions(def);
    put('p/package-lock.json', '{"tag":"L2"}\n');
    put('p/.env', 'A=2\n');
    const two = await loadProjectExtensions(def);
    const first = { files: ['package-lock.json'], sha256: memberHash([['package-lock.json', L1]]) };
    // (1) red when the lockfile is read at every identity computation (the rebuild names L2); (2)
    //     prints whether it rebuilt and both members.
    expect({
      rebuilt: two.registry !== one.registry,
      modules: two.registry.identity?.modules.length,
      one: one.registry.identity?.lockfile,
      two: two.registry.identity?.lockfile,
    }).toEqual({ rebuilt: true, modules: 0, one: first, two: first });
  });
});

describe('#828 PR B — check 11: the drift warning names the lockfile when it differs', () => {
  /** A run of `def` in an in-memory store, its history seeded with `identity`. */
  async function runWith(store: InMemoryStore, def: WorkflowDefinition, identity: unknown) {
    const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const { record: run } = await store.get(record.id);
    (run as { extension_identity?: unknown[] }).extension_identity = [identity];
    await store.update(run);
    return record.id;
  }
  /** The drift warning lines one attach prints, the per-process map forgotten first (a new process). */
  async function attach(
    store: InMemoryStore,
    runId: string,
    def: WorkflowDefinition,
  ): Promise<string[]> {
    clearProjectExtensionsCache();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await resolveRunAttach(runId, { store, workflowStore: declared({ get: async () => def }) });
      return err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('identity differs'));
    } finally {
      err.mockRestore();
    }
  }

  it('only the lockfile changed between two attaches: the clause; only the tree changed: none', async () => {
    const dir = project('p');
    put('p/package-lock.json', '{"tag":"L1"}\n');
    const name = unique('m');
    put(`p/ext/${name}.js`, moduleSource(`h_${counter}`));
    const helper = put('p/ext/helper.js', 'export const x = 1;\n');
    const def = definition(dir, [`./ext/${name}.js`]);
    const store = new InMemoryStore();
    // The first attach's identity, as the run would record it.
    clearProjectExtensionsCache();
    const recorded = (await loadProjectExtensions(def)).registry.identity!;
    const runId = await runWith(store, def, recorded);
    put('p/package-lock.json', '{"tag":"L2"}\n');
    const lockOnly = await attach(store, runId, def);
    // The tree only: the lockfile back as it was, a helper edited.
    put('p/package-lock.json', '{"tag":"L1"}\n');
    writeFileSync(helper, 'export const x = 2;\n');
    const treeOnly = await attach(store, runId, def);
    const L1 = memberHash([['package-lock.json', '{"tag":"L1"}\n']]);
    const L2 = memberHash([['package-lock.json', '{"tag":"L2"}\n']]);
    // (1) red when the clause is not printed, or printed when only the tree changed; (2) prints the
    //     warning lines.
    expect({
      lockOnly: lockOnly.map((l) =>
        l.includes(
          `; recorded lockfile sha256 ${L1}, current lockfile sha256 ${L2}. Advisory only`,
        ),
      ),
      treeOnly: treeOnly.map((l) => l.includes('lockfile')),
    }).toEqual({ lockOnly: [true], treeOnly: [false] });
  });
});

describe('#828 PR B — the Words, each pinned (named beside it)', () => {
  it('the project-extensions page, the acting and record pages and the CHANGELOG carry the lockfile words', () => {
    const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
    const flat = (text: string) => text.replace(/\s+/g, ' ');
    const page = flat(read('docs/reference/project-extensions.md'));
    const sentences: Array<[string, string]> = [
      // The table row: check 9 (the forms), core check 10 (compared like the code).
      [
        page,
        "| `lockfile` | The project's lockfile: the files' paths from the project's folder and a SHA-256 over their paths and hashes, or that none was found, or that it cannot be read (an unreadable lockfile is compared by its file names only). Compared like the code. A run made after version 0.50.0 records it. |",
      ],
      // Where Realm looks: check 9 (a)–(k).
      [
        page,
        "The lockfile is every one of `npm-shrinkwrap.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock` and `bun.lockb` in the nearest folder that holds one, looking first in the project's folder and then in each folder above it, up to the repository's root (the first folder with a `.git` directory). Outside a repository it never looks in the user's home folder or above it, unless the project's folder is the home folder itself; then it looks there and no higher. When `npm-shrinkwrap.json` is present, `package-lock.json` beside it is left out, as npm itself ignores it. It records what the project declares, not what `node_modules` holds.",
      ],
      // When it is read: checks 6, 15, 16, 16b and 17.
      [
        page,
        "It reads each lockfile once, just before it first loads the code of a project that uses it (for a project with no code of its own, when it first loads `realm.yaml`), and keeps it for every project that uses it, even when an import fails, so a package installed afterwards without a restart shows as a changed lockfile. It keeps each file's hash, so",
      ],
      // The carry-on and the older run: core check 10 (a missing member is left out).
      [
        page,
        "A changed lockfile counts as changed code. When an answer is given over MCP with its `claim_token`, Realm runs the steps after it in the same call only when the server's code, lockfile included, is the code the run last ran with. Otherwise the reply's `next_actions` holds `advance_run`, and the owed steps run with the code of whichever program advances the run. A run whose last entry was recorded by version 0.50.0 or earlier does not compare lockfiles until its code changes.",
      ],
      // The acting row: docs-pages-625-acting (the advance cell after a lockfile-only change).
      [
        flat(read('docs/reference/cli/realm-run-acting.md')),
        "Comparable, and different: a code file, an entry module, the `realm.yaml` or the `--extensions-module` override, or the project's lockfile changed.",
      ],
      // The record row: check 12 (the store keeps it), check 9.
      [
        flat(read('docs/reference/run-record-and-export.md')),
        "Which project code ran the run, and the project's lockfile.",
      ],
      // The CHANGELOG Added line: check 14 (the API report names the type), checks 11 and 15–17.
      [
        read('CHANGELOG.md'),
        "- A run's recorded project code now includes the project's lockfile: `ExtensionIdentityEntry` gains `lockfile`, an `ExtensionIdentityLockfile` (the files and a SHA-256 over them, none found, or unreadable). `realm run inspect` and `--check-drift` show it, and a changed lockfile counts as changed code for the drift warning, `realm run advance` and carrying a run on. A process reads each lockfile once, before it first loads the code of a project that uses it, and keeps it (#828).",
      ],
    ];
    // (1) red when a sentence is changed or dropped; (2) prints the missing ones.
    expect(
      sentences.filter(([text, s]) => !text.includes(s)).map(([, s]) => s.slice(0, 80)),
    ).toEqual([]);
    // The example block's line, with inspect's own indent (its form: inspect.test.ts; its hash: the
    // next cell).
    // (1) red when the line is changed or dropped; (2) prints whether it is there.
    expect(
      read('docs/reference/project-extensions.md').includes(
        '\n     lockfile: package-lock.json (sha256 over these files: 829145c35459e9c807d45145dedb2fe0b40b1a4ea10e8c11da2bae9f94eba090)\n',
      ),
    ).toBe(true);
  });

  it('the example line is what the built function gives for that lockfile', () => {
    const shop = join(root, 'shop');
    mkdirSync(join(shop, '.git'), { recursive: true });
    writeFileSync(
      join(shop, 'package-lock.json'),
      '{\n  "name": "shop",\n  "version": "1.4.0",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": { "name": "shop", "version": "1.4.0" }\n  }\n}\n',
    );
    // (1) red when the built function's member for that lockfile is not the example's; (2) prints it.
    expect(lockfileNow(shop)).toEqual({
      files: ['package-lock.json'],
      sha256: '829145c35459e9c807d45145dedb2fe0b40b1a4ea10e8c11da2bae9f94eba090',
    });
  });
});
