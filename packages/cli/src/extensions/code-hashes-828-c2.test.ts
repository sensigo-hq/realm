// code-hashes-828-c2.test.ts — #828 unit 1, PR A, correction 2: a failed import never changes a
// folder's sweep (prompt feat-828-u1-pr-a-correction-2.md, checks 1–5).
//
// Each cell drives real `loadProjectExtensions` calls into one order, with no timers. A load runs
// synchronously up to its first import, so loads started in one turn sweep in call order. A module
// whose file awaits a gate holds its import open until the cell opens the gate, and a module that
// calls a signal at its top tells the cell its import has begun. Each file has a unique name, so
// Node's import cache from another cell never serves it.
//
// Every assertion carries (1) the change that turns it red and (2) what it prints when it fails.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { ExtensionIdentityEntry, WorkflowDefinition } from '@sensigo/realm';
import { joinSweeps, sweepFolder } from '@sensigo/realm-mcp/code-hashes';
import { recomputeIdentity } from './extension-identity.js';
import {
  loadProjectExtensions,
  clearProjectExtensionsCache,
  type LoadedProjectExtensions,
} from './load-project-extensions.js';

let root: string;
let counter = 0;

beforeEach(() => {
  clearProjectExtensionsCache();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'realm-828-c2-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '1.0.0' }));
  writeFileSync(join(root, 'realm.yaml'), 'version: 1\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const unique = (stem: string): string => `${stem}-${Date.now()}-${counter++}`;

/** The gates and signals the project's modules reach, by name, on a global the test owns. */
const G = ((globalThis as Record<string, unknown>)['__realm828c2'] ??= {}) as Record<
  string,
  Promise<void> | (() => void)
>;
/** A gate a module's file awaits (`await <held(name)>`); the returned function opens it. */
function gate(name: string): () => void {
  let open!: () => void;
  G[name] = new Promise<void>((resolve) => (open = resolve));
  return open;
}
/** A signal a module's file calls at its top (`<reached(name)>`); the promise settles then. */
function signal(name: string): Promise<void> {
  return new Promise<void>((resolve) => (G[name] = resolve));
}
const held = (name: string): string => `await globalThis.__realm828c2['${name}'];\n`;
const reached = (name: string): string => `globalThis.__realm828c2['${name}']();\n`;

/** Writes `source` to `<root>/<folder>/<name>` and returns its path. */
function write(folder: string, name: string, source: string): string {
  mkdirSync(join(root, folder), { recursive: true });
  const path = join(root, folder, name);
  writeFileSync(path, source);
  return path;
}

/** A workflow-declared module whose handler `id` returns `{ v: '<value>' }`, after `before`. */
const extModule = (id: string, value: string, before = ''): string =>
  `${before}export default { handlers: { '${id}': { id: '${id}', execute: async () => ({ data: { v: '${value}' } }) } } };\n`;
/** A module that fails to parse: its import throws before any of it runs. */
const BROKEN = 'export const b = ;\n';

/** A definition anchored at the temp project, declaring `extensions` relative to it. */
function definition(extensions: string[]): WorkflowDefinition {
  return {
    id: `wf-828-c2-${counter++}`,
    name: 'Correction 2 WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { s1: { description: 'step', execution: 'agent' } },
    origin: 'human',
    source_dir: root,
    trust_root: root,
    extensions,
  };
}

/** Whether a load succeeds. */
const outcome = (load: Promise<unknown>): Promise<string> =>
  load.then(
    () => 'loaded',
    () => 'failed',
  );

/** What the handler `id` returns: the value it read from the bytes the process runs. */
async function runs(loaded: LoadedProjectExtensions, id: string): Promise<unknown> {
  const handler = loaded.registry.getHandler(id);
  if (handler === undefined) throw new Error(`no handler ${id}`);
  const result = (await handler.execute({} as never, {} as never)) as { data?: { v?: unknown } };
  return result.data?.v;
}

/**
 * The identity entry, shown as what a reader of the record sees: the error (an error entry), the
 * roots, and whether the tree is a fresh sweep of the disk now (what `--check-drift` recomputes).
 */
function recorded(loaded: LoadedProjectExtensions) {
  const identity = loaded.registry.identity as ExtensionIdentityEntry;
  const fresh = joinSweeps(identity.tree.roots.map((r) => sweepFolder(r))).tree_hash;
  return {
    error: (identity as { error?: string }).error,
    roots: [...identity.tree.roots].sort(),
    treeIsTheDiskNow: identity.tree.tree_hash === fresh,
  };
}

describe('#828 correction 2 — a failed import never changes a folder’s sweep', () => {
  it('check 1: the failing load sweeps first: the other load in the folder records a normal entry, its tree the folder as it is', async () => {
    const tag = unique('c1');
    write('f', `b-${tag}.js`, BROKEN);
    write('f', `a-${tag}.js`, extModule(`ha-${tag}`, 'a1', held(`ga-${tag}`)));
    const openA = gate(`ga-${tag}`);
    const x = outcome(loadProjectExtensions(definition([`./f/b-${tag}.js`])));
    const y = loadProjectExtensions(definition([`./f/a-${tag}.js`]));
    const failed = await x;
    openA();
    const loaded = await y;
    // (1) red under 324e51d1's importFailed (X's failure removes the sweep it found absent, which
    //     is now Y's: Y's entry is `identity capture failed: no sweep of …`); (2) prints the
    //     outcome, the entry's error, roots and tree, and what the handler returns.
    expect({ failed, ...recorded(loaded), runs: await runs(loaded, `ha-${tag}`) }).toEqual({
      failed: 'failed',
      error: undefined,
      roots: [join(root, 'f')],
      treeIsTheDiskNow: true,
      runs: 'a1',
    });
  });

  it('check 2: the failing load sweeps twice, the other load between: the other load records a normal entry', async () => {
    const tag = unique('c2');
    write('f', `x-${tag}.js`, extModule(`hx-${tag}`, 'x1'));
    write('f', `b-${tag}.js`, BROKEN);
    write('f', `a-${tag}.js`, extModule(`ha-${tag}`, 'a1', held(`ga-${tag}`)));
    const openA = gate(`ga-${tag}`);
    // X sweeps f for x; Y sweeps f for a in the same turn; X sweeps f again for b once x loaded.
    const x = outcome(loadProjectExtensions(definition([`./f/x-${tag}.js`, `./f/b-${tag}.js`])));
    const y = loadProjectExtensions(definition([`./f/a-${tag}.js`]));
    const failed = await x;
    openA();
    const loaded = await y;
    // (1) red under 324e51d1's importFailed (X puts back what was there before its first sweep,
    //     none, over its last sweep, which came after Y's: Y's entry is an error); (2) prints as
    //     check 1.
    expect({ failed, ...recorded(loaded), runs: await runs(loaded, `ha-${tag}`) }).toEqual({
      failed: 'failed',
      error: undefined,
      roots: [join(root, 'f')],
      treeIsTheDiskNow: true,
      runs: 'a1',
    });
  });

  it('check 3: a module shared by two workflows, the other workflow’s second module in another folder: its entry is normal and its tree covers both folders', async () => {
    const tag = unique('c3');
    write('f', `a-${tag}.js`, extModule(`ha-${tag}`, 'a1'));
    write(
      'f',
      `b-${tag}.js`,
      `${reached(`rb-${tag}`)}${held(`g1-${tag}`)}throw new Error('b fails while it runs');\n`,
    );
    write(
      'h',
      `d-${tag}.js`,
      extModule(`hd-${tag}`, 'd1', reached(`rd-${tag}`) + held(`g2-${tag}`)),
    );
    const reachedB = signal(`rb-${tag}`);
    const reachedD = signal(`rd-${tag}`);
    const open1 = gate(`g1-${tag}`);
    const open2 = gate(`g2-${tag}`);
    const x = outcome(loadProjectExtensions(definition([`./f/a-${tag}.js`, `./f/b-${tag}.js`])));
    // X has imported a and swept f again for b, whose import is now running.
    await reachedB;
    const y = loadProjectExtensions(definition([`./f/a-${tag}.js`, `./h/d-${tag}.js`]));
    // Y has passed a (already loaded, f already swept: Y sweeps no f) and swept h for d.
    await reachedD;
    open1();
    const failed = await x;
    open2();
    const loaded = await y;
    // (1) red under 324e51d1's importFailed (X removes f's sweep, which Y relies on: Y's entry is
    //     an error); (2) prints as check 1, and both handlers' values.
    expect({
      failed,
      ...recorded(loaded),
      runs: [await runs(loaded, `ha-${tag}`), await runs(loaded, `hd-${tag}`)],
    }).toEqual({
      failed: 'failed',
      error: undefined,
      roots: [join(root, 'f'), join(root, 'h')].sort(),
      treeIsTheDiskNow: true,
      runs: ['a1', 'd1'],
    });
  });

  it('check 4: with no load running at the same time, a module edited, imported by a load that then fails, then loaded by another: its tree is the folder as it is, and --check-drift says the same', async () => {
    const tag = unique('c4');
    write('f', `y-${tag}.js`, extModule(`hy-${tag}`, 'y1'));
    const a = write('f', `a-${tag}.js`, extModule(`ha-${tag}`, 'a-old'));
    // 1. W0 loads; its sweep reads a's first bytes.
    const w0 = await loadProjectExtensions(definition([`./f/y-${tag}.js`]));
    // 2. a is edited.
    writeFileSync(a, extModule(`ha-${tag}`, 'a-new'));
    // 3. W2 imports a, then fails on b in the same folder.
    write('f', `b-${tag}.js`, BROKEN);
    const w2 = await outcome(
      loadProjectExtensions(definition([`./f/a-${tag}.js`, `./f/b-${tag}.js`])),
    );
    // 4. W1 loads a for the first time (a is already loaded, so it sweeps nothing itself).
    const w1 = await loadProjectExtensions(definition([`./f/a-${tag}.js`]));
    const identity = w1.registry.identity as ExtensionIdentityEntry;
    const drift = recomputeIdentity(identity, { trustRoot: root });
    // (1) red under 324e51d1's put-back (W2's failure puts back W0's sweep, so W1's tree names a's
    //     old bytes while its handler runs the new ones, and the recompute says the tree differs);
    //     (2) prints the outcomes, the entry, what the handler returns and the recompute's tree.
    expect({
      w0: (w0.registry.identity as { error?: string }).error,
      w2,
      ...recorded(w1),
      runs: await runs(w1, `ha-${tag}`),
      treeSame: drift.comparable && drift.tree.current_hash === drift.tree.recorded_hash,
    }).toEqual({
      w0: undefined,
      w2: 'failed',
      error: undefined,
      roots: [join(root, 'f')],
      treeIsTheDiskNow: true,
      runs: 'a-new',
      treeSame: true,
    });
  });

  it('check 5: another workflow loaded from the folder earlier; a edited and b added; the failing load and the other overlap as in check 1: the other load’s tree is the folder as it is, and its handler runs a as it is', async () => {
    const tag = unique('c5');
    write('f', `y-${tag}.js`, extModule(`hy-${tag}`, 'y1'));
    const a = write('f', `a-${tag}.js`, extModule(`ha-${tag}`, 'a-old'));
    // W0 loads from the folder: its sweep reads a's first bytes, and there is no b yet.
    const w0 = await loadProjectExtensions(definition([`./f/y-${tag}.js`]));
    writeFileSync(a, extModule(`ha-${tag}`, 'a-new', held(`ga-${tag}`)));
    write('f', `b-${tag}.js`, BROKEN);
    const openA = gate(`ga-${tag}`);
    const x = outcome(loadProjectExtensions(definition([`./f/b-${tag}.js`])));
    const y = loadProjectExtensions(definition([`./f/a-${tag}.js`]));
    const failed = await x;
    openA();
    const loaded = await y;
    // (1) red under 324e51d1's put-back (X's failure puts back W0's sweep: Y's tree names a's old
    //     bytes and no b); (2) prints as check 1.
    expect({
      w0: (w0.registry.identity as { error?: string }).error,
      failed,
      ...recorded(loaded),
      runs: await runs(loaded, `ha-${tag}`),
    }).toEqual({
      w0: undefined,
      failed: 'failed',
      error: undefined,
      roots: [join(root, 'f')],
      treeIsTheDiskNow: true,
      runs: 'a-new',
    });
  });
});
