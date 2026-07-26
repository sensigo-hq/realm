// apply-resume.test.ts — RESUME_CLEARS_SETTLED (projection + abandoned_at strip + void step, all
// on the single returned payload) for the core-owned pure resume transform (issue #279, increment
// 1, PR-B). Normative spec: plans/issue-279/design-d4-increment1.md §5.
import { describe, it, expect } from 'vitest';
import { applyResume } from './apply-resume.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const def: WorkflowDefinition = {
  id: 'resume-wf',
  name: 'Resume TCK fixture',
  version: 1,
  steps: {
    a: { description: 'a', execution: 'agent', depends_on: [] },
    b: { description: 'b', execution: 'agent', depends_on: [] },
    fin: { description: 'f', execution: 'finalizer', on_outcome: 'always' },
  },
};

function baseRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'resume-run',
    workflow_id: def.id,
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: ['a'],
    skipped_steps: [],
    run_phase: 'failed',
    version: 5,
    params: {},
    evidence: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: true,
    terminal_reason: `Step 'a' failed: boom`,
    ...overrides,
  };
}

describe('applyResume — RESUME_CLEARS_SETTLED (issue #279, increment 1, PR-B)', () => {
  it('projects settled down to live membership, strips terminal_reason AND abandoned_at, resets terminal_state, and VOIDS every pending finalizer — all on the single returned payload', () => {
    const snapshot = baseRun({
      abandoned_at: '2026-01-01T00:00:00.000Z',
      settled: {
        a: { token: 'tok-a', outcome: 'fail' },
        // an ORPHAN entry — 'ghost' is not in any membership array (simulates a stale/foreign
        // entry from a hand-authored or divergent history) — the projection must drop it too,
        // since it is not in completed′∪failed′∪skipped′ either.
        ghost: { token: null, outcome: 'complete' },
      },
      finalizer_ledger: {
        fin: { status: 'pending', rank: 0 },
      },
    });

    const { run, voided } = applyResume(snapshot, 'a', def);

    // terminal_reason + abandoned_at BOTH stripped (issue #281).
    expect(run.terminal_reason).toBeUndefined();
    expect(run.abandoned_at).toBeUndefined();
    expect(run.terminal_state).toBe(false);

    // 'a' removed from failed_steps (resumed).
    expect(run.failed_steps).not.toContain('a');

    // settled L17 projection: 'a' is gone from every membership array now (removed from
    // failed_steps, never in completed/skipped) ⇒ dropped. 'ghost' was never in any membership
    // array ⇒ dropped too (orphan).
    expect(run.settled?.['a']).toBeUndefined();
    expect(run.settled?.['ghost']).toBeUndefined();

    // The pending finalizer is VOIDED, loudly disclosed as never-executed (no lease_token).
    expect(run.finalizer_ledger?.['fin']?.status).toBe('voided');
    expect(voided).toHaveLength(1);
    expect(voided[0]!.name).toBe('fin');
    expect(voided[0]!.disclosure).toMatch(/never executed, superseded by resume/);

    // Claims released unconditionally.
    expect(run.in_progress_steps).toEqual([]);
    expect(run.claims).toEqual({});
  });

  it('a leased-but-unmarked pending finalizer gets the OTHER disclosure wording (may have executed without a recorded mark)', () => {
    const snapshot = baseRun({
      finalizer_ledger: {
        fin: {
          status: 'pending',
          rank: 0,
          lease_token: 'some-drainer-token',
          lease_deadline: '2020-01-01T00:00:00.000Z', // expired — otherwise the CLI would refuse
        },
      },
    });

    const { voided } = applyResume(snapshot, 'a', def);

    expect(voided).toHaveLength(1);
    expect(voided[0]!.disclosure).toMatch(
      /may have executed without a recorded mark; may re-execute at the next terminal edge/,
    );
  });

  it('never-downgrades an already-completed or already-failed finalizer ledger entry (only PENDING entries are voided)', () => {
    const snapshot = baseRun({
      finalizer_ledger: {
        completedFin: { status: 'completed', rank: 0 },
        failedFin: { status: 'failed', rank: 1 },
      },
    });

    const { run, voided } = applyResume(snapshot, 'a', def);

    expect(run.finalizer_ledger?.['completedFin']?.status).toBe('completed');
    expect(run.finalizer_ledger?.['failedFin']?.status).toBe('failed');
    expect(voided).toHaveLength(0);
  });

  it('a run with no finalizer_ledger at all resumes cleanly (undefined stays undefined, no crash)', () => {
    const snapshot = baseRun();
    const { run, voided } = applyResume(snapshot, 'a', def);
    expect(run.finalizer_ledger).toBeUndefined();
    expect(voided).toEqual([]);
  });

  it('re-derives skipped_steps/skip_details from scratch (a step skipped only because of the now-resumed failure becomes eligible again)', () => {
    const snapshot = baseRun({
      skipped_steps: ['b'],
      skip_details: { b: { kind: 'trigger_rule_unsatisfiable' } },
    });
    const { run } = applyResume(snapshot, 'a', def);
    // 'b' has no dependency on 'a' in this fixture, so propagateSkips should NOT re-skip it —
    // proving the skip state is genuinely RE-DERIVED, not merely carried forward stale.
    expect(run.skipped_steps).not.toContain('b');
    expect(run.skip_details['b']).toBeUndefined();
  });

  it('releases a genuinely DANGLING claim (non-empty in_progress_steps/claims — the actual R1-wedge shape, a crash mid-execution with no settle ever reached), not merely a fixture that is already empty', () => {
    const snapshot = baseRun({
      // The resumed step itself was left claimed (crashed before any settle) AND a sibling step
      // also has a stale claim outstanding — both must be released unconditionally.
      in_progress_steps: ['a', 'b'],
      claims: {
        a: { deadline: '2020-01-01T00:00:00.000Z', token: 'dead-token-a' },
        b: { deadline: '2020-01-01T00:00:00.000Z', token: 'dead-token-b' },
      },
    });
    const { run } = applyResume(snapshot, 'a', def);
    expect(run.in_progress_steps).toEqual([]);
    expect(run.claims).toEqual({});
  });

  it('a settled entry still in live membership (e.g. a genuinely completed sibling step) SURVIVES the projection', () => {
    const snapshot = baseRun({
      completed_steps: ['b'],
      settled: {
        a: { token: 'tok-a', outcome: 'fail' },
        b: { token: 'tok-b', outcome: 'complete' },
      },
    });
    const { run } = applyResume(snapshot, 'a', def);
    expect(run.settled?.['a']).toBeUndefined(); // 'a' is being resumed — no longer settled
    expect(run.settled?.['b']).toEqual({ token: 'tok-b', outcome: 'complete' }); // survives
  });
});
