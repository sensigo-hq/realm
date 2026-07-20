// get_run_state's capability_blocks field-fidelity gate (issue #188, PR-2).
//
// A minimal hand-rolled RunStore double — handleGetRunState only ever calls `.get()`, so the
// double only needs to implement that faithfully; every other method throws if reached (proving
// it never is).
import { describe, it, expect } from 'vitest';
import { JsonFileStore } from '@sensigo/realm';
import type { RunRecord, RunStore, LoadBearingRunRecordField } from '@sensigo/realm';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** A minimal RunStore double whose ONLY faithfully-implemented method is `get` (the only one
 *  handleGetRunState calls) — every other method throws if reached, proving it never is. */
function makeGetOnlyStore(
  run: RunRecord,
  persistedFields: LoadBearingRunRecordField[] | undefined,
): RunStore {
  return {
    persistsClaims: true,
    ...(persistedFields !== undefined
      ? { persistedRunRecordFields: new Set(persistedFields) }
      : {}),
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

describe('get_run_state — capability_blocks field-fidelity gate (issue #188)', () => {
  it('fires an honest warning when the store does NOT declare it persists capability_blocks', async () => {
    const store = makeGetOnlyStore(makeRun(), []); // declares an EMPTY set — persists nothing
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: store });
    expect(summary.warnings).toBeDefined();
    expect(summary.warnings!.some((w) => w.includes('capability_blocks'))).toBe(true);
  });

  it('fires the same warning when the store declares NO persistedRunRecordFields at all (fail-closed default)', async () => {
    const store = makeGetOnlyStore(makeRun(), undefined);
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: store });
    expect(summary.warnings).toBeDefined();
    expect(summary.warnings!.some((w) => w.includes('capability_blocks'))).toBe(true);
  });

  it('stays silent when the store DOES declare it persists capability_blocks', async () => {
    // issue #221: makeRun()'s default updated_at is far in the past — a claimless 'running' run
    // that old would now legitimately carry a never_claimed_idle run_health finding (and its
    // warnings-line companion). Pin a RECENT updated_at so this test keeps asserting ONLY fidelity
    // silence, not run-health silence (a materially different, still-untested claim).
    const store = makeGetOnlyStore(makeRun({ updated_at: new Date().toISOString() }), [
      'capability_blocks',
    ]);
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: store });
    expect(summary.warnings).toBeUndefined();
  });

  it('a real JsonFileStore (declares the full set) never surfaces the gate — local behavior unaffected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'get-run-state-fidelity-'));
    const runStore = new JsonFileStore(dir);
    const { run } = await runStore.create({ workflowId: 'wf', workflowVersion: 1, params: {} });
    const summary = await handleGetRunState({ run_id: run.id }, { runStore });
    expect(summary.warnings).toBeUndefined();
  });

  it('the gate is advisory only — capability_blocks/next_actions_status logic is unaffected by fidelity', async () => {
    const blockedRun = makeRun({
      capability_blocks: {
        blocked: {
          requirement: { kind: 'handler', name: 'missing_handler' },
          code: 'ENGINE_HANDLER_NOT_REGISTERED',
          at: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    const store = makeGetOnlyStore(blockedRun, []); // declares nothing — gate SHOULD fire
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: store });
    // The gate fires...
    expect(summary.warnings?.some((w) => w.includes('capability_blocks'))).toBe(true);
    // ...but the actual capability_blocks advisory + status are computed exactly as before,
    // from whatever the store DID return (the gate only adds honesty, never changes the read).
    expect(summary.next_actions_status).toBe('blocked_on_capability');
    expect(summary.capability_blocks).toHaveLength(1);
  });
});
