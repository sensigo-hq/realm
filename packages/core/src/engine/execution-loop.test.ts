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
    const { run: run } = await store.create({
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
    const { run: run } = await store.create({
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

    const { run: run } = await store.create({
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
    const { run: run } = await store.create({
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
    const { run: run } = await store.create({
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
    const { run: run } = await store.create({
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
    const { run: run } = await store.create({
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

    const { run: run } = await store.create({
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
    // so the agent can immediately correct and re-submit it. issue #220: true while this step's
    // accrued rejection count stays below its exhaustion threshold (default 6) — this single
    // rejection is call 1 of 6 by default, so this premise holds here; it stops holding once the
    // count reaches the threshold, at which point the step terminalizes instead (see
    // validation-exhaustion.test.ts).
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

    const { run: run } = await store.create({
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

    const { run: run } = await store.create({
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

    const { run: run } = await store.create({
      workflowId: 'test-wf',
      workflowVersion: 1,
      params: {},
    });

    // First call with invalid input — should fail. issue #220: this is rejection 1 of a default
    // threshold of 6 — well under exhaustion, so today's re-submittable behavior below holds.
    const first = await executeStep(store, schemaDefinition, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: echoDispatcher,
    });
    expect(first.status).toBe('error');

    // Second call with valid input — step was never claimed, so it can be re-submitted (true
    // while under the exhaustion threshold — issue #220; see validation-exhaustion.test.ts for
    // the terminalizing case once the threshold is reached).
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

      const { run: run } = await store.create({
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
        expect.any(AbortSignal),
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

    it('adapter-not-registered error carries the project-extensions hint when the definition declares no extensions', async () => {
      const registry = new ExtensionRegistry(); // empty — no adapter registered

      const { run: run } = await store.create({
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
      expect(envelope.errors[0]).toContain(
        "Declare this adapter under 'adapters:' in realm.yaml at your deployment root.",
      );
    });

    it('adapter-not-registered error omits the hint when the definition already declares extensions', async () => {
      const registry = new ExtensionRegistry(); // empty — no adapter registered

      const { run: run } = await store.create({
        workflowId: 'adapter-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(
        store,
        { ...adapterDefinition, extensions: ['./registry.js'] },
        {
          runId: run.id,
          command: 'fetch_data',
          input: {},
          dispatcher: echoDispatcher,
          registry,
        },
      );

      expect(envelope.status).toBe('error');
      expect(envelope.errors[0]).toContain('not registered');
      expect(envelope.errors[0]).not.toContain('realm.yaml');
    });

    it('wraps non-object adapter response in { data, status }', async () => {
      const adapter = makeAdapter('raw string' as unknown as Record<string, unknown>);
      const registry = new ExtensionRegistry();
      registry.register('adapter', 'mock_adapter', adapter);

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

    it('throws ADAPTER_OP_UNSUPPORTED when adapter has no delete method', async () => {
      const adapter: ServiceAdapter = {
        id: 'mock_adapter',
        fetch: vi.fn().mockResolvedValue({ status: 200, data: {} }),
        create: vi.fn().mockResolvedValue({ status: 201, data: {} }),
        update: vi.fn().mockResolvedValue({ status: 200, data: {} }),
        // delete is intentionally absent
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

      const { run: run } = await store.create({
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

      expect(envelope.status).toBe('error');
      expect(envelope.agent_action).toBe('stop');
      expect(envelope.errors[0]).toContain("does not support service_method 'delete'");
    });

    it('uses step name as operation when operation field is absent', async () => {
      const adapter = makeAdapter({ ok: true });
      const registry = new ExtensionRegistry();
      registry.register('adapter', 'mock_adapter', adapter);

      const { run: run } = await store.create({
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
        expect.any(AbortSignal),
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

      const { run: run } = await store.create({
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
        expect.any(AbortSignal),
      );
    });

    it('merges step-level config into adapter config object', async () => {
      const adapter = makeAdapter({ result: 'ok' });
      const registry = new ExtensionRegistry();
      registry.register('adapter', 'mock_adapter', adapter);

      const def: WorkflowDefinition = {
        ...adapterDefinition,
        steps: {
          fetch_data: {
            ...adapterDefinition.steps['fetch_data']!,
            config: { table: 'Tickets', view: 'Grid view' },
          },
        },
      };

      const { run: run } = await store.create({
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
        'fetch_data',
        expect.anything(),
        expect.objectContaining({
          adapter: 'mock_adapter',
          trust: 'engine_delivered',
          table: 'Tickets',
          view: 'Grid view',
        }),
        expect.any(AbortSignal),
      );
    });

    it('passes no extra keys in config when step has no config field', async () => {
      const adapter = makeAdapter({ result: 'ok' });
      const registry = new ExtensionRegistry();
      registry.register('adapter', 'mock_adapter', adapter);

      const { run: run } = await store.create({
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
          .fn<
            (
              inputs: StepHandlerInputs,
              ctx: StepContext,
            ) => Promise<{ data: Record<string, unknown> }>
          >()
          .mockResolvedValue({ data }),
      };
    }

    it('calls the registered handler and returns its data as step output', async () => {
      const handler = makeHandler({ valid: true });
      const registry = new ExtensionRegistry();
      registry.register('handler', 'my_handler', handler);

      const { run: run } = await store.create({
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
        expect.any(AbortSignal),
      );
    });

    it('returns error envelope when handler is not registered', async () => {
      const registry = new ExtensionRegistry(); // empty

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

    it('clean abort — handler returning { abort: { message } } produces run_phase: aborted', async () => {
      const handler: StepHandler = {
        id: 'my_handler',
        execute: vi.fn().mockResolvedValue({ abort: { message: 'Ticket is closed' } }),
      };
      const registry = new ExtensionRegistry();
      registry.register('handler', 'my_handler', handler);

      const { run: run } = await store.create({
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
      expect(envelope.next_actions).toHaveLength(0);

      const updatedRun = await store.get(run.id);
      expect(updatedRun.run_phase).toBe('aborted');
      expect(updatedRun.terminal_state).toBe(true);
      expect(updatedRun.aborted_at?.step_id).toBe('validate');
      expect(updatedRun.aborted_at?.abort_message).toBe('Ticket is closed');
    });

    // Issue #140 correction (S4): the review's novel probe N2 reverted the handler-abort return
    // path's `warnings` from `mergeWarnings(traceWarnings)` back to a hardcoded `[]`, and the
    // ENTIRE suite stayed green — this settle path had zero discriminating tests for the
    // programmatic-gate advisory. This is that witness: `retry.on_timeout: true` is armed WITHOUT
    // `idempotent: true` (the advisory's own trigger, pushed at loop entry regardless of how the
    // step eventually settles), and the step's handler aborts — the advisory must still surface
    // in this settle path's `warnings`.
    it('issue #140 S4: a handler-abort settle still carries the programmatic-gate advisory when on_timeout is armed without idempotent', async () => {
      const advisoryAbortDef: WorkflowDefinition = {
        id: 'abort-with-advisory-wf',
        name: 'Abort With Advisory',
        version: 1,
        steps: {
          validate: {
            description: 'Aborts; on_timeout armed but idempotent absent',
            execution: 'auto',
            depends_on: [],
            handler: 'my_handler',
            retry: { max_attempts: 2, on_timeout: true },
          },
        },
      };
      const handler: StepHandler = {
        id: 'my_handler',
        execute: vi.fn().mockResolvedValue({ abort: { message: 'Aborting' } }),
      };
      const registry = new ExtensionRegistry();
      registry.register('handler', 'my_handler', handler);

      const { run: run } = await store.create({
        workflowId: 'abort-with-advisory-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, advisoryAbortDef, {
        runId: run.id,
        command: 'validate',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      expect(envelope.status).toBe('ok'); // handler-abort settles 'ok' (pre-existing behavior)
      expect(envelope.warnings.some((w) => w.includes('on_timeout ignored'))).toBe(true);
    });

    it('abort skips downstream steps', async () => {
      const twoStepHandlerDef: WorkflowDefinition = {
        id: 'two-step-handler-wf',
        name: 'Two Step Handler Workflow',
        version: 1,
        steps: {
          check: {
            description: 'Guard-like check',
            execution: 'auto',
            depends_on: [],
            handler: 'my_handler',
          },
          process: {
            description: 'Downstream processing',
            execution: 'agent',
            depends_on: ['check'],
          },
        },
      };

      const handler: StepHandler = {
        id: 'my_handler',
        execute: vi.fn().mockResolvedValue({ abort: { message: 'Condition not met' } }),
      };
      const registry = new ExtensionRegistry();
      registry.register('handler', 'my_handler', handler);

      const { run: run } = await store.create({
        workflowId: 'two-step-handler-wf',
        workflowVersion: 1,
        params: {},
      });

      await executeStep(store, twoStepHandlerDef, {
        runId: run.id,
        command: 'check',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      const updatedRun = await store.get(run.id);
      expect(updatedRun.run_phase).toBe('aborted');
      expect(updatedRun.skipped_steps).toContain('check');
      expect(updatedRun.skipped_steps).toContain('process');
      expect(updatedRun.completed_steps).not.toContain('check');
      expect(updatedRun.failed_steps).not.toContain('check');
    });

    it('a handler abort records a handler_abort skip_details entry, plus a cascade detail for the downstream step (issue #111)', async () => {
      const twoStepHandlerDef: WorkflowDefinition = {
        id: 'two-step-handler-wf',
        name: 'Two Step Handler Workflow',
        version: 1,
        steps: {
          check: {
            description: 'Guard-like check',
            execution: 'auto',
            depends_on: [],
            handler: 'my_handler',
          },
          process: {
            description: 'Downstream processing',
            execution: 'agent',
            depends_on: ['check'],
          },
        },
      };

      const handler: StepHandler = {
        id: 'my_handler',
        execute: vi.fn().mockResolvedValue({ abort: { message: 'Condition not met' } }),
      };
      const registry = new ExtensionRegistry();
      registry.register('handler', 'my_handler', handler);

      const { run: run } = await store.create({
        workflowId: 'two-step-handler-wf',
        workflowVersion: 1,
        params: {},
      });

      await executeStep(store, twoStepHandlerDef, {
        runId: run.id,
        command: 'check',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      const updatedRun = await store.get(run.id);
      expect(updatedRun.skip_details?.['check']).toEqual({ kind: 'handler_abort' });
      // The merge is load-bearing — the cascade detail for 'process' (skipped because its
      // all_success dep 'check' never completed) must survive alongside 'check''s own tag.
      expect(updatedRun.skip_details?.['process']?.kind).toBe('trigger_rule_unsatisfiable');
    });

    it('abort evidence entry has status skipped and records the abort message', async () => {
      const handler: StepHandler = {
        id: 'my_handler',
        execute: vi.fn().mockResolvedValue({ abort: { message: 'Ticket is closed' } }),
      };
      const registry = new ExtensionRegistry();
      registry.register('handler', 'my_handler', handler);

      const { run: run } = await store.create({
        workflowId: 'handler-wf',
        workflowVersion: 1,
        params: {},
      });

      await executeStep(store, handlerDefinition, {
        runId: run.id,
        command: 'validate',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      const updatedRun = await store.get(run.id);
      const abortEntry = updatedRun.evidence.find((e) => e.step_id === 'validate');
      expect(abortEntry).toBeDefined();
      expect(abortEntry!.status).toBe('skipped');
      expect(abortEntry!.error).toBe('Ticket is closed');
    });

    it('throw still fails — handler that throws produces run_phase: failed', async () => {
      const handler: StepHandler = {
        id: 'my_handler',
        execute: vi.fn().mockRejectedValue(new Error('unexpected crash')),
      };
      const registry = new ExtensionRegistry();
      registry.register('handler', 'my_handler', handler);

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

    it('both abort and data — abort takes precedence and run aborts cleanly', async () => {
      const handler: StepHandler = {
        id: 'my_handler',
        execute: vi.fn().mockResolvedValue({
          data: { should_be_ignored: true },
          abort: { message: 'Abort wins' },
        }),
      };
      const registry = new ExtensionRegistry();
      registry.register('handler', 'my_handler', handler);

      const { run: run } = await store.create({
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
      expect(envelope.next_actions).toHaveLength(0);
      const updatedRun = await store.get(run.id);
      expect(updatedRun.run_phase).toBe('aborted');
      expect(updatedRun.aborted_at?.abort_message).toBe('Abort wins');
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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
      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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
    // issue #279 (increment 1, PR-B): JsonFileStore now declares settleStep, so the fail site's
    // MIGRATED path (not the legacy store.update path) handles this run — a genuine settleStep
    // throw surfaces as a hard ENGINE_STORE_FAILED error envelope (the complete-site's own
    // pre-existing catch pattern, replicated at all three migrated sites — design record §1/D1),
    // never a warning-degraded 'error' envelope that still preserves the ORIGINAL dispatch
    // failure's message. Mocking store.update (the old target) would no longer even intercept
    // this path, since the migrated fail site never calls it.
    it('surfaces a hard ENGINE_STORE_FAILED error envelope when the migrated settleStep throws', async () => {
      const { run: run } = await store.create({
        workflowId: 'test-wf',
        workflowVersion: 1,
        params: {},
      });

      vi.spyOn(store, 'settleStep').mockImplementation(async () => {
        throw new Error('store write failed');
      });

      try {
        const envelope = await executeStep(store, definition, {
          runId: run.id,
          command: 'step-one',
          input: {},
          dispatcher: failDispatcher,
        });

        expect(envelope.status).toBe('error');
        expect(envelope.error_code).toBe('ENGINE_STORE_FAILED');
        expect(envelope.errors[0]).toMatch(/Failed to persist run update/);
        expect(envelope.agent_action).toBe('stop');
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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
      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

    // issue #220 §4c (PR-3, pin jj): the unresolved-placeholder regex widened to admit a
    // `$`-leading reference — a typo'd $settlement path in a gate message must be DETECTED as
    // unresolved, not silently left unmatched (renderTemplate itself already leaves the
    // placeholder text verbatim when unresolved; this is a detection-side widening).
    it('pin (jj): gate.message with an unresolvable $settlement reference is detected as an unresolved placeholder', async () => {
      const gateMessageSettlementWf: WorkflowDefinition = {
        id: 'gate-msg-settlement-wf',
        name: 'Gate Message Settlement',
        version: 1,
        steps: {
          step1: {
            description: 'Prior step — never settles a field named bogus_field',
            execution: 'auto',
            depends_on: [],
          },
          gate_step: {
            description: 'Gate step referencing an unresolvable $settlement field',
            execution: 'auto',
            trust: 'human_confirmed',
            depends_on: ['step1'],
            gate: {
              choices: ['approve', 'reject'],
              message: 'Defaulted: {{ $settlement.step1.bogus_field }}',
            },
          },
        },
      };
      const { run: run } = await store.create({
        workflowId: 'gate-msg-settlement-wf',
        workflowVersion: 1,
        params: {},
      });
      await executeStep(store, gateMessageSettlementWf, {
        runId: run.id,
        command: 'step1',
        input: {},
        dispatcher: async () => ({}),
      });

      const envelope = await executeStep(store, gateMessageSettlementWf, {
        runId: run.id,
        command: 'gate_step',
        input: {},
        dispatcher: async () => ({}),
      });

      expect(envelope.status).toBe('error');
      expect(envelope.errors[0]).toContain('gate.message has unresolvable references');
      expect(envelope.errors[0]).toContain('$settlement.step1.bogus_field');
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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
      const { run: run } = await store.create({
        workflowId: 'test-wf',
        workflowVersion: 1,
        params: {},
      });
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

      const { run: run1 } = await store.create({
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

      const { run: run2 } = await store.create({
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

      const { run: run1 } = await store.create({
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

      const { run: run2 } = await store.create({
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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
      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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

    it('trace_schema warn: the trace warning survives a migrated settleStep throw (issue #279 PR-B)', async () => {
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

      const { run: run } = await store.create({
        workflowId: 'trace-schema-wf',
        workflowVersion: 1,
        params: {},
      });

      // JsonFileStore declares settleStep — the fail site's MIGRATED path handles this run, so
      // simulating a persist failure now means mocking settleStep, not store.update (the fail
      // site's legacy-only call, unreachable once the store declares the capability).
      vi.spyOn(store, 'settleStep').mockImplementation(async () => {
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
        expect(envelope.error_code).toBe('ENGINE_STORE_FAILED');
        // The trace warning survives (threaded through makeErrorEnvelope's extraWarnings) even
        // though the settle itself hard-failed — the persist-failure detail now lives in
        // errors[0]/error_code instead of a second warning entry (design record §1/D1: a genuine
        // throw must never become a false-ok/warning-degraded envelope).
        expect(envelope.warnings).toHaveLength(1);
        expect(envelope.warnings[0]).toContain('step-one');
        expect(envelope.errors[0]).toMatch(/Failed to persist run update/);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('trace_schema warn: gate settleStep error envelope retains trace warning', async () => {
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

      const { run: run } = await store.create({
        workflowId: 'trace-schema-wf',
        workflowVersion: 1,
        params: {},
      });

      // issue #279 (increment 2, PR-D): gate-open now persists via store.settleStep (not
      // store.update) on a declaring store — mock THAT to simulate the gate persistence failure
      // (post-dispatch). Mocking store.update alone no longer reaches the gate-open write path.
      vi.spyOn(store, 'settleStep').mockImplementation(async () => {
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
    const { run: run } = await store.create({
      workflowId: 'wal-test-wf',
      workflowVersion: 1,
      params: {},
    });

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
    const { run: run } = await store.create({
      workflowId: 'wal-test-wf',
      workflowVersion: 1,
      params: {},
    });

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
    const { run: run } = await store.create({
      workflowId: 'wal-schema-wf',
      workflowVersion: 1,
      params: {},
    });

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
    const { run: run } = await store.create({
      workflowId: 'wal-test-wf',
      workflowVersion: 1,
      params: {},
    });

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
    const { run: run } = await store.create({
      workflowId: 'wal-test-wf',
      workflowVersion: 1,
      params: {},
    });

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
    const { run: run } = await store.create({
      workflowId: 'wal-test-wf',
      workflowVersion: 1,
      params: {},
    });

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
// Trace provenance — honest seal-at-claim (issue #185)
// ---------------------------------------------------------------------------

describe('trace provenance — honest seal-at-claim (issue #185)', () => {
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
    dir = await mkdtemp(join(tmpdir(), 'realm-185-test-'));
    store = new JsonFileStore(dir);
  });

  describe('Finding 1 — budget-priority preserves the conclusion', () => {
    it('a WAL with more entries than the truncation budget still yields a canonical trace containing the execute_step conclusion, dropping the OLDEST buffer lines as overflow', async () => {
      const bufferStore = new InMemoryTraceBufferStore();
      const { run } = await store.create({
        workflowId: 'wal-test-wf',
        workflowVersion: 1,
        params: {},
      });

      // 105 buffer lines, appended in one batch (oldest → newest is array order) — 5 more than
      // the 100-entry budget once the conclusion is added (106 total candidates).
      const bufferBatch = Array.from({ length: 105 }, (_, i) => ({ event: `buffered_${i}` }));
      await bufferStore.append(run.id, 'step-agent', bufferBatch);

      const envelope = await executeStep(store, agentDef, {
        runId: run.id,
        command: 'step-agent',
        input: {},
        dispatcher: async () => ({}),
        traceBufferStore: bufferStore,
        trace: [{ event: 'the_conclusion' }],
      });

      expect(envelope.status).toBe('ok');
      const snap = envelope.evidence[0];
      const trace = snap?.trace ?? [];

      // The conclusion survived.
      expect(trace.some((e) => e.event === 'the_conclusion')).toBe(true);

      // Truncation occurred and is reported honestly.
      expect(snap?.trace_summary?.truncated).toBe(true);
      expect(snap?.trace_summary?.truncation_reason).toBe('count_limit');
      expect(snap?.trace_summary?.submitted_entries).toBe(106); // 105 buffer + 1 conclusion
      expect(snap?.trace_summary?.discarded_overflow_entries).toBe(6); // 106 - 100 budget
      expect(snap?.trace_summary?.stored_entries).toBe(101); // 100 real + 1 sentinel

      // The 6 OLDEST buffer lines (buffered_0..buffered_5) were dropped, never the conclusion.
      const survivingEvents = new Set(trace.map((e) => e.event));
      for (let i = 0; i < 6; i++) {
        expect(survivingEvents.has(`buffered_${i}`)).toBe(false);
      }
      for (let i = 6; i < 105; i++) {
        expect(survivingEvents.has(`buffered_${i}`)).toBe(true);
      }

      // The conclusion is chronologically last among real (non-sentinel) entries — highest seq.
      const nonSentinel = trace.filter((e) => e.event !== 'trace.truncated');
      expect(nonSentinel[nonSentinel.length - 1]?.event).toBe('the_conclusion');
      const conclusionEntry = trace.find((e) => e.event === 'the_conclusion');
      const oldestSurvivingBuffer = trace.find((e) => e.event === 'buffered_6');
      expect(oldestSurvivingBuffer!.seq).toBeLessThan(conclusionEntry!.seq);

      // The sentinel is present and last.
      expect(trace[trace.length - 1]?.event).toBe('trace.truncated');
    });

    it('the conclusion still survives when the WAL alone (no execute_step.trace overlap needed) pushes the merge past the byte budget', async () => {
      const bufferStore = new InMemoryTraceBufferStore();
      const { run } = await store.create({
        workflowId: 'wal-test-wf',
        workflowVersion: 1,
        params: {},
      });

      // Fewer than 100 entries, but each large enough that the total blows the 50KB budget
      // before the count limit would ever trigger (verified: 95 * ~555 bytes ≈ 52.7KB > 50KB,
      // while 95 < the 100-entry count limit).
      const bigValue = 'x'.repeat(500); // MAX_STRING_VALUE (500) — stays uncapped by normalizeData
      const bufferBatch = Array.from({ length: 95 }, (_, i) => ({
        event: `buffered_${i}`,
        data: { payload: bigValue },
      }));
      await bufferStore.append(run.id, 'step-agent', bufferBatch);

      const envelope = await executeStep(store, agentDef, {
        runId: run.id,
        command: 'step-agent',
        input: {},
        dispatcher: async () => ({}),
        traceBufferStore: bufferStore,
        trace: [{ event: 'the_conclusion' }],
      });

      expect(envelope.status).toBe('ok');
      const snap = envelope.evidence[0];
      const trace = snap?.trace ?? [];

      expect(trace.some((e) => e.event === 'the_conclusion')).toBe(true);
      expect(snap?.trace_summary?.truncated).toBe(true);
      expect(snap?.trace_summary?.truncation_reason).toBe('byte_limit');
      // Whatever was dropped is from the front (oldest) of the buffer — buffered_0 specifically.
      const survivingEvents = new Set(trace.map((e) => e.event));
      expect(survivingEvents.has('buffered_0')).toBe(false);
    });
  });

  describe('Finding 2 — the post-claim re-read closes the silent-loss window', () => {
    it('a line appended in the window between the pre-claim read and the claim is captured, not silently lost before WAL delete()', async () => {
      const bufferStore = new InMemoryTraceBufferStore();
      const { run } = await store.create({
        workflowId: 'wal-test-wf',
        workflowVersion: 1,
        params: {},
      });

      // Simulates a concurrent append_trace landing AFTER the pre-claim WAL read (already
      // executed by the time executeStep reaches claimStep) but before/at the claim itself.
      const originalClaimStep = store.claimStep.bind(store);
      const claimSpy = vi
        .spyOn(store, 'claimStep')
        .mockImplementationOnce(async (runId, stepId, def) => {
          await bufferStore.append(runId, stepId, [{ event: 'race_window_line' }]);
          return originalClaimStep(runId, stepId, def);
        });

      try {
        const envelope = await executeStep(store, agentDef, {
          runId: run.id,
          command: 'step-agent',
          input: {},
          dispatcher: async () => ({}),
          traceBufferStore: bufferStore,
          // No options.trace, no pre-seeded buffer — the pre-claim read sees NOTHING at all.
        });

        expect(envelope.status).toBe('ok');
        const snap = envelope.evidence[0];
        expect(snap?.trace?.some((e) => e.event === 'race_window_line')).toBe(true);

        // The WAL is gone after settlement — the line was captured before delete(), not lost.
        const remaining = await bufferStore.read(run.id, 'step-agent');
        expect(remaining).toHaveLength(0);
      } finally {
        claimSpy.mockRestore();
      }
    });

    it('enforce-mode schema validation still runs pre-claim (against a possibly-incomplete set) — its verdict is carried onto the final captured summary', async () => {
      const schemaEnforceDef: WorkflowDefinition = {
        id: 'wal-schema-185-wf',
        name: 'WAL Schema 185 Workflow',
        version: 1,
        steps: {
          'step-agent': {
            description: 'Agent step with trace schema',
            execution: 'agent',
            depends_on: [],
            // Validates against the NORMALIZED entry shape (seq/event), which every canonical
            // trace entry always has — unlike a schema requiring a custom field nested under
            // `data`, this one can actually pass.
            trace_schema: {
              type: 'array',
              items: {
                type: 'object',
                required: ['seq', 'event'],
                properties: { seq: { type: 'number' }, event: { type: 'string' } },
              },
            },
            trace_validation_mode: 'enforce',
          },
        },
      };
      const bufferStore = new InMemoryTraceBufferStore();
      const { run } = await store.create({
        workflowId: 'wal-test-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, schemaEnforceDef, {
        runId: run.id,
        command: 'step-agent',
        input: {},
        dispatcher: async () => ({}),
        traceBufferStore: bufferStore,
        trace: [{ event: 'ok_entry' }],
      });

      expect(envelope.status).toBe('ok');
      const snap = envelope.evidence[0];
      expect(snap?.trace_summary?.schema_applied).toBe(true);
      expect(snap?.trace_summary?.validation_mode).toBe('enforce');
      expect(snap?.trace_summary?.validation_errors).toBe(0);
    });
  });

  describe('Fix 3 — the honest trace_summary caveat', () => {
    it('adopting any buffer/WAL line carries buffered_lines_adopted with the exact count', async () => {
      const bufferStore = new InMemoryTraceBufferStore();
      const { run } = await store.create({
        workflowId: 'wal-test-wf',
        workflowVersion: 1,
        params: {},
      });

      await bufferStore.append(run.id, 'step-agent', [
        { event: 'buffered_a' },
        { event: 'buffered_b' },
      ]);

      const envelope = await executeStep(store, agentDef, {
        runId: run.id,
        command: 'step-agent',
        input: {},
        dispatcher: async () => ({}),
        traceBufferStore: bufferStore,
        trace: [{ event: 'the_conclusion' }],
      });

      expect(envelope.status).toBe('ok');
      const snap = envelope.evidence[0];
      expect(snap?.trace_summary?.buffered_lines_adopted).toBe(2);
    });

    it('an execute_step.trace-only execution (no buffer contribution) carries NO caveat', async () => {
      const bufferStore = new InMemoryTraceBufferStore();
      const { run } = await store.create({
        workflowId: 'wal-test-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, agentDef, {
        runId: run.id,
        command: 'step-agent',
        input: {},
        dispatcher: async () => ({}),
        traceBufferStore: bufferStore,
        trace: [{ event: 'the_conclusion' }],
      });

      expect(envelope.status).toBe('ok');
      const snap = envelope.evidence[0];
      expect(snap?.trace_summary?.buffered_lines_adopted).toBeUndefined();
    });

    it('no traceBufferStore configured at all → no caveat (pre-#185 shape, still exact)', async () => {
      const { run } = await store.create({
        workflowId: 'wal-test-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, agentDef, {
        runId: run.id,
        command: 'step-agent',
        input: {},
        dispatcher: async () => ({}),
        trace: [{ event: 'the_conclusion' }],
      });

      expect(envelope.status).toBe('ok');
      const snap = envelope.evidence[0];
      expect(snap?.trace_summary?.buffered_lines_adopted).toBeUndefined();
    });
  });

  describe('Regression guard — off the overflow/race/foreign-line paths, output is unchanged', () => {
    it('a normal WAL contribution (buffer well under budget) + a conclusion produces the same merged trace shape as before #185', async () => {
      const bufferStore = new InMemoryTraceBufferStore();
      const { run } = await store.create({
        workflowId: 'wal-test-wf',
        workflowVersion: 1,
        params: {},
      });

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
      const walEntry = snap?.trace?.find((e) => e.event === 'wal_first');
      const finalEntry = snap?.trace?.find((e) => e.event === 'final_last');
      expect(walEntry?.seq).toBeLessThan(finalEntry!.seq);
      expect(snap?.trace_summary?.truncated).toBe(false);
      expect(snap?.trace_summary?.buffered_lines_adopted).toBe(1);
    });

    it('an execute_step.trace-only step (no traceBufferStore) is byte-identical to before #185', async () => {
      const { run } = await store.create({
        workflowId: 'wal-test-wf',
        workflowVersion: 1,
        params: {},
      });

      const envelope = await executeStep(store, agentDef, {
        runId: run.id,
        command: 'step-agent',
        input: {},
        dispatcher: async () => ({}),
        trace: [{ event: 'direct_trace', data: { k: 'v' } }],
      });

      expect(envelope.status).toBe('ok');
      const snap = envelope.evidence[0];
      expect(snap?.trace).toEqual([{ seq: 1, event: 'direct_trace', data: { k: 'v' } }]);
      expect(snap?.trace_summary).toEqual({
        submitted_entries: 1,
        stored_entries: 1,
        discarded_entries: 0,
        discarded_reserved_event_entries: 0,
        discarded_overflow_entries: 0,
        truncated: false,
      });
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

  it('non-terminal failure with wait_for_human exposes recovery branch', async () => {
    const { run: run } = await store.create({
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
    expect(envelope.next_actions[0]?.instruction!.call_with.command).toBe('step_b');
    expect(
      envelope.context_hint.toLowerCase().includes('service') ||
        envelope.context_hint.toLowerCase().includes('recovery'),
    ).toBe(true);
  });

  it('non-terminal failure with provide_input is translated to report_to_user and exposes recovery branch', async () => {
    const { run: run } = await store.create({
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
    expect(envelope.next_actions[0]?.instruction!.call_with.command).toBe('step_b');
  });

  it('non-terminal failure with stop is translated to report_to_user and exposes recovery branch', async () => {
    const { run: run } = await store.create({
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

    const { run: run } = await store.create({
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

  it('WAL deletion failure does NOT suppress next_actions', async () => {
    const bufferStore = new InMemoryTraceBufferStore();
    vi.spyOn(bufferStore, 'delete').mockRejectedValue(new Error('disk contention'));

    const { run: run } = await store.create({
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

  it('a migrated settleStep failure suppresses next_actions and hard-stops (issue #279 PR-B)', async () => {
    const { run: run } = await store.create({
      workflowId: 'two-step-wf',
      workflowVersion: 1,
      params: {},
    });

    // JsonFileStore declares settleStep — the fail site's MIGRATED path handles this run;
    // store.update is never called there, so simulating a persist failure means mocking
    // settleStep. A genuine throw now hard-stops (agent_action: 'stop') REGARDLESS of the
    // original dispatch error's own agentAction — design record §1/D1's replicated
    // complete-site catch pattern overrides it, rather than degrading to a warning that
    // preserves the original semantics.
    vi.spyOn(store, 'settleStep').mockRejectedValue(new Error('disk full'));

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
    expect(envelope.error_code).toBe('ENGINE_STORE_FAILED');
    expect(envelope.agent_action).toBe('stop');
    expect(envelope.next_actions).toHaveLength(0);
    expect(envelope.errors.some((w) => w.toLowerCase().includes('persist'))).toBe(true);
  });

  it('run_version reflects persisted version not stale pre-persist version', async () => {
    const { run: run } = await store.create({
      workflowId: 'single-step-wf',
      workflowVersion: 1,
      params: {},
    });

    // issue #279 (increment 1, PR-B): JsonFileStore declares settleStep — the fail site's
    // MIGRATED path settles via settleStep, not store.update. Track the version it returns.
    const originalSettleStep = store.settleStep!.bind(store);
    let persistedVersion: number | undefined;
    vi.spyOn(store, 'settleStep').mockImplementation(async (...args) => {
      const result = await originalSettleStep(...args);
      if (result.applied) persistedVersion = result.run.version;
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
});

// ---------------------------------------------------------------------------
// retry_after field on ResponseEnvelope
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
    const { run: run } = await store.create({
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
    const { run: run } = await store.create({
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
      persistsClaims: store.persistsClaims,
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

      const { run: run } = await store.create({
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

      const { run: run } = await store.create({
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
// min_retry_seconds floor
// ---------------------------------------------------------------------------

describe('min_retry_seconds floor', () => {
  let store: JsonFileStore;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-min-retry-test-'));
    store = new JsonFileStore(dir);
  });

  it('floors a short Retry-After header to min_retry_seconds', async () => {
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
      let attempt = 0;
      const adapter: ServiceAdapter = {
        id: 'rl_floor_adapter',
        fetch: vi.fn().mockImplementation(async () => {
          attempt++;
          if (attempt === 1) {
            throw new WorkflowError('Rate limited', {
              code: 'SERVICE_RATE_LIMITED',
              category: 'SERVICE',
              agentAction: 'wait_and_proceed',
              retryable: true,
              retry_after: 1,
            });
          }
          return { status: 200, data: { ok: true } };
        }),
        create: vi.fn(),
        update: vi.fn(),
      };
      const registry = new ExtensionRegistry();
      registry.register('adapter', 'rl_floor_adapter', adapter);

      const def: WorkflowDefinition = {
        id: 'min-retry-floor-wf',
        name: 'Min Retry Floor Workflow',
        version: 1,
        services: {
          svc: {
            adapter: 'rl_floor_adapter',
            trust: 'engine_delivered',
            rate_limit: { min_retry_seconds: 30 },
          },
        },
        steps: {
          step_a: {
            description: 'Step using rate-limited service',
            execution: 'auto',
            depends_on: [],
            uses_service: 'svc',
            retry: { max_attempts: 2, backoff: 'fixed', base_delay_ms: 500 },
          },
        },
      };

      const { run: run } = await store.create({
        workflowId: 'min-retry-floor-wf',
        workflowVersion: 1,
        params: {},
      });
      const result = await executeStep(store, def, {
        runId: run.id,
        command: 'step_a',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      expect(result.status).toBe('ok');
      expect(attempt).toBe(2);
      // min_retry_seconds=30 floors retry_after: 1 → 30; Math.max(500, 30000) = 30000
      expect(capturedDelays).toContain(30000);
    } finally {
      (globalThis as Record<string, unknown>)['setTimeout'] = origSetTimeout;
    }
  });

  it('acts as fallback when no Retry-After header', async () => {
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
      let attempt = 0;
      const adapter: ServiceAdapter = {
        id: 'rl_fallback_adapter',
        fetch: vi.fn().mockImplementation(async () => {
          attempt++;
          if (attempt === 1) {
            throw new WorkflowError('Rate limited', {
              code: 'SERVICE_RATE_LIMITED',
              category: 'SERVICE',
              agentAction: 'wait_and_proceed',
              retryable: true,
              // no retry_after — min_retry_seconds acts as floor
            });
          }
          return { status: 200, data: { ok: true } };
        }),
        create: vi.fn(),
        update: vi.fn(),
      };
      const registry = new ExtensionRegistry();
      registry.register('adapter', 'rl_fallback_adapter', adapter);

      const def: WorkflowDefinition = {
        id: 'min-retry-fallback-wf',
        name: 'Min Retry Fallback Workflow',
        version: 1,
        services: {
          svc: {
            adapter: 'rl_fallback_adapter',
            trust: 'engine_delivered',
            rate_limit: { min_retry_seconds: 30 },
          },
        },
        steps: {
          step_a: {
            description: 'Step using rate-limited service',
            execution: 'auto',
            depends_on: [],
            uses_service: 'svc',
            retry: { max_attempts: 2, backoff: 'fixed', base_delay_ms: 500 },
          },
        },
      };

      const { run: run } = await store.create({
        workflowId: 'min-retry-fallback-wf',
        workflowVersion: 1,
        params: {},
      });
      const result = await executeStep(store, def, {
        runId: run.id,
        command: 'step_a',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      expect(result.status).toBe('ok');
      expect(attempt).toBe(2);
      // no header → rawRetryAfter=undefined; min_retry_seconds=30 → Math.max(500, 30000) = 30000
      expect(capturedDelays).toContain(30000);
    } finally {
      (globalThis as Record<string, unknown>)['setTimeout'] = origSetTimeout;
    }
  });

  it('regression: no min_retry_seconds, short Retry-After header honoured as-is', async () => {
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
      let attempt = 0;
      const adapter: ServiceAdapter = {
        id: 'rl_regression_adapter',
        fetch: vi.fn().mockImplementation(async () => {
          attempt++;
          if (attempt === 1) {
            throw new WorkflowError('Rate limited', {
              code: 'SERVICE_RATE_LIMITED',
              category: 'SERVICE',
              agentAction: 'wait_and_proceed',
              retryable: true,
              retry_after: 1,
            });
          }
          return { status: 200, data: { ok: true } };
        }),
        create: vi.fn(),
        update: vi.fn(),
      };
      const registry = new ExtensionRegistry();
      registry.register('adapter', 'rl_regression_adapter', adapter);

      const def: WorkflowDefinition = {
        id: 'min-retry-regression-wf',
        name: 'Min Retry Regression Workflow',
        version: 1,
        services: {
          svc: {
            adapter: 'rl_regression_adapter',
            trust: 'engine_delivered',
            // no rate_limit — min_retry_seconds absent
          },
        },
        steps: {
          step_a: {
            description: 'Step using rate-limited service',
            execution: 'auto',
            depends_on: [],
            uses_service: 'svc',
            retry: { max_attempts: 2, backoff: 'fixed', base_delay_ms: 500 },
          },
        },
      };

      const { run: run } = await store.create({
        workflowId: 'min-retry-regression-wf',
        workflowVersion: 1,
        params: {},
      });
      const result = await executeStep(store, def, {
        runId: run.id,
        command: 'step_a',
        input: {},
        dispatcher: echoDispatcher,
        registry,
      });

      expect(result.status).toBe('ok');
      expect(attempt).toBe(2);
      // no min_retry_seconds; retry_after=1 honoured; Math.max(500, 1000) = 1000
      expect(capturedDelays).toContain(1000);
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
    const { run: run } = await store.create({
      workflowId: 'guard-wf',
      workflowVersion: 1,
      params: {},
    });

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
    expect(envelope.next_actions.some((a) => a.instruction?.call_with.command === 'step_c')).toBe(
      true,
    );

    const savedRun = await store.get(run.id);
    expect(savedRun.completed_steps).toContain('guard_b');
    expect(savedRun.run_phase).not.toBe('aborted');
  });

  it('guard aborts — run_phase becomes aborted, next_actions is empty, aborted_at set', async () => {
    const { run: run } = await store.create({
      workflowId: 'guard-wf',
      workflowVersion: 1,
      params: {},
    });

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
    expect(savedRun.aborted_at?.conditions?.[0]?.passed).toBe(false);
  });

  it('guard abort skips downstream steps (step_c goes into skipped_steps)', async () => {
    const { run: run } = await store.create({
      workflowId: 'guard-wf',
      workflowVersion: 1,
      params: {},
    });

    await executeChain(store, guardWorkflow, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: async () => ({ status: 'closed' }),
    });

    const savedRun = await store.get(run.id);
    expect(savedRun.skipped_steps).toContain('step_c');
  });

  it('a guard abort records a guard_abort skip_details entry, plus a cascade detail for the downstream step (issue #111)', async () => {
    const { run: run } = await store.create({
      workflowId: 'guard-wf',
      workflowVersion: 1,
      params: {},
    });

    await executeChain(store, guardWorkflow, {
      runId: run.id,
      command: 'step_a',
      input: {},
      dispatcher: async () => ({ status: 'closed' }),
    });

    const savedRun = await store.get(run.id);
    expect(savedRun.skip_details?.['guard_b']).toEqual({ kind: 'guard_abort' });
    // The merge is load-bearing — the cascade detail for 'step_c' (skipped because its
    // all_success dep 'guard_b' never completed) must survive alongside 'guard_b''s own tag.
    expect(savedRun.skip_details?.['step_c']?.kind).toBe('trigger_rule_unsatisfiable');
  });

  it('guard resolution error — run_phase becomes failed, guard in failed_steps', async () => {
    const { run: run } = await store.create({
      workflowId: 'guard-wf',
      workflowVersion: 1,
      params: {},
    });

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

    const { run: run } = await store.create({
      workflowId: 'guard-msg-wf',
      workflowVersion: 1,
      params: {},
    });

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

    const { run: run } = await store.create({
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
    expect(envelope.next_actions.some((a) => a.instruction?.call_with.command === 'step_d')).toBe(
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

    const { run: run } = await store.create({
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

// ---------------------------------------------------------------------------
// Gap A — handler warn result
// ---------------------------------------------------------------------------

describe('handler warn result', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-warn-test-'));
    store = new JsonFileStore(dir);
  });

  const warnDefinition: WorkflowDefinition = {
    id: 'warn-wf',
    name: 'Warn Workflow',
    version: 1,
    steps: {
      validate: {
        description: 'Run validation with warn',
        execution: 'auto',
        depends_on: [],
        handler: 'warn_handler',
      },
    },
  };

  it('handler returning warn completes step with warning in evidence and envelope', async () => {
    const handler: StepHandler = {
      id: 'warn_handler',
      execute: vi.fn().mockResolvedValue({ data: { x: 1 }, warn: { message: 'quota near limit' } }),
    };
    const registry = new ExtensionRegistry();
    registry.register('handler', 'warn_handler', handler);

    const { run: run } = await store.create({
      workflowId: 'warn-wf',
      workflowVersion: 1,
      params: {},
    });
    const envelope = await executeStep(store, warnDefinition, {
      runId: run.id,
      command: 'validate',
      input: {},
      dispatcher: echoDispatcher,
      registry,
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.warnings).toEqual(['quota near limit']);

    const updatedRun = await store.get(run.id);
    expect(updatedRun.completed_steps).toContain('validate');
    const snap = updatedRun.evidence.find((e) => e.step_id === 'validate');
    expect(snap?.warn).toBe('quota near limit');
  });

  it('warn result does not retry — completes on first attempt', async () => {
    const handler: StepHandler = {
      id: 'warn_handler',
      execute: vi.fn().mockResolvedValue({ data: { x: 1 }, warn: { message: 'near limit' } }),
    };
    const registry = new ExtensionRegistry();
    registry.register('handler', 'warn_handler', handler);

    const retryDef: WorkflowDefinition = {
      ...warnDefinition,
      steps: {
        validate: {
          ...warnDefinition.steps['validate']!,
          retry: { max_attempts: 3, backoff: 'fixed', base_delay_ms: 1 },
        },
      },
    };

    const { run: run } = await store.create({
      workflowId: 'warn-wf',
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, retryDef, {
      runId: run.id,
      command: 'validate',
      input: {},
      dispatcher: echoDispatcher,
      registry,
    });

    expect(handler.execute).toHaveBeenCalledTimes(1);
    const snap = (await store.get(run.id)).evidence.find((e) => e.step_id === 'validate');
    expect(snap?.attempt).toBe(1);
  });

  it('warn from step 1 propagates into final chain warnings', async () => {
    const handler: StepHandler = {
      id: 'warn_handler',
      execute: vi
        .fn()
        .mockResolvedValue({ data: { processed: true }, warn: { message: 'from step 1' } }),
    };
    const registry = new ExtensionRegistry();
    registry.register('handler', 'warn_handler', handler);

    const chainDef: WorkflowDefinition = {
      id: 'warn-chain-wf',
      name: 'Warn Chain',
      version: 1,
      steps: {
        step1: {
          description: 'First step with warn',
          execution: 'auto',
          depends_on: [],
          handler: 'warn_handler',
        },
        step2: {
          description: 'Second step',
          execution: 'agent',
          depends_on: ['step1'],
        },
      },
    };

    const { run: run } = await store.create({
      workflowId: 'warn-chain-wf',
      workflowVersion: 1,
      params: {},
    });
    const envelope = await executeChain(store, chainDef, {
      runId: run.id,
      command: 'step1',
      input: {},
      dispatcher: echoDispatcher,
      registry,
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.warnings).toContain('from step 1');
  });

  it('handler returning no warn produces no warn in evidence and empty warnings', async () => {
    const handler: StepHandler = {
      id: 'warn_handler',
      execute: vi.fn().mockResolvedValue({ data: { x: 1 } }),
    };
    const registry = new ExtensionRegistry();
    registry.register('handler', 'warn_handler', handler);

    const { run: run } = await store.create({
      workflowId: 'warn-wf',
      workflowVersion: 1,
      params: {},
    });
    const envelope = await executeStep(store, warnDefinition, {
      runId: run.id,
      command: 'validate',
      input: {},
      dispatcher: echoDispatcher,
      registry,
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.warnings).toEqual([]);

    const snap = (await store.get(run.id)).evidence.find((e) => e.step_id === 'validate');
    expect(snap?.warn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gap B — run.params in when condition (execution-loop integration)
// ---------------------------------------------------------------------------

describe('when: run.params integration', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-runparams-test-'));
    store = new JsonFileStore(dir);
  });

  it('step with when: run.params.mode == live is skipped when run started with mode: shadow', async () => {
    const shadowDef: WorkflowDefinition = {
      id: 'shadow-wf',
      name: 'Shadow Workflow',
      version: 1,
      steps: {
        classify: {
          description: 'Classify',
          execution: 'auto',
          depends_on: [],
          handler: 'classify_handler',
        },
        post_action: {
          description: 'Post result — skipped in shadow mode',
          execution: 'auto',
          depends_on: ['classify'],
          when: "run.params.mode == 'live'",
          handler: 'post_handler',
        },
      },
    };

    const classifyHandler: StepHandler = {
      id: 'classify_handler',
      execute: vi.fn().mockResolvedValue({ data: { category: 'billing' } }),
    };
    const postHandler: StepHandler = {
      id: 'post_handler',
      execute: vi.fn().mockResolvedValue({ data: {} }),
    };
    const registry = new ExtensionRegistry();
    registry.register('handler', 'classify_handler', classifyHandler);
    registry.register('handler', 'post_handler', postHandler);

    const { run: run } = await store.create({
      workflowId: 'shadow-wf',
      workflowVersion: 1,
      params: { mode: 'shadow' },
    });

    const envelope = await executeChain(store, shadowDef, {
      runId: run.id,
      command: 'classify',
      input: {},
      dispatcher: echoDispatcher,
      registry,
    });

    expect(envelope.status).toBe('ok');
    const savedRun = await store.get(run.id);
    expect(savedRun.completed_steps).toContain('classify');
    expect(savedRun.skipped_steps).toContain('post_action');
    expect(savedRun.terminal_state).toBe(true);
    expect(postHandler.execute).not.toHaveBeenCalled();
    // issue #111: the regular (non-abort) complete path writes skip_details too.
    expect(savedRun.skip_details?.['post_action']?.kind).toBe('when_false');
  });
});

// ---------------------------------------------------------------------------
// Gap C — input_map on handler steps (execution-loop integration)
// ---------------------------------------------------------------------------

describe('input_map on handler steps', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-inputmap-handler-test-'));
    store = new JsonFileStore(dir);
  });

  it('handler step with $literal input_map receives resolved params', async () => {
    const handler: StepHandler = {
      id: 'table_handler',
      execute: vi.fn().mockResolvedValue({ data: { ok: true } }),
    };
    const registry = new ExtensionRegistry();
    registry.register('handler', 'table_handler', handler);

    const def: WorkflowDefinition = {
      id: 'inputmap-handler-wf',
      name: 'Input Map Handler',
      version: 1,
      steps: {
        fetch: {
          description: 'Fetch with literal input map',
          execution: 'auto',
          depends_on: [],
          handler: 'table_handler',
          input_map: { table: { $literal: 'CS_Macros' } },
        },
      },
    };

    const { run: run } = await store.create({
      workflowId: 'inputmap-handler-wf',
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, def, {
      runId: run.id,
      command: 'fetch',
      input: {},
      dispatcher: echoDispatcher,
      registry,
    });

    expect(handler.execute).toHaveBeenCalledWith(
      { params: { table: 'CS_Macros' } },
      expect.anything(),
      expect.any(AbortSignal),
    );
  });

  it('handler step with input_map reads from run.params', async () => {
    const handler: StepHandler = {
      id: 'ticket_handler',
      execute: vi.fn().mockResolvedValue({ data: {} }),
    };
    const registry = new ExtensionRegistry();
    registry.register('handler', 'ticket_handler', handler);

    const def: WorkflowDefinition = {
      id: 'inputmap-params-wf',
      name: 'Input Map Params',
      version: 1,
      steps: {
        process: {
          description: 'Process ticket',
          execution: 'auto',
          depends_on: [],
          handler: 'ticket_handler',
          input_map: { id: 'run.params.ticket_id' },
        },
      },
    };

    const { run: run } = await store.create({
      workflowId: 'inputmap-params-wf',
      workflowVersion: 1,
      params: { ticket_id: 'TKT-42' },
    });
    await executeStep(store, def, {
      runId: run.id,
      command: 'process',
      input: {},
      dispatcher: echoDispatcher,
      registry,
    });

    expect(handler.execute).toHaveBeenCalledWith(
      { params: { id: 'TKT-42' } },
      expect.anything(),
      expect.any(AbortSignal),
    );
  });

  it('handler step with input_map has resolved_params in EvidenceSnapshot', async () => {
    const handler: StepHandler = {
      id: 'table_handler',
      execute: vi.fn().mockResolvedValue({ data: { ok: true } }),
    };
    const registry = new ExtensionRegistry();
    registry.register('handler', 'table_handler', handler);

    const def: WorkflowDefinition = {
      id: 'inputmap-evidence-wf',
      name: 'Input Map Evidence',
      version: 1,
      steps: {
        fetch: {
          description: 'Fetch with literal input map',
          execution: 'auto',
          depends_on: [],
          handler: 'table_handler',
          input_map: { table: { $literal: 'CS_Macros' } },
        },
      },
    };

    const { run: run } = await store.create({
      workflowId: 'inputmap-evidence-wf',
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, def, {
      runId: run.id,
      command: 'fetch',
      input: {},
      dispatcher: echoDispatcher,
      registry,
    });

    const snap = (await store.get(run.id)).evidence.find((e) => e.step_id === 'fetch');
    expect(snap?.resolved_params).toEqual({ table: 'CS_Macros' });
  });

  it('handler step without input_map passes empty options.input to handler', async () => {
    const handler: StepHandler = {
      id: 'simple_handler',
      execute: vi.fn().mockResolvedValue({ data: {} }),
    };
    const registry = new ExtensionRegistry();
    registry.register('handler', 'simple_handler', handler);

    const def: WorkflowDefinition = {
      id: 'no-inputmap-wf',
      name: 'No Input Map',
      version: 1,
      steps: {
        process: {
          description: 'Process without input_map',
          execution: 'auto',
          depends_on: [],
          handler: 'simple_handler',
        },
      },
    };

    const { run: run } = await store.create({
      workflowId: 'no-inputmap-wf',
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, def, {
      runId: run.id,
      command: 'process',
      input: {},
      dispatcher: echoDispatcher,
      registry,
    });

    expect(handler.execute).toHaveBeenCalledWith(
      { params: {} },
      expect.anything(),
      expect.any(AbortSignal),
    );
  });
});

// ---------------------------------------------------------------------------
// Gap E — _debug capture
// ---------------------------------------------------------------------------

describe('_debug field capture', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-debug-test-'));
    store = new JsonFileStore(dir);
  });

  const debugDef: WorkflowDefinition = {
    id: 'debug-wf',
    name: 'Debug Workflow',
    version: 1,
    steps: {
      classify: {
        description: 'Agent step with output_schema',
        execution: 'agent',
        depends_on: [],
        output_schema: {
          type: 'object',
          required: ['category'],
          properties: { category: { type: 'string' } },
        },
      },
    },
  };

  it('_debug passes schema validation and is stored as debug_output (not in output_summary)', async () => {
    const { run: run } = await store.create({
      workflowId: 'debug-wf',
      workflowVersion: 1,
      params: {},
    });

    await executeStep(store, debugDef, {
      runId: run.id,
      command: 'classify',
      input: { category: 'billing', _debug: 'reasoning here' },
      dispatcher: echoDispatcher,
    });

    const updatedRun = await store.get(run.id);
    const snap = updatedRun.evidence.find((e) => e.step_id === 'classify');
    expect(snap).toBeDefined();
    expect(snap?.debug_output).toBe('reasoning here');
    expect((snap?.output_summary as Record<string, unknown>)['_debug']).toBeUndefined();
  });

  it('_debug does not appear in output_summary', async () => {
    const { run: run } = await store.create({
      workflowId: 'debug-wf',
      workflowVersion: 1,
      params: {},
    });

    await executeStep(store, debugDef, {
      runId: run.id,
      command: 'classify',
      input: { category: 'billing', _debug: 'internal notes' },
      dispatcher: echoDispatcher,
    });

    const snap = (await store.get(run.id)).evidence.find((e) => e.step_id === 'classify');
    expect(Object.keys(snap?.output_summary as object)).not.toContain('_debug');
  });

  it('evidence_hash is the same whether or not _debug is present', async () => {
    const { run: run1 } = await store.create({
      workflowId: 'debug-wf',
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, debugDef, {
      runId: run1.id,
      command: 'classify',
      input: { category: 'billing' },
      dispatcher: echoDispatcher,
    });

    const { run: run2 } = await store.create({
      workflowId: 'debug-wf',
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, debugDef, {
      runId: run2.id,
      command: 'classify',
      input: { category: 'billing', _debug: 'reasoning text' },
      dispatcher: echoDispatcher,
    });

    const snap1 = (await store.get(run1.id)).evidence.find((e) => e.step_id === 'classify');
    const snap2 = (await store.get(run2.id)).evidence.find((e) => e.step_id === 'classify');
    expect(snap1?.evidence_hash).toBe(snap2?.evidence_hash);
  });

  it('step without _debug produces no debug_output field on the snapshot', async () => {
    const { run: run } = await store.create({
      workflowId: 'debug-wf',
      workflowVersion: 1,
      params: {},
    });

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

// ---------------------------------------------------------------------------
// Gap E correction — _debug stripping on direct auto-step invocation
// ---------------------------------------------------------------------------

describe('_debug stripping on direct auto-step invocation', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-debug-strip-test-'));
    store = new JsonFileStore(dir);
  });

  it('handler step without input_map receives params with _debug stripped', async () => {
    const handler: StepHandler = {
      id: 'strip_handler',
      execute: vi.fn().mockResolvedValue({ data: { ok: true } }),
    };
    const registry = new ExtensionRegistry();
    registry.register('handler', 'strip_handler', handler);

    const def: WorkflowDefinition = {
      id: 'debug-strip-handler-wf',
      name: 'Debug Strip Handler',
      version: 1,
      steps: {
        process: {
          description: 'Handler step invoked directly with _debug',
          execution: 'auto',
          depends_on: [],
          handler: 'strip_handler',
        },
      },
    };

    const { run: run } = await store.create({
      workflowId: 'debug-strip-handler-wf',
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, def, {
      runId: run.id,
      command: 'process',
      input: { foo: 1, _debug: 'note' },
      dispatcher: echoDispatcher,
      registry,
    });

    expect(handler.execute).toHaveBeenCalledWith(
      { params: { foo: 1 } },
      expect.anything(),
      expect.any(AbortSignal),
    );

    const snap = (await store.get(run.id)).evidence.find((e) => e.step_id === 'process');
    expect(snap?.debug_output).toBe('note');
    expect(Object.keys(snap?.input_summary as object)).not.toContain('_debug');
  });

  it('adapter step without input_map receives params with _debug stripped', async () => {
    const adapter: ServiceAdapter = {
      id: 'strip_adapter',
      fetch: vi.fn().mockResolvedValue({ status: 200, data: { content: 'hello' } }),
      create: vi.fn(),
      update: vi.fn(),
    };
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'strip_adapter', adapter);

    const def: WorkflowDefinition = {
      id: 'debug-strip-adapter-wf',
      name: 'Debug Strip Adapter',
      version: 1,
      services: {
        my_service: { adapter: 'strip_adapter', trust: 'engine_delivered' },
      },
      steps: {
        fetch_data: {
          description: 'Adapter step invoked directly with _debug',
          execution: 'auto',
          depends_on: [],
          uses_service: 'my_service',
        },
      },
    };

    const { run: run } = await store.create({
      workflowId: 'debug-strip-adapter-wf',
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, def, {
      runId: run.id,
      command: 'fetch_data',
      input: { id: 'x', _debug: 'note' },
      dispatcher: echoDispatcher,
      registry,
    });

    expect(adapter.fetch).toHaveBeenCalledWith(
      'fetch_data',
      { id: 'x' },
      expect.objectContaining({ adapter: 'strip_adapter' }),
      expect.any(AbortSignal),
    );
  });

  it('abort evidence snapshot has _debug stripped from input_summary and preserved as debug_output', async () => {
    const handler: StepHandler = {
      id: 'abort_handler',
      execute: vi.fn().mockResolvedValue({ abort: { message: 'closed' } }),
    };
    const registry = new ExtensionRegistry();
    registry.register('handler', 'abort_handler', handler);

    const def: WorkflowDefinition = {
      id: 'debug-strip-abort-wf',
      name: 'Debug Strip Abort',
      version: 1,
      steps: {
        check: {
          description: 'Handler step that aborts',
          execution: 'auto',
          depends_on: [],
          handler: 'abort_handler',
        },
      },
    };

    const { run: run } = await store.create({
      workflowId: 'debug-strip-abort-wf',
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, def, {
      runId: run.id,
      command: 'check',
      input: { foo: 1, _debug: 'note' },
      dispatcher: echoDispatcher,
      registry,
    });

    const snap = (await store.get(run.id)).evidence.find((e) => e.step_id === 'check');
    expect(snap?.status).toBe('skipped');
    expect(Object.keys(snap?.input_summary as object)).not.toContain('_debug');
    expect(snap?.debug_output).toBe('note');
  });
});

// ---------------------------------------------------------------------------
// Issue #91: executeChain terminal-run entry guard (defense-in-depth)
// ---------------------------------------------------------------------------

describe('executeChain — terminal-run entry guard (#91)', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-chain-entry-test-'));
    store = new JsonFileStore(dir);
  });

  it('is a byte-unchanged no-op on a terminal aborted run (no step claimed)', async () => {
    const { run: run } = await store.create({
      workflowId: 'test-wf',
      workflowVersion: 1,
      params: {},
    });
    await store.update({
      ...run,
      run_phase: 'aborted',
      terminal_state: true,
      terminal_reason: "Guard 'g' aborted the run",
      aborted_at: { step_id: 'step-one' },
    });
    const before = await store.get(run.id);
    const dispatcher = vi.fn(echoDispatcher);

    const envelope = await executeChain(store, definition, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher,
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.agent_action).toBe('stop');
    expect(envelope.next_actions).toEqual([]);
    expect(envelope.run_version).toBe(before.version);
    expect(envelope.run_phase).toBe('aborted'); // #92: signal present on the entry-guard envelope
    expect(dispatcher).not.toHaveBeenCalled(); // no step executed
    const after = await store.get(run.id);
    expect(after).toEqual(before); // byte-unchanged (version, step sets, everything)
  });

  it('is a byte-unchanged no-op on a terminal completed run (no aborted_at)', async () => {
    const { run: run } = await store.create({
      workflowId: 'test-wf',
      workflowVersion: 1,
      params: {},
    });
    await store.update({
      ...run,
      run_phase: 'completed',
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
      completed_steps: ['step-one', 'step-two'],
    });
    const before = await store.get(run.id);
    const dispatcher = vi.fn(echoDispatcher);

    const envelope = await executeChain(store, definition, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher,
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.agent_action).toBe('stop');
    expect(dispatcher).not.toHaveBeenCalled();
    const after = await store.get(run.id);
    expect(after).toEqual(before);
  });

  it('does NOT over-fire — a non-terminal (running) run is still driven', async () => {
    const { run: run } = await store.create({
      workflowId: 'test-wf',
      workflowVersion: 1,
      params: {},
    });
    const createdVersion = run.version;
    const dispatcher = vi.fn(echoDispatcher);

    await executeChain(store, definition, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher,
    });

    expect(dispatcher).toHaveBeenCalled(); // the running run was driven
    const after = await store.get(run.id);
    expect(after.completed_steps).toContain('step-one');
    expect(after.version).toBeGreaterThan(createdVersion);
  });
});

// Issue #92 follow-up (0.10.0): submitHumanResponse defensive terminal guard.
describe('submitHumanResponse — terminal-run guard', () => {
  let store: JsonFileStore;
  let dir: string;

  const gateWf: WorkflowDefinition = {
    id: 'gate-terminal-wf',
    name: 'Gate Terminal WF',
    version: 1,
    steps: {
      gate_step: {
        description: 'Gate',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: { choices: ['approve', 'reject'] },
      },
    },
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-gate-terminal-'));
    store = new JsonFileStore(dir);
  });

  it('a gate response on a terminal run is rejected with STATE_RUN_TERMINAL (no re-drive)', async () => {
    const { run } = await store.create({
      workflowId: 'gate-terminal-wf',
      workflowVersion: 1,
      params: {},
    });
    // Open the gate.
    const opened = await executeStep(store, gateWf, {
      runId: run.id,
      command: 'gate_step',
      input: {},
      dispatcher: async () => ({}),
    });
    expect(opened.status).toBe('confirm_required');
    const gateId = opened.gate!.gate_id;

    // Force the run terminal underneath the open gate (simulating a late abandon/completion path),
    // then attempt a late gate response.
    const gated = await store.get(run.id);
    await store.update({ ...gated, terminal_state: true, abandoned_at: new Date().toISOString() });
    const before = await store.get(run.id);

    const envelope = await submitHumanResponse(store, gateWf, {
      runId: run.id,
      gateId,
      choice: 'approve',
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error_code).toBe('STATE_RUN_TERMINAL');
    // Run not re-driven by the late response.
    const after = await store.get(run.id);
    expect(after.version).toBe(before.version);
    expect(after.terminal_state).toBe(true);
  });

  it('cleanup', async () => {
    await rm(dir, { recursive: true, force: true });
  });
});
