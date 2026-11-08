// submit-expiry-wins.test.ts — issue #291, SUBMIT_EXPIRY_WINS law family: a late
// submitHumanResponse call against an expired-unresolved gate is honestly composed against
// whatever the enforce clock actually enacted. #715 (b): one store path (the legacy CAS path is
// gone), and the store's clock — a settable clock — decides when the answer arrives.
import { describe, it, expect } from 'vitest';
import { InMemoryStore, settableClock, type SettableClock } from '@sensigo/realm-testing';
import { executeStep, submitHumanResponse } from './execution-loop.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepDispatcher } from './execution-loop.js';

const echoDispatcher: StepDispatcher = async (_name, input) => ({ ...input });

function defWithGate(
  gate: NonNullable<WorkflowDefinition['steps'][string]['gate']>,
): WorkflowDefinition {
  return {
    id: 'submit-expiry-wf',
    name: 'Submit Expiry Wins',
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
  };
}

/** #715 (b): the instant the store's clock starts at — the gate opens then. */
const START = new Date('2026-03-01T00:00:00.000Z');

async function withClock<T>(fn: (clock: SettableClock) => Promise<T>): Promise<T> {
  // #715 (b): the store's clock is a settable clock, first at START.
  return fn(settableClock(START));
}

/** An in-memory store on `clock`. */
const makeStore = (clock: SettableClock): InMemoryStore => new InMemoryStore({ clock });

describe('submitHumanResponse — SUBMIT_EXPIRY_WINS', () => {
  it('same-choice cell: the F12-pinned string, status ok, choice NOT double-attributed to the human', async () => {
    await withClock(async (clock) => {
      const store = makeStore(clock);
      const def = defWithGate({
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

      await clock.set(future);

      const envelope = await submitHumanResponse(store, def, {
        runId: run.id,
        gateId: gate.gate_id,
        choice: 'approve', // matches the frozen default_choice
      });

      expect(envelope.status).toBe('ok');
      expect(envelope.context_hint).toBe(
        'the outcome matches your choice, but it was settled by timeout; your response was not recorded.',
      );
      expect(
        envelope.warnings?.some((w) => w.includes('(enacted_via: submitHumanResponse).')),
      ).toBe(true);

      const { record: finalRun } = await store.get(run.id);
      expect(finalRun.settled?.['approve']).toMatchObject({
        outcome: 'gate',
        choice: 'approve',
        resolved_by: 'timeout',
      });
      const snapshot = finalRun.evidence.find((e) => e.kind === 'gate_response');
      expect(snapshot?.responded_by).toBe('timeout');
      expect(snapshot?.resolution).toBe('expired_default');
    });
  });

  it('conflict cell: a DIFFERENT late choice gets an honest refusal naming the timeout-settled winner', async () => {
    await withClock(async (clock) => {
      const store = makeStore(clock);
      const def = defWithGate({
        choices: ['approve', 'reject'],
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

      await clock.set(future);

      const envelope = await submitHumanResponse(store, def, {
        runId: run.id,
        gateId: gate.gate_id,
        choice: 'reject', // conflicts with the frozen default_choice
      });

      expect(envelope.status).toBe('error');
      expect(envelope.errors.join(' ')).toContain(
        "was settled by timeout with choice 'approve' — your choice 'reject' was not recorded",
      );
    });
  });

  it('abort cell: the THIRD discriminated run_terminal variant — "expired ... aborted ... NOT recorded"', async () => {
    await withClock(async (clock) => {
      const store = makeStore(clock);
      const def = defWithGate({ timeout_seconds: 1, on_expiry: 'abort' });
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

      await clock.set(future);

      const envelope = await submitHumanResponse(store, def, {
        runId: run.id,
        gateId: gate.gate_id,
        choice: 'approve',
      });

      expect(envelope.status).toBe('error');
      expect(envelope.error_code).toBe('STATE_RUN_TERMINAL');
      expect(envelope.errors.join(' ')).toContain('expired and the run aborted');
      expect(envelope.errors.join(' ')).toContain('your choice was NOT recorded');

      const { record: finalRun } = await store.get(run.id);
      expect(finalRun.terminal_state).toBe(true);
      expect(finalRun.skip_details?.['approve']).toEqual({
        kind: 'gate_expired',
        gate_id: gate.gate_id,
      });
      // Never the false gate_cancelled_by_abort attribution.
      expect(finalRun.skip_details?.['approve']).not.toMatchObject({
        kind: 'gate_cancelled_by_abort',
      });
    });
  });

  it('finding-only mode: a late response ALWAYS resolves normally — never refused, however overdue', async () => {
    await withClock(async (clock) => {
      const store = makeStore(clock);
      const def = defWithGate({ timeout_seconds: 1 }); // no on_expiry — finding-only
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
      const wayLate = new Date(new Date(gate.expires_at!).getTime() + 999_999_000);

      await clock.set(wayLate);

      const envelope = await submitHumanResponse(store, def, {
        runId: run.id,
        gateId: gate.gate_id,
        choice: 'approve',
      });

      expect(envelope.status).toBe('ok');
      const { record: finalRun } = await store.get(run.id);
      // Path-agnostic: the migrated path writes a `.settled` entry, the legacy path never has
      // one at all (pre-#279 shape) — both agree the step genuinely, humanly completed.
      expect(finalRun.completed_steps).toContain('approve');
      expect(finalRun.pending_gate).toBeUndefined();
      if (finalRun.settled?.['approve'] !== undefined) {
        expect(finalRun.settled['approve'].resolved_by).toBeUndefined(); // a REAL human resolved it
      }
    });
  });

  it('a response BEFORE expiry resolves normally, unaffected by a future expires_at', async () => {
    await withClock(async (clock) => {
      const store = makeStore(clock);
      const def = defWithGate({
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
      const gate = (await store.get(run.id)).record.pending_gate!;

      const envelope = await submitHumanResponse(store, def, {
        runId: run.id,
        gateId: gate.gate_id,
        choice: 'approve',
      });
      expect(envelope.status).toBe('ok');
      const { record: finalRun } = await store.get(run.id);
      expect(finalRun.settled?.['approve']?.resolved_by).toBeUndefined();
    });
  });
});
