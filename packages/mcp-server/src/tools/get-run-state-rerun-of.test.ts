// issue #558 PR-C (C-6): get_run_state carries the supersede link.
//
// The sibling pattern of `get-run-state-terminal-reason.test.ts`: `rerun_of` is an additive,
// verbatim echo of `RunRecord.rerun_of`, present only when the record carries it. There is no
// `keyof RunRecord` disclosure registry to join for this surface, so these cells ARE the parity
// guard — the field is on ONE explicit route and nothing else would notice it going missing.
import { describe, it, expect } from 'vitest';
import type { RunRecord, RunStore } from '@sensigo/realm';
import { handleGetRunState } from './get-run-state.js';

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
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: false,
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

describe('get_run_state — rerun_of (issue #558 PR-C)', () => {
  it('present: a superseding run echoes the id of the run it replaced, verbatim', async () => {
    const run = makeRun({
      idempotency_key: 'k4',
      rerun_of: '11111111-2222-3333-4444-555555555555',
    });
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: makeStore(run) });

    expect(summary.rerun_of).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('absent: a first run under a key carries no link, and the KEY is not present either', async () => {
    const run = makeRun({ idempotency_key: 'k4' });
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: makeStore(run) });

    expect(summary.rerun_of).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(summary, 'rerun_of')).toBe(false);
  });
});
