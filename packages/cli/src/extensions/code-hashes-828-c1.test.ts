// code-hashes-828-c1.test.ts — #828 unit 1, PR A, correction 1: the record names the bytes the
// process runs, after a failed load and for a module that loads later (prompt
// feat-828-u1-pr-a-correction-1.md, checks 1–7, and the docs cell for its words).
//
// Each loader cell loads, changes files, loads again in the same process, and runs the handler,
// which returns a value read from its own file or its helper: so the cell shows which bytes the
// process runs beside the bytes it records. Each file has a unique name, so Node's import cache
// from another cell never serves it.
//
// Every assertion carries (1) the change that turns it red and (2) what it prints when it fails.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { hashFile, joinSweeps, sha256Hex, sweepFolder } from '@sensigo/realm-mcp/code-hashes';
import {
  loadProjectExtensions,
  clearProjectExtensionsCache,
  type LoadedProjectExtensions,
} from './load-project-extensions.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
let root: string;
let counter = 0;

beforeEach(() => {
  clearProjectExtensionsCache();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'realm-828-c1-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '1.0.0' }));
  writeFileSync(join(root, 'realm.yaml'), 'version: 1\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const unique = (stem: string): string => `${stem}-${Date.now()}-${counter++}`;
const sha = (text: string): string => sha256Hex(text);

/** Writes `source` to `<root>/<folder>/<name>` and returns its path. */
function write(folder: string, name: string, source: string): string {
  mkdirSync(join(root, folder), { recursive: true });
  const path = join(root, folder, name);
  writeFileSync(path, source);
  return path;
}

/** A workflow-declared module whose handler `id` returns `{ v: <expression> }`. */
const extModule = (id: string, value: string, imports = ''): string =>
  `${imports}\nexport default { handlers: { ${id}: { id: '${id}', execute: async () => ({ data: { v: ${value} } }) } } };\n`;

/** A manifest `use:` module whose handler returns `{ v: <expression> }`. */
const factoryModule = (value: string, imports = ''): string =>
  `${imports}\nexport function factory({ id }) { return { id, execute: async () => ({ data: { v: ${value} } }) }; }\n`;

/** A definition anchored at the temp project, declaring `extensions` relative to it. */
function definition(extensions: string[]): WorkflowDefinition {
  return {
    id: `wf-828-c1-${counter++}`,
    name: 'Correction 1 WF',
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

/** A folder's tree as the process loaded it: `first` gives the loaded hash of the files named in it. */
function treeAsLoaded(folder: string, first: ReadonlyMap<string, ReturnType<typeof hashFile>>) {
  return joinSweeps([
    sweepFolder(join(root, folder), (path) => (first.has(path) ? first.get(path) : hashFile(path))),
  ]);
}

describe('#828 correction 1 — the record names the bytes the process runs', () => {
  it('check 1: a load that fails after its import (realm.yaml names #missing) keeps what it read: the retry records the helper as loaded, and the handler runs it', async () => {
    const tag = unique('c');
    const helper = write('a', `h-${tag}.js`, 'export const y = 1;\n');
    const helperFirst = hashFile(helper);
    write('a', `c-${tag}.js`, factoryModule('y', `import { y } from './h-${tag}.js';`));
    const manifest = (name: string) =>
      `version: 1\nhandlers:\n  hc:\n    use: ./a/c-${tag}.js#${name}\n`;
    writeFileSync(join(root, 'realm.yaml'), manifest('missing'));
    const def = definition([]);
    const first = await outcome(loadProjectExtensions(def));
    writeFileSync(helper, 'export const y = 2;\n');
    writeFileSync(join(root, 'realm.yaml'), manifest('factory'));
    const two = await loadProjectExtensions(def);
    // (1) red under 9b9db79e's rule (a failed load keeps nothing but entry hashes: the retry sweeps
    //     the folder again and records the edited helper); (2) prints the outcome, the tree and what
    //     the handler returns.
    expect({
      first,
      tree_hash: two.registry.identity?.tree.tree_hash,
      runs: await runs(two, 'hc'),
    }).toEqual({
      first: 'failed',
      tree_hash: treeAsLoaded('a', new Map([[helper, helperFirst]])).tree_hash,
      runs: 1,
    });
  });

  it('check 2: another folder’s module fails to import: the loaded folder’s part of the tree is the bytes loaded, the failed folder’s the fixed bytes', async () => {
    const tag = unique('f');
    const helper = write('fa', `h-${tag}.js`, 'export const y = 1;\n');
    const helperFirst = hashFile(helper);
    const handlerA = `fa_${tag.replace(/\W/g, '_')}`;
    write('fa', `a-${tag}.js`, extModule(handlerA, 'y', `import { y } from './h-${tag}.js';`));
    const x = write('fx', `x-${tag}.js`, 'export function factory( {{ broken');
    writeFileSync(
      join(root, 'realm.yaml'),
      `version: 1\nhandlers:\n  hx:\n    use: ./fx/x-${tag}.js#factory\n`,
    );
    const def = definition([`./fa/a-${tag}.js`]);
    const first = await outcome(loadProjectExtensions(def));
    writeFileSync(helper, 'export const y = 2;\n');
    writeFileSync(x, factoryModule("'x'"));
    const two = await loadProjectExtensions(def);
    const expected = joinSweeps([
      sweepFolder(join(root, 'fa'), (p) => (p === helper ? helperFirst : hashFile(p))),
      sweepFolder(join(root, 'fx')),
    ]);
    // (1) red when every folder is dropped on an import failure (the retry records fa's edited
    //     helper); (2) prints the outcome, the roots, the tree and what A returns.
    expect({
      first,
      roots: two.registry.identity?.tree.roots,
      tree_hash: two.registry.identity?.tree.tree_hash,
      runs: await runs(two, handlerA),
    }).toEqual({
      first: 'failed',
      roots: [join(root, 'fa'), join(root, 'fx')],
      tree_hash: expected.tree_hash,
      runs: 1,
    });
  });

  it('check 3: the shared folder: a second workflow’s module, edited before it first loads, records its edited bytes, and runs them', async () => {
    const tag = unique('s');
    write('shared', `a-${tag}.js`, extModule(`sa_${tag.replace(/\W/g, '_')}`, "'a1'"));
    const bId = `sb_${tag.replace(/\W/g, '_')}`;
    const bPath = write('shared', `b-${tag}.js`, extModule(bId, "'b1'"));
    await loadProjectExtensions(definition([`./shared/a-${tag}.js`]));
    const edited = extModule(bId, "'b2'");
    writeFileSync(bPath, edited);
    const second = await loadProjectExtensions(definition([`./shared/b-${tag}.js`]));
    // (1) red when a module's own file takes the hash its folder's sweep already holds (b's first
    //     bytes); (2) prints b's entry hash, the tree and what b returns.
    expect({
      entry_hash: second.registry.identity?.modules[0]?.entry_hash,
      tree_hash: second.registry.identity?.tree.tree_hash,
      runs: await runs(second, bId),
    }).toEqual({
      entry_hash: sha(edited),
      tree_hash: joinSweeps([sweepFolder(join(root, 'shared'))]).tree_hash,
      runs: 'b2',
    });
  });

  it('check 4: the same folder after a failed import: a loaded before b; b broken; a edited, b fixed: a’s entry hash stays its first bytes and a runs them, b’s is the fixed bytes', async () => {
    const tag = unique('t');
    const aId = `ta_${tag.replace(/\W/g, '_')}`;
    const firstA = extModule(aId, "'a1'");
    const aPath = write('ext', `a-${tag}.js`, firstA);
    const bId = `tb_${tag.replace(/\W/g, '_')}`;
    const bPath = write('ext', `b-${tag}.js`, 'export default {{ broken');
    const def = definition([`./ext/a-${tag}.js`, `./ext/b-${tag}.js`]);
    const first = await outcome(loadProjectExtensions(def));
    writeFileSync(aPath, extModule(aId, "'a2'"));
    const fixedB = extModule(bId, "'b1'");
    writeFileSync(bPath, fixedB);
    const two = await loadProjectExtensions(def);
    const hashes = Object.fromEntries(
      (two.registry.identity?.modules ?? []).map((m) => [m.resolved, m.entry_hash]),
    );
    // (1) red when a's own hash is dropped with its folder (a's edited bytes recorded while a runs
    //     its first); (2) prints both entry hashes and what a returns.
    expect({ first, a: hashes[aPath], runsA: await runs(two, aId), b: hashes[bPath] }).toEqual({
      first: 'failed',
      a: sha(firstA),
      runsA: 'a1',
      b: sha(fixedB),
    });
  });

  it('a failed import drops what the load read in its folder (the words’ third exception): a module broken in its own file, its helper edited before the retry: the retry records the edited helper, which the handler runs', async () => {
    const tag = unique('d');
    const id = `d_${tag.replace(/\W/g, '_')}`;
    const helper = write('ext', `h-${tag}.js`, 'export const y = 1;\n');
    const path = write('ext', `m-${tag}.js`, 'export default {{ broken');
    const def = definition([`./ext/m-${tag}.js`]);
    const first = await outcome(loadProjectExtensions(def));
    // Node never loaded the helper: the module failed to parse before importing it.
    writeFileSync(helper, 'export const y = 2;\n');
    writeFileSync(path, extModule(id, 'y', `import { y } from './h-${tag}.js';`));
    const two = await loadProjectExtensions(def);
    // (1) red when a failed import drops nothing (the retry records the helper's first bytes, which
    //     the process never loaded); (2) prints the outcome, the tree and what the handler returns.
    expect({
      first,
      tree_hash: two.registry.identity?.tree.tree_hash,
      runs: await runs(two, id),
    }).toEqual({
      first: 'failed',
      tree_hash: joinSweeps([sweepFolder(join(root, 'ext'))]).tree_hash,
      runs: 2,
    });
  });

  it('check 5: the signals are taken once and kept, also when the load fails on an import: the retry’s signals are the first load’s', async () => {
    mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), 'a'.repeat(40) + '\n');
    const tag = unique('g');
    const id = `g_${tag.replace(/\W/g, '_')}`;
    const path = write('ext', `m-${tag}.js`, 'export default {{ broken');
    const def = definition([`./ext/m-${tag}.js`]);
    const first = await outcome(loadProjectExtensions(def));
    writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), 'b'.repeat(40) + '\n');
    writeFileSync(path, extModule(id, "'m1'"));
    const two = await loadProjectExtensions(def);
    // (1) red when the signals are read again at the retry (the new ref); (2) prints both.
    expect({ first, signals: two.registry.identity?.signals }).toEqual({
      first: 'failed',
      signals: { package_version: '1.0.0', git_head: 'a'.repeat(40) },
    });
  });

  it('check 6: a module past its folder’s cap that rewrites its own file when it loads: its entry hash is its bytes before the load', async () => {
    const tag = unique('z');
    const id = `z_${tag.replace(/\W/g, '_')}`;
    const source = extModule(
      id,
      "'z'",
      "import { readFileSync, writeFileSync } from 'node:fs';\nimport { fileURLToPath } from 'node:url';\nconst self = fileURLToPath(import.meta.url);\nwriteFileSync(self, readFileSync(self, 'utf8') + '// rewritten when it loaded\\n');",
    );
    const path = write('big', `zzz-${tag}.js`, source);
    for (let i = 0; i < 2000; i++)
      writeFileSync(join(root, 'big', `f${String(i).padStart(4, '0')}.js`), `${i}`);
    const loaded = await loadProjectExtensions(definition([`./big/zzz-${tag}.js`]));
    // (1) red when the module's hash is read after its import (the rewritten bytes); (2) prints the
    //     entry hash, whether the file was rewritten, and the tree's cap.
    expect({
      entry_hash: loaded.registry.identity?.modules[0]?.entry_hash,
      rewritten: readFileSync(path, 'utf8') !== source,
      file_count: loaded.registry.identity?.tree.file_count,
      truncated: loaded.registry.identity?.tree.truncated,
    }).toEqual({ entry_hash: sha(source), rewritten: true, file_count: 2000, truncated: true });
  });

  it('check 7: a rebuild after a .env change moves captured past the first load, and keeps the first entry hash', async () => {
    const tag = unique('r');
    const first = extModule(`r_${tag.replace(/\W/g, '_')}`, "'r1'");
    write('ext', `r-${tag}.js`, first);
    const def = definition([`./ext/r-${tag}.js`]);
    const one = await loadProjectExtensions(def);
    const firstAt = Date.parse(one.registry.identity!.captured_at);
    // The clock must move past the first load's millisecond, or the two stamps can be equal.
    while (Date.now() < firstAt + 2) await new Promise((resolve) => setTimeout(resolve, 1));
    writeFileSync(join(root, '.env'), 'ROTATED=1\n');
    const two = await loadProjectExtensions(def);
    // (1) red when the rebuild keeps the first load's `captured_at`, or does not rebuild; (2) prints
    //     both stamps and the entry hash.
    expect({
      rebuilt: two.registry !== one.registry,
      later: Date.parse(two.registry.identity!.captured_at) > firstAt,
      entry_hash: two.registry.identity?.modules[0]?.entry_hash,
    }).toEqual({ rebuilt: true, later: true, entry_hash: sha(first) });
  });
});

describe('#828 correction 1 — the words', () => {
  it('the project-extensions page and the CHANGELOG carry the correction’s words, each pinned (named beside it)', () => {
    const page = readFileSync(join(REPO, 'docs', 'reference', 'project-extensions.md'), 'utf8');
    const changelog = readFileSync(join(REPO, 'CHANGELOG.md'), 'utf8');
    const flat = (text: string) => text.replace(/\s+/g, ' ');
    const sentences = [
      // The two moments: checks 3 and 6 above (a module's own file), rev 3.1's check 2 (a sweep).
      "A process takes each file's hash at one of two moments: a module's own file just before that module first loads; any other file when a sweep of its folder first finds it, just before a module of that folder first loads.",
      // As loaded: checks 1 and 2 above, rev 3.1's checks 1 and 2.
      // #828 PR B: "It keeps that hash" became "It keeps each file's hash" (its Words).
      "It keeps each file's hash, so a process that keeps running after a file changes records the file as it loaded it, with three exceptions:",
      // Exception 1: plans/issue-828/LEFTOVERS.md (a file first loaded later; a nice to have).
      '- A file first loaded later, through a module that loads later, keeps its first hash.',
      // Exception 2: LEFTOVERS.md (audit S1).
      '- A file that another module had already loaded records its edit when it is first named as a module itself.',
      // Exception 3: LEFTOVERS.md (audit S2); the fixed files: checks 2, 4 and 5 above.
      "- When a module's import fails, its folder is read again when it is retried, so the record names the fixed files, and also any file of that folder that had already loaded and was edited in between, though the process keeps running the copy it loaded.",
      // The rebuild: check 7 above, rev 3.1's check 1 (a .env change rebuilds and keeps the hashes).
      'When `realm.yaml`, or a `dotenv` file named from its folder (the default `.env` included), changes, the process rebuilds its list of handlers at the next run but does not load the code again: `captured` is then the time of the rebuild, while every hash already taken stays as it was.',
      // The captured row: check 7 above.
      'When this process loaded the code, or last rebuilt its list of handlers because `realm.yaml` or a `dotenv` file named from its folder changed, and the ID of the process.',
    ];
    const line =
      "- The project code's hashes (each module's entry file, its folder's files and the signals) are now taken in the process that loads the code, before it loads it: a module's own file just before it first loads, the other files when a sweep of their folder first finds them, the signals once. A long-running server now records the files as it loaded them, not as they are later, with three exceptions listed under \"What a run records\" in the project-extensions reference; after a module's import fails, its folder is read again when it is retried (#828).";
    // (1) red when a sentence is changed or dropped from the page, or the CHANGELOG line (pinned by
    //     the same cells) is; (2) prints the missing sentences.
    expect({
      missing: sentences.filter((s) => !flat(page).includes(flat(s))),
      changelog: changelog.includes(line),
      oldParagraph: page.includes('Realm takes each hash once per process'),
    }).toEqual({ missing: [], changelog: true, oldParagraph: false });
  });
});
