// InMemoryStore parity for the per-claim liveness clock (issue #101) — mirrors JsonFileStore so
// reclaim/detection are testable on the testing default store.
import { describe, it, expect } from 'vitest';
import { InMemoryStore } from './in-memory-store.js';
import {
  runStoreFidelityContract,
  type RunStoreFidelityLaw,
} from './run-store-fidelity-contract.js';
import { WorkflowError } from '@sensigo/realm';
import type {
  WorkflowDefinition,
  RunStore,
  RunRecord,
  CreateRunOptions,
  LoadBearingRunRecordField,
} from '@sensigo/realm';

const autoFree: WorkflowDefinition = {
  id: 'p',
  name: 'Auto free',
  version: 1,
  steps: { work: { description: 'w', execution: 'auto', depends_on: [], handler: 'h' } },
};
const agentWf: WorkflowDefinition = {
  id: 'a',
  name: 'Agent',
  version: 1,
  steps: { work: { description: 'w', execution: 'agent', depends_on: [] } },
};

describe('InMemoryStore — claims parity (#101)', () => {
  it('declares persistsClaims', () => {
    expect(new InMemoryStore().persistsClaims).toBe(true);
  });

  it('claimStep writes a concrete deadline (auto step, finalizer-free) atomically with in_progress', async () => {
    const store = new InMemoryStore();
    const { run } = await store.create({ workflowId: 'p', workflowVersion: 1, params: {} });
    const claimed = await store.claimStep(run.id, 'work', autoFree);
    expect(claimed.in_progress_steps).toContain('work');
    expect(claimed.claims?.['work']?.deadline).toEqual(expect.any(String));
    expect(new Date(claimed.claims!['work']!.deadline!).getTime()).toBeGreaterThan(Date.now());
  });

  it('claimStep writes deadline: null for an agent step', async () => {
    const store = new InMemoryStore();
    const { run } = await store.create({ workflowId: 'a', workflowVersion: 1, params: {} });
    const claimed = await store.claimStep(run.id, 'work', agentWf);
    expect(claimed.claims?.['work']?.deadline).toBeNull();
  });

  // issue #279 (increment 1, PR-A): claimStep now mints a fencing token alongside the deadline —
  // dormant until PR-B, but real/present in every claim record starting with this PR.
  it('claimStep mints a token alongside the deadline (issue #279, dormant until PR-B)', async () => {
    const store = new InMemoryStore();
    const { run } = await store.create({ workflowId: 'a', workflowVersion: 1, params: {} });
    const claimed = await store.claimStep(run.id, 'work', agentWf);
    expect(claimed.claims?.['work']?.token).toEqual(expect.any(String));
    expect(claimed.claims!['work']!.token!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// RunStore field-fidelity + claimStep single-owner TCK conformance (issue #188, PR-2).
// ---------------------------------------------------------------------------

const ALL_FIELDS: LoadBearingRunRecordField[] = [
  'capability_blocks',
  'workflow_context_snapshots',
  'extension_identity',
  'validation_rejections',
  'defaulted_steps',
  // issue #279 (increment 1, PR-A): declared alongside settleStep — declaration-coherence.
  'settled',
  'finalizer_ledger',
];

describe('InMemoryStore — RunStore fidelity TCK conformance (issue #188)', () => {
  it('declares the full LoadBearingRunRecordField set (parity with JsonFileStore)', () => {
    const store = new InMemoryStore();
    for (const field of ALL_FIELDS) {
      expect(store.persistedRunRecordFields?.has(field)).toBe(true);
    }
  });

  const laws: RunStoreFidelityLaw[] = [
    'FIDELITY_HONESTY',
    'CLAIM_SINGLE_OWNER',
    'SEALED_BY_ROUNDTRIP',
  ];
  for (const law of laws) {
    it(`conforms to ${law}`, async () => {
      const store = new InMemoryStore();
      const cases = runStoreFidelityContract({ store, definition: agentWf, stepName: 'work' });
      const matching = cases.filter((c) => c.law === law);
      expect(matching.length).toBeGreaterThan(0);
      for (const c of matching) {
        await c.run();
      }
    });
  }
});

/**
 * A deliberately DISHONEST RunStore (issue #188): declares it persists `extension_identity` in
 * `persistedRunRecordFields`, but silently drops the field on every `update` — proves the TCK's
 * FIDELITY_HONESTY law actually catches a lying store, rather than passing vacuously. Mirrors
 * InMemoryStore's own logic for everything else (a faithful store in every OTHER respect), so the
 * ONLY thing under test is the one deliberate lie.
 */
class FieldDroppingFakeStore implements RunStore {
  private readonly runs = new Map<string, RunRecord>();
  readonly persistsClaims = true;
  readonly persistedRunRecordFields: ReadonlySet<LoadBearingRunRecordField> = new Set([
    'extension_identity',
  ]);

  async create(options: CreateRunOptions): Promise<{ run: RunRecord; created: boolean }> {
    const now = new Date().toISOString();
    const record: RunRecord = {
      id: crypto.randomUUID(),
      workflow_id: options.workflowId,
      workflow_version: options.workflowVersion,
      completed_steps: [],
      in_progress_steps: [],
      failed_steps: [],
      skipped_steps: [],
      run_phase: 'running',
      version: 0,
      params: options.params,
      evidence: [],
      created_at: now,
      updated_at: now,
      terminal_state: false,
    };
    this.runs.set(record.id, record);
    return { run: record, created: true };
  }

  async get(runId: string): Promise<RunRecord> {
    const record = this.runs.get(runId);
    if (record === undefined) {
      throw new WorkflowError(`Run '${runId}' not found`, {
        code: 'STATE_RUN_NOT_FOUND',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
    return record;
  }

  async update(record: RunRecord): Promise<RunRecord> {
    // THE LIE: extension_identity is stripped here despite being declared persisted above.
    const { extension_identity: _dropped, ...rest } = record;
    const updated: RunRecord = {
      ...rest,
      version: record.version + 1,
      updated_at: new Date().toISOString(),
    };
    this.runs.set(updated.id, updated);
    return updated;
  }

  async claimStep(): Promise<RunRecord> {
    throw new Error('not exercised by the fidelity-honesty law');
  }

  async list(workflowId?: string): Promise<RunRecord[]> {
    const all = [...this.runs.values()];
    return workflowId !== undefined ? all.filter((r) => r.workflow_id === workflowId) : all;
  }
}

describe('FieldDroppingFakeStore — the TCK catches a dishonest store (issue #188)', () => {
  it('FIDELITY_HONESTY fails a store that declares extension_identity but drops it on write', async () => {
    const store = new FieldDroppingFakeStore();
    const cases = runStoreFidelityContract({ store, definition: agentWf, stepName: 'work' });
    const target = cases.find(
      (c) => c.law === 'FIDELITY_HONESTY' && c.name.includes('extension_identity'),
    );
    expect(target, 'expected a FIDELITY_HONESTY case for extension_identity').toBeDefined();
    await expect(target!.run()).rejects.toThrow(/DISHONEST/);
  });
});

// issue #558 PR-C (C-6): the in-memory twin of JsonFileStore's supersede link. The same journey,
// so an external implementer reading the testing store sees the same contract.
describe('InMemoryStore — rerun_of, the supersede link (issue #558 PR-C)', () => {
  const opts = { workflowId: 'wf-1', workflowVersion: 1, params: {}, idempotencyKey: 'k4' };

  it('a `rerun` over a terminal run stamps rerun_of; `reuse` and a fresh key do not', async () => {
    const store = new InMemoryStore();
    const first = await store.create({ ...opts });
    expect(first.created).toBe(true);
    expect(first.run.rerun_of).toBeUndefined();
    await store.update({
      ...first.run,
      run_phase: 'abandoned',
      terminal_state: true,
      abandoned_at: new Date().toISOString(),
      sealed_by: { arm: 'abandon_requested' },
      terminal_reason: 'Abandoned via realm run abandon',
    });

    const reused = await store.create({ ...opts, onTerminalMatch: 'reuse' });
    expect(reused.created).toBe(false);
    expect(reused.run.rerun_of).toBeUndefined();

    const rerun = await store.create({ ...opts, onTerminalMatch: 'rerun' });
    expect(rerun.created).toBe(true);
    expect(rerun.run.id).not.toBe(first.run.id);
    expect(rerun.run.rerun_of).toBe(first.run.id);

    const fresh = await store.create({ ...opts, idempotencyKey: 'never-seen' });
    expect(fresh.run.rerun_of).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(fresh.run, 'rerun_of')).toBe(false);
  });

  it('a VANISHED mapped run supersedes nothing, so the fresh run carries no link', async () => {
    // The `existing === undefined` fall-through: the key index points at a run that is gone.
    // Nothing was superseded, so claiming a lineage would be a fabricated fact.
    const store = new InMemoryStore();
    const first = await store.create({ ...opts });
    // Element access is TypeScript's deliberate escape hatch for a private member — the ONLY way
    // to make a mapped run vanish underneath the key index (no public verb deletes a run here).
    store['runs'].delete(first.run.id);

    const second = await store.create({ ...opts, onTerminalMatch: 'rerun' });

    expect(second.created).toBe(true);
    expect(second.run.rerun_of).toBeUndefined();
  });
});
