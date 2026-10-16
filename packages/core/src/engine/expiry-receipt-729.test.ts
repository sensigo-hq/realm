// expiry-receipt-729.test.ts — issue #729 PR-0 (D4 T-2; DESIGN-PLAN A.3 #5, do-not-regress): every
// engine entry that can carry out an expired question's declared `on_expiry` names itself and the lag
// on the reply's `expiry` receipt. The [F1] NOOP — a call whose own expiry write finds the question
// already settled says `by_this_call: false` — is `late-lag-625.test.ts`'s race cell.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: the
// entry's word, the receipt's fields — gate ids and instants are the fixture's own.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  advanceRun,
  executeChain,
  executeEngineStep,
  executeStep,
  submitHumanResponse,
} from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { EngineReply } from '../types/response-envelope.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

/** `q` (a question; settle_default 60 s after it opens), `after` (auto), `side` (auto, independent). */
const D: WorkflowDefinition = {
  id: 'receipt',
  name: 'receipt',
  version: 1,
  steps: {
    q: {
      description: 'Ask.',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: {
        choices: ['approve', 'reject'],
        timeout_seconds: 60,
        on_expiry: 'settle_default',
        default_choice: 'approve',
      },
    },
    after: { description: 'After.', execution: 'auto', depends_on: ['q'] },
    side: { description: 'Side.', execution: 'auto', depends_on: ['q'] },
  },
} as WorkflowDefinition;

const LAG_MS = 7_000;

/** A run with its question open, and the instant `LAG_MS` after its deadline. */
async function due() {
  const store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-receipt-729-')));
  const { run } = await store.create({ workflowId: D.id, workflowVersion: 1, params: {} });
  await executeStep(store, D, {
    runId: run.id,
    command: 'q',
    input: {},
    dispatcher: async () => ({}),
  });
  const open = await store.get(run.id);
  const gateId = open.pending_gate!.gate_id;
  const deadline = open.pending_gate!.expires_at!;
  const now = new Date(new Date(deadline).getTime() + LAG_MS);
  return { store, runId: run.id, gateId, deadline, now, open };
}

/** The receipt's fields this law reads. */
const receipt = (reply: EngineReply) =>
  reply.expiry === undefined
    ? undefined
    : {
        on_expiry: reply.expiry.on_expiry,
        choice: reply.expiry.choice,
        enacted_via: reply.expiry.enacted_via,
        by_this_call: reply.expiry.by_this_call,
        overdue: reply.expiry.overdue,
      };

const CARRIED = (via: string) => ({
  on_expiry: 'settle_default',
  choice: 'approve',
  enacted_via: via,
  by_this_call: true,
  overdue: { ms: LAG_MS },
});

describe('#729 PR-0 — T-2, A.3 #5: each enactor of one deadline names itself and the lag', () => {
  it('advanceRun', async () => {
    const { store, runId, now } = await due();
    const reply = await advanceRun(store, D, { runId, now });
    // (a) red when the receipt drops the enactor or the lag; (b) prints the receipt.
    expect(receipt(reply)).toEqual(CARRIED('advanceRun'));
  });

  it('executeStep (a step named after the question)', async () => {
    const { store, runId, now } = await due();
    const reply = await executeStep(store, D, {
      runId,
      command: 'after',
      input: {},
      dispatcher: async () => ({}),
      now,
    });
    expect(receipt(reply)).toEqual(CARRIED('executeStep'));
  });

  it('executeChain', async () => {
    const { store, runId, now } = await due();
    const reply = await executeChain(store, D, {
      runId,
      command: 'after',
      input: {},
      dispatcher: async () => ({}),
      now,
    });
    expect(receipt(reply)).toEqual(CARRIED('executeChain'));
  });

  it('executeEngineStep', async () => {
    const { store, runId, now, open } = await due();
    const reply = await executeEngineStep(store, D, { runId, step: 'side', run: open, now });
    expect(receipt(reply)).toEqual(CARRIED('executeEngineStep'));
  });

  it('submitHumanResponse (a late answer)', async () => {
    const { store, runId, gateId, now } = await due();
    const reply = await submitHumanResponse(store, D, {
      runId,
      gateId,
      choice: 'reject',
      now,
    });
    expect(receipt(reply)).toEqual(CARRIED('submitHumanResponse'));
  });

  it('A.3 #13: the losing late answer is told the winning choice — outcome carries it, by the timeout', async () => {
    const { store, runId, gateId, now } = await due();
    const reply = await submitHumanResponse(store, D, { runId, gateId, choice: 'reject', now });
    // (a) red when the losing answer is not told what won; (b) prints the outcome's choice and kind.
    expect([reply.answer_recorded, reply.outcome?.choice, reply.outcome?.by.kind]).toEqual([
      false,
      'approve',
      'timeout',
    ]);
  });
});
