// caller-and-owed-625.test.ts — issue #625 PR-2a, round 17 (the scoped walk on round 16):
// - decision C133 (W3-R1): `advanceRun`'s `caller` is one of five words; any other value throws at
//   the admission step, before anything is read or written — the value named, the five listed (its
//   code `VALIDATION_CALLER_INVALID` since decision C144);
// - decision C134 (W1-Y2): the answer act outside the opening reply says the conversation that opened
//   the question passes back the claim_token it was given then (the opening reply is unchanged);
// - decision C135 (W2-Y1): a refused answer whose choice was not recorded — a late answer the expiry
//   beat, an answer another choice beat — keeps `report_to_user`, and its hint ends with what the run
//   owes, the view's next sentence;
// - decision C136 (W5-Y3): a `blocked` reply whose `next_actions` hold only the act says to call it.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  advanceRun,
  executeStep,
  expiryCarriedOutLine,
  submitHumanResponse,
} from './execution-loop.js';
import { ADVANCE_CALLERS } from './callers.js';
import { answerAction, describePending } from './pending.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const OPENER_SENTENCE =
  'The conversation that opened the question passes back the claim_token it was given then, when it was given one.';

/** `q` (a question, 60 s, `on_expiry` as given), then `after` (a bare `auto` step). */
function gated(onExpiry: 'settle_default' | 'abort' | undefined): WorkflowDefinition {
  return {
    id: `co-${onExpiry ?? 'none'}`,
    name: 'caller and owed',
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
          ...(onExpiry !== undefined ? { on_expiry: onExpiry } : {}),
          ...(onExpiry === 'settle_default' ? { default_choice: 'approve' } : {}),
        },
      },
      after: { description: 'After.', execution: 'auto', depends_on: ['q'] },
    },
  };
}

/** The store without `settleStep`: the legacy path of `submitHumanResponse`. */
function legacyOf(store: JsonFileStore): JsonFileStore {
  return Object.assign(Object.create(store) as JsonFileStore, { settleStep: undefined });
}

describe('#625 PR-2a, C133/C134/C135/C136 — the caller, the opener, what a refused answer leaves owed, the act', () => {
  let store: JsonFileStore;
  beforeEach(async () => {
    store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-co-625-')));
  });

  async function atQuestion(d: WorkflowDefinition) {
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    const opened = await executeStep(store, d, {
      runId: run.id,
      command: 'q',
      input: {},
      dispatcher: async () => ({}),
    });
    if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
    const gate = (await store.get(run.id)).pending_gate!;
    const past = new Date(new Date(gate.expires_at!).getTime() + 5_000);
    return { runId: run.id, gateId: gate.gate_id, past, token: opened.gate?.claim_token };
  }

  it('C133, W3-R1: an unknown caller throws before anything is read or written — the value named, the five listed (as a plain-JS program passes it)', async () => {
    const d = gated('settle_default');
    const { runId, past } = await atQuestion(d);
    const before = JSON.stringify(await store.get(runId));
    const calls: string[] = [];
    const watched = Object.create(store) as JsonFileStore;
    for (const m of ['get', 'update', 'settleStep', 'claimStep', 'create', 'list'] as const) {
      const own = (store[m] as (...a: unknown[]) => unknown).bind(store);
      Object.assign(watched, { [m]: (...a: unknown[]) => (calls.push(m), own(...a)) });
    }
    for (const [given, named] of [
      ['nightly-sweep', "'nightly-sweep'"],
      [42, '42'],
      [{ name: 'x' }, 'a value of type object'],
    ] as const) {
      let lines: string[] = [];
      // (a) red when the caller is not checked (the call runs and writes "this undefined call"),
      // the check runs after a read, or the message drops the value or the five; (b) prints it.
      await expect(
        advanceRun(watched, d, {
          runId,
          now: past,
          caller: given as never,
          onExpiry: (line) => lines.push(line),
        }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_CALLER_INVALID',
        category: 'VALIDATION',
        agentAction: 'report_to_user',
        message: `advanceRun's caller is one of advanceRun, advance_run, advance, start_run, agent; it was given ${named}. To label the reply with a word of your own, pass command. Nothing was read or written.`,
      });
      // (a) red when the refusal read or wrote the store, or told onExpiry; (b) prints them.
      expect({ calls, lines }).toEqual({ calls: [], lines: [] });
      lines = [];
    }
    // (a) red when the run changed (the expiry was carried out); (b) prints the record.
    expect(JSON.stringify(await store.get(runId))).toBe(before);
  });

  it.each(ADVANCE_CALLERS.map((c) => [c]))(
    'C133: the caller %s is accepted — it names the reply and the expiry line',
    async (caller) => {
      const d = gated('settle_default');
      const { runId, gateId, past } = await atQuestion(d);
      const reply = await advanceRun(store, d, { runId, now: past, caller });
      // (a) red when a member of the five is refused or renamed; (b) prints the reply's fields.
      expect({
        status: reply.status,
        command: reply.command,
        line: reply.warnings[0],
        phase: reply.run_phase,
      }).toEqual({
        status: 'ok',
        command: caller,
        line: expiryCarriedOutLine(
          gateId,
          'q',
          { on_expiry: 'settle_default', choice: 'approve' },
          caller,
          5_000,
        ),
        phase: 'completed',
      });
      // (a) red when the line says `undefined` or names another call; (b) prints it.
      expect(reply.warnings[0]).toContain(`(enacted_via: ${caller}).`);
      expect(reply.warnings[0]).not.toContain('undefined');
    },
  );

  it('C134, W1-Y2: the answer act outside the opening reply says the opener passes back its claim_token — and doing so is what proves the answer; the opening reply does not say it', async () => {
    const d = gated(undefined);
    const { runId, gateId, token } = await atQuestion(d);
    // A wrong gate id: the refusal offers the answer act, with no token.
    const refused = await submitHumanResponse(store, d, {
      runId,
      gateId: 'not-the-gate',
      choice: 'approve',
    });
    const act = refused.next_actions[0]!;
    // (a) red when the sentence is dropped or worded otherwise; (b) prints the text.
    expect(act.human_readable).toBe(
      `Human review required for step 'q'. Ask the user to choose one of: approve, reject, then call submit_human_response with their choice. The question's text, when its gate declares a message, is get_run_state's pending_gate.resolved_message. ${OPENER_SENTENCE}`,
    );
    // (a) red when the refusal's act carries the token (only the opening reply does); (b) prints it.
    expect(JSON.stringify(act)).not.toContain('claim_token"');
    // The opener follows it, passing back the token it was given when the question opened.
    expect(token).toBeDefined();
    const answered = await submitHumanResponse(store, d, {
      runId,
      gateId,
      choice: 'approve',
      claimToken: token!,
    });
    // (a) red when the token the sentence names does not prove the answer; (b) prints the reply.
    expect({
      status: answered.status,
      proof: answered.gate_claim?.proof,
      warnings: answered.warnings,
    }).toEqual({ status: 'ok', proof: 'matched', warnings: [] });
    // (a) red when the opening form says it too (it carries the token itself); (b) prints the text.
    const opening = answerAction(
      runId,
      { step: 'q', gate_id: gateId, choices: ['approve', 'reject'] },
      'tok',
      'gate_reply',
    );
    expect(opening.human_readable).not.toContain(OPENER_SENTENCE);
  });

  it('C135, W2-Y1: a late answer the expiry beat keeps report_to_user and its hint ends with what the run owes — on both store kinds', async () => {
    const d = gated('settle_default');
    for (const legacy of [false, true]) {
      const { runId, gateId, past } = await atQuestion(d);
      const reply = await submitHumanResponse(legacy ? legacyOf(store) : store, d, {
        runId,
        gateId,
        choice: 'reject',
        now: past,
      });
      const run = await store.get(runId);
      // (a) red when the hint does not say what the run owes, says it differently from the view, the
      // routing changes, or next_actions are not the view's; (b) prints the reply.
      expect({
        legacy,
        status: reply.status,
        agent_action: reply.agent_action,
        recorded: reply.answer_recorded,
        hint: reply.context_hint,
        error: reply.errors[0],
        next: reply.next_actions,
      }).toEqual({
        legacy,
        status: 'error',
        agent_action: 'report_to_user',
        recorded: false,
        hint: `Gate '${gateId}' was settled by timeout with choice 'approve' — your choice 'reject' was not recorded. Owed to the engine: 'after' — call advance_run.`,
        error: `Gate '${gateId}' was settled by timeout with choice 'approve' — your choice 'reject' was not recorded.`,
        next: [describePending(d, run, undefined, past).act],
      });
    }
  });

  it('C135 CONTROL: a late answer to a question whose expiry ends the run — the hint says nothing owed, nothing offered', async () => {
    const d = gated('abort');
    const { runId, gateId, past } = await atQuestion(d);
    const reply = await submitHumanResponse(store, d, {
      runId,
      gateId,
      choice: 'reject',
      now: past,
    });
    // (a) red when a run that has ended is said to owe something; (b) prints the reply.
    expect({
      hint: reply.context_hint,
      next: reply.next_actions,
      action: reply.agent_action,
    }).toEqual({
      hint: `Gate '${gateId}' on 'q' expired and the run aborted per the workflow's declared on_expiry — your choice was NOT recorded.`,
      next: [],
      action: 'report_to_user',
    });
  });

  it('C135: an answer another choice beat keeps report_to_user and its hint ends with what the run owes', async () => {
    const d = gated(undefined);
    const { runId, gateId } = await atQuestion(d);
    const first = await submitHumanResponse(store, d, { runId, gateId, choice: 'approve' });
    expect(first.status).toBe('ok');
    const reply = await submitHumanResponse(store, d, { runId, gateId, choice: 'reject' });
    const now = new Date();
    // (a) red when the hint does not say what the run owes, or the routing changes; (b) prints it.
    expect({
      status: reply.status,
      agent_action: reply.agent_action,
      hint: reply.context_hint,
      error: reply.errors[0],
      next: reply.next_actions.map((a) => a.instruction?.tool),
    }).toEqual({
      status: 'error',
      agent_action: 'report_to_user',
      hint: `Gate '${gateId}' was already resolved with choice 'approve' — your choice 'reject' was not recorded. Owed to the engine: 'after' — call advance_run.`,
      error: `Gate '${gateId}' was already resolved with choice 'approve' — your choice 'reject' was not recorded.`,
      next: ['advance_run'],
    });
    expect(reply.next_actions).toEqual([
      describePending(d, await store.get(runId), undefined, now).act,
    ]);
  });

  it("C136, W5-Y3: execute_step on the question's own step after its expiry was carried out by that call — the suggestion says to call advance_run, as next_actions holds only that", async () => {
    const d = gated('settle_default');
    const { runId, gateId, past } = await atQuestion(d);
    const reply = await executeStep(store, d, {
      runId,
      command: 'q',
      input: {},
      dispatcher: async () => ({}),
      now: past,
    });
    // (a) red when the suggestion names steps next_actions does not hold, or the list changes;
    // (b) prints the reply.
    expect({
      status: reply.status,
      agent_action: reply.agent_action,
      next: reply.next_actions.map((a) => a.instruction?.tool),
      blocked: reply.blocked_reason,
      hint: reply.context_hint,
      line: reply.warnings,
    }).toEqual({
      status: 'blocked',
      agent_action: 'resolve_precondition',
      next: ['advance_run'],
      blocked: { eligible_steps: ['after'], suggestion: 'Call advance_run, as next_actions says.' },
      hint: "Step 'q' cannot be called now: it has already completed. Owed to the engine: 'after' — call advance_run.",
      line: [
        expiryCarriedOutLine(
          gateId,
          'q',
          { on_expiry: 'settle_default', choice: 'approve' },
          'executeStep',
          5_000,
        ),
      ],
    });
  });
});
