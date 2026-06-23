// Tests for executeChain — automatic chaining through consecutive auto steps.
// Source: execution-loop.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeChain } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepDispatcher } from './execution-loop.js';

/** Three consecutive auto steps that chain all the way to completed. */
const threeAutoStepsDef: WorkflowDefinition = {
  id: 'chain-wf',
  name: 'Chain Workflow',
  version: 1,
  steps: {
    'step-a': {
      description: 'First auto step',
      execution: 'auto',
      depends_on: [],
    },
    'step-b': {
      description: 'Second auto step',
      execution: 'auto',
      depends_on: ['step-a'],
    },
    'step-c': {
      description: 'Third auto step',
      execution: 'auto',
      depends_on: ['step-b'],
    },
  },
};

/** Auto step followed by an agent step — chain must stop at the agent step. */
const stopAtAgentDef: WorkflowDefinition = {
  id: 'stop-agent-wf',
  name: 'Stop At Agent Workflow',
  version: 1,
  steps: {
    'step-a': {
      description: 'Auto step',
      execution: 'auto',
      depends_on: [],
    },
    'step-b': {
      description: 'Agent step — chain stops here',
      execution: 'agent',
      depends_on: ['step-a'],
    },
  },
};

/** Auto step (trust: auto) followed by an auto step with trust: human_confirmed. */
const stopAtGateDef: WorkflowDefinition = {
  id: 'stop-gate-wf',
  name: 'Stop At Gate Workflow',
  version: 1,
  steps: {
    'step-a': {
      description: 'Auto step without gate',
      execution: 'auto',
      depends_on: [],
    },
    'step-b': {
      description: 'Auto step with human confirmation gate',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: ['step-a'],
    },
  },
};

/** Two auto steps — dispatcher throws on step-a. */
const failsDef: WorkflowDefinition = {
  id: 'fail-wf',
  name: 'Fail Workflow',
  version: 1,
  steps: {
    'step-a': {
      description: 'Auto step that fails',
      execution: 'auto',
      depends_on: [],
    },
    'step-b': {
      description: 'Second auto step',
      execution: 'auto',
      depends_on: ['step-a'],
    },
  },
};

const echoDispatcher: StepDispatcher = async (_step, _input, _run, _signal) => ({});

describe('executeChain', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-chain-'));
  });

  it('auto-chains 3 auto steps in one call — run ends at completed', async () => {
    const store = new JsonFileStore(dir);
    const { run: run } = await store.create({
      workflowId: 'chain-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeChain(store, threeAutoStepsDef, {
      runId: run.id,
      command: 'step-a',
      input: {},
      dispatcher: echoDispatcher,
    });

    expect(envelope.status).toBe('ok');

    const updated = await store.get(run.id);
    expect(updated.run_phase).toBe('completed');
    // Evidence for all 3 steps is persisted in the run.
    expect(updated.evidence).toHaveLength(3);
  });

  it('stops at an agent step — step-b is NOT executed', async () => {
    const store = new JsonFileStore(dir);
    const { run: run } = await store.create({
      workflowId: 'stop-agent-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeChain(store, stopAtAgentDef, {
      runId: run.id,
      command: 'step-a',
      input: {},
      dispatcher: echoDispatcher,
    });

    // The returned envelope is from step-a (the last step executed).
    expect(envelope.status).toBe('ok');

    const updated = await store.get(run.id);
    // step-a completed; step-b (agent) was NOT auto-executed — run is still running.
    expect(updated.run_phase).toBe('running');
    expect(updated.completed_steps).toContain('step-a');
    expect(updated.completed_steps).not.toContain('step-b');
  });

  it('chains into trust: human_confirmed — step-b opens gate and returns confirm_required', async () => {
    const store = new JsonFileStore(dir);
    const { run: run } = await store.create({
      workflowId: 'stop-gate-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeChain(store, stopAtGateDef, {
      runId: run.id,
      command: 'step-a',
      input: {},
      dispatcher: echoDispatcher,
    });

    // step-b opens a gate — chain returns confirm_required.
    expect(envelope.status).toBe('confirm_required');

    const updated = await store.get(run.id);
    expect(updated.run_phase).toBe('gate_waiting');
  });

  it('stops and returns error when a step fails — run is marked failed', async () => {
    const store = new JsonFileStore(dir);
    const { run: run } = await store.create({
      workflowId: 'fail-wf',
      workflowVersion: 1,
      params: {},
    });

    const failDispatcher: StepDispatcher = async (_step, _input, _run, _signal) => {
      throw new WorkflowError('step-a failed', {
        code: 'ENGINE_HANDLER_FAILED',
        category: 'ENGINE',
        agentAction: 'stop',
        retryable: false,
      });
    };

    const envelope = await executeChain(store, failsDef, {
      runId: run.id,
      command: 'step-a',
      input: {},
      dispatcher: failDispatcher,
    });

    expect(envelope.status).toBe('error');

    const updated = await store.get(run.id);
    expect(updated.run_phase).toBe('failed');
  });
});
