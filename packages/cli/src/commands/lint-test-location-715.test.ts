// lint-test-location-715.test.ts — issue #715 (a) Part C.4 (D6-52): production code never creates a
// test clock or writes a clock file (the file store reads one, beside `runs/`). The rule names `createTestLocation` (from @sensigo/realm-testing) and
// `writeTestClockFile`, `fileClock`, `readTestClockFile` (from @sensigo/realm); tests and the testing
// package are allowed by an override block that re-states the zod/v3 restriction (a later block
// REPLACES an earlier one's list for the files it matches). Each snippet is linted in memory at a
// path the blocks match (no file is written). Each assertion names (a) the change that turns it red
// and (b) what it prints: the rule id and message only.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** The `no-restricted-imports` messages a snippet draws at `path` (repo-relative). */
async function hits(path: string, code: string): Promise<string[]> {
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfig: [
      { languageOptions: { parserOptions: { project: null, projectService: false } } },
    ],
  });
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, path) });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === 'no-restricted-imports')
    .map((m) => m.message);
}

const PROD = 'packages/cli/src/commands/zz-lint-probe.ts';
const TEST = 'packages/cli/src/commands/zz-lint-probe.test.ts';
const TESTING = 'packages/testing/src/clock/zz-lint-probe.ts';
const SOURCES = {
  createTestLocation:
    "import { createTestLocation } from '@sensigo/realm-testing';\nexport const f = createTestLocation;\n",
  writeTestClockFile:
    "import { writeTestClockFile } from '@sensigo/realm';\nexport const f = writeTestClockFile;\n",
  fileClock: "import { fileClock } from '@sensigo/realm';\nexport const f = fileClock;\n",
  readTestClockFile:
    "import { readTestClockFile } from '@sensigo/realm';\nexport const f = readTestClockFile;\n",
};
const ZOD = "import { z } from 'zod/v3';\nexport const s = z.string();\n";

describe('#715 (a) C.4 — the test-clock import rule and its file sets', () => {
  it('a production module importing a test-clock helper draws the rule; a test or the testing package does not', async () => {
    const at: Record<string, Record<string, number>> = {};
    for (const [name, code] of Object.entries(SOURCES)) {
      at[name] = {
        production: (await hits(PROD, code)).filter((m) => m.includes('#715, D6-52')).length,
        test: (await hits(TEST, code)).length,
        testing: (await hits(TESTING, code)).length,
      };
    }
    // (a) red when a member is absent from the rule, or the override's file sets are wrong;
    // (b) prints the hit counts per import and path.
    expect(at).toEqual({
      createTestLocation: { production: 1, test: 0, testing: 0 },
      writeTestClockFile: { production: 1, test: 0, testing: 0 },
      fileClock: { production: 1, test: 0, testing: 0 },
      readTestClockFile: { production: 1, test: 0, testing: 0 },
    });
  });

  it('zod/v3 is still refused everywhere: the entry was merged, and the override re-states it', async () => {
    // (a) red when the general block's merge or the override drops the zod restriction;
    // (b) prints the messages.
    const production = await hits(PROD, ZOD);
    const test = await hits(TEST, ZOD);
    const testing = await hits(TESTING, ZOD);
    expect(
      {
        production: production.filter((m) => m.includes('GHSA-mrhx-c7xc-m3w5')).length,
        test: test.filter((m) => m.includes('GHSA-mrhx-c7xc-m3w5')).length,
        testing: testing.filter((m) => m.includes('GHSA-mrhx-c7xc-m3w5')).length,
      },
      JSON.stringify({ production, test, testing }),
    ).toEqual({ production: 1, test: 1, testing: 1 });
  });
});

// =================================================================================================
// #715 (a) correction 1 (C-2): the PROPERTY, pinned by a source scan. ESLint's `no-restricted-imports`
// sees only static `import … from` declarations (by documented design), and this CLI's house style is
// `await import('@sensigo/realm')`: `const { fileClock } = await import('@sensigo/realm')` passes the
// rule above. So this scan reads every non-test source file of the four packages (`.ts` and `.mjs`)
// as TEXT and fails when a file outside the allowed set names a test-clock helper or the clock file's
// name, in any import form or as text. A non-literal specifier or a computed member
// (`m['file' + 'Clock']`) escapes a text scan, as it escapes every tool read for this (nice to have 8
// of the correction's list). It is the repo's own census pattern (#367's terminal-writer census;
// `docs-715a.test.ts`'s `takeReading` scan): one function lists the files, one scans any list, so the
// cells run it on the tree and on a seeded list. Prints file NAMES only, never their text.
// =================================================================================================

const PACKAGES = ['cli', 'core', 'mcp-server', 'testing'] as const;

/** The names core exports from `test-clock-file.ts`, `createTestLocation`, and the file's name. */
const NEEDLES = [
  'TEST_CLOCK_FILE_NAME',
  'testClockFilePath',
  'writeTestClockFile',
  'readTestClockFile',
  'fileClock',
  'createTestLocation',
  '.realm-test-clock',
] as const;

/** The files allowed to hold a needle, each with its reason. A file not named here may not. */
const ALLOWED: ReadonlyArray<readonly [string | RegExp, string]> = [
  ['packages/core/src/store/test-clock-file.ts', 'defines the clock file and its helpers'],
  [
    'packages/core/src/store/json-file-store.ts',
    'reads a clock file through `resolveStoreClock`; a comment names the file',
  ],
  ['packages/core/src/index.ts', 're-exports the helpers for the testing package'],
  [/^packages\/testing\/src\//, 'the testing package: it makes test locations'],
];

const isAllowed = (path: string): boolean =>
  ALLOWED.some(([p]) => (typeof p === 'string' ? p === path : p.test(path)));

/** Every non-test source file of the four packages: `.ts` (not `.test.ts`, `.d.ts`) and `.mjs`. */
function productionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'node_modules') walk(path);
      } else if ((/\.ts$/.test(name) && !/\.(test|d)\.ts$/.test(name)) || /\.mjs$/.test(name)) {
        out.push(relative(ROOT, path));
      }
    }
  };
  for (const pkg of PACKAGES) walk(join(ROOT, 'packages', pkg, 'src'));
  return out.sort();
}

/** The files of `files` outside the allowed set that hold a needle (names only). */
function violations(files: ReadonlyArray<{ path: string; text: string }>): string[] {
  return files
    .filter((f) => !isAllowed(f.path) && NEEDLES.some((n) => f.text.includes(n)))
    .map((f) => f.path);
}

describe('#715 (a) correction 1 (C-2) — no production file names a test-clock helper, in any form', () => {
  it('the scan of the tree finds none outside the allowed set', () => {
    // (a) red when a production file names a helper, e.g. `await import('@sensigo/realm')` then
    // `fileClock`; (b) prints the violating files' names.
    const found = violations(
      productionSources().map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') })),
    );
    expect(found, `production files naming a test-clock helper: ${found.join(', ')}`).toEqual([]);
  });

  it('the scan finds an awaited import, a `.then`, a re-export and the file’s name; a clean file and an allowed file pass', () => {
    // (a) red when the scan stops seeing a form (a needle dropped, the allowed set widened past the
    // testing package); (b) prints the names it found. The seed is a list: nothing is written.
    const seeded = [
      {
        path: 'packages/cli/src/commands/zz-seed-await.ts',
        text: "const { fileClock } = await import('@sensigo/realm');\n",
      },
      {
        path: 'packages/cli/src/commands/zz-seed-then.ts',
        text: "const c = import('@sensigo/realm').then((m) => m.readTestClockFile);\n",
      },
      {
        path: 'packages/mcp-server/src/zz-seed-reexport.ts',
        text: "export { writeTestClockFile } from '@sensigo/realm';\n",
      },
      {
        path: 'packages/core/src/zz-seed-name.mjs',
        text: "const p = join(root, '.realm-test-clock');\n",
      },
      {
        path: 'packages/cli/src/commands/zz-seed-clean.ts',
        text: "const { JsonFileStore } = await import('@sensigo/realm');\n",
      },
      {
        path: 'packages/testing/src/clock/zz-seed-allowed.ts',
        text: "import { fileClock } from '@sensigo/realm';\n",
      },
    ];
    const found = violations(seeded);
    expect(found, found.join(', ')).toEqual([
      'packages/cli/src/commands/zz-seed-await.ts',
      'packages/cli/src/commands/zz-seed-then.ts',
      'packages/mcp-server/src/zz-seed-reexport.ts',
      'packages/core/src/zz-seed-name.mjs',
    ]);
  });

  it('the file set: every package is read, `.mjs` files included, no test file', () => {
    // (a) red when the list drops a package or the `.mjs` files, or takes in a test file; (b) prints
    // the count per package and the `.mjs` names.
    const files = productionSources();
    const perPackage = Object.fromEntries(
      PACKAGES.map((p) => [p, files.filter((f) => f.startsWith(`packages/${p}/src/`)).length]),
    );
    const mjs = files.filter((f) => f.endsWith('.mjs'));
    expect(
      {
        everyPackage: PACKAGES.every((p) => (perPackage[p] ?? 0) > 0),
        tests: files.filter((f) => /\.test\.ts$/.test(f)).length,
        mjs:
          mjs.includes('packages/testing/src/clock/test-location-child.mjs') &&
          mjs.includes('packages/mcp-server/src/tools/async-schema-runtime-child.mjs'),
      },
      JSON.stringify({ perPackage, mjs }),
    ).toEqual({ everyPackage: true, tests: 0, mjs: true });
  });
});
