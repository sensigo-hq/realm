// pending-625.test.ts — issue #625 PR-2a: what a run owes, read from its record (`describePending`),
// the one act that runs it (`advance_run`), and the loop that runs it (`advanceRun`).
//
// Laws pinned here (core): L5 progress-or-withdraw, L6 ownership on a store without `settleStep`,
// L8 witnesses (source text), L9 agreement (executeStep refuses exactly when the view says
// `runnable_here: false`, member by member), decision C3 (the bare-step output rule).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp as mkdtempP, rm as rmP } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonFileStore } from '../store/json-file-store.js';
import {
  advanceRun,
  buildNextActions,
  executeChain,
  executeStep,
  submitHumanResponse,
  bareStepOutput,
  finalizerOutcomeLines,
} from './execution-loop.js';
import {
  ADVANCE_OWED,
  CAPABILITY_BASES,
  PRE_CLAIM_REFUSALS,
  cannotRunWords,
  cannotRunClause,
  cannotRunWayOut,
  cannotRunWayOutApplies,
  cannotRunWayOutTools,
  checkPreClaim,
  composeNextActionsStatusWord,
  describeNext,
  describePending,
  describeRunDriver,
  engineStepInput,
  judgeProgramFit,
  owedWords,
  owedRunsClause,
  oneOf,
  respondCommand,
  waitingOnAnswer,
  waitingWords,
  pendingCleanupWay,
  pendingCleanupLine,
  pendingCleanupSentence,
  owedCallWords,
  endsWithCommand,
  sentenceEnd,
  type PendingView,
} from './pending.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { StepDispatcher } from './execution-loop.js';
import type { RunRecord, EvidenceSnapshot } from '../types/run-record.js';
import type { WorkflowDefinition, StepDefinition } from '../types/workflow-definition.js';
import type { ExtensionIdentityEntry } from '../types/extension-identity.js';
import type { RunStore } from '../store/store-interface.js';

const echo: StepDispatcher = async (_name, input) => ({ ...input });

async function withStore<T>(fn: (store: JsonFileStore) => Promise<T>): Promise<T> {
  const dir = await mkdtempP(join(tmpdir(), 'realm-pending-625-'));
  try {
    return await fn(new JsonFileStore(dir));
  } finally {
    await rmP(dir, { recursive: true, force: true });
  }
}

function def(steps: Record<string, StepDefinition>, extra?: Partial<WorkflowDefinition>) {
  return { id: 'pending-wf', name: 'Pending', version: 1, steps, ...extra } as WorkflowDefinition;
}

/** The tools' way out, as a literal (decisions C51, C57, C60). */
const TOOLS_WAY_OUT_TEXT =
  'Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.';

/** An open run with nothing in flight and no question open — the run describeNext reads (C57). */
const OPEN_RUN = {
  id: 'r',
  params: {},
  completed_steps: [],
  in_progress_steps: [],
  failed_steps: [],
  skipped_steps: [],
  evidence: [],
  terminal_state: false,
} as unknown as RunRecord;

const gateThenAuto = def({
  confirm: {
    description: 'Confirm',
    execution: 'auto',
    trust: 'human_confirmed',
    depends_on: [],
    gate: { choices: ['approve', 'reject'] },
  },
  after: { description: 'After', execution: 'auto', depends_on: ['confirm'] },
  finish: { description: 'Finish', execution: 'agent', depends_on: ['after'] },
});

async function answeredGateThenAuto(store: RunStore): Promise<string> {
  const { run } = await store.create({
    workflowId: gateThenAuto.id,
    workflowVersion: 1,
    params: {},
  });
  const opened = await executeStep(store, gateThenAuto, {
    runId: run.id,
    command: 'confirm',
    input: {},
    dispatcher: echo,
  });
  expect(opened.status).toBe('confirm_required');
  const gate = (await store.get(run.id)).pending_gate!;
  const answered = await submitHumanResponse(store, gateThenAuto, {
    runId: run.id,
    gateId: gate.gate_id,
    choice: 'approve',
  });
  expect(answered.status).toBe('ok');
  return run.id;
}

describe('#625 PR-2a — describePending, the act, the status word, the next sentence', () => {
  it('gate→auto after the answer: the act names the owed step, last; the answer reply says so', async () => {
    await withStore(async (store) => {
      const { run } = await store.create({
        workflowId: gateThenAuto.id,
        workflowVersion: 1,
        params: {},
      });
      await executeStep(store, gateThenAuto, {
        runId: run.id,
        command: 'confirm',
        input: {},
        dispatcher: echo,
      });
      const gate = (await store.get(run.id)).pending_gate!;
      const answered = await submitHumanResponse(store, gateThenAuto, {
        runId: run.id,
        gateId: gate.gate_id,
        choice: 'approve',
      });
      expect(answered.context_hint).toBe(
        "Gate 'confirm' resolved with choice 'approve'. Owed to the engine: 'after' — call advance_run.",
      );
      expect(answered.next_actions).toHaveLength(1);
      const act = answered.next_actions[0]!;
      expect(act.instruction).toEqual({
        tool: 'advance_run',
        params: { run_id: run.id },
        call_with: { run_id: run.id },
      });
      expect(act.human_readable).toBe(
        "Call advance_run to run the step the engine owes: 'after'. It runs it with this server's extensions and environment.",
      );
      expect(act.orientation).toBe("Run is active. Engine work is owed: 'after'.");
      const pending = describePending(gateThenAuto, await store.get(run.id), undefined, new Date());
      expect(composeNextActionsStatusWord(pending)).toBe(ADVANCE_OWED);
      expect(ADVANCE_OWED).toBe('advance_owed');
    });
  });

  it('describeNext, its four members: agent only, owed only, both, neither', () => {
    const base = {
      agent_actions: [],
      agent_steps: [],
      agent_refused: [],
      pending_guards: [],
      engine_runnable: [],
      cannot_run: [],
    };
    const act = { instruction: null, human_readable: '', orientation: '' };
    expect(describeNext({ ...base }, OPEN_RUN)).toBe(' No step is ready.');
    expect(describeNext({ ...base, agent_steps: ['a', 'b'] }, OPEN_RUN)).toBe(
      " Ready for the agent: 'a', 'b'.",
    );
    expect(
      describeNext(
        {
          ...base,
          pending_guards: ['g'],
          engine_runnable: [{ step: 'x', runnable_here: true }],
          act,
        },
        OPEN_RUN,
      ),
    ).toBe(
      " Owed to the engine: 'g', 'x' — call advance_run; it runs them until a step opens a question, fails or ends the run.",
    );
    expect(
      describeNext(
        {
          ...base,
          agent_steps: ['a'],
          engine_runnable: [{ step: 'x', runnable_here: 'unknown' }],
          act,
        },
        OPEN_RUN,
      ),
    ).toBe(" Ready for the agent: 'a'. Owed to the engine: 'x' — call advance_run.");
  });

  it('C34: describeNext names each engine step that cannot run, one cell per member, after the other clauses', () => {
    const base = {
      agent_actions: [],
      agent_steps: [],
      agent_refused: [],
      pending_guards: [],
      engine_runnable: [],
      cannot_run: [],
    };
    const act = { instruction: null, human_readable: '', orientation: '' };
    const refused = (
      check: 'trust' | 'precondition' | 'input_schema' | 'capability',
      refusal: string,
    ) => {
      const entry = { step: 'x', runnable_here: false as const, refused_by: check, refusal };
      return { ...base, engine_runnable: [entry], cannot_run: [entry] };
    };
    // decision C36: `here` for capability only — a runner with the handler could run it. Another
    // runner can run it, so no way out follows (C57).
    expect(
      describeNext(refused('capability', "handler 'h' is not registered here"), OPEN_RUN),
    ).toBe(" 'x' cannot run here (capability): handler 'h' is not registered here.");
    // decision C57: a step refused before its claim with nothing else ready — the run cannot go on
    // until its workflow is corrected, so the sentence ends with the way out.
    expect(describeNext(refused('trust', 'bad trust'), OPEN_RUN)).toBe(
      ` 'x' cannot run (trust): bad trust. ${TOOLS_WAY_OUT_TEXT}`,
    );
    // decision C37: a refusal that ends with a full stop gets no second one.
    expect(describeNext(refused('precondition', 'Resolved value: undefined.'), OPEN_RUN)).toBe(
      ` 'x' cannot run (precondition): Resolved value: undefined. ${TOOLS_WAY_OUT_TEXT}`,
    );
    expect(describeNext(refused('input_schema', "'n' must be number"), OPEN_RUN)).toBe(
      ` 'x' cannot run (input_schema): 'n' must be number. ${TOOLS_WAY_OUT_TEXT}`,
    );
    // After the agent and the owed clauses, in that order; `No step is ready.` never beside them.
    expect(
      describeNext(
        {
          ...base,
          agent_steps: ['a'],
          engine_runnable: [
            { step: 'x', runnable_here: false, refused_by: 'trust', refusal: 'bad' },
            { step: 'y', runnable_here: true },
          ],
          cannot_run: [{ step: 'x', runnable_here: false, refused_by: 'trust', refusal: 'bad' }],
          act,
        },
        OPEN_RUN,
      ),
    ).toBe(
      " Ready for the agent: 'a'. Owed to the engine: 'y' — call advance_run. 'x' cannot run (trust): bad.",
    );
    // Nothing else is said: only then `No step is ready.`
    expect(describeNext({ ...base }, OPEN_RUN)).toBe(' No step is ready.');
  });

  it("C33 at the reply sites: an answer judges the capability check with the CALL's registry, as get_run_state does", async () => {
    const d = def({
      act: { description: 'Act', execution: 'auto', depends_on: [], handler: 'note' },
      b: {
        description: 'B',
        execution: 'agent',
        depends_on: [],
        trust: 'human_confirmed',
        gate: { choices: ['approve', 'reject'] },
      },
    });
    const has = new ExtensionRegistry();
    has.register('handler', 'note', { id: 'note', execute: async () => ({ data: {} }) } as never);
    const answer = async (registry: ExtensionRegistry | undefined) =>
      withStore(async (store) => {
        const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
        // A runner that lacked the handler attempted the step: the marker is on the record.
        await advanceRun(store, d, { runId: run.id, registry: new ExtensionRegistry() });
        expect((await store.get(run.id)).capability_blocks?.['act']).toBeDefined();
        await executeStep(store, d, {
          runId: run.id,
          command: 'b',
          input: {},
          dispatcher: echo,
          registry: has,
        });
        const gate = (await store.get(run.id)).pending_gate!;
        return submitHumanResponse(store, d, {
          runId: run.id,
          gateId: gate.gate_id,
          choice: 'approve',
          ...(registry !== undefined ? { registry } : {}),
        });
      });
    // A server that HAS the handler: the act, whatever the old marker says.
    const capable = await answer(has);
    expect(capable.context_hint).toBe(
      "Gate 'b' resolved with choice 'approve'. Owed to the engine: 'act' — call advance_run.",
    );
    expect(capable.next_actions.map((a) => a.instruction?.tool)).toEqual(['advance_run']);
    // A server that lacks it: no act, the step named as one this server cannot run.
    const lacking = await answer(new ExtensionRegistry());
    expect(lacking.context_hint).toBe(
      "Gate 'b' resolved with choice 'approve'. 'act' cannot run here (capability): handler 'note' is not registered here — load the missing extension, or run the step on a runner that has it.",
    );
    expect(lacking.next_actions).toEqual([]);
    // A caller with no registry: the run's own marker is the freshest fact — past tense, since no
    // runner was consulted (decision C41).
    const none = await answer(undefined);
    expect(none.context_hint).toBe(
      "Gate 'b' resolved with choice 'approve'. 'act' could not run (capability): handler 'note' was not registered in the runner that last attempted it.",
    );
    expect(none.next_actions).toEqual([]);
  });

  it('C34 at the step sites: a completed step names a next step that cannot run, never "Waiting for other steps"', async () => {
    const d = def({
      w: { description: 'W', execution: 'agent', depends_on: [] },
      x: {
        description: 'X',
        execution: 'auto',
        depends_on: ['w'],
        preconditions: ['w.ok == true'],
      },
    });
    await withStore(async (store) => {
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const reply = await executeStep(store, d, {
        runId: run.id,
        command: 'w',
        input: { ok: false },
        dispatcher: echo,
      });
      expect(reply.status).toBe('ok');
      expect(reply.next_actions).toEqual([]);
      // decision C57: nothing else is ready, so the reply ends with the way out.
      expect(reply.context_hint).toBe(
        `Step 'w' completed. 'x' cannot run (precondition): Precondition failed for step 'x'. Precondition failed: 'w.ok == true'. Resolved value: false. ${TOOLS_WAY_OUT_TEXT}`,
      );
    });
  });

  it('C37: the act and the owed words agree with the count — the step / it, the steps / them', () => {
    const d = def({
      a: { description: 'A', execution: 'auto', depends_on: [] },
      b: { description: 'B', execution: 'auto', depends_on: [] },
    });
    const fresh = {
      id: 'r',
      params: {},
      completed_steps: [],
      in_progress_steps: [],
      failed_steps: [],
      skipped_steps: [],
      evidence: [],
      terminal_state: false,
    } as unknown as RunRecord;
    const two = describePending(d, fresh, undefined, new Date());
    // decision C207: with several owed, where one advance call stops — never a promise that all run.
    expect(owedWords(two)).toEqual({
      steps: 'the steps',
      them: 'them',
      until: ' until a step opens a question, fails or ends the run',
    });
    expect(owedRunsClause(two)).toBe(
      '; it runs them until a step opens a question, fails or ends the run',
    );
    expect(two.act!.human_readable).toBe(
      "Call advance_run to run the steps the engine owes: 'a', 'b'. It runs them with this server's extensions and environment until a step opens a question, fails or ends the run.",
    );
    const one = describePending(
      def({ a: { description: 'A', execution: 'auto', depends_on: [] } }),
      fresh,
      undefined,
      new Date(),
    );
    expect(owedWords(one)).toEqual({ steps: 'the step', them: 'it', until: '' });
    expect(owedRunsClause(one)).toBe('');
    expect(one.act!.human_readable).toBe(
      "Call advance_run to run the step the engine owes: 'a'. It runs it with this server's extensions and environment.",
    );
  });

  it('with an agent step ready AND engine work owed: the agent action first, the act last, status ok', async () => {
    const d = def({
      a: { description: 'A', execution: 'agent', depends_on: [] },
      b: { description: 'B', execution: 'auto', depends_on: [] },
    });
    await withStore(async (store) => {
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const actions = buildNextActions(d, run, undefined, new Date());
      expect(actions.map((x) => x.instruction?.tool)).toEqual(['execute_step', 'advance_run']);
      expect(
        composeNextActionsStatusWord(describePending(d, run, undefined, new Date())),
      ).toBeUndefined();
    });
  });

  it('a pending guard alone (a store without settleStep) owes the act — guards named first (L6)', () => {
    const d = def({
      g: {
        description: 'G',
        execution: 'guard',
        depends_on: ['w'],
        abort_unless: ['w.ok == true'],
      },
      w: { description: 'W', execution: 'agent', depends_on: [] },
      x: { description: 'X', execution: 'auto', depends_on: ['w'] },
    });
    const run = {
      id: 'r1',
      params: {},
      completed_steps: ['w'],
      in_progress_steps: [],
      failed_steps: [],
      skipped_steps: [],
      evidence: [{ step_id: 'w', status: 'success', output_summary: { ok: true } }],
      terminal_state: false,
    } as unknown as RunRecord;
    const pending = describePending(d, run, undefined, new Date());
    expect(pending.pending_guards).toEqual(['g']);
    expect(pending.act?.orientation).toBe("Run is active. Engine work is owed: 'g', 'x'.");
  });

  it('a terminal run and a run with an open gate owe nothing', () => {
    const d = def({ x: { description: 'X', execution: 'auto', depends_on: [] } });
    const live = {
      id: 'r',
      params: {},
      completed_steps: [],
      in_progress_steps: [],
      failed_steps: [],
      skipped_steps: [],
      evidence: [],
      terminal_state: false,
    } as unknown as RunRecord;
    expect(describePending(d, live, undefined, new Date()).act).toBeDefined();
    expect(
      describePending(d, { ...live, terminal_state: true }, undefined, new Date()).act,
    ).toBeUndefined();
    expect(
      describePending(
        d,
        {
          ...live,
          pending_gate: {
            gate_id: 'g',
            step_name: 'y',
            choices: ['a'],
            opened_at: '',
            preview: {},
          },
        } as RunRecord,
        undefined,
        new Date(),
      ).act,
    ).toBeUndefined();
  });
});

describe('#625 PR-2a — checkPreClaim, one cell per member of PRE_CLAIM_REFUSALS', () => {
  const live = (evidence: unknown[] = [], params = {}) =>
    ({
      id: 'r',
      params,
      completed_steps: ['w'],
      in_progress_steps: [],
      failed_steps: [],
      skipped_steps: [],
      evidence,
      terminal_state: false,
    }) as unknown as RunRecord;
  const w: StepDefinition = { description: 'W', execution: 'agent', depends_on: [] };

  it('the members, in the order executeStep runs them', () => {
    expect(PRE_CLAIM_REFUSALS).toEqual(['trust', 'precondition', 'input_schema', 'capability']);
  });

  it("trust: an invalid trust value is refused, with executeStep's own message", () => {
    const d = def({
      w,
      x: { description: 'X', execution: 'auto', depends_on: ['w'], trust: 'nope' as never },
    });
    const v = checkPreClaim({ definition: d, run: live(), step: 'x', input: {} });
    expect(v && 'refused_by' in v ? v.refused_by : undefined).toBe('trust');
    expect(describePending(d, live(), undefined, new Date()).engine_runnable).toEqual([
      expect.objectContaining({ step: 'x', runnable_here: false, refused_by: 'trust' }),
    ]);
  });

  it('precondition: the hint and the suggestion executeStep returns', () => {
    const d = def({
      w,
      x: {
        description: 'X',
        execution: 'auto',
        depends_on: ['w'],
        preconditions: ['w.ok == true'],
      },
    });
    const run = live([{ step_id: 'w', status: 'success', output_summary: { ok: false } }]);
    const v = checkPreClaim({ definition: d, run, step: 'x', input: {} });
    expect(v).toEqual({
      refused_by: 'precondition',
      refusal:
        "Precondition failed for step 'x'. Precondition failed: 'w.ok == true'. Resolved value: false.",
      hint: "Precondition failed for step 'x'.",
      suggestion: "Precondition failed: 'w.ok == true'. Resolved value: false.",
    });
  });

  it("input_schema: judged on the input the ENGINE passes (the run's params for a head step)", () => {
    const d = def({
      x: {
        description: 'X',
        execution: 'auto',
        depends_on: [],
        input_schema: {
          type: 'object',
          required: ['alpha'],
          properties: { alpha: { type: 'string' } },
        },
      },
    });
    expect(engineStepInput(d, live([], { alpha: 'a' }), 'x')).toEqual({ alpha: 'a' });
    expect(describePending(d, live([], {}), undefined, new Date()).engine_runnable[0]).toEqual({
      step: 'x',
      runnable_here: false,
      refused_by: 'input_schema',
      // decision C37: the field and what it must be (the first validation message).
      refusal: "Invalid input for step 'x': the input must have required property 'alpha'",
    });
    // ...while the engine's own error — what `executeStep` returns — stays byte-identical (D1.2).
    const verdict = checkPreClaim({ definition: d, run: live([], {}), step: 'x', input: {} });
    expect(verdict !== undefined && 'error' in verdict ? verdict.error?.message : undefined).toBe(
      "Invalid input for step 'x'",
    );
    // A nested field is named by its path.
    const nested = def({
      x: {
        description: 'X',
        execution: 'auto',
        depends_on: [],
        input_schema: {
          type: 'object',
          properties: { n: { type: 'object', properties: { m: { type: 'number' } } } },
        },
      },
    });
    expect(
      describePending(nested, live([], { n: { m: 'one' } }), undefined, new Date())
        .engine_runnable[0]?.refusal,
    ).toBe("Invalid input for step 'x': 'n.m' must be number");
    expect(
      describePending(d, live([], { alpha: 'a' }), undefined, new Date()).engine_runnable[0]
        ?.runnable_here,
    ).toBe(true);
  });

  it('capability: unknown with no registry; refused with one that lacks it; runnable with one that has it', () => {
    const d = def({ x: { description: 'X', execution: 'auto', depends_on: [], handler: 'h' } });
    expect(
      describePending(d, live(), undefined, new Date()).engine_runnable[0]?.runnable_here,
    ).toBe('unknown');
    expect(
      describePending(d, live(), new ExtensionRegistry(), new Date()).engine_runnable[0],
    ).toEqual({
      step: 'x',
      runnable_here: false,
      refused_by: 'capability',
      refusal: "handler 'h' is not registered here",
      basis: 'registry',
    });
    const reg = new ExtensionRegistry();
    reg.register('handler', 'h', { id: 'h', execute: async () => ({ data: {} }) });
    expect(describePending(d, live(), reg, new Date()).engine_runnable[0]?.runnable_here).toBe(
      true,
    );
    // A refused step is never named, so with nothing else owed the act is withdrawn.
    expect(describePending(d, live(), new ExtensionRegistry(), new Date()).act).toBeUndefined();
  });
});

describe('#625 PR-2a — L9 agreement: executeStep refuses exactly when the view says false', () => {
  const cases: Array<{ member: string; step: StepDefinition; params?: Record<string, unknown> }> = [
    {
      member: 'trust',
      step: { description: 'X', execution: 'auto', depends_on: [], trust: 'nope' as never },
    },
    {
      member: 'precondition',
      step: {
        description: 'X',
        execution: 'auto',
        depends_on: [],
        preconditions: ['missing.ok == true'],
      },
    },
    {
      member: 'input_schema',
      step: {
        description: 'X',
        execution: 'auto',
        depends_on: [],
        input_schema: { type: 'object', required: ['alpha'] },
      },
    },
  ];
  for (const c of cases) {
    it(`${c.member}: refused by both, with the same check named`, async () => {
      const d = def({ x: c.step });
      await withStore(async (store) => {
        const { run } = await store.create({
          workflowId: d.id,
          workflowVersion: 1,
          params: c.params ?? {},
        });
        const view = describePending(d, run, undefined, new Date()).engine_runnable[0]!;
        expect(view.runnable_here).toBe(false);
        expect(view.refused_by).toBe(c.member);
        const reply = await executeStep(store, d, {
          runId: run.id,
          command: 'x',
          input: engineStepInput(d, run, 'x'),
          dispatcher: echo,
        });
        expect(reply.status === 'ok' || reply.status === 'confirm_required').toBe(false);
        // write-free: the step was never claimed
        expect((await store.get(run.id)).in_progress_steps).toEqual([]);
      });
    });
    it(`${c.member}: CONTROL — fixed, both let it run`, async () => {
      const fixed: StepDefinition = { description: 'X', execution: 'auto', depends_on: [] };
      const d = def({ x: fixed });
      await withStore(async (store) => {
        const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
        expect(
          describePending(d, run, undefined, new Date()).engine_runnable[0]!.runnable_here,
        ).toBe(true);
        const reply = await executeStep(store, d, {
          runId: run.id,
          command: 'x',
          input: {},
          dispatcher: echo,
        });
        expect(reply.status).toBe('ok');
      });
    });
  }
  it('capability: the view with the registry says false exactly when the dispatch fails not-registered', async () => {
    const d = def({ x: { description: 'X', execution: 'auto', depends_on: [], handler: 'h' } });
    await withStore(async (store) => {
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const empty = new ExtensionRegistry();
      expect(describePending(d, run, empty, new Date()).engine_runnable[0]!.refused_by).toBe(
        'capability',
      );
      const reply = await executeStep(store, d, {
        runId: run.id,
        command: 'x',
        input: {},
        dispatcher: echo,
        registry: empty,
      });
      expect(reply.error_code).toBe('ENGINE_HANDLER_NOT_REGISTERED');
    });
  });
});

describe('#625 PR-2a — advanceRun: one call runs what is owed; L5 progress-or-withdraw', () => {
  it('gate→auto: one advanceRun runs the owed step and stops at the agent step', async () => {
    await withStore(async (store) => {
      const runId = await answeredGateThenAuto(store);
      const steps: string[] = [];
      const reply = await advanceRun(store, gateThenAuto, { runId, onStep: (s) => steps.push(s) });
      expect(steps).toEqual(['after']);
      expect(reply.status).toBe('ok');
      // decision C124: a program's own call names itself.
      expect(reply.command).toBe('advanceRun');
      expect(reply.chained_auto_steps?.map((c) => c.step)).toEqual(['after']);
      expect(reply.next_actions.map((a) => a.instruction?.tool)).toEqual(['execute_step']);
      // A repeat with nothing owed runs nothing and returns the view, never an error.
      const again = await advanceRun(store, gateThenAuto, { runId });
      expect(again.status).toBe('ok');
      expect(again.chained_auto_steps).toBeUndefined();
      expect(again.context_hint).toBe(
        `Run '${runId}': nothing ran. Ready for the agent: 'finish'.`,
      );
    });
  });

  it('two owed steps, the first refused before its claim: the call runs the second (never loops on the first)', async () => {
    const d = def({
      a: {
        description: 'A',
        execution: 'auto',
        depends_on: [],
        preconditions: ['missing.ok == true'],
      },
      b: { description: 'B', execution: 'auto', depends_on: [] },
    });
    await withStore(async (store) => {
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const steps: string[] = [];
      await advanceRun(store, d, { runId: run.id, onStep: (s) => steps.push(s) });
      expect(steps).toEqual(['b']);
      const after = await store.get(run.id);
      expect(after.completed_steps).toEqual(['b']);
      // L5: the act is withdrawn — only the refused step is left, and it is never named.
      expect(describePending(d, after, undefined, new Date()).act).toBeUndefined();
      expect(describePending(d, after, undefined, new Date()).engine_runnable).toEqual([
        expect.objectContaining({ step: 'a', runnable_here: false, refused_by: 'precondition' }),
      ]);
    });
  });

  it('capability with a registry: the call runs every step the view lets run first, then attempts the unmarked capability step ONCE (the marker); the next call skips it', async () => {
    const d = def({
      a: { description: 'A', execution: 'auto', depends_on: [], handler: 'h' },
      b: { description: 'B', execution: 'auto', depends_on: [] },
    });
    await withStore(async (store) => {
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const reg = new ExtensionRegistry();
      // The act names only `b` (the view refuses `a` for capability)…
      expect(describePending(d, run, reg, new Date()).act?.human_readable).toContain("'b'");
      const steps: string[] = [];
      const first = await advanceRun(store, d, {
        runId: run.id,
        registry: reg,
        onStep: (s) => steps.push(s),
      });
      // …so the call runs `b` first, then makes the one attempt that writes `a`'s marker (C4, C23).
      expect(steps).toEqual(['b', 'a']);
      expect(first.error_code).toBe('ENGINE_HANDLER_NOT_REGISTERED');
      const after = await store.get(run.id);
      expect(after.completed_steps).toEqual(['b']);
      expect(after.capability_blocks?.['a']).toBeDefined();
      const again: string[] = [];
      const second = await advanceRun(store, d, {
        runId: run.id,
        registry: reg,
        onStep: (s) => again.push(s),
      });
      expect(again).toEqual([]);
      expect(second.status).toBe('ok');
      expect(describePending(d, await store.get(run.id), reg, new Date()).act).toBeUndefined();
    });
  });

  it('a store without settleStep: gate→guard after the answer owes the act and advanceRun settles the guard (L6)', async () => {
    const d = def({
      confirm: {
        description: 'Confirm',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: { choices: ['approve', 'reject'] },
      },
      check: {
        description: 'Check',
        execution: 'guard',
        depends_on: ['confirm'],
        abort_unless: ["confirm.choice == 'approve'"],
      },
      finish: { description: 'Finish', execution: 'agent', depends_on: ['check'] },
    });
    await withStore(async (json) => {
      // The same store with `settleStep` hidden — the legacy two-write shape.
      const store = new Proxy(json, {
        get(target, prop, receiver) {
          if (prop === 'settleStep') return undefined;
          const v = Reflect.get(target, prop, receiver) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }) as unknown as RunStore;
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      await executeStep(store, d, {
        runId: run.id,
        command: 'confirm',
        input: {},
        dispatcher: echo,
      });
      const gate = (await store.get(run.id)).pending_gate!;
      await submitHumanResponse(store, d, {
        runId: run.id,
        gateId: gate.gate_id,
        choice: 'approve',
      });
      const afterAnswer = await store.get(run.id);
      expect(describePending(d, afterAnswer, undefined, new Date()).pending_guards).toEqual([
        'check',
      ]);
      expect(describePending(d, afterAnswer, undefined, new Date()).act).toBeDefined();
      await advanceRun(store, d, { runId: run.id });
      expect((await store.get(run.id)).completed_steps).toContain('check');
    });
  });

  const refusedStep: Record<'trust' | 'precondition' | 'input_schema', StepDefinition> = {
    trust: { description: 'X', execution: 'auto', depends_on: [], trust: 'not_a_level' as never },
    precondition: {
      description: 'X',
      execution: 'auto',
      depends_on: [],
      preconditions: ['missing.ok == true'],
    },
    input_schema: {
      description: 'X',
      execution: 'auto',
      depends_on: [],
      input_schema: { type: 'object', required: ['needed'] },
    },
  };
  for (const member of ['trust', 'precondition', 'input_schema'] as const) {
    it(`L5 ${member}: after advance_run, nothing ran and the act is withdrawn for that caller`, async () => {
      const d = def({ x: refusedStep[member] });
      await withStore(async (store) => {
        const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
        const before = describePending(d, await store.get(run.id), undefined, new Date());
        expect(before.act).toBeUndefined();
        expect(before.engine_runnable).toEqual([
          expect.objectContaining({ step: 'x', runnable_here: false, refused_by: member }),
        ]);
        const steps: string[] = [];
        const reply = await advanceRun(store, d, { runId: run.id, onStep: (s) => steps.push(s) });
        expect(steps).toEqual([]);
        expect(reply.status).toBe('ok');
        expect(reply.next_actions).toEqual([]);
        // decision C34: the reply names the step that cannot run instead of `No step is ready.`;
        // decision C37: one full stop, never two (the precondition refusal ends with its own).
        const refusal = before.engine_runnable[0]!.refusal!;
        // decision C51: nothing else is ready, so the reply ends with the way out in the tools' words.
        expect(reply.context_hint).toBe(
          `Run '${run.id}': nothing ran. 'x' cannot run (${member}): ${refusal}${refusal.endsWith('.') ? '' : '.'} Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.`,
        );
        expect(reply.context_hint).not.toContain('..');
        expect(
          describePending(d, await store.get(run.id), undefined, new Date()).act,
        ).toBeUndefined();
      });
    });
  }

  it('D3.2: an engine step another process holds is not run here — onTaken, re-read, continue', async () => {
    const d = def({
      x: { description: 'X', execution: 'auto', depends_on: [] },
      y: { description: 'Y', execution: 'auto', depends_on: [] },
    });
    await withStore(async (store) => {
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const other = { by: 'other@host', by_source: 'derived', channel: 'agent' } as const;
      const realClaim = store.claimStep.bind(store);
      let first = true;
      store.claimStep = async (...args: Parameters<RunStore['claimStep']>) => {
        if (first && args[1] === 'x') {
          first = false;
          await realClaim(args[0], args[1], args[2], other);
        }
        return realClaim(...args);
      };
      const taken: Array<{ step: string; holder: unknown }> = [];
      const steps: string[] = [];
      const reply = await advanceRun(store, d, {
        runId: run.id,
        onStep: (s) => steps.push(s),
        onTaken: (s, record) => taken.push({ step: s, holder: record.claims?.[s]?.holder }),
      });
      expect(steps).toEqual(['x', 'y']);
      expect(taken).toEqual([{ step: 'x', holder: other }]);
      expect(reply.status).toBe('ok');
      expect(reply.chained_auto_steps?.map((c) => c.step)).toEqual(['y']);
      const after = await store.get(run.id);
      expect(after.completed_steps).toEqual(['y']);
      expect(after.in_progress_steps).toEqual(['x']);
    });
  });

  it("C205: describeNext with nothing ready but steps in flight elsewhere names them and the wait — one, and several (`are`, `them`); a question's own step is not in flight", async () => {
    const d = def({
      a: { description: 'A', execution: 'auto', depends_on: [] },
      b: { description: 'B', execution: 'auto', depends_on: [] },
    });
    await withStore(async (store) => {
      const other = {
        by: 'other@host',
        by_source: 'derived' as const,
        channel: 'advance' as const,
      };
      const { run: one } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      await store.claimStep(one.id, 'a', d, other);
      await store.claimStep(one.id, 'b', d, other);
      const both = await store.get(one.id);
      const sentence = describeNext(describePending(d, both, undefined, new Date()), both);
      // (a) red when the steps in flight are not named, the plural words are wrong, or the wait is
      //     dropped; (b) prints the sentence.
      expect(sentence).toBe(
        " No step is ready: 'a', 'b' are in flight elsewhere — wait for them, then call get_run_state.",
      );
    });
  });

  it('D3.2: when the only owed step is taken, nothing ran — and the hint says what the record says now', async () => {
    const d = def({ x: { description: 'X', execution: 'auto', depends_on: [] } });
    await withStore(async (store) => {
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const realClaim = store.claimStep.bind(store);
      let first = true;
      store.claimStep = async (...args: Parameters<RunStore['claimStep']>) => {
        if (first) {
          first = false;
          await realClaim(args[0], args[1], args[2], {
            by: 'other@host',
            by_source: 'derived',
            channel: 'agent',
          });
        }
        return realClaim(...args);
      };
      const reply = await advanceRun(store, d, { runId: run.id });
      expect(reply.chained_auto_steps).toBeUndefined();
      expect(reply.next_actions).toEqual([]);
      // decision C25: the reply ends with one clause per step another process held; decision
      // C205: nothing is ready because 'x' is in flight elsewhere — the sentence says to wait.
      expect(reply.context_hint).toBe(
        `Run '${run.id}': nothing ran. No step is ready: 'x' is in flight elsewhere — wait for it, then call get_run_state. 'x' was claimed by another process, so it did not run here.`,
      );
    });
  });

  it("C25: a reply that ran a step still ends with the taken step's clause", async () => {
    const d = def({
      x: { description: 'X', execution: 'auto', depends_on: [] },
      y: { description: 'Y', execution: 'auto', depends_on: [] },
      z: { description: 'Z', execution: 'agent', depends_on: ['x', 'y'] },
    });
    await withStore(async (store) => {
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const realClaim = store.claimStep.bind(store);
      let first = true;
      store.claimStep = async (...args: Parameters<RunStore['claimStep']>) => {
        if (first && args[1] === 'x') {
          first = false;
          await realClaim(args[0], args[1], args[2], {
            by: 'other@host',
            by_source: 'derived',
            channel: 'agent',
          });
        }
        return realClaim(...args);
      };
      const reply = await advanceRun(store, d, { runId: run.id });
      expect(reply.chained_auto_steps?.map((c) => c.step)).toEqual(['y']);
      expect(
        reply.context_hint.endsWith(" 'x' was claimed by another process, so it did not run here."),
      ).toBe(true);
      expect(reply.context_hint.split('was claimed by another process')).toHaveLength(2);
    });
  });

  it('C24: the capability attempt’s reply is rebuilt with the call’s registry — no advance_run act for the step that just failed to dispatch', async () => {
    const d = def({
      x: { description: 'X', execution: 'auto', depends_on: [], handler: 'missing_h' },
      y: { description: 'Y', execution: 'agent', depends_on: [] },
    });
    await withStore(async (store) => {
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const reply = await advanceRun(store, d, {
        runId: run.id,
        registry: new ExtensionRegistry(),
      });
      expect(reply.status).toBe('error');
      expect(reply.error_code).toBe('ENGINE_HANDLER_NOT_REGISTERED');
      expect(reply.next_actions.map((a) => a.instruction?.tool)).toEqual(['execute_step']);
      expect(reply.next_actions.some((a) => a.instruction?.tool === 'advance_run')).toBe(false);
    });
  });
});

describe('#625 PR-2a — decision C3: the output of a bare step the engine runs', () => {
  const chainDef = def({
    draft: { description: 'Draft', execution: 'agent', depends_on: [] },
    middle: { description: 'Middle', execution: 'auto', depends_on: ['draft'] },
    last: { description: 'Last', execution: 'auto', depends_on: ['middle'] },
    head: { description: 'Head', execution: 'auto', depends_on: [] },
    two: { description: 'Two', execution: 'auto', depends_on: ['draft', 'head'] },
  });

  it('dependency (one and two hops), run_params (no depends_on), none (two dependencies), driven_step (the named step)', async () => {
    await withStore(async (store) => {
      const { run } = await store.create({
        workflowId: chainDef.id,
        workflowVersion: 1,
        params: { p: 1 },
      });
      const reply = await executeChain(store, chainDef, {
        runId: run.id,
        command: 'draft',
        input: { answer: 42 },
        dispatcher: async () => ({ answer: 42 }),
      });
      expect(reply.status).toBe('ok');
      const after = await store.get(run.id);
      const entry = (s: string): EvidenceSnapshot => after.evidence.find((e) => e.step_id === s)!;
      expect(entry('draft').output_source).toBeUndefined(); // an agent step: never stamped
      expect([entry('middle').output_summary, entry('middle').output_source]).toEqual([
        { answer: 42 },
        'dependency',
      ]);
      expect([entry('last').output_summary, entry('last').output_source]).toEqual([
        { answer: 42 },
        'dependency',
      ]);
      expect([entry('head').output_summary, entry('head').output_source]).toEqual([
        { p: 1 },
        'run_params',
      ]);
      expect([entry('two').output_summary, entry('two').output_source]).toEqual([{}, 'none']);
    });
  });

  it("a bare step the CALLER names records driven_step and the dispatcher's output", async () => {
    const d = def({ only: { description: 'Only', execution: 'auto', depends_on: [] } });
    await withStore(async (store) => {
      const { run } = await store.create({
        workflowId: d.id,
        workflowVersion: 1,
        params: { p: 1 },
      });
      await executeChain(store, d, {
        runId: run.id,
        command: 'only',
        input: {},
        dispatcher: async () => ({ mine: true }),
      });
      const e = (await store.get(run.id)).evidence.find((x) => x.step_id === 'only')!;
      expect([e.output_summary, e.output_source]).toEqual([{ mine: true }, 'driven_step']);
    });
  });

  it('bareStepOutput: a single dependency with no successful entry records none', () => {
    const run = { params: {}, evidence: [] } as unknown as RunRecord;
    expect(bareStepOutput(chainDef, run, 'middle')).toEqual({ source: 'none', output: {} });
  });

  it("an example's gate preview is byte-identical whether the chain or advance_run opens it", async () => {
    const d = def({
      write_review: { description: 'Write', execution: 'agent', depends_on: [] },
      confirm_review: {
        description: 'Confirm',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: ['write_review'],
        gate: { choices: ['approve', 'reject'] },
      },
    });
    const output = { review: 'looks good', score: 4 };
    const viaChain = await withStore(async (store) => {
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      await executeChain(store, d, {
        runId: run.id,
        command: 'write_review',
        input: output,
        dispatcher: async () => output,
      });
      return (await store.get(run.id)).pending_gate!.preview;
    });
    const viaAdvance = await withStore(async (store) => {
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      await executeStep(store, d, {
        runId: run.id,
        command: 'write_review',
        input: output,
        dispatcher: async () => output,
      });
      await advanceRun(store, d, { runId: run.id });
      return (await store.get(run.id)).pending_gate!.preview;
    });
    expect(JSON.stringify(viaAdvance)).toBe(JSON.stringify(viaChain));
  });
});

describe('#625 PR-2a — judgeProgramFit, D-8 table row by row', () => {
  const entry = (
    over: Partial<ExtensionIdentityEntry> = {},
    tree: Partial<ExtensionIdentityEntry['tree']> = {},
  ) =>
    ({
      captured_at: 't',
      modules: [{ declared: 'x', resolved: '/x', entry_hash: 'h', format: 'esm' }],
      tree: {
        roots: ['/'],
        rules: 'r1',
        file_count: 1,
        total_bytes: 1,
        tree_hash: 'T',
        truncated: false,
        ...tree,
      },
      coverage: 'dir_tree_v1',
      ...over,
    }) as ExtensionIdentityEntry;
  const runWith = (e?: ExtensionIdentityEntry) =>
    ({
      extension_identity: e === undefined ? undefined : [entry({}, { tree_hash: 'OLD' }), e],
    }) as unknown as RunRecord;
  it('same · differs · rules differ · truncated · error · one side absent · none', () => {
    expect(judgeProgramFit(runWith(entry()), entry())).toBe('same');
    expect(judgeProgramFit(runWith(entry()), entry({}, { tree_hash: 'U' }))).toBe('differs');
    expect(judgeProgramFit(runWith(entry()), entry({}, { rules: 'r2' }))).toBe('not_comparable');
    expect(
      judgeProgramFit(runWith(entry({}, { truncated: true })), entry({}, { truncated: true })),
    ).toBe('not_comparable');
    expect(judgeProgramFit(runWith(entry({ error: 'boom' })), entry())).toBe('not_comparable');
    expect(judgeProgramFit(runWith(entry()), undefined)).toBe('not_comparable');
    expect(judgeProgramFit(runWith(undefined), entry())).toBe('not_comparable');
    expect(judgeProgramFit(runWith(undefined), undefined)).toBe('none');
  });
});

describe('#625 PR-2a — describeRunDriver', () => {
  const driverDef = def({
    a: { description: 'A', execution: 'agent', depends_on: [] },
    b: { description: 'B', execution: 'agent', depends_on: ['a'] },
    c: { description: 'C', execution: 'auto', depends_on: ['b'] },
    d: { description: 'D', execution: 'auto', depends_on: ['c'] },
    g: { description: 'G', execution: 'guard', depends_on: ['d'] },
  });
  it('the newest entry that names its driver, and how many newer entries name none', () => {
    const run = {
      evidence: [
        {
          step_id: 'a',
          completed_at: 't1',
          driven_by: { by: 'old', by_source: 'derived', channel: 'agent' },
        },
        {
          step_id: 'b',
          completed_at: 't2',
          driven_by: { by: 'me', by_source: 'ambient', channel: 'agent' },
        },
        { step_id: 'c', completed_at: 't3' },
        { step_id: 'd', completed_at: 't4' },
      ],
    } as unknown as RunRecord;
    expect(describeRunDriver(run, driverDef)).toEqual({
      driver: { by: 'me', by_source: 'ambient', channel: 'agent' },
      step: 'b',
      at: 't2',
      newer_without_driver: 2,
    });
    expect(describeRunDriver({ evidence: [] } as unknown as RunRecord, driverDef)).toEqual({
      driver: { by: null, absent_cause: 'driver_not_recorded' },
      newer_without_driver: 0,
    });
  });
  it('C21: an answer entry and a guard entry are never counted (they never carry driven_by)', () => {
    const run = {
      evidence: [
        {
          step_id: 'b',
          completed_at: 't2',
          driven_by: { by: 'me', by_source: 'ambient', channel: 'agent' },
        },
        { step_id: 'confirm', kind: 'gate_response', completed_at: 't3' },
        { step_id: 'g', completed_at: 't4' },
      ],
    } as unknown as RunRecord;
    expect(describeRunDriver(run, driverDef).newer_without_driver).toBe(0);
  });
  it('C21, end to end: after an answered gate the count is 0', async () => {
    await withStore(async (store) => {
      const { run } = await store.create({
        workflowId: gateThenAuto.id,
        workflowVersion: 1,
        params: {},
      });
      const driver = { by: 'tester', by_source: 'ambient', channel: 'agent' } as const;
      await executeStep(store, gateThenAuto, {
        runId: run.id,
        command: 'confirm',
        input: {},
        dispatcher: echo,
        driver,
      });
      const gate = (await store.get(run.id)).pending_gate!;
      await submitHumanResponse(store, gateThenAuto, {
        runId: run.id,
        gateId: gate.gate_id,
        choice: 'approve',
      });
      const d = describeRunDriver(await store.get(run.id), gateThenAuto);
      expect(d.driver).toEqual(driver);
      expect(d.step).toBe('confirm');
      expect(d.newer_without_driver).toBe(0);
    });
  });
});

describe('#625 PR-2a — L8 witnesses (source text)', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
  it('the next-auto pick exists in one function', () => {
    const el = read('core/src/engine/execution-loop.ts');
    expect(el.match(/function pickNextEngineStep\(/g)).toHaveLength(1);
    expect(el.match(/pickNextEngineStep\(/g)).toHaveLength(2); // the declaration and its one call
  });
  // Comments stripped, whitespace collapsed: the witnesses read code, never prose.
  const code = (rel: string) =>
    read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/\s+/g, ' ');
  it('run-agent.ts names no auto step in its pick', () => {
    const ra = code('cli/src/agent/run-agent.ts');
    // decision C82: the pick is the view's offered agent steps — a refused one is never picked.
    expect(ra).toContain(
      'describePending(definition, currentRun, deps.registry, new Date()).agent_steps',
    );
    expect(ra).not.toContain("execution === 'auto'");
    expect(ra).not.toContain('executeStep(');
  });
  it('no disposition sentence in run-agent.ts appears twice', () => {
    const ra = code('cli/src/agent/run-agent.ts');
    for (const sentence of [
      'is not registered in this runner.',
      'The run is NOT failed',
      "failed: ${result.errors.join(', ')}${repairSuffix}",
      'CHOKEPOINT (4)',
      "error_class: 'validation_rejected'",
    ]) {
      expect(read('cli/src/agent/run-agent.ts').split(sentence).length - 1, sentence).toBe(1);
    }
    expect(ra.split("result.error_code === 'ENGINE_HANDLER_NOT_REGISTERED' ||").length - 1).toBe(1);
  });
  it('the literal advance_owed appears in core only (code, comments stripped)', async () => {
    const { readdirSync } = await import('node:fs');
    const hits: string[] = [];
    const walk = (rel: string): void => {
      for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name !== 'node_modules' && e.name !== 'dist') walk(child);
        } else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
          if (code(child).includes("'advance_owed'")) hits.push(child);
        }
      }
    };
    for (const pkg of ['core/src', 'mcp-server/src', 'cli/src', 'testing/src']) walk(pkg);
    expect(hits).toEqual(['core/src/engine/pending.ts']);
  });
  it('executeStep calls checkPreClaim for its three checks (no inline copy of their predicates)', () => {
    const el = read('core/src/engine/execution-loop.ts');
    expect(el).toContain('const preClaimVerdict = checkPreClaim({');
    expect(el).not.toContain('classifyStepTrust(');
    expect(el).not.toContain('checkPreconditions(');
    expect(el).not.toContain('validateInputSchema(');
  });
});

describe('#625 PR-2a — round 5: one cell per reply site (C39), the C24 rebuild (C40), basis (C41), the extra property (C42)', () => {
  const capDef = def({
    act: { description: 'Act', execution: 'auto', depends_on: [], handler: 'note' },
    w: { description: 'W', execution: 'agent', depends_on: [] },
    b: {
      description: 'B',
      execution: 'agent',
      depends_on: [],
      trust: 'human_confirmed',
      gate: { choices: ['approve', 'reject'] },
    },
  });
  const hasNote = (): ExtensionRegistry => {
    const r = new ExtensionRegistry();
    r.register('handler', 'note', { id: 'note', execute: async () => ({ data: {} }) } as never);
    return r;
  };
  /** The same store with `settleStep` hidden — the legacy two-write shape. */
  const withoutSettle = (json: JsonFileStore): RunStore =>
    new Proxy(json, {
      get(target, prop, receiver) {
        if (prop === 'settleStep') return undefined;
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as unknown as RunStore;
  /** A run whose `act` a runner that lacked `note` attempted: the marker is on the record. */
  async function markedRun(store: RunStore): Promise<string> {
    const { run } = await store.create({ workflowId: capDef.id, workflowVersion: 1, params: {} });
    await advanceRun(store, capDef, { runId: run.id, registry: new ExtensionRegistry() });
    expect((await store.get(run.id)).capability_blocks?.['act']).toBeDefined();
    return run.id;
  }
  const stepReply = async (store: RunStore) => {
    const runId = await markedRun(store);
    return executeStep(store, capDef, {
      runId,
      command: 'w',
      input: {},
      dispatcher: echo,
      registry: hasNote(),
    });
  };
  const answerReply = async (store: RunStore) => {
    const runId = await markedRun(store);
    await executeStep(store, capDef, {
      runId,
      command: 'b',
      input: {},
      dispatcher: echo,
      registry: hasNote(),
    });
    const gate = (await store.get(runId)).pending_gate!;
    return submitHumanResponse(store, capDef, {
      runId,
      gateId: gate.gate_id,
      choice: 'approve',
      registry: hasNote(),
    });
  };

  it("C39 site S1: a step's reply on a store with settleStep judges with the CALL's registry (the old marker loses)", async () => {
    await withStore(async (store) => {
      const reply = await stepReply(store);
      expect(reply.status).toBe('ok');
      expect(reply.context_hint).toBe(
        "Step 'w' completed. Ready for the agent: 'b'. Owed to the engine: 'act' — call advance_run.",
      );
      expect(reply.next_actions.map((a) => a.instruction?.tool)).toEqual([
        'execute_step',
        'advance_run',
      ]);
    });
  });

  it("C39 site S2: a step's reply on a store without settleStep judges with the CALL's registry", async () => {
    await withStore(async (json) => {
      const reply = await stepReply(withoutSettle(json));
      expect(reply.status).toBe('ok');
      expect(reply.context_hint).toBe(
        "Step 'w' completed. Ready for the agent: 'b'. Owed to the engine: 'act' — call advance_run.",
      );
      expect(reply.next_actions.map((a) => a.instruction?.tool)).toEqual([
        'execute_step',
        'advance_run',
      ]);
    });
  });

  it("C39 site S4: an answer's reply on a store without settleStep judges with the CALL's registry", async () => {
    await withStore(async (json) => {
      const reply = await answerReply(withoutSettle(json));
      expect(reply.status).toBe('ok');
      expect(reply.context_hint).toBe(
        "Gate 'b' resolved with choice 'approve'. Ready for the agent: 'w'. Owed to the engine: 'act' — call advance_run.",
      );
      expect(reply.next_actions.map((a) => a.instruction?.tool)).toEqual([
        'execute_step',
        'advance_run',
      ]);
    });
  });

  it("C40: a step that FAILS beside an unmarked step the call's registry cannot run — advanceRun's reply offers no advance_run act", async () => {
    const d = def({
      x: { description: 'X', execution: 'auto', depends_on: [], handler: 'boom' },
      y: { description: 'Y', execution: 'auto', depends_on: [], handler: 'missing_h' },
    });
    const registry = new ExtensionRegistry();
    registry.register('handler', 'boom', {
      id: 'boom',
      execute: async () => {
        throw new Error('handler blew up');
      },
    } as never);
    await withStore(async (store) => {
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const reply = await advanceRun(store, d, { runId: run.id, registry });
      expect(reply.status).toBe('error');
      const after = await store.get(run.id);
      // y is still eligible and unmarked: only the call's registry says it cannot run here.
      expect(after.terminal_state).toBe(false);
      expect(after.capability_blocks?.['y']).toBeUndefined();
      expect(reply.next_actions.some((a) => a.instruction?.tool === 'advance_run')).toBe(false);
    });
  });

  it('C41: a capability refusal says what it was judged from — registry (here, present tense) or marker (past tense)', () => {
    const d = def({ x: { description: 'X', execution: 'auto', depends_on: [], handler: 'h' } });
    const live = {
      id: 'r',
      params: {},
      completed_steps: [],
      in_progress_steps: [],
      failed_steps: [],
      skipped_steps: [],
      evidence: [],
      terminal_state: false,
    } as unknown as RunRecord;
    const marked = {
      ...live,
      capability_blocks: {
        x: {
          requirement: { kind: 'handler', name: 'h' },
          code: 'ENGINE_HANDLER_NOT_REGISTERED',
          at: '2026-10-05T00:00:00.000Z',
        },
      },
    } as unknown as RunRecord;
    const byRegistry = describePending(d, live, new ExtensionRegistry(), new Date())
      .engine_runnable[0]!;
    expect(byRegistry).toEqual({
      step: 'x',
      runnable_here: false,
      refused_by: 'capability',
      refusal: "handler 'h' is not registered here",
      basis: 'registry',
    });
    const byMarker = describePending(d, marked, undefined, new Date()).engine_runnable[0]!;
    expect(byMarker).toEqual({
      step: 'x',
      runnable_here: false,
      refused_by: 'capability',
      refusal: "handler 'h' was not registered in the runner that last attempted it",
      basis: 'marker',
    });
    expect(CAPABILITY_BASES).toEqual(['registry', 'marker']);
    expect(cannotRunWords(byRegistry)).toBe('cannot run here (capability)');
    expect(cannotRunWords(byMarker)).toBe('could not run (capability)');
    expect(describeNext(describePending(d, live, new ExtensionRegistry(), new Date()), live)).toBe(
      " 'x' cannot run here (capability): handler 'h' is not registered here — load the missing extension, or run the step on a runner that has it.",
    );
    expect(describeNext(describePending(d, marked, undefined, new Date()), marked)).toBe(
      " 'x' could not run (capability): handler 'h' was not registered in the runner that last attempted it.",
    );
    // No basis on a refusal that is not capability's, nor on a runnable entry.
    const trust = def({
      x: { description: 'X', execution: 'auto', depends_on: [], trust: 'nope' as never },
    });
    expect(
      describePending(trust, live, undefined, new Date()).engine_runnable[0],
    ).not.toHaveProperty('basis');
    expect(describePending(d, live, hasNote2(), new Date()).engine_runnable[0]).toEqual({
      step: 'x',
      runnable_here: true,
    });
  });

  it("C42: a property the schema does not allow is named ('<p>' is not allowed), at the top and on a nested path; executeStep's message is unchanged", async () => {
    const live = (params: Record<string, unknown>) =>
      ({
        id: 'r',
        params,
        completed_steps: [],
        in_progress_steps: [],
        failed_steps: [],
        skipped_steps: [],
        evidence: [],
        terminal_state: false,
      }) as unknown as RunRecord;
    const top = def({
      x: {
        description: 'X',
        execution: 'auto',
        depends_on: [],
        input_schema: {
          type: 'object',
          properties: { n: { type: 'number' } },
          additionalProperties: false,
        },
      },
    });
    expect(
      describePending(top, live({ n: 1, extra: true }), undefined, new Date()).engine_runnable[0]
        ?.refusal,
    ).toBe("Invalid input for step 'x': 'extra' is not allowed");
    const nested = def({
      x: {
        description: 'X',
        execution: 'auto',
        depends_on: [],
        input_schema: {
          type: 'object',
          properties: {
            n: {
              type: 'object',
              properties: { m: { type: 'number' } },
              additionalProperties: false,
            },
          },
        },
      },
    });
    expect(
      describePending(nested, live({ n: { m: 1, stray: 2 } }), undefined, new Date())
        .engine_runnable[0]?.refusal,
    ).toBe("Invalid input for step 'x': 'n.stray' is not allowed");
    // executeStep's own reply for the same refusal: the engine's message, byte-identical.
    await withStore(async (store) => {
      const { run } = await store.create({
        workflowId: top.id,
        workflowVersion: 1,
        params: { n: 1, extra: true },
      });
      const reply = await executeStep(store, top, {
        runId: run.id,
        command: 'x',
        input: { n: 1, extra: true },
        dispatcher: echo,
      });
      expect(reply.error_code).toBe('VALIDATION_INPUT_SCHEMA');
      expect(reply.errors).toEqual(["Invalid input for step 'x'"]);
    });
  });
});

function hasNote2(): ExtensionRegistry {
  const r = new ExtensionRegistry();
  r.register('handler', 'h', { id: 'h', execute: async () => ({ data: {} }) } as never);
  return r;
}

describe("#625 PR-2a — round 6: the view's trust voice (C49), the tools' way out (C51), the capability way out (C53)", () => {
  const FINDING_VOICE =
    "'trust: \"nope\"' is not a recognized value — the engine will refuse this step at dispatch (VALIDATION_TRUST_VALUE). Accepts auto, human_confirmed, human_reviewed — correct the value and 'realm workflow register <path>'.";
  const DISPATCH_VOICE =
    "Step 'work': 'trust: \"nope\"' is not a recognized value — refused at dispatch: no gate opens and this step does not run; this run is now parked, non-terminal, until the value is corrected, and any step depending on this one returns 'blocked' in the meantime. A step's 'trust' accepts auto, human_confirmed, human_reviewed. Correct the value, then 'realm workflow register <path>' and retry this step — this run picks up the corrected definition.";
  const TOOLS_WAY_OUT =
    'Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.';

  it("C49: the view's trust refusal is #508's read-time voice; executeStep's reply keeps the dispatch voice, byte for byte", async () => {
    const d = def({
      work: { description: 'w', execution: 'auto', depends_on: [], trust: 'nope' as never },
      ask: { description: 'Ask', execution: 'agent', depends_on: [] },
    });
    await withStore(async (store) => {
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      // The view: the read-time voice — nothing was dispatched, and the agent step beside it runs.
      const entry = describePending(d, run, undefined, new Date()).engine_runnable[0]!;
      expect(entry).toEqual({
        step: 'work',
        runnable_here: false,
        refused_by: 'trust',
        refusal: FINDING_VOICE,
      });
      expect(entry.refusal).not.toContain('parked');
      expect(describeNext(describePending(d, run, undefined, new Date()), run)).toBe(
        ` Ready for the agent: 'ask'. 'work' cannot run (trust): ${FINDING_VOICE}`,
      );
      // checkPreClaim carries both: the view's words, and the error executeStep returns.
      const verdict = checkPreClaim({ definition: d, run, step: 'work', input: {} });
      expect(verdict && 'refused_by' in verdict ? verdict.refusal : undefined).toBe(FINDING_VOICE);
      expect(verdict && 'refused_by' in verdict ? verdict.error?.message : undefined).toBe(
        DISPATCH_VOICE,
      );
      // executeStep's reply: the dispatch voice, as on d2f0b3cf (errors and context_hint).
      const reply = await executeStep(store, d, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: echo,
      });
      expect(reply.status).toBe('error');
      expect(reply.error_code).toBe('VALIDATION_TRUST_VALUE');
      expect(reply.errors).toEqual([DISPATCH_VOICE]);
      expect(reply.context_hint).toBe("Error during 'work'. Run phase: 'running'.");
      // decision C94: what the caller can call instead — the view's, never the refused step.
      expect(reply.agent_action).toBe('resolve_precondition');
      expect(reply.next_actions.map((a) => a.instruction?.params['command'])).toEqual(['ask']);
      expect(reply.blocked_reason?.eligible_steps).toEqual(['ask']);
    });
  });

  it("C51: advance_run's nothing-ran reply ends with the tools' way out only when nothing else is ready and a step is refused before its claim", async () => {
    expect(cannotRunWayOutTools()).toBe(TOOLS_WAY_OUT);
    // Present: covered member by member by the three L5 cells (trust, precondition, input schema).
    // Absent when an agent step is ready beside the refused step.
    const withAgent = def({
      x: {
        description: 'X',
        execution: 'auto',
        depends_on: [],
        input_schema: { type: 'object', required: ['needed'] },
      },
      ask: { description: 'Ask', execution: 'agent', depends_on: [] },
    });
    await withStore(async (store) => {
      const { run } = await store.create({
        workflowId: withAgent.id,
        workflowVersion: 1,
        params: {},
      });
      const reply = await advanceRun(store, withAgent, { runId: run.id });
      expect(reply.context_hint).toBe(
        `Run '${run.id}': nothing ran. Ready for the agent: 'ask'. 'x' cannot run (input_schema): Invalid input for step 'x': the input must have required property 'needed'.`,
      );
      expect(
        cannotRunWayOutApplies(run, describePending(withAgent, run, undefined, new Date())),
      ).toBe(false);
    });
    // Absent for capability: another runner can run the step.
    const cap = def({ x: { description: 'X', execution: 'auto', depends_on: [], handler: 'h' } });
    await withStore(async (store) => {
      const { run } = await store.create({ workflowId: cap.id, workflowVersion: 1, params: {} });
      const lacking = new ExtensionRegistry();
      const first = await advanceRun(store, cap, { runId: run.id, registry: lacking });
      expect(first.error_code).toBe('ENGINE_HANDLER_NOT_REGISTERED');
      const second = await advanceRun(store, cap, { runId: run.id, registry: lacking });
      expect(second.context_hint).toBe(
        `Run '${run.id}': nothing ran. 'x' cannot run here (capability): handler 'h' is not registered here — load the missing extension, or run the step on a runner that has it.`,
      );
      expect(second.context_hint).not.toContain(TOOLS_WAY_OUT);
    });
    // Absent while a step is in flight elsewhere (the CLI's condition, shared).
    const refused = def({
      x: { description: 'X', execution: 'auto', depends_on: [], trust: 'nope' as never },
    });
    const live = {
      id: 'r',
      params: {},
      completed_steps: [],
      in_progress_steps: [],
      failed_steps: [],
      skipped_steps: [],
      evidence: [],
      terminal_state: false,
    } as unknown as RunRecord;
    expect(
      cannotRunWayOutApplies(live, describePending(refused, live, undefined, new Date())),
    ).toBe(true);
    const inFlight = { ...live, in_progress_steps: ['other'] } as unknown as RunRecord;
    expect(
      cannotRunWayOutApplies(inFlight, describePending(refused, inFlight, undefined, new Date())),
    ).toBe(false);
  });

  it("C53: a capability refusal judged from the caller's registry ends with its way out; one judged from the marker does not", () => {
    expect(
      cannotRunClause({
        step: 'x',
        runnable_here: false,
        refused_by: 'capability',
        refusal: "handler 'h' is not registered here",
        basis: 'registry',
      }),
    ).toBe(
      "'x' cannot run here (capability): handler 'h' is not registered here — load the missing extension, or run the step on a runner that has it",
    );
    expect(
      cannotRunClause({
        step: 'x',
        runnable_here: false,
        refused_by: 'capability',
        refusal: "handler 'h' was not registered in the runner that last attempted it",
        basis: 'marker',
      }),
    ).toBe(
      "'x' could not run (capability): handler 'h' was not registered in the runner that last attempted it",
    );
  });

  it('the eligibility path of D3.2: a step another process claimed before executeStep read the record is said as taken — never "not eligible"', async () => {
    const d = def({
      x: { description: 'X', execution: 'auto', depends_on: [] },
      y: { description: 'Y', execution: 'auto', depends_on: [] },
    });
    await withStore(async (store) => {
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const realGet = store.get.bind(store);
      let armed = false;
      store.get = async (id: string) => {
        if (armed) {
          armed = false;
          await store.claimStep(id, 'x', d, {
            by: 'other@host',
            by_source: 'derived',
            channel: 'agent',
          });
        }
        return realGet(id);
      };
      const steps: string[] = [];
      const taken: string[] = [];
      const reply = await advanceRun(store, d, {
        runId: run.id,
        onStep: (s) => {
          steps.push(s);
          if (s === 'x') armed = true;
        },
        onTaken: (s) => taken.push(s),
      });
      expect(steps).toEqual(['x', 'y']);
      expect(taken).toEqual(['x']);
      expect(reply.status).toBe('ok');
      expect(reply.chained_auto_steps?.map((c) => c.step)).toEqual(['y']);
      expect(reply.context_hint).not.toContain('not eligible');
      expect(
        reply.context_hint.endsWith(" 'x' was claimed by another process, so it did not run here."),
      ).toBe(true);
      const after = await store.get(run.id);
      expect(after.in_progress_steps).toEqual(['x']);
      expect(after.completed_steps).toEqual(['y']);
    });
  });
});

describe('#625 PR-2a — round 7: the way out at every site that says what comes next (C57), the two forms (C60)', () => {
  /** The same store with `settleStep` hidden — the legacy two-write shape. */
  const withoutSettle = (json: JsonFileStore): RunStore =>
    new Proxy(json, {
      get(target, prop, receiver) {
        if (prop === 'settleStep') return undefined;
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as unknown as RunStore;
  const needsN = { type: 'object', required: ['n'], properties: { n: { type: 'number' } } };
  const REFUSAL =
    "'compute' cannot run (input_schema): Invalid input for step 'compute': the input must have required property 'n'.";
  /** After `ask`, only `compute` is owed, and it is refused before its claim. */
  const afterStep = def({
    ask: { description: 'Ask', execution: 'agent', depends_on: [] },
    compute: { description: 'C', execution: 'auto', depends_on: ['ask'], input_schema: needsN },
  });
  /** The control: after `ask`, an agent step is ready beside the refused one. */
  const afterStepWithAgent = def({
    ask: { description: 'Ask', execution: 'agent', depends_on: [] },
    ask2: { description: 'Ask 2', execution: 'agent', depends_on: ['ask'] },
    compute: { description: 'C', execution: 'auto', depends_on: ['ask'], input_schema: needsN },
  });
  /** After the answer, only `compute` is owed, and it is refused before its claim. */
  const afterAnswer = def({
    b: {
      description: 'B',
      execution: 'agent',
      depends_on: [],
      trust: 'human_confirmed',
      gate: { choices: ['approve', 'reject'] },
    },
    compute: { description: 'C', execution: 'auto', depends_on: ['b'], input_schema: needsN },
  });
  const afterAnswerWithAgent = def({
    b: {
      description: 'B',
      execution: 'agent',
      depends_on: [],
      trust: 'human_confirmed',
      gate: { choices: ['approve', 'reject'] },
    },
    w: { description: 'W', execution: 'agent', depends_on: ['b'] },
    compute: { description: 'C', execution: 'auto', depends_on: ['b'], input_schema: needsN },
  });
  const stepReply = async (store: RunStore, d: WorkflowDefinition) => {
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    return executeStep(store, d, { runId: run.id, command: 'ask', input: {}, dispatcher: echo });
  };
  const answerReply = async (store: RunStore, d: WorkflowDefinition) => {
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    await executeStep(store, d, { runId: run.id, command: 'b', input: {}, dispatcher: echo });
    const gate = (await store.get(run.id)).pending_gate!;
    return submitHumanResponse(store, d, {
      runId: run.id,
      gateId: gate.gate_id,
      choice: 'approve',
    });
  };

  it("C57 site S1: a step's reply on a store with settleStep ends with the way out when only a refused engine step remains; not when an agent step is ready", async () => {
    await withStore(async (store) => {
      const reply = await stepReply(store, afterStep);
      expect(reply.status).toBe('ok');
      expect(reply.next_actions).toEqual([]);
      expect(reply.context_hint).toBe(`Step 'ask' completed. ${REFUSAL} ${TOOLS_WAY_OUT_TEXT}`);
      const control = await stepReply(store, afterStepWithAgent);
      expect(control.context_hint).toBe(
        `Step 'ask' completed. Ready for the agent: 'ask2'. ${REFUSAL}`,
      );
    });
  });

  it("C57 site S2: a step's reply on a store without settleStep ends with the way out; not when an agent step is ready", async () => {
    await withStore(async (json) => {
      const store = withoutSettle(json);
      const reply = await stepReply(store, afterStep);
      expect(reply.status).toBe('ok');
      expect(reply.next_actions).toEqual([]);
      expect(reply.context_hint).toBe(`Step 'ask' completed. ${REFUSAL} ${TOOLS_WAY_OUT_TEXT}`);
      const control = await stepReply(store, afterStepWithAgent);
      expect(control.context_hint).toBe(
        `Step 'ask' completed. Ready for the agent: 'ask2'. ${REFUSAL}`,
      );
    });
  });

  it("C57 site S3: an answer's reply on a store with settleStep ends with the way out; not when an agent step is ready", async () => {
    await withStore(async (store) => {
      const reply = await answerReply(store, afterAnswer);
      expect(reply.status).toBe('ok');
      expect(reply.next_actions).toEqual([]);
      expect(reply.context_hint).toBe(
        `Gate 'b' resolved with choice 'approve'. ${REFUSAL} ${TOOLS_WAY_OUT_TEXT}`,
      );
      const control = await answerReply(store, afterAnswerWithAgent);
      expect(control.context_hint).toBe(
        `Gate 'b' resolved with choice 'approve'. Ready for the agent: 'w'. ${REFUSAL}`,
      );
    });
  });

  it("C57 site S4: an answer's reply on a store without settleStep ends with the way out; not when an agent step is ready", async () => {
    await withStore(async (json) => {
      const store = withoutSettle(json);
      const reply = await answerReply(store, afterAnswer);
      expect(reply.status).toBe('ok');
      expect(reply.next_actions).toEqual([]);
      expect(reply.context_hint).toBe(
        `Gate 'b' resolved with choice 'approve'. ${REFUSAL} ${TOOLS_WAY_OUT_TEXT}`,
      );
      const control = await answerReply(store, afterAnswerWithAgent);
      expect(control.context_hint).toBe(
        `Gate 'b' resolved with choice 'approve'. Ready for the agent: 'w'. ${REFUSAL}`,
      );
    });
  });

  it('C57 the nothing-ran reply: composed through describeNext, it ends with the way out once; not when an agent step is ready', async () => {
    const only = def({
      compute: { description: 'C', execution: 'auto', depends_on: [], input_schema: needsN },
    });
    const withAgent = def({
      compute: { description: 'C', execution: 'auto', depends_on: [], input_schema: needsN },
      ask: { description: 'Ask', execution: 'agent', depends_on: [] },
    });
    await withStore(async (store) => {
      const { run } = await store.create({ workflowId: only.id, workflowVersion: 1, params: {} });
      const reply = await advanceRun(store, only, { runId: run.id });
      expect(reply.context_hint).toBe(
        `Run '${run.id}': nothing ran. ${REFUSAL} ${TOOLS_WAY_OUT_TEXT}`,
      );
      // Once: the way out is said by describeNext alone, never appended a second time.
      expect(reply.context_hint.split(TOOLS_WAY_OUT_TEXT)).toHaveLength(2);
      const control = await store.create({
        workflowId: withAgent.id,
        workflowVersion: 1,
        params: {},
      });
      const controlReply = await advanceRun(store, withAgent, { runId: control.run.id });
      expect(controlReply.context_hint).toBe(
        `Run '${control.run.id}': nothing ran. Ready for the agent: 'ask'. ${REFUSAL}`,
      );
    });
  });

  it('C57 describeNext itself: the way out follows the refusal only under cannotRunWayOutApplies (in flight, a question open, a terminal run: none)', () => {
    const only = def({
      compute: { description: 'C', execution: 'auto', depends_on: [], input_schema: needsN },
    });
    const pending = describePending(only, OPEN_RUN, undefined, new Date());
    expect(describeNext(pending, OPEN_RUN)).toBe(` ${REFUSAL} ${TOOLS_WAY_OUT_TEXT}`);
    const inFlight = { ...OPEN_RUN, in_progress_steps: ['other'] } as unknown as RunRecord;
    expect(describeNext(pending, inFlight)).toBe(` ${REFUSAL}`);
    const gated = {
      ...OPEN_RUN,
      pending_gate: { gate_id: 'g', step_name: 'b' },
    } as unknown as RunRecord;
    expect(describeNext(pending, gated)).toBe(` ${REFUSAL}`);
    const ended = { ...OPEN_RUN, terminal_state: true } as unknown as RunRecord;
    expect(describeNext(pending, ended)).toBe(` ${REFUSAL}`);
  });

  it('C60: cannotRunWayOut, the CLI form, is pinned whole in core', async () => {
    await withStore(async (store) => {
      const { run } = await store.create({
        workflowId: 'pending-wf',
        workflowVersion: 1,
        params: {},
      });
      expect(cannotRunWayOut(run)).toBe(
        `Run ${run.id} stays open (phase 'running'): correct the workflow, register it again, then realm run advance ${run.id} — or end it: realm run abandon ${run.id}`,
      );
    });
  });

  it('C60: cannotRunWayOutTools, the tools form, is pinned whole in core', () => {
    expect(cannotRunWayOutTools()).toBe(
      'Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.',
    );
  });
});

describe('#625 PR-2a, round 29 — C206, C207, C208: the one choice form, where one advance call stops, the cleanup steps’ outcomes', () => {
  it('C206 (walk c13 RED-1): oneOf and respondCommand — the value itself for one, `<one of: a, b>` for several, never `a|b`', () => {
    // (a) red when one value is wrapped, several are joined with `|`, or the command differs; (b)
    //     prints them.
    expect({
      one: oneOf(['ack']),
      two: oneOf(['ship', 'hold']),
      cmdTwo: respondCommand('r', 'g', ['ship', 'hold']),
      cmdOne: respondCommand('r', 'g', ['ack']),
    }).toEqual({
      one: 'ack',
      two: '<one of: ship, hold>',
      cmdTwo: 'realm run respond r --gate g --choice <one of: ship, hold>',
      cmdOne: 'realm run respond r --gate g --choice ack',
    });
  });

  it('C207 (walk c13 YELLOW-3): one advanceRun runs the owed steps one at a time, and the steps the run owes after them, and stops at the first step that opens a question or fails — the rule the `until` words state', async () => {
    const auto = (extra: Partial<StepDefinition> = {}): StepDefinition =>
      ({ description: 'd', execution: 'auto', depends_on: [], ...extra }) as StepDefinition;
    const registry = new ExtensionRegistry();
    registry.register('handler', 'boom', {
      id: 'boom',
      execute: async () => {
        throw new Error('it broke');
      },
    });
    const cases = {
      question: def({
        approve: auto({ trust: 'human_confirmed', gate: { choices: ['ship', 'hold'] } }),
        fetch: auto(),
      }),
      fails: def({ a: auto({ handler: 'boom' }), b: auto() }),
      plain: def({ a: auto(), b: auto(), c: auto({ depends_on: ['a'] }) }),
    };
    const seen: Record<string, unknown> = {};
    for (const [name, d] of Object.entries(cases)) {
      await withStore(async (store) => {
        const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
        const view = describePending(d, run, registry, new Date());
        const steps: string[] = [];
        const reply = await advanceRun(store, d, {
          runId: run.id,
          registry,
          onStep: (s) => steps.push(s),
        });
        const after = await store.get(run.id);
        seen[name] = {
          owed: view.act?.human_readable,
          ran: steps,
          status: reply.status,
          completed: after.completed_steps,
        };
      });
    }
    // (a) red when the call runs a step named after one that opened a question or failed, stops
    //     before the steps the run owes after the named ones, or the owed words promise that all
    //     run; (b) prints them.
    expect(seen).toEqual({
      question: {
        owed: "Call advance_run to run the steps the engine owes: 'approve', 'fetch'. It runs them with this server's extensions and environment until a step opens a question, fails or ends the run.",
        ran: ['approve'],
        status: 'confirm_required',
        completed: [],
      },
      fails: {
        owed: "Call advance_run to run the steps the engine owes: 'a', 'b'. It runs them with this server's extensions and environment until a step opens a question, fails or ends the run.",
        ran: ['a'],
        status: 'error',
        completed: [],
      },
      plain: {
        owed: "Call advance_run to run the steps the engine owes: 'a', 'b'. It runs them with this server's extensions and environment until a step opens a question, fails or ends the run.",
        ran: ['a', 'b', 'c'],
        status: 'ok',
        completed: ['a', 'b', 'c'],
      },
    });
  });

  it('C208 (walk c13 YELLOW-4): finalizerOutcomeLines — one line per cleanup step, in rank order, with the status the record holds; none for a run with no cleanup step', () => {
    const ledger = {
      tidy: { status: 'completed', rank: 1 },
      note: { status: 'failed', rank: 0 },
    };
    // (a) red when a line is left out, the order is not the rank order, or the words change; (b)
    //     prints them.
    expect({
      two: finalizerOutcomeLines({ finalizer_ledger: ledger } as unknown as RunRecord),
      none: finalizerOutcomeLines({} as RunRecord),
    }).toEqual({ two: ["finalizer 'note': failed", "finalizer 'tidy': completed"], none: [] });
  });

  it('C210 (walk c14 W3-3): finalizerOutcomeLines with the record before the call — only the cleanup steps whose status the call changed', () => {
    const run = (ledger: Record<string, { status: string; rank: number }>) =>
      ({ finalizer_ledger: ledger }) as unknown as RunRecord;
    const before = run({
      done: { status: 'completed', rank: 0 },
      broke: { status: 'failed', rank: 1 },
      rearmed: { status: 'voided', rank: 2 },
      unselected: { status: 'voided', rank: 3 },
    });
    const after = run({
      done: { status: 'completed', rank: 0 },
      broke: { status: 'failed', rank: 1 },
      rearmed: { status: 'completed', rank: 0 },
      unselected: { status: 'voided', rank: 3 },
      minted: { status: 'pending', rank: 1 },
    });
    // (a) red when a cleanup step that did not change is said, or one this call ran or minted is left
    //     out; (b) prints the lines.
    expect({
      changed: finalizerOutcomeLines(after, before),
      noBefore: finalizerOutcomeLines(after, {} as RunRecord),
    }).toEqual({
      changed: ["finalizer 'rearmed': completed", "finalizer 'minted': pending"],
      noBefore: [
        "finalizer 'done': completed",
        "finalizer 'rearmed': completed",
        "finalizer 'broke': failed",
        "finalizer 'minted': pending",
        "finalizer 'unselected': voided",
      ],
    });
  });
});

describe('#625 PR-2a, round 30 — C211, C212: the composers', () => {
  const asRun = (fields: Partial<RunRecord>) =>
    ({
      id: 'r1',
      terminal_state: false,
      completed_steps: [],
      in_progress_steps: [],
      failed_steps: [],
      skipped_steps: [],
      evidence: [],
      params: {},
      ...fields,
    }) as unknown as RunRecord;
  const def = {
    id: 'w',
    name: 'w',
    version: 1,
    steps: {
      g0: { description: 'g0', execution: 'auto', depends_on: [] },
      q: { description: 'q', execution: 'auto', depends_on: ['g0'] },
      z: { description: 'z', execution: 'agent', depends_on: ['g0'] },
      y: { description: 'y', execution: 'auto', depends_on: ['g0'] },
      later: { description: 'later', execution: 'auto', depends_on: ['q'] },
    },
  } as unknown as WorkflowDefinition;
  const gate = {
    gate_id: 'gq',
    step_name: 'q',
    choices: ['yes', 'no'],
    opened_at: '',
    preview: {},
  };

  it('C211 (walk c14 W2-2): waitingOnAnswer — the steps ready but for the open question, its own step and the steps after it left out; none without a question or on an ended run', () => {
    const open = asRun({
      completed_steps: ['g0'],
      in_progress_steps: ['q'],
      pending_gate: gate,
    } as never);
    const view = describePending(def, open, undefined, new Date());
    // (a) red when a held step is left out, the question's own step or a step after it is named, or
    //     a run with no question names any; (b) prints them.
    expect({
      waiting: waitingOnAnswer(def, open),
      view: view.waiting_on_answer,
      words: waitingWords(view),
      one: waitingWords({ waiting_on_answer: ['z'] } as PendingView),
      none: waitingOnAnswer(def, asRun({ completed_steps: ['g0'] })),
      ended: waitingOnAnswer(def, { ...open, terminal_state: true }),
      noWords: waitingWords({} as PendingView),
    }).toEqual({
      waiting: ['z', 'y'],
      view: ['z', 'y'],
      words: "'z', 'y' wait for its answer",
      one: "'z' waits for its answer",
      none: [],
      ended: [],
      noWords: undefined,
    });
  });

  it('C211 (walk c14 W3-4): pendingCleanupWay and its two forms — the pending entries in rank order; none on a run that has not ended', () => {
    const ledger = {
      note: { status: 'pending', rank: 1 },
      tidy: { status: 'pending', rank: 0 },
      done: { status: 'completed', rank: 2 },
    };
    const ended = asRun({ terminal_state: true, finalizer_ledger: ledger } as never);
    const one = asRun({
      terminal_state: true,
      finalizer_ledger: { tidy: { status: 'pending', rank: 0 } },
    } as never);
    // (a) red when a completed entry is named, the order is not the rank order, or a live run gets a
    //     line; (b) prints them.
    expect({
      way: pendingCleanupWay(ended),
      line: pendingCleanupLine(ended),
      oneLine: pendingCleanupLine(one),
      sentence: pendingCleanupSentence(one),
      live: [
        pendingCleanupWay({ ...ended, terminal_state: false }),
        pendingCleanupSentence({ ...ended, terminal_state: false }),
      ],
    }).toEqual({
      way: { steps: ['tidy', 'note'], command: 'realm run drain r1 --force' },
      line: "Cleanup steps left pending: 'tidy', 'note' — to run them with code that has their handlers: realm run drain r1 --force",
      oneLine:
        "Cleanup step left pending: 'tidy' — to run it with code that has its handler: realm run drain r1 --force",
      sentence:
        " Cleanup step left pending: 'tidy' — 'realm run drain r1 --force' runs it with code that has its handler.",
      live: [undefined, ''],
    });
  });

  it('C211 (walk c14 W2-1): an expired question — owedRunsClause and owedCallWords say the call then runs what a declared default leaves owed; nothing for an abort', () => {
    const view = (on_expiry: 'settle_default' | 'abort') =>
      ({ expiry_due: { step: 'g', gate_id: 'x', on_expiry } }) as unknown as PendingView;
    const several = {
      pending_guards: [],
      engine_runnable: [
        { step: 'a', runnable_here: true },
        { step: 'b', runnable_here: true },
      ],
    } as unknown as PendingView;
    // (a) red when a default's call is said to stop at the expiry, an abort is said to run more, or
    //     several owed lose their stop words; (b) prints them.
    expect({
      clause: [owedRunsClause(view('settle_default')), owedRunsClause(view('abort'))],
      call: [
        owedCallWords(view('settle_default')),
        owedCallWords(view('abort')),
        owedCallWords(several),
      ],
    }).toEqual({
      clause: [
        '; then it runs what that leaves owed until a step opens a question, fails or ends the run',
        '',
      ],
      call: [
        ' carries it out, then runs what that leaves owed until a step opens a question, fails or ends the run',
        '',
        ' runs them until a step opens a question, fails or ends the run',
      ],
    });
  });

  it('C212 (walk c14 W1-1): the one rule — a sentence that ends with a command gets no full stop; a command followed by words, or none, does', () => {
    // (a) red when a command ending a sentence gets a full stop, or prose ending in words loses one;
    //     (b) prints them.
    expect(
      [
        'a question is open — realm run respond r1 --gate g --choice ok',
        'a question is open — realm run respond r1 --gate g --choice <one of: ship, hold>',
        "an agent step is ready: 'w' — drive it with realm agent --run-id r1 --provider <provider> --model <model>",
        "'p' is in flight in another program — wait for it, or see realm run inspect r1",
        "the run has ended (failed) — to make 's' runnable again: realm run resume r1 --from s",
        'To run them: realm run drain r1 --force',
        'realm run advance r1 runs them until a step opens a question, fails or ends the run',
        'If a realm workflow run or realm agent is still waiting on this run, it goes on by itself',
        'the run has ended (completed)',
        'nothing is ready to run now.',
      ].map((t) => [
        endsWithCommand(t),
        sentenceEnd(t) === t ? 'as printed' : sentenceEnd(t) === `${t}.` ? 'full stop' : 'other',
      ]),
    ).toEqual([
      [true, 'as printed'],
      [true, 'as printed'],
      [true, 'as printed'],
      [true, 'as printed'],
      [true, 'as printed'],
      [true, 'as printed'],
      [false, 'full stop'],
      [false, 'full stop'],
      [false, 'full stop'],
      [false, 'as printed'],
    ]);
  });
});
