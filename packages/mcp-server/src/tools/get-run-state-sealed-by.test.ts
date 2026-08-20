// get_run_state's sealed_by disclosure (issue #367, part 5) — the ruling, the classifier marker,
// and the deterministic-arm step, additive beside `sealed_by_arm`.
//
// Two rules govern every cell here. Keys are ABSENT when the underlying field is absent — never
// null, because "no walk ran" and "the walk found nothing" are different facts. And the step is
// emitted ONLY where the arm makes it the seal's identity; on a `complete`/`step_failure` seal the
// recorded step is whichever one settled last, and this surface's readers are agents — the readers
// most likely to take a named step as THE culprit, which is the misreading #373 exists to prevent.
//
// A minimal hand-rolled RunStore double (the sibling files' precedent) — handleGetRunState only
// ever calls `.get()`.
import { describe, it, expect } from 'vitest';
import type { RunRecord, RunStore, SealedBy } from '@sensigo/realm';
import { handleGetRunState } from './get-run-state.js';

const RULING = {
  by: 'mihai',
  at: '2026-08-21T00:00:00.000Z',
  previous_arm: 'complete' as const,
  reason: 'the guard is what stopped this run',
};

function makeRun(sealedBy: SealedBy | undefined, over: Partial<RunRecord> = {}): RunRecord {
  const base = {
    id: 'r1',
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'aborted',
    version: 1,
    params: {},
    evidence: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: true,
    ...over,
  } as RunRecord;
  // Assigned rather than spread: under `exactOptionalPropertyTypes` an explicit `undefined` is not
  // the same as an absent key, and the absence cells below depend on the difference being real.
  return sealedBy === undefined ? base : { ...base, sealed_by: sealedBy };
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

const state = (run: RunRecord) => handleGetRunState({ run_id: 'r1' }, { runStore: makeStore(run) });

describe('get_run_state — sealed_by_adjudicated (issue #367)', () => {
  it('present: the ruling passes through as one whole object, field for field', async () => {
    // Verbatim matters more here than anywhere else on this surface: a consumer that receives
    // `by` and `at` but no `reason` has been handed half a provenance record and no way to know it.
    const summary = await state(makeRun({ arm: 'guard_abort', step: 'g', adjudicated: RULING }));
    expect(summary.sealed_by_adjudicated).toEqual(RULING);
  });

  it('present: a null previous_arm survives as null — it is the first-stamp fact, not a gap', async () => {
    const ruling = { ...RULING, previous_arm: null };
    const summary = await state(makeRun({ arm: 'guard_abort', adjudicated: ruling }));
    expect(summary.sealed_by_adjudicated).toEqual(ruling);
    expect(summary.sealed_by_adjudicated?.previous_arm).toBeNull();
  });

  it('absent: an unruled seal omits the key entirely', async () => {
    const summary = await state(makeRun({ arm: 'guard_abort', step: 'g' }));
    expect('sealed_by_adjudicated' in summary).toBe(false);
  });
});

describe('get_run_state — sealed_by_classified (issue #367)', () => {
  it('present: a classifier-recovered seal says so', async () => {
    const summary = await state(makeRun({ arm: 'complete', classified: true }));
    expect(summary.sealed_by_classified).toBe(true);
  });

  it('absent: a seal a writer stamped omits the key', async () => {
    const summary = await state(makeRun({ arm: 'complete' }));
    expect('sealed_by_classified' in summary).toBe(false);
  });
});

describe('get_run_state — sealed_by_step (issue #367)', () => {
  it('present: a guard abort names the step, because the guard IS the seal', async () => {
    const summary = await state(makeRun({ arm: 'guard_abort', step: 'g' }));
    expect(summary.sealed_by_step).toBe('g');
  });

  it('ABSENT for a step_failure seal that carries a step — a settle-order artifact is not a culprit', async () => {
    // The discriminating cell. The record still holds `beta`; this surface refuses to hand an
    // agent a single name for a run that failed in two places.
    const summary = await state(
      makeRun(
        { arm: 'step_failure', step: 'beta' },
        { run_phase: 'failed', failed_steps: ['alpha', 'beta'] },
      ),
    );
    expect(summary.sealed_by_arm).toBe('step_failure');
    expect('sealed_by_step' in summary).toBe(false);
  });

  it('absent: a seal with no recorded step omits the key', async () => {
    const summary = await state(makeRun({ arm: 'gate_expiry_abort' }));
    expect('sealed_by_step' in summary).toBe(false);
  });
});

describe('get_run_state — the whole seal block (issue #367)', () => {
  it('emits exactly the four seal keys and nothing else when every field is set', async () => {
    // A shape-drift pin: an extra or renamed key here is a consumer break, and no other cell in
    // this file would see it.
    const summary = await state(
      makeRun({ arm: 'guard_abort', step: 'g', classified: true, adjudicated: RULING }),
    );
    expect(
      Object.keys(summary)
        .filter((k) => k.startsWith('sealed_by'))
        .sort(),
    ).toEqual(['sealed_by_adjudicated', 'sealed_by_arm', 'sealed_by_classified', 'sealed_by_step']);
  });

  it('emits no seal key at all for an unsealed run', async () => {
    const summary = await state(
      makeRun(undefined, { terminal_state: false, run_phase: 'running' }),
    );
    expect(Object.keys(summary).filter((k) => k.startsWith('sealed_by'))).toEqual([]);
  });
});
