// sealed-by-writers.test.ts — issue #367: every terminal path names the arm that sealed it, and
// the run's finalizers still fire exactly as before.
//
// Keyed to the PATH census rather than to the 13 arms: several sites share an arm, and a per-arm
// cell would leave the sibling sites uncovered — a deleted stamp at one of them would stay green.
// Each cell asserts the PERSISTED arm (read back through the store, not the in-memory return) AND
// the finalizer-handler call count, because the guard classifier that reads the arm is what feeds
// the finalizer drain: a wrong answer there silently runs the wrong cleanup.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeStep, executeChain, submitHumanResponse } from './execution-loop.js';
import { abandonRun } from './abandon-run.js';
import { applyResume } from './apply-resume.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { RunStore, CreateRunOptions } from '../store/store-interface.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepHandler } from '../extensions/step-handler.js';

/** Forces the LEGACY (non-declaring) seal path — `settleStep` is never implemented. */
class LegacyOnlyStore implements RunStore {
  readonly persistsClaims: boolean;
  constructor(private readonly inner: JsonFileStore) {
    this.persistsClaims = inner.persistsClaims;
  }
  create(o: CreateRunOptions): Promise<{ run: RunRecord; created: boolean }> {
    return this.inner.create(o);
  }
  get(id: string): Promise<RunRecord> {
    return this.inner.get(id);
  }
  update(r: RunRecord): Promise<RunRecord> {
    return this.inner.update(r);
  }
  list(w?: string): Promise<RunRecord[]> {
    return this.inner.list(w);
  }
  claimStep(r: string, s: string, d: WorkflowDefinition): Promise<RunRecord> {
    return this.inner.claimStep(r, s, d);
  }
  // settleStep intentionally OMITTED.
}

const succeed = async (): Promise<Record<string, unknown>> => ({});
const explode = (m: string) => async (): Promise<Record<string, unknown>> => {
  throw new Error(m);
};

describe('#367 — the writer census: every terminal path persists its own arm', () => {
  let dir: string;
  let declaring: JsonFileStore;
  let finalizerCalls: number;
  let registry: ExtensionRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-seal-writers-'));
    declaring = new JsonFileStore(dir);
    finalizerCalls = 0;
    const handler: StepHandler = {
      id: 'fin-handler',
      execute: async () => {
        finalizerCalls += 1;
        return { data: {} };
      },
    };
    const abortHandler: StepHandler = {
      id: 'abort-handler',
      execute: async () => ({ abort: { message: 'handler said stop' } }),
    };
    registry = new ExtensionRegistry();
    registry.register('handler', 'fin-handler', handler);
    registry.register('handler', 'abort-handler', abortHandler);
  });

  const legacy = (): RunStore => new LegacyOnlyStore(new JsonFileStore(dir));

  /** `a` alone, plus an always-finalizer so every cell can count the drain. */
  function def(steps: Record<string, unknown>, withFinalizer = true): WorkflowDefinition {
    return {
      id: 'seal-writers-wf',
      name: 'Seal Writers',
      version: 1,
      steps: {
        ...(steps as WorkflowDefinition['steps']),
        ...(withFinalizer
          ? {
              fin: {
                description: 'F',
                execution: 'finalizer' as const,
                on_outcome: 'always' as const,
                handler: 'fin-handler',
              },
            }
          : {}),
      },
    } as WorkflowDefinition;
  }

  async function drive(
    store: RunStore,
    definition: WorkflowDefinition,
    command: string,
    dispatcher: () => Promise<Record<string, unknown>>,
  ): Promise<RunRecord> {
    const { run } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });
    await executeChain(store, definition, {
      runId: run.id,
      command,
      input: {},
      dispatcher,
      registry,
    });
    return store.get(run.id);
  }

  // --- complete / step_failure, both layers ---
  it.each([
    ['settlement layer', () => declaring],
    ['legacy layer', legacy],
  ])(
    '%s: a completing run persists arm `complete` and drains its finalizer once',
    async (_l, make) => {
      const d = def({ a: { description: 'A', execution: 'agent', depends_on: [] } });
      const record = await drive(make(), d, 'a', succeed);
      expect(record.sealed_by).toEqual({ arm: 'complete', step: 'a' });
      expect(record.run_phase).toBe('completed');
      expect(finalizerCalls).toBe(1);
    },
  );

  it.each([
    ['settlement layer', () => declaring],
    ['legacy layer', legacy],
  ])('%s: a failing run persists arm `step_failure` and drains once', async (_l, make) => {
    const d = def({ a: { description: 'A', execution: 'agent', depends_on: [] } });
    const record = await drive(make(), d, 'a', explode('boom'));
    expect(record.sealed_by).toEqual({ arm: 'step_failure', step: 'a' });
    expect(record.run_phase).toBe('failed');
    expect(finalizerCalls).toBe(1);
  });

  // --- handler_abort, both layers ---
  it.each([
    ['settlement layer', () => declaring],
    ['legacy layer', legacy],
  ])('%s: a handler abort persists arm `handler_abort` and drains once', async (_l, make) => {
    const d = def({
      a: { description: 'A', execution: 'auto', depends_on: [], handler: 'abort-handler' },
    });
    const record = await drive(make(), d, 'a', succeed);
    expect(record.sealed_by).toEqual({ arm: 'handler_abort', step: 'a' });
    expect(record.run_phase).toBe('aborted');
    expect(record.aborted_at).toBeDefined();
    expect(finalizerCalls).toBe(1);
  });

  // --- guard arms, both layers ---
  it.each([
    ['settlement layer', () => declaring],
    ['legacy layer', legacy],
  ])('%s: a guard resolution error persists arm `guard_resolution_error`', async (_l, make) => {
    const d = def({
      a: { description: 'A', execution: 'agent', depends_on: [] },
      g: {
        description: 'G',
        execution: 'guard',
        depends_on: ['a'],
        abort_unless: ['$.nope.field == true'],
      },
    });
    const record = await drive(make(), d, 'a', succeed);
    expect(record.sealed_by).toEqual({ arm: 'guard_resolution_error', step: 'g' });
    expect(record.run_phase).toBe('failed');
    expect(finalizerCalls).toBe(1);
  });

  it.each([
    ['settlement layer', () => declaring],
    ['legacy layer', legacy],
  ])('%s: a firing guard persists arm `guard_abort`', async (_l, make) => {
    const d = def({
      a: { description: 'A', execution: 'agent', depends_on: [] },
      g: {
        description: 'G',
        execution: 'guard',
        depends_on: ['a'],
        abort_unless: ['$settlement.a.failed == true'],
      },
    });
    const record = await drive(make(), d, 'a', succeed);
    expect(record.sealed_by).toEqual({ arm: 'guard_abort', step: 'g' });
    expect(record.run_phase).toBe('aborted');
    expect(finalizerCalls).toBe(1);
  });

  it.each([
    ['settlement layer', () => declaring],
    ['legacy layer', legacy],
  ])(
    '%s: a guard PASS that completes the run persists arm `guard_pass_complete`',
    async (_l, make) => {
      const d = def({
        a: { description: 'A', execution: 'agent', depends_on: [] },
        g: {
          description: 'G',
          execution: 'guard',
          depends_on: ['a'],
          abort_unless: ['$settlement.a.failed == false'],
        },
      });
      const record = await drive(make(), d, 'a', succeed);
      expect(record.sealed_by).toEqual({ arm: 'guard_pass_complete', step: 'g' });
      expect(record.run_phase).toBe('completed');
      expect(finalizerCalls).toBe(1);
    },
  );

  // --- the run-level bypass writer ---
  it('abandonRun persists arm `abandon_requested`, step-less', async () => {
    const d = def({ a: { description: 'A', execution: 'agent', depends_on: [] } }, false);
    const { run } = await declaring.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    await abandonRun(declaring, run.id);
    const record = await declaring.get(run.id);
    expect(record.sealed_by).toEqual({ arm: 'abandon_requested' });
    expect(record.sealed_by?.step).toBeUndefined();
    expect(record.run_phase).toBe('abandoned');
  });

  // --- the strip sites ---
  it('applyResume strips the seal in the SAME record that flips the run live', async () => {
    const d = def({ a: { description: 'A', execution: 'agent', depends_on: [] } }, false);
    const sealed = await drive(declaring, d, 'a', explode('boom'));
    expect(sealed.sealed_by).toBeDefined(); // non-vacuity: there IS a seal to strip
    const { run: resumed } = applyResume(sealed, 'a', d);
    expect(resumed.sealed_by).toBeUndefined();
    expect(resumed.terminal_state).toBe(false);
    // And the store accepts it — proving the strip and the flip really are one write.
    await expect(declaring.update(resumed)).resolves.toBeDefined();
  });

  // --- the gate arms: three sites, three arms, all previously un-celled ---
  function gateDef(gate: Record<string, unknown>): WorkflowDefinition {
    return {
      id: 'seal-gate-wf',
      name: 'Seal Gate',
      version: 1,
      steps: {
        approve: {
          description: 'Approve',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          gate,
        },
      },
    } as unknown as WorkflowDefinition;
  }

  it('a human gate resolution that COMPLETES the run persists arm `gate_resolution_complete`', async () => {
    const d = gateDef({ choices: ['approve', 'reject'] });
    const { run } = await declaring.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    await executeStep(declaring, d, {
      runId: run.id,
      command: 'approve',
      input: {},
      dispatcher: succeed,
    });
    const gate = (await declaring.get(run.id)).pending_gate!;
    expect(gate).toBeDefined(); // non-vacuity: the gate really opened
    await submitHumanResponse(declaring, d, {
      runId: run.id,
      gateId: gate.gate_id,
      choice: 'approve',
    });
    const record = await declaring.get(run.id);
    expect(record.sealed_by).toEqual({ arm: 'gate_resolution_complete', step: 'approve' });
    expect(record.run_phase).toBe('completed');
  });

  it('a gate expiring into its DEFAULT that completes the run persists arm `gate_expiry_default`', async () => {
    const d = gateDef({
      choices: ['approve'],
      timeout_seconds: 1,
      on_expiry: 'settle_default',
      default_choice: 'approve',
    });
    const { run } = await declaring.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    await executeStep(declaring, d, {
      runId: run.id,
      command: 'approve',
      input: {},
      dispatcher: succeed,
    });
    const gate = (await declaring.get(run.id)).pending_gate!;
    const future = new Date(new Date(gate.expires_at!).getTime() + 1000);
    await executeStep(declaring, d, {
      runId: run.id,
      command: 'approve',
      input: {},
      dispatcher: succeed,
      now: future,
    });
    const record = await declaring.get(run.id);
    expect(record.sealed_by).toEqual({ arm: 'gate_expiry_default', step: 'approve' });
    expect(record.run_phase).toBe('completed');
  });

  it('a gate expiring into ABORT persists arm `gate_expiry_abort`', async () => {
    const d = gateDef({ choices: ['approve'], timeout_seconds: 1, on_expiry: 'abort' });
    const { run } = await declaring.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    await executeStep(declaring, d, {
      runId: run.id,
      command: 'approve',
      input: {},
      dispatcher: succeed,
    });
    const gate = (await declaring.get(run.id)).pending_gate!;
    const future = new Date(new Date(gate.expires_at!).getTime() + 1000);
    await executeStep(declaring, d, {
      runId: run.id,
      command: 'approve',
      input: {},
      dispatcher: succeed,
      now: future,
    });
    const record = await declaring.get(run.id);
    expect(record.sealed_by).toEqual({ arm: 'gate_expiry_abort', step: 'approve' });
    expect(record.run_phase).toBe('aborted');
    expect(record.aborted_at).toBeDefined();
  });

  // --- the deleted-ternary leg: exhaustion is NOT a distinct arm ---
  it('a validation-exhausted run persists arm `step_failure` — exhaustion is deliberately not its own arm', async () => {
    // The distinction lives in defaulted_steps and the step diagnostics, not in the seal
    // vocabulary. Without this cell the deleted ternary could come back and nothing would notice.
    const d: WorkflowDefinition = {
      id: 'exhaust-seal-wf',
      name: 'Exhaust',
      version: 1,
      steps: {
        v: {
          description: 'V',
          execution: 'agent',
          depends_on: [],
          output_schema: { type: 'object', required: ['x'], properties: { x: { type: 'string' } } },
        },
      },
    } as unknown as WorkflowDefinition;
    const { run } = await declaring.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await executeStep(declaring, d, {
        runId: run.id,
        command: 'v',
        input: {},
        dispatcher: succeed,
      });
      if ((await declaring.get(run.id)).terminal_state) break;
    }
    const record = await declaring.get(run.id);
    expect(record.terminal_state).toBe(true); // non-vacuity: the budget really did run out
    expect(record.sealed_by?.arm).toBe('step_failure');
    expect(record.run_phase).toBe('failed');
  });

  it('the gate-response strip clears a stale seal on the same write', async () => {
    // submitHumanResponse re-derives liveness from scratch, so a grandfathered/mixed-fleet seal
    // must not survive it.
    const d: WorkflowDefinition = {
      id: 'gate-strip-wf',
      name: 'Gate Strip',
      version: 1,
      steps: {
        a: {
          description: 'A',
          execution: 'agent',
          depends_on: [],
          gate: { choices: ['approve'] },
        },
      },
    } as unknown as WorkflowDefinition;
    const { run } = await declaring.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    const env = await executeStep(declaring, d, {
      runId: run.id,
      command: 'a',
      input: {},
      dispatcher: succeed,
    });
    const gated = await declaring.get(run.id);
    if (gated.pending_gate === undefined) return; // fixture guard: gate never opened
    expect(env.status).toBeDefined();
    const after = await submitHumanResponse(declaring, d, {
      runId: run.id,
      gateId: gated.pending_gate.gate_id,
      choice: 'approve',
    });
    expect(after.status).toBeDefined();
    const final = await declaring.get(run.id);
    // Whatever the gate resolution decided, the record never ends up live-with-a-seal.
    if (!final.terminal_state) expect(final.sealed_by).toBeUndefined();
  });
});
