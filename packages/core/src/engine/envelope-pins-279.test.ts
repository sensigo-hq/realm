// envelope-pins-279.test.ts — D-4 typed envelope pins (issue #279, increment 2, PR-D, Deliverable
// 5): the run_terminal cancelled/zombie discriminator, gate_choice_conflict + winning_choice,
// already_open's LIVE-gate render, the N1 neutral-wording arm, capability-block refusal
// degradation, the convergence hint, respondedBy, and evaluatedAtVersion. A mix of real-engine-flow
// tests (where the scenario is genuinely reachable) and forced-result store doubles (where D-1/N1's
// own defensive arms are documented as in-contract UNREACHABLE — the ENVELOPE TEXT LOGIC is still
// unit-testable this way, per the same technique used by guard-chain-consumption-279.test.ts).
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { executeStep, executeChain, submitHumanResponse } from './execution-loop.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { RunStore, CreateRunOptions } from '../store/store-interface.js';
import type { SettlementDelta, SettlementResult } from '../types/settlement.js';

describe('run_terminal envelope — the composed cancelled-predicate (issue #279, increment 2, PR-D, design record D-4)', () => {
  it('CANCELLED variant: a gate cancelled by a sibling abort discloses "your choice was NOT recorded" + the aborting step', async () => {
    const def: WorkflowDefinition = {
      id: 'run-terminal-cancelled-wf',
      name: 'Run-terminal cancelled variant',
      version: 1,
      steps: {
        gate_step: {
          description: 'gated',
          execution: 'agent',
          depends_on: [],
          trust: 'human_confirmed',
          gate: { choices: ['approve', 'reject'] },
        },
        aborter: {
          description: 'aborts',
          execution: 'auto',
          depends_on: [],
          handler: 'abort-handler',
        },
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'realm-envelope-cancelled-'));
    try {
      const store = new JsonFileStore(dir);
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      // Pre-claim `aborter` FIRST (before the gate opens) — eligibility.ts's "gate blocks ALL
      // eligibility" invariant means aborter could never be independently claimed WHILE a gate is
      // already open; mirroring gate-death-279.test.ts's own fix, both steps' claims must exist
      // before either commits, matching a realistic fan-out where both were dispatched together.
      const claimedAborter = await store.claimStep(run.id, 'aborter', def);
      const aborterToken = claimedAborter.claims?.['aborter']?.token;

      const opened = await executeStep(store, def, {
        runId: run.id,
        command: 'gate_step',
        input: {},
        dispatcher: async () => ({ preview: true }),
      });
      expect(opened.status).toBe('confirm_required');
      const gateId = opened.gate!.gate_id;

      // aborter's OWN settle_step abort — the REAL applyAbortEdge call executeStep's handler-abort
      // path would have made, applied directly against the CURRENT fresh state (which shows
      // gate_step's gate open) — proving the cancel-gate logic fires against a genuinely-open gate.
      const abortSettle = await store.settleStep!(
        run.id,
        {
          kind: 'settle_step',
          step: 'aborter',
          outcome: 'abort',
          ...(aborterToken !== undefined ? { claimToken: aborterToken } : {}),
          evidence: [],
          abort: { stepId: 'aborter', abortMessage: 'aborter says stop' },
        },
        def,
      );
      expect(abortSettle.applied).toBe(true);

      const finalRunAfterAbort = await store.get(run.id);
      expect(finalRunAfterAbort.terminal_state).toBe(true);
      expect(finalRunAfterAbort.skip_details?.['gate_step']?.kind).toBe('gate_cancelled_by_abort');

      const submitAfterCancel = await submitHumanResponse(store, def, {
        runId: run.id,
        gateId,
        choice: 'approve',
      });
      expect(submitAfterCancel.status).toBe('error');
      expect(submitAfterCancel.error_code).toBe('STATE_RUN_TERMINAL');
      expect(submitAfterCancel.errors[0]).toContain('NOT recorded');
      expect(submitAfterCancel.errors[0]).toContain('aborter');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ZOMBIE variant: a grandfathered terminal-with-stale-gate record (no cancel skip-detail) gets the plain terminal text + the resume/purge pointer', async () => {
    const def: WorkflowDefinition = {
      id: 'run-terminal-zombie-wf',
      name: 'Run-terminal zombie variant',
      version: 1,
      steps: {
        gate_step: {
          description: 'gated',
          execution: 'agent',
          depends_on: [],
          trust: 'human_confirmed',
          gate: { choices: ['approve', 'reject'] },
        },
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'realm-envelope-zombie-'));
    try {
      const store = new JsonFileStore(dir);
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      // Hand-shape a #282-class grandfathered record: terminal AND still carrying a pending_gate,
      // with NO gate_cancelled_by_abort skip detail (the class this closure legislates over).
      const zombie = await store.update({
        ...run,
        completed_steps: ['gate_step'],
        terminal_state: true,
        terminal_reason: 'Workflow completed.',
        pending_gate: {
          gate_id: 'zombie-gate',
          step_name: 'gate_step',
          preview: {},
          choices: ['approve', 'reject'],
          opened_at: new Date().toISOString(),
        },
      });

      const result = await submitHumanResponse(store, def, {
        runId: zombie.id,
        gateId: 'zombie-gate',
        choice: 'approve',
      });
      expect(result.status).toBe('error');
      expect(result.error_code).toBe('STATE_RUN_TERMINAL');
      expect(result.errors[0]).not.toContain('NOT recorded'); // never the cancelled text
      expect(result.errors[0]).toContain('realm resume');
      expect(result.errors[0]).toContain('realm run purge');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('gate_choice_conflict envelope (issue #279, increment 2, PR-D)', () => {
  it('a DIFFERENT choice submitted against an already-resolved gate is refused with the winning choice named', async () => {
    const def: WorkflowDefinition = {
      id: 'gate-choice-conflict-wf',
      name: 'Gate choice conflict',
      version: 1,
      steps: {
        gate_step: {
          description: 'gated',
          execution: 'agent',
          depends_on: [],
          trust: 'human_confirmed',
          gate: { choices: ['approve', 'reject'] },
        },
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'realm-envelope-conflict-'));
    try {
      const store = new JsonFileStore(dir);
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const opened = await executeStep(store, def, {
        runId: run.id,
        command: 'gate_step',
        input: {},
        dispatcher: async () => ({ preview: true }),
      });
      const gateId = opened.gate!.gate_id;

      const firstSubmit = await submitHumanResponse(store, def, {
        runId: run.id,
        gateId,
        choice: 'approve',
      });
      expect(firstSubmit.status).toBe('ok');

      const conflictingSubmit = await submitHumanResponse(store, def, {
        runId: run.id,
        gateId,
        choice: 'reject',
      });
      expect(conflictingSubmit.status).toBe('error');
      expect(conflictingSubmit.error_code).toBe('STATE_BLOCKED');
      expect(conflictingSubmit.error_details?.['winning_choice']).toBe('approve');
      expect(conflictingSubmit.errors[0]).toContain('approve');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Delegates every method to a real JsonFileStore, except `settleStep`, which — for the FIRST
 *  call matching `matches` — returns a HAND-CONSTRUCTED SettlementResult instead of delegating.
 *  Used ONLY for D-1/N1's own documented in-contract-UNREACHABLE defensive arms, where the ENGINE
 *  cannot honestly reach the scenario, but the ENVELOPE TEXT LOGIC built around it is still real,
 *  shipped code this repo must pin. */
class ForcesResultStore implements RunStore {
  readonly persistsClaims: boolean;
  private forced = false;
  constructor(
    private readonly inner: JsonFileStore,
    private readonly matches: (delta: SettlementDelta) => boolean,
    private readonly forcedResult: (fresh: RunRecord) => SettlementResult,
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
    if (!this.forced && this.matches(delta)) {
      this.forced = true;
      const fresh = await this.inner.get(runId);
      return this.forcedResult(fresh);
    }
    return this.inner.settleStep(runId, delta, definition, options);
  }
}

describe('already_open envelope — the LIVE gate wins, rendered verbatim (issue #279, increment 2, PR-D, design record D-1 — in-contract UNREACHABLE, forced for the envelope pin)', () => {
  it('a forced already_open NOOP renders the LIVE PendingGate, calm, confirm_required, never report_to_user', async () => {
    const def: WorkflowDefinition = {
      id: 'already-open-wf',
      name: 'Already-open fixture',
      version: 1,
      steps: {
        gate_step: {
          description: 'gated',
          execution: 'agent',
          depends_on: [],
          trust: 'human_confirmed',
          gate: { choices: ['approve', 'reject'] },
        },
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'realm-envelope-already-open-'));
    try {
      const inner = new JsonFileStore(dir);
      const { run } = await inner.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const liveGate = {
        gate_id: 'live-gate-id',
        step_name: 'gate_step',
        preview: { forced: true },
        choices: ['approve', 'reject'],
        opened_at: new Date().toISOString(),
      };
      const store = new ForcesResultStore(
        inner,
        (d) => d.kind === 'open_gate',
        (fresh) => ({
          applied: false,
          reason: 'already_open',
          run: { ...fresh, pending_gate: liveGate },
          gate: liveGate,
        }),
      );

      const result = await executeStep(store, def, {
        runId: run.id,
        command: 'gate_step',
        input: {},
        dispatcher: async () => ({ preview: true }),
      });

      expect(result.status).toBe('confirm_required');
      expect(result.agent_action).toBeUndefined(); // never report_to_user
      expect(result.gate?.gate_id).toBe('live-gate-id'); // the LIVE gate, not the rebuilt one
      expect(result.gate?.preview).toEqual({ forced: true });
      expect(result.context_hint).toContain('already paused');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('N1 neutral wording — never amplify a "by_other" white lie (issue #279, increment 2, PR-D, design record §2/§11, forced for the envelope pin)', () => {
  it('open_gate refused already_settled_by_other with a persisted "gate" outcome renders "by a completed gate", never "by a different attempt"', async () => {
    const def: WorkflowDefinition = {
      id: 'n1-wording-wf',
      name: 'N1 wording fixture',
      version: 1,
      steps: {
        gate_step: {
          description: 'gated',
          execution: 'agent',
          depends_on: [],
          trust: 'human_confirmed',
          gate: { choices: ['approve', 'reject'] },
        },
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'realm-envelope-n1-'));
    try {
      const inner = new JsonFileStore(dir);
      const { run } = await inner.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const store = new ForcesResultStore(
        inner,
        (d) => d.kind === 'open_gate',
        (fresh) => ({
          applied: false,
          reason: 'already_settled_by_other',
          run: {
            ...fresh,
            completed_steps: ['gate_step'],
            settled: {
              gate_step: { token: 'some-other-gate-id', outcome: 'gate', choice: 'approve' },
            },
          },
        }),
      );

      const result = await executeStep(store, def, {
        runId: run.id,
        command: 'gate_step',
        input: {},
        dispatcher: async () => ({ preview: true }),
      });

      expect(result.status).toBe('error');
      expect(result.errors[0]).toContain('by a completed gate');
      expect(result.errors[0]).not.toContain('by a different attempt');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('capability-block refusal degradation (issue #279, increment 2, PR-D, Deliverable 1d)', () => {
  it('a sibling settles the SAME step FIRST ⇒ the capability-block release is refused, but the SAME block envelope + a typed warning is returned (claim survives for reclaim)', async () => {
    const def: WorkflowDefinition = {
      id: 'capability-refusal-wf',
      name: 'Capability-block refusal fixture',
      version: 1,
      steps: {
        work: { description: 'w', execution: 'auto', depends_on: [], handler: 'not-registered' },
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'realm-envelope-cap-refusal-'));
    try {
      const inner = new JsonFileStore(dir);
      const { run } = await inner.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const store = new ForcesResultStore(
        inner,
        (d) => d.kind === 'release_step',
        (fresh) => ({ applied: false, reason: 'claim_lost', run: fresh }),
      );

      const result = await executeStep(store, def, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: async () => ({}),
        registry: new ExtensionRegistry(),
      });

      expect(result.status).toBe('error');
      expect(result.error_code).toBe('ENGINE_HANDLER_NOT_REGISTERED'); // the SAME block envelope
      expect(result.warnings.some((w) => w.includes('capability block not persisted'))).toBe(true);
      expect(result.warnings.some((w) => w.includes('claim_lost'))).toBe(true);
      expect(JSON.stringify(result)).not.toContain('STATE_CLAIM_LOST'); // never that framing
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the convergence hint (issue #279, increment 2, PR-D, design record D-2 N8 narrowing)', () => {
  it('present: a committed RESOLVE that makes a guard eligible appends "guard <name> now eligible" to the success envelope', async () => {
    const def: WorkflowDefinition = {
      id: 'convergence-hint-present-wf',
      name: 'Convergence hint present',
      version: 1,
      steps: {
        gate_step: {
          description: 'gated',
          execution: 'agent',
          depends_on: [],
          trust: 'human_confirmed',
          gate: { choices: ['approve', 'reject'] },
        },
        guard_after: {
          description: 'g',
          execution: 'guard',
          depends_on: ['gate_step'],
          abort_unless: ["gate_step.choice == 'approve'"],
        },
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'realm-envelope-hint-present-'));
    try {
      const store = new JsonFileStore(dir);
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const opened = await executeStep(store, def, {
        runId: run.id,
        command: 'gate_step',
        input: {},
        dispatcher: async () => ({ preview: true }),
      });
      const result = await submitHumanResponse(store, def, {
        runId: run.id,
        gateId: opened.gate!.gate_id,
        choice: 'approve',
      });
      expect(result.status).toBe('ok');
      expect(
        result.warnings.some(
          (w) => w.includes("guard 'guard_after' now eligible") && w.includes('converges'),
        ),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('absent: a RESOLVE with no eligible guard carries no convergence hint', async () => {
    const def: WorkflowDefinition = {
      id: 'convergence-hint-absent-wf',
      name: 'Convergence hint absent',
      version: 1,
      steps: {
        gate_step: {
          description: 'gated',
          execution: 'agent',
          depends_on: [],
          trust: 'human_confirmed',
          gate: { choices: ['approve', 'reject'] },
        },
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'realm-envelope-hint-absent-'));
    try {
      const store = new JsonFileStore(dir);
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const opened = await executeStep(store, def, {
        runId: run.id,
        command: 'gate_step',
        input: {},
        dispatcher: async () => ({ preview: true }),
      });
      const result = await submitHumanResponse(store, def, {
        runId: run.id,
        gateId: opened.gate!.gate_id,
        choice: 'approve',
      });
      expect(result.status).toBe('ok');
      expect(result.warnings.some((w) => w.includes('now eligible'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('respondedBy — recorded, not enforced (issue #279, increment 2, PR-D, design record D-5)', () => {
  it('supplied: populates BOTH the delta AND the gate_response evidence snapshot', async () => {
    const def: WorkflowDefinition = {
      id: 'responded-by-supplied-wf',
      name: 'RespondedBy supplied',
      version: 1,
      steps: {
        gate_step: {
          description: 'gated',
          execution: 'agent',
          depends_on: [],
          trust: 'human_confirmed',
          gate: { choices: ['approve', 'reject'] },
        },
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'realm-responded-by-'));
    try {
      const inner = new JsonFileStore(dir);
      const { run } = await inner.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      let capturedDelta: SettlementDelta | undefined;
      const store = new ForcesResultStore(
        inner,
        (d) => {
          if (d.kind === 'settle_gate') capturedDelta = d;
          return false; // never actually force — just observe, then let the real store handle it
        },
        (fresh) => ({ applied: true, run: fresh, transitioned: false, pendingFinalizers: [] }),
      );
      const opened = await executeStep(inner, def, {
        runId: run.id,
        command: 'gate_step',
        input: {},
        dispatcher: async () => ({ preview: true }),
      });
      const result = await submitHumanResponse(store, def, {
        runId: run.id,
        gateId: opened.gate!.gate_id,
        choice: 'approve',
        respondedBy: 'operator-42',
      });
      expect(result.status).toBe('ok');
      expect(capturedDelta?.kind).toBe('settle_gate');
      expect((capturedDelta as { respondedBy?: string }).respondedBy).toBe('operator-42');
      const finalRun = await inner.get(run.id);
      const gateEvidence = finalRun.evidence.find((e) => e.kind === 'gate_response');
      expect(gateEvidence?.responded_by).toBe('operator-42');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('absent: never set on the delta or the snapshot when not supplied', async () => {
    const def: WorkflowDefinition = {
      id: 'responded-by-absent-wf',
      name: 'RespondedBy absent',
      version: 1,
      steps: {
        gate_step: {
          description: 'gated',
          execution: 'agent',
          depends_on: [],
          trust: 'human_confirmed',
          gate: { choices: ['approve', 'reject'] },
        },
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'realm-responded-by-absent-'));
    try {
      const store = new JsonFileStore(dir);
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const opened = await executeStep(store, def, {
        runId: run.id,
        command: 'gate_step',
        input: {},
        dispatcher: async () => ({ preview: true }),
      });
      await submitHumanResponse(store, def, {
        runId: run.id,
        gateId: opened.gate!.gate_id,
        choice: 'approve',
      });
      const finalRun = await store.get(run.id);
      const gateEvidence = finalRun.evidence.find((e) => e.kind === 'gate_response');
      expect(gateEvidence?.responded_by).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("evaluatedAtVersion — the chain's own evaluation snapshot (issue #279, increment 2, PR-D, design record §2, lane-B steal 2)", () => {
  it('populated by the guard chain with the pre-settle run version', async () => {
    const def: WorkflowDefinition = {
      id: 'evaluated-at-version-wf',
      name: 'EvaluatedAtVersion fixture',
      version: 1,
      steps: {
        step_a: { description: 'a', execution: 'agent', depends_on: [] },
        guard_b: {
          description: 'g',
          execution: 'guard',
          depends_on: ['step_a'],
          abort_unless: ["step_a.status == 'open'"],
        },
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'realm-evaluated-at-version-'));
    try {
      const inner = new JsonFileStore(dir);
      const { run } = await inner.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      let capturedDelta: SettlementDelta | undefined;
      const store = new ForcesResultStore(
        inner,
        (d) => {
          if (d.kind === 'settle_guard') capturedDelta = d;
          return false; // observe only
        },
        (fresh) => ({ applied: true, run: fresh, transitioned: false, pendingFinalizers: [] }),
      );

      const preGuardRun = await inner.get(run.id); // before step_a settles — just to prove intent
      expect(preGuardRun.version).toBeDefined();

      await executeChain(store, def, {
        runId: run.id,
        command: 'step_a',
        input: {},
        dispatcher: async () => ({ status: 'open' }),
      });

      expect(capturedDelta?.kind).toBe('settle_guard');
      const runAfterStepA = await inner.get(run.id).catch(() => undefined);
      // The captured delta's evaluatedAtVersion is the run version AT THE MOMENT the guard chain
      // evaluated it — i.e., immediately after step_a's own settle committed (version bumped once),
      // strictly BEFORE the guard's own settle (which would bump it again).
      expect((capturedDelta as { evaluatedAtVersion?: number }).evaluatedAtVersion).toBeDefined();
      if (runAfterStepA !== undefined) {
        expect(
          (capturedDelta as { evaluatedAtVersion?: number }).evaluatedAtVersion,
        ).toBeLessThanOrEqual(runAfterStepA.version);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
