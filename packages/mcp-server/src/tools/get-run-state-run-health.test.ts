// get_run_state's run_health field + the run-health-presence warning line (issue #221).
//
// A minimal hand-rolled RunStore double — handleGetRunState only ever calls `.get()`, so the
// double only needs to implement that faithfully; every other method throws if reached, proving
// it never is (mirrors get-run-state-fidelity-gate.test.ts's own double).
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonWorkflowStore, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { RunRecord, RunStore, WorkflowDefinition } from '@sensigo/realm';
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
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z', // far in the past — idle by default
    terminal_state: false,
    ...over,
  };
}

/** A fully-declaring store (no fidelity gate ever fires) — isolates run_health behavior from the
 *  store-fidelity caveats already covered by get-run-state-fidelity-gate.test.ts. */
function makeFullFidelityStore(run: RunRecord): RunStore {
  return {
    persistsClaims: true,
    persistedRunRecordFields: new Set([
      'capability_blocks',
      'workflow_context_snapshots',
      'extension_identity',
    ]),
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

const basicDef: WorkflowDefinition = {
  id: 'wf',
  name: 'WF',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    draft: { description: 'd', execution: 'agent' },
  },
};

describe('get_run_state — run_health (issue #221)', () => {
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    workflowStore = new JsonWorkflowStore(await mkdtemp(join(tmpdir(), 'get-run-state-rh-')));
    await workflowStore.register(basicDef);
  });

  it("wedged fixture (idle, claimless, resolvable-workflow-with-an-eligible-agent-step) ⇒ next_actions_status STAYS 'ok' (status-invariant probe target), run_health present, ONE warning", async () => {
    // in_progress_steps stays EMPTY on purpose: the #101 claim-wedge carve-out in get-run-state.ts
    // only runs `if (run.in_progress_steps.length > 0)`, so this fixture is the one that isolates
    // run_health's own effect on next_actions_status from that pre-existing, unrelated override —
    // 'draft' is eligible and agent-executed, so status resolves 'ok' exactly as it would with no
    // run_health computation at all.
    const run = makeRun(); // default: running, in_progress_steps: [], updated_at far in the past
    const store = makeFullFidelityStore(run);
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: store, workflowStore });

    expect(summary.next_actions_status).toBe('ok');
    expect(summary.run_health).toBeDefined();
    expect(summary.run_health).toHaveLength(1);
    expect(summary.run_health![0]).toMatchObject({ kind: 'never_claimed_idle' });
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings![0]).toContain('run-health finding');
  });

  it("a stale claim on a running run ⇒ next_actions_status becomes 'claim_stale' via the PRE-EXISTING #101 carve-out (unaffected by run_health — run_health only ADDS the typed finding + warning, it never suppresses or replaces the #101 status override)", async () => {
    const run = makeRun({
      updated_at: new Date().toISOString(), // recent — isolates this fixture from never_claimed_idle
      in_progress_steps: ['work'],
      claims: { work: { deadline: new Date(Date.now() - 60_000).toISOString() } },
    });
    const store = makeFullFidelityStore(run);
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: store, workflowStore });

    expect(summary.next_actions_status).toBe('claim_stale');
    expect(summary.run_health).toBeDefined();
    expect(summary.run_health).toHaveLength(1);
    expect(summary.run_health![0]).toMatchObject({ kind: 'stale_claim', step: 'work' });
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings![0]).toContain('run-health finding');
  });

  it('an idle, claimless running run with an unresolvable workflow ⇒ run_health present (never_claimed_idle), status STAYS workflow_unresolved', async () => {
    const run = makeRun(); // default: running, in_progress_steps: [], updated_at far in the past
    const store = makeFullFidelityStore(run);
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: store }); // no workflowStore

    expect(summary.next_actions_status).toBe('workflow_unresolved');
    expect(summary.run_health).toBeDefined();
    expect(summary.run_health![0]?.kind).toBe('never_claimed_idle');
    expect(summary.warnings).toHaveLength(1);
  });

  it('healthy gated fixture ⇒ NO run_health, status awaiting_human (the B1 negative pin surfaced through get_run_state)', async () => {
    const run = makeRun({
      run_phase: 'gate_waiting',
      in_progress_steps: ['gated'],
      claims: { gated: { deadline: null } },
      pending_gate: {
        gate_id: 'g1',
        step_name: 'gated',
        choices: ['approve'],
        opened_at: new Date().toISOString(),
        preview: {},
      },
    });
    const store = makeFullFidelityStore(run);
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: store });

    expect(summary.next_actions_status).toBe('awaiting_human');
    expect(summary.run_health).toBeUndefined();
    expect(summary.warnings).toBeUndefined();
  });

  it("congruence [S2]: run_health's claim + capability findings ≡ stuck_claims + capability_blocks on one fixture", async () => {
    const run = makeRun({
      in_progress_steps: ['sibling'],
      claims: { sibling: { deadline: new Date(Date.now() - 60_000).toISOString() } },
      capability_blocks: {
        enrich: {
          requirement: { kind: 'adapter', name: 'shopify' },
          code: 'ENGINE_ADAPTER_NOT_REGISTERED',
          at: new Date().toISOString(),
        },
      },
    });
    const store = makeFullFidelityStore(run);
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: store });

    expect(summary.stuck_claims).toBeDefined();
    expect(summary.capability_blocks).toBeDefined();
    expect(summary.run_health).toBeDefined();

    const claimFindings = summary
      .run_health!.filter((f) => f.kind === 'stale_claim' || f.kind === 'wedged_gate_sibling')
      .map((f) => ({ step: f.step, state: f.evidence?.['state'] }));
    expect(claimFindings).toEqual(
      summary.stuck_claims!.map((c) => ({ step: c.step, state: c.state })),
    );

    const capabilityFindings = summary
      .run_health!.filter((f) => f.kind === 'capability_block')
      .map((f) => ({ step: f.step, requirement: f.evidence?.['requirement'] }));
    expect(capabilityFindings).toEqual(
      summary.capability_blocks!.map((b) => ({ step: b.step, requirement: b.requirement })),
    );
  });

  it('run_health never alters next_actions_status on the gate path (status-invariant, deliverable-2 mandate)', async () => {
    // A gate_waiting run with a wedged NON-gated sibling — run_health fires (wedged_gate_sibling)
    // but status MUST stay awaiting_human (drivers key on it).
    const run = makeRun({
      run_phase: 'gate_waiting',
      in_progress_steps: ['gated', 'branch_b'],
      claims: {
        gated: { deadline: null },
        branch_b: { deadline: new Date(Date.now() - 60_000).toISOString() },
      },
      pending_gate: {
        gate_id: 'g1',
        step_name: 'gated',
        choices: ['approve'],
        opened_at: new Date().toISOString(),
        preview: {},
      },
    });
    const store = makeFullFidelityStore(run);
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: store });

    expect(summary.next_actions_status).toBe('awaiting_human');
    expect(summary.run_health).toBeDefined();
    expect(summary.run_health![0]).toMatchObject({ kind: 'wedged_gate_sibling', step: 'branch_b' });
  });

  it('the claims-field fidelity caveat fires when the store declares persistsClaims: false', async () => {
    const run = makeRun({ updated_at: new Date().toISOString() }); // recent — isolate from run_health
    const store: RunStore = {
      persistsClaims: false,
      persistedRunRecordFields: new Set([
        'capability_blocks',
        'workflow_context_snapshots',
        'extension_identity',
      ]),
      async get() {
        return run;
      },
      async create() {
        throw new Error('not exercised');
      },
      async update() {
        throw new Error('not exercised');
      },
      async list() {
        throw new Error('not exercised');
      },
      async claimStep() {
        throw new Error('not exercised');
      },
    };
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: store });
    expect(summary.warnings).toBeDefined();
    expect(summary.warnings!.some((w) => w.includes("'claims'"))).toBe(true);
  });

  it('the claims-field fidelity caveat stays silent when the store declares persistsClaims: true', async () => {
    const run = makeRun({ updated_at: new Date().toISOString() }); // recent — isolate from run_health
    const store = makeFullFidelityStore(run);
    const summary = await handleGetRunState({ run_id: 'r1' }, { runStore: store });
    expect(summary.warnings).toBeUndefined();
  });
});
