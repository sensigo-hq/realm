// lint-test-location-715.test.ts — issue #715 (a) Part C.4 (D6-52): production code never creates or
// reads a test clock. The rule names `createTestLocation` (from @sensigo/realm-testing) and
// `writeTestClockFile`, `fileClock`, `readTestClockFile` (from @sensigo/realm); tests and the testing
// package are allowed by an override block that re-states the zod/v3 restriction (a later block
// REPLACES an earlier one's list for the files it matches). Each snippet is linted in memory at a
// path the blocks match (no file is written). Each assertion names (a) the change that turns it red
// and (b) what it prints: the rule id and message only.
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
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
