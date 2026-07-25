// get_run_state's defaulted_steps field (issue #232) — read-time derivation via the shared
// deriveDefaultedSteps helper, computed UNIFORMLY regardless of how the run sealed.
//
// A minimal hand-rolled RunStore double — handleGetRunState only ever calls `.get()`, so the
// double only needs to implement that faithfully (mirrors get-run-state-run-health.test.ts's own
// double, minus the fidelity-gate concerns that are out of scope here).
import { describe, it, expect } from 'vitest';
import type { RunRecord, RunStore, EvidenceSnapshot } from '@sensigo/realm';
import { deriveDefaultedSteps } from '@sensigo/realm';
import { handleGetRunState } from './get-run-state.js';

function makeSnapshot(stepId: string, overrides: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot {
  return {
    step_id: stepId,
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:01.000Z',
    duration_ms: 1,
    input_summary: {},
    output_summary: {},
    status: 'success',
    evidence_hash: 'x',
    ...overrides,
  };
}

function defaultSettledSnapshot(stepId: string): EvidenceSnapshot {
  return makeSnapshot(stepId, {
    diagnostics: { input_token_estimate: 1, precondition_trace: [], settled_by_default: true },
  });
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
    run_phase: 'completed',
    version: 1,
    params: {},
    evidence: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: true,
    ...over,
  };
}

function makeStore(run: RunRecord): RunStore {
  return {
    persistsClaims: true,
    async get() {
      return run;
    },
    async create() {
      throw new Error('not exercised by get_run_state');
    },
    async update() {
      throw new Error('not exercised by get_run_state');
    },
    async list() {
      throw new Error('not exercised by get_run_state');
    },
    async claimStep() {
      throw new Error('not exercised by get_run_state');
    },
  };
}

describe('get_run_state — defaulted_steps (issue #232)', () => {
  it('AC-1 failure path: a FAILED run that default-settled step "draft" earlier ⇒ defaulted_steps: ["draft"], without scanning evidence', async () => {
    const run = makeRun({
      run_phase: 'failed',
      failed_steps: ['finish'],
      evidence: [defaultSettledSnapshot('draft'), makeSnapshot('finish', { status: 'error' })],
    });
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: makeStore(run) });

    expect(summary.run_phase).toBe('failed');
    expect(summary.defaulted_steps).toEqual(['draft']);
  });

  it('AC-1 abort path: an ABORTED run that default-settled step "draft" earlier ⇒ defaulted_steps: ["draft"]', async () => {
    const run = makeRun({
      run_phase: 'aborted',
      evidence: [defaultSettledSnapshot('draft')],
    });
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: makeStore(run) });

    expect(summary.run_phase).toBe('aborted');
    expect(summary.defaulted_steps).toEqual(['draft']);
  });

  it('AC-2 exact match: defaulted_steps equals exactly the set of evidence[].diagnostics.settled_by_default===true step_ids, including a multi-default and a dedup case', async () => {
    const evidence = [
      defaultSettledSnapshot('first'),
      makeSnapshot('untouched'), // not settled
      defaultSettledSnapshot('second'),
      defaultSettledSnapshot('first'), // duplicate step_id, still settled — must not double-count
    ];
    const run = makeRun({ run_phase: 'failed', evidence });
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: makeStore(run) });

    expect(summary.defaulted_steps).toEqual(deriveDefaultedSteps(evidence));
    expect(summary.defaulted_steps).toEqual(['first', 'second']);
  });

  it('AC-4 complete-run parity: for a COMPLETE run, the derived defaulted_steps equals the persisted RunRecord.defaulted_steps', async () => {
    const evidence = [defaultSettledSnapshot('draft'), makeSnapshot('finish')];
    // Stamped exactly as stampDefaultedSteps would at the 'complete' seal (issue #220 PR-2) — the
    // persisted-field shape this run-level parity check compares against.
    const run = makeRun({
      run_phase: 'completed',
      completed_steps: ['draft', 'finish'],
      evidence,
      defaulted_steps: deriveDefaultedSteps(evidence),
    });
    expect(run.defaulted_steps).toEqual(['draft']); // sanity on the fixture itself

    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: makeStore(run) });
    expect(summary.defaulted_steps).toEqual(run.defaulted_steps);
  });

  it('AC-3 negative: a run with NO default-settled step ⇒ defaulted_steps is ABSENT, never an empty array', async () => {
    const run = makeRun({
      run_phase: 'completed',
      completed_steps: ['draft'],
      evidence: [makeSnapshot('draft')],
    });
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: makeStore(run) });

    expect(summary.defaulted_steps).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(summary, 'defaulted_steps')).toBe(false);
  });

  it('AC-3 negative, empty evidence ⇒ defaulted_steps is ABSENT', async () => {
    const run = makeRun({ run_phase: 'completed', evidence: [] });
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: makeStore(run) });

    expect(summary.defaulted_steps).toBeUndefined();
  });
});
