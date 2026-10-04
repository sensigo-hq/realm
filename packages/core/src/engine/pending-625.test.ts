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
} from './execution-loop.js';
import {
  ADVANCE_OWED,
  PRE_CLAIM_REFUSALS,
  checkPreClaim,
  composeNextActionsStatusWord,
  describeNext,
  describePending,
  describeRunDriver,
  engineStepInput,
  judgeProgramFit,
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
        "Call advance_run to run the steps the engine owes: 'after'. It runs them with this server's extensions and environment.",
      );
      expect(act.orientation).toBe("Run is active. Engine work is owed: 'after'.");
      const pending = describePending(gateThenAuto, await store.get(run.id));
      expect(composeNextActionsStatusWord(pending)).toBe(ADVANCE_OWED);
      expect(ADVANCE_OWED).toBe('advance_owed');
    });
  });

  it('describeNext, its four members: agent only, owed only, both, neither', () => {
    const base = { agent_actions: [], agent_steps: [], pending_guards: [], engine_runnable: [] };
    const act = { instruction: null, human_readable: '', orientation: '' };
    expect(describeNext({ ...base })).toBe(' No step is ready.');
    expect(describeNext({ ...base, agent_steps: ['a', 'b'] })).toBe(
      " Ready for the agent: 'a', 'b'.",
    );
    expect(
      describeNext({
        ...base,
        pending_guards: ['g'],
        engine_runnable: [{ step: 'x', runnable_here: true }],
        act,
      }),
    ).toBe(" Owed to the engine: 'g', 'x' — call advance_run.");
    expect(
      describeNext({
        ...base,
        agent_steps: ['a'],
        engine_runnable: [{ step: 'x', runnable_here: 'unknown' }],
        act,
      }),
    ).toBe(" Ready for the agent: 'a'. Owed to the engine: 'x' — call advance_run.");
  });

  it('with an agent step ready AND engine work owed: the agent action first, the act last, status ok', async () => {
    const d = def({
      a: { description: 'A', execution: 'agent', depends_on: [] },
      b: { description: 'B', execution: 'auto', depends_on: [] },
    });
    await withStore(async (store) => {
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const actions = buildNextActions(d, run);
      expect(actions.map((x) => x.instruction?.tool)).toEqual(['execute_step', 'advance_run']);
      expect(composeNextActionsStatusWord(describePending(d, run))).toBeUndefined();
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
    const pending = describePending(d, run);
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
    expect(describePending(d, live).act).toBeDefined();
    expect(describePending(d, { ...live, terminal_state: true }).act).toBeUndefined();
    expect(
      describePending(d, {
        ...live,
        pending_gate: { gate_id: 'g', step_name: 'y', choices: ['a'], opened_at: '', preview: {} },
      } as RunRecord).act,
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
    expect(describePending(d, live()).engine_runnable).toEqual([
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
    expect(describePending(d, live([], {})).engine_runnable[0]).toEqual({
      step: 'x',
      runnable_here: false,
      refused_by: 'input_schema',
      refusal: "Invalid input for step 'x'",
    });
    expect(describePending(d, live([], { alpha: 'a' })).engine_runnable[0]?.runnable_here).toBe(
      true,
    );
  });

  it('capability: unknown with no registry; refused with one that lacks it; runnable with one that has it', () => {
    const d = def({ x: { description: 'X', execution: 'auto', depends_on: [], handler: 'h' } });
    expect(describePending(d, live()).engine_runnable[0]?.runnable_here).toBe('unknown');
    expect(describePending(d, live(), new ExtensionRegistry()).engine_runnable[0]).toEqual({
      step: 'x',
      runnable_here: false,
      refused_by: 'capability',
      refusal: "handler 'h' is not registered here",
    });
    const reg = new ExtensionRegistry();
    reg.register('handler', 'h', { id: 'h', execute: async () => ({ data: {} }) });
    expect(describePending(d, live(), reg).engine_runnable[0]?.runnable_here).toBe(true);
    // A refused step is never named, so with nothing else owed the act is withdrawn.
    expect(describePending(d, live(), new ExtensionRegistry()).act).toBeUndefined();
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
        const view = describePending(d, run).engine_runnable[0]!;
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
        expect(describePending(d, run).engine_runnable[0]!.runnable_here).toBe(true);
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
      expect(describePending(d, run, empty).engine_runnable[0]!.refused_by).toBe('capability');
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
      expect(reply.command).toBe('advance_run');
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
      expect(describePending(d, after).act).toBeUndefined();
      expect(describePending(d, after).engine_runnable).toEqual([
        expect.objectContaining({ step: 'a', runnable_here: false, refused_by: 'precondition' }),
      ]);
    });
  });

  it('capability with a registry: the first call attempts it once (the marker); the second skips it and runs the rest', async () => {
    const d = def({
      a: { description: 'A', execution: 'auto', depends_on: [], handler: 'h' },
      b: { description: 'B', execution: 'auto', depends_on: [] },
    });
    await withStore(async (store) => {
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const reg = new ExtensionRegistry();
      const first = await advanceRun(store, d, { runId: run.id, registry: reg });
      expect(first.error_code).toBe('ENGINE_HANDLER_NOT_REGISTERED');
      expect((await store.get(run.id)).capability_blocks?.['a']).toBeDefined();
      const steps: string[] = [];
      const second = await advanceRun(store, d, {
        runId: run.id,
        registry: reg,
        onStep: (s) => steps.push(s),
      });
      expect(steps).toEqual(['b']);
      expect(second.status).toBe('ok');
      expect(describePending(d, await store.get(run.id), reg).act).toBeUndefined();
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
      expect(describePending(d, afterAnswer).pending_guards).toEqual(['check']);
      expect(describePending(d, afterAnswer).act).toBeDefined();
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
        const before = describePending(d, await store.get(run.id));
        expect(before.act).toBeUndefined();
        expect(before.engine_runnable).toEqual([
          expect.objectContaining({ step: 'x', runnable_here: false, refused_by: member }),
        ]);
        const steps: string[] = [];
        const reply = await advanceRun(store, d, { runId: run.id, onStep: (s) => steps.push(s) });
        expect(steps).toEqual([]);
        expect(reply.status).toBe('ok');
        expect(reply.next_actions).toEqual([]);
        expect(reply.context_hint).toBe(`Run '${run.id}': nothing ran. No step is ready.`);
        expect(describePending(d, await store.get(run.id)).act).toBeUndefined();
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
      // decision C25: the reply ends with one clause per step another process held.
      expect(reply.context_hint).toBe(
        `Run '${run.id}': nothing ran. No step is ready. 'x' was claimed by another process, so it did not run here.`,
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
    expect(ra).toContain(
      "findEligibleSteps(definition, currentRun).filter( (name) => definition.steps[name]?.execution === 'agent', )",
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
