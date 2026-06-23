// Tests for DAG-based branching: trigger_rule variants, when-condition routing,
// Source: execution-loop.ts
// fan-out eligibility, and gate-response flow.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeStep, executeChain, submitHumanResponse } from './execution-loop.js';
import { findEligibleSteps } from './eligibility.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { WorkflowError } from '../types/workflow-error.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepDispatcher } from './execution-loop.js';
import type {
  StepHandler,
  StepHandlerInputs,
  StepContext,
  StepHandlerResult,
} from '../extensions/step-handler.js';

/** A handler that always throws a WorkflowError. */
class FailingHandler implements StepHandler {
  readonly id = 'always_fail';
  async execute(_inputs: StepHandlerInputs, _ctx: StepContext): Promise<StepHandlerResult> {
    throw new WorkflowError('Handler deliberately failed', {
      code: 'ENGINE_HANDLER_FAILED',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: false,
    });
  }
}

/** Handler that returns { confidence: value } for when-condition routing tests. */
class ConfidenceHandler implements StepHandler {
  constructor(private readonly value: string) {}
  readonly id = 'confidence_handler';
  async execute(_inputs: StepHandlerInputs, _ctx: StepContext): Promise<StepHandlerResult> {
    return { data: { confidence: this.value } };
  }
}

const passthroughDispatcher: StepDispatcher = async () => ({});

// ---------------------------------------------------------------------------
// trigger_rule: all_failed — recovery after step failure
// ---------------------------------------------------------------------------

/**
 * Workflow: step-a (fails) → step-recover (trigger_rule: all_failed, agent)
 * After step-a fails, step-recover is eligible; step-continue is NOT eligible.
 */
function makeRecoveryWorkflow(): WorkflowDefinition {
  return {
    id: 'recovery-wf',
    name: 'Recovery Workflow',
    version: 1,
    steps: {
      validate: {
        description: 'Auto step that fails',
        execution: 'auto',
        handler: 'always_fail',
        depends_on: [],
      },
      recover: {
        description: 'Agent recovery step — only eligible when validate fails',
        execution: 'agent',
        depends_on: ['validate'],
        trigger_rule: 'all_failed',
      },
      continue_work: {
        description: 'Normal continuation step — only eligible when validate succeeds',
        execution: 'agent',
        depends_on: ['validate'],
      },
    },
  };
}

/** Workflow with no recovery step — failure is terminal. */
function makeNoRecoveryWorkflow(): WorkflowDefinition {
  return {
    id: 'no-recovery-wf',
    name: 'No Recovery Workflow',
    version: 1,
    steps: {
      validate: {
        description: 'Auto step with no recovery path',
        execution: 'auto',
        handler: 'always_fail',
        depends_on: [],
      },
    },
  };
}

/** Workflow: step-a (fails) → step-recover (auto, trigger_rule: all_failed) → completed */
function makeAutoRecoveryWorkflow(): WorkflowDefinition {
  return {
    id: 'auto-recovery-wf',
    name: 'Auto Recovery Workflow',
    version: 1,
    steps: {
      validate: {
        description: 'Auto step that fails',
        execution: 'auto',
        handler: 'always_fail',
        depends_on: [],
      },
      auto_recover: {
        description: 'Auto recovery step — runs without agent input',
        execution: 'auto',
        depends_on: ['validate'],
        trigger_rule: 'all_failed',
      },
    },
  };
}

describe('trigger_rule: all_failed — recovery after step failure', () => {
  let dir: string;
  let store: JsonFileStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-branch-'));
    store = new JsonFileStore(dir);
  });

  it('step fails → recovery step is eligible, normal continuation is NOT', async () => {
    const definition = makeRecoveryWorkflow();
    const registry = new ExtensionRegistry();
    registry.register('handler', 'always_fail', new FailingHandler());

    const { run: run } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });

    const result = await executeStep(store, definition, {
      runId: run.id,
      command: 'validate',
      input: {},
      dispatcher: passthroughDispatcher,
      registry,
    });

    expect(result.status).toBe('error');

    const updatedRun = await store.get(run.id);
    expect(updatedRun.failed_steps).toContain('validate');
    expect(updatedRun.run_phase).toBe('running'); // recovery step still eligible
    // continue_work has all_success on [validate] — permanently ineligible after failure.
    expect(updatedRun.skipped_steps).toContain('continue_work');

    const eligible = findEligibleSteps(definition, updatedRun);
    expect(eligible).toContain('recover');
    expect(eligible).not.toContain('continue_work');
  });

  it('step fails without recovery path → run is terminal (failed)', async () => {
    const definition = makeNoRecoveryWorkflow();
    const registry = new ExtensionRegistry();
    registry.register('handler', 'always_fail', new FailingHandler());

    const { run: run } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });

    const result = await executeStep(store, definition, {
      runId: run.id,
      command: 'validate',
      input: {},
      dispatcher: passthroughDispatcher,
      registry,
    });

    expect(result.status).toBe('error');
    const updatedRun = await store.get(run.id);
    expect(updatedRun.run_phase).toBe('failed');
    expect(updatedRun.terminal_state).toBe(true);
  });

  it('step fails → auto recovery step is eligible and can be chained explicitly', async () => {
    const definition = makeAutoRecoveryWorkflow();
    const registry = new ExtensionRegistry();
    registry.register('handler', 'always_fail', new FailingHandler());

    const { run: run } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });

    // step: validate fails
    const failResult = await executeChain(store, definition, {
      runId: run.id,
      command: 'validate',
      input: {},
      dispatcher: passthroughDispatcher,
      registry,
    });
    expect(failResult.status).toBe('error');

    // auto_recover is now eligible — can chain into it explicitly
    const recoveryResult = await executeChain(store, definition, {
      runId: run.id,
      command: 'auto_recover',
      input: {},
      dispatcher: passthroughDispatcher,
      registry,
    });
    expect(recoveryResult.status).toBe('ok');

    const finalRun = await store.get(run.id);
    expect(finalRun.run_phase).toBe('completed');
    expect(finalRun.completed_steps).toContain('auto_recover');
  });

  it('cleanup', async () => {
    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// when — conditional routing based on prior step output
// ---------------------------------------------------------------------------

/**
 * Workflow with when-condition routing:
 *   step-a → step-high (when: "step_a.confidence == high")
 *          → step-low  (when: "step_a.confidence == low")
 */
function makeWhenRoutingWorkflow(): WorkflowDefinition {
  return {
    id: 'when-routing-wf',
    name: 'When Routing Workflow',
    version: 1,
    steps: {
      step_a: {
        description: 'Auto step that outputs confidence level',
        execution: 'auto',
        handler: 'confidence_handler',
        depends_on: [],
      },
      step_high: {
        description: 'Runs only when confidence is high',
        execution: 'agent',
        depends_on: ['step_a'],
        when: 'step_a.confidence == high',
      },
      step_low: {
        description: 'Runs only when confidence is low',
        execution: 'agent',
        depends_on: ['step_a'],
        when: 'step_a.confidence == low',
      },
    },
  };
}

describe('when condition routing', () => {
  let dir: string;
  let store: JsonFileStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-when-'));
    store = new JsonFileStore(dir);
  });

  it('confidence=high → step_high eligible, step_low NOT eligible', async () => {
    const definition = makeWhenRoutingWorkflow();
    const registry = new ExtensionRegistry();
    registry.register('handler', 'confidence_handler', new ConfidenceHandler('high'));

    const { run: run } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });

    await executeStep(store, definition, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: passthroughDispatcher,
      registry,
    });

    const updatedRun = await store.get(run.id);
    const eligible = findEligibleSteps(definition, updatedRun);
    expect(eligible).toContain('step_high');
    expect(eligible).not.toContain('step_low');
  });

  it('confidence=low → step_low eligible, step_high NOT eligible', async () => {
    const definition = makeWhenRoutingWorkflow();
    const registry = new ExtensionRegistry();
    registry.register('handler', 'confidence_handler', new ConfidenceHandler('low'));

    const { run: run } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });

    await executeStep(store, definition, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: passthroughDispatcher,
      registry,
    });

    const updatedRun = await store.get(run.id);
    const eligible = findEligibleSteps(definition, updatedRun);
    expect(eligible).toContain('step_low');
    expect(eligible).not.toContain('step_high');
  });

  it('confidence=high → run reaches completed, step_low is skipped', async () => {
    const definition = makeWhenRoutingWorkflow();
    const registry = new ExtensionRegistry();
    registry.register('handler', 'confidence_handler', new ConfidenceHandler('high'));

    const { run: run } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });

    await executeStep(store, definition, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: passthroughDispatcher,
      registry,
    });

    const afterStepA = await store.get(run.id);
    await executeStep(store, definition, {
      runId: afterStepA.id,
      command: 'step_high',
      input: {},
      dispatcher: passthroughDispatcher,
      registry,
    });

    const finalRun = await store.get(run.id);
    expect(finalRun.terminal_state).toBe(true);
    expect(finalRun.run_phase).toBe('completed');
    expect(finalRun.skipped_steps).toContain('step_low');
    expect(finalRun.completed_steps).toContain('step_a');
    expect(finalRun.completed_steps).toContain('step_high');
  });

  it('confidence=low → run reaches completed, step_high is skipped', async () => {
    const definition = makeWhenRoutingWorkflow();
    const registry = new ExtensionRegistry();
    registry.register('handler', 'confidence_handler', new ConfidenceHandler('low'));

    const { run: run } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });

    await executeStep(store, definition, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: passthroughDispatcher,
      registry,
    });

    const afterStepA = await store.get(run.id);
    await executeStep(store, definition, {
      runId: afterStepA.id,
      command: 'step_low',
      input: {},
      dispatcher: passthroughDispatcher,
      registry,
    });

    const finalRun = await store.get(run.id);
    expect(finalRun.terminal_state).toBe(true);
    expect(finalRun.run_phase).toBe('completed');
    expect(finalRun.skipped_steps).toContain('step_high');
    expect(finalRun.completed_steps).toContain('step_a');
    expect(finalRun.completed_steps).toContain('step_low');
  });

  it('cleanup', async () => {
    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// fan-out: multiple steps eligible from same parent
// ---------------------------------------------------------------------------

describe('fan-out: multiple steps eligible simultaneously', () => {
  let dir: string;
  let store: JsonFileStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-fanout-'));
    store = new JsonFileStore(dir);
  });

  it('after step-a completes, both step-b and step-c are eligible', async () => {
    const definition: WorkflowDefinition = {
      id: 'fanout-wf',
      name: 'Fan-out Workflow',
      version: 1,
      steps: {
        'step-a': { description: 'Root', execution: 'auto', depends_on: [] },
        'step-b': { description: 'Branch 1', execution: 'agent', depends_on: ['step-a'] },
        'step-c': { description: 'Branch 2', execution: 'agent', depends_on: ['step-a'] },
      },
    };
    const { run: run } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });

    await executeStep(store, definition, {
      runId: run.id,
      command: 'step-a',
      input: {},
      dispatcher: passthroughDispatcher,
    });

    const updatedRun = await store.get(run.id);
    const eligible = findEligibleSteps(definition, updatedRun);
    expect(eligible).toContain('step-b');
    expect(eligible).toContain('step-c');
    expect(eligible).toHaveLength(2);
  });

  it('cleanup', async () => {
    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// gate response — submitHumanResponse advances the run
// ---------------------------------------------------------------------------

const autoGateDef: WorkflowDefinition = {
  id: 'gate-advance-wf',
  name: 'Gate Advance Workflow',
  version: 1,
  steps: {
    confirm: {
      description: 'Human gate — approve or reject',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['approve', 'reject'] },
    },
    'post-approve': {
      description: 'Runs after approval',
      execution: 'agent',
      depends_on: ['confirm'],
    },
  },
};

describe('gate-response flow', () => {
  let dir: string;
  let store: JsonFileStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-gate-'));
    store = new JsonFileStore(dir);
  });

  it('approve advances run — confirm moves to completed_steps, post-approve is eligible', async () => {
    const { run: run } = await store.create({
      workflowId: autoGateDef.id,
      workflowVersion: 1,
      params: {},
    });

    const gateResult = await executeChain(store, autoGateDef, {
      runId: run.id,
      command: 'confirm',
      input: {},
      dispatcher: passthroughDispatcher,
    });
    expect(gateResult.status).toBe('confirm_required');
    const gateId = gateResult.gate!.gate_id;

    const approveResult = await submitHumanResponse(store, autoGateDef, {
      runId: run.id,
      gateId,
      choice: 'approve',
    });

    expect(approveResult.status).toBe('ok');
    const finalRun = await store.get(run.id);
    expect(finalRun.completed_steps).toContain('confirm');
    expect(finalRun.pending_gate).toBeUndefined();
    expect(findEligibleSteps(autoGateDef, finalRun)).toContain('post-approve');
  });

  it('reject on only-step gate — run completes after reject with no reject handler', async () => {
    const singleGateDef: WorkflowDefinition = {
      id: 'single-gate-wf',
      name: 'Single Gate Workflow',
      version: 1,
      steps: {
        confirm: {
          description: 'Single gate step',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          gate: { choices: ['approve', 'reject'] },
        },
      },
    };

    const { run: run } = await store.create({
      workflowId: singleGateDef.id,
      workflowVersion: 1,
      params: {},
    });

    const gateResult = await executeChain(store, singleGateDef, {
      runId: run.id,
      command: 'confirm',
      input: {},
      dispatcher: passthroughDispatcher,
    });
    expect(gateResult.status).toBe('confirm_required');

    const rejectResult = await submitHumanResponse(store, singleGateDef, {
      runId: run.id,
      gateId: gateResult.gate!.gate_id,
      choice: 'reject',
    });

    expect(rejectResult.status).toBe('ok');
    const finalRun = await store.get(run.id);
    expect(finalRun.completed_steps).toContain('confirm');
    expect(finalRun.run_phase).toBe('completed');
  });

  it('cleanup', async () => {
    await rm(dir, { recursive: true, force: true });
  });
});
