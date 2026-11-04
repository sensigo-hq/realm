// gate-timing.test.ts — issue #291, Deliverable 7: the shared read-time due/overdue derivation.
import { describe, it, expect } from 'vitest';
import { computeGateDueState } from './gate-timing.js';
import type { PendingGate } from '../types/run-record.js';

function makeGate(overrides: Partial<PendingGate> = {}): PendingGate {
  return {
    gate_id: 'gate-1',
    step_name: 'approve',
    preview: {},
    choices: ['approve', 'reject'],
    opened_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('computeGateDueState (issue #291)', () => {
  it('expired: false + no overdue_ms when there is no enforce clock at all', () => {
    const state = computeGateDueState(makeGate(), new Date('2026-01-01T01:00:00.000Z'));
    expect(state.expired).toBe(false);
    expect(state.overdue_ms).toBeUndefined();
  });

  it('expired: false before expires_at', () => {
    const gate = makeGate({ expires_at: '2026-01-01T00:10:00.000Z' });
    const state = computeGateDueState(gate, new Date('2026-01-01T00:05:00.000Z'));
    expect(state.expired).toBe(false);
    expect(state.overdue_ms).toBeUndefined();
  });

  it('expired: true at/after expires_at, with the exact overdue_ms', () => {
    const gate = makeGate({ expires_at: '2026-01-01T00:10:00.000Z' });
    const state = computeGateDueState(gate, new Date('2026-01-01T00:12:30.000Z'));
    expect(state.expired).toBe(true);
    expect(state.overdue_ms).toBe(150_000); // 2m30s
  });

  it('next_reminder_due_at is absent without a frozen reminder_seconds', () => {
    const state = computeGateDueState(makeGate(), new Date('2026-01-01T00:00:30.000Z'));
    expect(state.next_reminder_due_at).toBeUndefined();
  });

  it('next_reminder_due_at computes the NEXT-undelivered occurrence at opened_at + n*reminder_seconds', () => {
    const gate = makeGate({ reminder_seconds: 60 }); // every 60s
    // At t=0 (opened_at), the next occurrence is at +60s.
    const atOpen = computeGateDueState(gate, new Date('2026-01-01T00:00:00.000Z'));
    expect(atOpen.next_reminder_due_at).toBe('2026-01-01T00:01:00.000Z');
    // At t=90s (past the first occurrence), the NEXT one is at +120s.
    const midway = computeGateDueState(gate, new Date('2026-01-01T00:01:30.000Z'));
    expect(midway.next_reminder_due_at).toBe('2026-01-01T00:02:00.000Z');
  });

  it('a pure-notify gate (reminder_seconds, no expires_at) never reports expired', () => {
    const gate = makeGate({ reminder_seconds: 60 });
    const state = computeGateDueState(gate, new Date('2026-01-01T02:00:00.000Z'));
    expect(state.expired).toBe(false);
    expect(state.next_reminder_due_at).toBeDefined();
  });
});

// #715 (b) A.2 (D-25): the reminder schedule reads `opened_at` through the one stamp parser. An
// unparseable `opened_at` yields NO occurrence — before, `new Date(NaN).toISOString()` threw RangeError
// whenever `reminder_seconds` was set (and returned nothing when it was not).
describe('computeGateDueState — an unparseable opened_at (#715 (b), D-25)', () => {
  it('with reminder_seconds set: no next_reminder_due_at, the due facts still computed, never a RangeError', () => {
    // (a) red when the schedule parses opened_at itself again (RangeError) or schedules from NaN;
    //     (b) prints the state, or the thrown error's name and message.
    const gate = makeGate({
      opened_at: 'garbage',
      reminder_seconds: 60,
      expires_at: '2026-01-01T00:10:00.000Z',
    });
    let outcome: unknown;
    try {
      outcome = computeGateDueState(gate, new Date('2026-01-01T00:20:00.000Z'));
    } catch (e) {
      outcome = `${(e as Error).name}: ${(e as Error).message}`;
    }
    expect(outcome).toEqual({ expired: true, overdue_ms: 600_000 });
  });
});
