// lib/cacheability.test.ts — issue #600 caching PR 5 (C3.2–C3.5): the host's own rules, called
// directly where the commands' cells (validate-cacheability.test.ts) cannot reach them cleanly — the
// flags' edge values, the share filter's profile rule, the economics detail's escaping, and the
// once-lines printed once per process. On a failing host each cell prints realm's words and the
// flags' answers: test values only, the scratch path written `<dir>`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinition } from '@sensigo/realm';
import {
  buildCacheabilityReport,
  checkCacheFlags,
  renderCacheabilityLines,
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
