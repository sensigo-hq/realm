// race-receipt-729-pr6a.test.ts — #729 PR-6a (B7, B8): the MCP answer tool tells an answer another
// answer beat whose answer stands, in the assistant's words, through the one sentence-maker; the
// library's reply to the same answer carries the one admission's refusal (the MCP wire never
// publishes it, PR0-CONTRACT:88); an answer after an `on_expiry: abort` another call carried out
// says the time limit ended the run; `get_run_state` says when each answer was given. Acceptance
// checks 4 (MCP), 8, 9 and 18 (get_run_state). Check 10 (the form) is `form-627.test.ts`'s "a form
// accepted after another route settled the question records nothing" cell.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  executeStep,
  instantText,
  submitHumanResponse,
  type RunStore,
  type WorkflowDefinition,
  type WorkflowRegistrar,
} from '@sensigo/realm';
import { handleSubmitHumanResponse } from './submit-human-response.js';
import { handleGetRunState } from './get-run-state.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

/** `confirm` (a question; `on_expiry: abort` when asked), then `after` (`auto`) unless `last`. */
function gated(id: string, opts: { abort?: boolean; last?: boolean } = {}): WorkflowDefinition {
  return {
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      confirm: {
        description: 'Confirm.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: {
          choices: ['approve', 'reject'],
          ...(opts.abort === true ? { timeout_seconds: 60, on_expiry: 'abort' as const } : {}),
        },
      },
      ...(opts.last === true
        ? {}
        : {
            after: { description: 'After.', execution: 'auto' as const, depends_on: ['confirm'] },
          }),
    },
  };
}

describe('#729 PR-6a — submit_human_response tells an answer that was not recorded whose answer stands (B7)', () => {
  let h: TempHome;
  let runStore: RunStore;
  let workflowStore: WorkflowRegistrar;
  beforeEach(async () => {
    h = await makeTempHome();
    runStore = h.stores.runStore;
    workflowStore = h.stores.workflowStore;
  });
  afterEach(async () => {
    await h.cleanup();
  });

  async function atQuestion(d: WorkflowDefinition): Promise<{ runId: string; gateId: string }> {
    await workflowStore.register(d);
    const { record: run } = await runStore.create({
      workflowId: d.id,
      workflowVersion: 1,
      params: {},
    });
    await executeStep(runStore, d, {
      runId: run.id,
      command: 'confirm',
      input: {},
      dispatcher: async () => ({}),
    });
    return { runId: run.id, gateId: (await runStore.get(run.id)).record.pending_gate!.gate_id };
  }
  /** Alice's answer from a terminal, as `realm run respond --by alice` sends it; its time. */
  async function alice(d: WorkflowDefinition, runId: string, gateId: string): Promise<string> {
    const r = await submitHumanResponse(runStore, d, {
      runId,
      gateId,
      choice: 'approve',
      respondedBy: 'alice',
      route: 'cli',
    });
    if (r.status !== 'ok') throw new Error(`fixture: ${r.status}`);
    const entry = (await runStore.get(runId)).record.evidence.find(
      (e) => e.kind === 'gate_response',
    );
    return instantText(Date.parse(entry!.completed_at));
  }
  const tool = (runId: string, gateId: string, choice: string) =>
    handleSubmitHumanResponse(
      { run_id: runId, gate_id: gateId, choice },
      { runStore, workflowStore },
    );

  it('check 8: a different choice after alice — errors[0] is the beaten-different sentence in the assistant’s words; `attempted_choice`; the library’s `refusal` is `question_settled`', async () => {
    const d = gated('pr6a-m8');
    const { runId, gateId } = await atQuestion(d);
    const at = await alice(d, runId, gateId);
    const reply = await tool(runId, gateId, 'reject');
    const library = await submitHumanResponse(runStore, d, { runId, gateId, choice: 'reject' });
    const sentence = `Not recorded: your choice 'reject'. The question on step 'confirm' was already answered — approve, by "alice" (as stated), through a terminal, at ${at}.`;
    // (a) red when the tool says today's `Gate '…' was already resolved …`, the outcome lacks this
    //     call's choice, the hint loses what the run owes, the wire publishes `refusal`, or the
    //     library's reply carries none; (b) prints them.
    expect({
      error: reply.errors[0],
      hint: reply.context_hint,
      attempted_choice: reply.outcome?.attempted_choice,
      wireRefusal: 'refusal' in reply,
      libraryRefusal: library.refusal?.code,
    }).toEqual({
      error: sentence,
      hint: `${sentence} Owed to the engine: 'after' — call advance_run.`,
      attempted_choice: 'reject',
      wireRefusal: false,
      libraryRefusal: 'question_settled',
    });
  });

  it('check 8: once the run has ended after the winning answer — the same errors[0], and the library’s `refusal` is `run_ended`', async () => {
    const d = gated('pr6a-m8-ended', { last: true });
    const { runId, gateId } = await atQuestion(d);
    const at = await alice(d, runId, gateId);
    if ((await runStore.get(runId)).record.terminal_state === undefined) {
      throw new Error('fixture: the winning answer did not end the run');
    }
    const reply = await tool(runId, gateId, 'reject');
    const library = await submitHumanResponse(runStore, d, { runId, gateId, choice: 'reject' });
    // (a) red when the ended run loses the winner's name, or the library's refusal is not the
    //     admission's verdict on the ended run; (b) prints them.
    expect({ error: reply.errors[0], libraryRefusal: library.refusal?.code }).toEqual({
      error: `Not recorded: your choice 'reject'. The question on step 'confirm' was already answered — approve, by "alice" (as stated), through a terminal, at ${at}.`,
      libraryRefusal: 'run_ended',
    });
  });

  it('check 9: the same choice after alice — `context_hint` is the beaten-same sentence; no late-answer line, no `answer_recorded`', async () => {
    const d = gated('pr6a-m9');
    const { runId, gateId } = await atQuestion(d);
    const at = await alice(d, runId, gateId);
    const reply = await tool(runId, gateId, 'approve');
    // (a) red on today's `… — no action was taken.`, or when the repeat is marked as beaten by the
    //     expiry (it would route into the late-answer lines); (b) prints them.
    expect({
      status: reply.status,
      hint: reply.context_hint,
      answer_recorded: reply.answer_recorded,
    }).toEqual({
      status: 'ok',
      hint: `Not recorded: the question on step 'confirm' already had this answer — approve, by "alice" (as stated), through a terminal, at ${at}.`,
      answer_recorded: undefined,
    });
  });

  it('check 4 (MCP): an answer after another call carried out `on_expiry: abort` — `outcome.by.kind: timeout`, `answer_recorded: false`, errors[0] the time-limit-aborted sentence', async () => {
    const d = gated('pr6a-m4', { abort: true });
    const { runId, gateId } = await atQuestion(d);
    const { record } = await runStore.get(runId);
    await runStore.update({
      ...record,
      pending_gate: { ...record.pending_gate!, expires_at: '2020-01-01T00:00:00.000Z' },
    });
    const drained = await runStore.settleStep(runId, { kind: 'expire_gate', gateId }, d);
    if (!drained.applied) throw new Error('fixture: the abort was not carried out');
    const reply = await tool(runId, gateId, 'approve');
    // (a) red on today's reply with no outcome and the bare `Run '<run>' is terminal …` refusal;
    //     (b) prints them.
    expect({
      by: reply.outcome?.by,
      answer_recorded: reply.answer_recorded,
      error: reply.errors[0],
    }).toEqual({
      by: { kind: 'timeout' },
      answer_recorded: false,
      error:
        "Not recorded: the question on step 'confirm' reached its time limit, and the run ended as aborted.",
    });
  });

  it("check 18 (get_run_state): `include_steps`'s `answers[0].at` equals the answer entry's `completed_at`", async () => {
    const d = gated('pr6a-m18');
    const { runId, gateId } = await atQuestion(d);
    await alice(d, runId, gateId);
    const summary = await handleGetRunState(
      { run_id: runId, include_steps: true },
      { runStore, workflowStore },
    );
    const entry = (await runStore.get(runId)).record.evidence.find(
      (e) => e.kind === 'gate_response',
    );
    // (a) red when the run view carries no time for the answer, or another one; (b) prints both.
    expect({
      at: summary.steps?.['confirm']?.answers?.[0]?.at,
      completed_at: entry?.completed_at,
    }).toEqual({ at: entry?.completed_at, completed_at: expect.any(String) });
  });
});
