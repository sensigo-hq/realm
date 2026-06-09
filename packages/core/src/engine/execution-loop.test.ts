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

    it('calls adapter.delete() when service_method is delete', async () => {
      const adapter: ServiceAdapter = {
        id: 'mock_adapter',
        fetch: vi.fn().mockResolvedValue({ status: 200, data: {} }),
        create: vi.fn().mockResolvedValue({ status: 201, data: {} }),
        update: vi.fn().mockResolvedValue({ status: 200, data: {} }),
        delete: vi.fn().mockResolvedValue({ status: 204, data: {} }),
      };
      const registry = new ExtensionRegistry();
      registry.register('adapter', 'mock_adapter', adapter);

      const def: WorkflowDefinition = {
        ...adapterDefinition,
        steps: {
          fetch_data: {
            ...adapterDefinition.steps['fetch_data']!,
            service_method: 'delete',
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
      expect(adapter.delete).toHaveBeenCalledTimes(1);
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

    it('passes no extra keys in config when step has no config field', async () => {
      const adapter = makeAdapter({ result: 'ok' });
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

      const receivedConfig = (adapter.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[2] as Record<string, unknown>;
      expect(Object.keys(receivedConfig).sort()).toEqual(['adapter', 'trust']);
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

    it('throw still fails — handler that throws produces run_phase: failed', async () => {
      const handler: StepHandler = {
        id: 'my_handler',
        execute: vi.fn().mockRejectedValue(new Error('unexpected crash')),
      };
      const registry = new ExtensionRegistry();
      registry.register('handler', 'my_handler', handler);

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
      const updatedRun = await store.get(run.id);
      expect(updatedRun.run_phase).toBe('failed');
      expect(updatedRun.failed_steps).toContain('validate');
    });

    it('data-only result unchanged — handler returning { data } completes normally', async () => {
      const handler = makeHandler({ processed: true });
      const registry = new ExtensionRegistry();
      registry.register('handler', 'my_handler', handler);

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

      expect(envelope.status).toBe('ok');
      expect(envelope.data).toEqual({ processed: true });
      const updatedRun = await store.get(run.id);
      expect(updatedRun.run_phase).toBe('completed');
      expect(updatedRun.completed_steps).toContain('validate');
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 71 — handler abort and warn
  // ---------------------------------------------------------------------------

  describe('handler abort and warn (Phase 71)', () => {
    const abortWarnDef: WorkflowDefinition = {
      id: 'abort-warn-wf',
      name: 'Abort Warn Workflow',
      version: 1,
      steps: {
        check: {
          description: 'Check step',
          execution: 'auto',
          depends_on: [],
          handler: 'check_handler',
        },
        downstream: {
          description: 'Downstream agent step',
          execution: 'agent',
          depends_on: ['check'],
        },
      },
    };

    it('handler returning abort transitions run to run_phase: aborted with step in completed_steps', async () => {
      const handler: StepHandler = {
        id: 'check_handler',
        execute: vi.fn().mockResolvedValue({ abort: { message: 'ticket is closed' } }),
      };
      const registry = new ExtensionRegistry();
      registry.register('handler', 'check_handler', handler);
      const run = await store.create({
        workflowId: 'abort-warn-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, abortWarnDef, {
        runId: run.id,
        command: 'check',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      expect(envelope.status).toBe('ok');
      expect(envelope.next_actions).toHaveLength(0);
      expect(envelope.context_hint).toContain('aborted');

      const updatedRun = await store.get(run.id);
      expect(updatedRun.run_phase).toBe('aborted');
      expect(updatedRun.completed_steps).toContain('check');
      expect(updatedRun.failed_steps).not.toContain('check');
      expect(updatedRun.aborted_at?.step_id).toBe('check');
      expect(updatedRun.aborted_at?.abort_message).toBe('ticket is closed');
    });

    it('handler abort sets terminal_state — downstream steps never execute', async () => {
      const handler: StepHandler = {
        id: 'check_handler',
        execute: vi.fn().mockResolvedValue({ abort: { message: 'already done' } }),
      };
      const registry = new ExtensionRegistry();
      registry.register('handler', 'check_handler', handler);
      const run = await store.create({
        workflowId: 'abort-warn-wf',
        workflowVersion: 1,
        params: {},
      });

      await executeStep(store, abortWarnDef, {
        runId: run.id,
        command: 'check',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      const updatedRun = await store.get(run.id);
      expect(updatedRun.terminal_state).toBe(true);
      expect(updatedRun.run_phase).toBe('aborted');
      expect(updatedRun.completed_steps).toContain('check');
    });

    it('handler returning warn results in EvidenceSnapshot.warn and ResponseEnvelope.warnings', async () => {
      const handler: StepHandler = {
        id: 'check_handler',
        execute: vi
          .fn()
          .mockResolvedValue({ data: { result: 'ok' }, warn: { message: 'quota at 95%' } }),
      };
      const registry = new ExtensionRegistry();
      registry.register('handler', 'check_handler', handler);
      const run = await store.create({
        workflowId: 'abort-warn-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, abortWarnDef, {
        runId: run.id,
        command: 'check',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      expect(envelope.status).toBe('ok');
      expect(envelope.warnings).toEqual(['quota at 95%']);

      const updatedRun = await store.get(run.id);
      expect(updatedRun.run_phase).toBe('running');
      expect(updatedRun.completed_steps).toContain('check');

      const snap = updatedRun.evidence.find((e) => e.step_id === 'check');
      expect(snap?.warn).toBe('quota at 95%');
    });

    it('warned step with retry.max_attempts: 3 does not retry — completes on first warn', async () => {
      const warnRetryDef: WorkflowDefinition = {
        id: 'warn-retry-wf',
        name: 'Warn Retry',
        version: 1,
        steps: {
          check: {
            description: 'Check with retry',
            execution: 'auto',
            depends_on: [],
            handler: 'check_handler',
            retry: { max_attempts: 3, backoff: 'fixed', base_delay_ms: 0 },
          },
        },
      };
      let callCount = 0;
      const handler: StepHandler = {
        id: 'check_handler',
        execute: vi.fn().mockImplementation(async () => {
          callCount++;
          return { data: { done: true }, warn: { message: 'degraded' } };
        }),
      };
      const registry = new ExtensionRegistry();
      registry.register('handler', 'check_handler', handler);
      const run = await store.create({
        workflowId: 'warn-retry-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, warnRetryDef, {
        runId: run.id,
        command: 'check',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      expect(envelope.status).toBe('ok');
      expect(envelope.warnings).toEqual(['degraded']);
      expect(callCount).toBe(1);
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
  });
});

// ---------------------------------------------------------------------------
// Step 5 dispatch-failure envelope — agent_action, next_actions, run_version
// ---------------------------------------------------------------------------

describe('Step 5 dispatch-failure envelope', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-step5-test-'));
    store = new JsonFileStore(dir);
  });

  // Two-step workflow: step_a (agent) → step_b (agent, trigger_rule: one_failed).
  const twoStepDef: WorkflowDefinition = {
    id: 'two-step-wf',
    name: 'Two Step Workflow',
    version: 1,
    steps: {
      step_a: {
        description: 'First step',
        execution: 'agent',
        depends_on: [],
      },
      step_b: {
        description: 'Recovery step',
        execution: 'agent',
        depends_on: ['step_a'],
        trigger_rule: 'one_failed',
      },
    },
  };

  it('terminal failure always returns stop with empty next_actions', async () => {
    // Single-step workflow — no recovery branch possible.
    const singleStepDef: WorkflowDefinition = {
      id: 'single-step-wf',
      name: 'Single Step Workflow',
      version: 1,
      steps: {
        step_a: {
          description: 'Only step',
          execution: 'agent',
          depends_on: [],
        },
      },
    };

    const run = await store.create({
      workflowId: 'single-step-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeStep(store, singleStepDef, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: async () => {
        throw new WorkflowError('Service unavailable', {
          code: 'SERVICE_HTTP_5XX',
          category: 'SERVICE',
          agentAction: 'wait_for_human',
          retryable: false,
        });
      },
    });

    expect(envelope.status).toBe('error');
    expect(envelope.agent_action).toBe('stop');
    expect(envelope.next_actions).toHaveLength(0);
  });

  it('non-terminal failure with wait_for_human exposes recovery branch', async () => {
    const run = await store.create({
      workflowId: 'two-step-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeStep(store, twoStepDef, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: async () => {
        throw new WorkflowError('Service unavailable', {
          code: 'SERVICE_HTTP_5XX',
          category: 'SERVICE',
          agentAction: 'wait_for_human',
          retryable: false,
        });
      },
    });

    expect(envelope.status).toBe('error');
    expect(envelope.agent_action).toBe('wait_for_human');
    expect(envelope.next_actions.length).toBeGreaterThanOrEqual(1);
    expect(envelope.next_actions[0]?.instruction.call_with.command).toBe('step_b');
    expect(
      envelope.context_hint.toLowerCase().includes('service') ||
        envelope.context_hint.toLowerCase().includes('recovery'),
    ).toBe(true);
  });

  it('non-terminal failure with provide_input is translated to report_to_user and exposes recovery branch', async () => {
    const run = await store.create({
      workflowId: 'two-step-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeStep(store, twoStepDef, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: async () => {
        throw new WorkflowError('Adapter method not supported', {
          code: 'ADAPTER_OP_UNSUPPORTED',
          category: 'SERVICE',
          agentAction: 'provide_input',
          retryable: false,
        });
      },
    });

    expect(envelope.status).toBe('error');
    expect(envelope.agent_action).toBe('report_to_user');
    expect(envelope.next_actions.length).toBeGreaterThanOrEqual(1);
    expect(envelope.next_actions[0]?.instruction.call_with.command).toBe('step_b');
  });

  it('non-terminal failure with stop is translated to report_to_user and exposes recovery branch', async () => {
    const run = await store.create({
      workflowId: 'two-step-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeStep(store, twoStepDef, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: async () => {
        throw new WorkflowError('Authentication failed', {
          code: 'SERVICE_AUTH_FAILED',
          category: 'SERVICE',
          agentAction: 'stop',
          retryable: false,
        });
      },
    });

    expect(envelope.status).toBe('error');
    expect(envelope.agent_action).toBe('report_to_user');
    expect(envelope.next_actions.length).toBeGreaterThanOrEqual(1);
  });

  it('WAL deletion failure does NOT suppress next_actions', async () => {
    const bufferStore = new InMemoryTraceBufferStore();
    vi.spyOn(bufferStore, 'delete').mockRejectedValue(new Error('disk contention'));

    const run = await store.create({
      workflowId: 'two-step-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeStep(store, twoStepDef, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: async () => {
        throw new WorkflowError('Service unavailable', {
          code: 'SERVICE_HTTP_5XX',
          category: 'SERVICE',
          agentAction: 'wait_for_human',
          retryable: false,
        });
      },
      traceBufferStore: bufferStore,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.agent_action).toBe('wait_for_human');
    expect(envelope.next_actions.length).toBeGreaterThanOrEqual(1);
    expect(
      envelope.warnings.some(
        (w) => w.toLowerCase().includes('trace') || w.toLowerCase().includes('buffer'),
      ),
    ).toBe(true);
  });

  it('store.update failure suppresses next_actions', async () => {
    const run = await store.create({
      workflowId: 'two-step-wf',
      workflowVersion: 1,
      params: {},
    });

    // claimStep uses its own atomic file-lock write and does not call store.update,
    // so spying on store.update only intercepts the Step 5 store.update(failedRun) call.
    vi.spyOn(store, 'update').mockRejectedValue(new Error('disk full'));

    const envelope = await executeStep(store, twoStepDef, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: async () => {
        throw new WorkflowError('Service unavailable', {
          code: 'SERVICE_HTTP_5XX',
          category: 'SERVICE',
          agentAction: 'wait_for_human',
          retryable: false,
        });
      },
    });

    expect(envelope.status).toBe('error');
    expect(envelope.agent_action).toBe('wait_for_human');
    expect(envelope.next_actions).toHaveLength(0);
    expect(envelope.warnings.some((w) => w.toLowerCase().includes('persist'))).toBe(true);
  });

  it('run_version reflects persisted version not stale pre-persist version', async () => {
    const run = await store.create({
      workflowId: 'single-step-wf',
      workflowVersion: 1,
      params: {},
    });

    // Track the version returned by store.update in Step 5.
    const originalUpdate = store.update.bind(store);
    let persistedVersion: number | undefined;
    vi.spyOn(store, 'update').mockImplementation(async (record) => {
      const result = await originalUpdate(record);
      persistedVersion = result.version;
      return result;
    });

    const singleStepDef: WorkflowDefinition = {
      id: 'single-step-wf',
      name: 'Single Step Workflow',
      version: 1,
      steps: {
        step_a: {
          description: 'Only step',
          execution: 'agent',
          depends_on: [],
        },
      },
    };

    const envelope = await executeStep(store, singleStepDef, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: async () => {
        throw new WorkflowError('failure', {
          code: 'ENGINE_HANDLER_FAILED',
          category: 'ENGINE',
          agentAction: 'stop',
          retryable: false,
        });
      },
    });

    expect(envelope.status).toBe('error');
    // run_version must equal what store.update returned, not the stale pendingRun.version.
    expect(persistedVersion).toBeDefined();
    expect(envelope.run_version).toBe(persistedVersion);
  });

  // ---------------------------------------------------------------------------
  // Phase 75 — _debug capture
  // ---------------------------------------------------------------------------

  describe('_debug capture (Phase 75)', () => {
    const debugDef: WorkflowDefinition = {
      id: 'debug-wf',
      name: 'Debug Workflow',
      version: 1,
      steps: {
        classify: {
          description: 'Agent step with output_schema',
          execution: 'agent',
          depends_on: [],
          input_schema: {
            type: 'object',
            required: ['category'],
            properties: { category: { type: 'string' } },
          },
        },
      },
    };

    it('_debug is stripped from output_summary and stored as debug_output on the snapshot', async () => {
      const run = await store.create({ workflowId: 'debug-wf', workflowVersion: 1, params: {} });

      await executeStep(store, debugDef, {
        runId: run.id,
        command: 'classify',
        input: { category: 'billing', _debug: 'Ticket mentions invoice #4421. Confident billing.' },
        dispatcher: echoDispatcher,
      });

      const updatedRun = await store.get(run.id);
      const snap = updatedRun.evidence.find((e) => e.step_id === 'classify');
      expect(snap).toBeDefined();
      expect(snap?.debug_output).toBe('Ticket mentions invoice #4421. Confident billing.');
      // _debug must not appear in output_summary
      expect((snap?.output_summary as Record<string, unknown>)['_debug']).toBeUndefined();
    });

    it('_debug passes schema validation — stripped before schema check', async () => {
      const run = await store.create({ workflowId: 'debug-wf', workflowVersion: 1, params: {} });

      // Without _debug removal, this would fail schema validation because
      // output_schema requires only { category }. With removal, it passes.
      const envelope = await executeStep(store, debugDef, {
        runId: run.id,
        command: 'classify',
        input: { category: 'billing', _debug: 'reasoning text' },
        dispatcher: echoDispatcher,
      });

      expect(envelope.status).toBe('ok');
    });

    it('step without _debug produces no debug_output field on the snapshot', async () => {
      const run = await store.create({ workflowId: 'debug-wf', workflowVersion: 1, params: {} });

      await executeStep(store, debugDef, {
        runId: run.id,
        command: 'classify',
        input: { category: 'billing' },
        dispatcher: echoDispatcher,
      });

      const updatedRun = await store.get(run.id);
      const snap = updatedRun.evidence.find((e) => e.step_id === 'classify');
      expect(snap).toBeDefined();
      expect(Object.prototype.hasOwnProperty.call(snap, 'debug_output')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// trace_schema validation (A2)
// ---------------------------------------------------------------------------

describe('trace_schema validation', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-trace-schema-test-'));
    store = new JsonFileStore(dir);
  });

  const traceSchemaDefinitionBase: WorkflowDefinition = {
    id: 'trace-schema-wf',
    name: 'Test Workflow',
    version: 1,
    steps: {
      'step-one': {
        description: 'First step',
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
      'step-two': {
        description: 'Second step',
        execution: 'agent',
        depends_on: ['step-one'],
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

// ---------------------------------------------------------------------------
// WAL trace buffer integration (B-lite)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// retry_after on ResponseEnvelope
// ---------------------------------------------------------------------------

describe('retry_after on ResponseEnvelope', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-retry-after-test-'));
    store = new JsonFileStore(dir);
  });

  const twoStepDef: WorkflowDefinition = {
    id: 'two-step-retry-wf',
    name: 'Two Step Retry Workflow',
    version: 1,
    steps: {
      step_a: {
        description: 'Step that can fail',
        execution: 'agent',
        depends_on: [],
      },
      step_b: {
        description: 'Recovery step',
        execution: 'agent',
        depends_on: ['step_a'],
        trigger_rule: 'one_failed',
      },
    },
  };

  it('retry_after appears in ResponseEnvelope for wait_and_proceed dispatch failure', async () => {
    const run = await store.create({
      workflowId: 'two-step-retry-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeStep(store, twoStepDef, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: async () => {
        throw new WorkflowError('Rate limited', {
          code: 'SERVICE_RATE_LIMITED',
          category: 'SERVICE',
          agentAction: 'wait_and_proceed',
          retryable: true,
          retry_after: 30,
        });
      },
    });

    expect(envelope.status).toBe('error');
    expect(envelope.agent_action).toBe('wait_and_proceed');
    expect(envelope.retry_after).toBe(30);
  });

  it('retry_after is absent from ResponseEnvelope when not set on the error', async () => {
    const run = await store.create({
      workflowId: 'two-step-retry-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeStep(store, twoStepDef, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: async () => {
        throw new WorkflowError('Service unavailable', {
          code: 'SERVICE_HTTP_5XX',
          category: 'SERVICE',
          agentAction: 'wait_for_human',
          retryable: false,
        });
      },
    });

    expect(envelope.status).toBe('error');
    expect(envelope.agent_action).toBe('wait_for_human');
    expect(envelope.retry_after).toBeUndefined();
  });

  it('errorEnvelope includes retry_after when WorkflowError.retry_after is set (pre-execution path)', async () => {
    // Use a mock store whose get() throws a WorkflowError with retry_after set.
    // This exercises the makeErrorEnvelope(options, null, err) path in step 1.
    const mockStore: import('../store/store-interface.js').RunStore = {
      create: store.create.bind(store),
      get: async () => {
        throw new WorkflowError('Rate limited at store level', {
          code: 'SERVICE_RATE_LIMITED',
          category: 'SERVICE',
          agentAction: 'wait_and_proceed',
          retryable: true,
          retry_after: 45,
        });
      },
      update: store.update.bind(store),
      list: store.list.bind(store),
      claimStep: store.claimStep.bind(store),
    };

    const envelope = await executeStep(mockStore, twoStepDef, {
      runId: 'any-run-id',
      command: 'step_a',
      input: {},
      dispatcher: echoDispatcher,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.agent_action).toBe('wait_and_proceed');
    expect(envelope.retry_after).toBe(45);
  });

  it('engine retry loop uses Math.max(computeBackoff, retry_after * 1000) as delay', async () => {
    // Spy on setTimeout: record the requested delay but fire the callback immediately
    // (delay=0) so the test doesn't actually wait 30 seconds.
    const capturedDelays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    (globalThis as Record<string, unknown>)['setTimeout'] = (
      fn: (...args: unknown[]) => void,
      delay?: number,
    ) => {
      capturedDelays.push(delay ?? 0);
      return origSetTimeout(fn, 0);
    };

    try {
      const retryDef: WorkflowDefinition = {
        id: 'retry-delay-wf',
        name: 'Retry Delay Workflow',
        version: 1,
        steps: {
          step_a: {
            description: 'Step with retry',
            execution: 'agent',
            depends_on: [],
            retry: { max_attempts: 2, backoff: 'fixed', base_delay_ms: 100 },
          },
        },
      };

      const run = await store.create({
        workflowId: 'retry-delay-wf',
        workflowVersion: 1,
        params: {},
      });

      let attempt = 0;
      const result = await executeStep(store, retryDef, {
        runId: run.id,
        command: 'step_a',
        input: {},
        dispatcher: async () => {
          attempt++;
          if (attempt === 1) {
            throw new WorkflowError('Rate limited', {
              code: 'SERVICE_RATE_LIMITED',
              category: 'SERVICE',
              agentAction: 'wait_and_proceed',
              retryable: true,
              retry_after: 30,
            });
          }
          return { recovered: true };
        },
      });

      expect(result.status).toBe('ok');
      expect(attempt).toBe(2);
      // Math.max(100 base_delay_ms, 30 * 1000 retry_after_ms) = 30000
      expect(capturedDelays).toContain(30000);
    } finally {
      (globalThis as Record<string, unknown>)['setTimeout'] = origSetTimeout;
    }
  });

  it('engine retry loop falls back to computeBackoff when retry_after is undefined', async () => {
    // Same spy approach: record the requested delay but fire immediately.
    const capturedDelays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    (globalThis as Record<string, unknown>)['setTimeout'] = (
      fn: (...args: unknown[]) => void,
      delay?: number,
    ) => {
      capturedDelays.push(delay ?? 0);
      return origSetTimeout(fn, 0);
    };

    try {
      const retryDef: WorkflowDefinition = {
        id: 'retry-fallback-wf',
        name: 'Retry Fallback Workflow',
        version: 1,
        steps: {
          step_a: {
            description: 'Step with retry',
            execution: 'agent',
            depends_on: [],
            retry: { max_attempts: 2, backoff: 'fixed', base_delay_ms: 500 },
          },
        },
      };

      const run = await store.create({
        workflowId: 'retry-fallback-wf',
        workflowVersion: 1,
        params: {},
      });

      let attempt = 0;
      const result = await executeStep(store, retryDef, {
        runId: run.id,
        command: 'step_a',
        input: {},
        dispatcher: async () => {
          attempt++;
          if (attempt === 1) {
            throw new WorkflowError('Transient failure', {
              code: 'ENGINE_HANDLER_FAILED',
              category: 'ENGINE',
              agentAction: 'report_to_user',
              retryable: true,
              // No retry_after — computeBackoff (500ms) should be used
            });
          }
          return { recovered: true };
        },
      });

      expect(result.status).toBe('ok');
      expect(attempt).toBe(2);
      // Math.max(500 base_delay_ms, 0 retry_after_ms) = 500
      expect(capturedDelays).toContain(500);
    } finally {
      (globalThis as Record<string, unknown>)['setTimeout'] = origSetTimeout;
    }
  });
});

// ---------------------------------------------------------------------------
// execution: guard — inline guard step execution via executeChain
// ---------------------------------------------------------------------------

describe('guard step execution', () => {
  let store: JsonFileStore;
  let dir: string;

  const guardWorkflow: WorkflowDefinition = {
    id: 'guard-wf',
    name: 'Guard Workflow',
    version: 1,
    steps: {
      step_a: {
        description: 'Agent step',
        execution: 'agent',
        depends_on: [],
      },
      guard_b: {
        description: 'Guard step',
        execution: 'guard',
        depends_on: ['step_a'],
        abort_unless: ["step_a.status == 'open'"],
      },
      step_c: {
        description: 'Post-guard agent step',
        execution: 'agent',
        depends_on: ['guard_b'],
      },
    },
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-guard-test-'));
    store = new JsonFileStore(dir);
  });

  it('guard passes — run continues with downstream agent step in next_actions', async () => {
    const run = await store.create({ workflowId: 'guard-wf', workflowVersion: 1, params: {} });

    const envelope = await executeChain(store, guardWorkflow, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: async () => ({ status: 'open' }),
    });

    expect(envelope.status).toBe('ok');
    // Guard ran inline — visible in chained_auto_steps
    expect(envelope.chained_auto_steps?.some((s) => s.step === 'guard_b')).toBe(true);
    // step_c is the next eligible agent step
    expect(envelope.next_actions.some((a) => a.instruction.call_with.command === 'step_c')).toBe(
      true,
    );

    const savedRun = await store.get(run.id);
    expect(savedRun.completed_steps).toContain('guard_b');
    expect(savedRun.run_phase).not.toBe('aborted');
  });

  it('guard aborts — run_phase becomes aborted, next_actions is empty, aborted_at set', async () => {
    const run = await store.create({ workflowId: 'guard-wf', workflowVersion: 1, params: {} });

    const envelope = await executeChain(store, guardWorkflow, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: async () => ({ status: 'closed' }),
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.next_actions).toHaveLength(0);

    const savedRun = await store.get(run.id);
    expect(savedRun.run_phase).toBe('aborted');
    expect(savedRun.terminal_state).toBe(true);
    expect(savedRun.skipped_steps).toContain('guard_b');
    expect(savedRun.aborted_at).toBeDefined();
    expect(savedRun.aborted_at?.step_id).toBe('guard_b');
    expect(savedRun.aborted_at?.conditions).toHaveLength(1);
    expect(savedRun.aborted_at?.conditions[0]?.passed).toBe(false);
  });

  it('guard abort skips downstream steps (step_c goes into skipped_steps)', async () => {
    const run = await store.create({ workflowId: 'guard-wf', workflowVersion: 1, params: {} });

    await executeChain(store, guardWorkflow, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: async () => ({ status: 'closed' }),
    });

    const savedRun = await store.get(run.id);
    expect(savedRun.skipped_steps).toContain('step_c');
  });

  it('guard resolution error — run_phase becomes failed, guard in failed_steps', async () => {
    const run = await store.create({ workflowId: 'guard-wf', workflowVersion: 1, params: {} });

    // Dispatcher returns no 'status' field — path step_a.status is unresolvable
    const envelope = await executeChain(store, guardWorkflow, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: async () => ({ other_field: 'value' }),
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.next_actions).toHaveLength(0);

    const savedRun = await store.get(run.id);
    expect(savedRun.run_phase).toBe('failed');
    expect(savedRun.terminal_state).toBe(true);
    expect(savedRun.failed_steps).toContain('guard_b');
  });

  it('guard abort_message is recorded in aborted_at', async () => {
    const workflowWithMessage: WorkflowDefinition = {
      id: 'guard-msg-wf',
      name: 'Guard Message Workflow',
      version: 1,
      steps: {
        step_a: { description: 'Step A', execution: 'agent', depends_on: [] },
        guard_b: {
          description: 'Guard with message',
          execution: 'guard',
          depends_on: ['step_a'],
          abort_unless: ["step_a.status == 'open'"],
          abort_message: 'Ticket is not open',
        },
      },
    };

    const run = await store.create({ workflowId: 'guard-msg-wf', workflowVersion: 1, params: {} });

    await executeChain(store, workflowWithMessage, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: async () => ({ status: 'closed' }),
    });

    const savedRun = await store.get(run.id);
    expect(savedRun.aborted_at?.abort_message).toBe('Ticket is not open');
  });

  it('cascading guards — guard_b passes, guard_c passes, run continues', async () => {
    const cascadeWorkflow: WorkflowDefinition = {
      id: 'cascade-guard-wf',
      name: 'Cascade Guard Workflow',
      version: 1,
      steps: {
        step_a: { description: 'Step A', execution: 'agent', depends_on: [] },
        guard_b: {
          description: 'First guard',
          execution: 'guard',
          depends_on: ['step_a'],
          abort_unless: ['step_a.count > 0'],
        },
        guard_c: {
          description: 'Second guard',
          execution: 'guard',
          depends_on: ['guard_b'],
          abort_unless: ['step_a.count > 5'],
        },
        step_d: { description: 'Post-guard step', execution: 'agent', depends_on: ['guard_c'] },
      },
    };

    const run = await store.create({
      workflowId: 'cascade-guard-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeChain(store, cascadeWorkflow, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: async () => ({ count: 10 }),
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.next_actions.some((a) => a.instruction.call_with.command === 'step_d')).toBe(
      true,
    );

    const savedRun = await store.get(run.id);
    expect(savedRun.completed_steps).toContain('guard_b');
    expect(savedRun.completed_steps).toContain('guard_c');
    expect(savedRun.run_phase).not.toBe('aborted');
  });

  it('cascading guards — guard_b passes, guard_c aborts, run is aborted', async () => {
    const cascadeWorkflow: WorkflowDefinition = {
      id: 'cascade-abort-wf',
      name: 'Cascade Abort Workflow',
      version: 1,
      steps: {
        step_a: { description: 'Step A', execution: 'agent', depends_on: [] },
        guard_b: {
          description: 'First guard (passes)',
          execution: 'guard',
          depends_on: ['step_a'],
          abort_unless: ['step_a.count > 0'],
        },
        guard_c: {
          description: 'Second guard (aborts)',
          execution: 'guard',
          depends_on: ['guard_b'],
          abort_unless: ['step_a.count > 100'],
        },
        step_d: { description: 'Post-guard step', execution: 'agent', depends_on: ['guard_c'] },
      },
    };

    const run = await store.create({
      workflowId: 'cascade-abort-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeChain(store, cascadeWorkflow, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: async () => ({ count: 10 }),
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.next_actions).toHaveLength(0);

    const savedRun = await store.get(run.id);
    expect(savedRun.run_phase).toBe('aborted');
    expect(savedRun.completed_steps).toContain('guard_b');
    expect(savedRun.aborted_at?.step_id).toBe('guard_c');
  });
});
