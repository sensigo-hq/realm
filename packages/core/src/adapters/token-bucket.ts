// Token-bucket rate limiter implementation.
import { WorkflowError } from '../types/workflow-error.js';
import type { RateLimiter } from './rate-limiter.js';

interface Waiter {
  resolve: () => void;
  cancel: () => void;
}

/**
 * Token-bucket rate limiter.
 *
 * Starts full (burst tokens). Refills at one token per intervalMs.
 * `pause()` stops refill and drains tokens; on resume, exactly 1 token is
 * issued immediately and the refill timer restarts.
 */
export class TokenBucketRateLimiter implements RateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly intervalMs: number;
  private refillTimer: ReturnType<typeof setInterval> | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeAt = 0;
  private readonly waiters: Waiter[] = [];
  private readonly now: () => number;

  constructor(config: { requests_per_second: number; burst: number }, now?: () => number) {
    this.capacity = config.burst;
    this.tokens = config.burst;
    this.intervalMs = 1000 / config.requests_per_second;
    this.now = now ?? (() => Date.now());
    this.startRefill();
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (this.tokens > 0) {
      this.tokens--;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      if (signal !== undefined && signal.aborted) {
        reject(makeAbortError());
        return;
      }

      let settled = false;

      const waiter: Waiter = {
        resolve: () => {
          if (settled) return;
          settled = true;
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) this.waiters.splice(idx, 1);
          resolve();
        },
        cancel: () => {
          if (settled) return;
          settled = true;
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) this.waiters.splice(idx, 1);
        },
      };

      this.waiters.push(waiter);

      if (signal !== undefined) {
        signal.addEventListener(
          'abort',
          () => {
            waiter.cancel();
            reject(makeAbortError());
          },
          { once: true },
        );
      }
    });
  }

  pause(seconds: number): void {
    const newResumeAt = this.now() + seconds * 1000;
    if (newResumeAt <= this.resumeAt) return;
    this.resumeAt = newResumeAt;

    if (this.refillTimer !== null) {
      clearInterval(this.refillTimer);
      this.refillTimer = null;
    }
    this.tokens = 0;

    if (this.resumeTimer !== null) {
      clearTimeout(this.resumeTimer);
    }
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.resumeAt = 0;
      this.tokens = 1;
      this.serveOneWaiter();
      this.startRefill();
    }, seconds * 1000);
  }

  private startRefill(): void {
    this.refillTimer = setInterval(() => {
      this.tokens = Math.min(this.tokens + 1, this.capacity);
      if (this.waiters.length > 0) {
        this.serveOneWaiter();
      }
    }, this.intervalMs);
  }

  private serveOneWaiter(): void {
    if (this.tokens > 0 && this.waiters.length > 0) {
      this.tokens--;
      this.waiters[0]!.resolve();
    }
  }
}

function makeAbortError(): WorkflowError {
  return new WorkflowError('Token bucket acquire cancelled', {
    code: 'STEP_ABORTED',
    category: 'ENGINE',
    agentAction: 'report_to_user',
    retryable: false,
  });
}
