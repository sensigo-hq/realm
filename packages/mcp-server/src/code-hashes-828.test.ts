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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as codeHashes from './code-hashes.js';

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
