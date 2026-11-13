// race-receipt-729-pr6a.test.ts — #729 PR-6a (B2, B8): the facts every door says whose answer stands
// from. An answer another answer beat carries this call's own choice (`attempted_choice`) and the
// winner's name read through the one reader (`readStatedAnswerer`); the library's conflict reply
// carries the one admission's refusal; an answer after an `on_expiry: abort` another call carried out
// gets an `outcome`; the answer view says when each answer was given.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach } from 'vitest';
import { executeStep, submitHumanResponse } from './execution-loop.js';
import { composeStepViews } from './step-view.js';
import { InMemoryStore, settableClock, type SettableClock } from '@sensigo/realm-testing';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

function clockedStore(): InMemoryStore {
  return new InMemoryStore({ clock: settableClock(new Date()) });
}
async function setClockOf(store: object, t: Date): Promise<void> {
  const clock = (store as { clock?: Partial<SettableClock> }).clock ?? {};
  if (typeof clock.set !== 'function') throw new Error('fixture: this store has no settable clock');
  await clock.set(t);
}

/** `review` (a question, 60 s), then `after` (`auto`) unless `last`; `on_expiry` as given. */
function gated(opts: { onExpiry?: 'abort'; last?: boolean } = {}): WorkflowDefinition {
  return {
    id: `pr6a-${opts.onExpiry ?? 'none'}-${opts.last === true ? 'last' : 'mid'}`,
    name: 'pr6a',
    version: 1,
    steps: {
      review: {
        description: 'Ask.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: {
          choices: ['approve', 'reject'],
          timeout_seconds: 60,
          ...(opts.onExpiry !== undefined ? { on_expiry: opts.onExpiry } : {}),
        },
      },
      ...(opts.last === true
        ? {}
        : { after: { description: 'After.', execution: 'auto' as const, depends_on: ['review'] } }),
    },
  };
}

describe('#729 PR-6a — the facts of an answer that was not recorded (B2) and of the answer view (B8)', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = clockedStore();
  });

  async function atQuestion(d: WorkflowDefinition): Promise<{ runId: string; gateId: string }> {
    const { record: run } = await store.create({
      workflowId: d.id,
      workflowVersion: 1,
      params: {},
    });
    const opened = await executeStep(store, d, {
      runId: run.id,
      command: 'review',
      input: {},
      dispatcher: async () => ({}),
    });
    if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
    return { runId: run.id, gateId: (await store.get(run.id)).record.pending_gate!.gate_id };
  }

  /** Alice's answer from a terminal, as `realm run respond --by alice` sends it. */
  async function alice(
    d: WorkflowDefinition,
    runId: string,
    gateId: string,
    // `null`: no name passed at all.
    respondedBy: string | null = 'alice',
  ): Promise<void> {
    const r = await submitHumanResponse(store, d, {
      runId,
      gateId,
      choice: 'approve',
      ...(respondedBy !== null ? { respondedBy } : {}),
      route: 'cli',
      principal: { absent: 'not_a_server_door' },
    });
    if (r.status !== 'ok') throw new Error(`fixture: ${r.status} ${r.errors.join(' ')}`);
  }

  it('check 8 (library): a different choice after alice — `attempted_choice`, the winner named, refusal `question_settled`', async () => {
    const d = gated();
    const { runId, gateId } = await atQuestion(d);
    await alice(d, runId, gateId);
    const reply = await submitHumanResponse(store, d, { runId, gateId, choice: 'reject' });
    // (a) red when this call's choice is not carried, the winner's name or door is lost, or the
    //     conflict reply carries no refusal (#729 comment 6237959686 item 15); (b) prints them.
    expect({
      status: reply.status,
      attempted_choice: reply.outcome?.attempted_choice,
      choice: reply.outcome?.choice,
      by: reply.outcome?.by,
      via: reply.outcome?.via,
      refusal:
        reply.refusal === undefined
          ? undefined
          : { code: reply.refusal.code, facts: reply.refusal.facts },
    }).toEqual({
      status: 'error',
      attempted_choice: 'reject',
      choice: 'approve',
      by: { kind: 'answer', name: 'alice', basis: 'stated' },
      via: 'cli',
      refusal: { code: 'question_settled', facts: { gate_id: gateId } },
    });
  });

  it('check 8 (library), the run ended after the winning answer: refusal `run_ended`, the outcome still names alice', async () => {
    const d = gated({ last: true });
    const { runId, gateId } = await atQuestion(d);
    await alice(d, runId, gateId);
    if ((await store.get(runId)).record.terminal_state === undefined) {
      throw new Error('fixture: the winning answer did not end the run');
    }
    const reply = await submitHumanResponse(store, d, { runId, gateId, choice: 'reject' });
    // (a) red when the refusal is not the one admission's verdict on the ended run, or the outcome is
    //     lost once the run has ended (PR6-R-13, -R-17); (b) prints them.
    expect({
      refusal: reply.refusal?.code,
      name: reply.outcome?.by.kind === 'answer' ? reply.outcome.by.name : undefined,
      attempted_choice: reply.outcome?.attempted_choice,
    }).toEqual({ refusal: 'run_ended', name: 'alice', attempted_choice: 'reject' });
  });

  it('a same choice after alice: `ok`, `attempted_choice`, no refusal and no `answer_recorded`', async () => {
    const d = gated();
    const { runId, gateId } = await atQuestion(d);
    await alice(d, runId, gateId);
    const reply = await submitHumanResponse(store, d, { runId, gateId, choice: 'approve' });
    // (a) red when the repeat loses its own choice, gains a refusal, or is marked as beaten by the
    //     expiry (`answer_recorded` routes a reply into the late-answer lines); (b) prints them.
    expect({
      status: reply.status,
      attempted_choice: reply.outcome?.attempted_choice,
      refusal: reply.refusal,
      answer_recorded: reply.answer_recorded,
    }).toEqual({
      status: 'ok',
      attempted_choice: 'approve',
      refusal: undefined,
      answer_recorded: undefined,
    });
  });

  it.each([
    ['a name with spaces at either end', '  alice  ', { name: 'alice' }],
    ['a blank name', '   ', {}],
    ['no name', null, {}],
    ['a name with a control character', 'eve\u001b[31m', { name_absent: 'name_unreadable' }],
  ] as const)(
    "B2 (2): the winner's name, read as the answer view reads it — %s",
    async (_label, stored, expected) => {
      const d = gated();
      const { runId, gateId } = await atQuestion(d);
      // The library stores a name as given (#604): what the one reader makes of it is the fact.
      await alice(d, runId, gateId, stored);
      const reply = await submitHumanResponse(store, d, { runId, gateId, choice: 'reject' });
      const by = reply.outcome?.by;
      // (a) red when the raw name reaches `outcome` (a control character, the spaces), a blank name
      //     is shown, or a refused name gives no `name_absent`; (b) prints `by`.
      expect(by).toEqual({ kind: 'answer', ...expected, basis: 'stated' });
    },
  );

  it('B2 (3), check 4 (library): an answer after another call carried out `on_expiry: abort` — `outcome` (timeout, no choice, no expiry), not recorded', async () => {
    const d = gated({ onExpiry: 'abort' });
    const { runId, gateId } = await atQuestion(d);
    const { record } = await store.get(runId);
    await setClockOf(store, new Date(Date.parse(record.pending_gate!.expires_at!) + 5_000));
    // Another call — `realm run drain --expired` — carries the abort out first.
    const drained = await store.settleStep(runId, { kind: 'expire_gate', gateId }, d);
    if (!drained.applied) throw new Error('fixture: the expiry was not carried out');
    const reply = await submitHumanResponse(store, d, { runId, gateId, choice: 'approve' });
    // (a) red when the reply has no outcome (today's bare "is terminal" refusal), names a choice,
    //     claims a deadline it no longer read, or is not marked not recorded; (b) prints them.
    expect({
      status: reply.status,
      error_code: reply.error_code,
      answer_recorded: reply.answer_recorded,
      expiry_receipt: reply.expiry,
      outcome: reply.outcome,
    }).toEqual({
      status: 'error',
      error_code: 'STATE_RUN_TERMINAL',
      answer_recorded: false,
      expiry_receipt: undefined,
      outcome: {
        by: { kind: 'timeout' },
        via: { absent: 'settled_by_expiry' },
        at: expect.any(String),
        step: 'review',
        attempted: true,
        attempted_choice: 'approve',
      },
    });
  });

  it("check 18 (core): the answer view's `at` is the answer entry's `completed_at`", async () => {
    const d = gated();
    const { runId, gateId } = await atQuestion(d);
    await alice(d, runId, gateId);
    const { record } = await store.get(runId);
    const entry = record.evidence.find((e) => e.step_id === 'review' && e.kind === 'gate_response');
    const answers = composeStepViews(record)['review']?.answers ?? [];
    // (a) red when the view carries no time, or another one; (b) prints both.
    expect({ at: answers[0]?.at, completed_at: entry?.completed_at }).toEqual({
      at: entry?.completed_at,
      completed_at: expect.any(String),
    });
  });
});
