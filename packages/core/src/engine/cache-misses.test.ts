// cache-misses.test.ts — caching #600, 3-M piece A-2a1: whether each stored request read what its
// predecessor left in the provider's cache. The lists are stored request records shaped as the
// census's rows (`plans/llm-prompt-caching/pr3/3m/census-A2.md` answer 4): Anthropic writes its
// write as `cache_creation_input_tokens`, OpenAI as `cache_write_tokens`, and Anthropic's tool-loop
// final request records no `cache_requested`. Check 1 uses the counts of the live tool step
// MA2-899-LIVE-01 (every turn read exactly the turn before's read + write).
//
// On a failing CI host each cell prints every entry's position, `request_in_call`,
// `cache_requested`, `provider` and token counts (test values only; no record holds prompt text),
// then the verdict that differed.
import { describe, expect, it } from 'vitest';
import {
  cacheReadVerdicts,
  type CacheNotComparedCause,
  type CacheReadVerdict,
} from './cache-misses.js';

type Spec = {
  provider: string;
  /** Absent: the list was recorded before Realm recorded where a call begins. */
  in_call?: number;
  /** `cache_requested`; absent: Anthropic's final request, or a gateway-dropped request. */
  asked?: string;
  /** `cache_read_input_tokens`; absent: not reported. */
  read?: unknown;
  /** The write, under the provider's own field; absent: not reported. */
  write?: unknown;
  reference?: unknown;
};

/** One step's stored list, an entry per spec, in order. */
function stored(...specs: Spec[]): Record<string, unknown>[] {
  return specs.map((s, i) => {
    const anthropic = s.provider === 'anthropic';
    const count = (v: unknown): number => (typeof v === 'number' ? v : 0);
    const r: Record<string, unknown> = {
      request_start: `2026-11-08T05:00:${String(i).padStart(2, '0')}.000Z`,
      request_index: i,
      model: anthropic ? 'claude-sonnet-5-5' : 'gpt-5.5',
      endpoint: 'default',
      provider: s.provider,
      input_tokens: 4 + count(s.read) + count(s.write),
      output_tokens: 40,
    };
    if (s.asked !== undefined) r['cache_requested'] = s.asked;
    if (anthropic && s.asked === 'lifetime') r['cache_lifetime_s'] = 300;
    if (s.read !== undefined) r['cache_read_input_tokens'] = s.read;
    if (s.write !== undefined) {
      r[anthropic ? 'cache_creation_input_tokens' : 'cache_write_tokens'] = s.write;
      if (anthropic && typeof s.write === 'number') {
        r['cache_creation'] = { ephemeral_5m_input_tokens: s.write, ephemeral_1h_input_tokens: 0 };
      }
    }
    if (s.in_call !== undefined) r['request_in_call'] = s.in_call;
    if (s.reference !== undefined) r['reference'] = s.reference;
    return r;
  });
}

/** What a failing cell prints: each entry's place, ask, provider and counts. */
function show(list: readonly unknown[]): string {
  const one = (e: unknown): string => {
    if (e === null || typeof e !== 'object' || Array.isArray(e)) return JSON.stringify(e);
    const r = e as Record<string, unknown>;
    const write = r['cache_creation_input_tokens'] ?? r['cache_write_tokens'];
    return (
      `in_call=${String(r['request_in_call'])} asked=${String(r['cache_requested'])} ` +
      `provider=${String(r['provider'])} read=${JSON.stringify(r['cache_read_input_tokens'])} ` +
      `write=${JSON.stringify(write)}`
    );
  };
  return list
    .map((e, i) => {
      const ref =
        e !== null && typeof e === 'object' && !Array.isArray(e)
          ? (e as Record<string, unknown>)['reference']
          : undefined;
      return `#${i} ${one(e)}${ref === undefined ? '' : ` reference: ${one(ref)}`}`;
    })
    .join('\n');
}

const A = 'anthropic';
const O = 'openai';

describe("caching 3-M A-2a1 — a tool step's turns (Anthropic, the exact rule)", () => {
  // Positions 0–3 are one call: three turns, then the final request (no `cache_requested`).
  // Position 2 reads one token less than position 1 read and wrote (6,897 + 96 = 6,993).
  const turns = stored(
    { provider: A, in_call: 0, asked: 'lifetime', read: 0, write: 6897 },
    { provider: A, in_call: 1, asked: 'lifetime', read: 6897, write: 96 },
    { provider: A, in_call: 2, asked: 'lifetime', read: 6992, write: 94 },
    { provider: A, in_call: 3, read: 0, write: 0 },
  );

  // Can fail: `<=` for `<` in the exact rule makes the equal read a miss. Prints the list, then the
  // verdict for position 1.
  it('a turn that reads exactly what the turn before read and wrote is held against that turn', () => {
    expect(cacheReadVerdicts(turns)[1], show(turns)).toEqual({
      outcome: 'held',
      predecessor: { from: 'list', at: 0 },
    });
  });

  // Can fail: the exact rule given a tolerance, or the predecessor taken as any turn but the one
  // before (6,897 is then expected and the read is held). Prints the list, then position 2's
  // verdict.
  it('a turn one token short of that is missed by 1 under the exact rule, against the turn before', () => {
    expect(cacheReadVerdicts(turns)[2], show(turns)).toEqual({
      outcome: 'missed',
      predecessor: { from: 'list', at: 1 },
      expected_tokens: 6993,
      shortfall_tokens: 1,
      rule: 'exact',
    });
  });

  // Can fail: an absent `cache_requested` read as asked judges the final request against turn 2
  // (a miss of 7,086). Prints the list, then position 3's verdict.
  it('the final request, which records no cache_requested, is not judged', () => {
    expect(cacheReadVerdicts(turns)[3], show(turns)).toEqual({ outcome: 'not_asked' });
  });
});

describe('caching 3-M A-2a1 — repair attempts: three calls in one stored list', () => {
  // An Anthropic tool step whose first call ran no tool and whose corrections spent the budget:
  // call 1 is positions 0–2 (2 is its final request), call 2 (the first repair) is 3–4, and call 3
  // is 5.
  const calls = stored(
    { provider: A, in_call: 0, asked: 'lifetime', read: 0, write: 6897 },
    { provider: A, in_call: 1, asked: 'lifetime', read: 6897, write: 96 },
    { provider: A, in_call: 2, read: 0, write: 0 },
    { provider: A, in_call: 0, asked: 'lifetime', read: 6897, write: 120 },
    { provider: A, in_call: 1, asked: 'lifetime', read: 7017, write: 96 },
    { provider: A, in_call: 0, asked: 'lifetime', read: 7017, write: 0 },
  );

  // Can fail: a call's first request judged against the entry before it (position 1, the
  // correction turn: a miss of 96) or any earlier request that asked. Prints the list, then
  // position 3's verdict.
  it("a repair call's first request is judged against the earlier call's first request, never a later turn of that call", () => {
    expect(cacheReadVerdicts(calls)[3], show(calls)).toEqual({
      outcome: 'held',
      predecessor: { from: 'list', at: 0 },
    });
  });

  // Can fail: the call's first request left out of its own call (the scan stops before it), so a
  // later turn finds no predecessor. Prints the list, then position 4's verdict.
  it("a later turn of a repair call is judged against that call's first request", () => {
    expect(cacheReadVerdicts(calls)[4], show(calls)).toEqual({
      outcome: 'held',
      predecessor: { from: 'list', at: 3 },
    });
  });

  // Can fail: the list's first call opener taken instead of the nearest (position 0). Prints the
  // list, then position 5's verdict.
  it("a second repair call's first request is judged against the nearest earlier call's first request, not the list's first", () => {
    expect(cacheReadVerdicts(calls)[5], show(calls)).toEqual({
      outcome: 'held',
      predecessor: { from: 'list', at: 3 },
    });
  });
});

describe('caching 3-M A-2a1 — the reference a later drive carries', () => {
  /** A-1's copy of an earlier drive's first request of the step's last call. */
  const reference = (asked: string | undefined): Record<string, unknown> => ({
    from: 'run',
    request_start: '2026-11-08T04:00:00.000Z',
    provider: A,
    model: 'claude-sonnet-5-5',
    endpoint: 'default',
    ...(asked === undefined ? {} : { cache_requested: asked }),
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 6897,
  });

  // Can fail: the reference ignored (no_earlier_request), or the request's own counts used in its
  // place. Prints the entry with its reference, then the verdict.
  it("a step's first request in a later drive is judged against its reference, by the reference's counts", () => {
    const list = stored({
      provider: A,
      in_call: 0,
      asked: 'lifetime',
      read: 6000,
      write: 897,
      reference: reference('lifetime'),
    });
    expect(cacheReadVerdicts(list), show(list)).toEqual([
      {
        outcome: 'missed',
        predecessor: { from: 'reference' },
        expected_tokens: 6897,
        shortfall_tokens: 897,
        rule: 'exact',
      },
    ]);
  });

  // Can fail: the reference taken without the asked test on its own `cache_requested` (it is then
  // judged: held). An absent one is an earlier drive after a gateway refusal; `off` one run with
  // `--prompt-cache off`. Prints the entry with its reference, then the verdict.
  it.each([
    ['absent', undefined],
    ['off', 'off'],
  ])(
    'a reference whose cache_requested is %s asked nothing, so the request has no earlier request',
    (_label, asked) => {
      const list = stored({
        provider: A,
        in_call: 0,
        asked: 'lifetime',
        read: 6897,
        write: 0,
        reference: reference(asked),
      });
      expect(cacheReadVerdicts(list), show(list)).toEqual([
        { outcome: 'not_compared', cause: 'no_earlier_request' },
      ]);
    },
  );
});

describe('caching 3-M A-2a1 — a request that asked but is not compared, one cell per cause', () => {
  const notCompared = (cause: CacheNotComparedCause): CacheReadVerdict => ({
    outcome: 'not_compared',
    cause,
  });

  // Can fail: the `not_recorded` test removed (the requests then say no_earlier_request). Prints
  // the list, then the verdicts.
  it('a list recorded without request_in_call: each request that asked is not_recorded', () => {
    const list = stored(
      { provider: A, asked: 'lifetime', read: 0, write: 6897 },
      { provider: A, asked: 'lifetime', read: 6897, write: 96 },
    );
    expect(cacheReadVerdicts(list), show(list)).toEqual([
      notCompared('not_recorded'),
      notCompared('not_recorded'),
    ]);
  });

  // Can fail: the `no_earlier_request` test removed (the request falls through to the count test).
  // Prints the list, then the verdict.
  it("a step's first request with no reference: no_earlier_request", () => {
    const list = stored({ provider: A, in_call: 0, asked: 'lifetime', read: 0, write: 6897 });
    expect(cacheReadVerdicts(list), show(list)).toEqual([notCompared('no_earlier_request')]);
  });

  // Can fail: that count's test removed, so a missing count is read as 0 (n8n's bug before its
  // merge) and the request is judged. Only the named count is missing; every other is reported.
  // Prints the list, then position 1's verdict.
  it.each<[string, Spec, Spec]>([
    [
      "the request's own read",
      { provider: A, in_call: 0, asked: 'lifetime', read: 0, write: 6897 },
      { provider: A, in_call: 1, asked: 'lifetime', write: 96 },
    ],
    [
      "its predecessor's read",
      { provider: A, in_call: 0, asked: 'lifetime', write: 6897 },
      { provider: A, in_call: 1, asked: 'lifetime', read: 6897, write: 96 },
    ],
    [
      "on Anthropic, its predecessor's write (the predecessor's read is reported)",
      { provider: A, in_call: 0, asked: 'lifetime', read: 6800 },
      { provider: A, in_call: 1, asked: 'lifetime', read: 6897, write: 96 },
    ],
  ])('counts_not_reported when %s is not reported', (_label, first, second) => {
    const list = stored(first, second);
    expect(cacheReadVerdicts(list)[1], show(list)).toEqual(notCompared('counts_not_reported'));
  });

  // Can fail: the `nothing_expected` test removed (the request is held), or — the OpenAI cell —
  // that test requiring a reported write of 0 (OpenAI before GPT-5.6 reports none: held). Prints
  // the list, then position 1's verdict.
  it.each<[string, Spec, Spec]>([
    [
      "an Anthropic predecessor that read 0 and wrote 0 (a prompt under the model's minimum)",
      { provider: A, in_call: 0, asked: 'lifetime', read: 0, write: 0 },
      { provider: A, in_call: 1, asked: 'lifetime', read: 0, write: 0 },
    ],
    [
      'an OpenAI predecessor that read 0 and reported no write (every first turn before GPT-5.6)',
      { provider: O, in_call: 0, asked: 'provider_rules', read: 0 },
      { provider: O, in_call: 1, asked: 'provider_rules', read: 1920 },
    ],
  ])('nothing_expected after %s', (_label, first, second) => {
    const list = stored(first, second);
    expect(cacheReadVerdicts(list)[1], show(list)).toEqual(notCompared('nothing_expected'));
  });

  // Can fail: the causes checked in another order (the count test before `not_recorded`). Prints
  // the list, then the verdicts.
  it('a list without request_in_call whose counts are also missing still says not_recorded', () => {
    const list = stored(
      { provider: A, asked: 'lifetime' },
      { provider: A, asked: 'lifetime', write: 96 },
    );
    expect(cacheReadVerdicts(list), show(list)).toEqual([
      notCompared('not_recorded'),
      notCompared('not_recorded'),
    ]);
  });
});

describe("caching 3-M A-2a1 — the tolerance rule (OpenAI, Claude Code's thresholds)", () => {
  const missed = (expected: number, shortfall: number): CacheReadVerdict => ({
    outcome: 'missed',
    predecessor: { from: 'list', at: 0 },
    expected_tokens: expected,
    shortfall_tokens: shortfall,
    rule: 'tolerance',
  });
  const held: CacheReadVerdict = { outcome: 'held', predecessor: { from: 'list', at: 0 } };

  // Can fail, per row: 47,000 — the exact rule applied to every provider (a write OpenAI before
  // GPT-5.6 does not report then stops the comparison); 48,000 — the 95% test removed (2,000
  // short then misses); 8,500 — the 2,000 test removed; 95,000 — `<=` for `<` on 95%; 18,000 — `>`
  // for `>=` on 2,000; 30,000 — a reported write ignored (nothing_expected then). Prints the list,
  // then position 1's verdict.
  it.each<[string, number, number | undefined, number, CacheReadVerdict]>([
    [
      'read 47,000 after 50,000 (6% and 3,000 short): missed by 3,000',
      50000,
      undefined,
      47000,
      missed(50000, 3000),
    ],
    ['read 48,000 after 50,000 (4% short): held', 50000, undefined, 48000, held],
    ['read 8,500 after 10,000 (15% short, but 1,500 tokens): held', 10000, undefined, 8500, held],
    ['read 95,000 after 100,000 (exactly 95%): held', 100000, undefined, 95000, held],
    [
      'read 18,000 after 20,000 (exactly 2,000 short, 10%): missed by 2,000',
      20000,
      undefined,
      18000,
      missed(20000, 2000),
    ],
    [
      'GPT-5.6 and later: read 0 after a turn that read 0 and wrote 30,000: missed by 30,000',
      0,
      30000,
      0,
      missed(30000, 30000),
    ],
  ])('%s', (_label, beforeRead, beforeWrite, read, verdict) => {
    const list = stored(
      { provider: O, in_call: 0, asked: 'provider_rules', read: beforeRead, write: beforeWrite },
      { provider: O, in_call: 1, asked: 'provider_rules', read },
    );
    expect(cacheReadVerdicts(list)[1], show(list)).toEqual(verdict);
  });
});

describe('caching 3-M A-2a1 — a stored list from another writer or an older version', () => {
  // Can fail: a property read on an entry that is not an object (`null`) throws. Prints the list,
  // then the verdicts.
  it('never throws: an entry that is not an object asked nothing, and a count written as a string is not reported', () => {
    const list: unknown[] = [
      null,
      'a string',
      ['an', 'array'],
      ...stored(
        { provider: A, in_call: 0, asked: 'lifetime', read: 0, write: 6897 },
        { provider: A, in_call: 1, asked: 'lifetime', read: '6897', write: '96' },
      ),
    ];
    expect(cacheReadVerdicts(list), show(list)).toEqual([
      { outcome: 'not_asked' },
      { outcome: 'not_asked' },
      { outcome: 'not_asked' },
      { outcome: 'not_compared', cause: 'no_earlier_request' },
      { outcome: 'not_compared', cause: 'counts_not_reported' },
    ]);
  });
});
