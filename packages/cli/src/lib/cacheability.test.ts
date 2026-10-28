// lib/cacheability.test.ts — issue #600 caching PR 5 (C3.2–C3.5): the host's own rules, called
// directly where the commands' cells (validate-cacheability.test.ts) cannot reach them cleanly — the
// flags' edge values, the share filter's profile rule, the economics detail's escaping, and the
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

describe('the share rule, one condition at a time (correction 2, F-9)', () => {
  // `shareClauses` is called with a hand-built step, so the describer's segment order cannot make
  // one condition stand in for another: through the describer, "parts in the schema line" already
  // makes the layout, profile-end and coverage conditions true, so deleting one of those leaves
  // every command cell green. The baseline names one `schemas` clause; each row changes exactly one
  // input. (a) deleting ONE condition turns red exactly the rows that depend on it: rows 1–5 and 6
  // each their own; the F-4 check rows 7 and 9-below together; row 8 when F-4's exception is
  // removed. (b) a failing row prints its name and the clauses returned (test values only).
  it('F-9: each condition of the OpenAI schemas clause, and F-4, pinned on its own row', () => {
    const SHARE: CacheShare = {
      step: 'b',
      chars: 300,
      tokens: { low: 120, high: 250 },
      divergence_at: 'schema_line',
    };
    const step = (
      verdict: CacheabilityStep['verdict'],
      share: Partial<CacheShare> = {},
    ): CacheabilityStep => ({
      step: 'a',
      prefix: { chars: 400, tokens: { low: 160, high: 320 }, basis: 'default' },
      shares_with: [{ ...SHARE, ...share }],
      verdict,
    });
    const ends = (a: number, b: number): Map<string, number> =>
      new Map([
        ['a', a],
        ['b', b],
      ]);
    const SCHEMAS = [{ kind: 'schemas', chars: 300, steps: ['b'] }];
    const rows: Array<[string, Parameters<typeof shareClauses>, unknown]> = [
      ['baseline', [step('above_floor'), 'openai', ends(40, 40), 100, true], SCHEMAS],
      ['1 the Anthropic layout', [step('above_floor'), 'anthropic', ends(40, 40), 100, true], []],
      ['2 no profile of its own', [step('above_floor'), 'openai', ends(0, 0), 100, true], []],
      [
        '3 the other profile ends elsewhere',
        [step('above_floor'), 'openai', ends(40, 41), 100, true],
        [],
      ],
      [
        '4 the start short of the profile',
        [step('above_floor', { chars: 39 }), 'openai', ends(40, 40), 100, true],
        [],
      ],
      [
        '5 parts outside the schema line',
        [step('above_floor', { divergence_at: 'base' }), 'openai', ends(40, 40), 100, true],
        [],
      ],
      [
        '6 the share below the floor',
        [step('above_floor'), 'openai', ends(40, 40), 10000, true],
        [],
      ],
      [
        '7 F-4: the step below, the share above',
        [step('below_floor'), 'openai', ends(40, 40), 100, true],
        [],
      ],
      [
        '8 F-4 exception: row 7, the size not counted',
        [step('below_floor'), 'openai', ends(40, 40), 100, false],
        SCHEMAS,
      ],
      [
        '9 a whole share, the step below',
        [step('below_floor', { divergence_at: null }), 'openai', ends(40, 40), 100, true],
        [],
      ],
      [
        '9 a whole share, the step above',
        [step('above_floor', { divergence_at: null }), 'openai', ends(40, 40), 100, true],
        [{ kind: 'whole', chars: 300, steps: ['b'] }],
      ],
    ];
    expect(rows.map(([name, args]) => [name, shareClauses(...args)])).toEqual(
      rows.map(([name, , expected]) => [name, expected]),
    );
  });
});

describe('the sharing filter (C3.2; correction 1, C-1.2)', () => {
  // OpenAI names a partial share only after the whole of a profile both steps carry. np_one and
  // np_two carry none, and their first required names start with the same letter (they shared 254
  // chars at 894d0725, all Realm's own text); pfs_one and pfs_two share a profile but are strict, so
  // their schema comes first. (a) red when the profile condition is removed (the no-profile pair is
  // named); (b) prints the step lines' sharing clauses.
  it('openai: no partial share is named without a whole shared profile, nor on the strict rung', async () => {
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
  // The profile pair: the same 400-char profile, different schemas, not strict. They share the
  // profile, its `\n\n`, Realm's 155-char base, the schema line's 39-char lead and the schema's
  // 59-char opening: 655. (a) red when the profile condition is inverted (the pair is not named);
  // (b) prints the step line's sharing clause.
  it('openai: a pair that shares a whole profile and parts in the schema is named', async () => {
    const def = {
      ...definition({
        pf_one: { agent_profile: 'p400', output_schema: schemaOf('answer') },
        pf_two: { agent_profile: 'p400', output_schema: schemaOf('summary') },
      }),
      resolved_profiles: P400,
    } as WorkflowDefinition;
    const line = renderCacheabilityLines(await buildCacheabilityReport(def, { provider: 'openai' }))
      .steps[0]!;
    expect(line.split(' — ').slice(-1)[0]).toBe(
      'shares its first 655 chars with pf_two: the schemas differ',
    );
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
  // Correction 1 (C-7): with a floor in force, an openai pair that shares a whole profile is named
  // only when its shared start's estimate reaches the floor or comes near it (OpenAI's cache matches
  // a prefix only past its minimum); with no floor, the profile rule alone. Profiles of 400, 1,500
  // and 3,000 chars share 655, 1,755 and 3,255 chars: 131–262 (below 512), 351–702 (it straddles
  // 512: near), 651–1,302 (above). (a) red when the floor filter is removed (the 400-char pair is
  // named under 512) or inverted (the other two vanish); (b) prints each step line's sharing clause
  // and the pair's interval.
  it('C-7 openai: with a floor, a shared profile is named only when its estimate reaches the floor or comes near it', async () => {
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
      ['shares its first 655 chars with pf_two: the schemas differ', { low: 131, high: 262 }],
      ['none', { low: 131, high: 262 }],
      ['shares its first 1,755 chars with pf_two: the schemas differ', { low: 351, high: 702 }],
      ['shares its first 3,255 chars with pf_two: the schemas differ', { low: 651, high: 1302 }],
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
