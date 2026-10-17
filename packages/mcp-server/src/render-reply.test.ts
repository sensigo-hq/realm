// render-reply.test.ts — issue #729 PR-0: the MCP door's ONE renderer (`renderReply`, `renderWaysOf`).
// The agent-facing words that core composed before PR-0 (`describeNext`, the act's and the answer's
// instructions, `cannotRunWayOutTools`, `refusalSuggestion`) are this door's now: the cells that
// pinned them in core (`pending-625.test.ts` and its siblings) are kept here, on the same fixtures,
// read through the renderer — the words unchanged unless a §Table row of the prompt says otherwise.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  ExtensionRegistry,
  advanceRun,
  composeWaysAt,
  composeWaysOn,
  writtenSnapshot,
  executeStep,
  submitHumanResponse,
  type EngineReply,
  type RunRecord,
  type RunStore,
  type StepDefinition,
  type StepDispatcher,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { renderReply, renderWaysOf } from './render-reply.js';

const echo: StepDispatcher = async (_name, input) => ({ ...input });

async function withStore<T>(fn: (store: JsonFileStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'realm-render-reply-'));
  try {
    return await fn(new JsonFileStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function def(steps: Record<string, StepDefinition>, extra?: Partial<WorkflowDefinition>) {
  return { id: 'pending-wf', name: 'Pending', version: 1, steps, ...extra } as WorkflowDefinition;
}

/** The envelope an agent reads for an engine reply. */
const out = (reply: EngineReply) => renderReply(reply, {}).envelope;

/** The sentence of what comes next for a record, as the MCP door says it. */
const nextSentenceOf = (
  run: RunRecord,
  definition: WorkflowDefinition,
  registry?: ExtensionRegistry,
): string =>
  renderWaysOf(
    composeWaysAt(run, new Date(), { definition, ...(registry !== undefined ? { registry } : {}) }),
    {},
  ).next_sentence;

/** An open run with nothing in flight and no question open. */
const openRun = (over: Partial<RunRecord> = {}): RunRecord =>
  ({
    id: 'r',
    workflow_id: 'pending-wf',
    params: {},
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    evidence: [],
    terminal_state: false,
    version: 1,
    ...over,
  }) as unknown as RunRecord;

/** The tools' way out, as a literal (decisions C51, C57, C60) — F15: for trust and precondition. */
const TOOLS_WAY_OUT_TEXT =
  'Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.';
/**
 * F15 + T-20 (i): the tools' way out for a step refused for its input — with no `depends_on` (the
 * run's params) — saying that this run stays open, and how to end it.
 */
const inputWayOutParams = (step: string): string =>
  `For '${step}', start a run with params that fit, or correct its input_schema and register the workflow again; this run stays open — after a fix, call advance_run on it; or end it with abandon_run.`;

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

describe('#729 PR-0 — the MCP door words what comes next (formerly core describeNext, C34/C57/C205/C207)', () => {
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
      const answered = out(
        await submitHumanResponse(store, gateThenAuto, {
          runId: run.id,
          gateId: gate.gate_id,
          choice: 'approve',
        }),
      );
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
    });
  });

  it('the next sentence, its four members: agent only, owed only, both, neither', () => {
    const agents = def({
      a: { description: 'A', execution: 'agent', depends_on: [] },
      b: { description: 'B', execution: 'agent', depends_on: [] },
    });
    expect(nextSentenceOf(openRun(), agents)).toBe(" Ready for the agent: 'a', 'b'.");
    const owed = def({
      g: {
        description: 'G',
        execution: 'guard',
        depends_on: ['w'],
        abort_unless: ['w.ok == true'],
      },
      w: { description: 'W', execution: 'agent', depends_on: [] },
      x: { description: 'X', execution: 'auto', depends_on: ['w'] },
    });
    const wDone = openRun({
      completed_steps: ['w'],
      evidence: [{ step_id: 'w', status: 'success', output_summary: { ok: true } }],
    } as unknown as Partial<RunRecord>);
    expect(nextSentenceOf(wDone, owed)).toBe(
      " Owed to the engine: 'g', 'x' — call advance_run; it runs them until a step opens a question, fails or ends the run.",
    );
    const both = def({
      a: { description: 'A', execution: 'agent', depends_on: [] },
      x: { description: 'X', execution: 'auto', depends_on: [], handler: 'h' },
    });
    expect(nextSentenceOf(openRun(), both)).toBe(
      " Ready for the agent: 'a'. Owed to the engine: 'x' — call advance_run.",
    );
    const done = def({ x: { description: 'X', execution: 'auto', depends_on: [] } });
    expect(nextSentenceOf(openRun({ completed_steps: ['x'] }), done)).toBe(' No step is ready.');
  });

  it('C34: the sentence names each engine step that cannot run, one cell per member, after the other clauses', () => {
    const withX = (x: StepDefinition): WorkflowDefinition => def({ x });
    // decision C36: `here` for capability only — a runner with the handler could run it; another
    // runner can run it, so no way out follows (C57).
    expect(
      nextSentenceOf(
        openRun(),
        withX({ description: 'X', execution: 'auto', depends_on: [], handler: 'h' }),
        new ExtensionRegistry(),
      ),
    ).toBe(
      " 'x' cannot run here (capability): handler 'h' is not registered here — load the missing extension, or run the step on a runner that has it.",
    );
    // decision C57: a step refused before its claim with nothing else ready — the way out follows.
    expect(
      nextSentenceOf(
        openRun(),
        withX({ description: 'X', execution: 'auto', depends_on: [], trust: 'nope' as never }),
      ),
    ).toMatch(
      /^ 'x' cannot run \(trust\): .*\. Correct the workflow and register it again, then call advance_run; or end the run with abandon_run\.$/,
    );
    // decision C37: a refusal that ends with a full stop gets no second one.
    expect(
      nextSentenceOf(
        openRun(),
        withX({
          description: 'X',
          execution: 'auto',
          depends_on: [],
          preconditions: ['missing.ok == true'],
        }),
      ),
    ).toBe(
      ` 'x' cannot run (precondition): Precondition failed for step 'x'. Precondition failed: 'missing.ok == true'. Resolved value: undefined. ${TOOLS_WAY_OUT_TEXT}`,
    );
    expect(
      nextSentenceOf(
        openRun(),
        withX({
          description: 'X',
          execution: 'auto',
          depends_on: [],
          input_schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
        }),
      ),
    ).toBe(
      // F15: refused for its input, `x` with no `depends_on` — its own way out (T-20 (i)).
      ` 'x' cannot run (input_schema): Invalid input for step 'x': the input must have required property 'n'. ${inputWayOutParams('x')}`,
    );
    // After the agent and the owed clauses, in that order; `No step is ready.` never beside them.
    expect(
      nextSentenceOf(
        openRun(),
        def({
          a: { description: 'A', execution: 'agent', depends_on: [] },
          x: { description: 'X', execution: 'auto', depends_on: [], trust: 'nope' as never },
          y: { description: 'Y', execution: 'auto', depends_on: [] },
        }),
      ),
    ).toMatch(
      /^ Ready for the agent: 'a'\. Owed to the engine: 'y' — call advance_run\. 'x' cannot run \(trust\): [^]*\.$/,
    );
  });

  it('C205: with nothing ready but steps in flight elsewhere, the sentence names them and the wait — one, and several (`are`, `them`)', async () => {
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
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      await store.claimStep(run.id, 'a', d, other);
      await store.claimStep(run.id, 'b', d, other);
      expect(nextSentenceOf(await store.get(run.id), d)).toBe(
        " No step is ready: 'a', 'b' are in flight elsewhere — wait for them, then call get_run_state.",
      );
    });
  });

  it('C37: the act agrees with the count — the step / it, the steps / them', () => {
    const two = renderWaysOf(
      composeWaysAt(openRun(), new Date(), {
        definition: def({
          a: { description: 'A', execution: 'auto', depends_on: [] },
          b: { description: 'B', execution: 'auto', depends_on: [] },
        }),
      }),
      {},
    );
    expect(two.next_actions[0]!.human_readable).toBe(
      "Call advance_run to run the steps the engine owes: 'a', 'b'. It runs them with this server's extensions and environment until a step opens a question, fails or ends the run.",
    );
    const one = renderWaysOf(
      composeWaysAt(openRun(), new Date(), {
        definition: def({ a: { description: 'A', execution: 'auto', depends_on: [] } }),
      }),
      {},
    );
    expect(one.next_actions[0]!.human_readable).toBe(
      "Call advance_run to run the step the engine owes: 'a'. It runs it with this server's extensions and environment.",
    );
  });

  it("C33 at the reply sites: an answer's words judge the capability check with the CALL's registry", async () => {
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
        await advanceRun(store, d, { runId: run.id, registry: new ExtensionRegistry() });
        await executeStep(store, d, {
          runId: run.id,
          command: 'b',
          input: {},
          dispatcher: echo,
          registry: has,
        });
        const gate = (await store.get(run.id)).pending_gate!;
        return out(
          await submitHumanResponse(store, d, {
            runId: run.id,
            gateId: gate.gate_id,
            choice: 'approve',
            ...(registry !== undefined ? { registry } : {}),
          }),
        );
      });
    const capable = await answer(has);
    expect(capable.context_hint).toBe(
      "Gate 'b' resolved with choice 'approve'. Owed to the engine: 'act' — call advance_run.",
    );
    expect(capable.next_actions.map((a) => a.instruction?.tool)).toEqual(['advance_run']);
    const lacking = await answer(new ExtensionRegistry());
    expect(lacking.context_hint).toBe(
      "Gate 'b' resolved with choice 'approve'. 'act' cannot run here (capability): handler 'note' is not registered here — load the missing extension, or run the step on a runner that has it.",
    );
    expect(lacking.next_actions).toEqual([]);
    const none = await answer(undefined);
    expect(none.context_hint).toBe(
      "Gate 'b' resolved with choice 'approve'. 'act' could not run (capability): handler 'note' was not registered in the runner that last attempted it.",
    );
    expect(none.next_actions).toEqual([]);
  });

  it('C34/C57 at the step sites: a completed step names a next step that cannot run, and the way out', async () => {
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
      const reply = out(
        await executeStep(store, d, {
          runId: run.id,
          command: 'w',
          input: { ok: false },
          dispatcher: echo,
        }),
      );
      expect(reply.status).toBe('ok');
      expect(reply.next_actions).toEqual([]);
      expect(reply.context_hint).toBe(
        `Step 'w' completed. 'x' cannot run (precondition): Precondition failed for step 'x'. Precondition failed: 'w.ok == true'. Resolved value: false. ${TOOLS_WAY_OUT_TEXT}`,
      );
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
    it(`C51 ${member}: advance_run's nothing-ran reply names the step and ends with the tools' way out`, async () => {
      const d = def({ x: refusedStep[member] });
      await withStore(async (store: RunStore) => {
        const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
        const reply = out(await advanceRun(store, d, { runId: run.id }));
        expect(reply.next_actions).toEqual([]);
        expect(
          reply.context_hint.startsWith(
            `Run '${run.id}': nothing ran. 'x' cannot run (${member}): `,
          ),
        ).toBe(true);
        expect(
          reply.context_hint.endsWith(
            member === 'input_schema' ? inputWayOutParams('x') : TOOLS_WAY_OUT_TEXT,
          ),
        ).toBe(true);
        expect(reply.context_hint).not.toContain('..');
        // T-22: an `ok` reply on an open run with nothing callable says `report_to_user`.
        expect(reply.agent_action).toBe('report_to_user');
      });
    });
  }

  it('D3.2/C205: when the only owed step is taken, nothing ran — the hint names the wait, then the race; `await` with its pace', async () => {
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
      const reply = out(await advanceRun(store, d, { runId: run.id }));
      expect(reply.next_actions).toEqual([]);
      // #729 PR-0 (Table row 36): what happened is core's (the race also as `races`); the wait is the
      // door's, said before the race clause, as before PR-0 (358d3c83, pending-625.test.ts:943).
      expect(reply.context_hint).toBe(
        `Run '${run.id}': nothing ran. No step is ready: 'x' is in flight elsewhere — wait for it, then call get_run_state. 'x' was claimed by another process, so it did not run here.`,
      );
      expect(reply.races).toEqual([{ step: 'x', kind: 'held_elsewhere', ran_here: false }]);
      // T-22: a step in flight elsewhere is a wait — `await`, with the pace (P-2).
      expect(reply.agent_action).toBe('await');
      expect(reply.poll_after_ms).toBe(30_000);
    });
  });
});

describe('#729 PR-0 — the run_step and advance instructions an agent reads', () => {
  // ---------------------------------------------------------------------------
  // the instruction population
  // ---------------------------------------------------------------------------

  describe('the instruction population (formerly core buildNextActions; #729 PR-0: the MCP door renders the ways)', () => {
    // issue #412: the `expected_timeout` display is gone. It rendered on every NextAction built
    // from a step carrying `timeout_seconds` — agent steps, and handler-bearing steps of any
    // kind — and on both the INSTRUCTED action is outside anything that enforced the number.
    // The definitions here are built programmatically because the loader now refuses this shape
    // on an agent step (#402); a definition from the registry or an older store can still carry
    // it, which is exactly the population that must not be shown a bound nobody applies.
    it('an agent step carrying timeout_seconds gets NO timeout display', async () => {
      await withStore(async (store) => {
        const def: WorkflowDefinition = {
          id: 'no-expected-timeout-agent-wf',
          name: 'No Expected Timeout (agent)',
          version: 1,
          steps: {
            'review-code': {
              description: 'Review the code',
              execution: 'agent',
              depends_on: [],
              timeout_seconds: 60,
            },
          },
        };
        const { run } = await store.create({
          workflowId: 'no-expected-timeout-agent-wf',
          workflowVersion: 1,
          params: {},
        });
        const action = renderWaysOf(composeWaysAt(run, new Date(), { definition: def }), {})
          .next_actions[0]!;
        expect(action.instruction!.tool).toBe('execute_step');
        expect(Object.keys(action)).not.toContain('expected_timeout');
        expect(JSON.stringify(action)).not.toContain('60s');
      });
    });

    it('a HANDLER-bearing step carrying timeout_seconds gets none either', async () => {
      await withStore(async (store) => {
        // The other half of the reach, and the one the audit corrected: the NextActions filter is
        // agent-OR-handler, so an auto step with a handler is shown this too — and its instruction
        // tells the reader to call the handler themselves, which no withTimeout wraps.
        const def: WorkflowDefinition = {
          id: 'no-expected-timeout-handler-wf',
          name: 'No Expected Timeout (handler)',
          version: 1,
          steps: {
            enrich: {
              description: 'Enrich the record',
              execution: 'auto',
              depends_on: [],
              handler: 'do_enrich',
              timeout_seconds: 60,
            },
          },
        };
        const { run } = await store.create({
          workflowId: 'no-expected-timeout-handler-wf',
          workflowVersion: 1,
          params: {},
        });
        // issue #625 PR-2a (decision C5): an auto step is never its own next action — its handler is
        // no tool a client can call; the one act is `advance_run`.
        const action = renderWaysOf(composeWaysAt(run, new Date(), { definition: def }), {})
          .next_actions[0]!;
        expect(action.instruction!.tool).toBe('advance_run');
        expect(Object.keys(action)).not.toContain('expected_timeout');
        expect(JSON.stringify(action)).not.toContain('60s');
      });
    });

    it('populates instruction with execute_step for an agent step', async () => {
      await withStore(async (store) => {
        const agentStepDef: WorkflowDefinition = {
          id: 'agent-instr-wf',
          name: 'Agent Instruction Workflow',
          version: 1,
          steps: {
            'review-code': {
              description: 'Review the code',
              execution: 'agent',
              depends_on: [],
              input_schema: { required: ['findings'], properties: { findings: { type: 'array' } } },
            },
          },
        };

        const { run: run } = await store.create({
          workflowId: 'agent-instr-wf',
          workflowVersion: 1,
          params: {},
        });

        const actions = renderWaysOf(
          composeWaysAt(run, new Date(), { definition: agentStepDef }),
          {},
        ).next_actions;
        expect(actions).toHaveLength(1);
        const action = actions[0]!;
        expect(action.instruction).not.toBeNull();
        expect(action.instruction!.tool).toBe('execute_step');
        expect((action.instruction!.params as Record<string, unknown>)['command']).toBe(
          'review-code',
        );
        expect((action.instruction!.params as Record<string, unknown>)['run_id']).toBe(run.id);
        expect(action.input_schema).toEqual(agentStepDef.steps['review-code']?.input_schema);
        expect(
          (action.instruction!.params as Record<string, unknown>)['input_schema'],
        ).toBeUndefined();
        expect(action.instruction!.call_with).toBeDefined();
        expect((action.instruction!.call_with as Record<string, unknown>)['run_id']).toBe(run.id);
        expect((action.instruction!.call_with as Record<string, unknown>)['command']).toBe(
          'review-code',
        );
        // input_schema is present → call_with.params is a skeleton object
        const callWithParams = (action.instruction!.call_with as Record<string, unknown>)['params'];
        expect(typeof callWithParams).toBe('object');
        expect(callWithParams).not.toBeNull();
      });
    });

    it('returns no actions for an auto step without a handler', async () => {
      await withStore(async (store) => {
        const autoStepDef: WorkflowDefinition = {
          id: 'auto-instr-wf',
          name: 'Auto Instruction Workflow',
          version: 1,
          steps: {
            'fetch-data': {
              description: 'Fetch data automatically',
              execution: 'auto',
              depends_on: [],
            },
          },
        };

        const { run: run } = await store.create({
          workflowId: 'auto-instr-wf',
          workflowVersion: 1,
          params: {},
        });

        // issue #625 PR-2a: an auto step is never its own next action — the one act runs it
        const actions = renderWaysOf(
          composeWaysAt(run, new Date(), { definition: autoStepDef }),
          {},
        ).next_actions;
        expect(actions).toHaveLength(1);
        expect(actions[0]!.instruction!.tool).toBe('advance_run');
        expect(actions[0]!.human_readable).toBe(
          "Call advance_run to run the step the engine owes: 'fetch-data'. It runs it with this server's extensions and environment.",
        );
      });
    });
  });
});

describe("#729 PR-0 — C149/C148: a refusal's suggestion and hint, from the rendered list", () => {
  const dispatcher = async () => ({});
  const MIX = def({
    a: { description: 'A.', execution: 'agent', depends_on: [] },
    b: { description: 'B.', execution: 'auto', depends_on: [] },
    x: { description: 'X.', execution: 'auto', depends_on: ['a'] },
    y: { description: 'Y.', execution: 'auto', depends_on: ['b'] },
    c: { description: 'C.', execution: 'auto', depends_on: ['a', 'b'] },
  });
  const blockedOn = async (
    store: RunStore,
    d: WorkflowDefinition,
    command: string,
    setup?: (runId: string) => Promise<unknown>,
  ) => {
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    await setup?.(run.id);
    const reply = out(
      await executeStep(store, d, { runId: run.id, command, input: {}, dispatcher }),
    );
    return {
      status: reply.status,
      next: reply.next_actions.map(
        (n) => n.instruction?.params?.['command'] ?? n.instruction?.tool,
      ),
      suggestion: reply.blocked_reason?.suggestion,
    };
  };

  it('steps and the act — the suggestion names the steps and advance_run, and never calls the act a step', async () => {
    await withStore(async (store) => {
      expect(await blockedOn(store, MIX, 'c')).toEqual({
        status: 'blocked',
        next: ['a', 'advance_run'],
        suggestion: 'Call one of the steps indicated in next_actions, or advance_run, instead.',
      });
    });
  });

  it('steps only — one of the steps', async () => {
    await withStore(async (store) => {
      expect(
        await blockedOn(store, MIX, 'x', (runId) => advanceRun(store, MIX, { runId })),
      ).toEqual({
        status: 'blocked',
        next: ['a'],
        suggestion: 'Call one of the steps indicated in next_actions instead.',
      });
    });
  });

  it('the act only — advance_run', async () => {
    const d = def({
      b: { description: 'B.', execution: 'auto', depends_on: [] },
      y: { description: 'Y.', execution: 'auto', depends_on: ['b'] },
    });
    await withStore(async (store) => {
      expect(await blockedOn(store, d, 'y')).toEqual({
        status: 'blocked',
        next: ['advance_run'],
        suggestion: 'Call advance_run, as next_actions says.',
      });
    });
  });

  it('the answer — answer the open question; the hint names the question and its answer', async () => {
    const d = def({
      q: {
        description: 'Ask.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: { choices: ['approve', 'reject'] },
      },
      after: { description: 'After.', execution: 'auto', depends_on: ['q'] },
    });
    await withStore(async (store) => {
      expect(
        await blockedOn(store, d, 'after', (runId) =>
          executeStep(store, d, { runId, command: 'q', input: {}, dispatcher }),
        ),
      ).toEqual({
        status: 'blocked',
        next: ['submit_human_response'],
        suggestion: 'Answer the open question first, as next_actions says.',
      });
    });
  });

  it('C148: a step that has completed is refused; the hint says why, then what is ready', async () => {
    const d = def({
      a: { description: 'A.', execution: 'agent', depends_on: [] },
      s: { description: 'S.', execution: 'agent', depends_on: ['a'] },
      b: { description: 'B.', execution: 'agent', depends_on: [] },
    });
    await withStore(async (store) => {
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const echoIt = async (_s: string, input: Record<string, unknown>) => input;
      await executeStep(store, d, { runId: run.id, command: 'a', input: {}, dispatcher: echoIt });
      await executeStep(store, d, { runId: run.id, command: 's', input: {}, dispatcher: echoIt });
      const reply = out(
        await executeStep(store, d, { runId: run.id, command: 's', input: {}, dispatcher }),
      );
      expect(reply.context_hint).toBe(
        "Step 's' cannot be called now: it has already completed. Ready for the agent: 'b'.",
      );
      expect(reply.agent_action).toBe('resolve_precondition');
      expect(reply.blocked_reason?.suggestion).toBe(
        'Call one of the steps indicated in next_actions instead.',
      );
    });
  });
});

describe('#729 PR-0 — Amendment 16: the words name a way only where the agent can call it', () => {
  it('a wrong gate id at a question whose time is up, on a program whose project code failed to load: the tail never says to call advance_run (advance is listed, not callable)', async () => {
    await withStore(async (store) => {
      const d = def({
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
        } as StepDefinition,
        after: { description: 'After.', execution: 'auto', depends_on: ['q'] },
      });
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      await executeStep(store, d, { runId: run.id, command: 'q', input: {}, dispatcher: echo });
      const open = await store.get(run.id);
      const past = new Date(new Date(open.pending_gate!.expires_at!).getTime() + 5_000);
      // The engine's refusal of the wrong gate id, its ways re-judged as a program whose project
      // code failed to load judges them (A-5): advance listed (enactor_load_failed), not offered.
      const refused = await submitHumanResponse(store, d, {
        runId: run.id,
        gateId: 'not-the-gate',
        choice: 'approve',
        now: new Date(open.pending_gate!.opened_at),
      });
      const failedLoad = composeWaysOn(writtenSnapshot(open, past), {
        definition: { ok: d },
        enactor: { kind: 'load_failed', error_code: 'uncoded' },
        store: { persistsClaims: true },
      });
      const hint = out({ ...refused, ...failedLoad }).context_hint;
      // (a) red when the due tail names advance_run though it is not callable; (b) prints the hint's
      //     tail booleans.
      expect({
        timeUp: hint.includes('can no longer be answered: its time is up.'),
        namesAdvance: hint.includes('advance_run'),
      }).toEqual({ timeUp: true, namesAdvance: false });
      // CONTROL: the same refusal with the reply's own ways (advance offered) names the act.
      const callable = composeWaysOn(writtenSnapshot(open, past), {
        definition: { ok: d },
        enactor: { kind: 'observer' },
        store: { persistsClaims: true },
      });
      expect(out({ ...refused, ...callable }).context_hint).toContain(
        'its time is up — call advance_run to carry out its declared settle_default.',
      );
    });
  });
});
