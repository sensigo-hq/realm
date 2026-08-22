// drive-failing.test.ts — the `drive_failing` run-health finding, per conjunct (issue #401).
//
// The finding answers one question: is the last thing that happened to this run a failed drive?
// Every conjunct below exists to stop it answering "yes" when the run has since moved on — a
// watchdog that cries wolf gets ignored, which costs more than the finding was worth.
import { describe, it, expect } from 'vitest';
import { classifyRunHealth, DEFAULT_IDLE_THRESHOLD_MS } from './run-health.js';
import type { RunRecord, DriveFailureRecord, EvidenceSnapshot } from '../types/run-record.js';

const T0 = '2026-01-01T00:00:00.000Z';
const NOW = new Date('2026-01-01T00:05:00.000Z');

function failure(over: Partial<DriveFailureRecord> = {}): DriveFailureRecord {
  return {
    at: '2026-01-01T00:04:00.000Z',
    step: 'classify',
    provider: 'anthropic',
    error_class: 'connection_error',
    message: 'socket hang up',
    elapsed_ms: 1200,
    ...over,
  };
}

function makeRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 1,
    params: {},
    evidence: [],
    created_at: T0,
    updated_at: T0,
    terminal_state: false,
    drive_failures: { first_failed_at: failure().at, total: 1, entries: [failure()] },
    ...over,
  } as RunRecord;
}

const kinds = (run: RunRecord, now = NOW): string[] =>
  classifyRunHealth(run, { now }).map((f) => f.kind);

function snapshot(step: string, completedAt: string): EvidenceSnapshot {
  return {
    step_id: step,
    started_at: T0,
    completed_at: completedAt,
    duration_ms: 1,
    input_summary: {},
    output_summary: {},
  } as EvidenceSnapshot;
}

describe('drive_failing — the base case', () => {
  it('a fresh run whose only event is a failed drive FIRES', () => {
    expect(kinds(makeRun())).toContain('drive_failing');
  });

  it('carries the step, the class and the counters as evidence', () => {
    const [finding] = classifyRunHealth(makeRun(), { now: NOW }).filter(
      (f) => f.kind === 'drive_failing',
    );
    expect(finding?.step).toBe('classify');
    expect(finding?.evidence).toMatchObject({
      step: 'classify',
      error_class: 'connection_error',
      at: '2026-01-01T00:04:00.000Z',
      total: 1,
      first_failed_at: '2026-01-01T00:04:00.000Z',
    });
  });
});

describe('drive_failing — conjunct (ii): the run must be live', () => {
  it('a terminal run never fires — the seal is the visibility', () => {
    expect(kinds(makeRun({ terminal_state: true, run_phase: 'failed' }))).not.toContain(
      'drive_failing',
    );
  });
});

describe('drive_failing — conjunct (iii): the failure must be the LAST event', () => {
  it('a sibling step settling AFTER the failure kills the finding', () => {
    // The run moved on. Reporting the failure now would be reporting history.
    const run = makeRun({ evidence: [snapshot('other', '2026-01-01T00:04:30.000Z')] });
    expect(kinds(run)).not.toContain('drive_failing');
  });

  it('a step settling BEFORE the failure leaves it firing', () => {
    const run = makeRun({ evidence: [snapshot('other', '2026-01-01T00:03:00.000Z')] });
    expect(kinds(run)).toContain('drive_failing');
  });

  it('a gate opened AFTER the failure suppresses it', () => {
    // Dropping `opened_at` from the max is the mutant this cell exists for: a run waiting on a
    // human is not a run whose drive is failing.
    const run = makeRun({
      run_phase: 'gate_waiting',
      pending_gate: {
        gate_id: 'g1',
        step_name: 'approve',
        opened_at: '2026-01-01T00:04:30.000Z',
        choices: ['yes'],
        preview: {},
      } as NonNullable<RunRecord['pending_gate']>,
    });
    expect(kinds(run)).not.toContain('drive_failing');
  });

  it('COMPANION — a gate opened BEFORE the failure leaves it firing', () => {
    const run = makeRun({
      run_phase: 'gate_waiting',
      pending_gate: {
        gate_id: 'g1',
        step_name: 'approve',
        opened_at: '2026-01-01T00:03:00.000Z',
        choices: ['yes'],
        preview: {},
      } as NonNullable<RunRecord['pending_gate']>,
    });
    expect(kinds(run)).toContain('drive_failing');
  });

  it('THE FLOOR — an entry predating created_at is suppressed', () => {
    // Without the created_at floor, max of an empty evidence set is negative infinity and a stale
    // entry from a previous life of this id would fire.
    const stale = failure({ at: '2025-12-31T23:00:00.000Z' });
    const run = makeRun({
      drive_failures: { first_failed_at: stale.at, total: 1, entries: [stale] },
    });
    expect(kinds(run)).not.toContain('drive_failing');
  });
});

describe('drive_failing — conjunct (iv): the failing step must not have settled', () => {
  it.each([
    ['completed_steps', { completed_steps: ['classify'] }],
    ['failed_steps', { failed_steps: ['classify'] }],
    ['skipped_steps', { skipped_steps: ['classify'] }],
  ])('a step in %s suppresses the finding', (_label, over) => {
    expect(kinds(makeRun(over as Partial<RunRecord>))).not.toContain('drive_failing');
  });
});

describe('drive_failing — the reason string', () => {
  it('names when, what class, and what the provider said', () => {
    const [finding] = classifyRunHealth(makeRun(), { now: NOW }).filter(
      (f) => f.kind === 'drive_failing',
    );
    expect(finding?.reason).toBe(
      'the last drive attempt failed 1m ago (connection_error): socket hang up',
    );
  });

  it('appends the total ONLY when the ring has rolled', () => {
    const rolled = makeRun({
      drive_failures: {
        first_failed_at: '2026-01-01T00:00:30.000Z',
        total: 9,
        entries: [failure()],
      },
    });
    const [f1] = classifyRunHealth(rolled, { now: NOW }).filter((f) => f.kind === 'drive_failing');
    expect(f1?.reason).toContain('; 9 failures since 2026-01-01T00:00:30.000Z');

    // Polarity: total === entries.length ⇒ no suffix, because it would restate what the entries
    // already show.
    const [f2] = classifyRunHealth(makeRun(), { now: NOW }).filter(
      (f) => f.kind === 'drive_failing',
    );
    expect(f2?.reason).not.toContain('failures since');
  });
});

describe('drive_failing — the discriminators reach the operator', () => {
  it('status, Retry-After and the clock pair travel into evidence when present', () => {
    const rich = failure({
      error_class: 'api_status',
      last_observed_status: 429,
      retry_after_observed_ms: 30_000,
      declared_per_attempt_ms: 600_000,
      derived_ceiling_ms: 1_860_000,
    });
    const run = makeRun({
      drive_failures: { first_failed_at: rich.at, total: 1, entries: [rich] },
    });
    const [finding] = classifyRunHealth(run, { now: NOW }).filter(
      (f) => f.kind === 'drive_failing',
    );
    expect(finding?.evidence).toMatchObject({
      last_observed_status: 429,
      retry_after_observed_ms: 30_000,
      declared_per_attempt_ms: 600_000,
      derived_ceiling_ms: 1_860_000,
    });
  });

  it('and are ABSENT, not null, when the entry does not carry them', () => {
    const [finding] = classifyRunHealth(makeRun(), { now: NOW }).filter(
      (f) => f.kind === 'drive_failing',
    );
    expect(finding?.evidence).not.toHaveProperty('last_observed_status');
    expect(finding?.evidence).not.toHaveProperty('retry_after_observed_ms');
  });
});

describe('drive_failing — complementarity with never_claimed_idle', () => {
  it('AT LEAST ONE fires at every point, and BOTH fire once the run is also idle', () => {
    // The two findings are not exclusive and must not be made so. Before 24h only drive_failing
    // can speak; after it, silence is ALSO a fact, and suppressing either would hide one.
    const run = makeRun({ run_phase: 'running', in_progress_steps: [] });
    const failedAt = new Date(failure().at).getTime();

    const atOneMinute = kinds(run, new Date(failedAt + 60_000));
    expect(atOneMinute).toContain('drive_failing');

    const justUnderIdle = kinds(
      run,
      new Date(new Date(T0).getTime() + DEFAULT_IDLE_THRESHOLD_MS - 1000),
    );
    expect(justUnderIdle.length).toBeGreaterThan(0);
    expect(justUnderIdle).toContain('drive_failing');

    const pastIdle = kinds(
      run,
      new Date(new Date(T0).getTime() + DEFAULT_IDLE_THRESHOLD_MS + 1000),
    );
    expect(pastIdle).toContain('drive_failing');
    expect(pastIdle).toContain('never_claimed_idle');
  });
});
