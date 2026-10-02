// guard-chain-consumption-279.test.ts — GUARD_CHAIN_CONSUMPTION (issue #279, increment 2, PR-D,
// Deliverable 5; design record §6/§8, gate-1 gap-1's forcing test). Five legs through the REAL
// engine (the chain's guard loop, `advanceRun`) + a REAL JsonFileStore, exercising the chain-consumption table adjudicated
// for settle_guard's refusal reasons:
//   (a) a sibling settles the guard FIRST (same outcome) ⇒ our own attempt returns already_settled
//       ⇒ the chain ADVANCES, threading result.run, with NO error envelope.
//   (b) a sibling settles the guard FIRST with a DIFFERENT, non-abort outcome ⇒
//       settled_outcome_divergence ⇒ the chain ADVANCES + a warning line in the final envelope.
//   (c) same as (b), but OUR OWN attempt is the ABORT leg ⇒ report_to_user + chain-RETURN
//       (STATE_STEP_ALREADY_SETTLED) — the abort was never recorded.
//   (d) a gate opens on ANOTHER step between the guard's pre-seal snapshot and its own settle call
//       ⇒ gate_open_wait ⇒ quiet end-of-pass; the write that resolves the gate then settles the
//       guard (issue #625 — before it, a later drive re-applied the guard).
//   (e) [correction, MA review of reports/atomic-settle-279-pr-d.md] a sibling settles the guard
//       FIRST with the SAME outcome as our own attempt (same shape as leg (a)), but the sibling's
//       commit is a RAW `store.settleStep` call — it terminalizes the run and mints the finalizer
//       ledger PENDING, but (being a bare store-layer write, not a full executeChain/
//       submitHumanResponse call) never drains. Our own attempt then hits already_settled ⇒ the
//       1c NOOP-leg's own drain-on-already_settled clause must fire and deliver the finalizer,
//       exactly once, with its warnings (if any) riding `guardWarnings` into the final envelope —
//       pinning the self-corrected fix Deviation #2 of the PR-D report left unpinned.
//
// Construction technique: rather than a raw concurrency race (which would non-deterministically
// decide which of two callers "wins" the guard — unlike symptom-death-279.test.ts's sibling-STEP
// race, a sibling-GUARD race has no second independent entry point that reaches the SAME guard,
// since a guard only becomes eligible once ALL its deps land), each leg uses a DETERMINISTIC
// sibling-injecting store wrapper: on the FIRST `settleStep` call matching a declared predicate,
// it issues ITS OWN direct call (or a raw open_gate) against a SECOND handle onto the SAME
// underlying JsonFileStore directory — simulating "a sibling already got there first" — BEFORE
// delegating to the real call. Every predicate outcome this produces (already_settled/
// settled_outcome_divergence/gate_open_wait) is computed by the REAL, unmocked
// settlement.ts/JsonFileStore — only the INTERLEAVING is engineered, not the result. This is a
// deliberate divergence from the R3-death test's OWN "no interposition hook" instruction — that
// constraint is stated ONLY for R3-death's specific mechanism (verbatim from symptom-death-279);
// GUARD_CHAIN_CONSUMPTION's own record language ("an engine-level guard-chain fixture") calls for
// exactly this kind of deterministic construction.
//
// issue #625 (RE-HOMED onto `advanceRun`): on a store that declares `settleStep`, the named step's
// own write now settles every guard it makes eligible, so `executeChain` never issues a
// `settle_guard` of its own — the interposition below would never fire through it, and legs (a)
// and (e) would stay green for another reason (the cascade settled the guard; the step's own
// transitioned drain ran the finalizer). The table these legs pin lives in the chain's guard loop,
// which is now `advanceRun`; it settles a guard only on a record that some OTHER write left with
// an eligible one. Each leg therefore (1) leaves such a record with `store.update` — one completed
// step and its evidence entry — (2) calls `advanceRun` directly, and (3) asserts the interposition
// FIRED, so no leg can pass without entering the arm it names.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { advanceRun, executeChain, submitHumanResponse } from './execution-loop.js';
import { captureEvidence } from '../evidence/snapshot.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { RunStore, CreateRunOptions } from '../store/store-interface.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { SettlementDelta, SettlementResult } from '../types/settlement.js';
import type { StepHandler } from '../extensions/step-handler.js';

/**
 * Delegates every RunStore method to a real, functional JsonFileStore. `settleStep` is
 * intercepted: the FIRST call matching `matches(delta)` triggers `inject()` (a raw call against a
 * SECOND handle on the SAME directory) before delegating to the real settleStep — simulating a
 * sibling writer that got there first. Every subsequent call passes straight through.
 */
class InjectBeforeSettleStore implements RunStore {
  readonly persistsClaims: boolean;
  private injected = false;

  /** Whether the interposition ran — every leg asserts it (issue #625: without this a leg can
   *  pass having never entered the arm it names). */
  get fired(): boolean {
    return this.injected;
  }

  constructor(
    private readonly inner: JsonFileStore,
    private readonly matches: (delta: SettlementDelta) => boolean,
    private readonly inject: () => Promise<void>,
  ) {
    this.persistsClaims = inner.persistsClaims;
  }
  create(options: CreateRunOptions): Promise<{ run: RunRecord; created: boolean }> {
    return this.inner.create(options);
  }
  get(runId: string): Promise<RunRecord> {
    return this.inner.get(runId);
  }
  update(record: RunRecord): Promise<RunRecord> {
    return this.inner.update(record);
  }
  list(workflowId?: string): Promise<RunRecord[]> {
    return this.inner.list(workflowId);
  }
  claimStep(runId: string, stepName: string, definition: WorkflowDefinition): Promise<RunRecord> {
    return this.inner.claimStep(runId, stepName, definition);
  }
  async settleStep(
    runId: string,
    delta: SettlementDelta,
    definition: WorkflowDefinition,
    options?: { now?: Date },
  ): Promise<SettlementResult> {
    if (!this.injected && this.matches(delta)) {
      this.injected = true;
      await this.inject();
    }
    return this.inner.settleStep(runId, delta, definition, options);
  }
}

const def: WorkflowDefinition = {
  id: 'guard-chain-consumption-wf',
  name: 'Guard chain consumption fixture',
  version: 1,
  steps: {
    step_a: { description: 'a', execution: 'agent', depends_on: [] },
    guard_b: {
      description: 'g',
      execution: 'guard',
      depends_on: ['step_a'],
      abort_unless: ["step_a.status == 'open'"],
    },
    gated_step: {
      description: 'gs',
      execution: 'agent',
      depends_on: [],
      trust: 'human_confirmed',
      gate: { choices: ['approve', 'reject'] },
    },
  },
};

// Leg (d) ONLY — a SEPARATE definition (not shared with a/b/c, to avoid perturbing their own
// chain-continuation behavior): adds an independent auto step used to re-drive the chain after the
// sibling gate resolves. ANY subsequent execute_step/executeChain call naturally re-checks guard
// eligibility as a side effect (executeChainInternal's own post-executeStep guard-loop check) —
// `trigger_recheck` realistically stands in for whatever the agent does next.
const defWithRecheck: WorkflowDefinition = {
  ...def,
  id: 'guard-chain-consumption-recheck-wf',
  steps: {
    ...def.steps,
    trigger_recheck: { description: 'tr', execution: 'auto', depends_on: [] },
  },
};

// Leg (e) ONLY — a SEPARATE definition (same reasoning as defWithRecheck): adds a finalizer bound
// to the run's overall 'abort' outcome (r5-guard-finalizer-wf's own shape, gate-death-279.test.ts),
// so guard_b's abort terminalizes the run AND mints exactly one finalizer to drain.
const defWithFinalizer: WorkflowDefinition = {
  ...def,
  id: 'guard-chain-consumption-finalizer-wf',
  steps: {
    ...def.steps,
    fin: {
      description: 'finalizer',
      execution: 'finalizer',
      on_outcome: 'abort',
      handler: 'fin-handler',
    },
  },
};

/**
 * issue #625: leaves `guard_b` ELIGIBLE and unsettled — `step_a` completed with the given output,
 * written by `store.update`, a write that settles no guard. This is the record the chain's guard
 * loop (`advanceRun`) exists for on a `settleStep` store.
 */
async function leaveGuardEligible(
  inner: JsonFileStore,
  run: RunRecord,
  stepAOutput: Record<string, unknown>,
): Promise<RunRecord> {
  return inner.update({
    ...run,
    completed_steps: ['step_a'],
    evidence: [
      captureEvidence({
        stepId: 'step_a',
        startedAt: new Date(),
        completedAt: new Date(),
        input: {},
        output: stepAOutput,
      }),
    ],
  });
}

function makeGuardEvidence(outcome: 'pass' | 'resolution_error' | 'abort') {
  return captureEvidence({
    stepId: 'guard_b',
    startedAt: new Date(),
    completedAt: new Date(),
    input: {},
    output: { synthetic_sibling_settle: true, outcome },
  });
}

describe('GUARD_CHAIN_CONSUMPTION — the chain-consumption table (issue #279, increment 2, PR-D, design record §6)', () => {
  it('(a) a sibling settles the guard with the SAME outcome FIRST ⇒ already_settled ⇒ the chain ADVANCES, no error envelope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-gcc-a-'));
    try {
      const inner = new JsonFileStore(dir);
      const { run } = await inner.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const store = new InjectBeforeSettleStore(
        inner,
        (d) => d.kind === 'settle_guard' && d.step === 'guard_b',
        async () => {
          await inner.settleStep(
            run.id,
            {
              kind: 'settle_guard',
              step: 'guard_b',
              outcome: 'pass',
              evidence: makeGuardEvidence('pass'),
            },
            def,
          );
        },
      );

      await leaveGuardEligible(inner, run, { status: 'open' }); // guard_b's own condition would ALSO pass
      const result = await advanceRun(store, def, {
        runId: run.id,
        command: 'step_a',
        input: {},
        dispatcher: async () => ({}),
      });

      // (a) red when the guard loop never issues its own settle_guard (the arm is not entered);
      //     (b) prints true/false.
      expect(store.fired).toBe(true);
      expect(result.status).toBe('ok');
      expect(result.errors).toEqual([]);
      expect(result.error_code).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('STATE_STEP_ALREADY_SETTLED');
      const finalRun = await inner.get(run.id);
      expect(finalRun.completed_steps).toContain('guard_b'); // settled exactly once, by the sibling
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('(b) a sibling settles the guard with a DIFFERENT, non-abort outcome FIRST ⇒ settled_outcome_divergence ⇒ the chain ADVANCES + a warning line in the final envelope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-gcc-b-'));
    try {
      const inner = new JsonFileStore(dir);
      const { run } = await inner.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const store = new InjectBeforeSettleStore(
        inner,
        (d) => d.kind === 'settle_guard' && d.step === 'guard_b',
        async () => {
          // Sibling settles it as resolution_error — a DIFFERENT membership than our own 'pass'
          // attempt (step_a.status:'open' makes OUR condition pass).
          await inner.settleStep(
            run.id,
            {
              kind: 'settle_guard',
              step: 'guard_b',
              outcome: 'resolution_error',
              evidence: makeGuardEvidence('resolution_error'),
              resolutionError: {
                condition: "step_a.status == 'open'",
                unresolvable_path: 'synthetic',
              },
            },
            def,
          );
        },
      );

      await leaveGuardEligible(inner, run, { status: 'open' }); // OUR own guard evaluation would PASS
      const result = await advanceRun(store, def, {
        runId: run.id,
        command: 'step_a',
        input: {},
        dispatcher: async () => ({}),
      });

      // (a) red when the guard loop never issues its own settle_guard; (b) prints true/false.
      expect(store.fired).toBe(true);
      expect(result.status).toBe('ok');
      expect(result.error_code).toBeUndefined();
      expect(result.warnings.some((w) => w.includes('guard') && w.includes('diverged'))).toBe(true);
      const finalRun = await inner.get(run.id);
      // The SIBLING's outcome won (persisted) — resolution_error ⇒ failed_steps + terminal 'failed'.
      expect(finalRun.failed_steps).toContain('guard_b');
      expect(finalRun.terminal_state).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('(c) OUR OWN attempt is the ABORT leg, but a sibling already settled it differently ⇒ report_to_user + chain-RETURN (the abort was NOT recorded)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-gcc-c-'));
    try {
      const inner = new JsonFileStore(dir);
      const { run } = await inner.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const store = new InjectBeforeSettleStore(
        inner,
        (d) => d.kind === 'settle_guard' && d.step === 'guard_b',
        async () => {
          // Sibling settles it as 'pass' — but OUR OWN evaluation (condition fails, step_a.status
          // 'closed') will attempt 'abort'.
          await inner.settleStep(
            run.id,
            {
              kind: 'settle_guard',
              step: 'guard_b',
              outcome: 'pass',
              evidence: makeGuardEvidence('pass'),
            },
            def,
          );
        },
      );

      await leaveGuardEligible(inner, run, { status: 'closed' }); // OUR OWN guard evaluation aborts
      const result = await advanceRun(store, def, {
        runId: run.id,
        command: 'step_a',
        input: {},
        dispatcher: async () => ({}),
      });

      // (a) red when the guard loop never issues its own settle_guard; (b) prints true/false.
      expect(store.fired).toBe(true);
      expect(result.status).toBe('error');
      expect(result.error_code).toBe('STATE_STEP_ALREADY_SETTLED');
      expect(result.agent_action).toBe('report_to_user');
      expect(result.errors[0]).toContain('NOT recorded');
      const finalRun = await inner.get(run.id);
      // The SIBLING's 'pass' won — our abort was never recorded.
      expect(finalRun.completed_steps).toContain('guard_b');
      expect(finalRun.aborted_at).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("(d) a gate opens on ANOTHER step between the guard's pre-seal snapshot and its own settle ⇒ gate_open_wait ⇒ quiet end-of-pass; the write that resolves the gate then settles the guard", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-gcc-d-'));
    try {
      const inner = new JsonFileStore(dir);
      const { run } = await inner.create({
        workflowId: defWithRecheck.id,
        workflowVersion: 1,
        params: {},
      });
      const store = new InjectBeforeSettleStore(
        inner,
        (d) => d.kind === 'settle_guard' && d.step === 'guard_b',
        async () => {
          // Open a gate on the UNRELATED `gated_step` — claim it first, then open_gate.
          const claimed = await inner.claimStep(run.id, 'gated_step', defWithRecheck);
          await inner.settleStep(
            run.id,
            {
              kind: 'open_gate',
              step: 'gated_step',
              claimToken: claimed.claims!['gated_step']!.token!,
              pendingGate: {
                gate_id: 'sibling-gate',
                step_name: 'gated_step',
                preview: {},
                choices: ['approve', 'reject'],
                opened_at: new Date().toISOString(),
              },
              evidence: [],
            },
            defWithRecheck,
          );
        },
      );

      // guard_b's OWN condition must be NON-PASS to ever be eligible for gate_open_wait at all
      // (design record §3: "if fresh.pending_gate !== undefined && delta.outcome !== 'pass'" —
      // D-2 lets a PASSING guard through even under an open gate; only abort/resolution_error wait).
      await leaveGuardEligible(inner, run, { status: 'closed' }); // guard_b's OWN condition would ABORT
      const result = await advanceRun(store, defWithRecheck, {
        runId: run.id,
        command: 'step_a',
        input: {},
        dispatcher: async () => ({}),
      });

      // (a) red when the guard loop never issues its own settle_guard; (b) prints true/false.
      expect(store.fired).toBe(true);
      // Quiet end-of-pass: guard_b is neither completed/failed/skipped — the chain simply stops
      // (the gate now blocks everything), no error.
      expect(result.status).toBe('ok');
      expect(result.error_code).toBeUndefined();
      const midRun = await inner.get(run.id);
      expect(midRun.completed_steps).not.toContain('guard_b');
      expect(midRun.failed_steps).not.toContain('guard_b');
      expect(midRun.skipped_steps).not.toContain('guard_b');
      expect(midRun.pending_gate?.step_name).toBe('gated_step');

      // Resolve the gate — guard_b becomes eligible again, and (issue #625) the ANSWER'S OWN WRITE
      // settles it: no gate is in the way any more, so the guard aborts the run per its own
      // (unchanged) condition right there. The drive of `trigger_recheck` that follows finds the
      // run already ended and executes nothing; before #625 it was that drive that re-applied the
      // guard.
      const resolved = await submitHumanResponse(inner, defWithRecheck, {
        runId: run.id,
        gateId: 'sibling-gate',
        choice: 'approve',
      });
      expect(resolved.status).toBe('ok');
      // (a) red when the answer's write stops settling the guard it unblocks; (b) prints `guards`.
      expect(resolved.guards).toEqual([{ step: 'guard_b', outcome: 'abort' }]);
      const finalChain = await executeChain(inner, defWithRecheck, {
        runId: run.id,
        command: 'trigger_recheck',
        input: {},
        dispatcher: async () => ({}),
      });
      expect(finalChain.status).toBe('ok');
      expect(finalChain.error_code).toBeUndefined();
      const finalRun = await inner.get(run.id);
      expect(finalRun.skipped_steps).toContain('guard_b');
      expect(finalRun.aborted_at?.step_id).toBe('guard_b');
      expect(finalRun.terminal_state).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("(e) [correction] a sibling RAW-settles the guard with the SAME (abort) outcome, terminalizing the run and minting a finalizer PENDING with no drain ⇒ our own already_settled leg's NOOP-drain delivers it, exactly once", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-gcc-e-'));
    try {
      const inner = new JsonFileStore(dir);
      const { run } = await inner.create({
        workflowId: defWithFinalizer.id,
        workflowVersion: 1,
        params: {},
      });

      let handlerCallCount = 0;
      const finHandler: StepHandler = {
        id: 'fin-handler',
        execute: async () => {
          handlerCallCount += 1;
          return { data: {} };
        },
      };
      const registry = new ExtensionRegistry();
      registry.register('handler', 'fin-handler', finHandler);

      const store = new InjectBeforeSettleStore(
        inner,
        (d) => d.kind === 'settle_guard' && d.step === 'guard_b',
        async () => {
          // RAW sibling commit — a bare `store.settleStep` call, bypassing executeChain entirely.
          // applySettleGuard's abort arm mints the finalizer ledger PENDING as part of terminal
          // postconditions, but ONLY executeChain/submitHumanResponse ever call drainFinalizers —
          // a raw store-layer write never does, so "no drain runs" arises naturally, without any
          // separate lease-refusal interception (unlike 1b's own drain-on-NOOP precedent).
          await inner.settleStep(
            run.id,
            {
              kind: 'settle_guard',
              step: 'guard_b',
              outcome: 'abort',
              evidence: makeGuardEvidence('abort'),
              abort: {
                conditions: [
                  { condition: "step_a.status == 'open'", resolved_value: 'closed', passed: false },
                ],
              },
            },
            defWithFinalizer,
          );
        },
      );

      await leaveGuardEligible(inner, run, { status: 'closed' }); // OUR OWN attempt also aborts — same outcome
      const result = await advanceRun(store, defWithFinalizer, {
        runId: run.id,
        command: 'step_a',
        input: {},
        dispatcher: async () => ({}),
        registry,
      });

      // (a) red when the guard loop never issues its own settle_guard — the NOOP-drain arm this
      //     leg pins is then never entered; (b) prints true/false.
      expect(store.fired).toBe(true);
      expect(result.status).toBe('ok');
      expect(result.errors).toEqual([]);
      expect(result.error_code).toBeUndefined();

      const finalRun = await inner.get(run.id);
      // Delivered, not merely settled-terminal: the NOOP-leg's drain-on-already_settled clause
      // recovered the crashed-drain state left by the raw sibling commit.
      expect(finalRun.finalizer_ledger?.['fin']?.status).toBe('completed');
      expect(finalRun.completed_steps).toContain('fin');
      expect(finalRun.evidence.find((e) => e.step_id === 'fin')).toBeDefined();
      expect(handlerCallCount).toBe(1); // exactly once — never zero, never twice
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
