// code-hashes-828.test.ts — #828 unit 1 (PR A): the project code's hashes are taken once per process,
// just before Realm first loads that code, and kept only if the load succeeds (prompt
// feat-828-u1-fingerprint-before-load.md, checks 1–5, 7 and 13).
//
// Every loader cell uses a temp project WITH a `realm.yaml` (without a manifest a `.env` change does
// not rebuild), loads once, changes files, then loads again in the same process, and first asserts
// that the second load rebuilt (a new registry object). Each module file has a unique name, so Node's
// import cache from another cell never serves it.
//
// Every assertion carries (1) the change that turns it red and (2) what it prints when it fails.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  manifestSecretsBlockHash,
  parseDeploymentManifest,
} from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import {
  hashFile,
  joinSweeps,
  sha256Hex,
  sweepFolder,
  type FileHash,
} from '@sensigo/realm-mcp/code-hashes';
import { loadProjectExtensions, clearProjectExtensionsCache } from './load-project-extensions.js';
import { computeExtensionIdentity } from './extension-identity.js';

let root: string;
let counter = 0;

beforeEach(() => {
  clearProjectExtensionsCache();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'realm-828-hashes-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '1.0.0' }));
  writeFileSync(join(root, 'realm.yaml'), 'version: 1\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A unique name for a module or helper file. */
const unique = (stem: string): string => `${stem}-${Date.now()}-${counter++}`;

/** A workflow-declared module (`extensions:`): a default export with one handler. */
function moduleSource(handler: string, extra = ''): string {
  return `${extra}\nexport default { handlers: { ${handler}: { id: '${handler}', execute: async () => ({ data: {} }) } } };\n`;
}

/** A manifest `use:` module: a handler factory. */
function factorySource(extra = ''): string {
  return `${extra}\nexport function factory({ id }) { return { id, execute: async () => ({ data: {} }) }; }\n`;
}

/** Writes `source` to `<root>/<folder>/<name>` and returns its path. */
function write(folder: string, name: string, source: string): string {
  mkdirSync(join(root, folder), { recursive: true });
  const path = join(root, folder, name);
  writeFileSync(path, source);
  return path;
}

/** A definition anchored at the temp project, declaring `extensions` relative to it. */
function definition(extensions: string[]): WorkflowDefinition {
  return {
    id: `wf-828-${counter++}`,
    name: 'Hashes WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { s1: { description: 'step', execution: 'agent' } },
    origin: 'human',
    source_dir: root,
    trust_root: root,
    extensions,
  };
}

const sha = (text: string): string => sha256Hex(text);

describe('#828 unit 1 — the hashes are taken once, before the code first loads (checks 1–5)', () => {
  it('check 1: the entry file and .env changed — the rebuilt identity keeps the FIRST bytes’ entry hash', async () => {
    const name = unique('a');
    const first = moduleSource(`h_${counter}`);
    write('ext', `${name}.js`, first);
    const def = definition([`./ext/${name}.js`]);
    const one = await loadProjectExtensions(def);
    writeFileSync(join(root, 'ext', `${name}.js`), `${first}// edited after the load\n`);
    writeFileSync(join(root, '.env'), 'ROTATED=1\n');
    const two = await loadProjectExtensions(def);
    // (1) red when the rebuild re-reads the entry file (the edited bytes' hash); (2) prints whether
    //     it rebuilt and both hashes.
    expect({
      rebuilt: two.registry !== one.registry,
      entry_hash: two.registry.identity?.modules[0]?.entry_hash,
    }).toEqual({ rebuilt: true, entry_hash: sha(first) });
  });

  it('check 2: a helper in the module’s folder changed — the rebuilt tree is the first load’s', async () => {
    const name = unique('a');
    write('ext', `${name}.js`, moduleSource(`h_${counter}`));
    const helper = write('ext', `${unique('helper')}.js`, 'export const x = 1;\n');
    const def = definition([`./ext/${name}.js`]);
    const one = await loadProjectExtensions(def);
    writeFileSync(helper, 'export const x = 2;\n');
    writeFileSync(join(root, '.env'), 'ROTATED=1\n');
    const two = await loadProjectExtensions(def);
    // (1) red when the folder's files are hashed again on the rebuild; (2) prints both tree hashes.
    expect({
      rebuilt: two.registry !== one.registry,
      tree_hash: two.registry.identity?.tree.tree_hash,
    }).toEqual({ rebuilt: true, tree_hash: one.registry.identity?.tree.tree_hash });
  });

  it('check 3(a): the root set changed — a helper in folder A changed and a module in a new folder B added: the tree is both folders as they were before the helper changed', async () => {
    const aName = unique('a');
    const aPath = write('a', `${aName}.js`, moduleSource(`h_${counter}`));
    const helper = write('a', `${unique('helper')}.js`, 'export const x = 1;\n');
    const bPath = write('b', `${unique('b')}.js`, factorySource());
    const before = computeExtensionIdentity([
      { declared: 'a', resolved: aPath, format: 'esm' },
      { declared: 'b', resolved: bPath, format: 'esm' },
    ]);
    const def = definition([`./a/${aName}.js`]);
    const one = await loadProjectExtensions(def);
    writeFileSync(helper, 'export const x = 2;\n');
    writeFileSync(
      join(root, 'realm.yaml'),
      `version: 1\nhandlers:\n  hb:\n    use: ./b/${bPath.split('/').pop()!}#factory\n`,
    );
    const two = await loadProjectExtensions(def);
    // (1) red when folder A is hashed again (the helper's new bytes); (2) prints the roots and both
    //     tree hashes.
    expect({
      rebuilt: two.registry !== one.registry,
      roots: two.registry.identity?.tree.roots,
      tree_hash: two.registry.identity?.tree.tree_hash,
    }).toEqual({
      rebuilt: true,
      roots: [join(root, 'a'), join(root, 'b')],
      tree_hash: before.tree.tree_hash,
    });
  });

  it('check 3(b): a module added in the SAME folder A, importing a helper created after the first load: the tree holds the old module’s first bytes and the new files’ bytes', async () => {
    const aName = unique('a');
    const firstA = moduleSource(`h_${counter}`);
    const aPath = write('a', `${aName}.js`, firstA);
    const firstAHash = hashFile(aPath)!;
    const def = definition([`./a/${aName}.js`]);
    const one = await loadProjectExtensions(def);
    // After the first load: the old module is edited (the process still runs its first bytes), a
    // helper is created, and a new module in the same folder imports it.
    writeFileSync(aPath, `${firstA}// edited after the load\n`);
    const helperName = `${unique('helper')}.js`;
    write('a', helperName, 'export const y = 1;\n');
    const cName = `${unique('c')}.js`;
    write('a', cName, factorySource(`import { y } from './${helperName}'; void y;`));
    writeFileSync(
      join(root, 'realm.yaml'),
      `version: 1\nhandlers:\n  hc:\n    use: ./a/${cName}#factory\n`,
    );
    const two = await loadProjectExtensions(def);
    // The folder as this process loaded it: the old module's first hash, every other file now.
    const expected = joinSweeps([
      sweepFolder(join(root, 'a'), (path): FileHash | undefined =>
        path === aPath ? firstAHash : hashFile(path),
      ),
    ]);
    // (1) red when a folder's listing is kept instead of its files' hashes (the new module and
    //     helper missing), or the folder is hashed again (the old module's edited bytes); (2) prints
    //     both tree hashes and file counts.
    expect({
      rebuilt: two.registry !== one.registry,
      file_count: two.registry.identity?.tree.file_count,
      tree_hash: two.registry.identity?.tree.tree_hash,
    }).toEqual({ rebuilt: true, file_count: 3, tree_hash: expected.tree_hash });
  });

  it('check 4: the signals are taken once — .git/HEAD’s ref and realm.yaml changed, the rebuilt signals are the first load’s', async () => {
    mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), 'a'.repeat(40) + '\n');
    const name = unique('a');
    write('ext', `${name}.js`, moduleSource(`h_${counter}`));
    const def = definition([`./ext/${name}.js`]);
    const one = await loadProjectExtensions(def);
    writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), 'b'.repeat(40) + '\n');
    writeFileSync(join(root, 'realm.yaml'), 'version: 1\n# edited\n');
    const two = await loadProjectExtensions(def);
    // (1) red when the signals are read again on the rebuild (the new ref); (2) prints both.
    expect({
      rebuilt: two.registry !== one.registry,
      signals: two.registry.identity?.signals,
    }).toEqual({
      rebuilt: true,
      signals: { package_version: '1.0.0', git_head: 'a'.repeat(40) },
    });
  });

  it('check 5: the manifest is new each load — the rebuild’s manifest content hash and secrets block hash are the new bytes’', async () => {
    const name = unique('a');
    write('ext', `${name}.js`, moduleSource(`h_${counter}`));
    writeFileSync(join(root, '.env'), 'TOKEN_A=1\nTOKEN_B=2\n');
    const firstYaml = 'version: 1\nsecrets:\n  sources: [dotenv]\n';
    writeFileSync(join(root, 'realm.yaml'), firstYaml);
    const def = definition([`./ext/${name}.js`]);
    const one = await loadProjectExtensions(def);
    const secondYaml = 'version: 1\nsecrets:\n  sources: [dotenv, env]\n';
    writeFileSync(join(root, 'realm.yaml'), secondYaml);
    const two = await loadProjectExtensions(def);
    const parsed = parseDeploymentManifest(secondYaml);
    if ('error' in parsed) throw new Error('the second manifest does not parse');
    const manifest = two.registry.identity?.manifest;
    // (1) red when the rebuild reuses the whole previous identity (the first bytes' hashes);
    //     (2) prints both manifest records.
    expect({
      rebuilt: two.registry !== one.registry,
      content_hash: manifest?.content_hash,
      secrets_block_hash: manifest?.secrets_block_hash,
      changed: manifest?.secrets_block_hash !== one.registry.identity?.manifest?.secrets_block_hash,
    }).toEqual({
      rebuilt: true,
      content_hash: sha(secondYaml),
      secrets_block_hash: manifestSecretsBlockHash(parsed.document),
      changed: true,
    });
  });
});

describe('#828 unit 1 — the joined caps (check 7)', () => {
  it('check 7(a): two fresh sweeps joined, 1,999 files and 5 — 2,000 lines, truncated; a file that sorts last in the second folder changes nothing', () => {
    const first = join(root, 'one');
    const second = join(root, 'two');
    mkdirSync(first);
    mkdirSync(second);
    for (let i = 0; i < 1999; i++)
      writeFileSync(join(first, `f${String(i).padStart(4, '0')}.js`), `${i}`);
    for (let i = 0; i < 5; i++) writeFileSync(join(second, `g${i}.js`), `${i}`);
    const joined = joinSweeps([sweepFolder(first), sweepFolder(second)]);
    writeFileSync(join(second, 'zzz-last.js'), 'late');
    const again = joinSweeps([sweepFolder(first), sweepFolder(second)]);
    // (1) red when the folders' lines are joined without the caps applied again (2,004 lines);
    //     (2) prints both joins.
    expect({
      file_count: joined.file_count,
      truncated: joined.truncated,
      unchanged: again.tree_hash === joined.tree_hash,
    }).toEqual({ file_count: 2000, truncated: true, unchanged: true });
  });

  it('check 7(b): through the loader, one folder of 2,001 files — truncated', async () => {
    const name = unique('a');
    write('big', `${name}.js`, moduleSource(`h_${counter}`));
    for (let i = 0; i < 2000; i++)
      writeFileSync(join(root, 'big', `f${String(i).padStart(4, '0')}.js`), `${i}`);
    const loaded = await loadProjectExtensions(definition([`./big/${name}.js`]));
    // (1) red when a folder's own cap mark is dropped (the last folder's sweep stopped at the cap,
    //     and nothing follows it in the join); (2) prints the tree.
    expect({
      file_count: loaded.registry.identity?.tree.file_count,
      truncated: loaded.registry.identity?.tree.truncated,
    }).toEqual({ file_count: 2000, truncated: true });
  });
});

describe('#828 unit 1 — a failed import, then fixed (check 13)', () => {
  it('check 13(a): the first load fails on a syntax error in the entry file; fixed, the second load records the fixed bytes', async () => {
    const name = unique('a');
    const path = write('ext', `${name}.js`, 'export default {{ broken');
    const def = definition([`./ext/${name}.js`]);
    const failed = await loadProjectExtensions(def).then(
      () => 'loaded',
      () => 'failed',
    );
    const fixed = moduleSource(`h_${counter}`);
    writeFileSync(path, fixed);
    const two = await loadProjectExtensions(def);
    // (1) red when a value taken for the failed load is kept (the broken bytes' hash); (2) prints the
    //     first outcome and the entry hash.
    expect({ failed, entry_hash: two.registry.identity?.modules[0]?.entry_hash }).toEqual({
      failed: 'failed',
      entry_hash: sha(fixed),
    });
  });

  it('check 13(b): modules a and b in one folder, b broken — the load fails; b fixed, the second load records b’s fixed bytes and a’s first', async () => {
    const aName = unique('a');
    const firstA = moduleSource(`ha_${counter}`);
    const aPath = write('ext', `${aName}.js`, firstA);
    const bName = unique('b');
    const bPath = write('ext', `${bName}.js`, 'export default {{ broken');
    const def = definition([`./ext/${aName}.js`, `./ext/${bName}.js`]);
    const failed = await loadProjectExtensions(def).then(
      () => 'loaded',
      () => 'failed',
    );
    // a was imported (Node runs its first bytes); then it is edited, and b is fixed.
    writeFileSync(aPath, `${firstA}// edited after the failed load\n`);
    const fixedB = moduleSource(`hb_${counter}`);
    writeFileSync(bPath, fixedB);
    const two = await loadProjectExtensions(def);
    const hashes = Object.fromEntries(
      (two.registry.identity?.modules ?? []).map((m) => [m.resolved, m.entry_hash]),
    );
    // (1) red when a value is kept because an earlier import of the same load succeeded (b's broken
    //     hash), or a's kept entry hash is not reused (a's edited bytes); (2) prints both hashes.
    expect({ failed, a: hashes[aPath], b: hashes[bPath] }).toEqual({
      failed: 'failed',
      a: sha(firstA),
      b: sha(fixedB),
    });
  });
});
