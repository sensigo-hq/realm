// docs-pages-625-core-library.test.ts — issue #625 PR-2a, decision C174 (round 22), lane F: the
// sentences and table rows of `docs/reference/core-library.md` that #625 PR-2a adds or changes and
// that no cell quoted yet. Each cell quotes its sentence (or its table row, whole or from its start)
// word for word, asserts the page still holds it (read from the repository, whitespace folded), then
// drives the case through the library and asserts what it states — so neither the page nor the
// behaviour can change alone.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  advanceRun,
  executeChain,
  executeEngineStep,
  executeStep,
  submitHumanResponse,
} from './execution-loop.js';
import { describePending } from './pending.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { RunStore } from '../store/store-interface.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PAGE = 'docs/reference/core-library.md';
const flat = (t: string) => t.replace(/\s+/g, ' ');

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** `q` (a question, 60 s, `settle_default` → approve), then `after` (a bare `auto` step). */
const GATED: WorkflowDefinition = {
  id: 'dp-gated',
  name: 'docs pages',
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
        on_expiry: 'settle_default',
        default_choice: 'approve',
      },
    },
    after: { description: 'After.', execution: 'auto', depends_on: ['q'] },
  },
};

/** The same question, then `a` (auto), guard `check` after it, then `b` (auto). */
const GUARDED: WorkflowDefinition = {
  ...GATED,
  id: 'dp-guarded',
  steps: {
    q: GATED.steps['q']!,
    a: { description: 'A.', execution: 'auto', depends_on: ['q'] },
    check: {
      description: 'Go on only when approved.',
      execution: 'guard',
      depends_on: ['a'],
      abort_unless: ["q.choice == 'approve'"],
      abort_message: 'Not approved.',
    },
    b: { description: 'B.', execution: 'auto', depends_on: ['check'] },
  },
};

/** One bare `auto` step. */
const PLAIN: WorkflowDefinition = {
  id: 'dp-plain',
  name: 'plain',
  version: 1,
  steps: { only: { description: 'Only.', execution: 'auto', depends_on: [] } },
};

const dispatcher = async () => ({});
const LATER = () => new Date(Date.now() + 120_000);
const EARLIER = () => new Date(Date.now() - 120_000);
const line = (gateId: string, fn: string) =>
  `gate '${gateId}' on 'q' had expired 1m before this call — this ${fn} call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: ${fn}).`;

/** The store, with a count of every method called on it (reads and writes alike). */
function counted(store: RunStore): { store: RunStore; calls: string[] } {
  const calls: string[] = [];
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store: proxy, calls };
}

describe('#625 PR-2a, C174 lane F — core-library.md rows no cell quoted yet, through the library', () => {
  let store: JsonFileStore;
  beforeEach(async () => {
    store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-dp-625-')));
  });

  async function atQuestion(d: WorkflowDefinition = GATED) {
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    const opened = await executeStep(store, d, {
      runId: run.id,
      command: 'q',
      input: {},
      dispatcher,
    });
    if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
    return { runId: run.id, gateId: (await store.get(run.id)).pending_gate!.gate_id };
  }

  it('line 102, the advanceRun row: advanceRun(store, definition, options) carries out the expired question first, then the guard and the auto step that are ready', async () => {
    claim(
      PAGE,
      "| `advanceRun(store, definition, options)` | Runs what a run owes the engine and returns the reply: first an expired question's declared `on_expiry`, when its time is up, then the guards and `auto` steps that are ready.",
    );
    const { runId, gateId } = await atQuestion(GUARDED);
    const order: string[] = [];
    const r = await advanceRun(store, GUARDED, {
      runId,
      now: LATER(),
      onExpiry: () => void order.push('expiry'),
      onStep: (step) => void order.push(step),
    });
    // (a) red when the expiry is not carried out first, or the auto steps and the guard that are
    //     then ready are not run; (b) prints the reply's parts.
    //     (`onStep` is called for each `auto` step; the guard is listed in `chained_auto_steps`.)
    expect([
      r.status,
      r.warnings[0],
      order,
      (r.chained_auto_steps ?? []).map((c) => c.step),
      r.run_phase,
    ]).toEqual([
      'ok',
      line(gateId, 'advanceRun'),
      ['expiry', 'a', 'b'],
      ['a', 'check', 'b'],
      'completed',
    ]);
    // (a) red when the question is not settled by its expiry; (b) prints the step's record.
    expect((await store.get(runId)).settled?.['q']).toEqual(
      expect.objectContaining({ choice: 'approve', resolved_by: 'timeout' }),
    );
  });

  it("line 102: advanceRun's caller is one of five words — each is the call the expiry line names and the reply's command; another throws", async () => {
    claim(
      PAGE,
      "`caller` is one of five words: `advanceRun` (the default, a program's own call), `advance_run`, `advance`, `start_run` or `agent`.",
    );
    for (const caller of [undefined, 'advance_run', 'advance', 'start_run', 'agent'] as const) {
      const { runId, gateId } = await atQuestion();
      const r = await advanceRun(store, GATED, {
        runId,
        now: LATER(),
        ...(caller !== undefined ? { caller } : {}),
      });
      const named = caller ?? 'advanceRun';
      // (a) red when a word is refused, or the line or the reply names another call; (b) prints them.
      expect([r.command, r.warnings[0]], named).toEqual([named, line(gateId, named)]);
    }
    const { runId } = await atQuestion();
    const before = JSON.stringify(await store.get(runId));
    // (a) red when a sixth word is taken; (b) prints the throw.
    await expect(
      advanceRun(store, GATED, { runId, now: LATER(), caller: 'nightly' as never }),
    ).rejects.toMatchObject({ code: 'VALIDATION_CALLER_INVALID' });
    expect(JSON.stringify(await store.get(runId))).toBe(before);
  });

  it('line 103, the describePending row: describePending(definition, run, registry, now) returns an object with every field the row names', async () => {
    claim(
      PAGE,
      "| `describePending(definition, run, registry, now)` | Says what a run is waiting for, as an object with: `agent_steps` (the agent steps ready for an answer) and `agent_actions` (the call for each), `agent_refused` (the ready agent steps the run refuses before their claim, and why), `pending_guards` (the guard steps ready to be decided), `engine_runnable` (the `auto` steps it owes, each with `runnable_here`), `cannot_run` (every step that cannot run, and why), `expiry_due` (the open question whose time is up at `now` and whose `on_expiry` the engine carries out — it can no longer be answered), `open_question` (whenever the run waits on a question: its `step`, `gate_id` and `choices`) and `act` (the call to make next: `advance_run`, when the engine owes work that can run with the given registry — with no registry, any owed step counts — or an expired question's `on_expiry`).",
    );
    const { runId, gateId } = await atQuestion();
    const run = await store.get(runId);
    const due = describePending(GATED, run, undefined, LATER());
    // (a) red when a field the row names is dropped, or the expired question is not named as due
    //     and as the act; (b) prints the object.
    expect(Object.keys(due).sort()).toEqual(
      [
        'act',
        'agent_actions',
        'agent_refused',
        'agent_steps',
        'cannot_run',
        'engine_runnable',
        'expiry_due',
        'open_question',
        'pending_guards',
      ].sort(),
    );
    expect([due.open_question, due.act?.instruction?.tool]).toEqual([
      { step: 'q', gate_id: gateId, choices: ['approve', 'reject'] },
      'advance_run',
    ]);
    // Not yet due at the current time: no act, no expiry_due.
    const open = describePending(GATED, run, undefined, new Date());
    expect([open.expiry_due, open.act]).toEqual([undefined, undefined]);
    // An agent step ready, and an auto step owed beside it.
    const both: WorkflowDefinition = {
      id: 'dp-both',
      name: 'both',
      version: 1,
      steps: {
        x: { description: 'X.', execution: 'agent', depends_on: [] },
        y: { description: 'Y.', execution: 'auto', depends_on: [] },
      },
    };
    const { run: fresh } = await store.create({
      workflowId: both.id,
      workflowVersion: 1,
      params: {},
    });
    const p = describePending(both, fresh, undefined, new Date());
    // (a) red when the agent step, its call, or the owed auto step is not named; (b) prints them.
    expect([
      p.agent_steps,
      p.agent_actions.map((a) => a.instruction?.tool),
      p.engine_runnable.map((e) => e.step),
      typeof p.engine_runnable[0]?.runnable_here,
      p.act?.instruction?.tool,
    ]).toEqual([['x'], ['execute_step'], ['y'], 'boolean', 'advance_run']);
  });

  it('line 104, the executeEngineStep row and its options: runId, step and run; caller executeEngineStep (the default) or agent; another throws naming executeEngineStep before anything is read or written', async () => {
    claim(
      PAGE,
      '| `executeEngineStep(store, definition, options)` | Runs one `auto` step the way the engine runs it.',
    );
    claim(
      PAGE,
      "`options` holds `runId`, `step` and `run` (the run's record), and optionally `caller`: `executeEngineStep` (the default) or `agent`; any other value throws a `WorkflowError` with the code `VALIDATION_CALLER_INVALID`, naming `executeEngineStep`, before anything is read or written.",
    );
    const { run } = await store.create({ workflowId: PLAIN.id, workflowVersion: 1, params: {} });
    const done = await executeEngineStep(store, PLAIN, {
      runId: run.id,
      step: 'only',
      run: await store.get(run.id),
    });
    // (a) red when runId, step and run are not enough to run the step; (b) prints the reply.
    expect([done.status, (await store.get(run.id)).completed_steps]).toEqual(['ok', ['only']]);
    for (const caller of [undefined, 'agent'] as const) {
      const { runId, gateId } = await atQuestion();
      const r = await executeEngineStep(store, GATED, {
        runId,
        step: 'after',
        run: await store.get(runId),
        now: LATER(),
        ...(caller !== undefined ? { caller } : {}),
      });
      // (a) red when the default is not executeEngineStep, or agent is refused; (b) prints the line.
      expect(r.warnings).toContain(line(gateId, caller ?? 'executeEngineStep'));
    }
    const { runId } = await atQuestion();
    const record = await store.get(runId);
    const before = JSON.stringify(record);
    const watched = counted(store);
    const thrown = await executeEngineStep(watched.store, GATED, {
      runId,
      step: 'after',
      run: record,
      now: LATER(),
      caller: 'executeChain' as never,
    }).catch((e: unknown) => e);
    // (a) red when another word is taken, the throw names another function, or the store is
    //     touched first; (b) prints the throw and the store calls.
    expect(thrown).toMatchObject({
      code: 'VALIDATION_CALLER_INVALID',
      message: expect.stringMatching(
        /^executeEngineStep's caller is one of executeEngineStep, agent;/,
      ),
    });
    expect(watched.calls).toEqual([]);
    expect(JSON.stringify(await store.get(runId))).toBe(before);
  });

  it('line 119, the now row: executeStep and executeChain judge the question by now — the current time by default', async () => {
    claim(
      PAGE,
      "| `now` | No | A `Date`, the time the call judges an open question's expiry by (default: the current time): the call carries out an expired question's declared `on_expiry` first only when the question's time is up at `now`. |",
    );
    for (const fn of ['executeStep', 'executeChain'] as const) {
      const call = (runId: string, now?: Date) => {
        const o = { runId, command: 'after', input: {}, dispatcher, ...(now ? { now } : {}) };
        return fn === 'executeStep' ? executeStep(store, GATED, o) : executeChain(store, GATED, o);
      };
      const byDefault = await atQuestion();
      const r0 = await call(byDefault.runId);
      const early = await atQuestion();
      const r1 = await call(early.runId, EARLIER());
      const late = await atQuestion();
      const r2 = await call(late.runId, LATER());
      // (a) red when the call judges by something other than `now` (the clock by default), or
      //     carries out a question whose time is not up; (b) prints the three replies.
      expect(
        [r0, r1, r2].map((r) => [r.status, r.warnings.some((w) => w.includes('had expired'))]),
        fn,
      ).toEqual([
        ['blocked', false],
        ['blocked', false],
        ['ok', true],
      ]);
      expect((await store.get(byDefault.runId)).pending_gate?.gate_id).toBe(byDefault.gateId);
    }
  });

  it('lines 120: the caller row — executeStep takes executeStep or agent, executeChain takes executeChain, execute_step, agent or run; each is the call the line names; another throws before anything is read or written', async () => {
    claim(
      PAGE,
      '| `caller` | No | The call the expiry line names when this call carries out an expired question first. `executeStep` takes `executeStep` (the default) or `agent`; `executeChain` takes `executeChain` (the default), `execute_step`, `agent` or `run`. Any other value throws a `WorkflowError` with the code `VALIDATION_CALLER_INVALID` before anything is read or written. Added after version 0.46.0. |',
    );
    claim(
      PAGE,
      '`executeStep` takes `executeStep` (the default) or `agent`; `executeChain` takes `executeChain` (the default), `execute_step`, `agent` or `run`.',
    );
    const words = {
      executeStep: [undefined, 'agent'],
      executeChain: [undefined, 'execute_step', 'agent', 'run'],
    } as const;
    for (const fn of ['executeStep', 'executeChain'] as const) {
      const call = (s: RunStore, runId: string, caller?: string) => {
        const o = {
          runId,
          command: 'after',
          input: {},
          dispatcher,
          now: LATER(),
          ...(caller !== undefined ? { caller: caller as never } : {}),
        };
        return fn === 'executeStep' ? executeStep(s, GATED, o) : executeChain(s, GATED, o);
      };
      for (const w of words[fn]) {
        const { runId, gateId } = await atQuestion();
        const r = await call(store, runId, w);
        // (a) red when a listed word is refused, or the line names another call; (b) prints it.
        expect(r.warnings, `${fn} ${w ?? '(default)'}`).toContain(line(gateId, w ?? fn));
      }
      const { runId } = await atQuestion();
      const before = JSON.stringify(await store.get(runId));
      const watched = counted(store);
      const other = fn === 'executeStep' ? 'run' : 'advance';
      // (a) red when a word of the other list (or any other) is taken, or the store is touched
      //     first; (b) prints the throw and the store calls.
      await expect(call(watched.store, runId, other)).rejects.toMatchObject({
        code: 'VALIDATION_CALLER_INVALID',
      });
      expect(watched.calls).toEqual([]);
      expect(JSON.stringify(await store.get(runId))).toBe(before);
    }
  });

  it("line 124: submitHumanResponse's caller — submitHumanResponse (the default), submit_human_response, respond, run or agent is the call a late answer's expiry line names; another throws as above", async () => {
    claim(
      PAGE,
      "`caller` is the call the expiry line names when an answer that comes after the question's time is up carries out its expiry: `submitHumanResponse` (the default), `submit_human_response`, `respond`, `run` or `agent`; any other value throws as above (added after version 0.46.0).",
    );
    for (const w of [undefined, 'submit_human_response', 'respond', 'run', 'agent'] as const) {
      const { runId, gateId } = await atQuestion();
      const r = await submitHumanResponse(store, GATED, {
        runId,
        gateId,
        choice: 'reject',
        now: LATER(),
        ...(w !== undefined ? { caller: w } : {}),
      });
      // (a) red when a listed word is refused, or the line names another call; (b) prints it.
      expect(r.warnings, w ?? '(default)').toContain(line(gateId, w ?? 'submitHumanResponse'));
    }
    const { runId, gateId } = await atQuestion();
    const before = JSON.stringify(await store.get(runId));
    const watched = counted(store);
    // (a) red when another word is taken, or the store is touched first; (b) prints the throw.
    await expect(
      submitHumanResponse(watched.store, GATED, {
        runId,
        gateId,
        choice: 'approve',
        caller: 'executeStep' as never,
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_CALLER_INVALID',
      message: expect.stringMatching(
        /^submitHumanResponse's caller is one of submitHumanResponse, submit_human_response, respond, run, agent;/,
      ),
    });
    expect(watched.calls).toEqual([]);
    expect(JSON.stringify(await store.get(runId))).toBe(before);
  });

  it('lines 132–134, the driver rows: by 1–200 characters, not only spaces, no control character; by_source stated, ambient or derived; channel 1–64 of [a-z0-9_-] — taken and written as driven_by, or refused naming the field', async () => {
    claim(
      PAGE,
      '| `by` | The name: text of 1 to 200 characters, not only spaces, with no control character. |',
    );
    claim(
      PAGE,
      '| `by_source` | How the name is known: `stated` (your program says it), `ambient` (from the environment, as `REALM_OPERATOR` is) or `derived` (from the OS user). |',
    );
    claim(
      PAGE,
      '| `channel` | Your own word for the way the call came in: 1 to 64 characters of `a`–`z`, `0`–`9`, `_` and `-`, such as `cron`. |',
    );
    const taken = [
      { by: 'n', by_source: 'stated', channel: 'cron' },
      { by: 'n'.repeat(200), by_source: 'ambient', channel: 'a'.repeat(64) },
      { by: 'Ana B', by_source: 'derived', channel: 'z_0-9' },
    ] as const;
    for (const driver of taken) {
      const { run } = await store.create({ workflowId: PLAIN.id, workflowVersion: 1, params: {} });
      const r = await advanceRun(store, PLAIN, { runId: run.id, driver });
      const ev = (await store.get(run.id)).evidence.find(
        (e) => e.step_id === 'only',
      ) as unknown as { driven_by?: unknown };
      // (a) red when a value the rows take is refused, or not written as driven_by; (b) prints it.
      expect([r.status, ev?.driven_by]).toEqual(['ok', expect.objectContaining(driver)]);
    }
    const refused: Array<[Record<string, unknown>, string]> = [
      [{ by: '', by_source: 'stated', channel: 'cron' }, 'Invalid driver.by: empty.'],
      [{ by: '   ', by_source: 'stated', channel: 'cron' }, 'Invalid driver.by: empty.'],
      [
        { by: 'n'.repeat(201), by_source: 'stated', channel: 'cron' },
        'Invalid driver.by: longer than 200 characters.',
      ],
      [
        { by: 'a\tb', by_source: 'stated', channel: 'cron' },
        'Invalid driver.by: contains a control character.',
      ],
      [
        { by: 'n', by_source: 'typed', channel: 'cron' },
        'Invalid driver.by_source: not one of stated, ambient, derived.',
      ],
      [
        { by: 'n', by_source: 'stated', channel: '' },
        'Invalid driver.channel: not 1–64 characters of [a-z0-9_-].',
      ],
      [
        { by: 'n', by_source: 'stated', channel: 'a'.repeat(65) },
        'Invalid driver.channel: not 1–64 characters of [a-z0-9_-].',
      ],
      [
        { by: 'n', by_source: 'stated', channel: 'Cron' },
        'Invalid driver.channel: not 1–64 characters of [a-z0-9_-].',
      ],
      [
        { by: 'n', by_source: 'stated', channel: 'cron job' },
        'Invalid driver.channel: not 1–64 characters of [a-z0-9_-].',
      ],
    ];
    const { run } = await store.create({ workflowId: PLAIN.id, workflowVersion: 1, params: {} });
    for (const [driver, message] of refused) {
      // (a) red when a value outside the rows is taken, or the refusal names another field;
      //     (b) prints the throw.
      await expect(
        advanceRun(store, PLAIN, { runId: run.id, driver: driver as never }),
        JSON.stringify(driver),
      ).rejects.toMatchObject({ code: 'VALIDATION_ACTOR_INVALID', message });
    }
    expect((await store.get(run.id)).completed_steps).toEqual([]);
  });
});
