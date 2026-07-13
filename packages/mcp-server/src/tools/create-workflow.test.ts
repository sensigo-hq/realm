// Integration tests for the create_workflow tool business logic.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, JsonWorkflowStore } from '@sensigo/realm';
import { handleCreateWorkflow, type CreateWorkflowArgs } from './create-workflow.js';
import { handleExecuteStep } from './execute-step.js';

describe('handleCreateWorkflow', () => {
  let runDir: string;
  let workflowDir: string;
  let stores: { runStore: JsonFileStore; workflowStore: JsonWorkflowStore };

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-cw-run-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-cw-wf-'));
    stores = {
      runStore: new JsonFileStore(runDir),
      workflowStore: new JsonWorkflowStore(workflowDir),
    };
  });

  it('happy path — single step: returns ok and next_action pointing at the step', async () => {
    const result = await handleCreateWorkflow(
      { steps: [{ id: 'research', description: 'Research the topic' }] },
      stores,
    );
    expect(result.status).toBe('ok');
    expect(result.run_id).not.toBe('');
    expect(result.next_actions[0]?.instruction?.call_with.command).toBe('research');
  });

  it('happy path — multi-step: ok, first step in next_action, 3 steps in store', async () => {
    const args: CreateWorkflowArgs = {
      steps: [
        { id: 'plan', description: 'Plan the work' },
        { id: 'execute', description: 'Execute the plan' },
        { id: 'report', description: 'Write the report' },
      ],
    };
    const result = await handleCreateWorkflow(args, stores);
    expect(result.status).toBe('ok');
    expect(result.next_actions[0]?.instruction?.call_with.command).toBe('plan');

    const def = await stores.workflowStore.get(result.data['workflow_id'] as string);
    expect(Object.keys(def.steps)).toHaveLength(3);
  });

  it('happy path — metadata.name produces a readable workflow_id', async () => {
    const result = await handleCreateWorkflow(
      {
        steps: [{ id: 'step-a', description: 'Do something' }],
        metadata: { name: 'Company Research' },
      },
      stores,
    );
    expect(result.status).toBe('ok');
    expect(result.data['workflow_id']).toMatch(/^company-research-/);
  });

  it('happy path — no metadata produces a dynamic- workflow_id', async () => {
    const result = await handleCreateWorkflow(
      { steps: [{ id: 'step-a', description: 'Do something' }] },
      stores,
    );
    expect(result.status).toBe('ok');
    expect(result.data['workflow_id']).toMatch(/^dynamic-/);
  });

  it('identical args produce the same workflow_id (deterministic/idempotent)', async () => {
    const args = {
      steps: [{ id: 'step-a', description: 'Do something repeatable' }],
      metadata: { name: 'idempotency-test' },
    };
    const result1 = await handleCreateWorkflow(args, stores);
    const result2 = await handleCreateWorkflow(args, stores);
    expect(result1.status).toBe('ok');
    expect(result2.status).toBe('ok');
    expect(result1.data['workflow_id']).toBe(result2.data['workflow_id']);
  });

  it('happy path — input_schema is forwarded to the step and next_action', async () => {
    const schema = {
      type: 'object',
      required: ['answer'],
      properties: { answer: { type: 'string' } },
    };
    const result = await handleCreateWorkflow(
      {
        steps: [{ id: 'step-schema', description: 'Schemed step', input_schema: schema }],
      },
      stores,
    );
    expect(result.status).toBe('ok');
    const def = await stores.workflowStore.get(result.data['workflow_id'] as string);
    expect(def.steps['step-schema']?.input_schema).toEqual(schema);
    expect(result.next_actions[0]?.input_schema).toEqual(schema);
  });

  it('validation — empty steps array returns error with provide_input', async () => {
    const result = await handleCreateWorkflow(
      { steps: [] } as unknown as CreateWorkflowArgs,
      stores,
    );
    expect(result.status).toBe('error');
    expect(result.agent_action).toBe('provide_input');
    expect(result.errors.some((e) => e.includes('at least one step'))).toBe(true);
  });

  it('validation — duplicate step IDs returns error mentioning Duplicate', async () => {
    const result = await handleCreateWorkflow(
      {
        steps: [
          { id: 'step-a', description: 'First' },
          { id: 'step-a', description: 'Second — duplicate' },
        ],
      },
      stores,
    );
    expect(result.status).toBe('error');
    expect(result.agent_action).toBe('provide_input');
    expect(result.errors.some((e) => e.includes('Duplicate step id'))).toBe(true);
  });

  it('validation — step ID with spaces returns error mentioning invalid', async () => {
    const result = await handleCreateWorkflow(
      { steps: [{ id: 'bad id', description: 'Bad step' }] },
      stores,
    );
    expect(result.status).toBe('error');
    expect(result.errors.some((e) => e.includes('invalid'))).toBe(true);
  });

  it('validation — depends_on with multiple predecessors returns error', async () => {
    const result = await handleCreateWorkflow(
      {
        steps: [
          { id: 'a', description: 'Step A' },
          { id: 'b', description: 'Step B' },
          { id: 'c', description: 'Step C', depends_on: ['a', 'b'] },
        ],
      },
      stores,
    );
    expect(result.status).toBe('error');
    expect(result.errors.some((e) => e.includes('at most one predecessor'))).toBe(true);
  });

  it('validation — depends_on unknown reference returns error', async () => {
    const result = await handleCreateWorkflow(
      {
        steps: [{ id: 'step-a', description: 'Step A', depends_on: ['unknown-step'] }],
      },
      stores,
    );
    expect(result.status).toBe('error');
    expect(result.errors.some((e) => e.includes('unknown step'))).toBe(true);
  });

  it('validation — agent_profile rejected with provide_input', async () => {
    const result = await handleCreateWorkflow(
      {
        steps: [
          {
            id: 'step-a',
            description: 'A step',
            agent_profile: 'some-profile',
          } as unknown as import('./create-workflow.js').CreateWorkflowStep,
        ],
      },
      stores,
    );
    expect(result.status).toBe('error');
    expect(result.agent_action).toBe('provide_input');
    expect(
      result.errors.some((e) =>
        e.includes('agent_profile is not supported on dynamically-created workflows'),
      ),
    ).toBe(true);
  });

  it('validation — multiple errors collected together', async () => {
    const result = await handleCreateWorkflow(
      {
        steps: [{ id: 'bad id', description: '' }],
      },
      stores,
    );
    expect(result.status).toBe('error');
    // Both "invalid id" and "description must be non-empty" should appear
    expect(result.errors.length).toBeGreaterThan(1);
  });

  it('provenance — origin is set to agent on built definition', async () => {
    const result = await handleCreateWorkflow(
      { steps: [{ id: 'step-a', description: 'Do something' }] },
      stores,
    );
    expect(result.status).toBe('ok');
    const def = await stores.workflowStore.get(result.data['workflow_id'] as string);
    expect(def.origin).toBe('agent');
  });

  it('provenance — model and agent are passed through from metadata', async () => {
    const result = await handleCreateWorkflow(
      {
        steps: [{ id: 'step-a', description: 'Do something' }],
        metadata: { model: 'claude-sonnet-4-6', agent: 'cursor' },
      },
      stores,
    );
    expect(result.status).toBe('ok');
    const def = await stores.workflowStore.get(result.data['workflow_id'] as string);
    expect(def.model).toBe('claude-sonnet-4-6');
    expect(def.agent).toBe('cursor');
  });

  it('provenance — model and agent are absent when not provided in metadata', async () => {
    const result = await handleCreateWorkflow(
      { steps: [{ id: 'step-a', description: 'Do something' }] },
      stores,
    );
    expect(result.status).toBe('ok');
    const def = await stores.workflowStore.get(result.data['workflow_id'] as string);
    expect(def.model).toBeUndefined();
    expect(def.agent).toBeUndefined();
  });

  it('metadata.description round-trips into definition.description (issue #144 correction)', async () => {
    const result = await handleCreateWorkflow(
      {
        steps: [{ id: 'step-a', description: 'Do something' }],
        metadata: { description: 'What this workflow is for.' },
      },
      stores,
    );
    expect(result.status).toBe('ok');
    const def = await stores.workflowStore.get(result.data['workflow_id'] as string);
    expect(def.description).toBe('What this workflow is for.');
  });

  it('metadata.description omitted leaves definition.description absent — no synthesized default', async () => {
    const result = await handleCreateWorkflow(
      { steps: [{ id: 'step-a', description: 'Do something' }] },
      stores,
    );
    expect(result.status).toBe('ok');
    const def = await stores.workflowStore.get(result.data['workflow_id'] as string);
    expect(def.description).toBeUndefined();
  });

  it('metadata.description of empty/whitespace is treated as omitted, not set to an empty string', async () => {
    const result = await handleCreateWorkflow(
      {
        steps: [{ id: 'step-a', description: 'Do something' }],
        metadata: { description: '   ' },
      },
      stores,
    );
    expect(result.status).toBe('ok');
    const def = await stores.workflowStore.get(result.data['workflow_id'] as string);
    expect(def.description).toBeUndefined();
  });

  it('metadata.description and metadata.task_description map independently (description ≠ quick_start)', async () => {
    const result = await handleCreateWorkflow(
      {
        steps: [{ id: 'step-a', description: 'Do something' }],
        metadata: {
          description: 'Declarative purpose.',
          task_description: 'Imperative how-to-begin.',
        },
      },
      stores,
    );
    expect(result.status).toBe('ok');
    const def = await stores.workflowStore.get(result.data['workflow_id'] as string);
    expect(def.description).toBe('Declarative purpose.');
    expect(def.protocol?.quick_start).toBe('Imperative how-to-begin.');
  });
});

describe('end-to-end — create_workflow + execute_step walk to completion', () => {
  let runDir: string;
  let workflowDir: string;
  let stores: { runStore: JsonFileStore; workflowStore: JsonWorkflowStore };

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-e2e-run-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-e2e-wf-'));
    stores = {
      runStore: new JsonFileStore(runDir),
      workflowStore: new JsonWorkflowStore(workflowDir),
    };
  });

  it('two-step plan: create_workflow → execute step 1 → execute step 2 → completed', async () => {
    const createResult = await handleCreateWorkflow(
      {
        steps: [
          { id: 'step_one', description: 'Produce the first output.' },
          { id: 'step_two', description: 'Produce the second output.' },
        ],
        metadata: { name: 'smoke-test' },
      },
      stores,
    );

    expect(createResult.status).toBe('ok');
    expect(createResult.next_actions[0]?.instruction?.call_with.command).toBe('step_one');

    const step1Result = await handleExecuteStep(
      {
        run_id: createResult.run_id,
        command: createResult.next_actions[0]!.instruction!.call_with.command as string,
        params: { output: 'first output' },
      },
      stores,
    );

    expect(step1Result.status).toBe('ok');
    expect(step1Result.next_actions[0]?.instruction?.call_with.command).toBe('step_two');

    const step2Result = await handleExecuteStep(
      {
        run_id: step1Result.run_id,
        command: step1Result.next_actions[0]!.instruction!.call_with.command as string,
        params: { output: 'second output' },
      },
      stores,
    );

    expect(step2Result.status).toBe('ok');
    expect(step2Result.next_actions.length).toBe(0);

    // Verify the run itself reached the terminal state.
    const finalRun = await stores.runStore.get(step2Result.run_id);
    expect(finalRun.run_phase).toBe('completed');
  });
});
