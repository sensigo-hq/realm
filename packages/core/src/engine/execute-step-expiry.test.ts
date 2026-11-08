// execute-step-expiry.test.ts — issue #291, Deliverable 4b: execute_step's pre-refusal
// enact-then-proceed. A step attempted while a sibling gate has expired unresolved enacts the
// gate's frozen disposition BEFORE the eligibility check — potentially un-blocking the very step
// being requested (level-triggering).
import { describe, it, expect } from 'vitest';
import { InMemoryStore, settableClock, type SettableClock } from '@sensigo/realm-testing';
import { executeStep } from './execution-loop.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepDispatcher } from './execution-loop.js';

/** #715 (b) (01 §C.4): the store's clock decides what is due — an in-memory store on a settable
 *  clock, first set to the host's reading, which `setClockOf` moves. */
function clockedStore(): InMemoryStore {
  return new InMemoryStore({ clock: settableClock(new Date()) });
}
async function setClockOf(store: object, t: Date): Promise<void> {
  const clock = (store as { clock?: Partial<SettableClock> }).clock ?? {};
  if (typeof clock.set !== 'function')
    throw new Error('setClockOf: this store has no settable clock');
  await clock.set(t);
}

const echoDispatcher: StepDispatcher = async (_name, input) => ({ ...input });

/** A gated step followed by a downstream step that only becomes eligible once the gate clears. */
function defWithGateThenDownstream(
  gate: NonNullable<WorkflowDefinition['steps'][string]['gate']>,
): WorkflowDefinition {
  return {
    id: 'execute-step-expiry-wf',
    name: 'Execute Step Expiry',
    version: 1,
    steps: {
      approve: {
        description: 'Approve',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate,
      },
      after: {
        description: 'After the gate',
        execution: 'auto',
        depends_on: ['approve'],
      },
    },
  };
}

async function withStore<T>(fn: (store: InMemoryStore) => Promise<T>): Promise<T> {
  return fn(clockedStore());
}

describe('executeStep — pre-refusal enact-then-proceed (issue #291)', () => {
  it('settle_default: an execute_step attempt on the DOWNSTREAM step enacts the expired gate first, then succeeds directly', async () => {
    await withStore(async (store) => {
      const def = defWithGateThenDownstream({
        timeout_seconds: 1,
        on_expiry: 'settle_default',
        default_choice: 'approve',
      });
      const { record: run } = await store.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      await executeStep(store, def, {
        runId: run.id,
        command: 'approve',
        input: {},
        dispatcher: echoDispatcher,
      });
      const gate = (await store.get(run.id)).record.pending_gate!;
      const future = new Date(new Date(gate.expires_at!).getTime() + 1000);

      // Attempting 'after' directly — normally STATE_STEP_NOT_ELIGIBLE while the gate is open.
      await setClockOf(store, future);
      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'after',
        input: {},
        dispatcher: echoDispatcher,
      });

      expect(envelope.status).toBe('ok');
      expect(envelope.command).toBe('after');
      expect(envelope.warnings?.some((w) => w.includes('(enacted_via: executeStep).'))).toBe(true);

      const { record: finalRun } = await store.get(run.id);
      expect(finalRun.pending_gate).toBeUndefined();
      expect(finalRun.completed_steps).toEqual(expect.arrayContaining(['approve', 'after']));
      expect(finalRun.settled?.['approve']).toMatchObject({ resolved_by: 'timeout' });
      // issue #367 census path: this run's seal comes from the LAST step, not the gate — the gate
      // expiry resolved the gate, and `after` then completed the run.
      expect(finalRun.sealed_by).toEqual({ arm: 'complete', step: 'after' });
    });
  });

  it('abort: an execute_step attempt on the downstream step observes the expired gate, enacts abort, and reports NOT_ELIGIBLE against the now-terminal run', async () => {
    await withStore(async (store) => {
      const def = defWithGateThenDownstream({ timeout_seconds: 1, on_expiry: 'abort' });
      const { record: run } = await store.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      await executeStep(store, def, {
        runId: run.id,
        command: 'approve',
        input: {},
        dispatcher: echoDispatcher,
      });
      const gate = (await store.get(run.id)).record.pending_gate!;
      const future = new Date(new Date(gate.expires_at!).getTime() + 1000);

      await setClockOf(store, future);
      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'after',
        input: {},
        dispatcher: echoDispatcher,
      });

      // The run is now terminal (aborted) — 'after' is blocked, but for a DIFFERENT, honest
      // reason than before, and the enactment is disclosed.
      expect(envelope.status).toBe('blocked');
      expect(
        envelope.warnings?.some(
          (w) => w.includes('enacted (abort)') || w.includes('carried out its declared abort'),
        ),
      ).toBe(true);

      const { record: finalRun } = await store.get(run.id);
      expect(finalRun.terminal_state).toBe(true);
      expect(finalRun.pending_gate).toBeUndefined();
      expect(finalRun.skip_details?.['approve']).toEqual({
        kind: 'gate_expired',
        gate_id: gate.gate_id,
      });
    });
  });

  it('finding-only mode: execute_step on a sibling never enacts anything (no on_expiry) — stays blocked, undisturbed', async () => {
    await withStore(async (store) => {
      const def = defWithGateThenDownstream({ timeout_seconds: 1 }); // no on_expiry
      const { record: run } = await store.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      await executeStep(store, def, {
        runId: run.id,
        command: 'approve',
        input: {},
        dispatcher: echoDispatcher,
      });
      const gate = (await store.get(run.id)).record.pending_gate!;
      const future = new Date(new Date(gate.expires_at!).getTime() + 1000);

      await setClockOf(store, future);
      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'after',
        input: {},
        dispatcher: echoDispatcher,
      });

      expect(envelope.status).toBe('blocked');
      expect(envelope.warnings ?? []).toEqual([]);
      const { record: finalRun } = await store.get(run.id);
      expect(finalRun.pending_gate).toBeDefined(); // untouched — nothing to enact
    });
  });

  it('a non-expired gate never triggers enactment — the downstream step stays blocked, unaffected', async () => {
    await withStore(async (store) => {
      const def = defWithGateThenDownstream({
        timeout_seconds: 600,
        on_expiry: 'settle_default',
        default_choice: 'approve',
      });
      const { record: run } = await store.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      await executeStep(store, def, {
        runId: run.id,
        command: 'approve',
        input: {},
        dispatcher: echoDispatcher,
      });
      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'after',
        input: {},
        dispatcher: echoDispatcher,
      });
      expect(envelope.status).toBe('blocked');
      const { record: finalRun } = await store.get(run.id);
      expect(finalRun.pending_gate).toBeDefined();
    });
  });
});
