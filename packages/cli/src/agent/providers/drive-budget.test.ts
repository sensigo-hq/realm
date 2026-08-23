// drive-budget.test.ts — issue #401 PR-2: the per-create ceiling, the wire counters, and the
// attribution a fired bound carries. The units here never touch a socket except where the point
// IS the socket (the ceiling-kills-the-sleep cell at the bottom).
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import {
  deriveLlmClock,
  makeCountingFetch,
  driveCreate,
  attachDriveCall,
  safeErrorText,
  MAX_RETRIES,
  type WireCounters,
} from './agent-utils.js';

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
    const declared = sources.join('\n').match(/maxRetries: MAX_RETRIES/g) ?? [];
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

  it('fires DURING an honored Retry-After sleep and says so', async () => {
    // A 429 with `retry-after-ms: 250` and one retry allowed: the fetch layer honors the sleep,
    // so nothing is on the wire when the 100ms ceiling fires. This is the class the bound exists
    // for — waiting is not the same as progress.
    server = createServer((_req, res) => {
      res.writeHead(429, { 'retry-after-ms': '250', 'content-type': 'application/json' });
      res.end('{"error":{"message":"slow down"}}');
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    const counters: WireCounters = { attempts: 0 };
    const countingFetch = makeCountingFetch(counters);

    // The loser's rejection lands after the race is decided. Unobserved it would take the process
    // down — the trap proves the no-op `.catch` in driveCreate is doing its job, and it lives in
    // this cell because this is the only place the loser is guaranteed to reject late.
    const unhandled: unknown[] = [];
    const trap = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on('unhandledRejection', trap);

    const started = Date.now();
    const err = await driveCreate(
      async (_b, o) => {
        const res = await countingFetch(`http://127.0.0.1:${String(port)}/v1/messages`, {
          method: 'POST',
          body: JSON.stringify(_b),
          signal: o['signal'] as AbortSignal,
        });
        if (!res.ok) {
          const wait = Number(res.headers.get('retry-after-ms') ?? 0);
          await new Promise((r) => setTimeout(r, wait)); // the honored sleep
          throw Object.assign(new Error('rate limited'), { status: res.status });
        }
        return {};
      },
      { model: 'm' },
      { ceilingMs: 100, declaredPerAttemptMs: 40 },
      counters,
    ).catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    expect(payloadOf(err)?.error_class).toBe('aborted_by_budget');
    expect(payloadOf(err)?.last_observed_status).toBe(429);
    expect(payloadOf(err)?.retry_after_observed_ms).toBe(250);
    // Raced, not awaited: the whole cell returns near the ceiling, not after the 250ms sleep.
    expect(elapsed).toBeLessThan(220);

    await new Promise((r) => setTimeout(r, 300)); // let the loser reject, in-cell
    process.off('unhandledRejection', trap);
    expect(unhandled).toEqual([]);
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
