// cache-misses.test.ts — caching #600, 3-M piece A-2a1: whether each stored request read what its
// predecessor left in the provider's cache. The lists are stored request records shaped as the
// census's rows (`plans/llm-prompt-caching/pr3/3m/census-A2.md` answer 4): Anthropic writes its
// write as `cache_creation_input_tokens`, OpenAI as `cache_write_tokens`, and Anthropic's tool-loop
// final request records no `cache_requested`. Check 1 uses the counts of the live tool step
// MA2-899-LIVE-01 (every turn read exactly the turn before's read + write).
//
// On a failing CI host each cell prints every entry's position, `request_in_call`,
// `cache_requested`, `provider` and token counts (test values only; no record holds prompt text),
// then the verdict that differed. Piece A-2a2's cells (`cacheMissCauses`, at the end) print more:
// see `explain`.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  cacheMissCauses,
  cacheMissGaps,
  cachePredecessor,
  cacheReadVerdicts,
  type CacheNotComparedCause,
  type CacheReadVerdict,
} from './cache-misses.js';

/** The parts a request sent, each named by a label the builder turns into its SHA-256. */
type Parts = { tools?: string; system?: string; prompt?: string; format?: string };

type Spec = {
  /** A string on every request Realm records; absent or a number only in the cells of a record
   *  another writer made. */
  provider?: unknown;
  /** Absent: the list was recorded before Realm recorded where a call begins. */
  in_call?: number;
  /** `cache_requested`; absent: Anthropic's final request, or a gateway-dropped request. */
  asked?: string;
  /** `cache_read_input_tokens`; absent: not reported. */
  read?: unknown;
  /** The write, under the provider's own field; absent: not reported. */
  write?: unknown;
  reference?: unknown;
  // Piece A-2a2's facts; each is absent unless a cell sets it.
  /** `endpoint`, the client's kind; absent: `default`. */
  endpoint?: string;
  /** `cache_lifetime_s` on a `lifetime` request: Anthropic's, absent 300; on another provider
   *  written only when set (OpenAI's explicit lifetime, 1,800; piece A-2a3). */
  lifetime_s?: number;
  /** `request_strict_sent`. */
  strict?: boolean;
  /** `cache_marked`. */
  marked?: string[];
  /** `prefix_chars`: present on a split request (0 for a blank head). */
  prefix_chars?: number;
  /** `prefix_parts`. */
  parts?: Parts;
  /** `model`; absent: the provider's usual one; `null`: none recorded (piece A-2a2r). */
  model?: string | null;
  /** `request_start`; absent: one second apart from 05:00:00Z, by position (piece A-2a3). */
  start?: string;
};

const sha256 = (label: string): string => createHash('sha256').update(label).digest('hex');

/** One step's stored list, an entry per spec, in order. */
function stored(...specs: Spec[]): Record<string, unknown>[] {
  return specs.map((s, i) => {
    const anthropic = s.provider === 'anthropic';
    const count = (v: unknown): number => (typeof v === 'number' ? v : 0);
    const r: Record<string, unknown> = {
      request_start: s.start ?? `2026-11-08T05:00:${String(i).padStart(2, '0')}.000Z`,
      request_index: i,
      ...(s.model === null
        ? {}
        : { model: s.model ?? (anthropic ? 'claude-sonnet-5-5' : 'gpt-5.5') }),
      endpoint: s.endpoint ?? 'default',
      ...(s.provider === undefined ? {} : { provider: s.provider }),
      input_tokens: 4 + count(s.read) + count(s.write),
      output_tokens: 40,
    };
    const lifetime = s.lifetime_s ?? 300;
    if (s.asked !== undefined) r['cache_requested'] = s.asked;
    if (s.asked === 'lifetime' && (anthropic || s.lifetime_s !== undefined)) {
      r['cache_lifetime_s'] = lifetime;
    }
    if (s.read !== undefined) r['cache_read_input_tokens'] = s.read;
    if (s.write !== undefined) {
      r[anthropic ? 'cache_creation_input_tokens' : 'cache_write_tokens'] = s.write;
      if (anthropic && typeof s.write === 'number') {
        const hour = lifetime === 3600;
        r['cache_creation'] = {
          ephemeral_5m_input_tokens: hour ? 0 : s.write,
          ephemeral_1h_input_tokens: hour ? s.write : 0,
        };
      }
    }
    if (s.in_call !== undefined) r['request_in_call'] = s.in_call;
    if (s.reference !== undefined) r['reference'] = s.reference;
    if (s.prefix_chars !== undefined) r['prefix_chars'] = s.prefix_chars;
    if (s.parts !== undefined) {
      const digests: Record<string, string> = {};
      for (const [part, label] of Object.entries(s.parts)) {
        if (typeof label === 'string') digests[part] = sha256(label);
      }
      r['prefix_parts'] = digests;
    }
    if (s.marked !== undefined) r['cache_marked'] = [...s.marked];
    if (s.strict !== undefined) r['request_strict_sent'] = s.strict;
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

  // `cachePredecessor` is what A-2a2 reads. Can fail: it returns the entry before
  // (`requests[i - 1]`: positions 3 and 5), or the list's first (positions 4 and 5). The positions
  // are checked first, so the loop cannot pass by checking nothing. Prints the position, the place
  // its verdict names, and the list.
  it('cachePredecessor returns the very entry each verdict names, not a copy', () => {
    const verdicts = cacheReadVerdicts(calls);
    const named = verdicts.flatMap((v, i) =>
      (v.outcome === 'held' || v.outcome === 'missed') && v.predecessor.from === 'list'
        ? [{ i, at: v.predecessor.at }]
        : [],
    );
    expect(
      named.map((n) => n.i),
      show(calls),
    ).toEqual([1, 3, 4, 5]);
    for (const { i, at } of named) {
      expect(cachePredecessor(calls, i), `#${i}, its verdict names #${at}\n${show(calls)}`).toBe(
        calls[at],
      );
    }
  });

  // Can fail, per row: the final request (position 2): the body returns `requests[i - 1]` or the
  // list's first; position 0: the list's first; `'1'`: the guard on `i` deleted (the record at 1 is
  // then found). The rows -1, 1.5, NaN and 6 stay green without that guard (the list holds nothing
  // there): they pin the contract. Prints the `i` with its type, then the list.
  it.each<[string, number]>([
    ['the final request, which asked nothing (position 2)', 2],
    ["a call's first request with no predecessor (position 0)", 0],
    ['-1', -1],
    ['1.5', 1.5],
    ['NaN', Number.NaN],
    ["the list's length (6)", 6],
    ["'1', a string", '1' as unknown as number],
  ])('cachePredecessor gives no record for %s', (_label, i) => {
    expect(
      cachePredecessor(calls, i),
      `i=${String(i)} (${typeof i})\n${show(calls)}`,
    ).toBeUndefined();
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

  /** A later drive's step: one request, judged against the reference it carries. */
  const laterDrive = (): Record<string, unknown>[] =>
    stored({
      provider: A,
      in_call: 0,
      asked: 'lifetime',
      read: 6897,
      write: 0,
      reference: reference('lifetime'),
    });

  // Can fail: `cachePredecessor` returns the entry before (`requests[-1]`: none) or the list's
  // first (the request itself) instead of its `reference`. The verdict's place is checked first.
  // Prints the entry with its reference.
  it('cachePredecessor returns the very reference object the verdict names', () => {
    const list = laterDrive();
    expect(cacheReadVerdicts(list)[0], show(list)).toMatchObject({
      predecessor: { from: 'reference' },
    });
    expect(cachePredecessor(list, 0), show(list)).toBe(list[0]?.['reference']);
  });

  // Can fail: the guard that `requests` is an array removed. `null` and `undefined` then throw
  // reading `length`; the array-like object (it holds the later drive's request) returns that
  // request's reference. Prints the input, then the error or the record.
  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['an array-like object holding a request that asked', { 0: laterDrive()[0], length: 1 }],
  ])('cachePredecessor gives no record when requests is %s', (label, requests) => {
    const entries =
      requests === null || requests === undefined ? [] : [(requests as { 0: unknown })[0]];
    const shown = `requests: ${label}\n${show(entries)}`;
    expect(() => cachePredecessor(requests, 0), shown).not.toThrow();
    expect(cachePredecessor(requests, 0), shown).toBeUndefined();
  });
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

describe("caching 3-M A-2a1 — who asked: a provider module's request, and a provider that is not a string", () => {
  // Can fail: the `module:` test removed. The second request is then judged by the tolerance
  // against the first (missed by 5,000), and the first says no_earlier_request. Prints the list,
  // then the verdicts.
  it("a provider module's requests asked nothing, even when they say lifetime", () => {
    const list = stored(
      { provider: 'module:foo', in_call: 0, asked: 'lifetime', read: 0, write: 5000 },
      { provider: 'module:foo', in_call: 1, asked: 'lifetime', read: 0 },
    );
    expect(cacheReadVerdicts(list), show(list)).toEqual([
      { outcome: 'not_asked' },
      { outcome: 'not_asked' },
    ]);
  });

  // Can fail: the string test on `provider` removed, so reading this request throws a TypeError.
  // One list per case: in one list the first throw would hide the second. Prints the list and the
  // error, then the verdict.
  it.each<[string, unknown]>([
    ['no provider', undefined],
    ['a numeric provider (5)', 5],
  ])(
    'a stored request that says lifetime with %s asked nothing, and is read without a throw',
    (_label, provider) => {
      const list = stored({ provider, in_call: 0, asked: 'lifetime' });
      expect(() => cacheReadVerdicts(list), show(list)).not.toThrow();
      expect(cacheReadVerdicts(list), show(list)).toEqual([{ outcome: 'not_asked' }]);
    },
  );
});

// Piece A-2a2: why a request that missed may have missed (`cacheMissCauses`). In every cell each
// missed request and its predecessor have the same provider, endpoint, model and
// `request_strict_sent`, and the request has a tools part whenever its predecessor has one.

/** A-1b's copy of an earlier drive's request, as the run's record keeps it: the request's own
 *  fields under `CacheReference`'s keys, never a place, an index or token totals. */
function referenceOf(spec: Spec): Record<string, unknown> {
  const {
    request_index: _index,
    request_in_call: _place,
    input_tokens: _input,
    output_tokens: _output,
    ...kept
  } = stored(spec)[0] ?? {};
  // One second before the list's first entry (piece A-2a3): within every lifetime, so no earlier
  // cell's answer turns on the pause; a cell about the pause sets `start` itself.
  return { from: 'run', ...kept, request_start: spec.start ?? '2026-11-08T04:59:59.000Z' };
}

/** A later drive's step: one request, `now`, judged against its reference, `before`. */
function againstReference(now: Spec, before: Spec): Record<string, unknown>[] {
  return stored({ ...now, in_call: 0, reference: referenceOf(before) });
}

/**
 * What an A-2a2 cell prints on failure, per entry: its position, A-2a1's verdict, the facts a cause
 * reads, the counts, and the parts it records with, against the predecessor its verdict names,
 * whether each part's digest is the same (=), differs (≠) or is on one side only. Its reference is
 * printed the same way. Never a digest or a prompt's text.
 */
function explain(list: readonly unknown[]): string {
  const verdicts = cacheReadVerdicts(list);
  const record = (e: unknown): Record<string, unknown> | undefined =>
    e !== null && typeof e === 'object' && !Array.isArray(e)
      ? (e as Record<string, unknown>)
      : undefined;
  const facts = (r: Record<string, unknown>): string =>
    [
      `provider=${String(r['provider'])}`,
      `endpoint=${String(r['endpoint'])}`,
      `model=${String(r['model'])}`,
      `in_call=${String(r['request_in_call'])}`,
      `asked=${String(r['cache_requested'])}`,
      `marked=${JSON.stringify(r['cache_marked'])}`,
      `lifetime_s=${String(r['cache_lifetime_s'])}`,
      `start=${String(r['request_start'])}`,
      `creation=${JSON.stringify(r['cache_creation'])}`,
      `strict=${String(r['request_strict_sent'])}`,
      `prefix_chars=${String(r['prefix_chars'])}`,
      `read=${JSON.stringify(r['cache_read_input_tokens'])}`,
      `write=${JSON.stringify(r['cache_creation_input_tokens'] ?? r['cache_write_tokens'])}`,
    ].join(' ');
  const parts = (r: Record<string, unknown>, against?: Record<string, unknown>): string => {
    const mine = record(r['prefix_parts']) ?? {};
    const theirs = against === undefined ? undefined : (record(against['prefix_parts']) ?? {});
    const keys = [...new Set([...Object.keys(mine), ...Object.keys(theirs ?? {})])];
    const each = keys.map((k) => {
      if (theirs === undefined) return k;
      if (!Object.hasOwn(mine, k)) return `${k}(predecessor only)`;
      if (!Object.hasOwn(theirs, k)) return `${k}(here only)`;
      return `${k}(${mine[k] === theirs[k] ? '=' : '≠'})`;
    });
    return `parts: ${each.join(' ') || 'none'}`;
  };
  return list
    .map((e, i) => {
      const r = record(e);
      if (r === undefined) return `#${i} ${JSON.stringify(e)}`;
      const v = verdicts[i];
      const before =
        v === undefined || !('predecessor' in v)
          ? undefined
          : v.predecessor.from === 'list'
            ? record(list[v.predecessor.at])
            : record(r['reference']);
      const ref = record(r['reference']);
      return (
        `#${i} verdict=${JSON.stringify(v)} ${facts(r)} ${parts(r, before)}` +
        (ref === undefined ? '' : `\n   reference: ${facts(ref)} ${parts(ref)}`)
      );
    })
    .join('\n');
}

/** Anthropic: an earlier request read 0 and wrote 6,897; a request that reads 0 then misses. */
const anthropicWrote: Spec = {
  provider: A,
  asked: 'lifetime',
  read: 0,
  write: 6897,
  strict: false,
};
/** OpenAI before GPT-5.6: an earlier request read 8,000 and reported no write… */
const openaiRead: Spec = { provider: O, asked: 'provider_rules', read: 8000, strict: false };
/** …and a request that read 0 misses by 8,000 under the tolerance. */
const openaiMissed: Spec = { provider: O, asked: 'provider_rules', read: 0, strict: false };

describe('caching 3-M A-2a2 — the cached span, judged on both sides (each against a reference)', () => {
  // An Anthropic single-shot step whose prompt is not split: only the system text is marked, on
  // both. The step's input changed, so the prompt differs, but it was never cached. Can fail: the
  // span ignored (a differing prompt compared anyway) names `prompt`. Prints each entry.
  it('a prompt outside what both asked to be cached is no cause: unexplained', () => {
    const list = againstReference(
      {
        ...anthropicWrote,
        marked: ['system'],
        parts: { tools: 'submit', system: 'profile', prompt: 'input B' },
      },
      {
        ...anthropicWrote,
        marked: ['system'],
        parts: { tools: 'submit', system: 'profile', prompt: 'input A' },
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['unexplained']);
  });

  // An Anthropic split single-shot step (`system` and `prompt` marked on both), after a workflow
  // edit of the text before the step's first placeholder. Can fail: `prompt` left out of the marks
  // that put the prompt inside (unexplained). Prints each entry.
  it('a cached prompt head that differs is named prompt', () => {
    const list = againstReference(
      {
        ...anthropicWrote,
        marked: ['system', 'prompt'],
        prefix_chars: 48,
        parts: { tools: 'submit', system: 'profile', prompt: 'head after the edit' },
      },
      {
        ...anthropicWrote,
        marked: ['system', 'prompt'],
        prefix_chars: 40,
        parts: { tools: 'submit', system: 'profile', prompt: 'head before the edit' },
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['prompt']);
  });

  // A workflow edit put literal text before the step's first placeholder: the earlier drive's head
  // was blank (`prefix_chars: 0`, only `system` marked), this drive's is not (`prompt` marked too).
  // The prompt lies inside on this side only, so it is not compared; the marks differ. Can fail:
  // the span judged on the request only names `prompt`. Prints each entry.
  it('a prompt cached on the request but not on its predecessor is not compared: cache_settings', () => {
    const list = againstReference(
      {
        ...anthropicWrote,
        marked: ['system', 'prompt'],
        prefix_chars: 30,
        parts: { tools: 'submit', system: 'profile', prompt: 'literal head' },
      },
      {
        ...anthropicWrote,
        marked: ['system'],
        prefix_chars: 0,
        parts: { tools: 'submit', system: 'profile', prompt: 'blank head' },
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['cache_settings']);
  });

  // The reverse edit, that literal text removed: the earlier drive's head was not blank, this
  // drive's is. Can fail: the span judged on the predecessor only names `prompt`. Prints each
  // entry.
  it('a prompt cached on the predecessor but not on the request is not compared: cache_settings', () => {
    const list = againstReference(
      {
        ...anthropicWrote,
        marked: ['system'],
        prefix_chars: 0,
        parts: { tools: 'submit', system: 'profile', prompt: 'blank head' },
      },
      {
        ...anthropicWrote,
        marked: ['system', 'prompt'],
        prefix_chars: 30,
        parts: { tools: 'submit', system: 'profile', prompt: 'literal head' },
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['cache_settings']);
  });

  // OpenAI before GPT-5.6 at its own address (`provider_rules`), a split step, the same edit: the
  // earlier drive's blank head sent no key and recorded no marks; this drive's head records `key`.
  // Under `provider_rules` the prompt lies inside on both sides, and both are split, so it is
  // compared, before the settings. Can fail: `provider_rules` left out of the span, or
  // `prefix_chars: 0` read as absent (a truthiness test): each names `cache_settings`. Prints each
  // entry.
  it('under provider_rules a split prompt is compared on both sides, a blank head included: prompt', () => {
    const list = againstReference(
      {
        ...openaiMissed,
        marked: ['key'],
        prefix_chars: 30,
        parts: { system: 'profile', prompt: 'literal head', format: 'json_object' },
      },
      {
        ...openaiRead,
        prefix_chars: 0,
        parts: { system: 'profile', prompt: 'blank head', format: 'json_object' },
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['prompt']);
  });

  // An Anthropic tool step (`system` and `conversation` marked on both). Its reference is an
  // earlier drive's repair opener, whose prompt carries that drive's repair feedback. Can fail:
  // `conversation` left out of the span (unexplained). Prints each entry.
  it("a tool step's prompt differs from an earlier drive's repair opener: prompt", () => {
    const list = againstReference(
      {
        ...anthropicWrote,
        marked: ['system', 'conversation'],
        parts: { tools: 'mcp tools', system: 'profile', prompt: 'input' },
      },
      {
        ...anthropicWrote,
        marked: ['system', 'conversation'],
        parts: { tools: 'mcp tools', system: 'profile', prompt: "input and that drive's feedback" },
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['prompt']);
  });
});

describe("caching 3-M A-2a2 — the prompt's two shapes", () => {
  // Both on a gateway (`endpoint: 'custom'`) under the runner's default, so no key goes out and
  // nothing is marked on either. After a workflow edit the earlier drive's request split its prompt
  // and this one did not: one `prompt` digests a head, the other a whole prompt. Can fail: the shape
  // rule dropped names `prompt`. Prints each entry.
  it('a split prompt and a whole prompt are not compared: unexplained', () => {
    const list = againstReference(
      { ...openaiMissed, endpoint: 'custom', parts: { system: 'profile', prompt: 'whole prompt' } },
      {
        ...openaiRead,
        endpoint: 'custom',
        prefix_chars: 25,
        parts: { system: 'profile', prompt: 'head' },
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['unexplained']);
  });
});

describe('caching 3-M A-2a2 — the parts, in order', () => {
  // Inside one list: an Anthropic tool step whose repair opener (position 2) follows the MCP server
  // listing different tools; its prompt also carries the feedback. Position 1 is the first call's
  // final request (no `cache_requested`). Can fail: the tools check removed (unexplained). Prints
  // each entry.
  it("tools re-listed differently before a repair opener: tools, before the prompt's feedback", () => {
    const conversation = ['system', 'conversation'];
    const list = stored(
      {
        ...anthropicWrote,
        in_call: 0,
        marked: conversation,
        parts: { tools: 'mcp tools, first listing', system: 'profile', prompt: 'input' },
      },
      {
        provider: A,
        in_call: 1,
        read: 6897,
        write: 0,
        strict: false,
        parts: { system: 'profile', prompt: 'input' },
      },
      {
        ...anthropicWrote,
        in_call: 0,
        marked: conversation,
        parts: {
          tools: 'mcp tools, second listing',
          system: 'profile',
          prompt: 'input and feedback',
        },
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual([undefined, undefined, 'tools']);
  });

  // Inside one list: an OpenAI tool step with no `prompt:`, before GPT-5.6 (`provider_rules`, not
  // strict). Call 0 is positions 0–2: two turns and its final request, which sends no tools and
  // reads in full (held). Position 3 is call 1's first request, the repair opener; its predecessor
  // is call 0's first request, which read from the cache and reports no write. The SDK types that
  // field as optional; the captured pre-5.6 answers carry none, but all were cold reads, so this
  // warm shape is built from the type. Only the prompt differs (its feedback). Can fail: a prompt
  // difference inside one list named `prompt`, or the predecessor taken as the entry just before
  // (the final request, with no tools: `tools`). Prints each entry.
  it('inside one list a prompt difference names nothing: unexplained', () => {
    const turn: Parts = {
      tools: 'mcp tools',
      system: 'profile',
      prompt: 'input',
      format: 'json_object',
    };
    const list = stored(
      { ...openaiRead, in_call: 0, read: 4000, parts: turn },
      { ...openaiRead, in_call: 1, read: 5000, parts: turn },
      {
        ...openaiRead,
        in_call: 2,
        read: 5000,
        parts: { system: 'profile', prompt: 'input', format: 'json_object' },
      },
      { ...openaiMissed, in_call: 0, parts: { ...turn, prompt: 'input and feedback' } },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual([
      undefined,
      undefined,
      undefined,
      'unexplained',
    ]);
  });

  // Against a reference after a profile edit: an Anthropic tool step whose reference is an earlier
  // drive's repair opener, so the system text and the prompt both differ. Can fail: the system
  // check removed, or the prompt checked before it (each names `prompt`). Prints each entry.
  it('the system text and the prompt both differ: system', () => {
    const list = againstReference(
      {
        ...anthropicWrote,
        marked: ['system', 'conversation'],
        parts: { tools: 'mcp tools', system: 'profile after the edit', prompt: 'input' },
      },
      {
        ...anthropicWrote,
        marked: ['system', 'conversation'],
        parts: {
          tools: 'mcp tools',
          system: 'profile before the edit',
          prompt: "input and that drive's feedback",
        },
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['system']);
  });

  // Against a reference: the same gateway (`endpoint: 'custom'` on both), reached through
  // `OPENAI_BASE_URL` in drive 1 (JSON mode on) and `--base-url` in drive 2 (off), for a non-strict
  // step: drive 1 sent a format part, drive 2 none. Can fail: the format check removed
  // (unexplained). Prints each entry.
  it('JSON mode moved with --base-url: format', () => {
    const list = againstReference(
      { ...openaiMissed, endpoint: 'custom', parts: { system: 'profile', prompt: 'input' } },
      {
        ...openaiRead,
        endpoint: 'custom',
        parts: { system: 'profile', prompt: 'input', format: 'json_object' },
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['format']);
  });

  // Against a reference after an Anthropic schema and profile edit: the submit tool and the system
  // text both differ. Can fail: the order reversed, or the tools check removed (each names
  // `system`). Prints each entry.
  it('the tools and the system text both differ: tools', () => {
    const list = againstReference(
      {
        ...anthropicWrote,
        marked: ['system'],
        parts: { tools: 'submit, schema 2', system: 'profile 2, schema 2', prompt: 'input' },
      },
      {
        ...anthropicWrote,
        marked: ['system'],
        parts: { tools: 'submit, schema 1', system: 'profile 1, schema 1', prompt: 'input' },
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['tools']);
  });
});

describe('caching 3-M A-2a2 — the cache settings (each against a reference)', () => {
  // OpenAI before GPT-5.6 at its own address, a split step: drive 1 ran under the runner's default
  // and sent the key (`cache_marked: ['key']`); drive 2 ran under `--prompt-cache off`, still
  // `provider_rules`, with no key. Every part is the same. Can fail: the settings check removed
  // (unexplained). Prints each entry.
  it('the key sent in one drive and not the other: cache_settings', () => {
    const split: Parts = { system: 'profile', prompt: 'head', format: 'json_object' };
    const list = againstReference(
      { ...openaiMissed, prefix_chars: 30, parts: split },
      { ...openaiRead, marked: ['key'], prefix_chars: 30, parts: split },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['cache_settings']);
  });

  // Anthropic: drive 1 asked for 5 minutes and drive 2 for 1 hour, with the same marks and parts;
  // only `cache_lifetime_s` differs, and on Anthropic that alone reads in full. Can fail: the
  // lifetime compared (cache_settings). Prints each entry.
  it('a lifetime-only change is no cause: unexplained', () => {
    const split: Spec = {
      ...anthropicWrote,
      marked: ['system', 'prompt'],
      prefix_chars: 30,
      parts: { tools: 'submit', system: 'profile', prompt: 'head' },
    };
    const list = againstReference({ ...split, lifetime_s: 3600 }, { ...split, lifetime_s: 300 });
    expect(cacheMissCauses(list), explain(list)).toEqual(['unexplained']);
  });
});

describe('caching 3-M A-2a2 — only a request that missed gets a cause, and it never throws', () => {
  // An Anthropic tool step that read what it should: the first request has nothing earlier, the
  // second is held, the final asked nothing. The outcomes are checked first, so the cell cannot
  // pass on a list with no held entry. Can fail: a cause minted for a held request. Prints each
  // entry.
  it('a request not compared, held or not asked gets no cause', () => {
    const conversation = ['system', 'conversation'];
    const turn: Parts = { tools: 'mcp tools', system: 'profile', prompt: 'input' };
    const list = stored(
      { ...anthropicWrote, in_call: 0, marked: conversation, parts: turn },
      { ...anthropicWrote, in_call: 1, read: 6897, write: 96, marked: conversation, parts: turn },
      { provider: A, in_call: 2, read: 6993, write: 0, strict: false, parts: turn },
    );
    expect(
      cacheReadVerdicts(list).map((v) => v.outcome),
      explain(list),
    ).toEqual(['not_compared', 'held', 'not_asked']);
    expect(cacheMissCauses(list), explain(list)).toEqual([undefined, undefined, undefined]);
  });

  // A step that called no model has no list. Mapped over `cacheReadVerdicts`, which already gives
  // `[]` there, so removing the array test leaves this green (GROUNDING). Prints the input.
  it('requests that is not an array gives no causes', () => {
    expect(cacheMissCauses(undefined), 'requests: undefined').toEqual([]);
  });

  // A-2a1's check-6 list: entries that are not objects, then an Anthropic call whose second
  // request carries its counts as strings. Can fail: an entry's fields read before its verdict is
  // known to be `missed` (the `null` entry throws). Prints the list and the error, then the causes.
  it('a list from another writer is read without a throw, and nothing in it missed', () => {
    const list: unknown[] = [
      null,
      'a string',
      ['an', 'array'],
      ...stored(
        { provider: A, in_call: 0, asked: 'lifetime', read: 0, write: 6897 },
        { provider: A, in_call: 1, asked: 'lifetime', read: '6897', write: '96' },
      ),
    ];
    expect(() => cacheMissCauses(list), explain(list)).not.toThrow();
    expect(cacheMissCauses(list), explain(list)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe('caching 3-M A-2a2 — correction 1: the rules with no cell of their own', () => {
  const conversation = ['system', 'conversation'];

  // Group 1 (a): a reference with no `prefix_parts`: `provider`, `cache_requested` and the counts
  // only (and no `request_strict_sent`, unset on both sides here). Realm's own drives never make
  // one: the pick of a reference (`lastCallOpenerIn`) takes only a request with `request_in_call`
  // 0, which 0.48.0 did not write, so a 0.48.0 record is never copied. A record another writer
  // made, or an unreleased main build between A-1b and A-0, can be. This pins that the module never
  // throws on one and names the absence. Can fail: the predecessor-side object test removed (it
  // throws reading the parts), or the word changed (`unexplained`). Prints the list and the error,
  // then the cause.
  it('a reference from a record that holds no parts: parts_not_recorded', () => {
    const list = againstReference(
      {
        provider: A,
        asked: 'lifetime',
        read: 0,
        write: 6897,
        marked: ['system'],
        parts: { tools: 'submit', system: 'profile', prompt: 'input' },
      },
      { provider: A, asked: 'lifetime', read: 0, write: 6897 },
    );
    expect(() => cacheMissCauses(list), explain(list)).not.toThrow();
    expect(cacheMissCauses(list), explain(list)).toEqual(['parts_not_recorded']);
  });

  // Group 1 (b): inside one list, a missed request written by another writer, with no
  // `prefix_parts`, after a request that has them. Can fail: the request-side object test removed
  // (it throws reading the parts), or the word changed. Prints the list and the error, then the
  // causes.
  it('a missed request that records no parts: parts_not_recorded', () => {
    const list = stored(
      {
        ...anthropicWrote,
        in_call: 0,
        marked: conversation,
        parts: { tools: 'mcp tools', system: 'profile', prompt: 'input' },
      },
      { ...anthropicWrote, in_call: 1, marked: conversation },
    );
    expect(() => cacheMissCauses(list), explain(list)).not.toThrow();
    expect(cacheMissCauses(list), explain(list)).toEqual([undefined, 'parts_not_recorded']);
  });

  // Group 2: against a reference, an Anthropic tool step whose MCP server listed no tools in one
  // of the two drives: the tools part is on one side only. Can fail: a part missing on one side
  // ignored for the tools (a later cause: unexplained). Prints each entry.
  it.each<[string, Parts, Parts]>([
    [
      'the request sent tools and its reference none',
      { tools: 'mcp tools', system: 'profile', prompt: 'input' },
      { system: 'profile', prompt: 'input' },
    ],
    [
      'its reference sent tools and the request none',
      { system: 'profile', prompt: 'input' },
      { tools: 'mcp tools', system: 'profile', prompt: 'input' },
    ],
  ])('%s: tools', (_label, now, before) => {
    const list = againstReference(
      { ...anthropicWrote, marked: conversation, parts: now },
      { ...anthropicWrote, marked: conversation, parts: before },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['tools']);
  });

  // Group 3: against a reference, an Anthropic tool step (the prompt lies inside on both, neither
  // split) where a workflow edit added the prompt to the step, or removed it: the prompt part is
  // on one side only. Can fail: a part missing on one side ignored for the prompt (unexplained).
  // Prints each entry.
  it.each<[string, Parts, Parts]>([
    [
      'the edit added the prompt',
      { tools: 'mcp tools', system: 'profile', prompt: 'input' },
      { tools: 'mcp tools', system: 'profile' },
    ],
    [
      'the edit removed the prompt',
      { tools: 'mcp tools', system: 'profile' },
      { tools: 'mcp tools', system: 'profile', prompt: 'input' },
    ],
  ])('%s: prompt', (_label, now, before) => {
    const list = againstReference(
      { ...anthropicWrote, marked: conversation, parts: now },
      { ...anthropicWrote, marked: conversation, parts: before },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['prompt']);
  });

  // Group 4 (a): against a reference, OpenAI before GPT-5.6 on a gateway (`provider_rules`, not
  // strict). JSON mode moved with `--base-url` between the drives, so the format part is on the
  // earlier side only, and the prompt also differs (inside on both, neither split). Can fail: the
  // format checked before the prompt (format). Prints each entry.
  it('the format on one side and the prompt different: prompt, before the format', () => {
    const list = againstReference(
      { ...openaiMissed, endpoint: 'custom', parts: { system: 'profile', prompt: 'input B' } },
      {
        ...openaiRead,
        endpoint: 'custom',
        parts: { system: 'profile', prompt: 'input A', format: 'json_object' },
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['prompt']);
  });

  // Group 4 (b): the same move of JSON mode, and a setting stated on the gateway in the earlier
  // drive only, so the key went out there alone; the prompt is the same. Can fail: the cache
  // settings checked before the format (cache_settings). Prints each entry.
  it('the format on one side and the marks different: format, before the cache settings', () => {
    const list = againstReference(
      { ...openaiMissed, endpoint: 'custom', parts: { system: 'profile', prompt: 'input' } },
      {
        ...openaiRead,
        endpoint: 'custom',
        marked: ['key'],
        parts: { system: 'profile', prompt: 'input', format: 'json_object' },
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['format']);
  });
});

describe('caching 3-M A-2a2r — the provider, the address or the model changed', () => {
  // (a) Drive 2 of a single-shot step with an output schema, on another provider: the request on
  // OpenAI at its own address (JSON mode on, a format part); its reference on Anthropic through a
  // gateway (`ANTHROPIC_BASE_URL`), with the submit tool's tools part and no format. Provider,
  // address and model all differ. Can fail: the address checked before the provider
  // (endpoint_changed), or the three checked after the parts (tools). Prints each entry.
  it('another provider: provider_changed, before the address, the model and the parts', () => {
    const list = againstReference(
      { ...openaiMissed, parts: { system: 'profile', prompt: 'input', format: 'json_object' } },
      {
        ...anthropicWrote,
        endpoint: 'custom',
        marked: ['system'],
        parts: { tools: 'submit', system: 'profile', prompt: 'input' },
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['provider_changed']);
  });

  // (b) Drive 2 at another address, OpenAI on both sides: the request at the default address
  // (JSON mode on, a format part); its reference through `--base-url` (no format part, and the
  // gateway names the model its own way). Can fail: the model checked before the address
  // (model_changed), or the three checked after the parts (format). Prints each entry.
  it('another address: endpoint_changed, before the model and the parts', () => {
    const list = againstReference(
      { ...openaiMissed, parts: { system: 'profile', prompt: 'input', format: 'json_object' } },
      {
        ...openaiRead,
        endpoint: 'custom',
        model: 'openai/gpt-5.5',
        parts: { system: 'profile', prompt: 'input' },
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['endpoint_changed']);
  });

  // (c) Inside one list, on a gateway: the second turn was answered by the gateway's fallback
  // model; every part is the same. Can fail: the model check removed (unexplained). Prints each
  // entry.
  it('the gateway answered from another model inside one list: model_changed', () => {
    const turn: Parts = {
      tools: 'mcp tools',
      system: 'profile',
      prompt: 'input',
      format: 'json_object',
    };
    const list = stored(
      { ...openaiRead, endpoint: 'custom', in_call: 0, parts: turn },
      { ...openaiMissed, endpoint: 'custom', in_call: 1, model: 'gpt-5.5-mini', parts: turn },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual([undefined, 'model_changed']);
  });

  // (d) On a gateway, one side records no model and every part is the same: no model word.
  // Absent on the reference: its source's response named no model, and the reference copies
  // `model` only when its source had one. Absent on the request: drive 2's gateway response named
  // none. Can fail: the test on that side dropped (compared when only the other side records it:
  // model_changed). Prints each entry.
  it.each<[string, Spec, Spec]>([
    ['on the reference', {}, { model: null }],
    ['on the request', { model: null }, {}],
  ])('no model recorded %s: unexplained', (_label, nowModel, beforeModel) => {
    const parts: Parts = { system: 'profile', prompt: 'input' };
    const list = againstReference(
      { ...openaiMissed, endpoint: 'custom', parts, ...nowModel },
      { ...openaiRead, endpoint: 'custom', parts, ...beforeModel },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['unexplained']);
  });

  // (e) Drive 2 ran with another `--model`: against a reference with today's shape (parts, marks,
  // strict), the same provider and address, every part the same. Can fail: the model compared only
  // inside one list (unexplained). Prints each entry.
  it('another --model in drive 2: model_changed', () => {
    const parts: Parts = { tools: 'submit', system: 'profile', prompt: 'input' };
    const list = againstReference(
      { ...anthropicWrote, model: 'claude-opus-5-5', marked: ['system'], parts },
      { ...anthropicWrote, marked: ['system'], parts },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['model_changed']);
  });

  // Correction 1: drive 2 ran with another `--model` AND the profile was edited in the same gap,
  // so the system part differs too. The model is checked before every part (design M-D). Can fail:
  // the model check moved after the parts, or after the cache settings (system). Prints each entry.
  it('another --model and a profile edit in the same gap: model_changed, before the system text', () => {
    const list = againstReference(
      {
        ...anthropicWrote,
        model: 'claude-opus-5-5',
        marked: ['system'],
        parts: { tools: 'submit', system: 'profile after the edit', prompt: 'input' },
      },
      {
        ...anthropicWrote,
        marked: ['system'],
        parts: { tools: 'submit', system: 'profile before the edit', prompt: 'input' },
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['model_changed']);
  });
});

describe("caching 3-M A-2a2s — Realm's own changes: the final request, the strict ladder, repair feedback", () => {
  /** The model of the captured GPT-5.6 answers (`plans/issue-896/live-checks/`). */
  const luna = 'gpt-5.6-luna';
  const conversation = ['system', 'conversation'];
  const turn = (tools: string, prompt = 'input'): Parts => ({
    tools,
    system: 'profile',
    prompt,
    format: 'json_object',
  });

  // 1 (a) An OpenAI strict tool step (`structured_output: strict`): turns 0 and 1 send strict tool
  // arguments, then the final request sends no tools and records no strict. Can fail: the strict
  // ladder checked first, or final_request moved after the parts (each gives strict_ladder).
  // Prints each entry.
  it("the final request after a strict tool step's turns: final_request, before the strict ladder", () => {
    const list = stored(
      { ...openaiRead, in_call: 0, read: 0, strict: true, parts: turn('mcp tools') },
      { ...openaiRead, in_call: 1, read: 4000, strict: true, parts: turn('mcp tools') },
      {
        ...openaiMissed,
        in_call: 2,
        strict: false,
        parts: { system: 'profile', prompt: 'input', format: 'json_object' },
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual([undefined, undefined, 'final_request']);
  });

  // 1 (b) A GPT-5.6 single-shot step at OpenAI's own address, asking with a lifetime: its JSON
  // retry is the same call, with no tools on either side and every part the same. Both answers'
  // counts are C1's captured first answer (read 0, wrote 3,930; results-gpt-5.6-luna.json): the
  // provider did not keep the entry, which the record cannot see. Can fail: final_request without
  // its "the earlier request sent tools" test (final_request). Prints each entry.
  it('a single-shot JSON retry, no tools on either side: unexplained, not final_request', () => {
    const shot: Spec = {
      provider: O,
      model: luna,
      asked: 'lifetime',
      read: 0,
      write: 3930,
      strict: false,
      marked: ['system'],
      parts: { system: 'profile', prompt: 'input', format: 'json_object' },
    };
    const list = stored({ ...shot, in_call: 0 }, { ...shot, in_call: 1 });
    expect(cacheMissCauses(list), explain(list)).toEqual([undefined, 'unexplained']);
  });

  // 2 (a) OpenAI's #313 ladder: turn 1 sent strict tool arguments, the endpoint refused them, and
  // turn 2 went without, so its tools part differs too. Can fail: the tools checked before the
  // ladder (tools), or final_request without its "this request sent none" test (final_request).
  // Prints each entry.
  it('strict dropped between two turns of one call: strict_ladder', () => {
    const list = stored(
      { ...openaiRead, in_call: 0, read: 0, strict: true, parts: turn('mcp tools, strict') },
      { ...openaiRead, in_call: 1, read: 4000, strict: true, parts: turn('mcp tools, strict') },
      { ...openaiMissed, in_call: 2, strict: false, parts: turn('mcp tools, not strict') },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual([undefined, undefined, 'strict_ladder']);
  });

  // 2 (b) The same values against a reference, on the same gateway: drive 2 ran through the same
  // `--base-url` without the `--strict-base-url` drive 1 had (strict is lifted only with
  // `--base-url`). The record cannot tell this from Realm's ladder. Can fail: the ladder named
  // across drives (strict_ladder), or the tools checked before it (tools). Prints each entry.
  it('strict sent in the earlier drive and not this one: strict_changed', () => {
    const list = againstReference(
      { ...openaiMissed, endpoint: 'custom', strict: false, parts: turn('mcp tools, not strict') },
      { ...openaiRead, endpoint: 'custom', strict: true, parts: turn('mcp tools, strict') },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['strict_changed']);
  });

  // 2 (c) Strict back on inside one list: an Anthropic tool step whose call 0 met a 503 on its
  // first turn. The refused request left no entry, so call 0's first entry is its retry without
  // strict. A 503 does not arm the sticky drop, so call 1, the repair attempt, sends strict again;
  // its prompt also carries the feedback. Can fail: "differ" read as "true, then false" (tools), or
  // the repair feedback checked before the ladder (repair_feedback). Prints each entry.
  it('strict sent again by the repair attempt: strict_ladder, before the repair feedback', () => {
    const anthropicTurn = (tools: string, prompt = 'input'): Parts => ({
      tools,
      system: 'profile',
      prompt,
    });
    const list = stored(
      {
        ...anthropicWrote,
        in_call: 0,
        strict: false,
        marked: conversation,
        parts: anthropicTurn('mcp tools, not strict'),
      },
      { provider: A, in_call: 1, read: 6897, write: 0 },
      {
        ...anthropicWrote,
        in_call: 0,
        strict: true,
        marked: conversation,
        parts: anthropicTurn('mcp tools, strict', 'input and feedback'),
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual([undefined, undefined, 'strict_ladder']);
  });

  // 2 (d) The same direction against a reference: the first turn of drive 1's last call met the
  // 503 (no strict); drive 2 sent strict. Can fail: "differ" read as "true, then false" (tools).
  // Prints each entry.
  it('strict not sent in the earlier drive and sent in this one: strict_changed', () => {
    const list = againstReference(
      {
        ...anthropicWrote,
        strict: true,
        marked: conversation,
        parts: { tools: 'mcp tools, strict', system: 'profile', prompt: 'input' },
      },
      {
        ...anthropicWrote,
        strict: false,
        marked: conversation,
        parts: { tools: 'mcp tools, not strict', system: 'profile', prompt: 'input' },
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['strict_changed']);
  });

  // 3 (a) An Anthropic tool step: call 0 holds turns 0 and 1 and its final request (no
  // `cache_requested`), then comes call 1's first request, whose prompt carries the repair
  // feedback; the conversation is marked on both. Can fail: the repair feedback check removed (a
  // prompt difference inside one list is then no cause: unexplained). Prints each entry.
  it("a repair opener's feedback under a marked conversation: repair_feedback", () => {
    const parts = (prompt: string): Parts => ({ tools: 'mcp tools', system: 'profile', prompt });
    const list = stored(
      { ...anthropicWrote, in_call: 0, strict: false, marked: conversation, parts: parts('input') },
      {
        ...anthropicWrote,
        in_call: 1,
        read: 6897,
        write: 96,
        strict: false,
        marked: conversation,
        parts: parts('input'),
      },
      { provider: A, in_call: 2, read: 6993, write: 0 },
      {
        ...anthropicWrote,
        in_call: 0,
        strict: false,
        marked: conversation,
        parts: parts('input and feedback'),
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual([
      undefined,
      undefined,
      undefined,
      'repair_feedback',
    ]);
  });

  // 3 (b) A GPT-5.6 tool step with no `prompt:` (unsplit, so its prompt part is the whole prompt),
  // under `provider_rules`: call 0's first request, then its repair opener. Both answers' counts
  // are C9's captured first answer (read 0, wrote 4,012; results-gpt-5.6-luna-C9.json). Can fail:
  // the write branch dropped (unexplained). Prints each entry.
  it("a GPT-5.6 repair opener's feedback after a reported write: repair_feedback", () => {
    const tool: Spec = { provider: O, model: luna, asked: 'provider_rules', strict: false };
    const list = stored(
      { ...tool, in_call: 0, read: 0, write: 4012, parts: turn('mcp tools') },
      { ...tool, in_call: 0, read: 0, write: 4012, parts: turn('mcp tools', 'input and feedback') },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual([undefined, 'repair_feedback']);
  });

  // 3 (c) The same, the earlier request reporting a write of 0: its counts are C1's captured
  // second answer (read 3,930, wrote 0; results-gpt-5.6-luna.json), the repair opener's C9's first
  // (read 0, wrote 4,012). C1 is an explicit-mode capture; a write of 0 under `provider_rules` is
  // INFERRED (an identical re-send; the implicit warm reads captured wrote 82 and 19). Can fail:
  // "reported" read as "wrote more than 0" (unexplained). Prints each entry.
  it('a reported write of 0 is a reported write: repair_feedback', () => {
    const tool: Spec = { provider: O, model: luna, asked: 'provider_rules', strict: false };
    const list = stored(
      { ...tool, in_call: 0, read: 3930, write: 0, parts: turn('mcp tools') },
      { ...tool, in_call: 0, read: 0, write: 4012, parts: turn('mcp tools', 'input and feedback') },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual([undefined, 'repair_feedback']);
  });

  // 3 (d) An Anthropic split single-shot step (`system` and `prompt` marked on both) whose tail has
  // text: call 0's first request, then call 1's, its repair opener. The feedback lands in the tail,
  // so the head's digest is unchanged and every part is the same. Can fail: the repair feedback
  // without its "the digests differ" test (repair_feedback). Prints each entry.
  it('feedback in the tail of a split prompt leaves the head unchanged: unexplained', () => {
    const shot: Spec = {
      ...anthropicWrote,
      write: 3000,
      marked: ['system', 'prompt'],
      prefix_chars: 40,
      parts: { tools: 'submit', system: 'profile', prompt: 'head' },
    };
    const list = stored({ ...shot, in_call: 0 }, { ...shot, in_call: 0 });
    expect(cacheMissCauses(list), explain(list)).toEqual([undefined, 'unexplained']);
  });
});

describe('caching 3-M A-2a3 — possibly expired: the pause and the lifetime the entry was granted', () => {
  const luna = 'gpt-5.6-luna';
  const conversation = ['system', 'conversation'];
  const parts: Parts = { tools: 'submit', system: 'profile', prompt: 'input' };

  /**
   * 1 (a)'s list, inside one list: an Anthropic tool step with `tool_timeout: 60`. Turn 0 wrote
   * with a 5-minute split. Its answer took about two minutes and asked for five tool calls, run one
   * after another, about a minute each (no one MCP call outlives 60 s), so turn 1, stamped when
   * sent, starts 420.25 s later and reads 0. Turn 2 reads what turn 1 wrote (held); the final
   * request asked nothing.
   */
  const toolStep = (): Record<string, unknown>[] => {
    const turn: Spec = {
      ...anthropicWrote,
      marked: conversation,
      parts: { tools: 'mcp tools', system: 'profile', prompt: 'input' },
    };
    return stored(
      { ...turn, in_call: 0, start: '2026-11-08T05:00:00.000Z' },
      { ...turn, in_call: 1, read: 0, write: 7000, start: '2026-11-08T05:07:00.250Z' },
      { ...turn, in_call: 2, read: 7000, write: 50, start: '2026-11-08T05:07:20.000Z' },
      { provider: A, in_call: 3, read: 7050, write: 0, start: '2026-11-08T05:07:40.000Z' },
    );
  };

  // 1 (a) Can fail: expiry judged only against the reference (unexplained), the gap rounded (420),
  // or the asked lifetime read before the split (`asked`). Prints each entry with its start.
  it('a turn 420.25 s after a 5-minute write: possibly_expired, judged on the written 300 s', () => {
    const list = toolStep();
    expect(cacheMissCauses(list)[1], explain(list)).toBe('possibly_expired');
    expect(cacheMissGaps(list)[1], explain(list)).toEqual({
      gap_s: 420.25,
      lifetime_s: 300,
      lifetime_from: 'written',
    });
  });

  // 1 (b) Asked and granted 1 hour: the reference's split shows a 1-hour write; drive 2 started
  // twenty minutes later. Can fail: a 1-hour write read as 300 s, or the gap compared in
  // milliseconds (each gives possibly_expired). Prints each entry.
  it('twenty minutes after a 1-hour write: unexplained, judged on the written 3,600 s', () => {
    const hour: Spec = { ...anthropicWrote, lifetime_s: 3600, marked: ['system'], parts };
    const list = againstReference(
      { ...hour, start: '2026-11-08T05:00:00.000Z' },
      { ...hour, start: '2026-11-08T04:40:00.000Z' },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['unexplained']);
    expect(cacheMissGaps(list), explain(list)).toEqual([
      { gap_s: 1200, lifetime_s: 3600, lifetime_from: 'written' },
    ]);
  });

  // 1 (c) A reference that only read (its split 0 and 0) and asked 5 minutes. Drive 2, ten minutes
  // later, asked 1 hour (`auto` chose the long lifetime this drive: its split a 1-hour write) and
  // read 0. Can fail: a split of 0 and 0 read as "no lifetime" (unexplained) or as `written`, or
  // the lifetime read from the request (3,600: unexplained). Prints each entry.
  it('a reference that only read: possibly_expired, judged on the 300 s it asked for', () => {
    const list = againstReference(
      {
        ...anthropicWrote,
        lifetime_s: 3600,
        marked: ['system'],
        parts,
        start: '2026-11-08T05:00:00.000Z',
      },
      {
        ...anthropicWrote,
        read: 6897,
        write: 0,
        marked: ['system'],
        parts,
        start: '2026-11-08T04:50:00.000Z',
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['possibly_expired']);
    expect(cacheMissGaps(list), explain(list)).toEqual([
      { gap_s: 600, lifetime_s: 300, lifetime_from: 'asked' },
    ]);
  });

  // 1 (d) A GPT-5.6 single-shot step at OpenAI's own address (explicit: `cache_lifetime_s` 1,800,
  // no split). The reference's counts are C1's captured first answer (read 0, wrote 3,930;
  // results-gpt-5.6-luna.json); drive 2, forty-five minutes later, reads 0 and writes 3,930. Can
  // fail: a write without a split read as "no lifetime" (unexplained). Prints each entry.
  it('forty-five minutes after an explicit 30-minute ask: possibly_expired, judged on 1,800 s', () => {
    const explicit: Spec = {
      provider: O,
      model: luna,
      asked: 'lifetime',
      lifetime_s: 1800,
      read: 0,
      write: 3930,
      strict: false,
      marked: ['system'],
      parts: { system: 'profile', prompt: 'input', format: 'json_object' },
    };
    const list = againstReference(
      { ...explicit, start: '2026-11-08T05:00:00.000Z' },
      { ...explicit, start: '2026-11-08T04:15:00.000Z' },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['possibly_expired']);
    expect(cacheMissGaps(list), explain(list)).toEqual([
      { gap_s: 2700, lifetime_s: 1800, lifetime_from: 'asked' },
    ]);
  });

  // 1 (e) A GPT-5.6 tool step (`provider_rules`, so no lifetime recorded). The reference's counts
  // are C9's captured first answer (read 0, wrote 4,012; results-gpt-5.6-luna-C9.json); drive 2,
  // the next day, reads 0 and writes 4,012. Can fail: a lifetime assumed for `provider_rules`
  // (OpenAI's 30 minutes: possibly_expired). Prints each entry.
  it('a day after a provider_rules request: unexplained, with the gap and no lifetime', () => {
    const tool: Spec = {
      provider: O,
      model: luna,
      asked: 'provider_rules',
      read: 0,
      write: 4012,
      strict: false,
      parts: { tools: 'mcp tools', system: 'profile', prompt: 'input', format: 'json_object' },
    };
    const list = againstReference(
      { ...tool, start: '2026-11-08T05:00:00.000Z' },
      { ...tool, start: '2026-11-07T05:00:00.000Z' },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['unexplained']);
    expect(cacheMissGaps(list), explain(list)).toEqual([{ gap_s: 86400 }]);
  });

  // 2 (a) The order: against a reference a day later, an Anthropic step whose prompt edit removed
  // its fixed start. Drive 1 was split (`system` and `prompt` marked), drive 2 is not (`system`
  // only), so the prompt is not compared and the marks differ; the gap still carries the day. Can
  // fail: possibly_expired checked before cache_settings. Prints each entry.
  it('the marks differ a day later: cache_settings, before possibly_expired', () => {
    const list = againstReference(
      {
        ...anthropicWrote,
        marked: ['system'],
        parts: { tools: 'submit', system: 'profile', prompt: 'whole prompt' },
        start: '2026-11-08T05:00:00.000Z',
      },
      {
        ...anthropicWrote,
        marked: ['system', 'prompt'],
        prefix_chars: 40,
        parts: { tools: 'submit', system: 'profile', prompt: 'head' },
        start: '2026-11-07T05:00:00.000Z',
      },
    );
    expect(cacheMissCauses(list), explain(list)).toEqual(['cache_settings']);
    expect(cacheMissGaps(list), explain(list)).toEqual([
      { gap_s: 86400, lifetime_s: 300, lifetime_from: 'written' },
    ]);
  });

  // 3 Only a request that missed carries a gap: 1 (a)'s list, its held turn 2 and its final
  // request (which asked nothing). Can fail: a gap given to every request with a predecessor (the
  // held turn gets one). Prints each entry.
  it('a held request and one that did not ask carry no gap', () => {
    const list = toolStep();
    const gaps = cacheMissGaps(list);
    expect(cacheReadVerdicts(list)[2]?.outcome, explain(list)).toBe('held');
    expect(gaps[2], explain(list)).toBeUndefined();
    expect(gaps[3], explain(list)).toBeUndefined();
  });

  // 3 A step that called no model has no list. GROUNDING: mapped over `cacheReadVerdicts`, which
  // already gives `[]` there.
  it('requests that is not an array gives no gaps', () => {
    expect(cacheMissGaps(undefined), 'requests: undefined').toEqual([]);
  });
});

// Piece C1: a request whose `reference` came from another run. No two-run capture exists (C3M6-30):
// the counts below are real but paired by construction, 4,019 from `anthropic-miss-rule.out`
// (PR3LC-08: wrote 4,019, read 4,019) and 6,897 from `plans/llm-prompt-caching/tools-path/live-899/`
// (its first turn wrote 6,897).
describe('caching 3-M C1 — a request judged against another run', () => {
  /** An Anthropic single-shot step: the one shape on which a prompt's fixed start can be compared. */
  const SINGLE_SHOT: Spec = {
    provider: A,
    asked: 'lifetime',
    marked: ['system', 'prompt'],
    prefix_chars: 900,
    parts: { system: 'profile', prompt: 'head' },
  };
  /** The copy C2 will make of another run's request. */
  const earlierRun = (before: Spec): Record<string, unknown> => ({
    ...referenceOf(before),
    from: 'earlier_run',
  });
  const against = (now: Spec, before: Spec): Record<string, unknown>[] =>
    stored({ ...now, in_call: 0, reference: earlierRun(before) });
  const WROTE: Spec = { ...SINGLE_SHOT, read: 0, write: 4019 };

  // Check 1. Real case: a second run of a single-shot step reads nothing its earlier run wrote. Can
  // fail: the place left as `reference`. Prints the entry and its reference, then the verdict.
  it('a miss names the place earlier_run and the count that run wrote', () => {
    const list = against({ ...SINGLE_SHOT, read: 0, write: 4019 }, WROTE);
    expect(cacheReadVerdicts(list), show(list)).toEqual([
      {
        outcome: 'missed',
        predecessor: { from: 'earlier_run' },
        expected_tokens: 4019,
        shortfall_tokens: 4019,
        rule: 'exact',
      },
    ]);
  });

  // Check 1. Real case: the second run reads all of it. Can fail: as above. Prints the same.
  it('reading all of it holds, with the place earlier_run; the predecessor is the very reference', () => {
    const list = against({ ...SINGLE_SHOT, read: 4019, write: 0 }, WROTE);
    expect(cacheReadVerdicts(list), show(list)).toEqual([
      { outcome: 'held', predecessor: { from: 'earlier_run' } },
    ]);
    expect(cachePredecessor(list, 0), show(list)).toBe(list[0]!['reference']);
  });

  const NOT_COMPARED = [{ outcome: 'not_compared', cause: 'input_in_cached_part' }];
  const CONVERSATION: Spec = { provider: A, asked: 'lifetime', marked: ['conversation'] };
  const OPENAI_RULES: Spec = { provider: O, asked: 'provider_rules' };
  const OPENAI_EXPLICIT: Spec = {
    provider: O,
    asked: 'lifetime',
    lifetime_s: 1800,
    marked: ['prompt'],
  };

  // Check 2. Real case: the cached part holds the run's own input, so a new input always reads less
  // and the line would blame it on every run. Can fail: either shape's test removed; only one side
  // read (the other side's rows); the counts read first (the `held` row). Prints the entry with its
  // reference, then the verdict.
  it.each<[string, Spec, Spec]>([
    [
      "this side conversation: a tool step's first turn after a new input",
      { ...CONVERSATION, read: 0, write: 6897 },
      { ...CONVERSATION, read: 0, write: 6897 },
    ],
    [
      "only the reference conversation: a workflow edit removed the step's tools",
      { ...SINGLE_SHOT, read: 0, write: 4019 },
      { ...CONVERSATION, read: 0, write: 6897 },
    ],
    [
      'this side provider_rules: an OpenAI request',
      { ...OPENAI_RULES, read: 0, write: 4012 },
      { ...OPENAI_EXPLICIT, read: 0, write: 4012 },
    ],
    [
      'only the reference provider_rules: the model moved to GPT-5.6 or later',
      { ...OPENAI_EXPLICIT, read: 0, write: 4012 },
      { ...OPENAI_RULES, read: 0, write: 4012 },
    ],
    [
      'counts that would have held: the same input again',
      { ...CONVERSATION, read: 6897, write: 0 },
      { ...CONVERSATION, read: 0, write: 6897 },
    ],
  ])('%s: not compared', (_label, now, before) => {
    const list = against(now, before);
    expect(cacheReadVerdicts(list), show(list)).toEqual(NOT_COMPARED);
  });

  // Check 3, both boundaries. Real cases: a reference that asked nothing has no bearing; a count the
  // tool step's turn did not report must not hide why it is not compared. Can fail: the check moved
  // before the predecessor search (the first row), or after the counts (the second). Prints the same.
  it('a reference that did not ask stays no_earlier_request, whatever this side caches', () => {
    const list = against(
      { ...CONVERSATION, read: 0, write: 6897 },
      { provider: A, asked: 'off', read: 0, write: 6897 },
    );
    expect(cacheReadVerdicts(list), show(list)).toEqual([
      { outcome: 'not_compared', cause: 'no_earlier_request' },
    ]);
  });
  it('this side caching its input with its read count absent is input_in_cached_part', () => {
    const list = against(
      { ...CONVERSATION, write: 6897 },
      { ...CONVERSATION, read: 0, write: 6897 },
    );
    expect(cacheReadVerdicts(list), show(list)).toEqual(NOT_COMPARED);
  });

  // Check 4. Real case: a re-drive of the same run has the same input, so its turn is still judged.
  // Can fail: the check applied to every reference. Prints the same.
  it('a from: run reference on the same shape is judged as before', () => {
    const list = againstReference(
      { ...CONVERSATION, read: 0, write: 6897 },
      { ...CONVERSATION, read: 0, write: 6897 },
    );
    expect(cacheReadVerdicts(list), show(list)).toEqual([
      {
        outcome: 'missed',
        predecessor: { from: 'reference' },
        expected_tokens: 6897,
        shortfall_tokens: 6897,
        rule: 'exact',
      },
    ]);
  });

  // Check 5. Real cases: a workflow edit that turned strict output on, and one that changed the
  // prompt's fixed start. Can fail: a scope test left reading `from === 'reference'` (the row reads
  // `unexplained`), or the list-only cause named instead. Prints the facts and the cause.
  it('against another run strict output differing is strict_changed, never strict_ladder', () => {
    const list = against({ ...WROTE, strict: true }, { ...WROTE, strict: false });
    expect(cacheMissCauses(list), explain(list)).toEqual(['strict_changed']);
  });
  it('against another run the fixed start differing is prompt, never repair_feedback', () => {
    const list = against({ ...WROTE, parts: { system: 'profile', prompt: 'another head' } }, WROTE);
    expect(cacheMissCauses(list), explain(list)).toEqual(['prompt']);
  });
});

// Piece C3: a reference that records that the step's agent profile changed. No two-run capture exists
// (C3M6-30): the counts are C1's real ones, paired by construction.
describe('caching 3-M C3 — a changed agent profile is named', () => {
  const SINGLE_SHOT: Spec = {
    provider: A,
    asked: 'lifetime',
    marked: ['system', 'prompt'],
    prefix_chars: 900,
    read: 0,
    write: 4019,
    parts: { system: 'profile', prompt: 'head' },
  };
  /** The step's request against the copy of `before`, `from` the given source, with the fact. */
  const withFact = (from: string, now: Spec, before: Spec): Record<string, unknown>[] =>
    stored({
      ...now,
      in_call: 0,
      reference: { ...referenceOf(before), from, agent_profile_changed: true },
    });
  /** The fact, then each part's equality and the cause's facts; never a digest or a prompt. */
  const printed = (list: readonly Record<string, unknown>[]): string =>
    `agent_profile_changed=${String((list[0]!['reference'] as Record<string, unknown>)['agent_profile_changed'])}\n${explain(list)}`;

  // Real case: the workflow's profile was edited between two drives of a run, or two runs. Can fail:
  // the fact ignored (both rows read `system`), or read for one source only (the other row does).
  // Prints the fact, each part's equality and the facts a cause reads.
  it.each(['run', 'earlier_run'])(
    'the system text differs and a `from: %s` reference records the change: agent_profile',
    (from) => {
      const list = withFact(
        from,
        { ...SINGLE_SHOT, parts: { system: 'profile after the edit', prompt: 'head' } },
        SINGLE_SHOT,
      );
      expect(cacheMissCauses(list), printed(list)).toEqual(['agent_profile']);
    },
  );

  // Real case: one edit of a step's schema and its profile on Anthropic; the schema is the answer
  // tool, so `tools` moves too. Can fail: `agent_profile` checked before `tools`. Prints the same.
  it('the tools and the system text both differ, with the fact: tools', () => {
    const list = withFact(
      'earlier_run',
      {
        ...SINGLE_SHOT,
        parts: { tools: 'answer tool after', system: 'profile after', prompt: 'head' },
      },
      { ...SINGLE_SHOT, parts: { tools: 'answer tool before', system: 'profile', prompt: 'head' } },
    );
    expect(cacheMissCauses(list), printed(list)).toEqual(['tools']);
  });
});
