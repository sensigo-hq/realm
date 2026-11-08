// late-answer-625.test.ts — issue #625 PR-2a, decision C9: the two refused answers that leave the run
// open AND moved on name what the run owes now (the different-choice late answer; the
// gate_choice_conflict on a gate ANOTHER writer expired). Every other refusal keeps [].
import { describe, it, expect } from 'vitest';
import { InMemoryStore, settableClock, type SettableClock } from '@sensigo/realm-testing';
import { executeStep, submitHumanResponse } from './execution-loop.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { nextCalls } from '../test-support/ways-view.js';

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

const def: WorkflowDefinition = {
  id: 'late-owed-wf',
  name: 'late owed',
  version: 1,
  steps: {
    confirm: {
      description: 'Confirm',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: {
        choices: ['approve', 'reject'],
        timeout_seconds: 1,
        on_expiry: 'settle_default',
        default_choice: 'approve',
      },
    },
    after: { description: 'After', execution: 'auto', depends_on: ['confirm'] },
  },
};

async function opened(store: InMemoryStore) {
  const { record: run } = await store.create({
    workflowId: def.id,
    workflowVersion: 1,
    params: {},
  });
  await executeStep(store, def, {
    runId: run.id,
    command: 'confirm',
    input: {},
    dispatcher: async () => ({}),
  });
  const gate = (await store.get(run.id)).record.pending_gate!;
  const afterExpiry = new Date(new Date(gate.expires_at!).getTime() + 60_000);
  return { runId: run.id, gateId: gate.gate_id, afterExpiry };
}

describe('#625 PR-2a — C9: a refused answer on a run that moved on names the owed work', () => {
  it('the different-choice late answer (its own expiry write settled another default): its ways end with advance (#729 PR-0: next_actions → ways)', async () => {
    const store = clockedStore();
    const { runId, gateId, afterExpiry } = await opened(store);
    await setClockOf(store, afterExpiry);
    const reply = await submitHumanResponse(store, def, {
      runId,
      gateId,
      choice: 'reject',
    });
    expect(reply.status).toBe('error');
    expect(reply.error_code).toBe('STATE_BLOCKED');
    expect(nextCalls(reply)).toEqual(['advance']);
  });

  it('gate_choice_conflict on a gate another writer expired: its ways end with advance (#729 PR-0: next_actions → ways)', async () => {
    const store = clockedStore();
    const { runId, gateId, afterExpiry } = await opened(store);
    await setClockOf(store, afterExpiry);
    await store.settleStep(runId, { kind: 'expire_gate', gateId }, def);
    const reply = await submitHumanResponse(store, def, {
      runId,
      gateId,
      choice: 'reject',
    });
    expect(reply.status).toBe('error');
    expect(nextCalls(reply)).toEqual(['advance']);
  });

  it('CONTROL: a refusal while the gate is still open (a choice not on the list) keeps next_actions empty', async () => {
    const store = clockedStore();
    const { runId, gateId } = await opened(store);
    const reply = await submitHumanResponse(store, def, { runId, gateId, choice: 'maybe' });
    expect(reply.status).toBe('error');
    expect(nextCalls(reply)).toEqual([]);
  });
});

describe('#625 PR-2a — advanceRun on a terminal run', () => {
  it('runs nothing and says so', async () => {
    const { advanceRun } = await import('./execution-loop.js');
    const store = clockedStore();
    const { record: run } = await store.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    await store.update({
      ...run,
      terminal_state: true,
      sealed_by: { arm: 'abandon_requested' },
      terminal_reason: 'Abandoned',
    } as never);
    const reply = await advanceRun(store, def, { runId: run.id });
    expect(reply.context_hint).toBe(
      `Run '${run.id}' is already terminal (abandoned); nothing ran.`,
    );
    expect(nextCalls(reply)).toEqual([]);
  });
});

// #715 (b) A.8 (iii) (D6-9, D6-61): the late answer and the expiry it meets share ONE write — before
// (b) the answer's write-free refusal was followed by a second `expire_gate` write, and the reply was
// composed at the host's instant. The reply is now judged at that one write's reading.
describe('#715 (b) A.8 (iii) — a late answer is one write, and its reply is judged at that write', () => {
  it('version + 1 once; the reply’s as_of is the enactment’s updated_at; the answer is not recorded', async () => {
    // (a) red when the late answer takes two writes again (two version steps), or the reply is
    //     composed at another instant than the write's (as_of ≠ updated_at); (b) prints both.
    const store = clockedStore();
    const { runId, gateId, afterExpiry } = await opened(store);
    const { record: before } = await store.get(runId);
    await setClockOf(store, afterExpiry);
    // The default's own choice: the `ok` late reply (a different choice is C9's error reply above).
    const reply = await submitHumanResponse(store, def, { runId, gateId, choice: 'approve' });
    const { record: after } = await store.get(runId);
    expect({
      status: reply.status,
      recorded: reply.answer_recorded,
      steps: after.version - before.version,
      as_of: reply.basis?.as_of,
    }).toEqual({ status: 'ok', recorded: false, steps: 1, as_of: after.updated_at });
  });
});
