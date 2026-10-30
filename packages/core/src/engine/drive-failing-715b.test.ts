// drive-failing-715b.test.ts — issue #715 (b) 02 §D.2 (D6-15, D6-47): `drive_failing` fires while the
// run holds exactly what it held when the failure was appended (its evidence count and its open
// question), never by comparing stamps — so a FROZEN clock, where the failure and the run's creation
// share an instant, judges it right. An entry written before #715 (b) carries neither and is judged
// by the stamp order, saying so (`basis: 'legacy_stamp_order'`).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import { classifyRunHealth } from './run-health.js';
import { writtenSnapshot } from './snapshot.js';
import type { DriveFailureRecord, EvidenceSnapshot, RunRecord } from '../types/run-record.js';

const T = '2026-10-30T10:00:00.000Z';

const failure = (fence: Partial<DriveFailureRecord>): DriveFailureRecord => ({
  at: T,
  step: 'draft',
  provider: 'anthropic',
  error_class: 'api_status',
  message: 'rate limited',
  elapsed_ms: 10,
  ...fence,
});

const run = (entry: DriveFailureRecord, evidence: EvidenceSnapshot[] = []): RunRecord =>
  ({
    id: 'r1',
    workflow_id: 'w',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    terminal_state: false,
    version: 2,
    params: {},
    evidence,
    created_at: T,
    updated_at: T,
    drive_failures: { first_failed_at: T, total: 1, entries: [entry] },
  }) as RunRecord;

const evidence: EvidenceSnapshot = {
  step_id: 'other',
  started_at: T,
  completed_at: T,
  duration_ms: 0,
  input_summary: {},
  output_summary: {},
  status: 'success',
  evidence_hash: 'h',
};

const finding = (record: RunRecord) =>
  classifyRunHealth(writtenSnapshot(record, new Date(T))).find((f) => f.kind === 'drive_failing');

describe('#715 (b) §D.2 — drive_failing by what the run held, not by stamps', () => {
  it('a frozen clock: the failure and the run share one instant — the finding fires while nothing was recorded since, and stops once something was', () => {
    // (a) red when the finding still compares stamps for an entry that carries its fence (it never
    //     fires at one instant), or ignores the count (it fires after evidence was recorded); (b)
    //     prints whether it fired in each state, and the basis.
    const entry = failure({ evidence_count: 0 });
    expect({
      nothingSince: finding(run(entry)) !== undefined,
      basis: finding(run(entry))?.evidence?.['basis'],
      afterEvidence: finding(run(entry, [evidence])) !== undefined,
    }).toEqual({ nothingSince: true, basis: undefined, afterEvidence: false });
  });

  it('a question opened or answered since the failure: no finding', () => {
    // (a) red when the open question is not part of the fence; (b) prints whether it fired.
    const atGate = { ...run(failure({ evidence_count: 0, gate_id: 'g1' })) };
    const other = {
      ...atGate,
      pending_gate: { gate_id: 'g2', step_name: 'draft' },
    } as unknown as RunRecord;
    expect(finding(other) !== undefined).toBe(false);
  });

  it('a legacy entry (written before #715 (b)) is judged by the stamp order, and says so', () => {
    // (a) red when a legacy entry loses its basis, or is judged by a fence it does not carry; (b)
    //     prints the finding's basis, and whether it fired at one instant (the stamp rule: no).
    const legacyAt = { ...run(failure({})), created_at: '2026-10-30T09:00:00.000Z' } as RunRecord;
    expect({
      later: finding(legacyAt)?.evidence?.['basis'],
      sameInstant: finding(run(failure({}))) !== undefined,
    }).toEqual({ later: 'legacy_stamp_order', sameInstant: false });
  });
});
