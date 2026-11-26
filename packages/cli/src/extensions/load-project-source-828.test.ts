// load-project-source-828.test.ts — #828 unit 2b (prompt feat-828-u2b-registry-source.md rev 2.1,
// check 6): the CLI loader states each entry's source at its two registration sites, the manifest's
// and a module's, with the hashes from the load's own map (the values the run's identity reads).
//
// Each cell asserts the whole source with `toEqual`. The last two drive the load's map through a seam:
// `beginCodeHashLoad` wrapped so its `entryHash` and `tree` answer what the cell sets.
//
// Every assertion carries (1) the change that turns it red and (2) what it prints when it fails.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { ExtensionIdentityModule, WorkflowDefinition } from '@sensigo/realm';
import { joinSweeps, sweepFolder } from '@sensigo/realm-mcp/code-hashes';
import { loadProjectExtensions, clearProjectExtensionsCache } from './load-project-extensions.js';

/**
 * What the wrapped load's `entryHash` and `tree` answer: the real map's; nothing from either
 * (`unavailable`); fixed values; or one of them failing alone (`no_entry_hash`, `tree_throws`).
 */
const seam = vi.hoisted(() => ({
  mode: 'real' as 'real' | 'unavailable' | 'fixed' | 'no_entry_hash' | 'tree_throws',
  entry: 'e'.repeat(64),
  tree: 'f'.repeat(64),
}));
vi.mock('@sensigo/realm-mcp/code-hashes', async (importOriginal) => {
  const real = await importOriginal<typeof import('@sensigo/realm-mcp/code-hashes')>();
  return {
    ...real,
    beginCodeHashLoad: (options: Parameters<typeof real.beginCodeHashLoad>[0]) => {
      const load = real.beginCodeHashLoad(options);
      if (seam.mode === 'real') return load;
      return {
        beforeImport: (entry: string) => load.beforeImport(entry),
        imported: (entry: string) => load.imported(entry),
        importFailed: (entry: string) => load.importFailed(entry),
        signals: () => load.signals(),
        lockfile: () => load.lockfile(),
        entryHash: (resolved: string) => {
          if (seam.mode === 'fixed') return seam.entry;
          return seam.mode === 'tree_throws' ? load.entryHash(resolved) : undefined;
        },
        tree: (roots: readonly string[]) => {
          if (seam.mode === 'unavailable' || seam.mode === 'tree_throws')
            throw new Error('no sweep of this root was taken');
          const real = load.tree(roots);
          return seam.mode === 'fixed' ? { ...real, tree_hash: seam.tree } : real;
        },
      };
    },
  };
});

let root: string;
let counter = 0;

beforeEach(() => {
  seam.mode = 'real';
  clearProjectExtensionsCache();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'realm-828-source-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '1.0.0' }));
  writeFileSync(join(root, 'realm.yaml'), 'version: 1\n');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** A unique name for a module file, so Node's import cache from another cell never serves it. */
const unique = (stem: string): string => `${stem}-${Date.now()}-${counter++}`;

/** Writes `source` to `<root>/<folder>/<name>` and returns its path. */
function write(folder: string, name: string, source: string): string {
  mkdirSync(join(root, folder), { recursive: true });
  const path = join(root, folder, name);
  writeFileSync(path, source);
  return path;
}

/** A module with a default export holding one handler. */
const moduleSource = (handler: string): string =>
  `export default { handlers: { ${handler}: { id: '${handler}', execute: async () => ({ data: {} }) } } };\n`;
/** A manifest `use:` module: a handler factory. */
const factorySource = (): string =>
  `export function factory({ id }) { return { id, execute: async () => ({ data: {} }) }; }\n`;

/** A definition anchored at the temp project, declaring `extensions` when given. */
function definition(extensions?: string[]): WorkflowDefinition {
  return {
    id: `wf-828-source-${counter++}`,
    name: 'Source WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { s1: { description: 'step', execution: 'agent' } },
    origin: 'human',
    source_dir: root,
    trust_root: root,
    ...(extensions !== undefined ? { extensions } : {}),
  };
}

/** The dir_tree_v1 hash of one folder alone, read now. */
const folderTree = (folder: string): string => joinSweeps([sweepFolder(folder)]).tree_hash;

/** The identity's module whose resolved path is `file`. */
function identityModule(
  modules: readonly ExtensionIdentityModule[] | undefined,
  file: string,
): ExtensionIdentityModule | undefined {
  return modules?.find((m) => m.resolved === realpathSync(file));
}

describe('#828 unit 2b check 6 — the loader states each entry’s source', () => {
  // (1) red when every entry gets one `via`, or `declared` loses its `#export`, or the hashes are not
  //     the identity's; (2) prints the source and the identity module it should match.
  it("a manifest module: via 'manifest', declared and entry_hash as the identity's", async () => {
    const file = write('m', `${unique('m')}.js`, factorySource());
    const use = `./m/${basename(file)}#factory`;
    writeFileSync(join(root, 'realm.yaml'), `version: 1\nhandlers:\n  hm:\n    use: ${use}\n`);
    const { registry } = await loadProjectExtensions(definition());
    const mod = identityModule(registry.identity?.modules, file);
    expect({ source: registry.entry('handler', 'hm')?.source, declared: mod?.declared }).toEqual({
      source: {
        source: 'project',
        declared: mod?.declared,
        via: 'manifest',
        entry_hash: mod?.entry_hash,
        folder_tree_hash: folderTree(dirname(file)),
      },
      declared: use,
    });
  });

  // (1) red when every entry gets one `via`, or the hashes are not the identity's; (2) prints the
  //     source and the identity module.
  it("an extensions-file module: via 'extensions_file'", async () => {
    const handler = `he_${counter}`;
    const file = write('e', `${unique('e')}.js`, moduleSource(handler));
    const { registry } = await loadProjectExtensions(definition([`./e/${basename(file)}`]));
    const mod = identityModule(registry.identity?.modules, file);
    expect(registry.entry('handler', handler)?.source).toEqual({
      source: 'project',
      declared: mod?.declared,
      via: 'extensions_file',
      entry_hash: mod?.entry_hash,
      folder_tree_hash: folderTree(dirname(file)),
    });
  });

  // (1) red when every entry gets one `via`; (2) prints the source and the identity module.
  it("the --extensions-module override: via 'override_flag'", async () => {
    const handler = `ho_${counter}`;
    const file = write('o', `${unique('o')}.js`, moduleSource(handler));
    const { registry } = await loadProjectExtensions(definition(), { overrideModule: file });
    const mod = identityModule(registry.identity?.modules, file);
    expect(registry.entry('handler', handler)?.source).toEqual({
      source: 'project',
      declared: mod?.declared,
      via: 'override_flag',
      entry_hash: mod?.entry_hash,
      folder_tree_hash: folderTree(dirname(file)),
    });
  });

  // (1) red when the catalog arm is removed (a catalog entry recorded as a project module); (2)
  //     prints the source.
  it('a catalog entry: exactly { source: catalog, use }', async () => {
    writeFileSync(
      join(root, 'realm.yaml'),
      'version: 1\nadapters:\n  files:\n    use: filesystem\n',
    );
    const { registry } = await loadProjectExtensions(definition());
    expect(registry.entry('adapter', 'files')?.source).toEqual({
      source: 'catalog',
      use: 'filesystem',
    });
  });

  // (1) red when the identity's tree joined over every module's folder is recorded; (2) prints each
  //     source's folder hash, its own folder's, and the joined one.
  it("two modules in two folders: each folder_tree_hash is its own folder's, not the identity's joined tree", async () => {
    const [ha, hb] = [`ha_${counter}`, `hb_${counter}`];
    const a = write('a', `${unique('a')}.js`, moduleSource(ha));
    const b = write('b', `${unique('b')}.js`, moduleSource(hb));
    const { registry } = await loadProjectExtensions(
      definition([`./a/${basename(a)}`, `./b/${basename(b)}`]),
    );
    const hashOf = (name: string): string | undefined => {
      const source = registry.entry('handler', name)?.source;
      return source?.source === 'project' && 'folder_tree_hash' in source
        ? source.folder_tree_hash
        : undefined;
    };
    const joined = registry.identity?.tree.tree_hash;
    expect({
      a: hashOf(ha),
      b: hashOf(hb),
      joinedDiffers: [hashOf(ha) !== joined, hashOf(hb) !== joined],
    }).toEqual({
      a: folderTree(dirname(a)),
      b: folderTree(dirname(b)),
      joinedDiffers: [true, true],
    });
  });

  // GROUNDING (correction 1, check 3): both conjuncts fail at once here, so it cannot tell them apart;
  // the two cells after check 6 pin each alone. Prints both sources.
  it("the load's entryHash gives nothing and its tree throws: absent 'hashes_unavailable'", async () => {
    seam.mode = 'unavailable';
    const handler = `hu_${counter}`;
    const file = write('u', `${unique('u')}.js`, moduleSource(handler));
    const factory = write('u', `${unique('uf')}.js`, factorySource());
    const use = `./u/${basename(factory)}#factory`;
    writeFileSync(join(root, 'realm.yaml'), `version: 1\nhandlers:\n  hum:\n    use: ${use}\n`);
    const { registry } = await loadProjectExtensions(definition([`./u/${basename(file)}`]));
    expect([
      registry.entry('handler', handler)?.source,
      registry.entry('handler', 'hum')?.source,
    ]).toEqual([
      {
        source: 'project',
        declared: `./u/${basename(file)}`,
        via: 'extensions_file',
        absent: 'hashes_unavailable',
      },
      { source: 'project', declared: use, via: 'manifest', absent: 'hashes_unavailable' },
    ]);
  });

  // (1) red when the source's hashes are read from the disk again rather than from the load's map;
  //     (2) prints both sources.
  it("the hashes come from the load's map: a module's and a manifest entry's carry exactly its values", async () => {
    seam.mode = 'fixed';
    const handler = `hf_${counter}`;
    const file = write('f', `${unique('f')}.js`, moduleSource(handler));
    const factory = write('f', `${unique('ff')}.js`, factorySource());
    writeFileSync(
      join(root, 'realm.yaml'),
      `version: 1\nhandlers:\n  hfm:\n    use: ./f/${basename(factory)}#factory\n`,
    );
    const { registry } = await loadProjectExtensions(definition([`./f/${basename(file)}`]));
    const hashes = (name: string) => {
      const source = registry.entry('handler', name)?.source;
      return source?.source === 'project' && 'entry_hash' in source
        ? [source.entry_hash, source.folder_tree_hash]
        : source;
    };
    expect([hashes(handler), hashes('hfm')]).toEqual([
      [seam.entry, seam.tree],
      [seam.entry, seam.tree],
    ]);
  });
});

/** A handler's `folder_tree_hash` in `registry`, or its whole source when it has none. */
function folderHashOf(
  registry: Awaited<ReturnType<typeof loadProjectExtensions>>['registry'],
  name: string,
): unknown {
  const source = registry.entry('handler', name)?.source;
  return source?.source === 'project' && 'folder_tree_hash' in source
    ? source.folder_tree_hash
    : source;
}

describe('#828 unit 2b correction 1 — each folder hash is taken after the load’s last import', () => {
  // (1) red when a module's folder hash is taken at its registration: the second load's first import
  //     of y sweeps the folder again, after x registered; (2) prints both hashes and the identity's.
  it("two loads in one process, y.js added to x's folder between them: x's and y's folder hash are the identity's tree", async () => {
    const [hx, hy] = [`hx_${counter}`, `hy_${counter}`];
    const x = write('d', `${unique('x')}.js`, moduleSource(hx));
    await loadProjectExtensions(definition([`./d/${basename(x)}`]));
    const y = write('d', `${unique('y')}.js`, moduleSource(hy));
    const { registry } = await loadProjectExtensions(
      definition([`./d/${basename(x)}`, `./d/${basename(y)}`]),
    );
    const now = folderTree(dirname(x));
    expect({
      x: folderHashOf(registry, hx),
      y: folderHashOf(registry, hy),
      identity: registry.identity?.tree.tree_hash,
    }).toEqual({ x: now, y: now, identity: now });
  });

  // (1) red when a module's folder hash is taken at its registration: w writes state.json while it is
  //     imported, and z's first import, in the same folder, sweeps it again; (2) prints the hashes.
  it('a module that writes a .json beside itself at import, then another in its folder: both are the identity’s tree', async () => {
    const [hw, hz] = [`hw_${counter}`, `hz_${counter}`];
    const w = write(
      'e',
      `${unique('w')}.js`,
      "import { writeFileSync } from 'node:fs';\n" +
        "writeFileSync(new URL('./state.json', import.meta.url), '{}');\n" +
        moduleSource(hw),
    );
    const z = write('e', `${unique('z')}.js`, moduleSource(hz));
    const { registry } = await loadProjectExtensions(
      definition([`./e/${basename(w)}`, `./e/${basename(z)}`]),
    );
    const now = folderTree(dirname(w));
    expect({
      w: folderHashOf(registry, hw),
      z: folderHashOf(registry, hz),
      identity: registry.identity?.tree.tree_hash,
      written: readdirSync(dirname(w)).includes('state.json'),
    }).toEqual({ w: now, z: now, identity: now, written: true });
  });
});

describe('#828 unit 2b correction 1 check 3 — "hashes unavailable", one cell per conjunct', () => {
  // (1) red when the entry-hash conjunct is dropped (the load then crashes: register refuses the
  //     undefined hash with VALIDATION_OPTION_INVALID); (2) prints the source or the load's error.
  it("only the load's entryHash gives nothing: absent 'hashes_unavailable'", async () => {
    seam.mode = 'no_entry_hash';
    const handler = `hn_${counter}`;
    const file = write('n', `${unique('n')}.js`, moduleSource(handler));
    const { registry } = await loadProjectExtensions(definition([`./n/${basename(file)}`]));
    expect(registry.entry('handler', handler)?.source).toEqual({
      source: 'project',
      declared: `./n/${basename(file)}`,
      via: 'extensions_file',
      absent: 'hashes_unavailable',
    });
  });

  // (1) red when the folder-hash conjunct is dropped (the load then crashes the same way); (2) prints
  //     the source or the load's error.
  it("only the load's tree throws: absent 'hashes_unavailable'", async () => {
    seam.mode = 'tree_throws';
    const handler = `ht_${counter}`;
    const file = write('t', `${unique('t')}.js`, moduleSource(handler));
    const { registry } = await loadProjectExtensions(definition([`./t/${basename(file)}`]));
    expect(registry.entry('handler', handler)?.source).toEqual({
      source: 'project',
      declared: `./t/${basename(file)}`,
      via: 'extensions_file',
      absent: 'hashes_unavailable',
    });
  });
});

/** The sha256 of a file's bytes. */
const sha256 = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

describe('#828 unit 2b correction 2 — each settled source reads its own module', () => {
  // (1) red when the settle pass finds an entry's module by its `declared` alone (c19311f6): the
  //     identity holds `./<x>.js` twice, the map keeps the manifest's, and the extensions-file handler
  //     takes that file's hashes; (2) prints both handlers' hashes beside each file's own.
  it("the workflow's ./x.js and the manifest's use: ./x.js are two files: each handler carries its own file's hashes", async () => {
    const name = `${unique('x')}.js`;
    const handler = `hc_${counter}`;
    const listed = write('wf', name, moduleSource(handler));
    const used = write(
      '.',
      name,
      'export default function factory({ id }) { return { id, execute: async () => ({ data: { m: 1 } }) }; }\n',
    );
    writeFileSync(join(root, 'realm.yaml'), `version: 1\nhandlers:\n  hcm:\n    use: ./${name}\n`);
    const { registry } = await loadProjectExtensions({
      ...definition([`./${name}`]),
      source_dir: join(root, 'wf'),
    });
    const modules = registry.identity?.modules;
    const hashesOf = (entry: string): unknown => {
      const source = registry.entry('handler', entry)?.source;
      return source?.source === 'project' && 'entry_hash' in source
        ? { entry: source.entry_hash, folder: source.folder_tree_hash }
        : source;
    };
    expect({
      listed: hashesOf(handler),
      used: hashesOf('hcm'),
      identity: [identityModule(modules, listed), identityModule(modules, used)].map((m) => [
        m?.declared,
        m?.entry_hash,
      ]),
    }).toEqual({
      listed: { entry: sha256(listed), folder: folderTree(dirname(listed)) },
      used: { entry: sha256(used), folder: folderTree(dirname(used)) },
      identity: [
        [`./${name}`, sha256(listed)],
        [`./${name}`, sha256(used)],
      ],
    });
  });
});
