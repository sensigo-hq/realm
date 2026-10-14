// dispatcher-timer-719.test.ts — issue #719 (A1): a host's dispatcher that throws synchronously,
// or returns a plain value, leaves no step timer running and no unhandled rejection; a plain value
// is the step's output. And the dispatcher branch serves exactly the steps `callsHostDispatcher`
// is true for.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

/** The ref'd timers this worker holds. The worker holds one before any work (F719-AU-1), so a
 *  cell compares the count before the call with the count after the reply, never with zero. A
 *  timer of the worker's own can end during the call (seen under the full suite: 1 before, 0
 *  after), so a cell asserts the reply leaves no MORE timers than there were — a leaked step timer
 *  is one more. */
const timers = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

async function callWith(dispatcher: StepDispatcher) {
  const { run } = await store.create({ workflowId: timed.id, workflowVersion: 1, params: {} });
  const before = timers();
  const reply = await executeStep(store, timed, {
    runId: run.id,
    command: 'work',
    input: {},
    dispatcher,
  });
  const after = timers();
  return { runId: run.id, before, after, leftMore: after > before, reply };
}

describe('issue #719 A1 — a dispatcher call cannot escape its step timer', () => {
  it('(a) a dispatcher that throws synchronously: no timer outlives the reply; the reply is "Dispatcher failed: <message>"', async () => {
    const thrower = (() => {
      throw new Error('boom');
    }) as unknown as StepDispatcher;
    const { before, after, leftMore, reply } = await callWith(thrower);
    // (a) red when the timer is left running (+1, and its STEP_TIMEOUT rejects unhandled 2 s
    //     later), or the reply changes; (b) prints the two counts and the reply's status, code and
    //     first error only.
    expect(
      { leftMore, status: reply.status, error_code: reply.error_code, error: reply.errors[0] },
      `timers ${before} → ${after}`,
    ).toEqual({
      leftMore: false,
      status: 'error',
      error_code: 'ENGINE_INTERNAL',
      error: 'Dispatcher failed: boom',
    });
  });

  it('(b) a dispatcher that returns a plain object: no timer outlives the reply; the object is the step output', async () => {
    const plain = (() => ({ answer: 42 })) as unknown as StepDispatcher;
    const { runId, before, after, leftMore, reply } = await callWith(plain);
    const entry = (await store.get(runId)).evidence.find((e) => e.step_id === 'work');
    // (a) red when the timer is left running, or the call fails `.then is not a function`; (b)
    //     prints the two counts, the reply's status, code and first error, and the recorded output.
    expect(
      {
        leftMore,
        status: reply.status,
        error_code: reply.error_code,
        error: reply.errors[0],
        output: entry?.output_summary,
      },
      `timers ${before} → ${after}`,
    ).toEqual({
      leftMore: false,
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
    const { before, after, leftMore, reply } = await callWith(rejecting);
    // (b) prints the two counts and the reply's status and first error only.
    expect(
      { leftMore, status: reply.status, error: reply.errors[0] },
      `timers ${before} → ${after}`,
    ).toEqual({
      leftMore: false,
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
