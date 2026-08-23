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
    // All FOUR, not two: an always-emit-null mutant on the other pair survived the shipped cell.
    expect(finding?.evidence).not.toHaveProperty('declared_per_attempt_ms');
    expect(finding?.evidence).not.toHaveProperty('derived_ceiling_ms');
  });
});

describe('drive_failing — complementarity with never_claimed_idle', () => {
  it('AT LEAST ONE fires at every point, and BOTH fire once the run is also idle', () => {
    // The two findings are not exclusive and must not be made so. Before 24h only drive_failing
    // can speak; after it, silence is ALSO a fact, and suppressing either would hide one.
    // `updated_at` is the last entry's timestamp because that is the only record the fence can
    // actually produce — writing the failure bumps updated_at at write time. A fixture whose
    // updated_at is OLDER than its newest entry is unrealizable, and anchoring the idle timepoints
    // to the entry is the same statement from the other side.
    const failedAt = new Date(failure().at).getTime();
    const run = makeRun({
      run_phase: 'running',
      in_progress_steps: [],
      updated_at: failure().at,
    });

    expect(kinds(run, new Date(failedAt + 60_000))).toContain('drive_failing');

    const justUnderIdle = kinds(run, new Date(failedAt + DEFAULT_IDLE_THRESHOLD_MS - 1000));
    expect(justUnderIdle.length).toBeGreaterThan(0);
    expect(justUnderIdle).toContain('drive_failing');

    const pastIdle = kinds(run, new Date(failedAt + DEFAULT_IDLE_THRESHOLD_MS + 1000));
    expect(pastIdle).toContain('drive_failing');
    expect(pastIdle).toContain('never_claimed_idle');
  });
});

describe('drive_failing — the gate exemption and the tie boundary', () => {
  it('THE GATE EXEMPTION — a gate_waiting run fires NEITHER, and that is the law working', () => {
    // The complementarity law's flagged exemption, pinned as a fact rather than left implied: a
    // run parked on a human gate is not a run whose drive is failing, and the gate_waiting phase
    // is itself the visibility. The age gate is deliberately SATISFIED so `run_phase` is the ONLY
    // thing suppressing the idle finding — otherwise this passes on age alone and proves nothing.
    // The mutant class is a conditioned un-exemption on either side.
    const failedAt = new Date(failure().at).getTime();
    const run = makeRun({
      run_phase: 'gate_waiting',
      in_progress_steps: [],
      updated_at: failure().at,
      pending_gate: {
        gate_id: 'g1',
        step_name: 'approve',
        opened_at: new Date(failedAt + 30_000).toISOString(),
        choices: ['yes'],
        preview: {},
      } as NonNullable<RunRecord['pending_gate']>,
    });

    const at24hPlus = kinds(run, new Date(failedAt + DEFAULT_IDLE_THRESHOLD_MS + 1000));
    expect(at24hPlus).not.toContain('drive_failing');
    expect(at24hPlus).not.toContain('never_claimed_idle');
  });

  it('THE TIE — an entry exactly as old as the newest event is SUPPRESSED', () => {
    // The comparison is `<=`, and that is load-bearing: a `<` mutant survives every other cell
    // here. A failure simultaneous with a settle is not the LAST thing that happened.
    const run = makeRun({ evidence: [snapshot('other', failure().at)] });
    expect(kinds(run)).not.toContain('drive_failing');
  });
});

describe('drive_failing — the "ago" phrasing, per branch', () => {
  // Only the minutes branch was pinned; the other three could each drift silently.
  const at = (offsetMs: number): Date => new Date(new Date(failure().at).getTime() + offsetMs);
  const reasonAt = (now: Date): string | undefined =>
    classifyRunHealth(makeRun(), { now }).find((f) => f.kind === 'drive_failing')?.reason;

  it('seconds', () => {
    expect(reasonAt(at(45_000))).toContain('failed 45s ago');
  });

  it('hours', () => {
    expect(reasonAt(at(3 * 60 * 60 * 1000))).toContain('failed 3h ago');
  });

  it('days', () => {
    expect(reasonAt(at(2 * 24 * 60 * 60 * 1000))).toContain('failed 2d ago');
  });
});

describe('drive_failing — across a resume (issue #401, R-12)', () => {
  it('applyResume PRESERVES drive_failures, and the finding fires until first progress', async () => {
    // CHOSEN, not incidental: the history of what went wrong survives a resume, so an operator who
    // resumes a wedged run can still see why it wedged. The consequence is stated rather than
    // hidden — immediately after a resume the finding still fires, and goes quiet at the first
    // step that settles.
    const { applyResume } = await import('./apply-resume.js');
    const definition = {
      id: 'wf',
      name: 'WF',
      version: 1,
      schema_version: 1,
      steps: { classify: { description: 'Classify', execution: 'agent', depends_on: [] } },
    } as unknown as Parameters<typeof applyResume>[2];
    const failed = makeRun({
      run_phase: 'failed',
      terminal_state: true,
      terminal_reason: "Step 'classify' failed: boom",
      failed_steps: ['classify'],
    });

    const { run: resumed } = applyResume(failed, 'classify', definition);

    expect(resumed.drive_failures).toEqual(failed.drive_failures);
    expect(resumed.terminal_state).toBe(false);
    // Fires until first progress.
    expect(kinds(resumed)).toContain('drive_failing');

    // First progress kills it — the run moved on.
    const progressed = { ...resumed, completed_steps: ['classify'] };
    expect(kinds(progressed)).not.toContain('drive_failing');
  });
});
