// slack-call.ts — #729 PR-4 (02 §Transport (1)): the deadline every Slack call runs under.

/**
 * #729 PR-4 (02 §Transport (1)): one Slack call's deadline — slack_sdk's default, above the 15 s
 * degraded latency Slack has published, ten times under undici's 300 s. Every Slack call takes it:
 * the notifier's one send function and the socket client's open. Its own module, so a test that
 * replaces the socket client keeps the deadline.
 */
export const SLACK_CALL_DEADLINE_MS = 30_000;

/**
 * A signal that aborts after `ms`, its abort scheduled with the GLOBAL `setTimeout` and unref'd —
 * never `AbortSignal.timeout`, which Node arms through the `timers` binding, so fake timers never
 * fire it and the cells could not run. `clear` cancels it once the call is done.
 */
export function deadlineSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  (timer as { unref?: () => void }).unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** A response body read bounded by the call's signal: it rejects when the deadline fires first. */
export function readWithin<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Slack call deadline passed'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('Slack call deadline passed'));
    signal.addEventListener('abort', onAbort, { once: true });
    read().then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
