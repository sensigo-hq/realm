// Tests for TokenBucketRateLimiter.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenBucketRateLimiter } from './token-bucket.js';

describe('TokenBucketRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts full — burst tokens available immediately', async () => {
    const bucket = new TokenBucketRateLimiter({ requests_per_second: 1, burst: 3 });
    // First three acquire() calls resolve immediately.
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    // Fourth queues (bucket empty — do not await it here).
    let resolved = false;
    const fourth = bucket.acquire().then(() => {
      resolved = true;
    });
    // Not yet resolved.
    expect(resolved).toBe(false);
    // Advance past one interval (1000ms / 1 rps = 1000ms).
    await vi.advanceTimersByTimeAsync(1000);
    await fourth;
    expect(resolved).toBe(true);
  });

  it('queues when empty — resolves after interval tick', async () => {
    const bucket = new TokenBucketRateLimiter({ requests_per_second: 2, burst: 1 });
    await bucket.acquire(); // consume the single token
    let done = false;
    const p = bucket.acquire().then(() => {
      done = true;
    });
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(500); // intervalMs = 500ms for 2 rps
    await p;
    expect(done).toBe(true);
  });

  it('pause stops refill — no token before resume', async () => {
    let now = 0;
    const bucket = new TokenBucketRateLimiter({ requests_per_second: 10, burst: 1 }, () => now);
    await bucket.acquire(); // empty the bucket
    bucket.pause(1);
    // Advance 500ms — still paused.
    await vi.advanceTimersByTimeAsync(500);
    now = 500;
    let midDone = false;
    bucket.acquire().then(() => {
      midDone = true;
    });
    await Promise.resolve();
    expect(midDone).toBe(false);
  });

  it('MAX semantics — shorter pause does not override longer pause', async () => {
    let now = 0;
    const bucket = new TokenBucketRateLimiter({ requests_per_second: 10, burst: 1 }, () => now);
    await bucket.acquire(); // empty the bucket
    bucket.pause(10); // 10-second pause
    now = 100;
    bucket.pause(5); // shorter — must not shorten the first
    // Advance 5000ms — should still be paused (10s pause set first).
    let resolved = false;
    bucket.acquire().then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(5000);
    now = 5000;
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it('resume serves waiting retry with exactly 1 token', async () => {
    let now = 0;
    const bucket = new TokenBucketRateLimiter({ requests_per_second: 1, burst: 3 }, () => now);
    // Drain all 3 tokens.
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    // Queue a waiter.
    let waiterResolved = false;
    const waiter = bucket.acquire().then(() => {
      waiterResolved = true;
    });
    // Pause for 1 second.
    now = 0;
    bucket.pause(1);
    expect(waiterResolved).toBe(false);
    // Advance to resume.
    await vi.advanceTimersByTimeAsync(1000);
    now = 1000;
    await waiter;
    expect(waiterResolved).toBe(true);
  });

  it('resume sets exactly 1 token — not burst capacity', async () => {
    let now = 0;
    const bucket = new TokenBucketRateLimiter({ requests_per_second: 1, burst: 5 }, () => now);
    // Drain all tokens.
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    // Pause and resume.
    bucket.pause(1);
    await vi.advanceTimersByTimeAsync(1000);
    now = 1000;
    await Promise.resolve();
    // Only 1 token available on resume — second immediate acquire should queue.
    await bucket.acquire(); // consumes the 1 resume token
    let secondDone = false;
    bucket.acquire().then(() => {
      secondDone = true;
    });
    await Promise.resolve();
    expect(secondDone).toBe(false); // no token yet
    // After one interval tick, the next token arrives.
    await vi.advanceTimersByTimeAsync(1000);
    now = 2000;
    await Promise.resolve();
    expect(secondDone).toBe(true);
  });

  it('AbortSignal already aborted — acquire rejects immediately with STEP_ABORTED', async () => {
    const bucket = new TokenBucketRateLimiter({ requests_per_second: 1, burst: 1 });
    await bucket.acquire(); // empty the bucket
    const controller = new AbortController();
    controller.abort();
    await expect(bucket.acquire(controller.signal)).rejects.toMatchObject({
      code: 'STEP_ABORTED',
      retryable: false,
    });
  });

  it('AbortSignal fires while waiting — waiter rejects and is removed from queue', async () => {
    const bucket = new TokenBucketRateLimiter({ requests_per_second: 1, burst: 1 });
    await bucket.acquire(); // empty the bucket
    const controller = new AbortController();
    const p = bucket.acquire(controller.signal);
    controller.abort();
    await expect(p).rejects.toMatchObject({ code: 'STEP_ABORTED' });
  });

  it('AbortSignal fires after resolve — settled guard prevents double settlement', async () => {
    const bucket = new TokenBucketRateLimiter({ requests_per_second: 2, burst: 1 });
    await bucket.acquire(); // empty the bucket
    const controller = new AbortController();
    const p = bucket.acquire(controller.signal);
    // Advance timers so the interval tick resolves the waiter first.
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    // Now fire the abort signal — waiter already settled, should not cause rejection.
    controller.abort();
    await expect(p).resolves.toBeUndefined();
  });
});
