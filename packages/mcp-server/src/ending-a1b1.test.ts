// ending-a1b1.test.ts — issue #625 PR-2b (A1b-1): one sentence for how a run ended, read from its
// record only, on the MCP replies about a run that someone other than the call ended.
//
// Before A1b-1 an abandoned run's replies said "An operator ended this run", though no record holds
// who did it, and most other endings were named by their phase only. Now one core composer gives
// each ending one sentence — which steps failed, which step or guard aborted it, a question's time
// limit, 'realm run cleanup', the reason an abandon was given — and the four MCP tails say it once, on a
// reply about a run that had already ended or that another program ended during the call.
//
// Each ended record is written by its real writer: the step arms by running the workflow, the
// run-level arms through the store's `seal_run` with each writer's exact arm and reason, a
// classified seal through `stampSeal` (the migrate vehicle's write), a record with no seal seeded as
// a legacy record. Every assertion carries (a) the change that turns it red and (b) what it prints.
import { describe, it, expect, afterEach } from 'vitest';
import {
  ExtensionRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  abandonRun,
  advanceRun,
  executeChain,
  executeStep,
  submitHumanResponse,
  classifyLegacySeal,
  terminalAnswerRefusalMessage,
  type RunRecord,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { handleAdvanceRun } from './tools/advance-run.js';
import { handleExecuteStep } from './tools/execute-step.js';
import { handleStartRun } from './tools/start-run.js';
import { handleSubmitHumanResponse } from './tools/submit-human-response.js';
import { handleAbandonRun } from './tools/abandon-run.js';
import { createRealmMcpServer } from './server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { makeTempHome, runsOf, type TempHome } from './test-support/temp-home.js';

const def = (id: string, steps: Record<string, unknown>): WorkflowDefinition =>
  ({ id, name: id, version: 1, schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION, steps }) as never;

const homes: TempHome[] = [];
afterEach(async () => {
  for (const h of homes.splice(0).reverse()) await h.cleanup();
});

/** An in-memory run store on a settable clock, beside a temp home's workflow store. */
async function world(defs: WorkflowDefinition[], registry = new ExtensionRegistry()) {
  const h = await makeTempHome();
  homes.push(h);
  const clock = settableClock(new Date('2026-11-18T00:00:00Z'));
  const runStore = new InMemoryStore({ clock });
  for (const d of defs) await h.stores.workflowStore.register(d);
  const stores = {
    runStore: runStore as RunStore,
    workflowStore: h.stores.workflowStore,
    registry,
  };
  const fresh = async (d: WorkflowDefinition): Promise<string> =>
    (await runStore.create({ workflowId: d.id, workflowVersion: 1, params: {} })).record.id;
  return { runStore, clock, stores, registry, fresh };
}

const echo = async (_n: string, i: Record<string, unknown>) => ({ ...i });
const occurrences = (text: unknown, words: string): number => String(text).split(words).length - 1;

/** The MCP reply of `advance_run` on a run that has already ended. */
async function endedReply(w: Awaited<ReturnType<typeof world>>, runId: string) {
  return (await handleAdvanceRun({ run_id: runId }, w.stores)) as unknown as Record<
    string,
    unknown
  >;
}

/** A registry with `ok`, `boom` (throws), `quit` (aborts), each a handler id. */
function handlers(): ExtensionRegistry {
  const r = new ExtensionRegistry();
  r.register('handler', 'ok', { id: 'ok', execute: async () => ({ data: { ok: true } }) } as never);
  r.register('handler', 'boom', {
    id: 'boom',
    execute: async () => {
      throw new Error('the printer is on fire');
    },
  } as never);
  r.register('handler', 'quit', {
    id: 'quit',
    execute: async () => ({ abort: { message: 'Nothing to do.' } }),
  } as never);
  return r;
}

const GATE = (extra: Record<string, unknown> = {}) => ({
  description: 'Q.',
  execution: 'auto',
  trust: 'human_confirmed',
  depends_on: [],
  gate: { choices: ['ok', 'no'], ...extra },
});

/** Each arm's workflow; the run that ends by it is driven by `end`. */
const D = {
  complete: def('e-complete', { s: { description: 'S.', execution: 'auto', depends_on: [] } }),
  answer: def('e-answer', { q: GATE() }),
  guardPass: def('e-guard-pass', {
    a: { description: 'A.', execution: 'agent', depends_on: [] },
    g: { description: 'G.', execution: 'guard', depends_on: ['a'], abort_unless: ['a.ok == true'] },
  }),
  expiryDefault: def('e-expiry-default', {
    q: GATE({ timeout_seconds: 60, on_expiry: 'settle_default', default_choice: 'ok' }),
  }),
  failure: def('e-failure', {
    s: { description: 'S.', execution: 'auto', depends_on: [], handler: 'boom' },
  }),
  twoFailed: def('e-two-failed', {
    a: { description: 'A.', execution: 'auto', depends_on: [], handler: 'boom' },
    b: {
      description: 'B.',
      execution: 'auto',
      depends_on: ['a'],
      trigger_rule: 'one_failed',
      handler: 'boom',
    },
  }),
  resolution: def('e-resolution', {
    a: { description: 'A.', execution: 'agent', depends_on: [] },
    g: {
      description: 'G.',
      execution: 'guard',
      depends_on: ['a'],
      abort_unless: ['a.missing == true'],
    },
  }),
  handlerAbort: def('e-handler-abort', {
    s: { description: 'S.', execution: 'auto', depends_on: [], handler: 'quit' },
  }),
  guardAbort: def('e-guard-abort', {
    a: { description: 'A.', execution: 'agent', depends_on: [] },
    g: {
      description: 'G.',
      execution: 'guard',
      depends_on: ['a'],
      abort_unless: ['a.ok == true'],
      abort_message: 'Not ok.',
    },
  }),
  expiryAbort: def('e-expiry-abort', { q: GATE({ timeout_seconds: 60, on_expiry: 'abort' }) }),
  runLevel: def('e-run-level', { a: { description: 'A.', execution: 'agent', depends_on: [] } }),
};
const ALL = Object.values(D);

/** Ends a fresh run of `d` by its arm's real writer; returns the run id. */
async function endBy(w: Awaited<ReturnType<typeof world>>, arm: string): Promise<string> {
  const s = w.runStore;
  const seal = async (d: WorkflowDefinition, a: string, reason: string, release = false) => {
    const id = await w.fresh(d);
    const { record } = await s.get(id);
    await s.settleStep!(id, {
      kind: 'seal_run',
      arm: a as never,
      reason,
      expected_version: record.version,
      release_claims: release,
    });
    return id;
  };
  const answer = async (d: WorkflowDefinition) => {
    const id = await w.fresh(d);
    await executeStep(s, d, { runId: id, command: 'q', input: {}, dispatcher: echo });
    const gate = (await s.get(id)).record.pending_gate!;
    return { id, gate };
  };
  switch (arm) {
    case 'complete': {
      const id = await w.fresh(D.complete);
      await advanceRun(s, D.complete, { runId: id, registry: w.registry });
      return id;
    }
    case 'gate_resolution_complete': {
      const { id, gate } = await answer(D.answer);
      await submitHumanResponse(s, D.answer, { runId: id, gateId: gate.gate_id, choice: 'ok' });
      return id;
    }
    case 'guard_pass_complete': {
      const id = await w.fresh(D.guardPass);
      await executeChain(s, D.guardPass, {
        runId: id,
        command: 'a',
        input: { ok: true },
        dispatcher: echo,
      });
      return id;
    }
    case 'gate_expiry_default': {
      const { id } = await answer(D.expiryDefault);
      await w.clock.set(new Date('2026-11-18T00:05:00Z'));
      await advanceRun(s, D.expiryDefault, { runId: id, registry: w.registry });
      return id;
    }
    case 'step_failure': {
      const id = await w.fresh(D.failure);
      await advanceRun(s, D.failure, { runId: id, registry: w.registry });
      return id;
    }
    case 'guard_resolution_error': {
      const id = await w.fresh(D.resolution);
      await executeChain(s, D.resolution, {
        runId: id,
        command: 'a',
        input: { ok: true },
        dispatcher: echo,
      });
      return id;
    }
    case 'spawn_failure':
      return seal(D.runLevel, 'spawn_failure', 'spawn_failed');
    case 'extensions_load_failure':
      return seal(D.runLevel, 'extensions_load_failure', 'extensions_load_failed');
    case 'handler_abort': {
      const id = await w.fresh(D.handlerAbort);
      await advanceRun(s, D.handlerAbort, { runId: id, registry: w.registry });
      return id;
    }
    case 'guard_abort': {
      const id = await w.fresh(D.guardAbort);
      await executeChain(s, D.guardAbort, {
        runId: id,
        command: 'a',
        input: { ok: false },
        dispatcher: echo,
      });
      return id;
    }
    case 'gate_expiry_abort': {
      const { id } = await answer(D.expiryAbort);
      await w.clock.set(new Date('2026-11-18T00:05:00Z'));
      await advanceRun(s, D.expiryAbort, { runId: id, registry: w.registry });
      return id;
    }
    case 'abandon_requested': {
      const id = await w.fresh(D.runLevel);
      await abandonRun(s, id, 'wrong customer');
      return id;
    }
    case 'cleanup_sweep':
      return seal(D.runLevel, 'cleanup_sweep', 'Marked abandoned by realm cleanup', true);
    default:
      throw new Error(`no writer for ${arm}`);
  }
}

/** Every arm and its one sentence, as the prompt's Words give them. */
const ENDINGS: Array<[string, string]> = [
  ['complete', 'It completed.'],
  ['gate_resolution_complete', "The answer on step 'q' completed the run."],
  ['guard_pass_complete', "Guard step 'g' passed and completed the run."],
  [
    'gate_expiry_default',
    "The question on step 'q' reached its time limit, and its declared default completed the run.",
  ],
  ['step_failure', "Step 's' failed."],
  ['guard_resolution_error', "Guard step 'g' failed with a resolution error. Run is terminated."],
  [
    'spawn_failure',
    "It failed: 'realm listen' could not start the program that drives it; the error is not on the record.",
  ],
  [
    'extensions_load_failure',
    "It failed: the project's extensions could not be loaded when 'realm agent' attached to it.",
  ],
  ['handler_abort', "Step 's''s handler aborted the run."],
  ['guard_abort', 'Guard step \'g\' aborted the run: "Not ok.".'],
  [
    'gate_expiry_abort',
    "Gate 'q' expired and the run aborted per the workflow's declared on_expiry.",
  ],
  ['abandon_requested', 'It was abandoned, with the reason "wrong customer".'],
  ['cleanup_sweep', "'realm run cleanup' marked it abandoned."],
];

describe('#625 A1b-1 — one sentence per ending, from the record, on the MCP reply about an ended run', () => {
  it.each(ENDINGS)('check 1 — %s: its own sentence, once', async (arm, sentence) => {
    const w = await world(ALL, handlers());
    const id = await endBy(w, arm);
    const { record } = await w.runStore.get(id);
    const r = await endedReply(w, id);
    // (a) red when one arm is read as another, or the sentence is said twice or not at all;
    //     (b) prints the arm the record holds and the hint.
    expect({
      arm: record.sealed_by?.arm,
      once: occurrences(r['context_hint'], sentence),
      hint: r['context_hint'],
    }).toMatchObject({
      arm,
      once: 1,
    });
    // No ending sentence claims who ended the run.
    expect(String(r['context_hint'])).not.toContain('operator');
  });

  it('check 1 — a record with no seal: worked out from its record, once', async () => {
    const w = await world(ALL, handlers());
    const id = await w.fresh(D.runLevel);
    const { record } = await w.runStore.get(id);
    // A record written before seals existed: terminal, completed by its prose, no `sealed_by`.
    w.runStore.seed({
      ...record,
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
      completed_steps: ['a'],
      run_phase: 'completed',
    } as RunRecord);
    const r = await endedReply(w, id);
    // (a) red when a record with no seal is given an arm's words; (b) prints the hint.
    expect(
      occurrences(
        r['context_hint'],
        "Its ending was worked out from its record (phase 'completed'); no seal was written.",
      ),
    ).toBe(1);
  });
});

describe('#625 A1b-1 — what the sentence never claims, and what it reads', () => {
  it('check 2 — no actor: abandon_run with a reason gives it; with none, "no reason was given", the door unnamed', async () => {
    const w = await world(ALL, handlers());
    const given = await w.fresh(D.runLevel);
    const none = await w.fresh(D.runLevel);
    await handleAbandonRun({ run_id: given, reason: 'x' }, w.stores);
    await handleAbandonRun({ run_id: none }, w.stores);
    const [a, b] = [await endedReply(w, given), await endedReply(w, none)];
    // (a) red when the old "an operator ended" clause returns, or Realm's default reason is read as
    //     one a person gave (the door then named); (b) prints both hints.
    expect({
      given: occurrences(a['context_hint'], 'It was abandoned, with the reason "x".'),
      none: occurrences(b['context_hint'], 'It was abandoned; no reason was given.'),
      door: String(b['context_hint']).includes('abandon_run'),
      operator: `${String(a['context_hint'])}${String(b['context_hint'])}`.includes('operator'),
    }).toEqual({ given: 1, none: 1, door: false, operator: false });
  });

  it('check 3 — two failed steps: both named, never sealed_by.step alone', async () => {
    const w = await world(ALL, handlers());
    const id = await w.fresh(D.twoFailed);
    await advanceRun(w.runStore, D.twoFailed, { runId: id, registry: w.registry });
    await advanceRun(w.runStore, D.twoFailed, { runId: id, registry: w.registry });
    const { record } = await w.runStore.get(id);
    const r = await endedReply(w, id);
    // (a) red when the sentence reads `sealed_by.step` (only the last failed step); (b) prints the
    //     record's failed steps, its seal's step and the hint.
    expect({
      failed: record.failed_steps,
      sealStep: record.sealed_by?.step,
      once: occurrences(r['context_hint'], "Steps 'a', 'b' failed."),
    }).toEqual({ failed: ['a', 'b'], sealStep: 'b', once: 1 });
  });

  it('check 4 — guard_abort with a message: the ended-run reply says it once; the act-time reply as today, without it', async () => {
    const w = await world(ALL, handlers());
    const id = await w.fresh(D.guardAbort);
    const act = (await handleExecuteStep(
      { run_id: id, command: 'a', params: { ok: false } },
      w.stores,
    )) as unknown as Record<string, unknown>;
    const after = await endedReply(w, id);
    // (a) red when M is dropped from the ended-before sentence, or added to the act-time mint (M
    //     then said twice: on the sentence and its `Reason:`); (b) prints both hints.
    expect({
      act: String(act['context_hint']).startsWith(
        "Step 'a' completed. Guard step 'g' aborted the run.",
      ),
      actHasM: String(act['context_hint']).includes('Not ok.'),
      after: occurrences(after['context_hint'], 'Guard step \'g\' aborted the run: "Not ok.".'),
    }).toEqual({ act: true, actHasM: false, after: 1 });
  });

  it('check 5 — how known: a classified seal says so, a classified handler_abort names its step from aborted_at', async () => {
    const w = await world(ALL, handlers());
    const id = await w.fresh(D.handlerAbort);
    const { record } = await w.runStore.get(id);
    // A record written before seals existed, aborted by a handler; then the migrate vehicle's stamp.
    const legacy = {
      ...record,
      terminal_state: true,
      terminal_reason: "Handler 'quit' aborted the run: Nothing to do.",
      aborted_at: { step_id: 's', abort_message: 'Nothing to do.' },
      run_phase: 'aborted',
    } as RunRecord;
    w.runStore.seed(legacy);
    const arm = classifyLegacySeal(legacy);
    await w.runStore.stampSeal!(id, { arm: arm!, classified: true }, legacy.version);
    const { record: stamped } = await w.runStore.get(id);
    const r = await endedReply(w, id);
    // (a) red when a classified seal's words are left out, or its step is read from `sealed_by`
    //     (absent on a classified seal); (b) prints the seal and the hint.
    expect({
      seal: stamped.sealed_by,
      once: occurrences(
        r['context_hint'],
        "Step 's''s handler aborted the run (classified when its record was migrated).",
      ),
    }).toEqual({ seal: { arm: 'handler_abort', classified: true }, once: 1 });
  });
});

/** A run store that lets another program abandon the run just before this call settles `step`. */
function abandonsBeforeSettle(inner: InMemoryStore, step: string): RunStore {
  let fired = false;
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'settleStep') {
        return async (...a: Parameters<NonNullable<InMemoryStore['settleStep']>>) => {
          const delta = a[1] as { kind?: string; step?: string };
          if (!fired && delta.kind === 'settle_step' && delta.step === step) {
            fired = true;
            await abandonRun(target, a[0], 'another program');
          }
          return target.settleStep!(...a);
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
    },
  }) as unknown as RunStore;
}

/** A registry whose handler `h` abandons the run (another program) while it runs. */
function abandoningHandler(store: () => InMemoryStore, runId: () => string): ExtensionRegistry {
  const r = new ExtensionRegistry();
  r.register('handler', 'h', {
    id: 'h',
    execute: async () => {
      await abandonRun(store(), runId(), 'another program');
      return { data: {} };
    },
  } as never);
  return r;
}

const ABANDONED = 'It was abandoned, with the reason "another program".';
const ANSWERED = "The answer on step 'q' completed the run.";

describe('#625 A1b-1 — said once, per surface', () => {
  it('check 6 — on a run already ended: execute_step, advance_run, start_run (matched) and submit_human_response each say it once', async () => {
    const w = await world(ALL, handlers());
    const id = await w.fresh(D.runLevel);
    await abandonRun(w.runStore, id, 'wrong customer');
    const keyed = await w.runStore.create({
      workflowId: D.runLevel.id,
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k',
    });
    await abandonRun(w.runStore, keyed.record.id, 'wrong customer');
    const said = 'It was abandoned, with the reason "wrong customer".';
    const exec = (await handleExecuteStep(
      { run_id: id, command: 'a', params: {} },
      w.stores,
    )) as unknown as Record<string, unknown>;
    const adv = await endedReply(w, id);
    const start = (await handleStartRun(
      { workflow_id: D.runLevel.id, params: {}, idempotency_key: 'k' },
      w.stores,
    )) as unknown as Record<string, unknown>;
    const answer = (await handleSubmitHumanResponse(
      { run_id: id, gate_id: 'other', choice: 'ok' },
      w.stores,
    )) as unknown as Record<string, unknown>;
    // (a) red when a surface drops the sentence or says it twice (its tail and its own text);
    //     (b) prints the counts.
    expect({
      exec: occurrences(exec['context_hint'], said),
      advance: occurrences(adv['context_hint'], said),
      start: occurrences(start['context_hint'], said),
      answer: occurrences(answer['context_hint'], said),
    }).toEqual({ exec: 1, advance: 1, start: 1, answer: 1 });
  });

  it('check 6 — this call’s own act: execute_step whose chained step failed, and an answer whose guard aborted the run, carry none', async () => {
    const chainFails = def('e-chain-fails', {
      a: { description: 'A.', execution: 'agent', depends_on: [] },
      s: { description: 'S.', execution: 'auto', depends_on: ['a'], handler: 'boom' },
    });
    const answerAborts = def('e-answer-aborts', {
      q: GATE(),
      g: {
        description: 'G.',
        execution: 'guard',
        depends_on: ['q'],
        abort_unless: ["q.choice == 'ok'"],
        abort_message: 'Said no.',
      },
    });
    const w = await world([...ALL, chainFails, answerAborts], handlers());
    const one = await w.fresh(chainFails);
    const exec = (await handleExecuteStep(
      { run_id: one, command: 'a', params: {} },
      w.stores,
    )) as unknown as Record<string, unknown>;
    const two = await w.fresh(answerAborts);
    await executeStep(w.runStore, answerAborts, {
      runId: two,
      command: 'q',
      input: {},
      dispatcher: echo,
    });
    const gate = (await w.runStore.get(two)).record.pending_gate!;
    const answer = (await handleSubmitHumanResponse(
      { run_id: two, gate_id: gate.gate_id, choice: 'no' },
      w.stores,
    )) as unknown as Record<string, unknown>;
    // (a) red when the rule fires on a reply whose own act ended the run (the ending then said
    //     twice: in the act's words and again); (b) prints both hints.
    expect({
      exec: occurrences(exec['context_hint'], "Step 's' failed."),
      answerSentence: occurrences(
        answer['context_hint'],
        'Guard step \'g\' aborted the run: "Said no.".',
      ),
      answerAct: occurrences(answer['context_hint'], "Guard step 'g' aborted the run."),
    }).toEqual({ exec: 1, answerSentence: 0, answerAct: 1 });
  });

  it('check 6 (M1) — execute_step whose own step meets a run another program abandoned: STATE_RUN_TERMINAL, the sentence once', async () => {
    const w = await world(ALL, handlers());
    const id = await w.fresh(D.runLevel);
    const r = (await handleExecuteStep(
      { run_id: id, command: 'a', params: {} },
      { ...w.stores, runStore: abandonsBeforeSettle(w.runStore, 'a') },
    )) as unknown as Record<string, unknown>;
    // (a) red when the `STATE_RUN_TERMINAL` signal is dropped from the rule; (b) prints the code
    //     and the hint.
    expect({ code: r['error_code'], once: occurrences(r['context_hint'], ABANDONED) }).toEqual({
      code: 'STATE_RUN_TERMINAL',
      once: 1,
    });
  });

  it('check 6 (ii) and M2 — advance_run meets a run another program abandoned: once; and after carrying out a settle_default expiry first: once', async () => {
    const plain = def('e-plain-race', {
      s: { description: 'S.', execution: 'auto', depends_on: [], handler: 'h' },
    });
    const afterExpiry = def('e-expiry-race', {
      q: GATE({ timeout_seconds: 60, on_expiry: 'settle_default', default_choice: 'ok' }),
      s: { description: 'S.', execution: 'auto', depends_on: ['q'], handler: 'h' },
    });
    let current = '';
    const w0 = await world([plain, afterExpiry]);
    const registry = abandoningHandler(
      () => w0.runStore,
      () => current,
    );
    const stores = { ...w0.stores, registry };
    current = await w0.fresh(plain);
    const a = (await handleAdvanceRun({ run_id: current }, stores)) as unknown as Record<
      string,
      unknown
    >;
    current = await w0.fresh(afterExpiry);
    await executeStep(w0.runStore, afterExpiry, {
      runId: current,
      command: 'q',
      input: {},
      dispatcher: echo,
    });
    await w0.clock.set(new Date('2026-11-18T00:05:00Z'));
    const b = (await handleAdvanceRun({ run_id: current }, stores)) as unknown as Record<
      string,
      unknown
    >;
    // (a) red when the `run_ended` race is dropped from the rule, or an expiry receipt is read as
    //     an exclusion again (M2 then says nothing); (b) prints both hints.
    expect({
      plain: occurrences(a['context_hint'], ABANDONED),
      afterExpiry: occurrences(b['context_hint'], ABANDONED),
    }).toEqual({ plain: 1, afterExpiry: 1 });
  });

  it('check 6 (M3) — start_run’s ran branch on a run another program abandoned during the call: once', async () => {
    const head = def('e-start-race', {
      s: { description: 'S.', execution: 'auto', depends_on: [], handler: 'h' },
    });
    const w0 = await world([head]);
    // The run's id is known only once start_run creates it: the handler reads the one run there is.
    const store = w0.runStore;
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h', {
      id: 'h',
      execute: async () => {
        await abandonRun(store, (await runsOf(store))[0]!.record.id, 'another program');
        return { data: {} };
      },
    } as never);
    const r = (await handleStartRun(
      { workflow_id: head.id, params: {} },
      { ...w0.stores, registry },
    )) as unknown as Record<string, unknown>;
    // (a) red when start_run's ran branch is left out of the tails; (b) prints the hint.
    expect(occurrences(r['context_hint'], ABANDONED)).toBe(1);
  });
});

describe('#625 A1b-1 — the answer form, the zombie refusal, the way out, D5', () => {
  it('check 6 — a form that came back after another door’s answer ended the run: the sentence once, after "ended while the form was open"', async () => {
    const asks = def('e-form', {
      a: { description: 'A.', execution: 'agent', depends_on: [] },
      q: { ...GATE(), depends_on: ['a'] },
    });
    const h = await makeTempHome();
    homes.push(h);
    await h.stores.workflowStore.register(asks);
    const clock = settableClock(new Date('2026-11-18T00:00:00Z'));
    const runStore = new InMemoryStore({ clock });
    const server = createRealmMcpServer({ ...h.stores, runStore });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'a1b1', version: '0' },
      { capabilities: { elicitation: { form: {} } } },
    );
    let runId = '';
    client.setRequestHandler(ElicitRequestSchema, async () => {
      // While the form is open, another door answers the question, and its answer completes the run.
      const gate = (await runStore.get(runId)).record.pending_gate!;
      await submitHumanResponse(runStore, asks, { runId, gateId: gate.gate_id, choice: 'ok' });
      return { action: 'decline' };
    });
    await Promise.all([server.connect(st), client.connect(ct)]);
    runId = (await runStore.create({ workflowId: asks.id, workflowVersion: 1, params: {} })).record
      .id;
    const raw = (await client.callTool(
      { name: 'execute_step', arguments: { run_id: runId, command: 'a', params: {} } },
      undefined,
      { timeout: 600_000 },
    )) as { content: Array<{ text: string }> };
    const r = JSON.parse(raw.content[0]!.text) as Record<string, unknown>;
    // (a) red when the form's ended-while-open arm drops the sentence, or the tail adds it again;
    //     (b) prints the hint.
    expect({
      opens: String(r['context_hint']).includes(
        `Run '${runId}' ended while the form was open (phase 'completed'). ${ANSWERED}`,
      ),
      once: occurrences(r['context_hint'], ANSWERED),
    }).toEqual({ opens: true, once: 1 });
  });

  it('check 6 — the zombie refusal with its time-limit outcome carries no ending sentence (its time-limit words say it)', async () => {
    const w = await world(ALL, handlers());
    const id = await w.fresh(D.expiryAbort);
    await executeStep(w.runStore, D.expiryAbort, {
      runId: id,
      command: 'q',
      input: {},
      dispatcher: echo,
    });
    const gate = (await w.runStore.get(id)).record.pending_gate!;
    await w.clock.set(new Date('2026-11-18T00:05:00Z'));
    // Another call carries the abort out first.
    await advanceRun(w.runStore, D.expiryAbort, { runId: id });
    const r = (await handleSubmitHumanResponse(
      { run_id: id, gate_id: gate.gate_id, choice: 'ok' },
      w.stores,
    )) as unknown as Record<string, unknown>;
    // (a) red when the zombie branch's exception is dropped (the ending then said twice: in the
    //     time-limit words and the sentence); (b) prints the reply.
    expect({
      outcome: r['outcome'] !== undefined,
      sentence: occurrences(
        JSON.stringify(r),
        "Gate 'q' expired and the run aborted per the workflow's declared on_expiry.",
      ),
    }).toEqual({ outcome: true, sentence: 0 });
  });

  it('check 7 — the way out: a completed run says completed once, an abandoned one points at a new run, a failed one still ends with its resume command', async () => {
    const w = await world(ALL, handlers());
    const done = await endBy(w, 'complete');
    const gone = await endBy(w, 'abandon_requested');
    const failed = await endBy(w, 'step_failure');
    const { record: doneRun } = await w.runStore.get(done);
    const refusal = terminalAnswerRefusalMessage(doneRun, D.complete, new Date());
    const [g, f] = [await endedReply(w, gone), await endedReply(w, failed)];
    // (a) red when the sentence is placed inside the way out ("completed" twice), the abandoned
    //     pointer is lost, or the resume command no longer ends the hint; (b) prints them.
    expect({
      refusal: refusal.split(' — ')[1],
      abandoned: String(g['context_hint']).endsWith(
        `${'It was abandoned, with the reason "wrong customer".'} To run the work again, start a new run.`,
      ),
      failedEnds: String(f['context_hint']).endsWith(`realm run resume ${failed} --from s`),
    }).toEqual({
      refusal: 'It completed. Nothing is owed.',
      abandoned: true,
      failedEnds: true,
    });
  });

  it('check 8 (D5) — advance_run on a run already ended says stop; on a run whose own expiry it carried out, no action', async () => {
    const w = await world(ALL, handlers());
    const ended = await endBy(w, 'complete');
    const before = await endedReply(w, ended);
    const id = await w.fresh(D.expiryAbort);
    await executeStep(w.runStore, D.expiryAbort, {
      runId: id,
      command: 'q',
      input: {},
      dispatcher: echo,
    });
    await w.clock.set(new Date('2026-11-18T00:05:00Z'));
    const own = (await handleAdvanceRun({ run_id: id }, w.stores)) as unknown as Record<
      string,
      unknown
    >;
    // (a) red when `stop` is set on both, or on neither; (b) prints the two actions.
    expect({ before: before['agent_action'], own: own['agent_action'] }).toEqual({
      before: 'stop',
      own: undefined,
    });
  });
});

describe('#625 A1b-1 correction 1 — the cells the review added', () => {
  it('correction 1 (WK-08) — a second answer on a run an earlier answer’s guard aborted says how the run ended, once', async () => {
    const d = def('e-second-answer', {
      confirm: GATE(),
      g: {
        description: 'G.',
        execution: 'guard',
        depends_on: ['confirm'],
        abort_unless: ["confirm.choice == 'ok'"],
        abort_message: 'Said no.',
      },
    });
    const w = await world([...ALL, d], handlers());
    const id = await w.fresh(d);
    await executeStep(w.runStore, d, {
      runId: id,
      command: 'confirm',
      input: {},
      dispatcher: echo,
    });
    const gate = (await w.runStore.get(id)).record.pending_gate!;
    // The first answer: its guard aborts the run.
    await submitHumanResponse(w.runStore, d, { runId: id, gateId: gate.gate_id, choice: 'no' });
    const second = (await handleSubmitHumanResponse(
      { run_id: id, gate_id: gate.gate_id, choice: 'ok' },
      w.stores,
    )) as unknown as Record<string, unknown>;
    // (a) red when the refusal's outcome (who answered) is taken to say how the run ended — the
    //     ending then left out; (b) prints the code and the hint.
    expect({
      code: second['error_code'],
      already: String(second['context_hint']).startsWith("Not recorded: your choice 'ok'."),
      once: occurrences(second['context_hint'], 'Guard step \'g\' aborted the run: "Said no.".'),
    }).toEqual({ code: 'STATE_BLOCKED', already: true, once: 1 });
  });

  it('correction 1 — abandon_run with a blank reason: no reason was given', async () => {
    const w = await world(ALL, handlers());
    const id = await w.fresh(D.runLevel);
    await handleAbandonRun({ run_id: id, reason: '' }, w.stores);
    const r = await endedReply(w, id);
    // (a) red when a blank reason is shown as one a person gave; (b) prints the hint.
    expect(occurrences(r['context_hint'], 'It was abandoned; no reason was given.')).toBe(1);
  });

  it('correction 1 — a legacy abandoned record with no seal keeps its reason, and says how it is known', async () => {
    const w = await world(ALL, handlers());
    const id = await w.fresh(D.runLevel);
    const { record } = await w.runStore.get(id);
    // A record written before seals existed: abandoned by hand, with a reason, no `sealed_by`.
    w.runStore.seed({
      ...record,
      terminal_state: true,
      terminal_reason: 'stopped by hand',
      abandoned_at: '2026-01-01T00:00:00.000Z',
      run_phase: 'abandoned',
    } as RunRecord);
    const r = await endedReply(w, id);
    // (a) red when such a record loses its reason, or says it as a fresh seal would; (b) prints the
    //     hint.
    expect(
      occurrences(
        r['context_hint'],
        'It was abandoned, with the reason "stopped by hand" (worked out from its record; no seal was written).',
      ),
    ).toBe(1);
  });
});
