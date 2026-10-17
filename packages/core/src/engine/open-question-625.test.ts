// open-question-625.test.ts — issue #625 PR-2a, round 15 (the scoped walk's W1-R1 and W2-R1):
// - decision C103: every reply that meets an open question names it — `PendingView.open_question`,
//   the ONE `respond` way (#729 PR-0: the opening reply's carries the claim's `proof`, no other),
//   `advanceRun`'s nothing-ran reply at a question;
// - decision C104: a step that is not eligible says why (`admitWay`'s code, `notCallableWords`),
//   carries what can be called (its ways, the answer among them) and routes by C94's rule (D-8);
// #729 PR-0: the doors' words for these replies are pinned in their renderer tests;
// - decisions C105, C109, C110: the expiry line says what this call did, core prints nothing, and
//   a reply lists the line once.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  advanceRun,
  executeChain,
  executeStep,
  notCallableWords,
  submitHumanResponse,
} from './execution-loop.js';
import { describePending, openQuestionOf } from './pending.js';
import { admitWay, composeWaysAt, type WayOn } from './ways.js';
import { writtenSnapshot } from './snapshot.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';
import type { EngineReply } from '../types/response-envelope.js';
import { agentActionFor, nextCalls, proofOf } from '../test-support/ways-view.js';

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

/** The reply's `respond` way, its `proof` read as presence only (never the token). */
function respondOf(reply: Pick<EngineReply, 'ways'>) {
  const way = reply.ways.find((w) => w.verb === 'respond');
  if (way === undefined || way.verb !== 'respond') return undefined;
  const { proof, ...rest } = way;
  return { ...rest, proof: proof !== undefined };
}

/** Every `respond` a reply carries — offered, or as a remedy of a refusal or an error. */
function respondsOf(reply: EngineReply): WayOn[] {
  return [
    ...reply.ways,
    ...(reply.error?.remedy ?? []),
    ...(reply.refusal?.remedy ?? []),
    ...reply.unavailable.flatMap((u) => u.remedy),
  ].filter((w) => w.verb === 'respond');
}

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

  it('C103: the gate-opening reply carries the ONE respond way, presented with the gate, with the proof', async () => {
    const d = gated();
    const { runId, gateId, opened } = await atQuestion(d);
    // (a) red when the opening reply drops the token; (b) prints true/false, never the token.
    expect(typeof proofOf(opened)).toBe('string');
    // (a) red when the respond way's gate, step, choices or presentation change, or the proof is
    //     dropped; (b) prints the way.
    expect(respondOf(opened)).toEqual({
      verb: 'respond',
      conditions: [],
      run_id: runId,
      gate_id: gateId,
      step: 'q',
      choice: { one_of: ['approve', 'reject'] },
      holds: [],
      presented: 'with_gate',
      proof: true,
    });
    expect(nextCalls(opened)).toEqual(['respond']);
    // (a) red when the hint carries the choices again (they are the respond way's); (b) prints it.
    expect(opened.context_hint).toBe(`Run is paused at gate '${gateId}'.`);
  });

  it('C103: advanceRun at an open question — the answer act (no token), no agent_action, a hint naming the step and its choices', async () => {
    const d = gated();
    const { runId, gateId } = await atQuestion(d);
    const reply = await advanceRun(store, d, { runId });
    // (a) red when the nothing-ran reply offers no answer, or carries the opening reply's token;
    // (b) prints the reply's ways.
    expect(nextCalls(reply)).toEqual(['respond']);
    expect(respondOf(reply)).toMatchObject({
      gate_id: gateId,
      step: 'q',
      presented: 'alone',
      proof: false,
    });
    expect(runId).toBe(reply.run_id);
    // (a) red when the reply sets an agent_action (the opening reply sets none); (b) prints it.
    expect(agentActionFor(reply)).toBeUndefined();
    // (a) red when the hint says "No step is ready." at a question; (b) prints the hint.
    // #729 PR-0 (D-B): core says what happened; the door appends what comes next (names_next).
    expect([reply.context_hint, reply.names_next]).toEqual([`Run '${runId}': nothing ran.`, true]);
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
    // (a) red when the respond way composed from the record does not give back the gate and
    //     choices (F6: from the record's open question); (b) prints it.
    const way = respondOf(composeWaysAt(run, new Date(), { definition: d }));
    expect({ gate_id: way?.gate_id, choices: way?.choice.one_of }).toEqual({
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
      agent_action: agentActionFor(reply),
      hint: reply.context_hint,
      code: reply.refusal?.code,
      next: nextCalls(reply),
      gate: respondOf(reply)?.gate_id,
      token: proofOf(reply),
      blocked: reply.blocked_reason,
    }).toEqual({
      status: 'blocked',
      agent_action: 'resolve_precondition',
      hint: "Step 'after' cannot be called now: it waits on the question on step 'q' (choices: approve, reject).",
      code: 'question_open',
      next: ['respond'],
      gate: gateId,
      token: undefined,
      blocked: { eligible_steps: [] },
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
      agent_action: agentActionFor(reply),
      hint: reply.context_hint,
      code: reply.refusal?.code,
      next: nextCalls(reply),
      cannot_run: reply.unavailable
        .filter((u) => u.code === 'refused_before_claim')
        .map((u) => [u.verb, u.step, u.remedy.map((w) => w.verb), u.no_remedy?.cause]),
      blocked: reply.blocked_reason,
    }).toEqual({
      status: 'blocked',
      agent_action: 'report_to_user',
      hint: "Step 'c' cannot be called now: a step it depends on cannot run ('a').",
      code: 'upstream_cannot_run',
      next: [],
      cannot_run: [
        ['run_step', 'a', ['register'], undefined],
        ['advance', 'a', ['register'], undefined],
      ],
      blocked: { eligible_steps: [] },
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
      agent_action: agentActionFor(reply),
      next: nextCalls(reply),
      blocked: reply.blocked_reason,
      hint: reply.context_hint,
      names_next: reply.names_next,
    }).toEqual({
      agent_action: 'resolve_precondition',
      next: ['run_step:b'],
      blocked: { eligible_steps: ['b'] },
      hint: "Step 'c' cannot be called now: a step it depends on cannot run ('a').",
      names_next: true,
    });
  });

  it('C104: every not-callable member — the code admitWay judges, then its words', async () => {
    const d: WorkflowDefinition = {
      id: 'w',
      name: 'w',
      version: 1,
      steps: {
        g: { description: 'g', execution: 'auto', depends_on: [] },
        a: { description: 'a', execution: 'agent', depends_on: [] },
        b: { description: 'b', execution: 'auto', depends_on: ['a'] },
        x: { description: 'x', execution: 'auto', depends_on: ['b'] },
        gd: { description: 'gd', execution: 'guard', depends_on: ['x'] },
        fin: { description: 'fin', execution: 'finalizer', depends_on: [] },
      } as WorkflowDefinition['steps'],
    };
    const base = {
      id: 'r',
      workflow_id: 'w',
      params: {},
      completed_steps: [],
      in_progress_steps: [],
      failed_steps: [],
      skipped_steps: [],
      evidence: [],
      terminal_state: false,
    } as unknown as RunRecord;
    const at = new Date();
    const judge = (record: RunRecord, step: string): string => {
      const admission = admitWay(
        'run_step',
        writtenSnapshot(record, at),
        { definition: { ok: d }, enactor: { kind: 'observer' }, store: {} },
        { run_id: 'r', command: step },
      );
      return 'ok' in admission ? 'ok' : `${admission.code}: ${notCallableWords(admission)}`;
    };
    // (a) red when a member's code or words change, or the order of the checks changes; (b) prints
    //     the code and the words.
    expect(judge(base, 'zz')).toBe("not_a_step: it is not a step of workflow 'w'");
    expect(
      judge({ ...base, terminal_state: true, sealed_by: { arm: 'complete' } } as RunRecord, 'a'),
    ).toBe('run_ended: the run has ended (completed)');
    expect(judge({ ...base, completed_steps: ['a'] }, 'a')).toBe(
      'step_settled: it has already completed',
    );
    expect(judge({ ...base, failed_steps: ['a'] }, 'a')).toBe(
      'step_settled: it has already failed',
    );
    expect(judge({ ...base, skipped_steps: ['a'] }, 'a')).toBe('step_settled: it was skipped');
    expect(judge(base, 'gd')).toBe(
      'step_engine_decided: it is a guard step: the engine runs it when the run reaches it',
    );
    expect(judge(base, 'fin')).toBe(
      'step_engine_decided: it is a cleanup step: the engine runs it when the run ends',
    );
    expect(judge({ ...base, in_progress_steps: ['a'] }, 'a')).toBe(
      'held_elsewhere: it is in flight (claimed by another call)',
    );
    expect(judge(base, 'x')).toBe("deps_unsettled: its dependencies are not settled ('b')");
    // The question members, on a real record: due (on_expiry declared, time up), the gated step,
    // a step another step's question holds.
    const q = gated('abort');
    const { runId, gateId } = await atQuestion(q);
    const open = await store.get(runId);
    const past = new Date(new Date(open.pending_gate!.expires_at!).getTime() + 5_000);
    const judgeAt = (step: string, when: Date): string => {
      const admission = admitWay(
        'run_step',
        writtenSnapshot(open, when),
        { definition: { ok: q }, enactor: { kind: 'observer' }, store: {} },
        { run_id: 'r', command: step },
      );
      return 'ok' in admission ? 'ok' : `${admission.code}: ${notCallableWords(admission)}`;
    };
    expect(judgeAt('after', past)).toBe(
      "question_due: it waits on the expired question on 'q' (its declared abort)",
    );
    expect(judgeAt('q', new Date())).toBe(
      'gated_step: its question is open (choices: approve, reject)',
    );
    expect(judgeAt('after', new Date())).toBe(
      "question_open: it waits on the question on step 'q' (choices: approve, reject)",
    );
    expect(gateId.length).toBeGreaterThan(0);
    // upstream_cannot_run: a step whose dependency is refused before its claim.
    const s = stranded(false);
    const { run: strandedRun } = await store.create({
      workflowId: s.id,
      workflowVersion: 1,
      params: {},
    });
    const sAdmission = admitWay(
      'run_step',
      writtenSnapshot(strandedRun, new Date()),
      { definition: { ok: s }, enactor: { kind: 'observer' }, store: {} },
      { run_id: strandedRun.id, command: 'c' },
    );
    expect('ok' in sAdmission ? 'ok' : `${sAdmission.code}: ${notCallableWords(sAdmission)}`).toBe(
      "upstream_cannot_run: a step it depends on cannot run ('a')",
    );
    // The default member: words for a code with no sentence of its own.
    expect(
      notCallableWords({
        verb: 'run_step',
        code: 'not_eligible',
        facts: { reason: 'nothing_owed' },
        remedy: [],
      }),
    ).toBe('it is not eligible in the current run state');
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
      agent_action: agentActionFor(reply),
      next: nextCalls(reply),
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
      `gate '${gateId}' on 'q' had expired 5s before this call — this advanceRun call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: advanceRun).`,
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
      `gate '${gateId}' on 'q' had expired 5s before this call — this advanceRun call first carried out its declared abort: the run ended (enacted_via: advanceRun).`,
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
      `gate '${gateId}' on 'q' had expired, but this advanceRun call could not carry out its declared abort (store says no); it went on with the run as it was.`,
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
      // (a) red when the refusal offers nothing, the wrong gate, or the token; (b) prints the
      //     reply's answers (gate, step, choices, proof presence).
      expect({
        legacy,
        status: reply.status,
        responds: respondsOf(reply).map((w) =>
          w.verb === 'respond'
            ? [
                w.run_id === runId,
                w.gate_id === gateId,
                w.step,
                w.choice.one_of,
                w.proof !== undefined,
              ]
            : [],
        ),
      }).toMatchObject({
        legacy,
        status: 'error',
        responds: expect.arrayContaining([[true, true, 'q', ['approve', 'reject'], false]]),
      });
      expect(respondsOf(reply).every((w) => w.verb === 'respond' && w.proof === undefined)).toBe(
        true,
      );
    }
  });
});
