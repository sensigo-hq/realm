// stop-kind-625.test.ts — issue #625 PR-2a, the last prompt's F7 (review G7-01, G7-04 = F-R7, G5-9,
// G7-07, A3-7): ONE rule for "another program got there first". Core exports the stop kinds and one
// classifier; the advance loop reads it on every reply that is not `ok`, goes on past each race, and
// composes the reply it returns after one from the record it re-read.
//
// Part 1 runs the classifier itself, row by row (the prompt's table: first matching row wins).
// Part 2 builds each row as a real race on `advanceRun` — another program acts on the same store at
// the moment the row names (before the step's own read, at its claim, or while its handler runs) —
// and reads the reply and the callbacks. Part 3 is `executeChain`'s chain (an `execute_step` call).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../index.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { advanceRun, executeChain, executeStep } from './execution-loop.js';
import { abandonRun } from './abandon-run.js';
import { reclaimStep } from './reclaim-step.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { Attributed } from './holder.js';
import type { RunRecord } from '../types/run-record.js';
import type { ResponseEnvelope } from '../types/response-envelope.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';

/** F7's exports, read off the module so a cell runs before they exist (and fails on that). */
const F7 = core as unknown as {
  STOP_KINDS?: readonly string[];
  classifyStop?: (
    reply: Partial<ResponseEnvelope>,
    step: string | undefined,
    record: Partial<RunRecord>,
  ) => unknown;
};
const classify = (
  reply: Partial<ResponseEnvelope>,
  step: string | undefined,
  record: Partial<RunRecord>,
): unknown => F7.classifyStop?.(reply, step, record) ?? (F7.classifyStop ? undefined : '<none>');

const RACER: Attributed = { by: 'racer-b', by_source: 'stated', channel: 'test' };

describe('#625 PR-2a, F7 — the stop kinds and the one classifier', () => {
  it('STOP_KINDS is one exported const: six race kinds, then the three that stop a loop', () => {
    // (a) red when a kind is added, dropped or renamed without the const, or it is not exported;
    //     (b) prints the const.
    expect(F7.STOP_KINDS).toEqual([
      'taken',
      'ran_elsewhere',
      'run_ended',
      'claim_removed',
      'question_opened',
      'not_eligible',
      'capability',
      'failed',
      'refused',
    ]);
  });

  /** A record with nothing on it but what a row reads. */
  const rec = (over: Partial<RunRecord> = {}): Partial<RunRecord> => ({
    terminal_state: false,
    in_progress_steps: [],
    completed_steps: [],
    failed_steps: [],
    ...over,
  });
  const ENDED = { terminal_state: true } as const;
  const QUESTION = {
    pending_gate: { gate_id: 'g', step_name: 'q', choices: ['ok'] },
  } as unknown as Partial<RunRecord>;
  const blocked = (over: Partial<ResponseEnvelope> = {}): Partial<ResponseEnvelope> => ({
    status: 'blocked',
    stopped_step: 's',
    ...over,
  });
  const error = (code: string, over: Partial<ResponseEnvelope> = {}): Partial<ResponseEnvelope> =>
    ({
      status: 'error',
      error_code: code,
      stopped_step: 's',
      ...over,
    }) as Partial<ResponseEnvelope>;

  /** A refusal of a guard of the chain: it names no `stopped_step`, only the guard in `error_details`. */
  const guardError = (code: string): Partial<ResponseEnvelope> =>
    ({
      status: 'error',
      error_code: code,
      error_details: { step: 'g' },
    }) as Partial<ResponseEnvelope>;

  // One row of the table each (the row's number first): the reply, the step the loop picked or ran,
  // the re-read record, and what the classifier must name.
  const ROWS: [
    string,
    Partial<ResponseEnvelope>,
    string | undefined,
    Partial<RunRecord>,
    unknown,
  ][] = [
    [
      '1',
      blocked({ error_code: 'STATE_STEP_ALREADY_CLAIMED' }),
      's',
      rec(),
      { kind: 'taken', ran_here: false },
    ],
    [
      '2 (in flight)',
      blocked(),
      's',
      rec({ in_progress_steps: ['s'] }),
      { kind: 'taken', ran_here: false },
    ],
    [
      '2 (completed, the run ended — row 2 first)',
      blocked(),
      's',
      rec({ ...ENDED, completed_steps: ['s'] }),
      { kind: 'taken', ran_here: false },
    ],
    [
      '2 (failed)',
      blocked(),
      's',
      rec({ failed_steps: ['s'] }),
      { kind: 'taken', ran_here: false },
    ],
    ['2b', blocked(), 's', rec(ENDED), { kind: 'run_ended', ran_here: false }],
    ['2c', blocked(), 's', rec(QUESTION), { kind: 'question_opened', ran_here: false }],
    ['2d (a precondition block)', blocked(), 's', rec(), undefined],
    [
      '2 (another step’s blocked reply is not this one’s)',
      blocked({ stopped_step: 'u' }),
      's',
      rec(ENDED),
      undefined,
    ],
    [
      '3',
      error('STATE_CLAIM_LOST'),
      's',
      rec({ in_progress_steps: ['s'] }),
      { kind: 'taken', ran_here: true },
    ],
    [
      '3 (not on an ended run: row 5)',
      error('STATE_RUN_TERMINAL'),
      's',
      rec({ ...ENDED, in_progress_steps: ['s'] }),
      { kind: 'run_ended', ran_here: true },
    ],
    [
      '4',
      error('STATE_STEP_ALREADY_SETTLED'),
      's',
      rec({ completed_steps: ['s'] }),
      { kind: 'ran_elsewhere', ran_here: true },
    ],
    [
      '4 (before 5: settled, then the run ended)',
      error('STATE_STEP_ALREADY_SETTLED'),
      's',
      rec({ ...ENDED, failed_steps: ['s'] }),
      { kind: 'ran_elsewhere', ran_here: true },
    ],
    ['5', error('STATE_RUN_TERMINAL'), 's', rec(ENDED), { kind: 'run_ended', ran_here: true }],
    ['6', error('STATE_CLAIM_LOST'), 's', rec(), { kind: 'claim_removed', ran_here: true }],
    [
      '7',
      error('STATE_STEP_NOT_ELIGIBLE'),
      's',
      rec(ENDED),
      { kind: 'run_ended', ran_here: false },
    ],
    [
      '8',
      error('STATE_STEP_NOT_ELIGIBLE'),
      's',
      rec(QUESTION),
      { kind: 'question_opened', ran_here: false },
    ],
    ['9', error('STATE_STEP_NOT_ELIGIBLE'), 's', rec(), { kind: 'not_eligible', ran_here: false }],
    ['10 (handler)', error('ENGINE_HANDLER_NOT_REGISTERED'), 's', rec(), { kind: 'capability' }],
    ['10 (adapter)', error('ENGINE_ADAPTER_NOT_REGISTERED'), 's', rec(), { kind: 'capability' }],
    ['11', error('ENGINE_HANDLER_FAILED'), 's', rec({ failed_steps: ['s'] }), { kind: 'failed' }],
    [
      '11 (a guard named in error_details)',
      guardError('STATE_STEP_ALREADY_SETTLED'),
      's',
      rec({ failed_steps: ['g'] }),
      { kind: 'failed' },
    ],
    [
      '12 (a guard of the chain: the race codes name no stopped_step)',
      guardError('STATE_STEP_ALREADY_SETTLED'),
      's',
      rec({ completed_steps: ['g'] }),
      { kind: 'refused' },
    ],
    ['12', error('ENGINE_HANDLER_FAILED'), 's', rec(), { kind: 'refused' }],
    ['none: ok', { status: 'ok' }, 's', rec(ENDED), undefined],
    ['none: a question', { status: 'confirm_required' }, 's', rec(QUESTION), undefined],
  ];

  it.each(ROWS)('row %s', (_row, reply, step, record, expected) => {
    // (a) red when a row is missing, read out of order, or names another kind or `ran_here`;
    //     (b) prints what the classifier named.
    expect(classify(reply, step, record)).toEqual(expected);
  });
});

/** `s` (auto, handler `h`) then `u` (auto, after `s`) and `x` (a question, after `s`). */
const DEF: WorkflowDefinition = {
  id: 'f7-race',
  name: 'f7-race',
  version: 1,
  steps: {
    s: { description: 'S', execution: 'auto', handler: 'h' },
    u: { description: 'U', execution: 'auto', depends_on: ['s'] },
    x: {
      description: 'X',
      execution: 'auto',
      depends_on: ['s'],
      trust: 'human_confirmed',
      gate: { choices: ['yes', 'no'] },
    } as StepDefinition,
  },
};
/**
 * Row 2d's workflow: `p` (agent, answered first), then `s` with a precondition on `p`'s answer that
 * the record meets — and that `s`'s own read does not, when the fixture changes that read.
 */
const DEF_PRE: WorkflowDefinition = {
  id: 'f7-race-pre',
  name: 'f7-race-pre',
  version: 1,
  steps: {
    p: { description: 'P', execution: 'agent' },
    s: {
      description: 'S',
      execution: 'auto',
      handler: 'h',
      depends_on: ['p'],
      preconditions: ['p.go == true'],
    },
  },
};
/** The same as DEF, but `x` has no dependency (another program can open its question at any time). */
const DEF_X_FREE: WorkflowDefinition = {
  ...DEF,
  id: 'f7-race-x',
  steps: { ...DEF.steps, x: { ...DEF.steps['x']!, depends_on: [] } as StepDefinition },
};

describe('#625 PR-2a, F7 — advanceRun meets each row as a real race and goes on', () => {
  let dir: string;
  let store: JsonFileStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-f7-race-'));
    store = new JsonFileStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  type Moment = 'read' | 'claim' | 'handler';
  /** What the other program does: `def` is the workflow the run uses. */
  type Act = (runId: string, def: WorkflowDefinition) => Promise<void>;

  /** The other program runs every step it can, to the run's end or its question. */
  const otherRunsIt: Act = async (runId, def) => {
    await advanceRun(store, def, { runId, registry: quick(), driver: RACER });
  };
  const otherAbandons: Act = async (runId) => {
    await abandonRun(store, runId, 'another program');
  };
  /** The other program opens `x`'s question (`x` with no dependency). */
  const otherOpensX: Act = async (runId, def) => {
    const r = await executeStep(store, def, {
      runId,
      command: 'x',
      input: {},
      dispatcher: async () => ({}),
      driver: RACER,
    });
    expect(r.status, 'fixture: the other program opened x').toBe('confirm_required');
  };

  /** A registry whose `h` returns at once. */
  function quick(): ExtensionRegistry {
    const r = new ExtensionRegistry();
    r.register('handler', 'h', { id: 'h', execute: async () => ({ data: { by: 'other' } }) });
    return r;
  }

  /**
   * One `advanceRun` of a fresh run of `def` (its agent step `p`, when it has one, answered first),
   * with the other program's act
   * at `moment`: `read` — after the loop picked `s`, before `s`'s own read; `claim` — at `s`'s claim;
   * `handler` — while this call's handler for `s` runs (once). `claimFake` makes the first claim of
   * `s` throw `STATE_STEP_NOT_ELIGIBLE` with nothing changed (a refusal the record shows no reason
   * for). Returns the reply, the callbacks' calls, the record after, and the handler's runs here.
   */
  async function race(
    def: WorkflowDefinition,
    moment: Moment,
    act: Act | 'claimFake',
    opts: { handler?: 'missing'; tamperRead?: boolean } = {},
  ) {
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    if (def.steps['p'] !== undefined) {
      await executeStep(store, def, {
        runId: run.id,
        command: 'p',
        input: { go: true },
        dispatcher: async (_n, input) => ({ ...input }),
      });
    }
    let armed = false;
    let fired = false;
    const fire = async () => {
      if (fired) return;
      fired = true;
      if (act !== 'claimFake') await act(run.id, def);
    };
    let readHook = false;
    const racing = new Proxy(store, {
      get(target, prop) {
        if (prop === 'get' && moment === 'read') {
          return async (id: string) => {
            if (armed) {
              armed = false;
              if (opts.tamperRead === true) {
                // row 2d: the step's own read sees a precondition that fails (`p`'s answer changed
                // for that read only) — the view the loop picked it from did not.
                readHook = true;
                const real = await target.get(id);
                return {
                  ...real,
                  evidence: real.evidence.map((e) =>
                    e.step_id === 'p' ? { ...e, output_summary: { go: false } } : e,
                  ),
                };
              }
              await fire();
            }
            return target.get(id);
          };
        }
        if (prop === 'claimStep' && moment === 'claim') {
          return async (...a: Parameters<JsonFileStore['claimStep']>) => {
            if (a[1] === 's' && !fired) {
              if (act === 'claimFake') {
                fired = true;
                throw new WorkflowError(
                  `Step 's' is not eligible for execution on run '${a[0]}'.`,
                  {
                    code: 'STATE_STEP_NOT_ELIGIBLE',
                    category: 'STATE',
                    agentAction: 'resolve_precondition',
                    retryable: false,
                  },
                );
              }
              await fire();
            }
            return target.claimStep(...a);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    let handlerRuns = 0;
    const registry = new ExtensionRegistry();
    if (opts.handler !== 'missing') {
      registry.register('handler', 'h', {
        id: 'h',
        execute: async () => {
          handlerRuns += 1;
          if (moment === 'handler' && handlerRuns === 1) await fire();
          return { data: { by: 'here' } };
        },
      });
    }
    const taken: string[] = [];
    const notRecorded: string[] = [];
    const reply = await advanceRun(racing, def, {
      runId: run.id,
      caller: 'advance_run',
      registry,
      onStep: (step) => {
        if (step === 's' && moment === 'read') armed = true;
      },
      onTaken: (step) => taken.push(step),
      ...({
        onNotRecorded: (step: string, kind: string) => notRecorded.push(`${step}:${kind}`),
      } as object),
    });
    const after = await store.get(run.id);
    return { reply, taken, notRecorded, after, handlerRuns, readHook, runId: run.id };
  }

  /** The reply's fields the record decides, and the record's. */
  const view = (r: Awaited<ReturnType<typeof race>>) => ({
    status: r.reply.status,
    agent_action: r.reply.agent_action,
    run_phase: r.reply.run_phase,
    fresh: r.reply.run_version === r.after.version,
    next: r.reply.next_actions.map((a) => a.instruction?.tool ?? null),
    chained: (r.reply.chained_auto_steps ?? []).map((c) => c.step),
    taken: r.taken,
    notRecorded: r.notRecorded,
  });
  const hintOf = (r: Awaited<ReturnType<typeof race>>) =>
    r.reply.context_hint.split(r.runId).join('<run>');

  it('row 1 (G7-01): another program ran the picked step to the run’s end before this call’s claim — taken; the reply describes the completed run', async () => {
    const r = await race(DEF, 'claim', otherRunsIt);
    // (a) red when the reply keeps the version, phase or next actions the call first read (G7-01),
    //     or the step is not said as taken; (b) prints the reply's fields and the hint.
    expect({ ...view(r), hint: hintOf(r) }).toEqual({
      status: 'ok',
      agent_action: undefined,
      run_phase: 'gate_waiting',
      fresh: true,
      next: ['submit_human_response'],
      chained: [],
      taken: ['s'],
      notRecorded: [],
      hint: "Run '<run>': nothing ran. Waiting on the question on step 'x' (choices: yes, no) — answer it with submit_human_response. 's' was claimed by another process, so it did not run here.",
    });
  });

  it('row 2 (G7-01, r1): the same race before the step’s own read — taken; the reply describes the run as the call ends', async () => {
    const r = await race(DEF, 'read', otherRunsIt);
    // (a) red when the reply keeps the version, phase or next actions the call first read;
    //     (b) prints the reply's fields.
    expect(view(r)).toEqual({
      status: 'ok',
      agent_action: undefined,
      run_phase: 'gate_waiting',
      fresh: true,
      next: ['submit_human_response'],
      chained: [],
      taken: ['s'],
      notRecorded: [],
    });
  });

  it('row 2b (G7-04’s r2 abandon): another program ended the run before the step’s read — run_ended, ok and stop, never taken', async () => {
    const r = await race(DEF, 'read', otherAbandons);
    // (a) red when the reply is the step's `blocked` refusal, the step is said as taken, or the run's
    //     ending carries no `stop`; (b) prints the reply's fields and the hint.
    expect({ ...view(r), hint: hintOf(r) }).toEqual({
      status: 'ok',
      agent_action: 'stop',
      run_phase: 'abandoned',
      fresh: true,
      next: [],
      chained: [],
      taken: [],
      notRecorded: [],
      hint: "Run '<run>' is already terminal (abandoned); nothing ran.",
    });
  });

  it('row 2c: another program opened a question before the step’s read — question_opened; the reply holds the answer, never a blocked refusal', async () => {
    const r = await race(DEF_X_FREE, 'read', otherOpensX);
    // (a) red when the reply is the step's `blocked` refusal or keeps what the call first read;
    //     (b) prints the reply's fields.
    expect(view(r)).toEqual({
      status: 'ok',
      agent_action: undefined,
      run_phase: 'gate_waiting',
      fresh: true,
      next: ['submit_human_response'],
      chained: [],
      taken: [],
      notRecorded: [],
    });
  });

  it('row 2d: a precondition the step’s own read refuses (preservation) — the blocked reply, as before', async () => {
    const r = await race(DEF_PRE, 'read', otherRunsIt, { tamperRead: true });
    // (a) red when a precondition block is read as a race (taken, or the loop goes on); (b) prints
    //     the reply's fields.
    expect({
      readHook: r.readHook,
      status: r.reply.status,
      stopped_step: r.reply.stopped_step,
      taken: r.taken,
      notRecorded: r.notRecorded,
      handlerRuns: r.handlerRuns,
    }).toEqual({
      readHook: true,
      status: 'blocked',
      stopped_step: 's',
      taken: [],
      notRecorded: [],
      handlerRuns: 0,
    });
  });

  it.each([
    [
      '3: another program takes it over (reclaim --force, then holds it)',
      async (runId: string) => {
        await reclaimStep(store, runId, 's');
        await store.claimStep(runId, 's', DEF, RACER);
      },
      'taken',
      'running',
      undefined,
      'ok',
      " 's' ran here, but another process took it over, so its outcome was not recorded.",
      [],
    ],
    [
      '4: another program runs it (reclaim --force, then runs it and the rest)',
      async (runId: string) => {
        await reclaimStep(store, runId, 's');
        await advanceRun(store, DEF, { runId, registry: quick(), driver: RACER });
      },
      'ran_elsewhere',
      'gate_waiting',
      undefined,
      'ok',
      " 's' ran here, but another process settled it first, so its outcome was not recorded.",
      [],
    ],
    [
      '5: another program ends the run',
      async (runId: string) => {
        await abandonRun(store, runId, 'another program');
      },
      'run_ended',
      'abandoned',
      'stop',
      'ok',
      " 's' ran here, but the run ended before its outcome was recorded.",
      [],
    ],
    [
      '6: another program removes its claim (reclaim --force) and nobody runs it — owed again, run again, then the rest',
      async (runId: string) => {
        await reclaimStep(store, runId, 's');
      },
      'claim_removed',
      'gate_waiting',
      undefined,
      // this call goes on past the race and opens `x`'s question itself: the question's reply
      'confirm_required',
      " 's' ran here, but another process removed its claim, so its outcome was not recorded.",
      ['s', 'u'],
    ],
  ] as const)(
    'row %s — the race named, the step’s outcome not recorded, the loop goes on; ran_here',
    async (_row, act, kind, phase, action, status, clause, chained) => {
      const r = await race(DEF, 'handler', act);
      // (a) red when the refused settle is returned as an error reply, the kind is not the row's,
      //     the reply keeps what the call first read, or the hint says nothing ran; (b) prints them.
      expect({
        status: r.reply.status,
        agent_action: r.reply.agent_action,
        run_phase: r.reply.run_phase,
        fresh: r.reply.run_version === r.after.version,
        notRecorded: r.notRecorded,
        chained: (r.reply.chained_auto_steps ?? []).map((c) => c.step),
        clause: r.reply.context_hint.endsWith(clause),
        nothingRan: r.reply.context_hint.includes('nothing ran'),
      }).toEqual({
        status,
        agent_action: action,
        run_phase: phase,
        fresh: true,
        notRecorded: [`s:${kind}`],
        chained,
        clause: true,
        nothingRan: false,
      });
    },
  );

  it('row 7 (F-R7, r3 abandon): another program ends the run at the step’s claim — run_ended, ok and stop; never STATE_STEP_NOT_ELIGIBLE with resolve_precondition and nothing to do', async () => {
    const r = await race(DEF, 'claim', otherAbandons);
    // (a) red when the claim's refusal is returned as an error (F-R7) or the run's ending carries no
    //     `stop`; (b) prints the reply's fields.
    expect({ ...view(r), error_code: r.reply.error_code }).toEqual({
      status: 'ok',
      agent_action: 'stop',
      run_phase: 'abandoned',
      fresh: true,
      next: [],
      chained: [],
      taken: [],
      notRecorded: [],
      error_code: undefined,
    });
  });

  it('row 8 (G5-9): another program opens a question at the step’s claim — question_opened; the reply holds the answer, never an error naming a step that did not fail', async () => {
    const r = await race(DEF_X_FREE, 'claim', otherOpensX);
    // (a) red when the claim's refusal is returned as an error; (b) prints the reply's fields.
    expect({ ...view(r), error_code: r.reply.error_code, stopped: r.reply.stopped_step }).toEqual({
      status: 'ok',
      agent_action: undefined,
      run_phase: 'gate_waiting',
      fresh: true,
      next: ['submit_human_response'],
      chained: [],
      taken: [],
      notRecorded: [],
      error_code: undefined,
      stopped: undefined,
    });
  });

  it('row 9: the claim’s re-check refuses with nothing on the record to say why — not_eligible; the loop goes on and runs it (then opens `x`’s question)', async () => {
    const r = await race(DEF, 'claim', 'claimFake');
    // (a) red when the refusal is returned as an error, or the step left owed is not run again in
    //     the call; (b) prints the reply's fields.
    expect({ ...view(r), handlerRuns: r.handlerRuns }).toEqual({
      status: 'confirm_required',
      agent_action: undefined,
      run_phase: 'gate_waiting',
      fresh: true,
      next: ['submit_human_response'],
      chained: ['s', 'u'],
      taken: [],
      notRecorded: [],
      handlerRuns: 1,
    });
  });

  it('row 10: a handler this program lacks (preservation) — the capability refusal, returned as before', async () => {
    // Nobody else acts: this program alone, without the handler.
    const r = await race(DEF, 'claim', async () => {}, { handler: 'missing' });
    // (a) red when a capability refusal is read as a race; (b) prints the reply's fields.
    expect({
      status: r.reply.status,
      error_code: r.reply.error_code,
      stopped_step: r.reply.stopped_step,
      taken: r.taken,
    }).toEqual({
      status: 'error',
      error_code: 'ENGINE_HANDLER_NOT_REGISTERED',
      stopped_step: 's',
      taken: [],
    });
  });

  it('a store that refuses every claim of the step cannot loop the call: the step left owed is tried once more, then the reply names it owed', async () => {
    const { run } = await store.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
    let claims = 0;
    const refusing = new Proxy(store, {
      get(target, prop) {
        if (prop === 'claimStep') {
          return async (...a: Parameters<JsonFileStore['claimStep']>) => {
            claims += 1;
            throw new WorkflowError(
              `Step '${a[1]}' is not eligible for execution on run '${a[0]}'.`,
              {
                code: 'STATE_STEP_NOT_ELIGIBLE',
                category: 'STATE',
                agentAction: 'resolve_precondition',
                retryable: false,
              },
            );
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    const reply = await advanceRun(refusing, DEF, { runId: run.id, registry: quick() });
    // (a) red when the loop retries the step without bound, or returns the refusal as an error;
    //     (b) prints the claims and the reply.
    expect({
      claims,
      status: reply.status,
      next: reply.next_actions.map((a) => a.instruction?.tool),
    }).toEqual({
      claims: 4,
      status: 'ok',
      next: ['advance_run'],
    });
  });
});

describe('#625 PR-2a, F7 — execute_step’s chain (executeChain) composes its reply from the record after a race', () => {
  let dir: string;
  let store: JsonFileStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-f7-chain-'));
    store = new JsonFileStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('another program runs the chained step to the run’s end before its read: the reply is the completed run’s, the named step said completed', async () => {
    const def: WorkflowDefinition = {
      id: 'f7-chain',
      name: 'f7-chain',
      version: 1,
      steps: {
        a: { description: 'A', execution: 'agent' },
        s: { description: 'S', execution: 'auto', depends_on: ['a'] },
      },
    };
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    let settledA = false;
    let getsAfter = 0;
    const racing = new Proxy(store, {
      get(target, prop) {
        if (prop === 'settleStep') {
          return async (...a: Parameters<NonNullable<JsonFileStore['settleStep']>>) => {
            const res = await target.settleStep!(...a);
            if (a[1].kind === 'settle_step' && a[1].step === 'a') settledA = true;
            return res;
          };
        }
        if (prop === 'get') {
          return async (id: string) => {
            if (settledA && ++getsAfter === 2) {
              // `s`'s own read: another program runs it, and the run completes.
              await advanceRun(store, def, { runId: id, driver: RACER });
            }
            return target.get(id);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    const reply = await executeChain(racing, def, {
      runId: run.id,
      command: 'a',
      input: { ok: true },
      dispatcher: async (_n, input) => ({ ...input }),
      caller: 'execute_step',
    });
    const after = await store.get(run.id);
    // (a) red when the chain returns the named step's reply as the call first composed it (phase
    //     `running`, `advance_run` offered) after the race; (b) prints the reply's fields.
    expect({
      status: reply.status,
      run_phase: reply.run_phase,
      fresh: reply.run_version === after.version,
      next: reply.next_actions.length,
      hint: reply.context_hint,
      recorded: after.run_phase,
    }).toEqual({
      status: 'ok',
      run_phase: 'completed',
      fresh: true,
      next: 0,
      hint: "Step 'a' completed. The run ended (completed). 's' was claimed by another process, so it did not run here.",
      recorded: 'completed',
    });
  });
});
