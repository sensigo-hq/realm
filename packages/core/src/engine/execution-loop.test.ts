import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeStep,
  executeChain,
  buildNextActions,
  submitHumanResponse,
} from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { WorkflowError } from '../types/workflow-error.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import { InMemoryTraceBufferStore } from '../store/trace-buffer-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepDispatcher } from './execution-loop.js';
import type { ServiceAdapter } from '../extensions/service-adapter.js';
import type { StepHandler, StepHandlerInputs, StepContext } from '../extensions/step-handler.js';

// Two-step workflow: step-one (auto) → step-two (agent).
const definition: WorkflowDefinition = {
  id: 'test-wf',
  name: 'Test Workflow',
  version: 1,
  steps: {
    'step-one': {
      description: 'First step',
      execution: 'auto',
      depends_on: [],
    },
    'step-two': {
      description: 'Second step',
      execution: 'agent',
      depends_on: ['step-one'],
    },
  },
};

const echoDispatcher: StepDispatcher = async (_step, input, _run, _signal) => ({
  ...input,
  echoed: true,
});
const failDispatcher: StepDispatcher = async () => {
  throw new WorkflowError('step failed', {
    code: 'ENGINE_HANDLER_FAILED',
    category: 'ENGINE',
    agentAction: 'stop',
    retryable: false,
  });
};

describe('executeStep', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-exec-test-'));
    store = new JsonFileStore(dir);
  });

  it('successful step returns status ok and updates completed_steps', async () => {
    const run = await store.create({
      workflowId: 'test-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeStep(store, definition, {
      runId: run.id,
      command: 'step-one',
      input: { key: 'value' },
      dispatcher: echoDispatcher,
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.data).toMatchObject({ key: 'value', echoed: true });
    expect(envelope.evidence).toHaveLength(1);
    expect(envelope.evidence[0]?.status).toBe('success');
    // step-two is the next eligible agent step → appears in next_actions
    expect(envelope.next_actions).toHaveLength(1);
    expect(envelope.next_actions[0]?.human_readable).toContain('step-two');
    expect(envelope.context_hint).toBeDefined();
    expect(envelope.context_hint).not.toBe('');

    const updated = await store.get(run.id);
    expect(updated.completed_steps).toContain('step-one');
    expect(updated.run_phase).toBe('running');
  });

  it('blocked state returns blocked envelope with blocked_reason', async () => {
    const run = await store.create({
      workflowId: 'test-wf',
      workflowVersion: 1,
      params: {},
    });

    // step-two depends on step-one which hasn't run → not eligible
    const envelope = await executeStep(store, definition, {
      runId: run.id,
      command: 'step-two',
      input: {},
      dispatcher: echoDispatcher,
    });

    expect(envelope.status).toBe('blocked');
    expect(envelope.blocked_reason).toBeDefined();
    expect(envelope.agent_action).toBe('resolve_precondition');
    // next_actions contains step-one (auto — instruction is null)
    expect(envelope.next_actions).toHaveLength(0); // auto step → no instruction → filtered out
    expect(envelope.blocked_reason?.suggestion).toContain('step');
    expect(envelope.context_hint).toContain('step-two');
  });

  it('blocked state with no eligible steps includes explanation in suggestion', async () => {
    // Workflow where every step has a depends_on dependency — nothing is eligible initially
    const blockedDef: WorkflowDefinition = {
      id: 'blocked-wf',
      name: 'Blocked Workflow',
      version: 1,
      steps: {
        'only-step': {
          description: 'A step that depends on a non-existent step',
          execution: 'agent',
          depends_on: ['phantom-step'],
        },
      },
    };

    const run = await store.create({
      workflowId: 'blocked-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeStep(store, blockedDef, {
      runId: run.id,
      command: 'only-step',
      input: {},
      dispatcher: echoDispatcher,
    });

    expect(envelope.status).toBe('blocked');
    expect(envelope.agent_action).toBe('resolve_precondition');
    expect(envelope.next_actions).toHaveLength(0);
    expect(envelope.blocked_reason?.suggestion).toBeDefined();
  });

  it('dispatcher error returns error envelope with evidence', async () => {
    const run = await store.create({
      workflowId: 'test-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeStep(store, definition, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: failDispatcher,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.evidence).toHaveLength(1);
    expect(envelope.evidence[0]?.status).toBe('error');
    expect(envelope.errors[0]).toContain('step failed');
    expect(envelope.context_hint).toContain('step-one');
  });

  it('completing final step sets run_phase to completed', async () => {
    const run = await store.create({
      workflowId: 'test-wf',
      workflowVersion: 1,
      params: {},
    });

    // Step-one must complete before step-two can run.
    await executeStep(store, definition, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: echoDispatcher,
    });

    const envelope = await executeStep(store, definition, {
      runId: run.id,
      command: 'step-two',
      input: {},
      dispatcher: echoDispatcher,
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.next_actions).toHaveLength(0);
    expect(envelope.context_hint).toContain('get_run_state');
    expect(envelope.context_hint).toContain(run.id);

    const updated = await store.get(run.id);
    expect(updated.run_phase).toBe('completed');
  });

  it('unknown run ID returns error envelope', async () => {
    const envelope = await executeStep(store, definition, {
      runId: 'does-not-exist',
      command: 'step-one',
      input: {},
      dispatcher: echoDispatcher,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.errors[0]).toContain('Run not found');
    expect(envelope.agent_action).toBe('report_to_user');
    expect(envelope.next_actions).toHaveLength(0);
  });

  it('input schema validation blocks dispatch when input is invalid', async () => {
    const dispatchCalled = vi.fn();
    const spy: StepDispatcher = async (step, input, run, _signal) => {
      dispatchCalled();
      return echoDispatcher(step, input, run, _signal);
    };

    const schemaDefinition: WorkflowDefinition = {
      ...definition,
      steps: {
        ...definition.steps,
        'step-one': {
          ...definition.steps['step-one']!,
          input_schema: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } },
          },
        },
      },
    };
    const run = await store.create({
      workflowId: 'test-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeStep(store, schemaDefinition, {
      runId: run.id,
      command: 'step-one',
      input: {}, // missing required 'name' field
      dispatcher: spy,
    });

    expect(envelope.status).toBe('error');
    expect(dispatchCalled).not.toHaveBeenCalled();
    expect(envelope.agent_action).toBe('provide_input');
    expect(envelope.next_actions).toHaveLength(0);
  });

  it('input schema validation passes through for valid input', async () => {
    const schemaDefinition: WorkflowDefinition = {
      ...definition,
      steps: {
        ...definition.steps,
        'step-one': {
          ...definition.steps['step-one']!,
          input_schema: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } },
          },
        },
      },
    };
    const run = await store.create({
      workflowId: 'test-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeStep(store, schemaDefinition, {
      runId: run.id,
      command: 'step-one',
      input: { name: 'Alice' },
      dispatcher: echoDispatcher,
    });

    expect(envelope.status).toBe('ok');
  });

  // ---------------------------------------------------------------------------
  // output_schema validation
  // ---------------------------------------------------------------------------

  it('output_schema: fails when agent submits output missing required field', async () => {
    const dispatchCalled = vi.fn();
    const spy: StepDispatcher = async (step, input, run, _signal) => {
      dispatchCalled();
      return echoDispatcher(step, input, run, _signal);
    };

    const schemaDefinition: WorkflowDefinition = {
      ...definition,
      steps: {
        ...definition.steps,
        'step-one': {
          ...definition.steps['step-one']!,
          execution: 'agent',
          output_schema: {
            type: 'object',
            required: ['summary'],
            properties: { summary: { type: 'string' } },
          },
        },
      },
    };

    const run = await store.create({
      workflowId: 'test-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeStep(store, schemaDefinition, {
      runId: run.id,
      command: 'step-one',
      input: {}, // missing required 'summary' field
      dispatcher: spy,
    });

    expect(envelope.status).toBe('error');
    expect(dispatchCalled).not.toHaveBeenCalled();
    expect(envelope.agent_action).toBe('provide_input');
    // The step was never claimed — it is still eligible and appears in next_actions
    // so the agent can immediately correct and re-submit it.
    expect(envelope.next_actions).toHaveLength(1);

    const runAfter = await store.get(run.id);
    expect(runAfter.in_progress_steps).not.toContain('step-one');
  });

  it('output_schema: passes when agent submits valid output', async () => {
    const schemaDefinition: WorkflowDefinition = {
      ...definition,
      steps: {
        ...definition.steps,
        'step-one': {
          ...definition.steps['step-one']!,
          execution: 'agent',
          output_schema: {
            type: 'object',
            required: ['summary'],
            properties: { summary: { type: 'string' } },
          },
        },
      },
    };

    const run = await store.create({
      workflowId: 'test-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeStep(store, schemaDefinition, {
      runId: run.id,
      command: 'step-one',
      input: { summary: 'all good' },
      dispatcher: echoDispatcher,
    });

    expect(envelope.status).toBe('ok');
  });

  it('output_schema: validation guard skips auto steps at runtime', async () => {
    const schemaDefinition: WorkflowDefinition = {
      ...definition,
      steps: {
        ...definition.steps,
        'step-one': {
          ...definition.steps['step-one']!,
          // execution: 'auto' (unchanged) — YAML loader would reject this, but
          // the runtime guard must correctly skip auto steps.
          output_schema: {
            type: 'object',
            required: ['summary'],
            properties: { summary: { type: 'string' } },
          },
        },
      },
    };

    const run = await store.create({
      workflowId: 'test-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeStep(store, schemaDefinition, {
      runId: run.id,
      command: 'step-one',
      input: {}, // would fail schema if the guard ran
      dispatcher: echoDispatcher,
    });

    expect(envelope.status).toBe('ok');
  });

  it('output_schema: step can be re-submitted after failed validation', async () => {
    const schemaDefinition: WorkflowDefinition = {
      ...definition,
      steps: {
        ...definition.steps,
        'step-one': {
          ...definition.steps['step-one']!,
          execution: 'agent',
          output_schema: {
            type: 'object',
            required: ['summary'],
            properties: { summary: { type: 'string' } },
          },
        },
      },
    };

    const run = await store.create({
      workflowId: 'test-wf',
      workflowVersion: 1,
      params: {},
    });

    // First call with invalid input — should fail
    const first = await executeStep(store, schemaDefinition, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: echoDispatcher,
    });
    expect(first.status).toBe('error');

    // Second call with valid input — step was never claimed, so it can be re-submitted
    const second = await executeStep(store, schemaDefinition, {
      runId: run.id,
      command: 'step-one',
      input: { summary: 'corrected' },
      dispatcher: echoDispatcher,
    });
    expect(second.status).toBe('ok');
  });

  // ---------------------------------------------------------------------------
  // Adapter dispatch (uses_service)
  // ---------------------------------------------------------------------------

  describe('adapter dispatch via uses_service', () => {
    const adapterDefinition: WorkflowDefinition = {
      id: 'adapter-wf',
      name: 'Adapter Workflow',
      version: 1,
      services: {
        my_service: { adapter: 'mock_adapter', trust: 'engine_delivered' },
      },
      steps: {
        fetch_data: {
          description: 'Fetch data from a service',
          execution: 'auto',
          depends_on: [],
          uses_service: 'my_service',
        },
      },
    };

    function makeAdapter(data: Record<string, unknown>): ServiceAdapter {
      return {
        id: 'mock_adapter',
        fetch: vi.fn().mockResolvedValue({ status: 200, data }),
        create: vi.fn(),
        update: vi.fn(),
      };
    }

    it('calls the registered adapter and returns its data as step output', async () => {
      const adapter = makeAdapter({ content: 'hello' });
      const registry = new ExtensionRegistry();
      registry.register('adapter', 'mock_adapter', adapter);

      const run = await store.create({
        workflowId: 'adapter-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, adapterDefinition, {
        runId: run.id,
        command: 'fetch_data',
        input: { doc_id: 'abc' },
        dispatcher: echoDispatcher,
        registry,
      });

      expect(envelope.status).toBe('ok');
      expect(envelope.data).toEqual({ content: 'hello' });
      expect(adapter.fetch).toHaveBeenCalledWith(
        'fetch_data',
        { doc_id: 'abc' },
        expect.objectContaining({ adapter: 'mock_adapter' }),
        undefined,
      );
    });

    it('returns error envelope when service is not declared in definition', async () => {
      const badDefinition: WorkflowDefinition = {
        id: 'adapter-wf',
        name: 'Adapter Workflow',
        version: 1,
        // no services block
        steps: {
          fetch_data: {
            description: 'Fetch data from a service',
            execution: 'auto',
            depends_on: [],
            uses_service: 'my_service',
          },
        },
      };
      const registry = new ExtensionRegistry();

      const run = await store.create({
        workflowId: 'adapter-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, badDefinition, {
        runId: run.id,
        command: 'fetch_data',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      expect(envelope.status).toBe('error');
      expect(envelope.errors[0]).toContain("Service 'my_service' not found");
    });

    it('returns error envelope when adapter is not registered in the registry', async () => {
      const registry = new ExtensionRegistry(); // empty — no adapter registered

      const run = await store.create({
        workflowId: 'adapter-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, adapterDefinition, {
        runId: run.id,
        command: 'fetch_data',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      expect(envelope.status).toBe('error');
      expect(envelope.errors[0]).toContain("Adapter 'mock_adapter'");
      expect(envelope.errors[0]).toContain('not registered');
    });

    it('wraps non-object adapter response in { data, status }', async () => {
      const adapter = makeAdapter('raw string' as unknown as Record<string, unknown>);
      const registry = new ExtensionRegistry();
      registry.register('adapter', 'mock_adapter', adapter);

      const run = await store.create({
        workflowId: 'adapter-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, adapterDefinition, {
        runId: run.id,
        command: 'fetch_data',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      expect(envelope.status).toBe('ok');
      expect(envelope.data).toEqual({ data: 'raw string', status: 200 });
    });

    it('defaults to fetch when service_method is absent', async () => {
      const adapter = makeAdapter({ result: 1 });
      const registry = new ExtensionRegistry();
      registry.register('adapter', 'mock_adapter', adapter);

      const run = await store.create({
        workflowId: 'adapter-wf',
        workflowVersion: 1,
        params: {},
      });

      await executeStep(store, adapterDefinition, {
        runId: run.id,
        command: 'fetch_data',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      expect(adapter.fetch).toHaveBeenCalledTimes(1);
      expect(adapter.create).not.toHaveBeenCalled();
      expect(adapter.update).not.toHaveBeenCalled();
    });

    it('calls adapter.create() when service_method is create', async () => {
      const adapter: ServiceAdapter = {
        id: 'mock_adapter',
        fetch: vi.fn().mockResolvedValue({ status: 200, data: {} }),
        create: vi.fn().mockResolvedValue({ status: 201, data: { id: 'new-1' } }),
        update: vi.fn().mockResolvedValue({ status: 200, data: {} }),
      };
      const registry = new ExtensionRegistry();
      registry.register('adapter', 'mock_adapter', adapter);

      const def: WorkflowDefinition = {
        ...adapterDefinition,
        steps: {
          fetch_data: {
            ...adapterDefinition.steps['fetch_data']!,
            service_method: 'create',
          },
        },
      };

      const run = await store.create({
        workflowId: 'adapter-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'fetch_data',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      expect(envelope.status).toBe('ok');
      expect(adapter.create).toHaveBeenCalledTimes(1);
      expect(adapter.fetch).not.toHaveBeenCalled();
    });

    it('calls adapter.update() when service_method is update', async () => {
      const adapter: ServiceAdapter = {
        id: 'mock_adapter',
        fetch: vi.fn().mockResolvedValue({ status: 200, data: {} }),
        create: vi.fn().mockResolvedValue({ status: 201, data: {} }),
        update: vi.fn().mockResolvedValue({ status: 200, data: { updated: true } }),
      };
      const registry = new ExtensionRegistry();
      registry.register('adapter', 'mock_adapter', adapter);

      const def: WorkflowDefinition = {
        ...adapterDefinition,
        steps: {
          fetch_data: {
            ...adapterDefinition.steps['fetch_data']!,
            service_method: 'update',
          },
        },
      };

      const run = await store.create({
        workflowId: 'adapter-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'fetch_data',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      expect(envelope.status).toBe('ok');
      expect(adapter.update).toHaveBeenCalledTimes(1);
      expect(adapter.fetch).not.toHaveBeenCalled();
    });

    it('uses step name as operation when operation field is absent', async () => {
      const adapter = makeAdapter({ ok: true });
      const registry = new ExtensionRegistry();
      registry.register('adapter', 'mock_adapter', adapter);

      const run = await store.create({
        workflowId: 'adapter-wf',
        workflowVersion: 1,
        params: {},
      });

      await executeStep(store, adapterDefinition, {
        runId: run.id,
        command: 'fetch_data',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      expect(adapter.fetch).toHaveBeenCalledWith(
        'fetch_data',
        expect.anything(),
        expect.anything(),
        undefined,
      );
    });

    it('uses operation field when present instead of step name', async () => {
      const adapter = makeAdapter({ ok: true });
      const registry = new ExtensionRegistry();
      registry.register('adapter', 'mock_adapter', adapter);

      const def: WorkflowDefinition = {
        ...adapterDefinition,
        steps: {
          fetch_data: {
            ...adapterDefinition.steps['fetch_data']!,
            operation: 'fetch_document_v2',
          },
        },
      };

      const run = await store.create({
        workflowId: 'adapter-wf',
        workflowVersion: 1,
        params: {},
      });

      await executeStep(store, def, {
        runId: run.id,
        command: 'fetch_data',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      expect(adapter.fetch).toHaveBeenCalledWith(
        'fetch_document_v2',
        expect.anything(),
        expect.anything(),
        undefined,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Handler dispatch (handler field)
  // ---------------------------------------------------------------------------

  describe('handler dispatch via handler field', () => {
    const handlerDefinition: WorkflowDefinition = {
      id: 'handler-wf',
      name: 'Handler Workflow',
      version: 1,
      steps: {
        validate: {
          description: 'Run custom validation logic',
          execution: 'auto',
          depends_on: [],
          handler: 'my_handler',
        },
      },
    };

    function makeHandler(data: Record<string, unknown>): StepHandler {
      return {
        id: 'my_handler',
        execute: vi
          .fn<[StepHandlerInputs, StepContext], Promise<{ data: Record<string, unknown> }>>()
          .mockResolvedValue({ data }),
      };
    }

    it('calls the registered handler and returns its data as step output', async () => {
      const handler = makeHandler({ valid: true });
      const registry = new ExtensionRegistry();
      registry.register('handler', 'my_handler', handler);

      const run = await store.create({
        workflowId: 'handler-wf',
        workflowVersion: 1,
        params: { source: 'doc-1' },
      });

      const envelope = await executeStep(store, handlerDefinition, {
        runId: run.id,
        command: 'validate',
        input: { threshold: 0.9 },
        dispatcher: echoDispatcher,
        registry,
      });

      expect(envelope.status).toBe('ok');
      expect(envelope.data).toEqual({ valid: true });
      expect(handler.execute).toHaveBeenCalledWith(
        { params: { threshold: 0.9 } },
        expect.objectContaining({
          run_id: run.id,
          run_params: { source: 'doc-1' },
        }),
        undefined,
      );
    });

    it('returns error envelope when handler is not registered', async () => {
      const registry = new ExtensionRegistry(); // empty

      const run = await store.create({
        workflowId: 'handler-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, handlerDefinition, {
        runId: run.id,
        command: 'validate',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      expect(envelope.status).toBe('error');
      expect(envelope.errors[0]).toContain("Handler 'my_handler' is not registered");
    });

    it('passes prior step outputs as context.resources to the handler', async () => {
      const twoStepDefinition: WorkflowDefinition = {
        id: 'two-step-wf',
        name: 'Two Step Workflow',
        version: 1,
        services: {
          docs: { adapter: 'mock_adapter', trust: 'engine_delivered' },
        },
        steps: {
          fetch_doc: {
            description: 'Fetch document',
            execution: 'auto',
            depends_on: [],
            uses_service: 'docs',
          },
          run_validation: {
            description: 'Validate fetched document',
            execution: 'auto',
            depends_on: ['fetch_doc'],
            handler: 'my_handler',
          },
        },
      };

      const capturedContext: StepContext[] = [];
      const handler: StepHandler = {
        id: 'my_handler',
        execute: vi
          .fn()
          .mockImplementation(async (_inputs: StepHandlerInputs, ctx: StepContext) => {
            capturedContext.push(ctx);
            return { data: { captured: true } };
          }),
      };

      const adapter: ServiceAdapter = {
        id: 'mock_adapter',
        fetch: vi.fn().mockResolvedValue({ status: 200, data: { text: 'document content' } }),
        create: vi.fn(),
        update: vi.fn(),
      };

      const registry = new ExtensionRegistry();
      registry.register('adapter', 'mock_adapter', adapter);
      registry.register('handler', 'my_handler', handler);

      const run = await store.create({
        workflowId: 'two-step-wf',
        workflowVersion: 1,
        params: {},
      });

      // Execute the adapter step first so its evidence is stored.
      await executeStep(store, twoStepDefinition, {
        runId: run.id,
        command: 'fetch_doc',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      await executeStep(store, twoStepDefinition, {
        runId: run.id,
        command: 'run_validation',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      expect(capturedContext).toHaveLength(1);
      const ctx = capturedContext[0]!;
      expect(ctx.resources).toBeDefined();
      expect(ctx.resources!['fetch_doc']).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // step.prompt resolution
  // ---------------------------------------------------------------------------

  describe('step.prompt resolution', () => {
    it('resolves step.prompt into next_actions[].prompt after a step completes', async () => {
      const promptDefinition: WorkflowDefinition = {
        id: 'prompt-wf',
        name: 'Prompt Workflow',
        version: 1,
        steps: {
          'step-one': {
            description: 'First step',
            execution: 'auto',
            depends_on: [],
          },
          'step-two': {
            description: 'Second step',
            execution: 'agent',
            depends_on: ['step-one'],
            prompt: 'Use result: {{ context.resources.step-one.key }}',
          },
        },
      };

      const run = await store.create({
        workflowId: 'prompt-wf',
        workflowVersion: 1,
        params: {},
      });

      const stepOneDispatcher: StepDispatcher = async () => ({ key: 'value-from-step-one' });

      const envelope = await executeStep(store, promptDefinition, {
        runId: run.id,
        command: 'step-one',
        input: {},
        dispatcher: stepOneDispatcher,
      });

      expect(envelope.status).toBe('ok');
      const nextAction = envelope.next_actions.find((a) => a.human_readable?.includes('step-two'));
      expect(nextAction).toBeDefined();
      expect(nextAction?.prompt).toBe('Use result: value-from-step-one');
    });

    it('resolves step.prompt into gate.display when step has trust: human_confirmed', async () => {
      const gatePromptDefinition: WorkflowDefinition = {
        id: 'gate-prompt-wf',
        name: 'Gate Prompt Workflow',
        version: 1,
        steps: {
          'step-one': {
            description: 'First step',
            execution: 'auto',
            depends_on: [],
          },
          'gate-step': {
            description: 'Gate step',
            execution: 'auto',
            trust: 'human_confirmed',
            depends_on: ['step-one'],
            prompt: 'Risk: {{ context.resources.step-one.risk }}',
          },
        },
      };

      const run = await store.create({
        workflowId: 'gate-prompt-wf',
        workflowVersion: 1,
        params: {},
      });

      const stepOneDispatcher: StepDispatcher = async () => ({ risk: 'high' });
      await executeStep(store, gatePromptDefinition, {
        runId: run.id,
        command: 'step-one',
        input: {},
        dispatcher: stepOneDispatcher,
      });

      const gateDispatcher: StepDispatcher = async () => ({});
      const envelope = await executeStep(store, gatePromptDefinition, {
        runId: run.id,
        command: 'gate-step',
        input: {},
        dispatcher: gateDispatcher,
      });

      expect(envelope.status).toBe('confirm_required');
      expect(envelope.gate?.display).toBe('Risk: high');
    });
  });

  // ---------------------------------------------------------------------------
  // buildNextActions instruction population
  // ---------------------------------------------------------------------------

  describe('buildNextActions instruction population', () => {
    it('populates instruction with execute_step for an agent step', async () => {
      const agentStepDef: WorkflowDefinition = {
        id: 'agent-instr-wf',
        name: 'Agent Instruction Workflow',
        version: 1,
        steps: {
          'review-code': {
            description: 'Review the code',
            execution: 'agent',
            depends_on: [],
            input_schema: { required: ['findings'], properties: { findings: { type: 'array' } } },
          },
        },
      };

      const run = await store.create({
        workflowId: 'agent-instr-wf',
        workflowVersion: 1,
        params: {},
      });

      const actions = buildNextActions(agentStepDef, run);
      expect(actions).toHaveLength(1);
      const action = actions[0]!;
      expect(action.instruction).not.toBeNull();
      expect(action.instruction!.tool).toBe('execute_step');
      expect((action.instruction!.params as Record<string, unknown>)['command']).toBe(
        'review-code',
      );
      expect((action.instruction!.params as Record<string, unknown>)['run_id']).toBe(run.id);
      expect(action.input_schema).toEqual(agentStepDef.steps['review-code']?.input_schema);
      expect(
        (action.instruction!.params as Record<string, unknown>)['input_schema'],
      ).toBeUndefined();
      expect(action.instruction!.call_with).toBeDefined();
      expect((action.instruction!.call_with as Record<string, unknown>)['run_id']).toBe(run.id);
      expect((action.instruction!.call_with as Record<string, unknown>)['command']).toBe(
        'review-code',
      );
      // input_schema is present → call_with.params is a skeleton object
      const callWithParams = (action.instruction!.call_with as Record<string, unknown>)['params'];
      expect(typeof callWithParams).toBe('object');
      expect(callWithParams).not.toBeNull();
    });

    it('returns no actions for an auto step without a handler', async () => {
      const autoStepDef: WorkflowDefinition = {
        id: 'auto-instr-wf',
        name: 'Auto Instruction Workflow',
        version: 1,
        steps: {
          'fetch-data': {
            description: 'Fetch data automatically',
            execution: 'auto',
            depends_on: [],
          },
        },
      };

      const run = await store.create({
        workflowId: 'auto-instr-wf',
        workflowVersion: 1,
        params: {},
      });

      // Auto steps without handlers are filtered out of next_actions
      const actions = buildNextActions(autoStepDef, run);
      expect(actions).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // confirm_required next_actions population
  // ---------------------------------------------------------------------------

  describe('confirm_required next_actions population', () => {
    it('confirm_required response has next_actions instruction pointing to submit_human_response', async () => {
      const gateWorkflow: WorkflowDefinition = {
        id: 'gate-nav-wf',
        name: 'Gate Navigation Workflow',
        version: 1,
        steps: {
          gate_step: {
            description: 'Gate step requiring human approval',
            execution: 'auto',
            trust: 'human_confirmed',
            depends_on: [],
          },
        },
      };
      const run = await store.create({
        workflowId: 'gate-nav-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, gateWorkflow, {
        runId: run.id,
        command: 'gate_step',
        input: {},
        dispatcher: echoDispatcher,
      });

      expect(envelope.status).toBe('confirm_required');
      expect(envelope.next_actions).toHaveLength(1);
      const gateAction = envelope.next_actions[0]!;
      expect(gateAction.instruction).not.toBeNull();
      expect(gateAction.instruction!.tool).toBe('submit_human_response');
      expect((gateAction.instruction!.params as Record<string, unknown>)['run_id']).toBe(run.id);
      expect((gateAction.instruction!.params as Record<string, unknown>)['gate_id']).toBe(
        envelope.gate!.gate_id,
      );
      expect(envelope.gate!.response_spec).toBeDefined();
      expect(envelope.gate!.response_spec!.choices).toContain('approve');
      expect(envelope.gate!.response_spec!.choices).toContain('reject');
      const callWith = gateAction.instruction!.call_with as Record<string, unknown>;
      expect(callWith['run_id']).toBe(run.id);
      expect(callWith['gate_id']).toBe(envelope.gate!.gate_id);
      expect(typeof callWith['choice']).toBe('string');
      expect((callWith['choice'] as string).startsWith('<')).toBe(true);
      expect((callWith['choice'] as string).includes('approve')).toBe(true);
      expect(envelope.context_hint).toContain('gate');
    });
  });

  // ---------------------------------------------------------------------------
  // gate owner propagation
  // ---------------------------------------------------------------------------

  describe('gate owner propagation', () => {
    it('propagates gate.owner from step definition into pending_gate.owner', async () => {
      const gateOwnerWorkflow: WorkflowDefinition = {
        id: 'gate-owner-wf',
        name: 'Gate Owner Workflow',
        version: 1,
        steps: {
          gate_step: {
            description: 'Gate step with owner',
            execution: 'auto',
            trust: 'human_confirmed',
            depends_on: [],
            gate: { choices: ['send', 'discard'], owner: '@mihai.lupu' },
          },
        },
      };

      const run = await store.create({
        workflowId: 'gate-owner-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, gateOwnerWorkflow, {
        runId: run.id,
        command: 'gate_step',
        input: {},
        dispatcher: echoDispatcher,
      });

      expect(envelope.status).toBe('confirm_required');
      const updatedRun = await store.get(run.id);
      expect(updatedRun.pending_gate?.owner).toBe('@mihai.lupu');
    });

    it('pending_gate.owner is undefined when gate has no owner', async () => {
      const gateNoOwnerWorkflow: WorkflowDefinition = {
        id: 'gate-no-owner-wf',
        name: 'Gate No Owner Workflow',
        version: 1,
        steps: {
          gate_step: {
            description: 'Gate step without owner',
            execution: 'auto',
            trust: 'human_confirmed',
            depends_on: [],
            gate: { choices: ['approve', 'reject'] },
          },
        },
      };

      const run = await store.create({
        workflowId: 'gate-no-owner-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, gateNoOwnerWorkflow, {
        runId: run.id,
        command: 'gate_step',
        input: {},
        dispatcher: echoDispatcher,
      });

      expect(envelope.status).toBe('confirm_required');
      const updatedRun = await store.get(run.id);
      expect(updatedRun.pending_gate?.owner).toBeUndefined();
    });
  });

  // Cleanup
  it('cleanup', async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('cleanup failure warning', () => {
    it('surfaces cleanup failure as warning when the failed-state store.update throws', async () => {
      const run = await store.create({
        workflowId: 'test-wf',
        workflowVersion: 1,
        params: {},
      });

      // Step claiming is now done via store.claimStep (not store.update), so the first
      // store.update call is the cleanup write that marks the run as failed.
      // Throw on every store.update call to simulate cleanup failure.
      const originalUpdate = store.update.bind(store);
      vi.spyOn(store, 'update').mockImplementation(async (_record) => {
        throw new Error('store write failed');
        return originalUpdate(_record);
      });

      try {
        const envelope = await executeStep(store, definition, {
          runId: run.id,
          command: 'step-one',
          input: {},
          dispatcher: failDispatcher,
        });

        expect(envelope.status).toBe('error');
        expect(envelope.errors[0]).toContain('step failed');
        expect(envelope.warnings).toHaveLength(1);
        expect(envelope.warnings[0]).toMatch(/Failed to persist step failure/);
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  describe('executeChain command override', () => {
    it('executeChain echoes the submitted command even when chaining into an auto gate step', async () => {
      const chainWorkflow: WorkflowDefinition = {
        id: 'chain-cmd-wf',
        name: 'Chain Command Workflow',
        version: 1,
        steps: {
          agent_step: {
            description: 'Agent step',
            execution: 'agent',
            depends_on: [],
          },
          auto_gate: {
            description: 'Auto gate step that follows agent_step',
            execution: 'auto',
            trust: 'human_confirmed',
            depends_on: ['agent_step'],
          },
        },
      };

      const run = await store.create({
        workflowId: 'chain-cmd-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeChain(store, chainWorkflow, {
        runId: run.id,
        command: 'agent_step',
        input: {},
        dispatcher: echoDispatcher,
      });

      // The agent submitted 'agent_step'; the chain ran into 'auto_gate' (gate).
      // The returned envelope's command must reflect the submitted step.
      expect(envelope.command).toBe('agent_step');
      // Inner step info is preserved via gate.
      expect(envelope.status).toBe('confirm_required');
      expect(envelope.gate!.step_name).toBe('auto_gate');
    });
  });

  describe('agent profile evidence', () => {
    it('agent step with resolved profile records agent_profile and agent_profile_hash in evidence', async () => {
      const profileHash = 'a'.repeat(64);
      const profiledWorkflow: WorkflowDefinition = {
        id: 'profile-wf',
        name: 'Profile Workflow',
        version: 1,
        steps: {
          profiled_step: {
            description: 'Profiled agent step',
            execution: 'agent',
            depends_on: [],
            agent_profile: 'my-profile',
          },
        },
        resolved_profiles: {
          'my-profile': { content: 'You are a specialist.', content_hash: profileHash },
        },
      };

      const run = await store.create({
        workflowId: 'profile-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, profiledWorkflow, {
        runId: run.id,
        command: 'profiled_step',
        input: { data: 'value' },
        dispatcher: echoDispatcher,
      });

      expect(envelope.status).toBe('ok');
      expect(envelope.evidence).toHaveLength(1);
      expect(envelope.evidence[0]?.agent_profile).toBe('my-profile');
      expect(envelope.evidence[0]?.agent_profile_hash).toBe(profileHash);
    });

    it('agent step without profile has no agent_profile on evidence', async () => {
      const run = await store.create({
        workflowId: 'test-wf',
        workflowVersion: 1,
        params: {},
      });

      // First run step-one so step-two is eligible
      await executeStep(store, definition, {
        runId: run.id,
        command: 'step-one',
        input: {},
        dispatcher: echoDispatcher,
      });

      const envelope = await executeStep(store, definition, {
        runId: run.id,
        command: 'step-two',
        input: { data: 'value' },
        dispatcher: echoDispatcher,
      });

      expect(envelope.status).toBe('ok');
      expect(envelope.evidence[0]?.agent_profile).toBeUndefined();
      expect(envelope.evidence[0]?.agent_profile_hash).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // gate.message template resolution
  // ---------------------------------------------------------------------------

  describe('gate.message template resolution', () => {
    it('fail-fast: returns stop error when gate.message contains an unresolvable reference', async () => {
      const gateMessageBrokenWf: WorkflowDefinition = {
        id: 'gate-msg-broken-wf',
        name: 'Gate Message Broken',
        version: 1,
        steps: {
          gate_step: {
            description: 'Gate step with broken message reference',
            execution: 'auto',
            trust: 'human_confirmed',
            depends_on: [],
            gate: {
              choices: ['approve', 'reject'],
              message: 'Count: {{ context.resources.gate_step.missing_field }}',
            },
          },
        },
      };

      const run = await store.create({
        workflowId: 'gate-msg-broken-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, gateMessageBrokenWf, {
        runId: run.id,
        command: 'gate_step',
        input: {},
        dispatcher: async () => ({}), // output has no missing_field
      });

      expect(envelope.status).toBe('error');
      expect(envelope.agent_action).toBe('stop');
      expect(envelope.errors[0]).toContain('gate.message has unresolvable references');
      expect(envelope.errors[0]).toContain('context.resources.gate_step.missing_field');

      // Gate must not be written to the store.
      const updatedRun = await store.get(run.id);
      expect(updatedRun.pending_gate).toBeUndefined();
    });

    it('happy path: gate.message with self-reference resolves and populates gate.display and resolved_message', async () => {
      const gateMessageWf: WorkflowDefinition = {
        id: 'gate-msg-happy-wf',
        name: 'Gate Message Happy',
        version: 1,
        steps: {
          gate_step: {
            description: 'Gate step with valid message self-reference',
            execution: 'auto',
            trust: 'human_confirmed',
            depends_on: [],
            gate: {
              choices: ['approve', 'reject'],
              message: 'Found: {{ context.resources.gate_step.count }}',
            },
          },
        },
      };

      const run = await store.create({
        workflowId: 'gate-msg-happy-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, gateMessageWf, {
        runId: run.id,
        command: 'gate_step',
        input: {},
        dispatcher: async () => ({ count: 7 }),
      });

      expect(envelope.status).toBe('confirm_required');
      expect(envelope.gate?.display).toBe('Found: 7');

      const updatedRun = await store.get(run.id);
      expect(updatedRun.pending_gate?.resolved_message).toBe('Found: 7');
    });

    it('evidence persistence: gate_message appears on gate_response snapshot and not in output blob', async () => {
      const gateMessageEvidenceWf: WorkflowDefinition = {
        id: 'gate-msg-evidence-wf',
        name: 'Gate Message Evidence',
        version: 1,
        steps: {
          gate_step: {
            description: 'Gate step for evidence test',
            execution: 'auto',
            trust: 'human_confirmed',
            depends_on: [],
            gate: {
              choices: ['approve', 'reject'],
              message: 'Found: {{ context.resources.gate_step.count }}',
            },
          },
        },
      };

      const run = await store.create({
        workflowId: 'gate-msg-evidence-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, gateMessageEvidenceWf, {
        runId: run.id,
        command: 'gate_step',
        input: {},
        dispatcher: async () => ({ count: 7 }),
      });

      expect(envelope.status).toBe('confirm_required');
      const gateId = envelope.gate!.gate_id;

      await submitHumanResponse(store, gateMessageEvidenceWf, {
        runId: run.id,
        gateId,
        choice: 'approve',
      });

      const finalRun = await store.get(run.id);
      const gateSnap = finalRun.evidence.find((e) => e.kind === 'gate_response');
      expect(gateSnap).toBeDefined();
      expect(gateSnap!.gate_message).toBe('Found: 7');
      // gate_message must NOT appear in the output blob.
      expect(gateSnap!.output_summary).not.toHaveProperty('gate_message');
    });

    it('no gate.message: pending_gate.resolved_message is absent and gate.display falls back to step.prompt', async () => {
      const gateNoMsgWf: WorkflowDefinition = {
        id: 'gate-no-msg-wf',
        name: 'Gate No Message',
        version: 1,
        steps: {
          gate_step: {
            description: 'Gate step without gate.message',
            execution: 'auto',
            trust: 'human_confirmed',
            depends_on: [],
            prompt: 'Prompt fallback',
            gate: { choices: ['approve', 'reject'] },
          },
        },
      };

      const run = await store.create({
        workflowId: 'gate-no-msg-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, gateNoMsgWf, {
        runId: run.id,
        command: 'gate_step',
        input: {},
        dispatcher: async () => ({}),
      });

      expect(envelope.status).toBe('confirm_required');
      expect(envelope.gate?.display).toBe('Prompt fallback');

      const updatedRun = await store.get(run.id);
      expect(updatedRun.pending_gate?.resolved_message).toBeUndefined();
    });

    it('no gate.message: gate_response evidence snapshot has no gate_message field', async () => {
      const gateNoMsgEvidenceWf: WorkflowDefinition = {
        id: 'gate-no-msg-ev-wf',
        name: 'Gate No Message Evidence',
        version: 1,
        steps: {
          gate_step: {
            description: 'Gate step without gate.message for evidence check',
            execution: 'auto',
            trust: 'human_confirmed',
            depends_on: [],
            gate: { choices: ['approve', 'reject'] },
          },
        },
      };

      const run = await store.create({
        workflowId: 'gate-no-msg-ev-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, gateNoMsgEvidenceWf, {
        runId: run.id,
        command: 'gate_step',
        input: {},
        dispatcher: async () => ({}),
      });

      expect(envelope.status).toBe('confirm_required');

      await submitHumanResponse(store, gateNoMsgEvidenceWf, {
        runId: run.id,
        gateId: envelope.gate!.gate_id,
        choice: 'approve',
      });

      const finalRun = await store.get(run.id);
      const gateSnap = finalRun.evidence.find((e) => e.kind === 'gate_response');
      expect(gateSnap).toBeDefined();
      expect(gateSnap!.gate_message).toBeUndefined();
    });

    it('gate.message present and step.prompt also present: gate.display uses gate.message not step.prompt', async () => {
      const gateMsgOverPromptWf: WorkflowDefinition = {
        id: 'gate-msg-over-prompt-wf',
        name: 'Gate Message Over Prompt',
        version: 1,
        steps: {
          gate_step: {
            description: 'Gate step with both message and prompt',
            execution: 'auto',
            trust: 'human_confirmed',
            depends_on: [],
            prompt: 'This is step.prompt text',
            gate: {
              choices: ['approve', 'reject'],
              message: 'This is gate.message text',
            },
          },
        },
      };

      const run = await store.create({
        workflowId: 'gate-msg-over-prompt-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, gateMsgOverPromptWf, {
        runId: run.id,
        command: 'gate_step',
        input: {},
        dispatcher: async () => ({}),
      });

      expect(envelope.status).toBe('confirm_required');
      expect(envelope.gate?.display).toBe('This is gate.message text');
      expect(envelope.gate?.display).not.toContain('step.prompt');
    });
  });

  // ---------------------------------------------------------------------------
  // trace — A1 contract hardening
  // ---------------------------------------------------------------------------

  describe('trace', () => {
    it('agent step stores canonical trace with seq numbers in evidence', async () => {
      const agentDefinition: WorkflowDefinition = {
        ...definition,
        id: 'trace-agent-wf',
        steps: {
          ...definition.steps,
          'step-one': { ...definition.steps['step-one']!, execution: 'agent', depends_on: [] },
        },
      };

      const run = await store.create({
        workflowId: 'trace-agent-wf',
        workflowVersion: 1,
        params: {},
      });
      const envelope = await executeStep(store, agentDefinition, {
        runId: run.id,
        command: 'step-one',
        input: { result: 'done' },
        dispatcher: echoDispatcher,
        trace: [
          { event: 'tool_called', data: { name: 'read_file' } },
          { event: 'tool_result', data: { status: 'ok' } },
        ],
      });

      expect(envelope.status).toBe('ok');
      const snap = envelope.evidence[0];
      expect(snap?.trace).toBeDefined();
      expect(snap?.trace).toHaveLength(2);
      expect(snap?.trace![0]!.seq).toBe(1);
      expect(snap?.trace![0]!.event).toBe('tool_called');
      expect(snap?.trace![1]!.seq).toBe(2);
      expect(snap?.trace_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(snap?.trace_summary?.stored_entries).toBe(2);
      expect(snap?.trace_summary?.truncated).toBe(false);
    });

    it('non-agent step silently drops provided trace', async () => {
      // step-one is execution: 'auto' in the default definition
      const run = await store.create({ workflowId: 'test-wf', workflowVersion: 1, params: {} });
      const envelope = await executeStep(store, definition, {
        runId: run.id,
        command: 'step-one',
        input: {},
        dispatcher: echoDispatcher,
        trace: [{ event: 'should_be_dropped' }],
      });

      expect(envelope.status).toBe('ok');
      const snap = envelope.evidence[0];
      expect(snap?.trace).toBeUndefined();
      expect(snap?.trace_digest).toBeUndefined();
      expect(snap?.trace_summary).toBeUndefined();
    });

    it('reserved "trace." prefix entries are dropped from agent trace', async () => {
      const agentDefinition: WorkflowDefinition = {
        ...definition,
        id: 'trace-reserved-wf',
        steps: {
          ...definition.steps,
          'step-one': { ...definition.steps['step-one']!, execution: 'agent', depends_on: [] },
        },
      };

      const run = await store.create({
        workflowId: 'trace-reserved-wf',
        workflowVersion: 1,
        params: {},
      });
      const envelope = await executeStep(store, agentDefinition, {
        runId: run.id,
        command: 'step-one',
        input: { r: 1 },
        dispatcher: echoDispatcher,
        trace: [
          { event: 'trace.internal_engine_event' },
          { event: 'trace.another_reserved' },
          { event: 'user_event' },
        ],
      });

      const snap = envelope.evidence[0];
      expect(snap?.trace).toHaveLength(1);
      expect(snap?.trace![0]!.event).toBe('user_event');
      expect(snap?.trace_summary?.discarded_reserved_event_entries).toBe(2);
    });

    it('count limit produces single sentinel with accurate summary', async () => {
      const agentDefinition: WorkflowDefinition = {
        ...definition,
        id: 'trace-count-wf',
        steps: {
          ...definition.steps,
          'step-one': { ...definition.steps['step-one']!, execution: 'agent', depends_on: [] },
        },
      };

      const run = await store.create({
        workflowId: 'trace-count-wf',
        workflowVersion: 1,
        params: {},
      });
      const manyEntries = Array.from({ length: 105 }, (_, i) => ({ event: `ev_${i}` }));
      const envelope = await executeStep(store, agentDefinition, {
        runId: run.id,
        command: 'step-one',
        input: { r: 1 },
        dispatcher: echoDispatcher,
        trace: manyEntries,
      });

      const snap = envelope.evidence[0];
      // 100 real entries + 1 sentinel
      expect(snap?.trace).toHaveLength(101);
      expect(snap?.trace![100]!.event).toBe('trace.truncated');
      expect(snap?.trace_summary?.truncated).toBe(true);
      expect(snap?.trace_summary?.truncation_reason).toBe('count_limit');
      expect(snap?.trace_summary?.discarded_overflow_entries).toBe(5);
    });

    it('evidence_hash is unchanged when trace changes but output is identical', async () => {
      const agentDefinition: WorkflowDefinition = {
        ...definition,
        id: 'trace-hash-stable-wf',
        steps: {
          ...definition.steps,
          'step-one': { ...definition.steps['step-one']!, execution: 'agent', depends_on: [] },
        },
      };

      const run1 = await store.create({
        workflowId: 'trace-hash-stable-wf',
        workflowVersion: 1,
        params: {},
      });
      const e1 = await executeStep(store, agentDefinition, {
        runId: run1.id,
        command: 'step-one',
        input: { result: 'same_output' },
        dispatcher: echoDispatcher,
        trace: [{ event: 'trace_a' }],
      });

      const run2 = await store.create({
        workflowId: 'trace-hash-stable-wf',
        workflowVersion: 1,
        params: {},
      });
      const e2 = await executeStep(store, agentDefinition, {
        runId: run2.id,
        command: 'step-one',
        input: { result: 'same_output' },
        dispatcher: echoDispatcher,
        trace: [{ event: 'trace_b' }],
      });

      expect(e1.evidence[0]?.evidence_hash).toBe(e2.evidence[0]?.evidence_hash);
      expect(e1.evidence[0]?.trace_digest).not.toBe(e2.evidence[0]?.trace_digest);
    });

    it('trace_digest differs when canonical trace differs', async () => {
      const agentDefinition: WorkflowDefinition = {
        ...definition,
        id: 'trace-digest-diff-wf',
        steps: {
          ...definition.steps,
          'step-one': { ...definition.steps['step-one']!, execution: 'agent', depends_on: [] },
        },
      };

      const run1 = await store.create({
        workflowId: 'trace-digest-diff-wf',
        workflowVersion: 1,
        params: {},
      });
      const e1 = await executeStep(store, agentDefinition, {
        runId: run1.id,
        command: 'step-one',
        input: { r: 1 },
        dispatcher: echoDispatcher,
        trace: [{ event: 'alpha' }],
      });

      const run2 = await store.create({
        workflowId: 'trace-digest-diff-wf',
        workflowVersion: 1,
        params: {},
      });
      const e2 = await executeStep(store, agentDefinition, {
        runId: run2.id,
        command: 'step-one',
        input: { r: 1 },
        dispatcher: echoDispatcher,
        trace: [{ event: 'beta' }],
      });

      expect(e1.evidence[0]?.trace_digest).toBeDefined();
      expect(e2.evidence[0]?.trace_digest).toBeDefined();
      expect(e1.evidence[0]?.trace_digest).not.toBe(e2.evidence[0]?.trace_digest);
    });

    // ─── trace_schema validation (A2) ──────────────────────────────────────

    const traceSchemaDefinitionBase: WorkflowDefinition = {
      ...definition,
      id: 'trace-schema-wf',
      steps: {
        ...definition.steps,
        'step-one': {
          ...definition.steps['step-one']!,
          execution: 'agent',
          depends_on: [],
          trace_schema: {
            type: 'array',
            items: {
              type: 'object',
              required: ['seq', 'event'],
              properties: {
                seq: { type: 'number' },
                event: { type: 'string', pattern: '^[a-z_]+$' },
              },
            },
          },
        },
      },
    };

    it('trace_schema enforce: invalid trace blocks pre-claim and is re-submittable', async () => {
      const def: WorkflowDefinition = {
        ...traceSchemaDefinitionBase,
        steps: {
          ...traceSchemaDefinitionBase.steps,
          'step-one': {
            ...traceSchemaDefinitionBase.steps['step-one']!,
            trace_validation_mode: 'enforce',
          },
        },
      };
      const dispatchCalled = vi.fn();
      const spy: StepDispatcher = async (step, input, run, signal) => {
        dispatchCalled();
        return echoDispatcher(step, input, run, signal);
      };

      const run = await store.create({
        workflowId: 'trace-schema-wf',
        workflowVersion: 1,
        params: {},
      });

      // Invalid trace: event contains uppercase letters (fails pattern '^[a-z_]+$')
      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'step-one',
        input: { result: 'done' },
        dispatcher: spy,
        trace: [{ event: 'InvalidEvent' }],
      });

      expect(envelope.status).toBe('error');
      expect(envelope.agent_action).toBe('provide_input');
      expect(dispatchCalled).not.toHaveBeenCalled();
      // Step not claimed — it is still eligible and in next_actions
      expect(envelope.next_actions).toHaveLength(1);
      const runAfter = await store.get(run.id);
      expect(runAfter.in_progress_steps).not.toContain('step-one');
    });

    it('trace_schema enforce: re-submittable after failure (step never claimed)', async () => {
      const def: WorkflowDefinition = {
        ...traceSchemaDefinitionBase,
        steps: {
          ...traceSchemaDefinitionBase.steps,
          'step-one': {
            ...traceSchemaDefinitionBase.steps['step-one']!,
            trace_validation_mode: 'enforce',
          },
        },
      };

      const run = await store.create({
        workflowId: 'trace-schema-wf',
        workflowVersion: 1,
        params: {},
      });

      // First call — invalid trace
      const first = await executeStep(store, def, {
        runId: run.id,
        command: 'step-one',
        input: { result: 'done' },
        dispatcher: echoDispatcher,
        trace: [{ event: 'BadEvent' }],
      });
      expect(first.status).toBe('error');

      // Second call — valid trace (all lowercase)
      const second = await executeStep(store, def, {
        runId: run.id,
        command: 'step-one',
        input: { result: 'done' },
        dispatcher: echoDispatcher,
        trace: [{ event: 'good_event' }],
      });
      expect(second.status).toBe('ok');
    });

    it('trace_schema warn: invalid trace does not block step, warning returned in envelope', async () => {
      const def: WorkflowDefinition = {
        ...traceSchemaDefinitionBase,
        steps: {
          ...traceSchemaDefinitionBase.steps,
          'step-one': {
            ...traceSchemaDefinitionBase.steps['step-one']!,
            trace_validation_mode: 'warn',
          },
        },
      };

      const run = await store.create({
        workflowId: 'trace-schema-wf',
        workflowVersion: 1,
        params: {},
      });

      // Invalid trace — but warn mode so step succeeds
      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'step-one',
        input: { result: 'done' },
        dispatcher: echoDispatcher,
        trace: [{ event: 'BadEvent' }],
      });

      expect(envelope.status).toBe('ok');
      expect(envelope.warnings).toHaveLength(1);
      expect(envelope.warnings[0]).toContain('step-one');
    });

    it('trace_schema warn: valid trace passes with no warnings', async () => {
      const def: WorkflowDefinition = {
        ...traceSchemaDefinitionBase,
        steps: {
          ...traceSchemaDefinitionBase.steps,
          'step-one': {
            ...traceSchemaDefinitionBase.steps['step-one']!,
            trace_validation_mode: 'warn',
          },
        },
      };

      const run = await store.create({
        workflowId: 'trace-schema-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'step-one',
        input: { result: 'done' },
        dispatcher: echoDispatcher,
        trace: [{ event: 'good_event' }],
      });

      expect(envelope.status).toBe('ok');
      expect(envelope.warnings).toHaveLength(0);
    });

    it('trace_schema: schema_applied and validation metadata recorded in trace_summary', async () => {
      const def: WorkflowDefinition = {
        ...traceSchemaDefinitionBase,
        steps: {
          ...traceSchemaDefinitionBase.steps,
          'step-one': {
            ...traceSchemaDefinitionBase.steps['step-one']!,
            trace_validation_mode: 'enforce',
          },
        },
      };

      const run = await store.create({
        workflowId: 'trace-schema-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'step-one',
        input: { result: 'done' },
        dispatcher: echoDispatcher,
        trace: [{ event: 'good_event' }],
      });

      expect(envelope.status).toBe('ok');
      const summary = envelope.evidence[0]?.trace_summary;
      expect(summary?.schema_applied).toBe(true);
      expect(summary?.validation_mode).toBe('enforce');
      expect(summary?.validation_errors).toBe(0);
    });

    it('trace_schema default mode is warn when trace_schema set but mode omitted', async () => {
      // traceSchemaDefinitionBase has trace_schema but no trace_validation_mode
      const run = await store.create({
        workflowId: 'trace-schema-wf',
        workflowVersion: 1,
        params: {},
      });

      // Submit invalid trace — default warn mode should not block
      const envelope = await executeStep(store, traceSchemaDefinitionBase, {
        runId: run.id,
        command: 'step-one',
        input: { result: 'done' },
        dispatcher: echoDispatcher,
        trace: [{ event: 'BadEvent' }],
      });

      expect(envelope.status).toBe('ok');
      expect(envelope.warnings).toHaveLength(1);
    });

    it('trace_schema warn: claim-error envelope includes trace warning', async () => {
      const def: WorkflowDefinition = {
        ...traceSchemaDefinitionBase,
        steps: {
          ...traceSchemaDefinitionBase.steps,
          'step-one': {
            ...traceSchemaDefinitionBase.steps['step-one']!,
            trace_validation_mode: 'warn',
          },
        },
      };

      const run = await store.create({
        workflowId: 'trace-schema-wf',
        workflowVersion: 1,
        params: {},
      });

      // Mock claimStep to throw after step 2d validation has already produced a warning
      vi.spyOn(store, 'claimStep').mockRejectedValue(
        new WorkflowError('claim failed', {
          code: 'ENGINE_STORE_FAILED',
          category: 'ENGINE',
          agentAction: 'stop',
          retryable: false,
        }),
      );

      try {
        const envelope = await executeStep(store, def, {
          runId: run.id,
          command: 'step-one',
          input: { result: 'done' },
          dispatcher: echoDispatcher,
          trace: [{ event: 'BadEvent' }],
        });

        expect(envelope.status).toBe('error');
        expect(envelope.warnings).toHaveLength(1);
        expect(envelope.warnings[0]).toContain('step-one');
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('trace_schema warn: dispatch-error envelope includes trace warning', async () => {
      const def: WorkflowDefinition = {
        ...traceSchemaDefinitionBase,
        steps: {
          ...traceSchemaDefinitionBase.steps,
          'step-one': {
            ...traceSchemaDefinitionBase.steps['step-one']!,
            trace_validation_mode: 'warn',
          },
        },
      };

      const run = await store.create({
        workflowId: 'trace-schema-wf',
        workflowVersion: 1,
        params: {},
      });

      // Invalid trace (warn mode) + failing dispatcher — trace warning must survive dispatch failure
      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'step-one',
        input: { result: 'done' },
        dispatcher: failDispatcher,
        trace: [{ event: 'BadEvent' }],
      });

      expect(envelope.status).toBe('error');
      expect(envelope.errors[0]).toContain('step failed');
      expect(envelope.warnings).toHaveLength(1);
      expect(envelope.warnings[0]).toContain('step-one');
    });

    it('trace_schema warn: confirm-required envelope includes trace warning', async () => {
      const def: WorkflowDefinition = {
        ...traceSchemaDefinitionBase,
        steps: {
          ...traceSchemaDefinitionBase.steps,
          'step-one': {
            ...traceSchemaDefinitionBase.steps['step-one']!,
            trace_validation_mode: 'warn',
            trust: 'human_confirmed' as const,
          },
        },
      };

      const run = await store.create({
        workflowId: 'trace-schema-wf',
        workflowVersion: 1,
        params: {},
      });

      // Invalid trace (warn mode) — step has trust: human_confirmed so returns confirm_required
      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'step-one',
        input: { result: 'done' },
        dispatcher: echoDispatcher,
        trace: [{ event: 'BadEvent' }],
      });

      expect(envelope.status).toBe('confirm_required');
      expect(envelope.warnings).toHaveLength(1);
      expect(envelope.warnings[0]).toContain('step-one');
    });

    it('trace_schema warn: both trace warning and cleanup warning appear when dispatch fails and store.update throws', async () => {
      const def: WorkflowDefinition = {
        ...traceSchemaDefinitionBase,
        steps: {
          ...traceSchemaDefinitionBase.steps,
          'step-one': {
            ...traceSchemaDefinitionBase.steps['step-one']!,
            trace_validation_mode: 'warn',
          },
        },
      };

      const run = await store.create({
        workflowId: 'trace-schema-wf',
        workflowVersion: 1,
        params: {},
      });

      // Mock store.update to throw — simulates cleanup write failure
      vi.spyOn(store, 'update').mockImplementation(async () => {
        throw new Error('store write failed');
      });

      try {
        const envelope = await executeStep(store, def, {
          runId: run.id,
          command: 'step-one',
          input: { result: 'done' },
          dispatcher: failDispatcher,
          trace: [{ event: 'BadEvent' }],
        });

        expect(envelope.status).toBe('error');
        expect(envelope.warnings).toHaveLength(2);
        // Trace warning first (deterministic order), cleanup warning second
        expect(envelope.warnings[0]).toContain('step-one');
        expect(envelope.warnings[1]).toMatch(/Failed to persist step failure/);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('trace_schema warn: gate store.update error envelope retains trace warning', async () => {
      const def: WorkflowDefinition = {
        ...traceSchemaDefinitionBase,
        steps: {
          ...traceSchemaDefinitionBase.steps,
          'step-one': {
            ...traceSchemaDefinitionBase.steps['step-one']!,
            trace_validation_mode: 'warn',
            trust: 'human_confirmed' as const,
          },
        },
      };

      const run = await store.create({
        workflowId: 'trace-schema-wf',
        workflowVersion: 1,
        params: {},
      });

      // Mock store.update to throw — simulates the gate persistence failure (post-dispatch)
      vi.spyOn(store, 'update').mockImplementation(async () => {
        throw new Error('gate store write failed');
      });

      try {
        const envelope = await executeStep(store, def, {
          runId: run.id,
          command: 'step-one',
          input: { result: 'done' },
          dispatcher: echoDispatcher,
          trace: [{ event: 'BadEvent' }],
        });

        expect(envelope.status).toBe('error');
        expect(envelope.warnings).toHaveLength(1);
        expect(envelope.warnings[0]).toContain('step-one');
      } finally {
        vi.restoreAllMocks();
      }
    });
  });
});

describe('WAL trace buffer integration (B-lite)', () => {
  let store: JsonFileStore;
  let dir: string;

  const agentDef: WorkflowDefinition = {
    id: 'wal-test-wf',
    name: 'WAL Test Workflow',
    version: 1,
    steps: {
      'step-agent': {
        description: 'Agent step',
        execution: 'agent',
        depends_on: [],
      },
    },
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-wal-test-'));
    store = new JsonFileStore(dir);
  });

  it('WAL entries present + no execute_step.trace → evidence has trace from WAL', async () => {
    const bufferStore = new InMemoryTraceBufferStore();
    const run = await store.create({ workflowId: 'wal-test-wf', workflowVersion: 1, params: {} });

    await bufferStore.append(run.id, 'step-agent', [
      { event: 'wal_event', data: { phase: 'pre' } },
    ]);

    const envelope = await executeStep(store, agentDef, {
      runId: run.id,
      command: 'step-agent',
      input: { result: 'done' },
      dispatcher: async () => ({ result: 'done' }),
      traceBufferStore: bufferStore,
    });

    expect(envelope.status).toBe('ok');
    const snap = envelope.evidence[0];
    expect(snap?.trace).toHaveLength(1);
    expect(snap?.trace?.[0]?.event).toBe('wal_event');
  });

  it('WAL entries + execute_step.trace entries → merged, WAL entries first', async () => {
    const bufferStore = new InMemoryTraceBufferStore();
    const run = await store.create({ workflowId: 'wal-test-wf', workflowVersion: 1, params: {} });

    await bufferStore.append(run.id, 'step-agent', [{ event: 'wal_first' }]);

    const envelope = await executeStep(store, agentDef, {
      runId: run.id,
      command: 'step-agent',
      input: {},
      dispatcher: async () => ({}),
      traceBufferStore: bufferStore,
      trace: [{ event: 'final_last' }],
    });

    expect(envelope.status).toBe('ok');
    const snap = envelope.evidence[0];
    expect(snap?.trace).toHaveLength(2);
    // WAL entry should have lower seq than the final entry.
    const walEntry = snap?.trace?.find((e) => e.event === 'wal_first');
    const finalEntry = snap?.trace?.find((e) => e.event === 'final_last');
    expect(walEntry?.seq).toBeDefined();
    expect(finalEntry?.seq).toBeDefined();
    expect(walEntry!.seq).toBeLessThan(finalEntry!.seq);
  });

  it('enforce-mode schema rejection → WAL preserved after rejection', async () => {
    const schemaEnforceDef: WorkflowDefinition = {
      id: 'wal-schema-wf',
      name: 'WAL Schema Workflow',
      version: 1,
      steps: {
        'step-agent': {
          description: 'Agent step with trace schema',
          execution: 'agent',
          depends_on: [],
          trace_schema: {
            type: 'array',
            items: { type: 'object', required: ['event', 'myField'] },
          },
          trace_validation_mode: 'enforce',
        },
      },
    };

    const bufferStore = new InMemoryTraceBufferStore();
    const run = await store.create({ workflowId: 'wal-schema-wf', workflowVersion: 1, params: {} });

    await bufferStore.append(run.id, 'step-agent', [{ event: 'buffered' }]);

    // Submit an execute_step call with a trace entry missing required 'myField' → schema enforcement fails.
    const envelope = await executeStep(store, schemaEnforceDef, {
      runId: run.id,
      command: 'step-agent',
      input: {},
      dispatcher: async () => ({}),
      traceBufferStore: bufferStore,
      trace: [{ event: 'bad_entry' }],
    });

    // Should return an error due to schema enforcement.
    expect(envelope.status).toBe('error');

    // WAL must be preserved — agent can retry.
    const remaining = await bufferStore.read(run.id, 'step-agent');
    expect(remaining.length).toBeGreaterThan(0);
  });

  it('execute_step succeeds → WAL is deleted', async () => {
    const bufferStore = new InMemoryTraceBufferStore();
    const run = await store.create({ workflowId: 'wal-test-wf', workflowVersion: 1, params: {} });

    await bufferStore.append(run.id, 'step-agent', [{ event: 'pre_step' }]);

    const envelope = await executeStep(store, agentDef, {
      runId: run.id,
      command: 'step-agent',
      input: {},
      dispatcher: async () => ({}),
      traceBufferStore: bufferStore,
    });

    expect(envelope.status).toBe('ok');
    const remaining = await bufferStore.read(run.id, 'step-agent');
    expect(remaining).toHaveLength(0);
  });

  it('execute_step dispatch fails → WAL is deleted', async () => {
    const bufferStore = new InMemoryTraceBufferStore();
    const run = await store.create({ workflowId: 'wal-test-wf', workflowVersion: 1, params: {} });

    await bufferStore.append(run.id, 'step-agent', [{ event: 'pre_fail' }]);

    const envelope = await executeStep(store, agentDef, {
      runId: run.id,
      command: 'step-agent',
      input: {},
      dispatcher: async () => {
        throw new WorkflowError('Simulated dispatch failure', {
          code: 'ENGINE_HANDLER_FAILED',
          category: 'ENGINE',
          agentAction: 'stop',
          retryable: false,
        });
      },
      traceBufferStore: bufferStore,
    });

    expect(envelope.status).toBe('error');
    const remaining = await bufferStore.read(run.id, 'step-agent');
    expect(remaining).toHaveLength(0);
  });

  it('no traceBufferStore configured → behaviour identical to pre-B-lite (regression)', async () => {
    const run = await store.create({ workflowId: 'wal-test-wf', workflowVersion: 1, params: {} });

    const envelope = await executeStep(store, agentDef, {
      runId: run.id,
      command: 'step-agent',
      input: {},
      dispatcher: async () => ({}),
      trace: [{ event: 'direct_trace' }],
      // No traceBufferStore — pre-B-lite path.
    });

    expect(envelope.status).toBe('ok');
    const snap = envelope.evidence[0];
    expect(snap?.trace).toHaveLength(1);
    expect(snap?.trace?.[0]?.event).toBe('direct_trace');
  });
});
