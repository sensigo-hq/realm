// code-hashes-828.test.ts — #828 unit 1 (PR A): the `@sensigo/realm-mcp/code-hashes` subpath's shape,
// as MA 2's review asks.
//  1. Nothing outside the module can build a load except through `beginCodeHashLoad()`: no class
//     leaves the module (`check:brands` requires a release mark on every exported class, and the
//     module may not import the mark), so the load's constructor is not exported.
//  2. The subpath stays internal: no name in it carries a release tag, it has no section in the
//     package's API report, the report's test does not walk it, and its `exports` entry lists
//     `types` first.
// (The import graph, check 8, is pinned in the CLI's read-only-no-extensions.test.ts.)
//
// Every assertion carries (1) the change that turns it red and (2) what it prints when it fails.
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as codeHashes from './code-hashes.js';
import { projectSourceOf } from './project-source.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const isClass = (value: unknown): boolean =>
  typeof value === 'function' && /^class\b/.test(Function.prototype.toString.call(value));

describe('#828 unit 1 — the code-hashes subpath', () => {
  it('no class leaves the module: a load is built only by beginCodeHashLoad(), whose constructor is not exported', () => {
    const exported = Object.entries(codeHashes as Record<string, unknown>);
    const load = codeHashes.beginCodeHashLoad({ readSignals: () => undefined });
    const constructor = (Object.getPrototypeOf(load) as { constructor: unknown }).constructor;
    // (1) red when the module exports a class (the load's, or any other), or its exported names
    //     change; (2) prints the classes, which exported name is the load's constructor, and the names.
    expect({
      classes: exported.filter(([, value]) => isClass(value)).map(([name]) => name),
      constructorExportedAs: exported.filter(([, value]) => value === constructor).map(([n]) => n),
      names: exported.map(([name]) => name).sort(),
    }).toEqual({
      classes: [],
      constructorExportedAs: [],
      names: [
        'DIR_TREE_V1_RULES',
        'beginCodeHashLoad',
        'clearCodeHashes',
        'hashFile',
        'joinSweeps',
        // #828 PR B: the lockfile read from the disk now, for the pure identity and the recompute.
        'lockfileNow',
        'sha256Hex',
        // #828 unit 2b: projectSourceOf's work, kept here with the map (the tagged wrapper is elsewhere).
        'statedProjectSource',
        'sweepFolder',
        'sweepTree',
      ],
    });
  });

  it('the subpath stays internal: no release tag, no section in the API report, not walked by its test, `types` first', () => {
    const source = readFileSync(join(HERE, 'code-hashes.ts'), 'utf8');
    const report = readFileSync(join(HERE, 'inventory', 'api-report.txt'), 'utf8');
    const reportTest = readFileSync(
      join(HERE, '..', '..', 'core', 'src', 'inventory', 'api-report.test.ts'),
      'utf8',
    );
    const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')) as {
      exports: Record<string, Record<string, string>>;
    };
    const names = Object.keys(codeHashes);
    // (1) red when a name in the module is tagged (`@public`, `@beta`, `@alpha`, `@internal`), the
    //     report gains the subpath or one of its names, the report's test walks it, or the entry
    //     lists `import` first; (2) prints each finding.
    expect({
      tags: source.match(/@(public|beta|alpha|internal)\b/g) ?? [],
      reportSection: report.includes('## @sensigo/realm-mcp/code-hashes'),
      namesInReport: names.filter((name) => new RegExp(`\\b${name}\\b`).test(report)),
      walkedByTheReportTest: reportTest.includes('code-hashes'),
      entry: pkg.exports['./code-hashes'],
      entryOrder: Object.keys(pkg.exports['./code-hashes'] ?? {}),
    }).toEqual({
      tags: [],
      reportSection: false,
      namesInReport: [],
      walkedByTheReportTest: false,
      entry: { types: './dist/code-hashes.d.ts', import: './dist/code-hashes.js' },
      entryOrder: ['types', 'import'],
    });
  });
});

// #828 unit 2b (prompt feat-828-u2b-registry-source.md rev 2.1, check 7): `projectSourceOf`, a host's
// stated source for a module it loads itself.
describe('#828 unit 2b check 7 — projectSourceOf', () => {
  let root: string;
  /** Root is the account that file modes do not bind, so no file is unreadable to it. */
  const NOT_BOUND_BY_MODES = process.getuid?.() === 0;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'realm-828-project-source-')));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  /** Writes a module and a helper beside it in `<root>/<folder>` and returns the module's path. */
  const moduleIn = (folder: string, text = 'export const x = 1;\n'): string => {
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, 'helper.js'), 'export const y = 2;\n');
    const path = join(root, folder, 'module.js');
    writeFileSync(path, text);
    return path;
  };
  /** What a module's source should hold, read from the disk now. */
  const expected = (path: string) => ({
    source: 'project',
    declared: path,
    via: 'host_stated',
    entry_hash: codeHashes.sha256Hex(readFileSync(path)),
    folder_tree_hash: codeHashes.joinSweeps([codeHashes.sweepFolder(dirname(path))]).tree_hash,
  });
  /** A refused call's code and words. */
  const refusedBy = (module: string | URL): { code: unknown; message: string } | 'no throw' => {
    try {
      projectSourceOf(module);
      return 'no throw';
    } catch (err) {
      return { code: (err as { code?: unknown }).code, message: (err as Error).message };
    }
  };

  // (1) red when a `file:` string is read as a path, or a URL is not converted; (2) prints the three
  //     results.
  it('a path, a URL and a file: string give one result', () => {
    const path = moduleIn('one');
    const url = pathToFileURL(path);
    expect([projectSourceOf(path), projectSourceOf(url), projectSourceOf(url.href)]).toEqual([
      expected(path),
      expected(path),
      expected(path),
    ]);
  });

  // (1) red when the path is not resolved to the real file first (the link's path and its folder's
  //     tree); (2) prints the source.
  it("a symlinked file gives the real path and its real folder's tree", () => {
    const real = moduleIn('real');
    mkdirSync(join(root, 'links'));
    const link = join(root, 'links', 'module.js');
    symlinkSync(real, link);
    expect(projectSourceOf(link)).toEqual(expected(real));
  });

  // (1) red when it is not memoised; (2) prints both results.
  it('two calls with the file changed in between return the first hash', () => {
    const path = moduleIn('twice');
    const first = projectSourceOf(path);
    writeFileSync(path, 'export const x = 2;\n');
    expect({ first, second: projectSourceOf(path) }).toEqual({ first, second: first });
  });

  // (1) red when a case throws an untyped error, or its words do not name the path and the case; (2)
  //     prints each case's code and words.
  it('a missing file, a folder and a non-file: URL each throw RESOURCE_FETCH_FAILED naming the path', () => {
    const missing = join(root, 'none.js');
    mkdirSync(join(root, 'folder'));
    const folder = join(root, 'folder');
    const web = 'https://example.com/module.js';
    const code = 'RESOURCE_FETCH_FAILED';
    expect([
      refusedBy(missing),
      refusedBy(folder),
      refusedBy(web),
      refusedBy(new URL(web)),
    ]).toEqual([
      { code, message: `projectSourceOf: ${missing} is missing.` },
      { code, message: `projectSourceOf: ${folder} is a folder.` },
      { code, message: `projectSourceOf: ${web} is not a file: URL.` },
      { code, message: `projectSourceOf: ${web} is not a file: URL.` },
    ]);
  });

  // (1) red when an unreadable file is hashed as something, or throws untyped; (2) prints the code and
  //     the words.
  it.skipIf(NOT_BOUND_BY_MODES)(
    'an unreadable file throws RESOURCE_FETCH_FAILED: cannot be read',
    () => {
      const path = moduleIn('locked');
      chmodSync(path, 0o000);
      try {
        expect(refusedBy(path)).toEqual({
          code: 'RESOURCE_FETCH_FAILED',
          message: `projectSourceOf: ${path} cannot be read.`,
        });
      } finally {
        chmodSync(path, 0o644);
      }
    },
  );
});
