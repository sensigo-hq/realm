// chain-stopped-step-676.test.ts — issue #676 (review, decisions C73/C74 in #625's record): a
// non-ok reply that is a step's own reply names that step in `stopped_step`; `command` keeps
// naming the step the caller asked for.
//
// Every cell reads `executeChain`'s RETURNED envelope (the public call), never the internals, so
// it holds whatever shape the chain takes inside. One cell per member of the rule — `error`,
// `blocked`, `confirm_required` from a step the engine ran after the called one, and the called
// step's own non-ok reply — and one per absence: an `ok` reply and an error of the chain itself.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { executeChain, executeStep } from './execution-loop.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepDispatcher } from './execution-loop.js';

/** The agent step's submission, accepted as given. */
const echo: StepDispatcher = async (_name, input) => ({ ...input });

/** `draft` (agent) → `publish` (auto, shaped by `publish`). */
function draftThenPublish(id: string, publish: Partial<StepDefinition>): WorkflowDefinition {
  return {
    id,
    name: id,
    version: 1,
    steps: {
      draft: { description: 'Write the draft', execution: 'agent' },
      publish: {
        description: 'Publish it',
        execution: 'auto',
        depends_on: ['draft'],
        ...publish,
      } as StepDefinition,
    },
  };
}

/** A registry whose `boom` handler throws. */
function boomRegistry(): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  registry.register('handler', 'boom', {
    id: 'boom',
    execute: async () => {
      throw new Error('the printer is on fire');
    },
  });
  return registry;
}

let dir: string;
let store: JsonFileStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'realm-676-stopped-'));
  store = new JsonFileStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function newRun(workflowId: string): Promise<string> {
  const { run } = await store.create({ workflowId, workflowVersion: 1, params: {} });
  return run.id;
}

describe('stopped_step names the step a non-ok reply belongs to', () => {
  it('error: a chained step whose handler throws — command stays the called step, stopped_step names the step that failed', async () => {
    const def = draftThenPublish('stopped-error', { handler: 'boom' });
    const runId = await newRun(def.id);
    const reply = await executeChain(store, def, {
      runId,
      command: 'draft',
      input: { text: 'hello' },
      dispatcher: echo,
      registry: boomRegistry(),
    });
    // (a) red when the chain's non-ok return drops the stamp, or when executeChain's relabel
    //     overwrites it; (b) prints the reply's status, command, stopped_step and errors.
    expect({
      status: reply.status,
      command: reply.command,
      stopped_step: reply.stopped_step,
      errors: reply.errors,
    }).toEqual({
      status: 'error',
      command: 'draft',
      stopped_step: 'publish',
      errors: [expect.stringContaining('the printer is on fire')],
    });
    // The called step settled: stopped_step's promise that `command`'s own call returned ok.
    // (a) red when the chain stamps a reply whose called step did not complete; (b) prints both lists.
    const record = await store.get(runId);
    expect({ completed: record.completed_steps, failed: record.failed_steps }).toEqual({
      completed: ['draft'],
      failed: ['publish'],
    });
  });

  it('error (a chained step blocked on a missing handler): stopped_step names the blocked step', async () => {
    const def = draftThenPublish('stopped-capability', { handler: 'not-registered' });
    const runId = await newRun(def.id);
    const reply = await executeChain(store, def, {
      runId,
      command: 'draft',
      input: { text: 'hello' },
      dispatcher: echo,
      registry: new ExtensionRegistry(),
    });
    // (a) red when the stamp is dropped; (b) prints status, command, stopped_step and the code.
    expect({
      status: reply.status,
      command: reply.command,
      stopped_step: reply.stopped_step,
      error_code: reply.error_code,
    }).toEqual({
      status: 'error',
      command: 'draft',
      stopped_step: 'publish',
      error_code: 'ENGINE_HANDLER_NOT_REGISTERED',
    });
  });

  it('blocked: a chained step whose precondition fails — stopped_step names it', async () => {
    const def = draftThenPublish('stopped-blocked', { preconditions: ['draft.ready == true'] });
    const runId = await newRun(def.id);
    const reply = await executeChain(store, def, {
      runId,
      command: 'draft',
      input: { ready: false },
      dispatcher: echo,
    });
    // (a) red when the stamp is limited to `error` replies; (b) prints status, command,
    //     stopped_step and the suggestion naming the failed precondition.
    expect({
      status: reply.status,
      command: reply.command,
      stopped_step: reply.stopped_step,
      suggestion: reply.blocked_reason?.suggestion,
    }).toEqual({
      status: 'blocked',
      command: 'draft',
      stopped_step: 'publish',
      suggestion: expect.stringContaining('draft.ready == true'),
    });
  });

  it('confirm_required: a chained step that opens a gate — stopped_step and the gate name the same step', async () => {
    const def = draftThenPublish('stopped-gate', { trust: 'human_confirmed' });
    const runId = await newRun(def.id);
    const reply = await executeChain(store, def, {
      runId,
      command: 'draft',
      input: { text: 'hello' },
      dispatcher: echo,
    });
    // (a) red when the stamp is limited to error/blocked replies; (b) prints status, command,
    //     stopped_step and the gate's step.
    expect({
      status: reply.status,
      command: reply.command,
      stopped_step: reply.stopped_step,
      gate_step: reply.gate?.step_name,
    }).toEqual({
      status: 'confirm_required',
      command: 'draft',
      stopped_step: 'publish',
      gate_step: 'publish',
    });
  });
});

describe('stopped_step: the called step, and where it is absent', () => {
  it('a refusal before the step does anything — the step is not eligible yet — names the step it refused', async () => {
    const def = draftThenPublish('stopped-not-eligible', {});
    const runId = await newRun(def.id);
    const reply = await executeChain(store, def, {
      runId,
      command: 'publish',
      input: {},
      dispatcher: echo,
    });
    // (a) red when the stamp is limited to replies made after the step ran; (b) prints status,
    //     command and stopped_step.
    expect({
      status: reply.status,
      command: reply.command,
      stopped_step: reply.stopped_step,
    }).toEqual({ status: 'blocked', command: 'publish', stopped_step: 'publish' });
  });

  it('CONTROL — an ok reply: the chain ran the next step to completion', async () => {
    const def = draftThenPublish('stopped-none-ok', {});
    const runId = await newRun(def.id);
    const reply = await executeChain(store, def, {
      runId,
      command: 'draft',
      input: { text: 'hello' },
      dispatcher: echo,
    });
    // (a) red when an ok reply gains the field; (b) prints the status and the field's value.
    expect({ status: reply.status, stopped_step: reply.stopped_step }).toEqual({
      status: 'ok',
      stopped_step: undefined,
    });
    // (a) red when the field is written with an undefined value instead of left out; (b) prints false.
    expect('stopped_step' in reply).toBe(false);
  });

  it("the called step's own non-ok reply names the called step — the same throwing handler, called directly", async () => {
    const def = draftThenPublish('stopped-none-own', { handler: 'boom' });
    const runId = await newRun(def.id);
    await executeStep(store, def, {
      runId,
      command: 'draft',
      input: { text: 'hello' },
      dispatcher: echo,
    });
    const reply = await executeChain(store, def, {
      runId,
      command: 'publish',
      input: {},
      dispatcher: echo,
      registry: boomRegistry(),
    });
    // (a) red when the stamp is limited to steps the engine ran after the called one — a caller
    //     that relabels `command` (MCP `start_run`) then loses the step's name; (b) prints
    //     status, command and stopped_step.
    expect({
      status: reply.status,
      command: reply.command,
      stopped_step: reply.stopped_step,
    }).toEqual({ status: 'error', command: 'publish', stopped_step: 'publish' });
  });

  it("CONTROL — an error of the chain itself: the depth limit names no step's own reply", async () => {
    // 52 bare auto steps in a line: the chain passes its depth limit (50) before the last one runs.
    const steps: Record<string, StepDefinition> = {};
    for (let i = 0; i < 52; i++) {
      steps[`s${i}`] = {
        description: `Step ${i}`,
        execution: 'auto',
        depends_on: i === 0 ? [] : [`s${i - 1}`],
      } as StepDefinition;
    }
    const def: WorkflowDefinition = { id: 'stopped-none-depth', name: 'depth', version: 1, steps };
    const runId = await newRun(def.id);
    const reply = await executeChain(store, def, {
      runId,
      command: 's0',
      input: {},
      dispatcher: echo,
    });
    // (a) red when the chain's own errors gain the field; (b) prints status, errors and presence.
    expect({
      status: reply.status,
      errors: reply.errors,
      has_stopped_step: 'stopped_step' in reply,
    }).toEqual({
      status: 'error',
      errors: [expect.stringContaining('exceeded maximum depth')],
      has_stopped_step: false,
    });
  });
});
