// settlement-282-closure.test.ts — core unit/engine-level tests for issue #279, increment 2
// (PR-C): the #282 class closure (design record design-d5-increment2.md §5 D-3, §8 "Core
// unit/engine tests"). TCK-level gate/guard/release-arm conformance lives in
// packages/testing/src/store/settlement-contract.ts (both stores); this file covers the
// CORE-OWNED pieces that TCK doesn't reach: idempotency's own call-site derive, abandonRun's
// hoisted terminal-first arm, applyResume's pending_gate strip, an interleaved-producer scenario
// for the class itself, and the L9 negative pin (extended to the new 'gate' outcome).
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { abandonRun } from './abandon-run.js';
import { applyResume } from './apply-resume.js';
import { applySettlement } from './settlement.js';
import { deriveRunPhase } from './eligibility.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { SettlementDelta, SettleStepOutcome } from '../types/settlement.js';

function baseRun(overrides: Partial<RunRecord> = {}): RunRecord {
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
    ...overrides,
  };
}

const def: WorkflowDefinition = {
  id: 'wf',
  name: '#282 closure fixture',
  version: 1,
  steps: {
    a: { description: 'a', execution: 'agent', depends_on: [] },
    b: { description: 'b', execution: 'agent', depends_on: [] },
  },
};

describe('#282 class closure — idempotency call-site derive (issue #279, increment 2, PR-C, D-3 leg v)', () => {
  it('a grandfathered COMPLETED match (stale persisted run_phase, honest terminal_reason) still reuses under rerun_if_failed — no duplicate run minted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-282-idempotency-'));
    try {
      const store = new JsonFileStore(dir);
      const { run: original } = await store.create({
        workflowId: 'wf',
        workflowVersion: 1,
        params: {},
        idempotencyKey: 'key-1',
      });
      // Grandfathered/#282-class: persisted run_phase is STALE ('gate_waiting'-shaped leftover),
      // but the record is genuinely, honestly completed (terminal_reason says so). The derive at
      // the create() call site must see 'completed' here, not the stale persisted value.
      await store.update({
        ...original,
        completed_steps: ['a', 'b'],
        terminal_state: true,
        terminal_reason: 'Workflow completed.',
        run_phase: 'gate_waiting', // deliberately wrong/stale — proves derivation, not trust
      });

      const { run: matched, created } = await store.create({
        workflowId: 'wf',
        workflowVersion: 1,
        params: {},
        idempotencyKey: 'key-1',
        onTerminalMatch: 'rerun_if_failed',
      });

      // rerun_if_failed reuses a genuinely-completed match (the "closed-ticket re-run" case) —
      // if the call site trusted the stale persisted 'gate_waiting' instead of deriving, it would
      // treat this as non-completed and WRONGLY supersede, minting a duplicate run.
      expect(created).toBe(false);
      expect(matched.id).toBe(original.id);

      const all = await store.list();
      expect(all).toHaveLength(1); // no duplicate run minted
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('#282 class closure — ABANDON_TERMINAL_FIRST (issue #279, increment 2, PR-C, D-3 leg v)', () => {
  it('a terminal run carrying a leftover pending_gate refuses STATE_RUN_TERMINAL (not the gate refusal) — the hoisted terminal arm', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-282-abandon-terminal-'));
    try {
      const store = new JsonFileStore(dir);
      const { run } = await store.create({ workflowId: 'wf', workflowVersion: 1, params: {} });
      const zombie = await store.update({
        ...run,
        completed_steps: ['a', 'b'],
        terminal_state: true,
        terminal_reason: 'Workflow completed.',
        pending_gate: {
          gate_id: 'zombie',
          step_name: 'a',
          preview: {},
          choices: ['approve'],
          opened_at: '2026-01-01T00:00:00.000Z',
        },
      });

      await expect(abandonRun(store, zombie.id)).rejects.toMatchObject({
        code: 'STATE_RUN_TERMINAL',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a genuinely LIVE gate (non-terminal) still refuses via the gate arm, unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-282-abandon-live-gate-'));
    try {
      const store = new JsonFileStore(dir);
      const { run } = await store.create({ workflowId: 'wf', workflowVersion: 1, params: {} });
      const gated = await store.update({
        ...run,
        in_progress_steps: ['a'],
        claims: { a: { deadline: null, token: 't' } },
        pending_gate: {
          gate_id: 'live',
          step_name: 'a',
          preview: {},
          choices: ['approve'],
          opened_at: '2026-01-01T00:00:00.000Z',
        },
      });

      await expect(abandonRun(store, gated.id)).rejects.toMatchObject({
        code: 'STATE_TRANSITION_DENIED',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('#282 class closure — applyResume strips a carried pending_gate (issue #279, increment 2, PR-C, D-3 leg ii)', () => {
  it('a fallback-shaped (failed ∧ pending_gate) snapshot resumes with NO pending_gate on the output, plus the zombie-gate disclosure string', () => {
    const snapshot = baseRun({
      run_phase: 'failed',
      terminal_state: true,
      failed_steps: ['a'],
      pending_gate: {
        gate_id: 'zombie-gate',
        step_name: 'b',
        preview: {},
        choices: ['approve', 'reject'],
        opened_at: '2026-01-01T00:00:00.000Z',
      },
    });

    const { run, disclosures } = applyResume(snapshot, 'a', def);

    expect(run.pending_gate).toBeUndefined();
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]).toMatch(/zombie gate 'zombie-gate' on 'b' cleared by resume/);
  });

  it('a run with no pending_gate at all resumes with an empty disclosures array (the common case)', () => {
    const snapshot = baseRun({ run_phase: 'failed', terminal_state: true, failed_steps: ['a'] });
    const { disclosures } = applyResume(snapshot, 'a', def);
    expect(disclosures).toEqual([]);
  });
});

describe('#282 class closure — PHASE_IS_GENERATED at the store write-tail (engine-level interleaved-producer scenario)', () => {
  it('a legacy-shaped fail seal (store.update, no settleStep) on a gate-carrying base persists the DERIVED phase, never a stale one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-282-interleaved-'));
    try {
      const store = new JsonFileStore(dir);
      const { run } = await store.create({ workflowId: 'wf', workflowVersion: 1, params: {} });
      // A legacy (non-settleStep) writer seals the run as failed while HAND-CONSTRUCTING the
      // record with a stale run_phase field — proving update()'s own write-tail derive (not this
      // PR's addition, but load-bearing for the closure) still corrects it.
      const sealed = await store.update({
        ...run,
        failed_steps: ['a'],
        terminal_state: true,
        run_phase: 'gate_waiting', // deliberately wrong
      });
      expect(sealed.run_phase).toBe('failed');
      expect(sealed.run_phase).toBe(deriveRunPhase(sealed));

      const reread = await store.get(run.id);
      expect(reread.run_phase).toBe('failed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('L9 negative pin, extended (issue #279, increment 2, PR-C) — no settle_step delta can ever produce a "gate" entry', () => {
  it('every settle_step outcome (complete/fail/abort) writes an entry whose outcome is one of complete/fail/skip — never gate', async () => {
    const outcomes: SettleStepOutcome[] = ['complete', 'fail', 'abort'];
    for (const outcome of outcomes) {
      const fresh: RunRecord = {
        id: `l9-${outcome}`,
        workflow_id: def.id,
        workflow_version: 1,
        completed_steps: [],
        in_progress_steps: ['a'],
        failed_steps: [],
        skipped_steps: [],
        run_phase: 'running',
        version: 0,
        params: {},
        evidence: [],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        terminal_state: false,
        claims: { a: { deadline: null, token: 'tok' } },
      };
      const delta: SettlementDelta = {
        kind: 'settle_step',
        step: 'a',
        outcome,
        claimToken: 'tok',
        evidence: [],
        ...(outcome === 'abort' ? { abort: { stepId: 'a', abortMessage: 'x' } } : {}),
      };
      const result = applySettlement(fresh, delta, def, {
        now: new Date('2026-01-01T00:00:00.000Z'),
      });
      if (!result.applied) throw new Error(`expected applied:true for outcome '${outcome}'`);
      const entry = result.run.settled?.['a'];
      expect(entry).toBeDefined();
      expect(entry?.outcome).not.toBe('gate');
      expect(['complete', 'fail', 'skip']).toContain(entry?.outcome);
    }
  });
});

describe("GUARD_CHAIN_CONSUMPTION shape (issue #279, increment 2, PR-C — forward-looking pin for PR-D's migration; simulated at the transform level since the guard chain caller itself stays untouched in this increment)", () => {
  it("leg (a): a sibling-settled guard's losing settle_guard call returns already_settled with result.run threaded — a chain consumer can ADVANCE without an error envelope", async () => {
    const guardDef: WorkflowDefinition = {
      id: 'guard-chain-wf',
      name: 'Guard chain fixture',
      version: 1,
      steps: { g: { description: 'g', execution: 'guard', abort_unless: [] } },
    };
    const dir = await mkdtemp(join(tmpdir(), 'realm-282-guard-chain-'));
    try {
      const store = new JsonFileStore(dir);
      const { run } = await store.create({
        workflowId: guardDef.id,
        workflowVersion: 1,
        params: {},
      });
      const settleStep = store.settleStep!.bind(store);
      const delta: SettlementDelta = {
        kind: 'settle_guard',
        step: 'g',
        outcome: 'pass',
        evidence: {
          step_id: 'g',
          started_at: '2026-01-01T00:00:00.000Z',
          completed_at: '2026-01-01T00:00:01.000Z',
          duration_ms: 1,
          input_summary: {},
          output_summary: {},
          status: 'success',
          evidence_hash: 'x',
        },
      };
      const winner = await settleStep(run.id, delta, guardDef);
      if (!winner.applied) throw new Error('expected the first settle_guard to apply');

      // A "losing" concurrent attempt (simulating a sibling chain that raced this one) retries
      // the SAME delta — already_settled, with `result.run` present and reflecting the winner's
      // own committed state. A chain consumer can thread this directly (no error envelope).
      const loser = await settleStep(run.id, delta, guardDef);
      expect(loser.applied).toBe(false);
      if (loser.applied) throw new Error('unreachable');
      expect(loser.reason).toBe('already_settled');
      expect(loser.run.completed_steps).toContain('g');
      expect(loser.run.version).toBe(winner.run.version); // no NEW write happened
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leg (b): a non-abort settled_outcome_divergence carries the persisted membership description a chain consumer can render as a warning (not a report_to_user error)', async () => {
    const guardDef: WorkflowDefinition = {
      id: 'guard-chain-wf-2',
      name: 'Guard chain fixture 2',
      version: 1,
      steps: { g: { description: 'g', execution: 'guard', abort_unless: ['1 == 2'] } },
    };
    const dir = await mkdtemp(join(tmpdir(), 'realm-282-guard-chain-2-'));
    try {
      const store = new JsonFileStore(dir);
      const { run } = await store.create({
        workflowId: guardDef.id,
        workflowVersion: 1,
        params: {},
      });
      const settleStep = store.settleStep!.bind(store);
      const passDelta: SettlementDelta = {
        kind: 'settle_guard',
        step: 'g',
        outcome: 'pass',
        evidence: {
          step_id: 'g',
          started_at: '2026-01-01T00:00:00.000Z',
          completed_at: '2026-01-01T00:00:01.000Z',
          duration_ms: 1,
          input_summary: {},
          output_summary: {},
          status: 'success',
          evidence_hash: 'x',
        },
      };
      const first = await settleStep(run.id, passDelta, guardDef);
      if (!first.applied) throw new Error('expected the pass to apply');

      // A DIFFERENT concurrent evaluation of the SAME guard reached 'abort' instead — a genuine
      // divergence a chain consumer should surface as a WARNING (never report_to_user/RETURN,
      // per the design's own chain-consumption table — that's reserved for the ABORT leg).
      const abortDelta: SettlementDelta = {
        kind: 'settle_guard',
        step: 'g',
        outcome: 'abort',
        evidence: passDelta.evidence,
        abort: { conditions: [{ condition: '1 == 2', resolved_value: false, passed: false }] },
      };
      const divergent = await settleStep(run.id, abortDelta, guardDef);
      expect(divergent.applied).toBe(false);
      if (divergent.applied) throw new Error('unreachable');
      expect(divergent.reason).toBe('settled_outcome_divergence');
      expect(divergent.persisted).toBe('complete');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
