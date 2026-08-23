// drive-budget.test.ts — issue #401 PR-2: the per-create ceiling, the wire counters, and the
// attribution a fired bound carries. The units here never touch a socket except where the point
// IS the socket (the ceiling-kills-the-sleep cell at the bottom).
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  deriveLlmClock,
  makeCountingFetch,
  driveCreate,
  attachDriveCall,
  safeErrorText,
  MAX_RETRIES,
  type WireCounters,
} from './agent-utils.js';
import { buildEntry } from '../drive-failure.js';

// -------------------------------------------------------------------------------------------
// The ceiling arithmetic
// -------------------------------------------------------------------------------------------
describe('deriveLlmClock — the per-attempt value becomes a whole-create ceiling', () => {
  it('the DEFAULT 600s per attempt derives 1,861,500ms', () => {
    // 600s × 3 attempts + 1.5s of un-jittered SDK backoff + a 60s download allowance.
    const clock = deriveLlmClock(600_000);
    expect(clock.ceilingMs).toBe(1_861_500);
    expect(clock.declaredPerAttemptMs).toBe(600_000);
  });

  it('an AUTHORED 30s scales the attempt term and nothing else', () => {
    // Only the attempt term moves: 30s × 3 = 90s, plus the same 1.5s + 60s that do not depend on
    // the per-attempt value at all.
    expect(deriveLlmClock(30_000).ceilingMs).toBe(151_500);
  });

  it('the formula is driven BY MAX_RETRIES — not by a hardcoded 3', () => {
    // Recomputed from the constant itself: if someone changes MAX_RETRIES, this cell follows,
    // and the source cell below proves the SDK clients were changed with it.
    let backoff = 0;
    for (let n = 0; n < MAX_RETRIES; n++) backoff += Math.min(0.5 * 2 ** n, 8) * 1000;
    expect(deriveLlmClock(30_000).ceilingMs).toBe(30_000 * (MAX_RETRIES + 1) + backoff + 60_000);
  });

  it('every SDK client is constructed with the SAME MAX_RETRIES the formula uses', () => {
    // The ceiling is only honest if the client really makes that many attempts. Source-text,
    // because the claim is about how the clients are BUILT — six constructor sites across three
    // provider files, all of which must move together with the constant.
    const sources = [
      'src/agent/providers/anthropic-provider.ts',
      'src/agent/providers/openai-provider.ts',
      'src/agent/providers/openai-reasoning-provider.ts',
    ].map((f) => readFileSync(f, 'utf8'));
    // Anchored on the trailing comma: without it the matcher also accepts a site written
    // `maxRetries: MAX_RETRIES + 1`, which is a DIFFERENT number of attempts than the formula
    // budgets for and would pass a census that was supposed to catch exactly that.
    const declared = sources.join('\n').match(/maxRetries: MAX_RETRIES,/g) ?? [];
    expect(declared).toHaveLength(6);
    // Non-vacuity: the matcher finds nothing if someone inlines a literal instead.
    expect(sources.join('\n')).not.toMatch(/maxRetries:\s*\d/);
  });
});

// -------------------------------------------------------------------------------------------
// The counting fetch
// -------------------------------------------------------------------------------------------
describe('makeCountingFetch — what the SDK ladder did, observed from outside it', () => {
  const req = new Request('https://example.invalid/v1/messages');

  it('counts every attempt and remembers the LAST status across creates on one client', async () => {
    const counters: WireCounters = { attempts: 0 };
    let call = 0;
    const fetch = makeCountingFetch(counters, async () => {
      call += 1;
      return new Response('{}', { status: call === 1 ? 500 : 200 });
    });
    await fetch(req);
    await fetch(req);
    expect(counters.attempts).toBe(2);
    expect(counters.lastStatus).toBe(200);
  });

  it('reads BOTH Retry-After forms, preferring the millisecond one', async () => {
    const secs: WireCounters = { attempts: 0 };
    await makeCountingFetch(
      secs,
      async () => new Response('', { status: 429, headers: { 'Retry-After': '7200' } }),
    )(req);
    expect(secs.lastRetryAfterMs).toBe(7_200_000);

    const ms: WireCounters = { attempts: 0 };
    await makeCountingFetch(
      ms,
      async () => new Response('', { status: 429, headers: { 'retry-after-ms': '250' } }),
    )(req);
    expect(ms.lastRetryAfterMs).toBe(250);

    // Both present: the precise form wins, never the rounded seconds.
    const both: WireCounters = { attempts: 0 };
    await makeCountingFetch(
      both,
      async () =>
        new Response('', {
          status: 429,
          headers: { 'Retry-After': '7200', 'retry-after-ms': '250' },
        }),
    )(req);
    expect(both.lastRetryAfterMs).toBe(250);
  });

  it('a REJECTED attempt still counts, and leaves the status observation alone', async () => {
    const counters: WireCounters = { attempts: 0, lastStatus: 500 };
    const fetch = makeCountingFetch(counters, async () => {
      throw new Error('ECONNRESET');
    });
    await expect(fetch(req)).rejects.toThrow('ECONNRESET');
    expect(counters.attempts).toBe(1);
    // Not overwritten with a fabricated value, and not silently carried forward as "this one's".
    expect(counters.lastStatus).toBe(500);
  });
});

// -------------------------------------------------------------------------------------------
// driveCreate — the bound and its attribution
// -------------------------------------------------------------------------------------------
interface Payload {
  error_class?: string;
  attempts_sdk?: number;
  elapsed_ms?: number;
  last_observed_status?: number;
  retry_after_observed_ms?: number;
  declared_per_attempt_ms?: number;
  derived_ceiling_ms?: number;
}
const payloadOf = (err: unknown): Payload | undefined =>
  (err as { driveCall?: Payload } | null)?.driveCall;

describe('driveCreate — no single model request holds the drive hostage', () => {
  it('returns the response untouched when the create finishes inside the ceiling', async () => {
    const counters: WireCounters = { attempts: 0 };
    const out = await driveCreate(
      async () => ({ ok: true }),
      { model: 'm' },
      { ceilingMs: 1_000, declaredPerAttemptMs: 300 },
      counters,
    );
    expect(out).toEqual({ ok: true });
  });

  it('passes an abort signal into the create — the SDK gets a chance to stop', async () => {
    const counters: WireCounters = { attempts: 0 };
    let seen: unknown;
    await driveCreate(
      async (_b, o) => {
        seen = o['signal'];
        return {};
      },
      {},
      { ceilingMs: 1_000 },
      counters,
    );
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it('a fired ceiling names the LEVER, in both of its spellings', async () => {
    const counters: WireCounters = { attempts: 1, lastStatus: 429 };
    const err = await driveCreate(
      () => new Promise(() => undefined), // never settles
      {},
      { ceilingMs: 30, declaredPerAttemptMs: 10 },
      counters,
    ).catch((e: unknown) => e);

    // The operator reading this line must not have to go looking for what to change.
    expect((err as Error).message).toContain('llm_timeout_seconds');
    expect((err as Error).message).toContain('--llm-timeout');
    expect((err as Error).message).toContain('30ms');

    const p = payloadOf(err);
    expect(p?.error_class).toBe('aborted_by_budget');
    expect(p?.declared_per_attempt_ms).toBe(10);
    expect(p?.derived_ceiling_ms).toBe(30);
    expect(typeof p?.elapsed_ms).toBe('number');
  });

  it('an SDK-raised error keeps its identity and gains the shape-classified payload', async () => {
    const counters: WireCounters = { attempts: 0 };
    const original = Object.assign(new Error('socket died'), { name: 'APIConnectionError' });
    const thrown = await driveCreate(
      async () => {
        counters.attempts = 1;
        throw original;
      },
      {},
      { ceilingMs: 5_000, declaredPerAttemptMs: 1_000 },
      counters,
    ).catch((e: unknown) => e);

    expect(thrown).toBe(original); // the original error, never a replacement
    expect(payloadOf(thrown)?.error_class).toBe('connection_error');
    expect(payloadOf(thrown)?.attempts_sdk).toBe(1);
  });

  it('never re-attributes an error that already carries a payload', async () => {
    // getClient's sdk_missing attach is the real case: it happens OUTSIDE this wrapper, and a
    // second attach here would relabel a missing package as a network shape.
    const counters: WireCounters = { attempts: 0 };
    const err = Object.assign(new Error('no sdk'), {
      driveCall: { error_class: 'sdk_missing', attempts_sdk: 0, elapsed_ms: 0 },
    });
    const thrown = await driveCreate(
      async () => {
        throw err;
      },
      {},
      { ceilingMs: 5_000 },
      counters,
    ).catch((e: unknown) => e);
    expect(payloadOf(thrown)?.error_class).toBe('sdk_missing');
  });

  it('STALE-OBSERVATION POLARITY — create 2 never inherits create 1s status', async () => {
    // One client, two creates. The first sees a 429 with a Retry-After; the second dies on the
    // wire with nothing to observe. If the delta snapshot were dropped, the second failure would
    // confidently report a rate limit that belonged to the first.
    const counters: WireCounters = { attempts: 0 };
    const clock = { ceilingMs: 5_000, declaredPerAttemptMs: 1_000 };

    const first = await driveCreate(
      async () => {
        counters.attempts += 1;
        counters.lastStatus = 429;
        counters.lastRetryAfterMs = 7_200_000;
        throw Object.assign(new Error('rate limited'), { status: 429 });
      },
      {},
      clock,
      counters,
    ).catch((e: unknown) => e);
    expect(payloadOf(first)?.last_observed_status).toBe(429);
    expect(payloadOf(first)?.retry_after_observed_ms).toBe(7_200_000);

    const second = await driveCreate(
      async () => {
        counters.attempts += 1; // a rejection: no status, no headers
        throw Object.assign(new Error('ECONNRESET'), { name: 'APIConnectionError' });
      },
      {},
      clock,
      counters,
    ).catch((e: unknown) => e);

    expect(payloadOf(second)?.error_class).toBe('connection_error');
    expect(payloadOf(second)?.last_observed_status).toBeUndefined();
    expect(payloadOf(second)?.retry_after_observed_ms).toBeUndefined();
    expect(payloadOf(second)?.attempts_sdk).toBe(1); // this create's attempt only, not 2
  });
});

describe('attachDriveCall / safeErrorText — the small totalities', () => {
  it('attach is a no-op on a non-object throw', () => {
    expect(() => {
      attachDriveCall('a string', { error_class: 'other' });
    }).not.toThrow();
  });

  it('safeErrorText survives a poisoned toString', () => {
    const hostile = {
      toString(): string {
        throw new Error('poisoned');
      },
    };
    expect(safeErrorText(hostile)).toBe('unrenderable thrown value');
    expect(safeErrorText(new Error('plain'))).toBe('plain');
  });
});

// -------------------------------------------------------------------------------------------
// LEG B — the ceiling kills a sleep the SDK is honoring. Real socket, real timer.
// -------------------------------------------------------------------------------------------
describe('the ceiling outranks a server-directed sleep (issue #401 leg B)', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('fires DURING an honored Retry-After sleep, and stops the retry that was coming', async () => {
    // The REAL Anthropic client, against a real 429. Hand-rolling the sleep here would have been
    // testing my own understanding of the SDK rather than the SDK — and the honoring agent is the
    // SDK's retry ladder, not the fetch layer, which is precisely the thing worth pinning.
    //
    // 429 + `retry-after-ms: 250` and one retry allowed: the SDK sleeps, so nothing is on the
    // wire when the 100ms ceiling fires. This is the class the bound exists for — waiting is not
    // progress.
    server = createServer((_req, res) => {
      res.writeHead(429, { 'retry-after-ms': '250', 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}');
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    const counters: WireCounters = { attempts: 0 };
    const client = new Anthropic({
      apiKey: 'sk-ant-test-drive-budget-0000',
      baseURL: `http://127.0.0.1:${String(port)}`,
      maxRetries: 1,
      fetch: makeCountingFetch(counters),
    });
    // Casts because driveCreate is Record-typed at its boundary — it bounds ANY create, and does
    // not know one SDK's request type from another's.
    const rawCreate = (b: Record<string, unknown>, o: Record<string, unknown>): Promise<unknown> =>
      client.messages.create(b as never, o as never);

    // The loser's rejection lands after the race is decided, and this is the only place it is
    // guaranteed to reject LATE — so the trap is the regression sentinel for the whole class.
    // What it does NOT prove is that driveCreate's no-op `.catch` lines are load-bearing:
    // `Promise.race` is already subscribed to both promises, and probing those lines away leaves
    // this cell green. Verified, and said plainly, because a trap that silently proves nothing is
    // worse than no trap.
    const unhandled: unknown[] = [];
    const trap = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on('unhandledRejection', trap);

    const started = Date.now();
    const err = await driveCreate(
      rawCreate,
      { model: 'claude-x', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      { ceilingMs: 100, declaredPerAttemptMs: 40 },
      counters,
    ).catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    expect(payloadOf(err)?.error_class).toBe('aborted_by_budget');
    expect(payloadOf(err)?.last_observed_status).toBe(429);
    expect(payloadOf(err)?.retry_after_observed_ms).toBe(250);
    // Raced, not awaited: the whole thing returns near the ceiling, not after the 250ms sleep.
    expect(elapsed).toBeLessThan(220);

    await new Promise((r) => setTimeout(r, 400)); // let the loser settle, in-cell
    process.off('unhandledRejection', trap);
    expect(unhandled).toEqual([]);
    // A4-2, executed: the SDK's backoff sleep is not itself interruptible, but the abort stops
    // the retry at the next check — so the second attempt never reaches the wire. One attempt,
    // counted, long after the sleep would have ended.
    expect(counters.attempts).toBe(1);
  });

  it('a hanging response is aborted by the signal, and the attempt is still counted', async () => {
    // Headers sent, body never finished — the post-header hang the SDK's own timeout cannot see.
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"partial":');
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    const counters: WireCounters = { attempts: 0 };
    const countingFetch = makeCountingFetch(counters);
    const err = await driveCreate(
      async (_b, o) => {
        const res = await countingFetch(`http://127.0.0.1:${String(port)}/v1/messages`, {
          signal: o['signal'] as AbortSignal,
        });
        return (await res.json()) as unknown;
      },
      {},
      { ceilingMs: 120, declaredPerAttemptMs: 40 },
      counters,
    ).catch((e: unknown) => e);

    expect(payloadOf(err)?.error_class).toBe('aborted_by_budget');
    expect(counters.attempts).toBe(1);
    expect(counters.lastStatus).toBe(200); // headers arrived; the body never did
  });
});

// -------------------------------------------------------------------------------------------
// K1 — an observation belongs to the create that made it, INCLUDING when it repeats
// -------------------------------------------------------------------------------------------
describe('driveCreate — a repeated status is still THIS creates status', () => {
  it('two consecutive 429s both carry the status AND the Retry-After', async () => {
    // The delta snapshot answers "did this create observe something?" by comparing against the
    // previous create's value — which silently means a SECOND identical 429 looks like nothing
    // was observed at all. A rate-limit storm is exactly a run of identical statuses, so the
    // discriminator disappears at the moment it matters most. Both fields are checked here
    // because a half-fix that resets only the status reds this cell on the Retry-After.
    const counters: WireCounters = { attempts: 0 };
    const clock = { ceilingMs: 5_000, declaredPerAttemptMs: 1_000 };
    const rateLimited = async (): Promise<never> => {
      counters.attempts += 1;
      counters.lastStatus = 429;
      counters.lastRetryAfterMs = 250;
      throw Object.assign(new Error('rate limited'), { status: 429 });
    };

    const first = await driveCreate(rateLimited, {}, clock, counters).catch((e: unknown) => e);
    const second = await driveCreate(rateLimited, {}, clock, counters).catch((e: unknown) => e);

    expect(payloadOf(first)?.last_observed_status).toBe(429);
    expect(payloadOf(first)?.retry_after_observed_ms).toBe(250);
    expect(payloadOf(second)?.last_observed_status).toBe(429);
    expect(payloadOf(second)?.retry_after_observed_ms).toBe(250);
    // The attempt count is still a DELTA — it is a running total, not an observation.
    expect(payloadOf(second)?.attempts_sdk).toBe(1);
  });
});

// -------------------------------------------------------------------------------------------
// attachDriveCall is TOTAL — enrichment never replaces the error being attributed
// -------------------------------------------------------------------------------------------
describe('attachDriveCall — the last untotal link in the attribution chain', () => {
  it('a FROZEN error survives: the original propagates, unattributed but intact', async () => {
    // Assigning to a frozen object throws in strict mode. Before this was total, a frozen thrown
    // value came back to the caller as the attacher's own TypeError — the operator's failure
    // replaced by the recording machinery's.
    const counters: WireCounters = { attempts: 0 };
    const frozen = Object.freeze(Object.assign(new Error('frozen failure'), { status: 503 }));
    const thrown = await driveCreate(
      async () => {
        throw frozen;
      },
      {},
      { ceilingMs: 5_000 },
      counters,
    ).catch((e: unknown) => e);

    expect(thrown).toBe(frozen);
    expect(payloadOf(thrown)).toBeUndefined();
    // And it still classifies, because shape classification never needed the payload.
    expect(buildEntry(thrown, 's', 'anthropic', Date.now()).error_class).toBe('api_status');
  });

  it('a proxy whose `has` trap throws survives the same way', () => {
    const hostile = new Proxy(new Error('trapped'), {
      has(): boolean {
        throw new Error('has trap');
      },
    });
    expect(() => {
      attachDriveCall(hostile, { error_class: 'other' });
    }).not.toThrow();
  });

  it('CONTROL — a getter-only driveCall is left alone, not overwritten', () => {
    const err = Object.defineProperty(new Error('x'), 'driveCall', {
      get: () => ({ error_class: 'sdk_missing' }),
      configurable: true,
    });
    attachDriveCall(err, { error_class: 'other' });
    expect((err as unknown as { driveCall: { error_class: string } }).driveCall.error_class).toBe(
      'sdk_missing',
    );
  });
});

// -------------------------------------------------------------------------------------------
// The lever a fired ceiling names is the one that is LIVE
// -------------------------------------------------------------------------------------------
describe('driveCreate — the abort names the live lever, not every lever', () => {
  const fire = async (source?: 'step' | 'flag' | 'default'): Promise<string> => {
    const err = await driveCreate(
      () => new Promise(() => undefined),
      {},
      {
        ceilingMs: 20,
        declaredPerAttemptMs: 10,
        ...(source !== undefined ? { perAttemptSource: source } : {}),
      },
      { attempts: 0 },
    ).catch((e: unknown) => e);
    return (err as Error).message;
  };

  it('a step-authored clock names the STEP key only', async () => {
    // Telling someone to raise a flag their own step key overrides sends them to change
    // something that cannot have any effect.
    const message = await fire('step');
    expect(message).toContain('raise llm_timeout_seconds on the step');
    expect(message).not.toContain('--llm-timeout');
  });

  it('a flag-sourced clock names the FLAG only', async () => {
    const message = await fire('flag');
    expect(message).toContain('--llm-timeout');
    expect(message).not.toContain('llm_timeout_seconds on the step');
  });

  it('a default-sourced clock names the FLAG — it is the live lever when nothing was authored', async () => {
    const message = await fire('default');
    expect(message).toContain('--llm-timeout');
    expect(message).not.toContain('llm_timeout_seconds on the step');
  });

  it('a clock with NO provenance names BOTH — either could be live', async () => {
    // This is also why the lever cells elsewhere in the suite stayed green when the fork landed:
    // green-as-is was probed pre-fork, and under the fork these cells stay green because a
    // source-less clock renders both arms.
    const message = await fire();
    expect(message).toContain('raise llm_timeout_seconds on the step');
    expect(message).toContain('--llm-timeout');
  });
});

// -------------------------------------------------------------------------------------------
// The clamp — a huge budget must not invert into an instant abort
// -------------------------------------------------------------------------------------------
describe('deriveLlmClock — both timers are clamped to what a timer can hold', () => {
  const MAX = 2 ** 31 - 1;

  it('a huge per-attempt value, and Infinity, both land exactly on the limit', () => {
    // Past 2^31-1 a setTimeout overflows and fires almost immediately, so an unclamped huge
    // budget becomes the opposite of what was asked for. Infinity is reachable from real input:
    // `Number.isInteger(1e305)` is true, so the loader accepts it and x1000 overflows to
    // Infinity. Math.min absorbs both cases.
    expect(deriveLlmClock(9_999_999_999_999).ceilingMs).toBe(MAX);
    expect(deriveLlmClock(Number.POSITIVE_INFINITY).ceilingMs).toBe(MAX);
  });

  it('the DECLARED value is the clamped one — the record says what actually bounds the attempt', () => {
    // Recording the raw request would have the record claim a bound that no timer can hold, and
    // the SDK's own `timeout` gets this same clamped number, so the two agree.
    expect(deriveLlmClock(9_999_999_999_999).declaredPerAttemptMs).toBe(MAX);
  });

  it('INVERSION PIN — a create under a huge clock RESOLVES rather than aborting instantly', async () => {
    // The discriminating cell, and the 20ms is load-bearing. Node clamps an over-range setTimeout
    // delay to ONE MILLISECOND, so unclamped this "effectively forever" budget fires the ceiling
    // almost at once and turns into a budget of nothing. A create that resolves in the same
    // microtask would beat even that timer and prove nothing — probed, and it did exactly that.
    const out = await driveCreate(
      async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { ok: true };
      },
      {},
      deriveLlmClock(9_999_999_999_999),
      { attempts: 0 },
    );
    expect(out).toEqual({ ok: true });
  });
});

// -------------------------------------------------------------------------------------------
// Retry-After — all three legal forms
// -------------------------------------------------------------------------------------------
describe('makeCountingFetch — the HTTP-date Retry-After form', () => {
  const req = new Request('https://example.invalid/v1/messages');
  const observe = async (value: string): Promise<number | undefined> => {
    const counters: WireCounters = { attempts: 0 };
    await makeCountingFetch(
      counters,
      async () => new Response('', { status: 429, headers: { 'Retry-After': value } }),
    )(req);
    return counters.lastRetryAfterMs;
  };

  it('a FUTURE date is observed as the delta from now', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00Z'));
    try {
      // Two minutes out. The SDKs honour this form, so a parser that only read numbers dropped a
      // whole legal header on the floor and recorded nothing for an obvious rate limit.
      const observed = await observe('Sun, 23 Aug 2026 12:02:00 GMT');
      expect(observed).toBe(120_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a PAST date is observed as 0 — the wait is over, not negative', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00Z'));
    try {
      expect(await observe('Sun, 23 Aug 2026 11:58:00 GMT')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an UNPARSEABLE header is observed as nothing at all — never a fabricated zero', async () => {
    // Zero would claim the server asked for no wait. Absence says the truth: realm has no idea
    // what was asked for.
    expect(await observe('whenever you feel like it')).toBeUndefined();
  });
});

describe('attempts_sdk counts what the wrapper SAW COMPLETE', () => {
  it('a pre-header hang records 0 attempts, truthfully', async () => {
    // An attempt still in flight when the ceiling fired is not a completed attempt, and the
    // wrapper does not count it. Zero is the honest number: nothing came back. The render says
    // "attempt 0", which reads oddly for exactly one second and then reads correctly — an
    // operator seeing it knows nothing ever completed, which is the whole diagnosis.
    const counters: WireCounters = { attempts: 0 };
    const err = await driveCreate(
      () => new Promise(() => undefined),
      {},
      { ceilingMs: 25, declaredPerAttemptMs: 10 },
      counters,
    ).catch((e: unknown) => e);
    expect(payloadOf(err)?.attempts_sdk).toBe(0);
    expect(payloadOf(err)?.last_observed_status).toBeUndefined();
  });
});
