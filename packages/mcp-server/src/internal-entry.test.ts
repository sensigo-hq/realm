// internal-entry.test.ts — CP-1 PR 3: `@sensigo/realm-mcp/internal` exports everything `@sensigo/realm-mcp`
// exports, from the same built files, so the two entries cannot drift and a class is one object
// whichever entry imports it. The cells import both BUILT entries by their package names (tests run
// after the build), so the `exports` map's new key is what resolves. The declared names come from
// the TypeScript checker over each entry's `.d.ts` (types included).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The names a built `.d.ts` exports, by the TypeScript checker (types and values), sorted. */
function declared(entry: 'index' | 'internal'): string[] {
  const file = join(PKG, 'dist', `${entry}.d.ts`);
  const program = ts.createProgram([file], { noEmit: true, skipLibCheck: true });
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(program.getSourceFile(file)!);
  return symbol === undefined
    ? []
    : [...new Set(checker.getExportsOfModule(symbol).map((s) => s.getName()))].sort();
}

/** The names one list has and the other has not. */
const onlyIn = (a: readonly string[], b: readonly string[]): string[] =>
  a.filter((n) => !b.includes(n));

describe('CP-1 PR 3 — `@sensigo/realm-mcp/internal`', () => {
  it('the same names: the two built modules export the same values, and the two .d.ts files the same names', async () => {
    // (1) red when an export line is in one entry and not the other (one moved back to index.ts);
    //     (2) prints only the names one entry has.
    const main = Object.keys(await import('@sensigo/realm-mcp')).sort();
    const internal = Object.keys(await import('@sensigo/realm-mcp/internal')).sort();
    const mainTypes = declared('index');
    const internalTypes = declared('internal');
    expect({
      values: { onlyMain: onlyIn(main, internal), onlyInternal: onlyIn(internal, main) },
      declared: {
        onlyMain: onlyIn(mainTypes, internalTypes),
        onlyInternal: onlyIn(internalTypes, mainTypes),
      },
      some: main.length > 0 && mainTypes.length > 0,
    }).toEqual({
      values: { onlyMain: [], onlyInternal: [] },
      declared: { onlyMain: [], onlyInternal: [] },
      some: true,
    });
  });

  it('the same objects: every exported value, classes included, is one object through either entry', async () => {
    // (1) red when the main entry exports its own object under a name the internal entry exports (a
    //     subclass shadowing the star's binding); (2) prints the names whose objects differ.
    const main = (await import('@sensigo/realm-mcp')) as Record<string, unknown>;
    const internal = (await import('@sensigo/realm-mcp/internal')) as Record<string, unknown>;
    expect(Object.keys(main).filter((k) => main[k] !== internal[k])).toEqual([]);
  });

  it('the package.json entry names its types first', () => {
    // (1) red when `import` comes before `types` in `exports["./internal"]` (Node and TypeScript
    //     read the first matching condition); (2) prints the key order.
    const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
      exports: Record<string, Record<string, string>>;
    };
    expect(pkg.exports['./internal']).toEqual({
      types: './dist/internal.d.ts',
      import: './dist/internal.js',
    });
    expect(Object.keys(pkg.exports['./internal']!)).toEqual(['types', 'import']);
  });
});
