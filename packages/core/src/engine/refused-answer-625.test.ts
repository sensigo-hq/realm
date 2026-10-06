// refused-answer-625.test.ts — issue #625 PR-2a, round 16 (the scoped walk on the merged head):
// - decision C117 (W3-R1): the view's clock is required — a wrong gate id on an expired question
//   offers `advance_run` and says its time is up, never the answer (which could not be recorded);
// - decision C118 (W1-Y2): a refused answer routes by C94's rule and its hint names the open question
//   (its step and gate id) — or says its time is up — or that none is open;
// - decision C122 (W3-Y1): the late answer's line is C105's — this submit_human_response call carried
//   the expiry out, or another call had;
// - decision C124 (W3-Y3): `advanceRun`'s caller names itself, on the reply and on the line;
// - decision C125 (W1-Y1): the answer act outside the opening reply says where the question's text is.
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
  type AdvanceCaller,
  type EnactedVia,
} from './execution-loop.js';
import { answerAction, describePending } from './pending.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { RunStore } from '../store/store-interface.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

/** `q` (a question, 60 s, `on_expiry` as given, a message), then `after` (`auto`; a precondition that never holds when `stuck`). */
function gated(
  onExpiry: 'settle_default' | 'abort' | undefined,
  stuck = false,
): WorkflowDefinition {
  return {
    id: `ra-${onExpiry ?? 'none'}${stuck ? '-stuck' : ''}`,
    name: 'refused answer',
    version: 1,
    steps: {
      q: {
        description: 'Ask.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: {
          message: 'Go ahead?',
          choices: ['approve', 'reject'],
          timeout_seconds: 60,
          ...(onExpiry !== undefined ? { on_expiry: onExpiry } : {}),
          ...(onExpiry === 'settle_default' ? { default_choice: 'approve' } : {}),
        },
      },
      after: {
        description: 'After.',
        execution: 'auto',
        depends_on: ['q'],
        ...(stuck ? { preconditions: ["run.params.mode == 'live'"] } : {}),
      },
    },
  };
}

/** The store without `settleStep`: the legacy path of `submitHumanResponse`. */
function legacyOf(store: JsonFileStore): JsonFileStore {
  return Object.assign(Object.create(store) as JsonFileStore, { settleStep: undefined });
}

describe('#625 PR-2a, C117/C118/C122/C124/C125 — the clock required, the refused answer, who carried it out', () => {
  let store: JsonFileStore;
  beforeEach(async () => {
    store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-ra-625-')));
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
    return { runId: run.id, gateId: gate.gate_id, past };
  }

  it('C117, C118: a wrong gate id on an EXPIRED question offers advance_run and says its time is up — resolve_precondition, on both store kinds', async () => {
    const d = gated('settle_default');
    for (const legacy of [false, true]) {
      const { runId, gateId, past } = await atQuestion(d);
      const reply = await submitHumanResponse(legacy ? legacyOf(store) : store, d, {
        runId,
        gateId: 'not-the-gate',
        choice: 'reject',
        now: past,
      });
      const first = legacy
        ? `Gate ID mismatch on run '${runId}'.`
        : "Gate 'not-the-gate' is not the open gate and matches no committed resolution.";
      // (a) red when the refusal's view has no clock (it offers the answer), routes to report_to_user
      // with something to call, or the hint does not say the time is up; (b) prints the reply.
      expect({
        legacy,
        status: reply.status,
        agent_action: reply.agent_action,
        next: reply.next_actions,
        hint: reply.context_hint,
      }).toEqual({
        legacy,
        status: 'error',
        agent_action: 'resolve_precondition',
        next: [describePending(d, await store.get(runId), undefined, past).act],
        hint: `${first} The question on step 'q' (gate '${gateId}') can no longer be answered: its time is up — call advance_run to carry out its declared settle_default.`,
      });
      expect(reply.next_actions.map((a) => a.instruction?.tool)).toEqual(['advance_run']);
      // (a) red when the refusal carried the expiry out itself; (b) prints the gate.
      expect((await store.get(runId)).pending_gate?.gate_id).toBe(gateId);
    }
  });

  it('C117 CONTROL: the same wrong gate id on an open question whose time is not up offers its answer — the question named, on both store kinds', async () => {
    const d = gated('settle_default');
    for (const legacy of [false, true]) {
      const { runId, gateId } = await atQuestion(d);
      const reply = await submitHumanResponse(legacy ? legacyOf(store) : store, d, {
        runId,
        gateId: 'not-the-gate',
        choice: 'reject',
      });
      const first = legacy
        ? `Gate ID mismatch on run '${runId}'.`
        : "Gate 'not-the-gate' is not the open gate and matches no committed resolution.";
      // (a) red when an unexpired question offers advance_run, the answer is missing, or the routing
      // is not C94's; (b) prints the reply.
      expect({
        legacy,
        agent_action: reply.agent_action,
        next: reply.next_actions,
        hint: reply.context_hint,
      }).toEqual({
        legacy,
        agent_action: 'resolve_precondition',
        next: [answerAction(runId, { step: 'q', gate_id: gateId, choices: ['approve', 'reject'] })],
        hint: `${first} The open question is on step 'q' (gate '${gateId}') — answer it as next_actions says.`,
      });
    }
  });

  it('C118: a wrong gate id when no question is open — the hint says none is; resolve_precondition with work to call, report_to_user with nothing', async () => {
    for (const [stuck, agentAction, tools] of [
      [false, 'resolve_precondition', ['advance_run']],
      [true, 'report_to_user', []],
    ] as const) {
      const d = gated(undefined, stuck);
      const { runId, gateId } = await atQuestion(d);
      const answered = await submitHumanResponse(store, d, { runId, gateId, choice: 'approve' });
      expect(answered.status).toBe('ok');
      const reply = await submitHumanResponse(store, d, {
        runId,
        gateId: 'not-the-gate',
        choice: 'approve',
      });
      // (a) red when the routing ignores next_actions (C94's rule), or the hint names a question that
      // is not open; (b) prints the reply.
      expect({
        stuck,
        agent_action: reply.agent_action,
        next: reply.next_actions.map((a) => a.instruction?.tool),
        hint: reply.context_hint,
      }).toEqual({
        stuck,
        agent_action: agentAction,
        next: [...tools],
        hint: "Gate 'not-the-gate' is not the open gate and matches no committed resolution. No question is open on this run.",
      });
    }
  });

  it("C122: the late answer's line is C105's — this submit_human_response call carried the expiry out (settle_default, both choices; abort), no 'ago', on both store kinds", async () => {
    for (const legacy of [false, true]) {
      for (const [onExpiry, choice] of [
        ['settle_default', 'approve'],
        ['settle_default', 'reject'],
        ['abort', 'approve'],
      ] as const) {
        const d = gated(onExpiry);
        const { runId, gateId, past } = await atQuestion(d);
        const reply = await submitHumanResponse(legacy ? legacyOf(store) : store, d, {
          runId,
          gateId,
          choice,
          now: past,
        });
        const line =
          onExpiry === 'settle_default'
            ? `gate '${gateId}' on 'q' had expired — this submit_human_response call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: submit).`
            : `gate '${gateId}' on 'q' had expired — this submit_human_response call first carried out its declared abort: the run ended (enacted_via: submit).`;
        // (a) red when the line says "before this response arrived", "expired 0m ago", or is not the
        // composer's; (b) prints the warnings.
        expect({ legacy, onExpiry, choice, warnings: reply.warnings.slice(0, 1) }).toEqual({
          legacy,
          onExpiry,
          choice,
          warnings: [line],
        });
        expect(reply.answer_recorded).toBe(false);
        expect(reply.warnings.join(' ')).not.toMatch(/ ago\b|before this response arrived/);
      }
    }
  });

  it('C122: a late answer that lost the race — another call had already carried the expiry out — says so, never "this call"', async () => {
    const d = gated('settle_default');
    const { runId, gateId, past } = await atQuestion(d);
    // Another process carries the expiry out between this answer's refusal (`gate_expired_pending`)
    // and its own `expire_gate` write — so that write finds the question already settled.
    const racing: RunStore = Object.assign(Object.create(store) as JsonFileStore, {
      settleStep: async (...args: Parameters<NonNullable<RunStore['settleStep']>>) => {
        const result = await store.settleStep(...args);
        if (args[1].kind === 'settle_gate' && !result.applied) {
          await store.settleStep(args[0], { kind: 'expire_gate', gateId }, args[2], { now: past });
        }
        return result;
      },
    });
    const reply = await submitHumanResponse(racing, d, {
      runId,
      gateId,
      choice: 'reject',
      now: past,
    });
    // (a) red when the line claims this call carried it out, or names a via; (b) prints the warnings.
    expect(reply.warnings[0]).toBe(
      `gate '${gateId}' on 'q' had expired — another call had already carried out its declared settle_default: the default choice 'approve' was recorded.`,
    );
    expect(reply.answer_recorded).toBe(false);
  });

  it('C124: advanceRun names its caller — the library default advanceRun, advance_run, advance — on the reply and on the line', async () => {
    for (const caller of [undefined, 'advance_run', 'advance'] as const) {
      const d = gated('settle_default');
      const { runId, gateId, past } = await atQuestion(d);
      const reply = await advanceRun(store, d, {
        runId,
        now: past,
        ...(caller !== undefined ? { caller } : {}),
      });
      const named: AdvanceCaller = caller ?? 'advanceRun';
      // (a) red when the library default is not advanceRun, or a caller's word is not used on both;
      // (b) prints the reply's command and line.
      expect({ caller, command: reply.command, line: reply.warnings[0] }).toEqual({
        caller,
        command: named,
        line: `gate '${gateId}' on 'q' had expired — this ${named} call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: ${named}).`,
      });
    }
  });

  it("C124: expiryCarriedOutLine, every member of enacted_via's vocabulary — the call each word names; another call's line", () => {
    const members: Array<[EnactedVia, string]> = [
      ['advanceRun', 'advanceRun'],
      ['advance_run', 'advance_run'],
      ['advance', 'advance'],
      ['start_run', 'start_run'],
      ['agent', 'agent'],
      ['execute_step', 'execute_step'],
      ['submit', 'submit_human_response'],
      ['timer', 'timer'],
    ];
    for (const [via, call] of members) {
      // (a) red when a member names the wrong call or drops enacted_via; (b) prints the line.
      expect(expiryCarriedOutLine('g1', 's', { on_expiry: 'abort' }, via)).toBe(
        `gate 'g1' on 's' had expired — this ${call} call first carried out its declared abort: the run ended (enacted_via: ${via}).`,
      );
    }
    // (a) red when the race form claims the call or names a via; (b) prints it.
    expect(
      expiryCarriedOutLine(
        'g1',
        's',
        { on_expiry: 'settle_default', choice: 'c' },
        'submit',
        false,
      ),
    ).toBe(
      "gate 'g1' on 's' had expired — another call had already carried out its declared settle_default: the default choice 'c' was recorded.",
    );
  });

  it("C125: the answer act outside the opening reply says where the question's text is — and it is there", async () => {
    const d = gated(undefined);
    const { runId, gateId } = await atQuestion(d);
    const act = answerAction(runId, { step: 'q', gate_id: gateId, choices: ['approve', 'reject'] });
    // (a) red when the pointer is dropped or names another field; (b) prints the text.
    expect(act.human_readable).toBe(
      "Human review required for step 'q'. Ask the user to choose one of: approve, reject, then call submit_human_response with their choice. The question's text, when its gate declares a message, is get_run_state's pending_gate.resolved_message.",
    );
    // (a) red when the record does not keep the gate's message where the pointer says; (b) prints it.
    expect((await store.get(runId)).pending_gate?.resolved_message).toBe('Go ahead?');
    // (a) red when the opening form says it (its text points at gate.display); (b) prints it.
    expect(
      answerAction(
        runId,
        { step: 'q', gate_id: gateId, choices: ['approve', 'reject'] },
        undefined,
        'gate_reply',
      ).human_readable,
    ).not.toContain('resolved_message');
  });
});
