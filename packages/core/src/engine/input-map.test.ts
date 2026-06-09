// Tests for input_map — static path-mapping for adapter params from run state.
// Source: execution-loop.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeStep } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepDispatcher } from './execution-loop.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import { MockAdapter } from '../adapters/mock-adapter.js';
import { vi } from 'vitest';

const noOpDispatcher: StepDispatcher = async (_step, _input, _run, _signal) => ({});

describe('input_map', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-input-map-'));
  });

  it('absent input_map — options.input passed to adapter unchanged', async () => {
    const def: WorkflowDefinition = {
      id: 'imap-wf',
      name: 'InputMap Workflow',
      version: 1,
      services: { svc: { adapter: 'mock', trust: 'engine_delivered' } },
      steps: {
        fetch: {
          description: 'Fetch without input_map',
          execution: 'auto',
          depends_on: [],
          uses_service: 'svc',
        },
      },
    };
    const adapter = new MockAdapter('mock', { fetch: { status: 200, data: { ok: true } } });
    const fetchSpy = vi.spyOn(adapter, 'fetch');
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'mock', adapter);
    const store = new JsonFileStore(dir);
    const run = await store.create({
      workflowId: 'imap-wf',
      workflowVersion: 1,
      params: {},
    });

    await executeStep(store, def, {
      runId: run.id,
      command: 'fetch',
      input: { doc_id: 'xyz' },
      dispatcher: noOpDispatcher,
      registry,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'fetch',
      { doc_id: 'xyz' },
      expect.any(Object),
      undefined,
    );
  });

  it('input_map from run.params', async () => {
    const def: WorkflowDefinition = {
      id: 'imap-wf',
      name: 'InputMap Workflow',
      version: 1,
      services: { svc: { adapter: 'mock', trust: 'engine_delivered' } },
      steps: {
        setup: {
          description: 'Agent step that produces state',
          execution: 'agent',
          depends_on: [],
        },
        'call-api': {
          description: 'Auto step using run.params via input_map',
          execution: 'auto',
          depends_on: ['setup'],
          uses_service: 'svc',
          input_map: { repo: 'run.params.repo' },
        },
      },
    };
    const adapter = new MockAdapter('mock', { 'call-api': { status: 200, data: { result: 1 } } });
    const fetchSpy = vi.spyOn(adapter, 'fetch');
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'mock', adapter);
    const store = new JsonFileStore(dir);

    // Start run with params.repo = 'acme/api'
    const run = await store.create({
      workflowId: 'imap-wf',
      workflowVersion: 1,
      params: { repo: 'acme/api' },
    });

    // Execute the agent step first to advance state to 'ready'
    await executeStep(store, def, {
      runId: run.id,
      command: 'setup',
      input: {},
      dispatcher: noOpDispatcher,
    });

    const updatedRun = await store.get(run.id);
    await executeStep(store, def, {
      runId: updatedRun.id,
      command: 'call-api',
      input: {},
      dispatcher: noOpDispatcher,
      registry,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'call-api',
      { repo: 'acme/api' },
      expect.any(Object),
      undefined,
    );
  });

  it('input_map from context.resources (prior step output)', async () => {
    const def: WorkflowDefinition = {
      id: 'imap-wf',
      name: 'InputMap Workflow',
      version: 1,
      services: { svc: { adapter: 'mock', trust: 'engine_delivered' } },
      steps: {
        step1: {
          description: 'Handler step that outputs pr_number',
          execution: 'auto',
          handler: 'make-pr',
          depends_on: [],
        },
        step2: {
          description: 'Adapter step using context.resources',
          execution: 'auto',
          depends_on: ['step1'],
          uses_service: 'svc',
          input_map: { number: 'context.resources.step1.pr_number' },
        },
      },
    };

    // Handler that returns { pr_number: 42 }
    const handler = {
      id: 'make-pr',
      async execute(_inputs: unknown, _ctx: unknown) {
        return { data: { pr_number: 42 } };
      },
    };
    const adapter = new MockAdapter('mock', { step2: { status: 200, data: { done: true } } });
    const fetchSpy = vi.spyOn(adapter, 'fetch');
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'mock', adapter);
    registry.register('handler', 'make-pr', handler);
    const store = new JsonFileStore(dir);

    const run = await store.create({
      workflowId: 'imap-wf',
      workflowVersion: 1,
      params: {},
    });

    // Execute step1 (handler produces pr_number: 42 in evidence)
    await executeStep(store, def, {
      runId: run.id,
      command: 'step1',
      input: {},
      dispatcher: noOpDispatcher,
      registry,
    });

    const afterStep1 = await store.get(run.id);
    await executeStep(store, def, {
      runId: afterStep1.id,
      command: 'step2',
      input: {},
      dispatcher: noOpDispatcher,
      registry,
    });

    expect(fetchSpy).toHaveBeenCalledWith('step2', { number: 42 }, expect.any(Object), undefined);
  });

  it('unresolvable path produces undefined key in adapter params', async () => {
    const def: WorkflowDefinition = {
      id: 'imap-wf',
      name: 'InputMap Workflow',
      version: 1,
      services: { svc: { adapter: 'mock', trust: 'engine_delivered' } },
      steps: {
        fetch: {
          description: 'Step with bad path in input_map',
          execution: 'auto',
          depends_on: [],
          uses_service: 'svc',
          input_map: { x: 'run.params.nonexistent' },
        },
      },
    };
    const adapter = new MockAdapter('mock', { fetch: { status: 200, data: {} } });
    const fetchSpy = vi.spyOn(adapter, 'fetch');
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'mock', adapter);
    const store = new JsonFileStore(dir);
    const run = await store.create({
      workflowId: 'imap-wf',
      workflowVersion: 1,
      params: {},
    });

    await executeStep(store, def, {
      runId: run.id,
      command: 'fetch',
      input: {},
      dispatcher: noOpDispatcher,
      registry,
    });

    expect(fetchSpy).toHaveBeenCalledWith('fetch', { x: undefined }, expect.any(Object), undefined);
  });

  it('input_map step records resolved_params in evidence snapshot', async () => {
    const def: WorkflowDefinition = {
      id: 'imap-wf',
      name: 'InputMap Workflow',
      version: 1,
      services: { svc: { adapter: 'mock', trust: 'engine_delivered' } },
      steps: {
        'call-api': {
          description: 'Auto step using run.params via input_map',
          execution: 'auto',
          depends_on: [],
          uses_service: 'svc',
          input_map: { repo: 'run.params.repo' },
        },
      },
    };
    const adapter = new MockAdapter('mock', { 'call-api': { status: 200, data: { result: 1 } } });
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'mock', adapter);
    const store = new JsonFileStore(dir);

    const run = await store.create({
      workflowId: 'imap-wf',
      workflowVersion: 1,
      params: { repo: 'acme/api' },
    });

    await executeStep(store, def, {
      runId: run.id,
      command: 'call-api',
      input: {},
      dispatcher: noOpDispatcher,
      registry,
    });

    const updatedRun = await store.get(run.id);
    const snap = updatedRun.evidence.find((e) => e.step_id === 'call-api');
    expect(snap).toBeDefined();
    expect(snap!.resolved_params).toEqual({ repo: 'acme/api' });
  });

  it('step without input_map does NOT have resolved_params in evidence snapshot', async () => {
    const def: WorkflowDefinition = {
      id: 'imap-wf',
      name: 'InputMap Workflow',
      version: 1,
      services: { svc: { adapter: 'mock', trust: 'engine_delivered' } },
      steps: {
        fetch: {
          description: 'Auto step without input_map',
          execution: 'auto',
          depends_on: [],
          uses_service: 'svc',
        },
      },
    };
    const adapter = new MockAdapter('mock', { fetch: { status: 200, data: { ok: true } } });
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'mock', adapter);
    const store = new JsonFileStore(dir);

    const run = await store.create({
      workflowId: 'imap-wf',
      workflowVersion: 1,
      params: {},
    });

    await executeStep(store, def, {
      runId: run.id,
      command: 'fetch',
      input: { doc_id: 'xyz' },
      dispatcher: noOpDispatcher,
      registry,
    });

    const updatedRun = await store.get(run.id);
    const snap = updatedRun.evidence.find((e) => e.step_id === 'fetch');
    expect(snap).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(snap, 'resolved_params')).toBe(false);
  });

  it('input_map — nested object from run.params', async () => {
    const def: WorkflowDefinition = {
      id: 'imap-wf',
      name: 'InputMap Workflow',
      version: 1,
      services: { svc: { adapter: 'mock', trust: 'engine_delivered' } },
      steps: {
        upsert: {
          description: 'Adapter step using nested input_map',
          execution: 'auto',
          depends_on: [],
          uses_service: 'svc',
          input_map: {
            fields: {
              name: 'run.params.customer_name',
              email: 'run.params.email',
            },
          },
        },
      },
    };
    const adapter = new MockAdapter('mock', { upsert: { status: 200, data: {} } });
    const fetchSpy = vi.spyOn(adapter, 'fetch');
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'mock', adapter);
    const store = new JsonFileStore(dir);
    const run = await store.create({
      workflowId: 'imap-wf',
      workflowVersion: 1,
      params: { customer_name: 'Alice', email: 'alice@example.com' },
    });

    await executeStep(store, def, {
      runId: run.id,
      command: 'upsert',
      input: {},
      dispatcher: noOpDispatcher,
      registry,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'upsert',
      { fields: { name: 'Alice', email: 'alice@example.com' } },
      expect.any(Object),
      undefined,
    );
  });

  it('input_map — flat and nested keys coexist', async () => {
    const def: WorkflowDefinition = {
      id: 'imap-wf',
      name: 'InputMap Workflow',
      version: 1,
      services: { svc: { adapter: 'mock', trust: 'engine_delivered' } },
      steps: {
        call: {
          description: 'Step with mixed flat/nested input_map',
          execution: 'auto',
          depends_on: [],
          uses_service: 'svc',
          input_map: {
            table_id: 'run.params.table',
            fields: {
              status: 'run.params.status',
            },
          },
        },
      },
    };
    const adapter = new MockAdapter('mock', { call: { status: 200, data: {} } });
    const fetchSpy = vi.spyOn(adapter, 'fetch');
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'mock', adapter);
    const store = new JsonFileStore(dir);
    const run = await store.create({
      workflowId: 'imap-wf',
      workflowVersion: 1,
      params: { table: 'tbl_abc', status: 'open' },
    });

    await executeStep(store, def, {
      runId: run.id,
      command: 'call',
      input: {},
      dispatcher: noOpDispatcher,
      registry,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'call',
      { table_id: 'tbl_abc', fields: { status: 'open' } },
      expect.any(Object),
      undefined,
    );
  });

  it('input_map — nested map records resolved_params in evidence snapshot', async () => {
    const def: WorkflowDefinition = {
      id: 'imap-wf',
      name: 'InputMap Workflow',
      version: 1,
      services: { svc: { adapter: 'mock', trust: 'engine_delivered' } },
      steps: {
        upsert: {
          description: 'Nested input_map step',
          execution: 'auto',
          depends_on: [],
          uses_service: 'svc',
          input_map: {
            fields: { name: 'run.params.name' },
          },
        },
      },
    };
    const adapter = new MockAdapter('mock', { upsert: { status: 200, data: { id: '42' } } });
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'mock', adapter);
    const store = new JsonFileStore(dir);
    const run = await store.create({
      workflowId: 'imap-wf',
      workflowVersion: 1,
      params: { name: 'Bob' },
    });

    await executeStep(store, def, {
      runId: run.id,
      command: 'upsert',
      input: {},
      dispatcher: noOpDispatcher,
      registry,
    });

    const afterRun = await store.get(run.id);
    const snap = afterRun.evidence.find((e) => e.step_id === 'upsert');
    expect(snap).toBeDefined();
    expect(snap!.resolved_params).toEqual({ fields: { name: 'Bob' } });
  });

  it('input_map — $literal string value resolves without path lookup', async () => {
    const def: WorkflowDefinition = {
      id: 'imap-wf',
      name: 'InputMap Workflow',
      version: 1,
      services: { svc: { adapter: 'mock', trust: 'engine_delivered' } },
      steps: {
        insert: {
          description: 'Adapter step with literal table name',
          execution: 'auto',
          depends_on: [],
          uses_service: 'svc',
          input_map: { table: { $literal: 'CS_Macros' } },
        },
      },
    };
    const adapter = new MockAdapter('mock', { insert: { status: 200, data: {} } });
    const fetchSpy = vi.spyOn(adapter, 'fetch');
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'mock', adapter);
    const store = new JsonFileStore(dir);
    const run = await store.create({ workflowId: 'imap-wf', workflowVersion: 1, params: {} });

    await executeStep(store, def, {
      runId: run.id,
      command: 'insert',
      input: {},
      dispatcher: noOpDispatcher,
      registry,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'insert',
      { table: 'CS_Macros' },
      expect.any(Object),
      undefined,
    );
  });

  it('input_map — $literal boolean false resolves to false', async () => {
    const def: WorkflowDefinition = {
      id: 'imap-wf',
      name: 'InputMap Workflow',
      version: 1,
      services: { svc: { adapter: 'mock', trust: 'engine_delivered' } },
      steps: {
        query: {
          description: 'Adapter step with boolean literal',
          execution: 'auto',
          depends_on: [],
          uses_service: 'svc',
          input_map: { include_archived: { $literal: false } },
        },
      },
    };
    const adapter = new MockAdapter('mock', { query: { status: 200, data: {} } });
    const fetchSpy = vi.spyOn(adapter, 'fetch');
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'mock', adapter);
    const store = new JsonFileStore(dir);
    const run = await store.create({ workflowId: 'imap-wf', workflowVersion: 1, params: {} });

    await executeStep(store, def, {
      runId: run.id,
      command: 'query',
      input: {},
      dispatcher: noOpDispatcher,
      registry,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'query',
      { include_archived: false },
      expect.any(Object),
      undefined,
    );
  });

  it('input_map — $literal number resolves to number', async () => {
    const def: WorkflowDefinition = {
      id: 'imap-wf',
      name: 'InputMap Workflow',
      version: 1,
      services: { svc: { adapter: 'mock', trust: 'engine_delivered' } },
      steps: {
        list: {
          description: 'Adapter step with number literal',
          execution: 'auto',
          depends_on: [],
          uses_service: 'svc',
          input_map: { max_results: { $literal: 100 } },
        },
      },
    };
    const adapter = new MockAdapter('mock', { list: { status: 200, data: {} } });
    const fetchSpy = vi.spyOn(adapter, 'fetch');
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'mock', adapter);
    const store = new JsonFileStore(dir);
    const run = await store.create({ workflowId: 'imap-wf', workflowVersion: 1, params: {} });

    await executeStep(store, def, {
      runId: run.id,
      command: 'list',
      input: {},
      dispatcher: noOpDispatcher,
      registry,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'list',
      { max_results: 100 },
      expect.any(Object),
      undefined,
    );
  });

  it('input_map — $literal null resolves to null', async () => {
    const def: WorkflowDefinition = {
      id: 'imap-wf',
      name: 'InputMap Workflow',
      version: 1,
      services: { svc: { adapter: 'mock', trust: 'engine_delivered' } },
      steps: {
        clear: {
          description: 'Adapter step with null literal',
          execution: 'auto',
          depends_on: [],
          uses_service: 'svc',
          input_map: { owner: { $literal: null } },
        },
      },
    };
    const adapter = new MockAdapter('mock', { clear: { status: 200, data: {} } });
    const fetchSpy = vi.spyOn(adapter, 'fetch');
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'mock', adapter);
    const store = new JsonFileStore(dir);
    const run = await store.create({ workflowId: 'imap-wf', workflowVersion: 1, params: {} });

    await executeStep(store, def, {
      runId: run.id,
      command: 'clear',
      input: {},
      dispatcher: noOpDispatcher,
      registry,
    });

    expect(fetchSpy).toHaveBeenCalledWith('clear', { owner: null }, expect.any(Object), undefined);
  });

  it('input_map — mixed path leaf and literal leaf produces correct merged object', async () => {
    const def: WorkflowDefinition = {
      id: 'imap-wf',
      name: 'InputMap Workflow',
      version: 1,
      services: { svc: { adapter: 'mock', trust: 'engine_delivered' } },
      steps: {
        upsert2: {
          description: 'Adapter step with mixed path and literal',
          execution: 'auto',
          depends_on: [],
          uses_service: 'svc',
          input_map: {
            table: { $literal: 'CS_Macros' },
            record_id: 'run.params.id',
          },
        },
      },
    };
    const adapter = new MockAdapter('mock', { upsert2: { status: 200, data: {} } });
    const fetchSpy = vi.spyOn(adapter, 'fetch');
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'mock', adapter);
    const store = new JsonFileStore(dir);
    const run = await store.create({
      workflowId: 'imap-wf',
      workflowVersion: 1,
      params: { id: 'rec123' },
    });

    await executeStep(store, def, {
      runId: run.id,
      command: 'upsert2',
      input: {},
      dispatcher: noOpDispatcher,
      registry,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'upsert2',
      { table: 'CS_Macros', record_id: 'rec123' },
      expect.any(Object),
      undefined,
    );
  });

  it('input_map — $literal nested inside object node resolves correctly', async () => {
    const def: WorkflowDefinition = {
      id: 'imap-wf',
      name: 'InputMap Workflow',
      version: 1,
      services: { svc: { adapter: 'mock', trust: 'engine_delivered' } },
      steps: {
        nested: {
          description: 'Adapter step with literal inside nested object',
          execution: 'auto',
          depends_on: [],
          uses_service: 'svc',
          input_map: {
            config: {
              table: { $literal: 'CS_Macros' },
              id: 'run.params.id',
            },
          },
        },
      },
    };
    const adapter = new MockAdapter('mock', { nested: { status: 200, data: {} } });
    const fetchSpy = vi.spyOn(adapter, 'fetch');
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'mock', adapter);
    const store = new JsonFileStore(dir);
    const run = await store.create({
      workflowId: 'imap-wf',
      workflowVersion: 1,
      params: { id: 'rec456' },
    });

    await executeStep(store, def, {
      runId: run.id,
      command: 'nested',
      input: {},
      dispatcher: noOpDispatcher,
      registry,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'nested',
      { config: { table: 'CS_Macros', id: 'rec456' } },
      expect.any(Object),
      undefined,
    );
  });

  it('handler step with input_map receives resolved params (Phase 73)', async () => {
    let capturedParams: Record<string, unknown> | undefined;

    const def: WorkflowDefinition = {
      id: 'handler-imap-wf',
      name: 'Handler InputMap Workflow',
      version: 1,
      steps: {
        process: {
          description: 'Handler step with input_map',
          execution: 'auto',
          handler: 'test-handler',
          depends_on: [],
          input_map: {
            table: { $literal: 'CS_Macros' },
            ticket_id: 'run.params.ticket_id',
          },
        },
      },
    };

    const registry = new ExtensionRegistry();
    registry.register('handler', 'test-handler', {
      id: 'test-handler',
      async execute(inputs: { params: Record<string, unknown> }) {
        capturedParams = inputs.params;
        return { data: { done: true } };
      },
    });

    const store = new JsonFileStore(dir);
    const run = await store.create({
      workflowId: 'handler-imap-wf',
      workflowVersion: 1,
      params: { ticket_id: 'TKT-999' },
    });

    await executeStep(store, def, {
      runId: run.id,
      command: 'process',
      input: {},
      dispatcher: noOpDispatcher,
      registry,
    });

    expect(capturedParams).toEqual({ table: 'CS_Macros', ticket_id: 'TKT-999' });
  });

  it('handler step with input_map records resolved_params in evidence snapshot (Phase 73)', async () => {
    const def: WorkflowDefinition = {
      id: 'handler-imap-snap-wf',
      name: 'Handler InputMap Snapshot Workflow',
      version: 1,
      steps: {
        process: {
          description: 'Handler step with input_map',
          execution: 'auto',
          handler: 'snap-handler',
          depends_on: [],
          input_map: { table: { $literal: 'Orders' } },
        },
      },
    };

    const registry = new ExtensionRegistry();
    registry.register('handler', 'snap-handler', {
      id: 'snap-handler',
      async execute() {
        return { data: { done: true } };
      },
    });

    const store = new JsonFileStore(dir);
    const run = await store.create({
      workflowId: 'handler-imap-snap-wf',
      workflowVersion: 1,
      params: {},
    });

    await executeStep(store, def, {
      runId: run.id,
      command: 'process',
      input: {},
      dispatcher: noOpDispatcher,
      registry,
    });

    const updatedRun = await store.get(run.id);
    const snap = updatedRun.evidence.find((e) => e.step_id === 'process');
    expect(snap).toBeDefined();
    expect(snap?.resolved_params).toEqual({ table: 'Orders' });
  });

  it('handler step without input_map passes options.input unchanged (Phase 73)', async () => {
    let capturedParams: Record<string, unknown> | undefined;

    const def: WorkflowDefinition = {
      id: 'handler-no-imap-wf',
      name: 'Handler No InputMap Workflow',
      version: 1,
      steps: {
        process: {
          description: 'Handler step without input_map',
          execution: 'auto',
          handler: 'passthrough-handler',
          depends_on: [],
        },
      },
    };

    const registry = new ExtensionRegistry();
    registry.register('handler', 'passthrough-handler', {
      id: 'passthrough-handler',
      async execute(inputs: { params: Record<string, unknown> }) {
        capturedParams = inputs.params;
        return { data: { done: true } };
      },
    });

    const store = new JsonFileStore(dir);
    const run = await store.create({
      workflowId: 'handler-no-imap-wf',
      workflowVersion: 1,
      params: {},
    });

    await executeStep(store, def, {
      runId: run.id,
      command: 'process',
      input: { custom: 'value' },
      dispatcher: noOpDispatcher,
      registry,
    });

    expect(capturedParams).toEqual({ custom: 'value' });
  });
});
