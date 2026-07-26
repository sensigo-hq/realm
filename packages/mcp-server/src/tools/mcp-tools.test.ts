// Integration tests for MCP tool business logic — tests handle* functions directly.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, JsonWorkflowStore, WorkflowError, ExtensionRegistry } from '@sensigo/realm';
import type { WorkflowDefinition, ServiceAdapter } from '@sensigo/realm';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import { handleListWorkflows } from './list-workflows.js';
import { handleGetWorkflowProtocol } from './get-workflow-protocol.js';
import { handleStartRun, registerStartRun } from './start-run.js';
import { handleExecuteStep, handleExecuteStepTool } from './execute-step.js';
import { handleSubmitHumanResponse, registerSubmitHumanResponse } from './submit-human-response.js';
import { handleGetRunState } from './get-run-state.js';
import { createDefaultRegistry } from '../server.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client';

/** Minimal 2-step workflow: auto → completed */
function makeSimpleDef(): WorkflowDefinition {
  return {
    id: 'simple-wf',
    name: 'Simple Workflow',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      'step-a': {
        description: 'Auto step',
        execution: 'auto',
        depends_on: [],
      },
    },
  };
}

/** 3-step workflow: auto → agent → completed */
function makeAgentDef(): WorkflowDefinition {
  return {
    id: 'agent-wf',
    name: 'Agent Workflow',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      'step-auto': {
        description: 'Auto step',
        execution: 'auto',
        depends_on: [],
      },
      'step-agent': {
        description: 'Agent step',
        execution: 'agent',
        depends_on: ['step-auto'],
      },
    },
  };
}

/** Workflow with a human gate: auto → gate → completed */
function makeGateDef(): WorkflowDefinition {
  return {
    id: 'gate-wf',
    name: 'Gate Workflow',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      'step-gate': {
        description: 'Gate step',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: { choices: ['approve', 'reject'] },
      },
    },
  };
}

describe('mcp tool handlers', () => {
  let runDir: string;
  let workflowDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-mcp-runs-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-mcp-wf-'));
  });

  it('handleListWorkflows returns registered workflows', async () => {
    const workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(makeSimpleDef());

    const result = await handleListWorkflows({ workflowStore });

    expect(result.workflows.length).toBe(1);
    expect(result.workflows[0]!.id).toBe('simple-wf');
    expect(result.hint).toContain('get_workflow_protocol');
  });

  it('handleGetWorkflowProtocol returns protocol for known workflow', async () => {
    const workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(makeSimpleDef());

    const result = await handleGetWorkflowProtocol({ workflow_id: 'simple-wf' }, { workflowStore });

    expect(result.workflow_id).toBe('simple-wf');
    expect(result.steps.length).toBe(1);
  });

  // issue #279 (increment 1, PR-B): the appended concurrent-settlement protocol rule.
  it('handleGetWorkflowProtocol appends the concurrent-settlement rule (STATE_STEP_ALREADY_SETTLED guidance)', async () => {
    const workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(makeSimpleDef());

    const result = await handleGetWorkflowProtocol({ workflow_id: 'simple-wf' }, { workflowStore });

    expect(
      result.rules.some(
        (r) => r.includes('STATE_STEP_ALREADY_SETTLED') && r.includes('get_run_state'),
      ),
    ).toBe(true);
  });

  it('handleStartRun creates a run and chains auto steps', async () => {
    const workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(makeSimpleDef());
    const runStore = new JsonFileStore(runDir);

    const result = await handleStartRun(
      { workflow_id: 'simple-wf', params: {} },
      { runStore, workflowStore },
    );

    expect(result.status).toBe('ok');
    expect(typeof result.run_id).toBe('string');
    expect(result.data).toEqual({});
    expect(result.context_hint).toBeDefined();
    expect(result.context_hint).not.toBe('');
    expect(result.chained_auto_steps).toEqual([{ step: 'step-a', run_phase: 'completed' }]);

    const run = await runStore.get(result.run_id);
    expect(run.run_phase).toBe('completed');
  });

  it('handleExecuteStep advances an agent step', async () => {
    const workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(makeAgentDef());
    const runStore = new JsonFileStore(runDir);

    // Start run: chains through the auto step, stops at agent step.
    const startResult = await handleStartRun(
      { workflow_id: 'agent-wf', params: {} },
      { runStore, workflowStore },
    );
    expect(startResult.status).toBe('ok');
    // The auto step ran silently during start_run — it must be reported.
    expect(startResult.chained_auto_steps).toEqual([{ step: 'step-auto', run_phase: 'running' }]);

    // Run is now waiting for the agent step.
    const midRun = await runStore.get(startResult.run_id);
    expect(midRun.run_phase).toBe('running');

    // Agent executes the step.
    const result = await handleExecuteStep(
      { run_id: startResult.run_id, command: 'step-agent', params: { result: 'done' } },
      { runStore, workflowStore },
    );

    expect(result.status).toBe('ok');
    const finalRun = await runStore.get(startResult.run_id);
    expect(finalRun.run_phase).toBe('completed');
  });

  it('handleExecuteStep accepts a top-level trace and persists it in evidence', async () => {
    const workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(makeAgentDef());
    const runStore = new JsonFileStore(runDir);

    const startResult = await handleStartRun(
      { workflow_id: 'agent-wf', params: {} },
      { runStore, workflowStore },
    );

    const result = await handleExecuteStep(
      {
        run_id: startResult.run_id,
        command: 'step-agent',
        params: { result: 'done' },
        trace: [
          { event: 'search_called', data: { query: 'hello' } },
          { event: 'search_returned', data: { count: 3 } },
        ],
      },
      { runStore, workflowStore },
    );

    expect(result.status).toBe('ok');
    const snap = result.evidence.find((e) => e.step_id === 'step-agent');
    expect(snap?.trace).toBeDefined();
    expect(snap?.trace).toHaveLength(2);
    expect(snap?.trace![0]!.event).toBe('search_called');
    expect(snap?.trace_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('trace is not merged into params — trace content does not appear in output_summary', async () => {
    const workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(makeAgentDef());
    const runStore = new JsonFileStore(runDir);

    const startResult = await handleStartRun(
      { workflow_id: 'agent-wf', params: {} },
      { runStore, workflowStore },
    );

    const result = await handleExecuteStep(
      {
        run_id: startResult.run_id,
        command: 'step-agent',
        params: { result: 'done' },
        trace: [{ event: 'should_not_be_in_params', data: { secret: 'leaked?' } }],
      },
      { runStore, workflowStore },
    );

    expect(result.status).toBe('ok');
    const snap = result.evidence.find((e) => e.step_id === 'step-agent');
    // output_summary comes from params only — trace fields must not appear in it
    expect(snap?.output_summary).not.toHaveProperty('trace');
    expect(snap?.output_summary).not.toHaveProperty('event');
    expect(snap?.output_summary).toEqual({ result: 'done' });
  });

  it('handleSubmitHumanResponse advances a gate-waiting run', async () => {
    const workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(makeGateDef());
    const runStore = new JsonFileStore(runDir);

    // Start run — chains into the gate step, which opens the gate.
    const startResult = await handleStartRun(
      { workflow_id: 'gate-wf', params: {} },
      { runStore, workflowStore },
    );
    expect(startResult.status).toBe('confirm_required');
    expect(startResult.gate).toBeDefined();

    const gateId = startResult.gate!.gate_id;
    const gateRun = await runStore.get(startResult.run_id);

    const result = await handleSubmitHumanResponse(
      { run_id: startResult.run_id, gate_id: gateId, choice: 'approve' },
      { runStore, workflowStore },
    );

    expect(result.status).toBe('ok');
    const finalRun = await runStore.get(startResult.run_id);
    expect(finalRun.run_phase).toBe('completed');
    // Suppress unused-variable warning for gateRun
    void gateRun;
  });

  it('handleExecuteStepTool strips data from the MCP response', async () => {
    const workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(makeAgentDef());
    const runStore = new JsonFileStore(runDir);

    // Start run: chains through the auto step, stops at agent step.
    const startResult = await handleStartRun(
      { workflow_id: 'agent-wf', params: {} },
      { runStore, workflowStore },
    );
    expect(startResult.status).toBe('ok');

    // Call the MCP-layer handler (not the raw handleExecuteStep).
    const result = await handleExecuteStepTool(
      { run_id: startResult.run_id, command: 'step-agent', params: { result: 'done' } },
      { runStore, workflowStore },
    );

    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed['data']).toEqual({});
    expect(parsed['status']).toBe('ok');
  });

  it('handleExecuteStepTool returns structured JSON on unexpected catch', async () => {
    // Pass a runStore that throws a plain Error (not WorkflowError) so it bypasses
    // executeStep's internal error handling and propagates to handleExecuteStepTool's catch.
    const throwingOpts = {
      runStore: {
        get: async () => {
          throw new Error('unexpected failure');
        },
        create: async () => {
          throw new Error('unexpected failure');
        },
        update: async () => {
          throw new Error('unexpected failure');
        },
        list: async () => [],
      } as unknown as JsonFileStore,
    };

    const result = await handleExecuteStepTool(
      { run_id: 'test-run', command: 'review_security' },
      throwingOpts,
    );

    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed['status']).toBe('error');
    expect(parsed['agent_action']).toBe('stop');
    expect(Array.isArray(parsed['next_actions'])).toBe(true);
    expect((parsed['next_actions'] as unknown[]).length).toBe(0);
    expect((parsed['errors'] as string[])[0]).toContain('unexpected failure');
    expect(parsed['run_id']).toBe('test-run');
    expect(parsed['command']).toBe('review_security');
    expect(parsed['error_code']).toBe('ENGINE_INTERNAL');
  });

  it('handleExecuteStepTool propagates WorkflowError.agentAction to MCP response', async () => {
    const { WorkflowError } = await import('@sensigo/realm');

    const throwingOpts = {
      runStore: {
        get: async () => {
          throw new WorkflowError('Run not found: unknown-run', {
            code: 'STATE_RUN_NOT_FOUND',
            category: 'STATE',
            agentAction: 'report_to_user',
            retryable: false,
          });
        },
        create: async () => {
          throw new Error('should not be called');
        },
        update: async () => {
          throw new Error('should not be called');
        },
        list: async () => [],
      } as unknown as JsonFileStore,
    };

    const result = await handleExecuteStepTool(
      { run_id: 'unknown-run', command: 'some_step' },
      throwingOpts,
    );

    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed['status']).toBe('error');
    expect(parsed['agent_action']).toBe('report_to_user');
    expect((parsed['errors'] as string[])[0]).toContain('Run not found');
    expect(parsed['error_code']).toBe('STATE_RUN_NOT_FOUND');
  });

  it('handleGetRunState returns run summary', async () => {
    const workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(makeSimpleDef());
    const runStore = new JsonFileStore(runDir);

    const startResult = await handleStartRun(
      { workflow_id: 'simple-wf' },
      { runStore, workflowStore },
    );

    const state = await handleGetRunState({ run_id: startResult.run_id }, { runStore });

    expect(state.run_id).toBe(startResult.run_id);
    expect(state.run_phase).toBe('completed');
    expect(state.terminal_state).toBe(true);
    expect(typeof state.evidence_count).toBe('number');
  });

  it('gate on_reject: submit_human_response with reject makes next step eligible', async () => {
    const gateTransitionDef: WorkflowDefinition = {
      id: 'gate-trans-wf',
      name: 'Gate Transition Workflow',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        review: {
          description: 'Human gate',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          gate: { choices: ['approve', 'reject'] },
        },
        revise: {
          description: 'Agent revision step — eligible after review completes',
          execution: 'agent',
          depends_on: ['review'],
        },
      },
    };
    const workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(gateTransitionDef);
    const runStore = new JsonFileStore(runDir);

    // Start run — chains into gate step
    const startResult = await handleStartRun(
      { workflow_id: 'gate-trans-wf', params: {} },
      { runStore, workflowStore },
    );
    expect(startResult.status).toBe('confirm_required');
    const gateId = startResult.gate!.gate_id;

    // Submit reject
    const rejectResult = await handleSubmitHumanResponse(
      { run_id: startResult.run_id, gate_id: gateId, choice: 'reject' },
      { runStore, workflowStore },
    );

    expect(rejectResult.status).toBe('ok');
    // After rejection, revise step is eligible (depends_on: [review], review now completed).
    expect(rejectResult.next_actions.length).toBeGreaterThan(0);
    const reviseAction = rejectResult.next_actions.find(
      (a) => (a.instruction?.call_with as Record<string, unknown>)?.['command'] === 'revise',
    );
    expect(reviseAction).toBeDefined();

    const finalRun = await runStore.get(startResult.run_id);
    // Run is still in progress — revise step has not yet executed.
    expect(finalRun.run_phase).toBe('running');
    expect(finalRun.completed_steps).toContain('review');
  });

  it('handleStartRun resolves a filesystem auto step using the default built-in registry', async () => {
    // Write a temp file to read.
    const tempFilePath = join(runDir, 'test-input.txt');
    await writeFile(tempFilePath, 'hello from filesystem adapter');

    const filesystemDef: WorkflowDefinition = {
      id: 'filesystem-auto-wf',
      name: 'Filesystem Auto Workflow',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      services: {
        source: { adapter: 'filesystem', trust: 'engine_delivered' },
      },
      steps: {
        read_file: {
          description: 'Read a file from disk.',
          execution: 'auto',
          uses_service: 'source',
          operation: 'read',
          depends_on: [],
        },
      },
    };

    const workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(filesystemDef);
    const runStore = new JsonFileStore(runDir);

    // createDefaultRegistry() is what createRealmMcpServer() uses when no registry is provided.
    // Passing it here verifies that the default registry has FileSystemAdapter available.
    const result = await handleStartRun(
      { workflow_id: 'filesystem-auto-wf', params: { path: tempFilePath } },
      { runStore, workflowStore, registry: createDefaultRegistry() },
    );

    expect(result.status).toBe('ok');
    expect(result.chained_auto_steps).toHaveLength(1);
    expect(result.chained_auto_steps![0]!.step).toBe('read_file');
    expect(result.chained_auto_steps![0]!.run_phase).toBe('completed');

    const run = await runStore.get(result.run_id);
    expect(run.run_phase).toBe('completed');
  });

  // ---
  // Step 5 dispatch-failure integration tests — verify agent_action in the serialised
  // MCP JSON response when a service adapter throws during auto-step execution.
  // ---

  /** Single-step service workflow — run becomes terminal on failure (no recovery step). */
  function makeSingleServiceDef(): WorkflowDefinition {
    return {
      id: 'single-service-wf',
      name: 'Single Service Workflow',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      services: { svc: { adapter: 'mock_throwing' } },
      steps: {
        call_api: {
          description: 'Service call',
          execution: 'auto',
          depends_on: [],
          uses_service: 'svc',
        },
      },
    };
  }

  /**
   * Two-step service workflow: auto service step + agent recovery step.
   * When `call_api` fails, `recover` becomes eligible via `trigger_rule: 'one_failed'`.
   * The run is therefore non-terminal after the failure.
   */
  function makeTwoStepServiceDef(): WorkflowDefinition {
    return {
      id: 'two-step-service-wf',
      name: 'Two Step Service Workflow',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      services: { svc: { adapter: 'mock_throwing' } },
      steps: {
        call_api: {
          description: 'Service call',
          execution: 'auto',
          depends_on: [],
          uses_service: 'svc',
        },
        recover: {
          description: 'Recovery step — runs when call_api fails',
          execution: 'agent',
          depends_on: ['call_api'],
          trigger_rule: 'one_failed',
        },
      },
    };
  }

  /** Returns a ServiceAdapter whose fetch/create/update all throw the given WorkflowError. */
  function makeThrowingAdapter(err: WorkflowError): ServiceAdapter {
    return {
      id: 'mock_throwing',
      fetch: async () => {
        throw err;
      },
      create: async () => {
        throw err;
      },
      update: async () => {
        throw err;
      },
    };
  }

  it('Step 5 dispatch failure: terminal run → agent_action: stop in MCP response', async () => {
    const adapterErr = new WorkflowError('Mock adapter failure', {
      code: 'SERVICE_UNAVAILABLE',
      category: 'SERVICE',
      agentAction: 'report_to_user',
      retryable: false,
    });
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'mock_throwing', makeThrowingAdapter(adapterErr));

    const workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(makeSingleServiceDef());
    const runStore = new JsonFileStore(runDir);
    const { run: run } = await runStore.create({
      workflowId: 'single-service-wf',
      workflowVersion: 1,
      params: {},
    });

    const result = await handleExecuteStepTool(
      { run_id: run.id, command: 'call_api' },
      { runStore, workflowStore, registry },
    );

    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed['status']).toBe('error');
    // Terminal run: resolvePostDispatchAgentAction always returns 'stop'.
    expect(parsed['agent_action']).toBe('stop');
    expect(Array.isArray(parsed['next_actions'])).toBe(true);
    expect((parsed['next_actions'] as unknown[]).length).toBe(0);
  });

  it('Step 5 dispatch failure: non-terminal run, report_to_user error → agent_action: report_to_user with next_actions', async () => {
    const adapterErr = new WorkflowError('Mock adapter failure', {
      code: 'SERVICE_UNAVAILABLE',
      category: 'SERVICE',
      agentAction: 'report_to_user',
      retryable: false,
    });
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'mock_throwing', makeThrowingAdapter(adapterErr));

    const workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(makeTwoStepServiceDef());
    const runStore = new JsonFileStore(runDir);
    const { run: run } = await runStore.create({
      workflowId: 'two-step-service-wf',
      workflowVersion: 1,
      params: {},
    });

    const result = await handleExecuteStepTool(
      { run_id: run.id, command: 'call_api' },
      { runStore, workflowStore, registry },
    );

    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed['status']).toBe('error');
    // Non-terminal run, report_to_user passes through.
    expect(parsed['agent_action']).toBe('report_to_user');
    // Recovery step is eligible — next_actions must be non-empty.
    expect(Array.isArray(parsed['next_actions'])).toBe(true);
    expect((parsed['next_actions'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('Step 5 dispatch failure: non-terminal run, wait_for_human error → agent_action: wait_for_human', async () => {
    const adapterErr = new WorkflowError('Mock adapter temporarily unavailable', {
      code: 'SERVICE_UNAVAILABLE',
      category: 'SERVICE',
      agentAction: 'wait_for_human',
      retryable: true,
    });
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'mock_throwing', makeThrowingAdapter(adapterErr));

    const workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(makeTwoStepServiceDef());
    const runStore = new JsonFileStore(runDir);
    const { run: run } = await runStore.create({
      workflowId: 'two-step-service-wf',
      workflowVersion: 1,
      params: {},
    });

    const result = await handleExecuteStepTool(
      { run_id: run.id, command: 'call_api' },
      { runStore, workflowStore, registry },
    );

    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed['status']).toBe('error');
    // Non-terminal run, wait_for_human passes through.
    expect(parsed['agent_action']).toBe('wait_for_human');
  });

  it('Step 5 dispatch failure: wait_and_proceed with retry_after → MCP response contains retry_after', async () => {
    const adapterErr = new WorkflowError('Rate limited', {
      code: 'SERVICE_RATE_LIMITED',
      category: 'SERVICE',
      agentAction: 'wait_and_proceed',
      retryable: true,
      retry_after: 30,
    });
    const registry = new ExtensionRegistry();
    registry.register('adapter', 'mock_throwing', makeThrowingAdapter(adapterErr));

    const workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(makeTwoStepServiceDef());
    const runStore = new JsonFileStore(runDir);
    const { run: run } = await runStore.create({
      workflowId: 'two-step-service-wf',
      workflowVersion: 1,
      params: {},
    });

    const result = await handleExecuteStepTool(
      { run_id: run.id, command: 'call_api' },
      { runStore, workflowStore, registry },
    );

    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed['status']).toBe('error');
    expect(parsed['agent_action']).toBe('wait_and_proceed');
    expect(parsed['retry_after']).toBe(30);
  });
});

describe('registerStartRun — ResponseEnvelope error shape', () => {
  it('emits error_code when workflow is not found', async () => {
    const server = new McpServer({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    registerStartRun(server, {});
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0' });
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: 'start_run',
      arguments: { workflow_id: 'nonexistent' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const envelope = JSON.parse(text) as Record<string, unknown>;
    expect(envelope['status']).toBe('error');
    expect(envelope['error_code']).toBe('STATE_WORKFLOW_NOT_FOUND');
    expect(envelope['command']).toBe('start_run');
    expect(envelope['run_id']).toBe('');
    expect(envelope['run_version']).toBe(0);
    expect(Array.isArray(envelope['next_actions'])).toBe(true);
    await client.close();
  });
});

describe('registerSubmitHumanResponse — ResponseEnvelope error shape', () => {
  it('emits error_code when run is not found', async () => {
    const server = new McpServer({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    registerSubmitHumanResponse(server, {});
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0' });
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: 'submit_human_response',
      arguments: { run_id: 'no-such-run', gate_id: 'g1', choice: 'approve' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const envelope = JSON.parse(text) as Record<string, unknown>;
    expect(envelope['status']).toBe('error');
    expect(envelope['error_code']).toBe('STATE_RUN_NOT_FOUND');
    expect(envelope['command']).toBe('submit_human_response');
    expect(envelope['run_id']).toBe('no-such-run');
    expect(envelope['run_version']).toBe(0);
    expect(Array.isArray(envelope['next_actions'])).toBe(true);
    await client.close();
  });
});

describe('handleGetRunState — abort_context', () => {
  let runDir: string;
  let workflowDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-abort-runs-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-abort-wf-'));
  });

  it('abort_context is included when run is aborted by a guard step', async () => {
    const guardWfDef: WorkflowDefinition = {
      id: 'guard-abort-wf',
      name: 'Guard Abort Workflow',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        step_a: { description: 'Agent step', execution: 'agent', depends_on: [] },
        guard_b: {
          description: 'Guard step',
          execution: 'guard',
          depends_on: ['step_a'],
          abort_unless: ["step_a.status == 'open'"],
          abort_message: 'Not open',
        },
      },
    };

    const workflowStore = new JsonWorkflowStore(workflowDir);
    await workflowStore.register(guardWfDef);
    const runStore = new JsonFileStore(runDir);

    const startResult = await handleStartRun(
      { workflow_id: 'guard-abort-wf', params: {} },
      { runStore, workflowStore },
    );
    expect(startResult.status).toBe('ok');

    // Execute step_a with closed status — guard should fire and abort the run.
    const execResult = await handleExecuteStep(
      { run_id: startResult.run_id, command: 'step_a', params: { status: 'closed' } },
      { runStore, workflowStore },
    );
    expect(execResult.status).toBe('ok');
    expect(execResult.next_actions).toHaveLength(0);

    const state = await handleGetRunState({ run_id: startResult.run_id }, { runStore });

    expect(state.run_phase).toBe('aborted');
    expect(state.terminal_state).toBe(true);
    expect(state.abort_context).toBeDefined();
    expect(state.abort_context?.step_id).toBe('guard_b');
    expect(state.abort_context?.abort_message).toBe('Not open');
    expect(Array.isArray(state.abort_context?.conditions)).toBe(true);
  });

  it('abort_context is absent on a non-aborted terminal run', async () => {
    const workflowStore = new JsonWorkflowStore(workflowDir);
    const simpleWf: WorkflowDefinition = {
      id: 'simple-complete-wf',
      name: 'Simple Complete Workflow',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        'step-a': { description: 'Auto step', execution: 'auto', depends_on: [] },
      },
    };
    await workflowStore.register(simpleWf);
    const runStore = new JsonFileStore(runDir);

    const startResult = await handleStartRun(
      { workflow_id: 'simple-complete-wf', params: {} },
      { runStore, workflowStore },
    );

    const state = await handleGetRunState({ run_id: startResult.run_id }, { runStore });
    expect(state.run_phase).toBe('completed');
    expect(state.abort_context).toBeUndefined();
  });
});
