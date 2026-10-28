// cacheability.test.ts — issue #600 caching PR 5 (C1.1): core's pure derivation of each agent step's
// fixed part — its token interval, its verdict against a floor, and the steps it shares a beginning
// with. The blocks are built here, shaped like the host's (a tools block of header, schema and strict
// flag; a system block of profile, base and schema line); core sees no provider. On a failing CI host
// each cell prints sizes, token counts, verdict words and segment names: test values only.
import { describe, expect, it } from 'vitest';
import {
  cacheTokenInterval,
  cacheVerdict,
  describeCacheability,
  DEFAULT_CHARS_PER_TOKEN_HIGH,
  DEFAULT_CHARS_PER_TOKEN_LOW,
  type CacheBlock,
} from './cacheability.js';

const HEADER = '[{"name":"__realm_submit__","description":"Return it.","input_schema":';
const STRICT = ',"strict":true';

/** A tools block shaped like the host's: header, schema, the strict flag when strict, then `}]`. */
function tools(schema: string, strict: boolean): CacheBlock {
  const text = `${HEADER}${schema}${strict ? STRICT : ''}}]`;
  const s = HEADER.length + schema.length;
  return {
    name: 'tools',
    text,
    stable: true,
    segments: [
      { name: 'tool_header', start: 0, end: HEADER.length },
      { name: 'tool_schema', start: HEADER.length, end: s },
      ...(strict ? [{ name: 'tool_strict', start: s, end: s + STRICT.length }] : []),
    ],
  };
}

const BASE = 'You are an agent executing a step.\nRespond with a JSON object only.';
const LINE = '\nThe JSON must conform to this schema: ';

/** A system block shaped like `buildSystemPrompt`'s: profile + `\n\n`, the base, the schema line. */
function system(profile: string | undefined, schema: string | undefined): CacheBlock {
  const head = profile !== undefined ? `${profile}\n\n` : '';
  const tail = schema !== undefined ? `${LINE}${schema}` : '';
  const text = `${head}${BASE}${tail}`;
  return {
    name: 'system',
    text,
    stable: true,
    segments: [
      ...(profile !== undefined ? [{ name: 'profile', start: 0, end: head.length }] : []),
      { name: 'base', start: head.length, end: head.length + BASE.length },
      ...(schema !== undefined
        ? [{ name: 'schema_line', start: head.length + BASE.length, end: text.length }]
        : []),
    ],
  };
}

const MESSAGES: CacheBlock = { name: 'messages', text: 'the input', stable: false, segments: [] };

describe('the token interval (C1.1; Δ13, Δ16)', () => {
  // (a) red when either default divisor changes; (b) prints the two constants.
  it('the default range is 2.5–5 characters per token', () => {
    expect([DEFAULT_CHARS_PER_TOKEN_LOW, DEFAULT_CHARS_PER_TOKEN_HIGH]).toEqual([2.5, 5]);
  });

  // (a) red when lo stops being chars/5, hi stops being chars/2.5 on ASCII text, or the host's band
  //     is not added to both ends; (b) prints each interval.
  it('1,010 chars read 202–404, and 422–934 with a band of 220–530; 515 chars read 103–206', () => {
    expect([
      cacheTokenInterval('a'.repeat(1010)),
      cacheTokenInterval('a'.repeat(1010), { extraTokens: { low: 220, high: 530 } }),
      cacheTokenInterval('a'.repeat(515)),
    ]).toEqual([
      { low: 202, high: 404 },
      { low: 422, high: 934 },
      { low: 103, high: 206 },
    ]);
  });

  // Δ16: one token per non-ASCII UTF-16 code unit at the high end. (a) red when the term is dropped
  // (the high end falls to 502, and the verdict at 512 turns to below); (b) prints the interval and
  // the verdict.
  it('text outside ASCII counts up to a token a character at the high end: 157 ASCII + 1,100 CJK reads 252–1,162, near at 512', () => {
    const text = `${'a'.repeat(157)}${'中'.repeat(1100)}`;
    const tokens = cacheTokenInterval(text);
    expect([text.length, tokens, cacheVerdict(tokens, 512)]).toEqual([
      1257,
      { low: 252, high: 1162 },
      'near_floor',
    ]);
  });

  // (a) red when the ratio's ±15% changes or the ratio is ignored; (b) prints the interval.
  it('with a ratio r: chars / (r × 1.15) to chars / (r × 0.85) — 1,000 chars at 4 read 218–294', () => {
    expect(cacheTokenInterval('a'.repeat(1000), { ratio: { chars_per_token: 4 } })).toEqual({
      low: 218,
      high: 294,
    });
  });

  // Correction 1 (C-2): the label says ±15% on characters per token, so the high end is
  // chars / (r × 0.85). 1,782 chars at 4 read 388–524: a floor of 520 is inside the range (near),
  // 525 above it (below). (a) red when the high factor is put back to chars / r × 1.15 (high 512:
  // 520 then reads below); (b) prints the interval and both verdicts.
  it('C-2, the high end: 1,782 chars at 4 read 388–524 — near at 520, below at 525', () => {
    const tokens = cacheTokenInterval('a'.repeat(1782), { ratio: { chars_per_token: 4 } });
    expect([tokens, cacheVerdict(tokens, 520), cacheVerdict(tokens, 525)]).toEqual([
      { low: 388, high: 524 },
      'near_floor',
      'below_floor',
    ]);
  });

  // Correction 1 (C-2): the low end is chars / (r × 1.15), which the high-end cell does not
  // discriminate (388 either way). 2,300 chars at 1 give a low end of 2,000 (chars / r × 0.87 gave
  // 2,001), so a floor of 2,000 reads above. (a) red when the low factor is put back to
  // chars / r × 0.87 (the floor then reads near); (b) prints the interval and the verdict.
  it('C-2, the low end: 2,300 chars at 1 read from 2,000 — above at 2,000', () => {
    const tokens = cacheTokenInterval('a'.repeat(2300), { ratio: { chars_per_token: 1 } });
    expect([tokens.low, cacheVerdict(tokens, 2000)]).toEqual([2000, 'above_floor']);
  });

  // Δ13: whole token counts. At 5,116 chars, lo = 1,023.2, so every whole count in the interval is
  // at least 1,024. (a) red when lo is compared unrounded (the verdict reads near); (b) prints the
  // interval and the verdict.
  it('the rounding: 5,116 chars against 1,024 is above, not near', () => {
    const tokens = cacheTokenInterval('a'.repeat(5116));
    expect([tokens, cacheVerdict(tokens, 1024)]).toEqual([
      { low: 1024, high: 2046 },
      'above_floor',
    ]);
  });
});

describe('the verdict, per conjunct (C1.1)', () => {
  // (a) red when `high < floor` becomes `<=` (the first reads below), or `low >= floor` becomes `>`
  //     (the third reads near); (b) prints the four verdicts.
  it('below only when the high end is under the floor; above only when the low end reaches it', () => {
    expect([
      cacheVerdict({ low: 400, high: 511 }, 512),
      cacheVerdict({ low: 400, high: 512 }, 512),
      cacheVerdict({ low: 512, high: 600 }, 512),
      cacheVerdict({ low: 511, high: 600 }, 512),
    ]).toEqual(['below_floor', 'near_floor', 'above_floor', 'near_floor']);
  });

  // (a) red when a step without a floor gets a verdict, or near loses its cause; (b) prints each
  //     step's verdict and cause.
  it('no floor, no verdict; a near verdict carries the cause near_floor', () => {
    const steps = [{ step: 'a', blocks: [system(undefined, undefined), MESSAGES] }];
    const without = describeCacheability(steps)[0]!;
    const at = describeCacheability(steps, { floor: { tokens: without.prefix.tokens.high } })[0]!;
    expect([
      [without.verdict, without.not_judged_cause],
      [at.verdict, at.not_judged_cause],
    ]).toEqual([
      ['not_judged', undefined],
      ['near_floor', 'near_floor'],
    ]);
  });
});

describe('the size and the sharing (C1.1; Δ12)', () => {
  const SCHEMA_A = '{"type":"object","properties":{"a":{"type":"string"}}}';
  const SCHEMA_B = '{"type":"object","properties":{"b":{"type":"string"}}}';

  // (a) red when a block that is not stable is counted, or the band is added to a step that has
  //     none; (b) prints each step's size and interval.
  it("the size is the stable blocks' text; a step's band is its own", () => {
    const report = describeCacheability([
      {
        step: 'banded',
        blocks: [tools(SCHEMA_A, false), system(undefined, SCHEMA_A), MESSAGES],
        extraTokens: { low: 220, high: 530 },
      },
      { step: 'plain', blocks: [system(undefined, undefined), MESSAGES] },
    ]);
    const banded = tools(SCHEMA_A, false).text.length + system(undefined, SCHEMA_A).text.length;
    expect(report.map((s) => [s.step, s.prefix.chars, s.prefix.tokens, s.prefix.basis])).toEqual([
      [
        'banded',
        banded,
        { low: Math.ceil(banded / 5) + 220, high: Math.floor(banded / 2.5) + 530 },
        'default',
      ],
      [
        'plain',
        BASE.length,
        { low: Math.ceil(BASE.length / 5), high: Math.floor(BASE.length / 2.5) },
        'default',
      ],
    ]);
  });

  // Where each pair parts, read from each step's side. (a) red when the pair is read from one side
  //     only (the non-strict side of the strict pair reads no segment, and the schema-less side of
  //     the schema pair reads none), when equal texts get a segment, or when a profile difference is
  //     named as another segment; (b) prints every step's shares as [other, chars, segment].
  it('equal; the schemas differ; only strict differs (read from both sides); the profiles differ; one text ends where the other goes on', () => {
    const report = describeCacheability([
      { step: 'one', blocks: [tools(SCHEMA_A, false), system(undefined, SCHEMA_A), MESSAGES] },
      { step: 'same', blocks: [tools(SCHEMA_A, false), system(undefined, SCHEMA_A), MESSAGES] },
      {
        step: 'other_schema',
        blocks: [tools(SCHEMA_B, false), system(undefined, SCHEMA_B), MESSAGES],
      },
      { step: 'strict', blocks: [tools(SCHEMA_A, true), system(undefined, SCHEMA_A), MESSAGES] },
    ]);
    const shares = (step: string) =>
      report
        .find((s) => s.step === step)!
        .shares_with.map((w) => [w.step, w.chars, w.divergence_at]);
    const whole = tools(SCHEMA_A, false).text.length + system(undefined, SCHEMA_A).text.length;
    const toSchema = HEADER.length + '{"type":"object","properties":{"'.length;
    const toStrict = HEADER.length + SCHEMA_A.length;
    expect([shares('one'), shares('strict')]).toEqual([
      [
        ['same', whole, null],
        ['other_schema', toSchema, 'tool_schema'],
        ['strict', toStrict, 'tool_strict'],
      ],
      [
        ['one', toStrict, 'tool_strict'],
        ['same', toStrict, 'tool_strict'],
        ['other_schema', toSchema, 'tool_schema'],
      ],
    ]);

    const openai = describeCacheability([
      { step: 'with_schema', blocks: [system('You are a reviewer.', SCHEMA_A), MESSAGES] },
      { step: 'no_schema', blocks: [system('You are a reviewer.', undefined), MESSAGES] },
      { step: 'other_profile', blocks: [system('You are a writer.', SCHEMA_A), MESSAGES] },
    ]);
    const parts = (step: string) =>
      openai
        .find((s) => s.step === step)!
        .shares_with.map((w) => [w.step, w.chars, w.divergence_at]);
    const ends = 'You are a reviewer.\n\n'.length + BASE.length;
    expect([parts('with_schema'), parts('no_schema')]).toEqual([
      [
        ['no_schema', ends, 'schema_line'],
        ['other_profile', 'You are a '.length, 'profile'],
      ],
      [
        ['with_schema', ends, 'schema_line'],
        ['other_profile', 'You are a '.length, 'profile'],
      ],
    ]);
  });

  // (a) red when a step with no stable block is measured or shared; (b) prints sizes and shares.
  it('a step with no stable block has size 0 and shares nothing; others do not list it', () => {
    const report = describeCacheability([
      { step: 'empty', blocks: [MESSAGES] },
      { step: 'full', blocks: [system(undefined, undefined), MESSAGES] },
    ]);
    expect(report.map((s) => [s.step, s.prefix.chars, s.shares_with.length])).toEqual([
      ['empty', 0, 0],
      ['full', BASE.length, 0],
    ]);
  });
});
