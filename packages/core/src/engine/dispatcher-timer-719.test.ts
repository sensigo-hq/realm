// dispatcher-timer-719.test.ts — issue #719 (A1): a host's dispatcher that throws synchronously,
// or returns a plain value, leaves no step timer running and no unhandled rejection; a plain value
// is the step's output. And the dispatcher branch serves exactly the steps `callsHostDispatcher`
// is true for.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { executeStep, type StepDispatcher } from './execution-loop.js';
import { callsHostDispatcher } from './output-source.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';

let dir: string;
let store: JsonFileStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'realm-719-timer-'));
  store = new JsonFileStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A bare `auto` step with a 2 s timer — the steps whose dispatcher call races a timer. */
const timed: WorkflowDefinition = {
  id: 'timer-719',
  name: 't',
  version: 1,
  steps: { work: { description: 'W.', execution: 'auto', timeout_seconds: 2 } },
} as unknown as WorkflowDefinition;

/**
 * issue #719 (C5): the step's OWN timer, pinned by its handle — the one `setTimeout` made with the
 * step's 2000 ms delay — never by a count of the process's timers (a worker timer that ends during
 * the call hid a leaked one: the count is shared with the worker). Both globals are spied around the
 * call only (the engine calls the global `setTimeout`, no `node:timers` import), and restored.
 */
async function callWith(dispatcher: StepDispatcher) {
  const { run } = await store.create({ workflowId: timed.id, workflowVersion: 1, params: {} });
  const set = vi.spyOn(globalThis, 'setTimeout');
  const clear = vi.spyOn(globalThis, 'clearTimeout');
  try {
    const reply = await executeStep(store, timed, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher,
    });
    // Read before the spies are restored: `mockRestore()` clears what they recorded.
    const handles = set.mock.calls.flatMap((args, i) =>
      args[1] === 2000 ? [set.mock.results[i]?.value as unknown] : [],
    );
    const cleared = handles.length === 1 && clear.mock.calls.some(([h]) => h === handles[0]);
    return { runId: run.id, oneStepTimer: handles.length === 1, cleared, reply };
  } finally {
    set.mockRestore();
    clear.mockRestore();
  }
}

describe('issue #719 A1 — a dispatcher call cannot escape its step timer', () => {
  it('(a) a dispatcher that throws synchronously: no timer outlives the reply; the reply is "Dispatcher failed: <message>"', async () => {
    const thrower = (() => {
      throw new Error('boom');
    }) as unknown as StepDispatcher;
    const { oneStepTimer, cleared, reply } = await callWith(thrower);
    // (a) red when the step's timer is left running (not cleared, and its STEP_TIMEOUT rejects
    //     unhandled 2 s later), or the reply changes; (b) prints two booleans and the reply's
    //     status, code and first error only.
    expect({
      oneStepTimer,
      cleared,
      status: reply.status,
      error_code: reply.error_code,
      error: reply.errors[0],
    }).toEqual({
      oneStepTimer: true,
      cleared: true,
      status: 'error',
      error_code: 'ENGINE_INTERNAL',
      error: 'Dispatcher failed: boom',
    });
  });

  it('(b) a dispatcher that returns a plain object: no timer outlives the reply; the object is the step output', async () => {
    const plain = (() => ({ answer: 42 })) as unknown as StepDispatcher;
    const { runId, oneStepTimer, cleared, reply } = await callWith(plain);
    const entry = (await store.get(runId)).evidence.find((e) => e.step_id === 'work');
    // (a) red when the step's timer is left running, or the call fails `.then is not a function`;
    //     (b) prints two booleans, the reply's status, code and first error, and the recorded
    //     output.
    expect({
      oneStepTimer,
      cleared,
      status: reply.status,
      error_code: reply.error_code,
      error: reply.errors[0],
      output: entry?.output_summary,
    }).toEqual({
      oneStepTimer: true,
      cleared: true,
      status: 'ok',
      error_code: undefined,
      error: undefined,
      output: { answer: 42 },
    });
  });

  it('(c) guard: a dispatcher that returns a rejecting promise behaves as today', async () => {
    const rejecting: StepDispatcher = async () => {
      throw new Error('nope');
    };
    const { oneStepTimer, cleared, reply } = await callWith(rejecting);
    // (b) prints two booleans and the reply's status and first error only.
    expect({ oneStepTimer, cleared, status: reply.status, error: reply.errors[0] }).toEqual({
      oneStepTimer: true,
      cleared: true,
      status: 'error',
      error: 'Dispatcher failed: nope',
    });
  });
});

describe('issue #719 A1.2 — the dispatcher branch and callsHostDispatcher agree for every step kind', () => {
  const KINDS: Array<[string, StepDefinition]> = [
    ['agent', { description: 'd', execution: 'agent' } as StepDefinition],
    ['bare auto', { description: 'd', execution: 'auto' } as StepDefinition],
    ['auto + handler', { description: 'd', execution: 'auto', handler: 'h' } as StepDefinition],
    [
      'auto + uses_service',
      {
        description: 'd',
        execution: 'auto',
        uses_service: 'svc',
        operation: 'op',
      } as StepDefinition,
    ],
    ['execution absent', { description: 'd' } as StepDefinition],
    ['execution: bogus', { description: 'd', execution: 'bogus' } as unknown as StepDefinition],
    // issue #719 (C5): the predicate's guard/finalizer clause — the engine settles those steps
    // itself, so neither the predicate nor the branch serves them.
    ['guard', { description: 'd', execution: 'guard', check: 'true' } as unknown as StepDefinition],
    ['finalizer', { description: 'd', execution: 'finalizer' } as unknown as StepDefinition],
  ];

  it.each(KINDS)('%s', async (_kind, step) => {
    const def = {
      id: 'kinds-719',
      name: 'k',
      version: 1,
      steps: { s: step },
    } as unknown as WorkflowDefinition;
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    let called = false;
    await executeStep(store, def, {
      runId: run.id,
      command: 's',
      input: {},
      dispatcher: async () => {
        called = true;
        return {};
      },
    });
    // (a) red when `makeCall`'s branch and the predicate admission reads disagree for this kind
    //     (a predicate that drops a kind, or a branch that serves another); (b) prints both.
    expect({ dispatcherCalled: called }).toEqual({ dispatcherCalled: callsHostDispatcher(step) });
  });
});

describe('issue #719 C5 — callsHostDispatcher outside a definition, and a guard or finalizer step named without a dispatcher', () => {
  it('false for an undefined step, a null one and one that is not an object — and no error', () => {
    const answers = [undefined, null, 'x', 7].map((step) => {
      try {
        return callsHostDispatcher(step as unknown as StepDefinition);
      } catch (e) {
        return `THROW ${(e as Error).constructor.name}`;
      }
    });
    // (a) red when one is true, or reading it throws (a `null` step read `.execution`); (b) prints
    //     the four answers.
    expect(answers).toEqual([false, false, false, false]);
  });

  it.each([
    ['guard', { description: 'd', execution: 'guard', check: 'true' }],
    ['finalizer', { description: 'd', execution: 'finalizer' }],
  ])(
    'guard: executeStep naming a %s step without a dispatcher is admitted, and blocked as before',
    async (_kind, step) => {
      const def = {
        id: 'gf-719',
        name: 'g',
        version: 1,
        steps: { s: step },
      } as unknown as WorkflowDefinition;
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const reply = await executeStep(store, def, { runId: run.id, command: 's', input: {} });
      // (a) red when the predicate's guard/finalizer clause is lost (then such a call rejects
      //     VALIDATION_OPTION_INVALID instead of today's `blocked` reply); (b) prints the status and
      //     the code.
      expect([reply.status, reply.error_code]).toEqual(['blocked', undefined]);
    },
  );
});
