// lint-clock-715b.test.ts — issue #715 (b) 04 §B.1–B.2 (D5 §5.3): the clock rule
// (`realm/no-clock-read`, `eslint.config.ts`). Outside the census's `outside` sites a production file
// may not read the host's clock (`new Date()`, `Date()`, `Date.now()` called or taken by name), nor
// take one as a parameter default. Its own rule id, so the later `no-restricted-syntax` blocks — which
// REPLACE each other's lists — cannot drop it; the file-set cell lints a probe in each of those
// blocks' sets. Each snippet is linted in memory at a path (no file is written).
//
// Each cell carries (a) the change that turns it red and (b) what it prints on failure (rule ids and
// message ids only).
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { outsideSites } from '../test-support/clock-census.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const RULE = 'realm/no-clock-read';

function eslint(): ESLint {
  return new ESLint({
    cwd: ROOT,
    overrideConfig: [
      { languageOptions: { parserOptions: { project: null, projectService: false } } },
    ],
  });
}

/** The clock rule's message ids a snippet draws at `path` (repo-relative). */
async function hits(path: string, code: string): Promise<string[]> {
  const [result] = await eslint().lintText(code, { filePath: join(ROOT, path) });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === RULE)
    .map((m) => m.messageId ?? m.message);
}

const PROD = 'packages/core/src/engine/zz-clock-probe.ts';

describe('#715 (b) 04 §B — the clock rule', () => {
  it('a raw read, a read taken by name, and a clock-reading default each draw the rule; an instant built from a value does not', async () => {
    // (a) red when one selector is missing from the rule (the read passes) or a default reads as a
    //     plain read; (b) prints the message ids per snippet.
    const found: Record<string, string[]> = {};
    for (const [name, code] of Object.entries({
      newDate: 'export const t = new Date();\n',
      dateCall: 'export const t = Date();\n',
      dateNow: 'export const t = Date.now();\n',
      byName: 'export const now = Date.now;\n',
      paramDefault: 'export function f(now: Date = new Date()): Date {\n  return now;\n}\n',
      nullishDefault: 'export function f(now?: Date): Date {\n  return now ?? new Date();\n}\n',
      fromValue: "export const t = new Date(0);\nexport const u = new Date('2030-01-01');\n",
    })) {
      found[name] = await hits(PROD, code);
    }
    expect(found).toEqual({
      newDate: ['read'],
      dateCall: ['read'],
      dateNow: ['read'],
      byName: ['read'],
      paramDefault: ['dflt'],
      nullishDefault: ['dflt'],
      fromValue: [],
    });
  });

  it('a census `outside` site may read the host’s clock — the same read in another function of that file may not; a test file is not linted', async () => {
    // (a) red when the allow-list matches by file alone, or tests are linted; (b) prints the hits.
    const code = (fn: string) =>
      `export function ${fn}(): string {\n  return new Date().toISOString();\n}\n`;
    expect({
      allowed: await hits('packages/cli/src/agent/run-agent.ts', code('sidecarStamp')),
      sameFile: await hits('packages/cli/src/agent/run-agent.ts', code('somethingElse')),
      test: await hits('packages/core/src/engine/zz-clock-probe.test.ts', code('f')),
    }).toEqual({ allowed: [], sameFile: ['read'], test: [] });
  });

  it('the rule fires in every block’s file set (a later no-restricted-syntax block cannot drop it)', async () => {
    // (a) red when a later block's file set loses the clock rule; (b) prints the paths it missed.
    const paths = [
      'packages/core/src/engine/zz-clock-probe.ts',
      'packages/testing/src/zz-clock-probe.ts',
      'packages/cli/src/agent/zz-clock-probe.ts',
      'packages/cli/src/commands/listen.ts',
      'packages/cli/src/lib/holder-render.ts',
      'packages/mcp-server/src/zz-clock-probe.ts',
      'packages/mcp-server/src/tools/zz-clock-probe.ts',
      'packages/mcp-server/src/server.ts',
      'packages/mcp-server/src/render-reply.ts',
    ];
    const missed: string[] = [];
    for (const p of paths) {
      if ((await hits(p, 'export const zzProbe = Date.now();\n')).length !== 1) missed.push(p);
    }
    expect(missed).toEqual([]);
  });

  it('the rule’s allowed sites are exactly the census’s `outside` rows (the two lists mirror)', async () => {
    // (a) red when a site is added to one list and not the other; (b) prints the differences.
    const config = (await eslint().calculateConfigForFile(join(ROOT, PROD))) as {
      rules?: Record<string, [unknown, { allow?: string[] }?]>;
    };
    const allow = [...(config.rules?.[RULE]?.[1]?.allow ?? [])].sort();
    const census = outsideSites();
    expect({
      onlyInTheRule: allow.filter((s) => !census.includes(s)),
      onlyInTheCensus: census.filter((s) => !allow.includes(s)),
    }).toEqual({ onlyInTheRule: [], onlyInTheCensus: [] });
  });
});
