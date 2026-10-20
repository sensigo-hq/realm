// Tests for diffRuns, diffReplays, and isReplayId business logic.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { captureEvidence } from '@sensigo/realm';
import { diffRuns, diffReplays, diffSymbol, isReplayId } from './diff.js';
import type { RunRecord, EvidenceSnapshot } from '@sensigo/realm';
import type { ReplayRecord } from '../store/replay-store.js';

function makeSnap(
  stepId: string,
  hash: string,
  status: 'success' | 'error' | 'skipped' = 'success',
  durationMs = 100,
  output: Record<string, unknown> = {},
): EvidenceSnapshot {
  return {
    step_id: stepId,
    started_at: '2024-01-01T00:00:00.000Z',
    completed_at: '2024-01-01T00:00:01.000Z',
    duration_ms: durationMs,
    input_summary: {},
    output_summary: output,
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

  it('steps with different outputs show same_output: false', () => {
    // fix-run-diff-field-order: the mark reads the outputs, so step_b's two outputs differ (they
    // were both `{}` and differed only by their hash strings). (a) red when same_output is true for
    // any two present steps (both present only); (b) prints the boolean.
    const runA = makeRun([
      makeSnap('step_a', 'hashA'),
      makeSnap('step_b', 'hashB1', 'success', 100, { v: 1 }),
    ]);
    const runB = makeRun([
      makeSnap('step_a', 'hashA'),
      makeSnap('step_b', 'hashB2', 'success', 100, { v: 2 }),
    ]);
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

describe('fix-run-diff-field-order — realm run diff compares the outputs, in any field order', () => {
  const at = (stepId: string, output: Record<string, unknown>) =>
    captureEvidence({
      stepId,
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      completedAt: new Date('2026-01-01T00:00:01.000Z'),
      input: {},
      output,
    });

  it('C1: the same output with its fields in another order, nested included — the stored hashes differ, and the step reads the same', () => {
    const a = at('step_a', { zeta: 1, rent: 1200, tenant: 'A', terms: { a: 1, b: 2 } });
    const b = at('step_a', { tenant: 'A', terms: { b: 2, a: 1 }, rent: 1200, zeta: 1 });
    const row = diffRuns(makeRun([a]), makeRun([b]))[0]!;
    // (a) red: `hashesDiffer` when the hash ignores field order (#840) — the docs' hash sentence
    //     ("can have a different hash") must change with it; `sameOutput` when the mark compares the
    //     stored hashes again; (b) prints the two 8-character prefixes and the boolean.
    expect({
      hashes: [a.evidence_hash.slice(0, 8), b.evidence_hash.slice(0, 8)],
      hashesDiffer: a.evidence_hash !== b.evidence_hash,
      sameOutput: row.same_output,
    }).toEqual({
      hashes: [a.evidence_hash.slice(0, 8), b.evidence_hash.slice(0, 8)],
      hashesDiffer: true,
      sameOutput: true,
    });
  });

  it('C2: a list keeps its order — `{v:[1,2]}` and `{v:[2,1]}` are different outputs', () => {
    const rows = diffRuns(
      makeRun([makeSnap('step_a', 'h', 'success', 100, { v: [1, 2] })]),
      makeRun([makeSnap('step_a', 'h', 'success', 100, { v: [2, 1] })]),
    );
    // (a) red when the comparison sorts lists; (b) prints the boolean.
    expect(rows[0]!.same_output).toBe(false);
  });

  it('C3: outputs that differ in one value but carry the same stored hash string are different — the mark reads the outputs, not the hashes', () => {
    const rows = diffRuns(
      makeRun([makeSnap('step_a', 'samehash', 'success', 100, { rent: 1200 })]),
      makeRun([makeSnap('step_a', 'samehash', 'success', 100, { rent: 1300 })]),
    );
    // (a) red when the mark compares the stored hashes; (b) prints the boolean.
    expect(rows[0]!.same_output).toBe(false);
  });

  it("C4: values compare strictly — `{n:1}` and `{n:'1'}` are different outputs", () => {
    const rows = diffRuns(
      makeRun([makeSnap('step_a', 'h', 'success', 100, { n: 1 })]),
      makeRun([makeSnap('step_a', 'h', 'success', 100, { n: '1' })]),
    );
    // (a) red when the comparison is loose (node:assert's deepEqual takes 1 for '1'); (b) prints
    //     the boolean.
    expect(rows[0]!.same_output).toBe(false);
  });

  it('C5: the reading reference says what the mark and the hash columns compare — each sentence executed by the cell named beside it', () => {
    const page = readFileSync(
      fileURLToPath(
        new URL('../../../../docs/reference/cli/realm-run-reading.md', import.meta.url),
      ),
      'utf8',
    ).replace(/\s+/g, ' ');
    // "the fields in any order": C1; "a list's items in the same order": C2; "`≠` if not" and
    // "blank if the step is missing from either run": C6. (a) red when the page no longer says it
    // word for word; (b) prints which sentence is missing.
    expect(
      page.includes(
        "`=` if the step has the same status and the same output in both runs (the same fields and values, the fields in any order, a list's items in the same order), `≠` if not, and blank if the step is missing from either run.",
      ),
      'realm-run-reading.md no longer says what the mark compares',
    ).toBe(true);
    // "can have a different hash": C1's hash half. (a) red when the page no longer says it word for
    // word; (b) prints which sentence is missing.
    expect(
      page.includes(
        "The first 8 characters of the hash of the step's output as recorded. The same output with its fields in another order can have a different hash, so the mark between the status columns, not the hashes, compares the outputs.",
      ),
      'realm-run-reading.md no longer says what the hash columns hold',
    ).toBe(true);
  });

  it('C6: the mark — blank for a step missing from either run; `=` for the same output and status; `≠` for another status or another output', () => {
    const row = (over: Partial<Parameters<typeof diffSymbol>[0]>) =>
      diffSymbol({
        step_id: 's',
        status_a: 'success',
        status_b: 'success',
        hash_a: 'a',
        hash_b: 'b',
        duration_a_ms: 0,
        duration_b_ms: 0,
        same_output: true,
        same_status: true,
        ...over,
      });
    // (a) red: `missing` when a missing step is marked; `otherStatus` when the mark reads the output
    //     alone; (b) prints each mark (≠ may carry its colour codes, so it is asserted as contained).
    expect({
      missing: row({ status_b: 'missing', same_status: false, same_output: false }),
      same: row({}),
      otherStatus: row({ status_b: 'error', same_status: false }).includes('\u2260'),
      otherOutput: row({ same_output: false }).includes('\u2260'),
    }).toEqual({ missing: ' ', same: '=', otherStatus: true, otherOutput: true });
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
