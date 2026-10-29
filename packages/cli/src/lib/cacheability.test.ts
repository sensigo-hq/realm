// lib/cacheability.test.ts — issue #600 caching PR 5 (C3.2–C3.5): the host's own rules, called
// directly where the commands' cells (validate-cacheability.test.ts) cannot reach them cleanly — the
// flags' edge values, the share rule (a whole shared fixed part only — #918), the economics detail's escaping, and the
// once-lines printed once per process. On a failing host each cell prints realm's words and the
// flags' answers: test values only, the scratch path written `<dir>`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CacheabilityStep, CacheShare, WorkflowDefinition } from '@sensigo/realm';
import {
  buildCacheabilityReport,
  checkCacheFlags,
  renderCacheabilityLines,
  shareClauses,
} from './cacheability.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A definition with the given agent steps (no profile). */
function definition(steps: Record<string, Record<string, unknown>>): WorkflowDefinition {
  return {
    id: 'w',
    name: 'w',
    version: 1,
    steps: Object.fromEntries(
      Object.entries(steps).map(([id, s]) => [
        id,
        { description: id, execution: 'agent', depends_on: [], ...s },
      ]),
    ),
  } as unknown as WorkflowDefinition;
}

describe('the flags (C3.5)', () => {
  // (a) red when a value the rule refuses is accepted, or one it accepts refused; (b) prints each
  //     answer: the checked flags, or the first word of the refusal's subject.
  it('--floor is a whole number ≥ 1; --ratio a plain number > 0; --model needs --provider', () => {
    const answer = (opts: Parameters<typeof checkCacheFlags>[0]): unknown => {
      const r = checkCacheFlags(opts);
      return r.ok ? r.flags : r.message.split(' ')[1];
    };
    expect([
      answer({ floor: '512' }),
      answer({ floor: '0' }),
      answer({ floor: '+5' }),
      answer({ floor: '1e3' }),
      answer({ floor: ' 5' }),
      answer({ ratio: '3.7' }),
      answer({ ratio: '.5' }),
      answer({ ratio: '0.0' }),
      answer({ ratio: '-1' }),
      answer({ ratio: '1e2' }),
      answer({ provider: 'openai' }),
      answer({ model: 'gpt-5' }),
      answer({ provider: 'openai', model: 'gpt-5' }),
    ]).toEqual([
      { floor: 512 },
      '--floor',
      '--floor',
      '--floor',
      '--floor',
      { ratio: 3.7 },
      { ratio: 0.5 },
      '--ratio',
      '--ratio',
      '--ratio',
      { provider: 'openai' },
      '--provider',
      { provider: 'openai', model: 'gpt-5' },
    ]);
  });
});

/** An eligible schema with one required string. */
const schemaOf = (name: string): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  required: [name],
  properties: { [name]: { type: 'string' } },
});
/** The same 400-character profile for every step that names `p400`. */
const P400 = { p400: { content: 'P'.repeat(400), content_hash: 'h400' } };

describe('the share rule, one input at a time (#918, N2)', () => {
  // `shareClauses` is called with a hand-built step, one input changed per row: a line names only a
  // whole shared fixed part, nothing for a step below the floor whose size realm counts (F-4), and
  // the clause again where realm does not count the size in full (F-4's strict-rung exception).
  // (a) red: naming a share whose `divergence_at` is not null turns rows 4 and 5 red; dropping the
  //     F-4 return turns row 2 red; ignoring `sizeCounted` turns row 3 red. (b) a failing row prints
  //     its name and the clauses returned (step names only).
  it('N2: a whole share is named; F-4 and its exception; a share that parts anywhere is not', () => {
    const step = (
      verdict: CacheabilityStep['verdict'],
      divergence_at: CacheShare['divergence_at'],
    ): CacheabilityStep => ({
      step: 'a',
      prefix: { chars: 400, tokens: { low: 160, high: 320 }, basis: 'default' },
      shares_with: [{ step: 'b', chars: 400, tokens: { low: 160, high: 320 }, divergence_at }],
      verdict,
    });
    const rows: Array<[string, Parameters<typeof shareClauses>, unknown]> = [
      ['1 a whole share, the step above', [step('above_floor', null), true], [{ steps: ['b'] }]],
      ['2 the same, the step below, the size counted', [step('below_floor', null), true], []],
      ['3 the same, the size not counted', [step('below_floor', null), false], [{ steps: ['b'] }]],
      [
        '4 parts in the schema line, the step above',
        [step('above_floor', 'schema_line'), true],
        [],
      ],
      ['5 parts in the base, the step above', [step('above_floor', 'base'), true], []],
    ];
    expect(rows.map(([name, args]) => [name, shareClauses(...args)])).toEqual(
      rows.map(([name, , expected]) => [name, expected]),
    );
  });
});

describe('the sharing filter (C3.2; correction 1, C-1.2)', () => {
  // #918: on OpenAI no share inside the one system message is named. np_one and np_two carry no
  // profile, and their first required names start with the same letter (they shared 254 chars at
  // 894d0725, all Realm's own text); pfs_one and pfs_two share a profile but are strict, so their
  // schema comes first. (a) red when a share inside one message is named (either pair gains a
  // clause); (b) prints the step lines' sharing clauses.
  it('openai: no share inside one message is named — without a shared profile, nor on the strict rung', async () => {
    const def = {
      ...definition({
        np_one: { output_schema: schemaOf('category') },
        np_two: { output_schema: schemaOf('code') },
        pfs_one: {
          agent_profile: 'p400',
          structured_output: 'strict',
          output_schema: schemaOf('answer'),
        },
        pfs_two: {
          agent_profile: 'p400',
          structured_output: 'strict',
          output_schema: schemaOf('summary'),
        },
      }),
      resolved_profiles: P400,
    } as WorkflowDefinition;
    const lines = renderCacheabilityLines(
      await buildCacheabilityReport(def, { provider: 'openai' }),
    ).steps;
    expect(lines.map((l) => l.includes('shares'))).toEqual([false, false, false, false]);
  });
  // N1 (#918, the at-stake cell): the profile pair — the same 400-char profile, different schemas,
  // not strict — shares a 655-character start inside the one system message, which OpenAI did not
  // read on gpt-5.6-luna. The line names no share, with no floor and at floor 100 (where the share,
  // 131–262 tokens, and the step, 141–280, are both above it, so F-4 does not hide it). (a) red when
  // the shared-start clause is restored (`shares its first 655 chars with pf_two: the schemas
  // differ`); (b) prints the line's text after its last ` — `.
  it('N1 openai: a pair that shares a whole profile and parts in the schema is not named, with or without a floor', async () => {
    const def = {
      ...definition({
        pf_one: { agent_profile: 'p400', output_schema: schemaOf('answer') },
        pf_two: { agent_profile: 'p400', output_schema: schemaOf('summary') },
      }),
      resolved_profiles: P400,
    } as WorkflowDefinition;
    const lineAt = async (floor?: number): Promise<string> =>
      renderCacheabilityLines(
        await buildCacheabilityReport(def, {
          provider: 'openai',
          ...(floor !== undefined ? { floor } : {}),
        }),
      ).steps[0]!;
    const lines = [await lineAt(), await lineAt(100)];
    expect(
      lines.map((l) => (l.includes(' — shares ') ? l.split(' — ').slice(-1)[0] : 'none')),
    ).toEqual(['none', 'none']);
  });
  // A pair that parts inside its profile shares no whole profile: two profiles that share their
  // first 200 characters are not named. (a) red when a pair that parts inside a profile is printed;
  // (b) prints whether the line names a share.
  it('a pair that parts inside its profile is not printed, even past 155 shared chars', async () => {
    const shared = 'x'.repeat(200);
    const def = {
      ...definition({ a: { agent_profile: 'pa' }, b: { agent_profile: 'pb' } }),
      resolved_profiles: {
        pa: { content: `${shared} one`, content_hash: 'h1' },
        pb: { content: `${shared} two`, content_hash: 'h2' },
      },
    } as WorkflowDefinition;
    const line = renderCacheabilityLines(await buildCacheabilityReport(def, { provider: 'openai' }))
      .steps[0]!;
    expect(line.includes('shares')).toBe(false);
  });
  // N3 (#918, rewriting C-7): no floor names the profile pair. Profiles of 400, 1,500 and 3,000
  // chars share 655, 1,755 and 3,255 chars inside the one system message: 131–262 (below 512),
  // 351–702 (it straddles 512), 651–1,302 (above). The intervals are core's and unchanged. (a) red
  // when the shared-start clause is restored (rows 1, 3 and 4 are named; row 2, 400 at 512, is
  // hidden by F-4 either way); (b) prints each step line's sharing text (or `none`) and the interval.
  it('N3 openai: no floor names the pair that shares a profile — none at 400, 1,500 or 3,000 chars', async () => {
    const pair = async (size: number, floor?: number) => {
      const def = {
        ...definition({
          pf_one: { agent_profile: 'p', output_schema: schemaOf('answer') },
          pf_two: { agent_profile: 'p', output_schema: schemaOf('summary') },
        }),
        resolved_profiles: { p: { content: 'P'.repeat(size), content_hash: `h${String(size)}` } },
      } as WorkflowDefinition;
      const report = await buildCacheabilityReport(def, {
        provider: 'openai',
        ...(floor !== undefined ? { floor } : {}),
      });
      const line = renderCacheabilityLines(report).steps[0]!;
      const tokens = report.steps[0]!.layouts[0]!.sized!.step.shares_with[0]!.tokens;
      return [
        line.includes(' — shares ') ? line.slice(line.indexOf(' — shares ') + 3) : 'none',
        tokens,
      ];
    };
    expect([
      await pair(400),
      await pair(400, 512),
      await pair(1500, 512),
      await pair(3000, 512),
    ]).toEqual([
      ['none', { low: 131, high: 262 }],
      ['none', { low: 131, high: 262 }],
      ['none', { low: 351, high: 702 }],
      ['none', { low: 651, high: 1302 }],
    ]);
  });
});

describe('the economics detail (C3.4)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // A detail that escaping would change is printed quoted, as `realm run inspect` prints it. (a) red
  // when the detail is printed raw; (b) prints the clause, the path written `<dir>`.
  it('a path with a double quote is printed quoted, as inspect quotes it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'realm-pr5-quote-'));
    const path = join(dir, 'a"b', 'economics.yaml');
    const report = await buildCacheabilityReport(
      definition({ a: {} }),
      { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      { cacheEconomicsPath: path },
    );
    const line = renderCacheabilityLines(report).steps[0]!;
    expect(line.slice(line.indexOf(' — economics')).split(dir).join('<dir>')).toBe(
      ` — economics unreachable: "cannot read '<dir>/a\\"b/economics.yaml': ENOENT"`,
    );
  });
});

describe('the once-lines, once per process (C3.4)', () => {
  // (a) red when a block printed again prints its once-lines again; (b) prints every line logged.
  it('a second block prints its step lines and none of the once-lines already printed', async () => {
    vi.resetModules();
    const fresh = await import('./cacheability.js');
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    const lines = fresh.renderCacheabilityLines(
      await fresh.buildCacheabilityReport(definition({ a: {} }), { provider: 'openai' }),
    );
    fresh.printCacheabilityLines(lines, '> ');
    fresh.printCacheabilityLines(lines, '> ');
    expect(logged.map((l) => l.slice(0, 18))).toEqual([
      '> cache: a — 155 c',
      '> openai: realm se',
      '> cache: a — 155 c',
    ]);
  });
});
