// test-support-export-616.test.ts — issue #616 PR-2c c9a (DELTAS row 49): the package's second entry,
// `@sensigo/realm-store-sqlite/test-support`, for tests in other workspace packages that need a second,
// raw connection on a home's `realm.db` (the one-loader law refuses any other file that loads the
// built-in, so such a test has no other lawful way to open one). The real cases: a CLI test imports
// the helper by the package's name; a later unit adds a third export to the entry, or a wildcard
// subpath that makes the rest of the package's test support reachable; the README's section changes
// without its cell. The tarball's test-support contents are pinned once, by the CLI's pack cell
// (`packages/cli/src/store-sqlite-package-616.test.ts`, unit 1); a CLI test that uses the helper is
// `packages/cli/src/commands/store-test-support-616.test.ts`.
//
// The entry is imported by the package's own specifier, never by a relative path, so these cells see
// what a consumer sees: Node's resolver over the `exports` map (`import.meta.resolve` under vitest is
// Node's; a literal import of an unexported path fails the whole file at vite's transform instead).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The package README, its whitespace folded, and whether it carries a sentence. */
const README = readFileSync(join(PACKAGE_ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
const says = (sentence: string): boolean => README.includes(sentence);

/** The README's sentence for the entry, with the cell below that pins what it says. */
const SENTENCES = {
  testSupport:
    "`@sensigo/realm-store-sqlite/test-support` exports two functions, `openForeignConnection(home)` — a second, raw connection on a home's `realm.db`, opened through the package's one loader, for tests that need a hostile writer or reader beside the store (a held lock, a foreign write, a raised schema version) — and `plantRegistryRow(home, { id, text })` — a registered copy written as raw text under its hash, the version guard dropped and put back around the write, so a test can give the store a copy it must refuse. Both are test support, not a production API, and may change with any release.",
} as const;

/** Where a specifier resolves, as a path in the package, or the error code that refused it. */
function resolution(specifier: string): string {
  try {
    const url = import.meta.resolve(specifier);
    return url.startsWith('file:')
      ? `resolves to ${relative(PACKAGE_ROOT, fileURLToPath(url)).split(sep).join('/')}`
      : `resolves to ${url}`;
  } catch (err) {
    return `refused ${String((err as { code?: unknown }).code)}`;
  }
}

describe('#616 PR-2c c9a — the ./test-support entry', () => {
  it('check A: the entry resolves to the built module and exports exactly openForeignConnection and plantRegistryRow; a deep path into the test support is refused by the exports map; the README says what the entry is', async () => {
    const entry = resolution('@sensigo/realm-store-sqlite/test-support');
    const deep = resolution('@sensigo/realm-store-sqlite/test-support/schema-versions.js');
    const keys = Object.keys(await import('@sensigo/realm-store-sqlite/test-support'));
    // (1) red when the entry exports a third name or loses one (a type has no runtime key; Constraints keep types
    //     out too), when a wildcard subpath (`./test-support/*`) makes the rest of the test support
    //     reachable, when the entry's target moves off the built module, and when the README's
    //     sentence changes or goes; (2) prints where each specifier resolved or the code that refused
    //     it, the module's export names, and whether the README carries the sentence.
    expect({ entry, keys, deep, says: says(SENTENCES.testSupport) }).toEqual({
      entry: 'resolves to dist/test-support/index.js',
      keys: ['openForeignConnection', 'plantRegistryRow'],
      deep: 'refused ERR_PACKAGE_PATH_NOT_EXPORTED',
      says: true,
    });
  });

  it("check D: package.json's exports are exactly the package entry and ./test-support, and ./test-support's import and types targets are the built module and its declaration", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    // (1) red when a third subpath appears in `exports`, or `./test-support` gains a condition or its
    //     `import` or `types` target moves; (2) prints the exports' keys and the entry as written.
    expect({
      keys: Object.keys(pkg.exports),
      testSupport: pkg.exports['./test-support'],
    }).toEqual({
      keys: ['.', './test-support'],
      testSupport: {
        import: './dist/test-support/index.js',
        types: './dist/test-support/index.d.ts',
      },
    });
  });
});
