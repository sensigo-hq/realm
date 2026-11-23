// callback-store-c3d.test.ts — callback C3d-A (R1.3): core's two pure helpers behind the port's new
// methods. `endOverdueCallbacks` writes an ended row as a `failed` mark writes it (`expired`; the
// address and body gone; every other field kept, the claim token too, which the port's view hides
// from the contract), anchors on the row's `finished_at` before the run's `updatedAt`, and ends at
// exactly 3 days. `countWaitingCallbacks` counts the pending rows of finished runs.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { describe, expect, it } from 'vitest';
import {
  CALLBACK_DELIVERY_WINDOW_SECONDS,
  countWaitingCallbacks,
  endOverdueCallbacks,
  type CallbackRow,
} from './callback-store.js';

const T0 = Date.parse('2026-04-01T00:00:00.000Z');
const iso = (ms: number): string => new Date(T0 + ms).toISOString();
const W = CALLBACK_DELIVERY_WINDOW_SECONDS * 1000;

/** A row claimed once at 1 s, its body frozen, its last try answered 503, due again at 90 s. */
const claimed: CallbackRow = {
  run_id: 'run-claimed',
  workflow_id: 'wf',
  host: 'hooks.example:443',
  webhook_id: '00000000-0000-4000-8000-000000000001',
  status: 'pending',
  attempts: 1,
  created_at: iso(0),
  next_attempt_at: iso(90_000),
  first_attempt_at: iso(1000),
  finished_at: iso(0),
  last_attempt_at: iso(1000),
  last_status: 503,
  url: 'https://hooks.example/callback/1',
  body: '{"type":"run.finished"}',
  claim_token: 'token-of-the-claim',
};

describe('callback C3d-A — endOverdueCallbacks', () => {
  it('writes the ended row as a failed mark writes it, expired, the claim token and every other field kept', () => {
    const run = { finished: true, updatedAt: iso(5000) };
    const out = endOverdueCallbacks([claimed], () => run, new Date(T0 + W), 10);
    const { url: _url, body: _body, ...kept } = claimed;
    // (1) red when the end drops the token or another kept field, keeps the address or the body,
    //     or writes another status or word; (2) prints the written rows and the result.
    expect(out).toEqual({
      ended: [{ run_id: 'run-claimed', workflow_id: 'wf', host: 'hooks.example:443', attempts: 1 }],
      writes: [{ ...kept, status: 'failed', last_status: 'expired' }],
    });
  });

  it('anchors on finished_at before the run’s updatedAt, and ends at exactly 3 days, not 1 ms before', () => {
    // The run's updatedAt is 5 s after the row's finished_at: an anchor read from the run ends 5 s late.
    const run = { finished: true, updatedAt: iso(5000) };
    const at = (ms: number) =>
      endOverdueCallbacks([claimed], () => run, new Date(T0 + ms), 10).ended.length;
    const { finished_at: _finished, ...never } = claimed;
    const fromRun = (ms: number) =>
      endOverdueCallbacks([never], () => run, new Date(T0 + ms), 10).ended.length;
    // (1) red when the anchor prefers the run's updatedAt, when `>` replaces `>=` at the boundary,
    //     or when a row with no finished_at is not read from its run; (2) prints the four counts.
    expect({
      before: at(W - 1),
      at: at(W),
      runBefore: fromRun(5000 + W - 1),
      runAt: fromRun(5000 + W),
    }).toEqual({ before: 0, at: 1, runBefore: 0, runAt: 1 });
  });
});

describe('callback C3d-A — countWaitingCallbacks', () => {
  it('counts the pending rows of finished runs only', () => {
    const rows: CallbackRow[] = [
      { ...claimed, run_id: 'finished' },
      { ...claimed, run_id: 'running' },
      { ...claimed, run_id: 'gone' },
      { ...claimed, run_id: 'delivered', status: 'delivered' },
    ];
    const finished = (id: string): boolean => id === 'finished' || id === 'delivered';
    // (1) red when the count takes every pending row, or a finished row that is not pending;
    //     (2) prints the count.
    expect(countWaitingCallbacks(rows, finished)).toBe(1);
  });
});
