// named-calls-625.test.ts — issue #625 PR-2a, round 19 (the fresh walk on the final build):
// - decision C144 (W1-Y1): a `caller` outside an entry's own words throws `VALIDATION_CALLER_INVALID`
//   (category `VALIDATION`) at the admission step, before anything is read or written — per entry;
// - decision C151 (W5-Y2): `executeStep`, `executeChain`, `submitHumanResponse` (and
//   `executeEngineStep`) name themselves on the expiry line when they carry an expired question out;
//   a host passes its own name (the MCP tools', the CLI's), as `advanceRun`'s `caller` does (C124);
// - decision C148 (W4-Y1): a called step that has already completed, failed or been skipped is
//   refused `blocked` / `resolve_precondition` with what else can be called, and does not run again;
// - decision C149 (W4-Y2): the `blocked` suggestion says what `next_actions` holds, for every mix it
//   can meet — steps only, the act only, steps and the act, the answer — and never calls the act a
//   step.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  advanceRun,
  executeChain,
  executeEngineStep,
  executeStep,
  expiryCarriedOutLine,
  submitHumanResponse,
  type EnactedVia,
} from './execution-loop.js';
import { ENTRY_CALLERS } from './callers.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { ResponseEnvelope } from '../types/response-envelope.js';

/** `q` (a question, 60 s, `on_expiry` as given), then `after` (a bare `auto` step). */
function gated(onExpiry: 'settle_default' | 'abort'): WorkflowDefinition {
  return {
    id: `nc-${onExpiry}`,
    name: 'named calls',
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
          on_expiry: onExpiry,
          ...(onExpiry === 'settle_default' ? { default_choice: 'approve' } : {}),
        },
      },
      after: { description: 'After.', execution: 'auto', depends_on: ['q'] },
    },
  };
}

/** `a` (agent) and `b` (auto) ready at start; `x` after `a`; `y` after `b`; `c` after both. */
const MIX: WorkflowDefinition = {
  id: 'nc-mix',
  name: 'mixes',
  version: 1,
  steps: {
    a: { description: 'A.', execution: 'agent', depends_on: [] },
    b: { description: 'B.', execution: 'auto', depends_on: [] },
    x: { description: 'X.', execution: 'auto', depends_on: ['a'] },
    y: { description: 'Y.', execution: 'auto', depends_on: ['b'] },
    c: { description: 'C.', execution: 'auto', depends_on: ['a', 'b'] },
  },
};

const dispatcher = async () => ({});

describe('#625 PR-2a, C144/C149/C151 — each call names itself; the suggestion says what next_actions holds', () => {
  let store: JsonFileStore;
  beforeEach(async () => {
    store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-nc-625-')));
  });

  async function atQuestion(d: WorkflowDefinition) {
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    const opened = await executeStep(store, d, {
      runId: run.id,
      command: 'q',
      input: {},
      dispatcher,
    });
    if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
    const gate = (await store.get(run.id)).pending_gate!;
    const past = new Date(new Date(gate.expires_at!).getTime() + 5_000);
    return { runId: run.id, gateId: gate.gate_id, past };
  }

  // C144: each entry's refusal of a word outside its own list.
  const REFUSE: Array<
    [
      string,
      (
        s: JsonFileStore,
        d: WorkflowDefinition,
        runId: string,
        gateId: string,
        caller: unknown,
      ) => Promise<unknown>,
    ]
  > = [
    [
      'advanceRun',
      (s, d, runId, _g, caller) => advanceRun(s, d, { runId, caller: caller as never }),
    ],
    [
      'executeStep',
      (s, d, runId, _g, caller) =>
        executeStep(s, d, {
          runId,
          command: 'after',
          input: {},
          dispatcher,
          caller: caller as never,
        }),
    ],
    [
      'executeChain',
      (s, d, runId, _g, caller) =>
        executeChain(s, d, {
          runId,
          command: 'after',
          input: {},
          dispatcher,
          caller: caller as never,
        }),
    ],
    [
      'submitHumanResponse',
      (s, d, runId, gateId, caller) =>
        submitHumanResponse(s, d, { runId, gateId, choice: 'approve', caller: caller as never }),
    ],
    [
      'executeEngineStep',
      async (s, d, runId, _g, caller) =>
        executeEngineStep(s, d, {
          runId,
          step: 'after',
          run: await store.get(runId),
          caller: caller as never,
        }),
    ],
  ];
  it.each(REFUSE)(
    'C144, W1-Y1: %s refuses a caller outside its words with VALIDATION_CALLER_INVALID — before anything is read or written',
    async (entry, call) => {
      const d = gated('settle_default');
      const { runId, gateId } = await atQuestion(d);
      const before = JSON.stringify(await store.get(runId));
      const calls: string[] = [];
      const watched = Object.create(store) as JsonFileStore;
      for (const m of ['get', 'update', 'settleStep', 'claimStep', 'create', 'list'] as const) {
        const own = (store[m] as (...a: unknown[]) => unknown).bind(store);
        Object.assign(watched, { [m]: (...a: unknown[]) => (calls.push(m), own(...a)) });
      }
      const words = ENTRY_CALLERS[entry as keyof typeof ENTRY_CALLERS].join(', ');
      const label =
        entry === 'advanceRun' ? ' To label the reply with a word of your own, pass command.' : '';
      for (const [given, named] of [
        ['nightly-sweep', "'nightly-sweep'"],
        [42, '42'],
        [{ name: 'x' }, 'a value of type object'],
      ] as const) {
        // (a) red when the code is ENGINE_INTERNAL again (C144 reverted), the entry does not check its
        // caller, or the message drops the value or the words; (b) prints what was thrown.
        await expect(call(watched, d, runId, gateId, given)).rejects.toMatchObject({
          code: 'VALIDATION_CALLER_INVALID',
          category: 'VALIDATION',
          agentAction: 'report_to_user',
          retryable: false,
          message: `${entry}'s caller is one of ${words}; it was given ${named}.${label} Nothing was read or written.`,
        });
      }
      // (a) red when the refusal read or wrote the store; (b) prints the calls made.
      expect(calls).toEqual([]);
      expect(JSON.stringify(await store.get(runId))).toBe(before);
    },
  );

  it("C155, W1-Y1: executeEngineStep's refusal names executeEngineStep — the entry the program called — and its own words, its default first", async () => {
    const d = gated('settle_default');
    const { runId } = await atQuestion(d);
    const before = JSON.stringify(await store.get(runId));
    // (a) red when executeEngineStep's caller is checked as executeStep's again (the message would
    // name executeStep and list executeStep first); (b) prints what was thrown.
    await expect(
      executeEngineStep(store, d, {
        runId,
        step: 'after',
        run: await store.get(runId),
        caller: 'executeChain' as never,
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_CALLER_INVALID',
      message:
        "executeEngineStep's caller is one of executeEngineStep, agent; it was given 'executeChain'. Nothing was read or written.",
      details: { entry: 'executeEngineStep' },
    });
    // (a) red when the refusal wrote; (b) prints the record.
    expect(JSON.stringify(await store.get(runId))).toBe(before);
  });

  it("C144: a word from another entry's list is refused too — executeChain is not executeStep", async () => {
    const d = gated('settle_default');
    const { runId } = await atQuestion(d);
    // (a) red when the lists are merged into one; (b) prints what was thrown.
    await expect(
      executeChain(store, d, {
        runId,
        command: 'after',
        input: {},
        dispatcher,
        caller: 'executeStep' as never,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_CALLER_INVALID' });
    await expect(
      executeStep(store, d, {
        runId,
        command: 'after',
        input: {},
        dispatcher,
        caller: 'execute_step' as never,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_CALLER_INVALID' });
  });

  // C151: a library call of each, and the name a host passes.
  type Carry = (
    s: JsonFileStore,
    d: WorkflowDefinition,
    runId: string,
    gateId: string,
    past: Date,
  ) => Promise<ResponseEnvelope>;
  const CARRY: Array<[string, EnactedVia, Carry]> = [
    [
      'executeStep',
      'executeStep',
      (s, d, runId, _g, now) =>
        executeStep(s, d, { runId, command: 'after', input: {}, dispatcher, now }),
    ],
    [
      'executeChain',
      'executeChain',
      (s, d, runId, _g, now) =>
        executeChain(s, d, { runId, command: 'after', input: {}, dispatcher, now }),
    ],
    [
      'submitHumanResponse',
      'submitHumanResponse',
      (s, d, runId, gateId, now) =>
        submitHumanResponse(s, d, { runId, gateId, choice: 'reject', now }),
    ],
    [
      'executeEngineStep',
      'executeEngineStep',
      async (s, d, runId, _g, now) =>
        executeEngineStep(s, d, { runId, step: 'after', run: await s.get(runId), now }),
    ],
    [
      'executeChain, caller execute_step (the MCP tool)',
      'execute_step',
      (s, d, runId, _g, now) =>
        executeChain(s, d, {
          runId,
          command: 'after',
          input: {},
          dispatcher,
          now,
          caller: 'execute_step',
        }),
    ],
    [
      'submitHumanResponse, caller submit_human_response (the MCP tool)',
      'submit_human_response',
      (s, d, runId, gateId, now) =>
        submitHumanResponse(s, d, {
          runId,
          gateId,
          choice: 'reject',
          now,
          caller: 'submit_human_response',
        }),
    ],
    [
      'submitHumanResponse, caller respond (realm run respond)',
      'respond',
      (s, d, runId, gateId, now) =>
        submitHumanResponse(s, d, { runId, gateId, choice: 'reject', now, caller: 'respond' }),
    ],
    [
      'executeChain, caller run (realm workflow run)',
      'run',
      (s, d, runId, _g, now) =>
        executeChain(s, d, { runId, command: 'after', input: {}, dispatcher, now, caller: 'run' }),
    ],
    [
      'executeEngineStep, caller agent (realm agent)',
      'agent',
      async (s, d, runId, _g, now) =>
        executeEngineStep(s, d, {
          runId,
          step: 'after',
          run: await s.get(runId),
          now,
          caller: 'agent',
        }),
    ],
  ];
  for (const onExpiry of ['settle_default', 'abort'] as const) {
    it.each(CARRY)(
      `C151, W5-Y2: %s carries out an expired ${onExpiry} — the line names %s, and the record holds no enacted_via`,
      async (_label, via, carry) => {
        const d = gated(onExpiry);
        const { runId, gateId, past } = await atQuestion(d);
        const reply = await carry(store, d, runId, gateId, past);
        const line = expiryCarriedOutLine(
          gateId,
          'q',
          onExpiry === 'settle_default'
            ? { on_expiry: 'settle_default', choice: 'approve' }
            : { on_expiry: 'abort' },
          via,
        );
        // (a) red when the function names another call (the MCP tool's, as before C151) or its
        // default is lost; (b) prints the reply's warnings.
        expect(reply.warnings.filter((w) => w.includes('had expired'))).toEqual([line]);
        // (a) red when enacted_via is written to the run's record; (b) prints the record's text.
        expect(JSON.stringify(await store.get(runId))).not.toContain('enacted_via');
      },
    );
  }

  // C149: one cell per mix of next_actions a refusal can meet.
  async function blockedOn(
    d: WorkflowDefinition,
    command: string,
    setup?: (runId: string) => Promise<unknown>,
  ) {
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    await setup?.(run.id);
    const reply = await executeStep(store, d, { runId: run.id, command, input: {}, dispatcher });
    return {
      status: reply.status,
      next: reply.next_actions.map(
        (n) => n.instruction?.params?.['command'] ?? n.instruction?.tool,
      ),
      suggestion: reply.blocked_reason?.suggestion,
    };
  }

  it('C149, W4-Y2: steps and the act — the suggestion names the steps and advance_run, and never calls the act a step', async () => {
    // (a) red when this mix gets the steps-only sentence again; (b) prints the reply.
    expect(await blockedOn(MIX, 'c')).toEqual({
      status: 'blocked',
      next: ['a', 'advance_run'],
      suggestion: 'Call one of the steps indicated in next_actions, or advance_run, instead.',
    });
  });

  it('C149: steps only — one of the steps', async () => {
    // (a) red when the steps-only sentence changes or names advance_run; (b) prints the reply.
    expect(await blockedOn(MIX, 'x', (runId) => advanceRun(store, MIX, { runId }))).toEqual({
      status: 'blocked',
      next: ['a'],
      suggestion: 'Call one of the steps indicated in next_actions instead.',
    });
  });

  it('C149: the act only — advance_run', async () => {
    const d: WorkflowDefinition = {
      id: 'nc-act',
      name: 'act',
      version: 1,
      steps: {
        b: { description: 'B.', execution: 'auto', depends_on: [] },
        y: { description: 'Y.', execution: 'auto', depends_on: ['b'] },
      },
    };
    // (a) red when the act-only sentence calls it a step; (b) prints the reply.
    expect(await blockedOn(d, 'y')).toEqual({
      status: 'blocked',
      next: ['advance_run'],
      suggestion: 'Call advance_run, as next_actions says.',
    });
  });

  it('C149: the answer — answer the open question', async () => {
    const d = gated('settle_default');
    // (a) red when the answer's sentence changes; (b) prints the reply.
    expect(
      await blockedOn(d, 'after', (runId) =>
        executeStep(store, d, { runId, command: 'q', input: {}, dispatcher }),
      ),
    ).toEqual({
      status: 'blocked',
      next: ['submit_human_response'],
      suggestion: 'Answer the open question first, as next_actions says.',
    });
  });
  // C148: the step called has already completed, failed or been skipped; `b` is ready beside it.
  it.each([['completed'], ['failed'], ['skipped']] as const)(
    'C148, W4-Y1: a step that has %s is refused with what else can be called — and does not run again',
    async (how) => {
      const d: WorkflowDefinition = {
        id: `nc-c148-${how}`,
        name: 'settled',
        version: 1,
        steps: {
          a: { description: 'A.', execution: 'agent', depends_on: [] },
          s: {
            description: 'S.',
            execution: 'agent',
            depends_on: ['a'],
            ...(how === 'skipped' ? { when: "a.go == 'yes'" } : {}),
          },
          b: { description: 'B.', execution: 'agent', depends_on: [] },
        },
      };
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      await executeChain(store, d, {
        runId: run.id,
        command: 'a',
        input: { go: 'no' },
        dispatcher: async (_s, input) => input,
      });
      if (how !== 'skipped') {
        await executeChain(store, d, {
          runId: run.id,
          command: 's',
          input: {},
          dispatcher:
            how === 'failed'
              ? async () => {
                  throw new Error('boom');
                }
              : dispatcher,
        });
      }
      const before = await store.get(run.id);
      let called = 0;
      const reply = await executeStep(store, d, {
        runId: run.id,
        command: 's',
        input: {},
        dispatcher: async () => (called++, {}),
      });
      const words = {
        completed: 'it has already completed',
        failed: 'it has already failed',
        skipped: 'it was skipped',
      }[how];
      // (a) red when the step runs again, the reply stops the caller, or the hint drops why;
      //     (b) prints the reply and the record's lists.
      expect({
        status: reply.status,
        agent_action: reply.agent_action,
        hint: reply.context_hint,
        next: reply.next_actions.map((n) => n.instruction?.params?.['command']),
        called,
        version: (await store.get(run.id)).version,
        phase: reply.run_phase,
      }).toEqual({
        status: 'blocked',
        agent_action: 'resolve_precondition',
        hint: `Step 's' cannot be called now: ${words}. Ready for the agent: 'b'.`,
        next: ['b'],
        called: 0,
        version: before.version,
        phase: 'running',
      });
    },
  );
});
