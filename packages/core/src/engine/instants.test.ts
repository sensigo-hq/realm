// instants.test.ts — issue #729 PR-0 (D4 P-8, A-15, T-2; Amendment 13 Q10): the ONE parser of a
// run's stored instants and the ONE due test of a stored deadline.
//
// - P-8: `ahead_ms` only for a `past_event`, never for a deadline; ε decides its presence (strictly
//   more than ε ahead); the stamped-ahead sentence names no clock.
// - Q10: an unparseable deadline is never past — pinned on both former copies of the due test
//   (`dueExpiry`, which read a NaN deadline as due; the settlement's `not_expired` refusal, which
//   refused it): they are one answer now.
// - T-2: a deadline not yet passed is never "0 s overdue" — `overdueOf` gives nothing.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import {
  CLOCK_SKEW_EPSILON_MS,
  isPastDeadline,
  overdueOf,
  readInstant,
  recordStampedAheadSentence,
} from './instants.js';
import { dueExpiry } from './pending.js';
import { applySettlement } from './settlement.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const R = new Date('2026-10-16T12:00:00.000Z');
const at = (offsetMs: number): string => new Date(R.getTime() + offsetMs).toISOString();

describe('#729 PR-0 — readInstant (P-8)', () => {
  it('a past event more than ε ahead of the reading carries ahead_ms, the full lead', () => {
    // (a) red when the lead is capped, or ahead_ms is dropped; (b) prints the reading.
    expect(readInstant(at(12_000), 'past_event', R)).toEqual({
      ms: R.getTime() + 12_000,
      ahead_ms: 12_000,
    });
  });

  it('ε decides presence: exactly ε ahead carries none; one millisecond more does', () => {
    // (a) red when the comparison loses its strictness, or ε changes; (b) prints both readings.
    expect([
      'ahead_ms' in readInstant(at(CLOCK_SKEW_EPSILON_MS), 'past_event', R),
      'ahead_ms' in readInstant(at(CLOCK_SKEW_EPSILON_MS + 1), 'past_event', R),
      CLOCK_SKEW_EPSILON_MS,
    ]).toEqual([false, true, 5_000]);
  });

  it('a deadline ahead of the reading never carries ahead_ms — it is simply not due', () => {
    // (a) red when the class is ignored; (b) prints the reading.
    expect(readInstant(at(60_000), 'deadline', R)).toEqual({ ms: R.getTime() + 60_000 });
  });

  it('an unparseable stamp is { absent: unparseable_stamp } — never NaN', () => {
    // (a) red when NaN leaks; (b) prints the reading.
    for (const cls of ['past_event', 'deadline'] as const) {
      expect(readInstant('not a time', cls, R)).toEqual({ absent: 'unparseable_stamp' });
    }
  });

  it('record_stamped_ahead’s sentence names no clock, in whole seconds', () => {
    // (a) red when the sentence blames one clock or changes its unit; (b) prints it.
    expect(recordStampedAheadSentence(12_400)).toBe('one of the two clocks is off by 12 s');
  });
});

describe('#729 PR-0 — isPastDeadline and overdueOf (A-15, T-2, Q10)', () => {
  it('past at the deadline itself and after it; not before (the engine’s `!(at < deadline)`)', () => {
    // (a) red when the boundary moves; (b) prints the three answers.
    expect([isPastDeadline(at(1), R), isPastDeadline(at(0), R), isPastDeadline(at(-1), R)]).toEqual(
      [false, true, true],
    );
  });

  it('Q10: an unparseable deadline is never past', () => {
    // (a) red when NaN reads as due (`!(at < NaN)` is true); (b) prints the answer.
    expect(isPastDeadline('not a time', R)).toBe(false);
  });

  it('T-2: overdue only when past — never "0 s" for a deadline not yet due; absent for an unparseable one', () => {
    // (a) red when a future deadline gets an overdue figure; (b) prints the three readings.
    expect([overdueOf(at(1), R), overdueOf(at(-1_500), R), overdueOf('nope', R)]).toEqual([
      undefined,
      { ms: 1_500 },
      { absent: 'unparseable_stamp' },
    ]);
  });

  it('Q10 on both former copies: the view offers no expiry and the settlement does not expire on an unparseable deadline', () => {
    const gate = {
      gate_id: 'g',
      step_name: 'q',
      preview: {},
      choices: ['approve', 'reject'],
      opened_at: at(-120_000),
      expires_at: 'not a time',
      on_expiry: 'abort' as const,
    };
    // (a) red when either copy reads the stamp its own way again; (b) prints both answers.
    const run = {
      id: 'r',
      workflow_id: 'w',
      workflow_version: 1,
      completed_steps: [],
      in_progress_steps: ['q'],
      failed_steps: [],
      skipped_steps: [],
      run_phase: 'gate_waiting',
      version: 3,
      params: {},
      evidence: [],
      created_at: at(-120_000),
      updated_at: at(-120_000),
      terminal_state: false,
      pending_gate: gate,
    } as unknown as RunRecord;
    const def: WorkflowDefinition = {
      id: 'w',
      name: 'w',
      version: 1,
      steps: { q: { description: 'q', execution: 'agent', depends_on: [] } },
    };
    const settled = applySettlement(run, { kind: 'expire_gate', gateId: 'g' }, def, { now: R });
    expect({
      view: dueExpiry(gate, R),
      settlement: settled.applied ? 'applied' : settled.reason,
    }).toEqual({ view: undefined, settlement: 'not_expired' });
  });
});
