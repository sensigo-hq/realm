// Tests for diffRuns, diffReplays, and isReplayId business logic.
import { describe, it, expect } from 'vitest';
import { diffRuns, diffReplays, isReplayId } from './diff.js';
import type { RunRecord, EvidenceSnapshot } from '@sensigo/realm';
import type { ReplayRecord } from '../store/replay-store.js';

function makeSnap(
  stepId: string,
  hash: string,
  status: 'success' | 'error' | 'skipped' = 'success',
  durationMs = 100,
): EvidenceSnapshot {
  return {
    step_id: stepId,
    started_at: '2024-01-01T00:00:00.000Z',
    completed_at: '2024-01-01T00:00:01.000Z',
    duration_ms: durationMs,
    input_summary: {},
    output_summary: {},
    status,
    evidence_hash: hash,
  };
}

function makeRun(evidence: EvidenceSnapshot[], workflowId = 'wf1'): RunRecord {
  return {
    id: 'run_' + Math.random().toString(36).slice(2),
    workflow_id: workflowId,
    workflow_version: 1,
    version: 1,
    params: {},
    evidence,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:01.000Z',
    terminal_state: true,
    // The DAG step sets + derived phase are required on RunRecord (they replaced the old scalar
    // `state` field this fixture still carried). diffRuns reads only `evidence`, so they are inert
    // here — present so the fixture is a structurally valid completed run.
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'completed',
  };
}

describe('diffRuns', () => {
  it('two identical runs produce all same_output: true rows', () => {
    const evidence = [makeSnap('step_a', 'hash1'), makeSnap('step_b', 'hash2')];
    const runA = makeRun(evidence);
    const runB = makeRun(evidence);
    const rows = diffRuns(runA, runB);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.same_output)).toBe(true);
    expect(rows.every((r) => r.same_status)).toBe(true);
  });

  it('steps with different output hashes show same_output: false', () => {
    const runA = makeRun([makeSnap('step_a', 'hashA'), makeSnap('step_b', 'hashB1')]);
    const runB = makeRun([makeSnap('step_a', 'hashA'), makeSnap('step_b', 'hashB2')]);
    const rows = diffRuns(runA, runB);
    expect(rows.find((r) => r.step_id === 'step_a')!.same_output).toBe(true);
    expect(rows.find((r) => r.step_id === 'step_b')!.same_output).toBe(false);
  });

  it('step present in A but missing from B shows status_b: missing', () => {
    const runA = makeRun([makeSnap('step_a', 'hashA'), makeSnap('step_b', 'hashB')]);
    const runB = makeRun([makeSnap('step_a', 'hashA')]);
    const rows = diffRuns(runA, runB);
    const stepBRow = rows.find((r) => r.step_id === 'step_b');
    expect(stepBRow).toBeDefined();
    expect(stepBRow!.status_b).toBe('missing');
    expect(stepBRow!.same_output).toBe(false);
  });

  it('different workflow IDs: diff still returns rows (does not throw)', () => {
    const runA = makeRun([makeSnap('step_a', 'hashX')], 'workflow-1');
    const runB = makeRun([makeSnap('step_a', 'hashX')], 'workflow-2');
    const rows = diffRuns(runA, runB);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.same_output).toBe(true);
  });
});

describe('isReplayId', () => {
  it('returns true for an rpl_-prefixed ID', () => {
    expect(isReplayId('rpl_abc123-def456')).toBe(true);
  });

  it('returns false for a plain run UUID', () => {
    expect(isReplayId('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isReplayId('')).toBe(false);
  });
});

function makeReplayRecord(
  stepResults: ReplayRecord['results'],
  overrides: string[] = [],
): ReplayRecord {
  return {
    id: `rpl_${Math.random().toString(36).slice(2)}`,
    origin_run_id: `run_${Math.random().toString(36).slice(2)}`,
    workflow_id: 'test-workflow',
    overrides,
    results: stepResults,
    created_at: '2024-01-01T00:00:00.000Z',
  };
}

describe('diffReplays', () => {
  it('two identical replays produce all differs: false rows', () => {
    const results = [
      {
        step_id: 'fetch_doc',
        preconditions_original: true,
        preconditions_replay: true,
        changed: false,
        has_preconditions: false,
      },
      {
        step_id: 'write',
        preconditions_original: true,
        preconditions_replay: true,
        changed: false,
        has_preconditions: true,
      },
    ];
    const recordA = makeReplayRecord(results);
    const recordB = makeReplayRecord(results);
    const rows = diffReplays(recordA, recordB);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.differs)).toBe(true);
  });

  it('step with has_preconditions false shows "none" in both columns', () => {
    const results = [
      {
        step_id: 'fetch_doc',
        preconditions_original: true,
        preconditions_replay: true,
        changed: false,
        has_preconditions: false,
      },
    ];
    const recordA = makeReplayRecord(results);
    const recordB = makeReplayRecord(results);
    const rows = diffReplays(recordA, recordB);
    expect(rows[0]!.precond_a).toBe('none');
    expect(rows[0]!.precond_b).toBe('none');
    expect(rows[0]!.differs).toBe(false);
  });

  it('one step changes from PASS→PASS to PASS→BLOCKED → that step has differs: true', () => {
    const resultsA = [
      {
        step_id: 'validate',
        preconditions_original: true,
        preconditions_replay: true,
        changed: false,
        has_preconditions: false,
      },
      {
        step_id: 'write',
        preconditions_original: true,
        preconditions_replay: true,
        changed: false,
        has_preconditions: true,
      },
    ];
    const resultsB = [
      {
        step_id: 'validate',
        preconditions_original: true,
        preconditions_replay: true,
        changed: false,
        has_preconditions: false,
      },
      {
        step_id: 'write',
        preconditions_original: true,
        preconditions_replay: false,
        changed: true,
        has_preconditions: true,
      },
    ];
    const recordA = makeReplayRecord(resultsA);
    const recordB = makeReplayRecord(resultsB);
    const rows = diffReplays(recordA, recordB);
    const validateRow = rows.find((r) => r.step_id === 'validate');
    const writeRow = rows.find((r) => r.step_id === 'write');
    expect(validateRow!.differs).toBe(false);
    expect(writeRow!.differs).toBe(true);
    expect(writeRow!.precond_a).toContain('PASS');
    expect(writeRow!.precond_b).toContain('BLOCKED');
  });

  it('step present in A but absent from B → precond_b is "missing" and differs: true', () => {
    const resultsA = [
      {
        step_id: 'fetch_doc',
        preconditions_original: true,
        preconditions_replay: true,
        changed: false,
        has_preconditions: false,
      },
      {
        step_id: 'extra_step',
        preconditions_original: true,
        preconditions_replay: true,
        changed: false,
        has_preconditions: true,
      },
    ];
    const resultsB = [
      {
        step_id: 'fetch_doc',
        preconditions_original: true,
        preconditions_replay: true,
        changed: false,
        has_preconditions: false,
      },
    ];
    const recordA = makeReplayRecord(resultsA);
    const recordB = makeReplayRecord(resultsB);
    const rows = diffReplays(recordA, recordB);
    const extraRow = rows.find((r) => r.step_id === 'extra_step');
    expect(extraRow).toBeDefined();
    expect(extraRow!.precond_b).toBe('missing');
    expect(extraRow!.differs).toBe(true);
  });
});

describe('mixed-ID rejection guard', () => {
  it('isReplayId(runId) !== isReplayId(replayId) evaluates true for mixed pair', () => {
    const runId = '550e8400-e29b-41d4-a716-446655440000';
    const replayId = 'rpl_abc123';
    expect(isReplayId(runId) !== isReplayId(replayId)).toBe(true);
  });

  it('isReplayId(replayIdA) !== isReplayId(replayIdB) evaluates false for two replay IDs', () => {
    const replayIdA = 'rpl_aaa';
    const replayIdB = 'rpl_bbb';
    expect(isReplayId(replayIdA) !== isReplayId(replayIdB)).toBe(false);
  });
});
