// judged-isolation-715b.test.ts — issue #715 (b), Amendment 8 (1): the snapshot an engine reply hands
// back (`judgedSnapshotOf`) is its OWN record's, whichever key carried it inside core — a reply's
// `basis` (an on-time answer) or its `error` (an error reply with no ways: a late answer whose expiry
// aborted the run) — and a reply that read no run carries none, never another reply's. Three calls,
// one after another, on three different runs.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { advanceRun, submitHumanResponse } from './execution-loop.js';
import { judgedSnapshotOf } from './snapshot.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

/** A question that aborts the run when its 60 s are up. */
const ASK: WorkflowDefinition = {
  id: 'isolation-715b',
  name: 'isolation 715b',
  version: 1,
  steps: {
    q: {
      description: 'Ask.',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['approve', 'reject'], timeout_seconds: 60, on_expiry: 'abort' },
    },
  },
} as WorkflowDefinition;

const T0 = new Date('2026-10-30T10:00:00.000Z');

describe('#715 (b) Amendment 8 (1) — each reply hands back its own record’s snapshot', () => {
  it('an on-time answer, then a late answer whose expiry aborted another run, then a call on a run that does not exist', async () => {
    // (a) red when core keys a snapshot on an object two replies share (a module-level constant:
    //     the no-run reply then resolves to the aborted run's record); (b) prints, per call, the
    //     reply's status and the id of the record its snapshot holds.
    const clock = settableClock(T0);
    const store = new InMemoryStore({ clock });
    const opened = async () => {
      const { record } = await store.create({ workflowId: ASK.id, workflowVersion: 1, params: {} });
      await advanceRun(store, ASK, { runId: record.id });
      const { record: atGate } = await store.get(record.id);
      return { runId: record.id, gateId: atGate.pending_gate!.gate_id };
    };
    const a = await opened();
    const b = await opened();
    const answered = await submitHumanResponse(store, ASK, { ...a, choice: 'approve' });
    // Two minutes later on the store's clock: b's question expired, and its answer finds it so.
    await clock.set(new Date(T0.getTime() + 120_000));
    const aborted = await submitHumanResponse(store, ASK, { ...b, choice: 'approve' });
    const unread = await submitHumanResponse(store, ASK, {
      runId: 'no-such-run',
      gateId: b.gateId,
      choice: 'approve',
    });
    expect({
      answered: [answered.status, judgedSnapshotOf(answered)?.record.id === a.runId],
      // non-vacuity: the aborted reply has no ways, so no `basis` — its snapshot came by its `error`.
      aborted: [
        aborted.status,
        aborted.basis === undefined,
        judgedSnapshotOf(aborted)?.record.id === b.runId,
      ],
      unread: [unread.status, judgedSnapshotOf(unread)?.record.id],
    }).toEqual({
      answered: ['ok', true],
      aborted: ['error', true, true],
      unread: ['error', undefined],
    });
  });
});
