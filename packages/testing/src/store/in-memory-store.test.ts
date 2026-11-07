// InMemoryStore parity for the per-claim liveness clock (issue #101) — mirrors JsonFileStore so
// reclaim/detection are testable on the testing default store.
import { describe, it, expect } from 'vitest';
import { InMemoryStore } from './in-memory-store.js';
import {
  runStoreFidelityContract,
  RUN_STORE_FIDELITY_LAWS,
  type RunStoreFidelityLaw,
} from './run-store-fidelity-contract.js';
import {
  WorkflowError,
  floorAtRecord,
  systemClock,
  takeRawReading,
  takeReading,
  writtenSnapshot,
} from '@sensigo/realm';
import type {
  WorkflowDefinition,
  RunStore,
  RunRecord,
  CreateRunOptions,
  LoadBearingRunRecordField,
} from '@sensigo/realm';
import type { Snapshot, Listing, CreateResult, StoreSettlement } from '@sensigo/realm';

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
    const { record: run } = await store.create({ workflowId: 'p', workflowVersion: 1, params: {} });
    const { record: claimed } = await store.claimStep(run.id, 'work', autoFree);
    expect(claimed.in_progress_steps).toContain('work');
    expect(claimed.claims?.['work']?.deadline).toEqual(expect.any(String));
    expect(new Date(claimed.claims!['work']!.deadline!).getTime()).toBeGreaterThan(Date.now());
  });

  it('claimStep writes deadline: null for an agent step', async () => {
    const store = new InMemoryStore();
    const { record: run } = await store.create({ workflowId: 'a', workflowVersion: 1, params: {} });
    const { record: claimed } = await store.claimStep(run.id, 'work', agentWf);
    expect(claimed.claims?.['work']?.deadline).toBeNull();
  });

  // issue #279 (increment 1, PR-A): claimStep now mints a fencing token alongside the deadline —
  // dormant until PR-B, but real/present in every claim record starting with this PR.
  it('claimStep mints a token alongside the deadline (issue #279, dormant until PR-B)', async () => {
    const store = new InMemoryStore();
    const { record: run } = await store.create({ workflowId: 'a', workflowVersion: 1, params: {} });
    const { record: claimed } = await store.claimStep(run.id, 'work', agentWf);
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

/**
 * The laws of this contract that THIS file deliberately does not run, each with its reason
 * (issue #625). Empty: InMemoryStore keeps claims, so every law of this contract applies to it.
 */
const NOT_RUN: Partial<Record<RunStoreFidelityLaw, string>> = {};

/** The laws this file runs: every exported law, minus the ones named in NOT_RUN above. */
const LAWS: readonly RunStoreFidelityLaw[] = RUN_STORE_FIDELITY_LAWS.filter(
  (law) => !(law in NOT_RUN),
);

describe('InMemoryStore — RunStore fidelity TCK conformance (issue #188)', () => {
  it('declares the full LoadBearingRunRecordField set (parity with JsonFileStore)', () => {
    const store = new InMemoryStore();
    for (const field of ALL_FIELDS) {
      expect(store.persistedRunRecordFields?.has(field)).toBe(true);
    }
  });

  for (const law of LAWS) {
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

describe('InMemoryStore RunStore fidelity wiring — the run list is derived from the contract', () => {
  // (a) red when a law is dropped from the run list WITHOUT being named in NOT_RUN, or NOT_RUN
  //     names a law the contract no longer exports; (b) prints the unaccounted / unknown laws.
  it('every exported law is either run or named in NOT_RUN, and NOT_RUN names only exported laws (issue #625)', () => {
    const exported: readonly string[] = RUN_STORE_FIDELITY_LAWS;
    const named = Object.keys(NOT_RUN);
    expect(named.filter((law) => !exported.includes(law))).toEqual([]);
    expect([...LAWS, ...named].sort()).toEqual([...exported].sort());
    for (const reason of Object.values(NOT_RUN)) expect(reason).not.toBe('');
  });
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
  /** #715 (b): every store reads the time only through its clock. */
  readonly clock = systemClock;

  async create(options: CreateRunOptions): Promise<CreateResult> {
    const at = takeReading(this.clock);
    const now = at.toISOString();
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
    return { ...writtenSnapshot(record, at), created: true };
  }

  async get(runId: string): Promise<Snapshot> {
    const r = takeRawReading(this.clock);
    const record = this.runs.get(runId);
    if (record === undefined) {
      throw new WorkflowError(`Run '${runId}' not found`, {
        code: 'STATE_RUN_NOT_FOUND',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
    return writtenSnapshot(record, floorAtRecord(r, record));
  }

  async update(record: RunRecord): Promise<Snapshot> {
    const at = takeReading(this.clock, this.runs.get(record.id));
    // THE LIE: extension_identity is stripped here despite being declared persisted above.
    const { extension_identity: _dropped, ...rest } = record;
    const updated: RunRecord = {
      ...rest,
      version: record.version + 1,
      updated_at: at.toISOString(),
    };
    this.runs.set(updated.id, updated);
    return writtenSnapshot(updated, at);
  }

  async claimStep(): Promise<Snapshot> {
    throw new Error('not exercised by the fidelity-honesty law');
  }

  async settleStep(): Promise<StoreSettlement> {
    throw new Error('not exercised by the fidelity-honesty law');
  }

  async list(workflowId?: string): Promise<Listing> {
    const r = takeRawReading(this.clock);
    const all = [...this.runs.values()];
    const kept =
      workflowId !== undefined ? all.filter((rec) => rec.workflow_id === workflowId) : all;
    return {
      snapshots: kept.map((rec) => writtenSnapshot(rec, floorAtRecord(r, rec))),
      read_at: r,
      consistent_snapshot: true,
    };
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

/**
 * #616 PR-1a unit 16a — the ways a store can misreport a create's `created`, one per mode. Each is
 * InMemoryStore with ONE thing broken on ONE branch of `create` (the branch is read from what the
 * real store did): an unkeyed create, a keyed create on a fresh key, a keyed create that reuses the
 * live run, or a keyed `rerun` that supersedes a finished one. `reuse-omits` is the shape a store
 * that never sets `created` on its dedupe path has; `omits-everywhere` never sets it at all.
 */
type CreatedMode =
  | 'unkeyed-false'
  | 'fresh-false'
  | 'reuse-true'
  | 'reuse-new-run'
  | 'supersede-false'
  | 'supersede-no-link'
  | 'reuse-omits'
  | 'omits-everywhere';

class CreatedMisreportingStore extends InMemoryStore {
  constructor(private readonly mode: CreatedMode) {
    super();
  }

  override async create(options: CreateRunOptions): Promise<CreateResult> {
    const result = await super.create(options);
    const branch = !result.created
      ? 'reuse'
      : result.record.rerun_of !== undefined
        ? 'supersede'
        : options.idempotencyKey !== undefined
          ? 'fresh'
          : 'unkeyed';
    const omitted = (): CreateResult => {
      const { created: _created, ...rest } = result;
      return rest as CreateResult;
    };
    switch (this.mode) {
      case 'unkeyed-false':
        return branch === 'unkeyed' ? { ...result, created: false } : result;
      case 'fresh-false':
        return branch === 'fresh' ? { ...result, created: false } : result;
      case 'reuse-true':
        return branch === 'reuse' ? { ...result, created: true } : result;
      case 'reuse-new-run': {
        if (branch !== 'reuse') return result;
        const { idempotencyKey: _key, ...unkeyed } = options;
        return { ...(await super.create(unkeyed)), created: false };
      }
      case 'supersede-false':
        return branch === 'supersede' ? { ...result, created: false } : result;
      case 'supersede-no-link': {
        if (branch !== 'supersede') return result;
        const { rerun_of: _link, ...record } = result.record;
        return { ...result, record };
      }
      case 'reuse-omits':
        return branch === 'reuse' ? omitted() : result;
      case 'omits-everywhere':
        return omitted();
    }
  }
}

/** Each CREATE_REPORTS_CREATED case run in order on ONE store (as the wirings run a law's cases):
 *  `passed`, or its failure message. */
async function createdOutcomes(store: RunStore): Promise<string[]> {
  const cases = runStoreFidelityContract({ store, definition: agentWf, stepName: 'work' }).filter(
    (c) => c.law === 'CREATE_REPORTS_CREATED',
  );
  const got: string[] = [];
  for (const c of cases) {
    got.push(
      await c.run().then(
        () => 'passed',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      ),
    );
  }
  return got;
}

const UNKEYED = 'CREATE_REPORTS_CREATED (an unkeyed create): ';
const FRESH = 'CREATE_REPORTS_CREATED (a keyed create on a fresh key): ';
const REUSE = 'CREATE_REPORTS_CREATED (a keyed create that reuses the live run under its key): ';
const RERUN =
  "CREATE_REPORTS_CREATED (a keyed create with onTerminalMatch 'rerun' over a finished run): ";
const MUST_CREATE = 'a create that makes a new run must report created: true; the store reported ';
const ID = '[0-9a-f-]{36}';
const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('#616 PR-1a unit 16a — CREATE_REPORTS_CREATED fails the store that misreports created, on that branch alone', () => {
  // Each row: (1) can it fail — the break is deleting the case (its message becomes `passed`), or,
  // for c2 and d2, deleting that conjunct of the case (the id check; the rerun_of check); (2) it
  // prints the four outcomes, each `passed` or the law's message (the branch, `created` as the
  // store reported it, and run ids — no value from the environment).
  const rows: ReadonlyArray<[CreatedMode, string, Array<string | RegExp>]> = [
    [
      'unkeyed-false',
      '(a)',
      [`${UNKEYED}${MUST_CREATE}created: false`, 'passed', 'passed', 'passed'],
    ],
    ['fresh-false', '(b)', ['passed', `${FRESH}${MUST_CREATE}created: false`, 'passed', 'passed']],
    [
      'reuse-true',
      '(c1)',
      [
        'passed',
        'passed',
        `${REUSE}it must report created: false; the store reported created: true`,
        'passed',
      ],
    ],
    [
      'reuse-new-run',
      '(c2)',
      [
        'passed',
        'passed',
        new RegExp(
          `^${escaped(REUSE)}it must return that run \\(${ID}\\); the store returned ${ID} and reported created: false$`,
        ),
        'passed',
      ],
    ],
    [
      'supersede-false',
      '(d1)',
      ['passed', 'passed', 'passed', `${RERUN}${MUST_CREATE}created: false`],
    ],
    [
      'supersede-no-link',
      '(d2)',
      [
        'passed',
        'passed',
        'passed',
        new RegExp(
          `^${escaped(RERUN)}the new run's rerun_of must name the run it replaces \\(${ID}\\); the store wrote no rerun_of$`,
        ),
      ],
    ],
  ];
  for (const [mode, conjunct, want] of rows) {
    it(`${conjunct} the '${mode}' store fails only its case, with the law's message`, async () => {
      const got = await createdOutcomes(new CreatedMisreportingStore(mode));
      expect(got).toEqual(want.map((w) => (typeof w === 'string' ? w : expect.stringMatching(w))));
    });
  }

  it('a store whose dedupe branch leaves created out, while its fresh branches report true, fails (c) alone: the check is `=== false`, not a falsy created', async () => {
    // (1) red when case (c) tests `!result.created` instead of `created !== false`: a left-out
    //     `created` then passes as a reuse; (2) prints the four outcomes.
    expect(await createdOutcomes(new CreatedMisreportingStore('reuse-omits'))).toEqual([
      'passed',
      'passed',
      `${REUSE}it must report created: false; the store reported \`created\` left out`,
      'passed',
    ]);
  });

  it('a store whose create leaves created out on every branch fails all four cases of the fidelity family', async () => {
    // (1) red when the law is removed from the contract (no case runs: an empty list); (2) prints the
    //     outcomes.
    expect(await createdOutcomes(new CreatedMisreportingStore('omits-everywhere'))).toEqual([
      `${UNKEYED}${MUST_CREATE}\`created\` left out`,
      `${FRESH}${MUST_CREATE}\`created\` left out`,
      `${REUSE}it must report created: false; the store reported \`created\` left out`,
      `${RERUN}${MUST_CREATE}\`created\` left out`,
    ]);
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
    expect(first.record.rerun_of).toBeUndefined();
    await store.update({
      ...first.record,
      run_phase: 'abandoned',
      terminal_state: true,
      abandoned_at: new Date().toISOString(),
      sealed_by: { arm: 'abandon_requested' },
      terminal_reason: 'Abandoned via realm run abandon',
    });

    const reused = await store.create({ ...opts, onTerminalMatch: 'reuse' });
    expect(reused.created).toBe(false);
    expect(reused.record.rerun_of).toBeUndefined();

    const rerun = await store.create({ ...opts, onTerminalMatch: 'rerun' });
    expect(rerun.created).toBe(true);
    expect(rerun.record.id).not.toBe(first.record.id);
    expect(rerun.record.rerun_of).toBe(first.record.id);

    const fresh = await store.create({ ...opts, idempotencyKey: 'never-seen' });
    expect(fresh.record.rerun_of).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(fresh.record, 'rerun_of')).toBe(false);
  });

  it('a VANISHED mapped run supersedes nothing, so the fresh run carries no link', async () => {
    // The `existing === undefined` fall-through: the key index points at a run that is gone.
    // Nothing was superseded, so claiming a lineage would be a fabricated fact.
    const store = new InMemoryStore();
    const first = await store.create({ ...opts });
    // Element access is TypeScript's deliberate escape hatch for a private member — the ONLY way
    // to make a mapped run vanish underneath the key index (no public verb deletes a run here).
    store['runs'].delete(first.record.id);

    const second = await store.create({ ...opts, onTerminalMatch: 'rerun' });

    expect(second.created).toBe(true);
    expect(second.record.rerun_of).toBeUndefined();
  });
});
