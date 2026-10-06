// open-question-625.test.ts — issue #625 PR-2a, round 15 (the scoped walk's W1-R1 and W2-R1):
// - decision C103: every reply that meets an open question names it — `PendingView.open_question`,
//   core's ONE answer composer `answerAction` (the opening reply's `buildGateNextAction` calls it,
//   the claim token passed only there), `advanceRun`'s nothing-ran reply at a question, and
//   `describeNext`'s sentence;
// - decision C104: a step that is not eligible says why, offers what can be called (the view's
//   `next_actions`, the answer act among them) and routes by C94's rule;
// - decisions C105, C109, C110: the expiry line says what this call did, core prints nothing, and
//   a reply lists the line once.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceRun, executeChain, executeStep, submitHumanResponse } from './execution-loop.js';
import {
  answerAction,
  answerOf,
  describePending,
  notCallableReason,
  openQuestionOf,
  type PendingView,
} from './pending.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';

/** `q` (a question), then `after` (a bare `auto` step). `timeout`/`onExpiry` as given. */
function gated(onExpiry?: 'settle_default' | 'abort'): WorkflowDefinition {
  return {
    id: `oq-${onExpiry ?? 'none'}`,
    name: 'open question',
    version: 1,
    steps: {
      q: {
        description: 'Ask.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: {
          choices: ['approve', 'reject'],
          ...(onExpiry !== undefined ? { timeout_seconds: 60, on_expiry: onExpiry } : {}),
          ...(onExpiry === 'settle_default' ? { default_choice: 'approve' } : {}),
        },
      },
      after: { description: 'After.', execution: 'auto', depends_on: ['q'] },
    },
  };
}

/** `a` (agent; a precondition that never holds), `c` (`auto`, depends on `a`), and — with `b` — an independent agent step. */
function stranded(withB: boolean): WorkflowDefinition {
  return {
    id: withB ? 'oq-strand-b' : 'oq-strand',
    name: 'stranded',
    version: 1,
    steps: {
      a: {
        description: 'Answer a.',
        execution: 'agent',
        depends_on: [],
        preconditions: ["run.params.mode == 'live'"],
      },
      c: { description: 'After a.', execution: 'auto', depends_on: ['a'] },
      ...(withB ? { b: { description: 'Answer b.', execution: 'agent', depends_on: [] } } : {}),
    },
  };
}

const NOT_A_GATE_REPLY_TEXT =
  "Human review required for step 'q'. Ask the user to choose one of: approve, reject, then call submit_human_response with their choice.";

describe('#625 PR-2a, C103/C104/C105/C109/C110 — the open question, named everywhere', () => {
  let store: JsonFileStore;
  beforeEach(async () => {
    store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-oq-625-')));
  });
  afterEach(() => {
    vi.restoreAllMocks();
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
    return { runId: run.id, gateId: gate.gate_id, opened };
  }

  it('C103: the gate-opening reply is byte-identical — the token rides params, call_with and the text; the already-open reply has none', async () => {
    const d = gated();
    const { runId, gateId, opened } = await atQuestion(d);
    const token = opened.gate?.claim_token;
    expect(typeof token).toBe('string');
    // (a) red when the composer's gate-reply form changes a byte of the opening act, or drops the
    // token; (b) prints the act.
    expect(opened.next_actions).toEqual([
      {
        instruction: {
          tool: 'submit_human_response',
          params: { run_id: runId, gate_id: gateId, claim_token: token },
          call_with: {
            run_id: runId,
            gate_id: gateId,
            choice: '<approve|reject>',
            claim_token: token,
          },
        },
        human_readable:
          "Human review required for step 'q'. Present gate.display to the user, wait for their choice from gate.response_spec.choices, then call submit_human_response with call_with, passing claim_token back unchanged — it shows that this answer comes from the conversation that opened the question.",
        orientation: `Run is paused at gate '${gateId}'. Available choices: approve, reject.`,
      },
    ]);
    // (a) red when the composer's gate-reply form is not what the opening reply used; (b) prints both.
    expect(opened.next_actions[0]).toEqual(
      answerAction(
        runId,
        { step: 'q', gate_id: gateId, choices: ['approve', 'reject'] },
        token,
        'gate_reply',
      ),
    );
  });

  it('C103: advanceRun at an open question — the answer act (no token), no agent_action, a hint naming the step and its choices', async () => {
    const d = gated();
    const { runId, gateId } = await atQuestion(d);
    const reply = await advanceRun(store, d, { runId });
    // (a) red when the nothing-ran reply leaves `next_actions` empty, or carries the opening reply's
    // token; (b) prints the reply's acts.
    expect(reply.next_actions).toEqual([
      {
        instruction: {
          tool: 'submit_human_response',
          params: { run_id: runId, gate_id: gateId },
          call_with: { run_id: runId, gate_id: gateId, choice: '<approve|reject>' },
        },
        human_readable: NOT_A_GATE_REPLY_TEXT,
        orientation: `Run is paused at gate '${gateId}'. Available choices: approve, reject.`,
      },
    ]);
    // (a) red when the reply sets an agent_action (the opening reply sets none); (b) prints it.
    expect(reply.agent_action).toBeUndefined();
    // (a) red when the hint says "No step is ready." at a question; (b) prints the hint.
    expect(reply.context_hint).toBe(
      `Run '${runId}': nothing ran. Waiting on the question on step 'q' (choices: approve, reject) — answer it with submit_human_response.`,
    );
    expect(reply.status).toBe('ok');
  });

  it("C103, C117: describePending's open_question — before and after its time is up; none on a run with no question", async () => {
    const d = gated('settle_default');
    const { runId, gateId } = await atQuestion(d);
    const run = await store.get(runId);
    const question = { step: 'q', gate_id: gateId, choices: ['approve', 'reject'] };
    // (a) red when the view does not name the open question; (b) prints the view.
    expect(describePending(d, run, undefined, new Date()).open_question).toEqual(question);
    // (a) red when a due question loses the field (it is still the open question); (b) prints it.
    const past = new Date(new Date(run.pending_gate!.expires_at!).getTime() + 5_000);
    expect(describePending(d, run, undefined, past).open_question).toEqual(question);
    // (a) red when a run with no question gets one; (b) prints it.
    expect(
      describePending(
        d,
        { ...run, pending_gate: undefined } as unknown as RunRecord,
        undefined,
        new Date(),
      ).open_question,
    ).toBe(undefined);
    expect(openQuestionOf({ ...run, terminal_state: true } as RunRecord)).toBe(undefined);
    // (a) red when the act's reader does not give back the gate and choices; (b) prints it.
    expect(answerOf(answerAction(runId, question))).toEqual({
      gate_id: gateId,
      choices: ['approve', 'reject'],
    });
  });

  it('C104: a step not eligible behind an open question — the question named, its answer offered, resolve_precondition', async () => {
    const d = gated();
    const { runId, gateId } = await atQuestion(d);
    const reply = await executeStep(store, d, {
      runId,
      command: 'after',
      input: {},
      dispatcher: async () => ({}),
    });
    // (a) red when the reply does not name the question, or routes to report_to_user with the answer
    // act offered; (b) prints the reply.
    expect({
      status: reply.status,
      agent_action: reply.agent_action,
      hint: reply.context_hint,
      tools: reply.next_actions.map((a) => a.instruction?.tool),
      gate: reply.next_actions[0]?.instruction?.params['gate_id'],
      token: reply.next_actions[0]?.instruction?.params['claim_token'],
      blocked: reply.blocked_reason,
    }).toEqual({
      status: 'blocked',
      agent_action: 'resolve_precondition',
      hint: "Step 'after' cannot be called now: it waits on the question on step 'q' (choices: approve, reject) — answer it with submit_human_response.",
      tools: ['submit_human_response'],
      gate: gateId,
      token: undefined,
      blocked: {
        eligible_steps: [],
        suggestion: 'Answer the open question first, as next_actions says.',
      },
    });
  });

  it('C104: a step not eligible behind a stranded dependency, nothing else callable — report_to_user and the way out', async () => {
    const d = stranded(false);
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    const reply = await executeStep(store, d, {
      runId: run.id,
      command: 'c',
      input: {},
      dispatcher: async () => ({}),
    });
    // (a) red when the reply says resolve_precondition with nothing to call, drops the way out, or
    // does not name the step that cannot run; (b) prints the reply.
    expect({
      status: reply.status,
      agent_action: reply.agent_action,
      hint: reply.context_hint,
      next: reply.next_actions,
      blocked: reply.blocked_reason,
    }).toEqual({
      status: 'blocked',
      agent_action: 'report_to_user',
      hint:
        "Step 'c' cannot be called now: a step it depends on cannot run ('a'). 'a' cannot run (precondition): Precondition failed for step 'a'. Precondition failed: 'run.params.mode == 'live''. Resolved value: undefined." +
        ' Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.',
      next: [],
      blocked: { eligible_steps: [], suggestion: 'No other step can be called now.' },
    });
  });

  it('C104: a step not eligible beside a callable step — resolve_precondition, that step in next_actions', async () => {
    const d = stranded(true);
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    const reply = await executeStep(store, d, {
      runId: run.id,
      command: 'c',
      input: {},
      dispatcher: async () => ({}),
    });
    // (a) red when the callable step is not offered, or the routing is report_to_user; (b) prints it.
    expect({
      agent_action: reply.agent_action,
      next: reply.next_actions.map((a) => a.instruction?.params['command']),
      blocked: reply.blocked_reason,
      hint: reply.context_hint,
    }).toEqual({
      agent_action: 'resolve_precondition',
      next: ['b'],
      blocked: {
        eligible_steps: ['b'],
        suggestion: 'Call one of the steps indicated in next_actions instead.',
      },
      hint:
        "Step 'c' cannot be called now: a step it depends on cannot run ('a'). Ready for the agent: 'b'." +
        " 'a' cannot run (precondition): Precondition failed for step 'a'. Precondition failed: 'run.params.mode == 'live''. Resolved value: undefined.",
    });
  });

  it('C104: notCallableReason, every member', () => {
    const d: WorkflowDefinition = {
      id: 'w',
      name: 'w',
      version: 1,
      steps: {
        g: { description: 'g', execution: 'auto', depends_on: [] },
        a: { description: 'a', execution: 'agent', depends_on: [] },
        b: { description: 'b', execution: 'auto', depends_on: ['a'] },
        x: { description: 'x', execution: 'auto', depends_on: ['b'] },
      },
    };
    const base = {
      id: 'r',
      params: {},
      completed_steps: [],
      in_progress_steps: [],
      failed_steps: [],
      skipped_steps: [],
      evidence: [],
      terminal_state: false,
    } as unknown as RunRecord;
    const none: PendingView = {
      agent_actions: [],
      agent_steps: [],
      agent_refused: [],
      pending_guards: [],
      engine_runnable: [],
      cannot_run: [],
    };
    const q = { step: 'g', gate_id: 'g1', choices: ['y', 'n'] };
    // (a) red when a member's words change or the order of the checks changes; (b) prints the word.
    expect(notCallableReason(d, base, 'zz', none)).toBe("it is not a step of workflow 'w'");
    expect(
      notCallableReason(
        d,
        { ...base, terminal_state: true, sealed_by: { arm: 'complete' } } as RunRecord,
        'a',
        none,
      ),
    ).toBe('the run has ended (completed)');
    expect(notCallableReason(d, { ...base, completed_steps: ['a'] }, 'a', none)).toBe(
      'it has already completed',
    );
    expect(notCallableReason(d, { ...base, failed_steps: ['a'] }, 'a', none)).toBe(
      'it has already failed',
    );
    expect(notCallableReason(d, { ...base, skipped_steps: ['a'] }, 'a', none)).toBe(
      'it was skipped',
    );
    expect(
      notCallableReason(d, base, 'a', {
        ...none,
        open_question: q,
        expiry_due: { gate_id: 'g1', step: 'g', on_expiry: 'abort' },
      }),
    ).toBe(
      "it waits on the expired question on 'g' (its declared abort) — call advance_run to carry it out",
    );
    expect(notCallableReason(d, base, 'g', { ...none, open_question: q })).toBe(
      'its question is open (choices: y, n) — answer it with submit_human_response',
    );
    expect(notCallableReason(d, base, 'a', { ...none, open_question: q })).toBe(
      "it waits on the question on step 'g' (choices: y, n) — answer it with submit_human_response",
    );
    expect(notCallableReason(d, { ...base, in_progress_steps: ['a'] }, 'a', none)).toBe(
      'it is in flight (claimed by another call)',
    );
    expect(
      notCallableReason(d, base, 'x', {
        ...none,
        cannot_run: [
          { step: 'a', runnable_here: false, refused_by: 'precondition', refusal: 'no' },
        ],
      }),
    ).toBe("a step it depends on cannot run ('a')");
    expect(notCallableReason(d, base, 'x', none)).toBe("its dependencies are not settled ('b')");
    expect(notCallableReason(d, base, 'a', none)).toBe(
      'it is not eligible in the current run state',
    );
  });

  it('C104: a step called on a run that has ended — stop, nothing offered, the run named as ended', async () => {
    const d = stranded(false);
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    await store.update({
      ...(await store.get(run.id)),
      terminal_state: true,
      run_phase: 'abandoned',
      sealed_by: { arm: 'abandon_requested' },
    } as RunRecord);
    const reply = await executeStep(store, d, {
      runId: run.id,
      command: 'a',
      input: {},
      dispatcher: async () => ({}),
    });
    // (a) red when an ended run's refusal routes anywhere but stop, or offers a call; (b) prints it.
    expect({
      agent_action: reply.agent_action,
      next: reply.next_actions,
      hint: reply.context_hint,
      eligible: reply.blocked_reason?.eligible_steps,
    }).toEqual({
      agent_action: 'stop',
      next: [],
      hint: "Step 'a' cannot be called now: the run has ended (abandoned).",
      eligible: [],
    });
  });

  it('C105, C109: an embedding program calling advanceRun on a due expiry — nothing on stderr, the line in warnings, saying what this call did', async () => {
    const d = gated('settle_default');
    const { runId, gateId } = await atQuestion(d);
    const past = new Date(
      new Date((await store.get(runId)).pending_gate!.expires_at!).getTime() + 5_000,
    );
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const log = vi.spyOn(console, 'log');
    const stderr = vi.spyOn(process.stderr, 'write');
    const reply = await advanceRun(store, d, { runId, now: past });
    // (a) red when core prints the line (or anything) itself; (b) prints the calls.
    expect([warn.mock.calls, error.mock.calls, log.mock.calls, stderr.mock.calls]).toEqual([
      [],
      [],
      [],
      [],
    ]);
    // (a) red when the line says "before this call", drops the default choice, or is missing; (b)
    // prints the warnings.
    expect(reply.warnings).toEqual([
      `gate '${gateId}' on 'q' had expired — this advance_run call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: advance_run).`,
    ]);
  });

  it('C105: abort — the line says the run ended', async () => {
    const d = gated('abort');
    const { runId, gateId } = await atQuestion(d);
    const past = new Date(
      new Date((await store.get(runId)).pending_gate!.expires_at!).getTime() + 5_000,
    );
    const reply = await advanceRun(store, d, { runId, now: past });
    // (a) red when the abort's line does not say the run ended; (b) prints the warnings.
    expect(reply.warnings).toEqual([
      `gate '${gateId}' on 'q' had expired — this advance_run call first carried out its declared abort: the run ended (enacted_via: advance_run).`,
    ]);
  });

  it('C109: a store that cannot carry the expiry out — nothing printed, the could-not line in warnings, the hint never says it was carried out', async () => {
    const d = gated('abort');
    const { runId, gateId } = await atQuestion(d);
    const past = new Date(
      new Date((await store.get(runId)).pending_gate!.expires_at!).getTime() + 5_000,
    );
    const real = store.settleStep!.bind(store);
    const failing = Object.create(store) as JsonFileStore;
    failing.settleStep = async (id, delta, def, opts) => {
      if (delta.kind === 'expire_gate') throw new Error('store says no');
      return real(id, delta, def, opts);
    };
    const warn = vi.spyOn(console, 'warn');
    const reply = await advanceRun(failing, d, { runId, now: past });
    // (a) red when core prints the could-not line itself; (b) prints the calls.
    expect(warn.mock.calls).toEqual([]);
    // (a) red when the could-not case returns no line; (b) prints the warnings.
    expect(reply.warnings).toEqual([
      `gate '${gateId}' on 'q' had expired, but this advance_run call could not carry out its declared abort (store says no); it went on with the run as it was.`,
    ]);
    // (a) red when the hint says the expiry was carried out; (b) prints the hint.
    expect(reply.context_hint).not.toContain('was carried out as declared');
  });

  it('C110: execute_step on the step after an expired settle_default question — the line once in the reply', async () => {
    const d = gated('settle_default');
    const { runId } = await atQuestion(d);
    const past = new Date(
      new Date((await store.get(runId)).pending_gate!.expires_at!).getTime() + 5_000,
    );
    const reply = await executeChain(store, d, {
      runId,
      command: 'after',
      input: {},
      now: past,
      dispatcher: async () => ({}),
    });
    expect(reply.run_phase).toBe('completed');
    // (a) red when the reply lists the line twice (the named step's warnings carried again); (b)
    // prints the warnings.
    expect(reply.warnings.filter((w) => w.includes('had expired'))).toHaveLength(1);
  });

  it('C103: an answer with the wrong gate id is refused naming the question that IS open — its answer (no token), on both store kinds', async () => {
    const d = gated();
    for (const legacy of [false, true]) {
      const { runId, gateId } = await atQuestion(d);
      const target = legacy
        ? (Object.assign(Object.create(store) as JsonFileStore, {
            settleStep: undefined,
          }) as JsonFileStore)
        : store;
      const reply = await submitHumanResponse(target, d, {
        runId,
        gateId: 'not-the-gate',
        choice: 'approve',
      });
      // (a) red when the refusal offers nothing, or the wrong gate; (b) prints the reply's acts.
      expect({ legacy, status: reply.status, next: reply.next_actions }).toEqual({
        legacy,
        status: 'error',
        next: [answerAction(runId, { step: 'q', gate_id: gateId, choices: ['approve', 'reject'] })],
      });
    }
  });
});
