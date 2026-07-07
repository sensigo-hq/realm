// Tests for the 0.10.0 run-recovery surface: abandon_run MCP tool + get_run_state's
// next_actions / next_actions_status.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, JsonWorkflowStore, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition, PendingGate } from '@sensigo/realm';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client';
import { handleAbandonRun, registerAbandonRun } from './abandon-run.js';
import { handleGetRunState } from './get-run-state.js';

const agentFirst: WorkflowDefinition = {
  id: 'agentflow',
  name: 'Agent First',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { review: { description: 'Agent step', execution: 'agent', depends_on: [] } },
};

const autoFirst: WorkflowDefinition = {
  id: 'autoflow',
  name: 'Auto First',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { compute: { description: 'Auto step', execution: 'auto', depends_on: [] } },
};

async function callRegisteredAbandon(
  runStore: JsonFileStore,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const server = new McpServer({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  registerAbandonRun(server, { runStore });
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0' });
  await client.connect(clientTransport);
  const result = await client.callTool({ name: 'abandon_run', arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  await client.close();
  return JSON.parse(text) as Record<string, unknown>;
}

describe('abandon_run MCP tool', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    runStore = new JsonFileStore(await mkdtemp(join(tmpdir(), 'rec-run-')));
    workflowStore = new JsonWorkflowStore(await mkdtemp(join(tmpdir(), 'rec-wf-')));
    await workflowStore.register(agentFirst);
  });

  it('success: abandons a running run, returns a terminal summary', async () => {
    const { run } = await runStore.create({
      workflowId: 'agentflow',
      workflowVersion: 1,
      params: {},
    });
    const summary = await handleAbandonRun({ run_id: run.id, reason: 'stale' }, { runStore });
    expect(summary.run_phase).toBe('abandoned');
    expect(summary.terminal_state).toBe(true);
    expect(summary.terminal_reason).toBe('stale');
  });

  it('error envelope: missing run → STATE_RUN_NOT_FOUND', async () => {
    const env = await callRegisteredAbandon(runStore, { run_id: 'no-such-run' });
    expect(env['status']).toBe('error');
    expect(env['error_code']).toBe('STATE_RUN_NOT_FOUND');
    expect(env['command']).toBe('abandon_run');
  });

  it('error envelope: terminal run → STATE_RUN_TERMINAL', async () => {
    const { run } = await runStore.create({
      workflowId: 'agentflow',
      workflowVersion: 1,
      params: {},
    });
    await runStore.update({
      ...run,
      completed_steps: ['review'],
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
    });
    const env = await callRegisteredAbandon(runStore, { run_id: run.id });
    expect(env['status']).toBe('error');
    expect(env['error_code']).toBe('STATE_RUN_TERMINAL');
  });

  it('error envelope: gate_waiting run → STATE_TRANSITION_DENIED', async () => {
    const { run } = await runStore.create({
      workflowId: 'agentflow',
      workflowVersion: 1,
      params: {},
    });
    const gate: PendingGate = {
      gate_id: 'g1',
      step_name: 'review',
      choices: ['approve'],
      opened_at: new Date().toISOString(),
      preview: {},
    };
    await runStore.update({ ...run, pending_gate: gate });
    const env = await callRegisteredAbandon(runStore, { run_id: run.id });
    expect(env['status']).toBe('error');
    expect(env['error_code']).toBe('STATE_TRANSITION_DENIED');
  });
});

describe('get_run_state — next_actions_status', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    runStore = new JsonFileStore(await mkdtemp(join(tmpdir(), 'nas-run-')));
    workflowStore = new JsonWorkflowStore(await mkdtemp(join(tmpdir(), 'nas-wf-')));
    await workflowStore.register(agentFirst);
    await workflowStore.register(autoFirst);
  });

  it('ok: running with an eligible agent step → next_actions non-empty', async () => {
    const { run } = await runStore.create({
      workflowId: 'agentflow',
      workflowVersion: 1,
      params: {},
    });
    const state = await handleGetRunState({ run_id: run.id }, { runStore, workflowStore });
    expect(state.next_actions_status).toBe('ok');
    expect(state.next_actions.length).toBeGreaterThan(0);
  });

  it('auto_pending: running with only an auto step eligible → empty next_actions', async () => {
    const { run } = await runStore.create({
      workflowId: 'autoflow',
      workflowVersion: 1,
      params: {},
    });
    const state = await handleGetRunState({ run_id: run.id }, { runStore, workflowStore });
    expect(state.next_actions_status).toBe('auto_pending');
    expect(state.next_actions).toEqual([]);
  });

  it('awaiting_human: a gate is open', async () => {
    const { run } = await runStore.create({
      workflowId: 'agentflow',
      workflowVersion: 1,
      params: {},
    });
    const gate: PendingGate = {
      gate_id: 'g1',
      step_name: 'review',
      choices: ['approve'],
      opened_at: new Date().toISOString(),
      preview: {},
    };
    await runStore.update({ ...run, pending_gate: gate });
    const state = await handleGetRunState({ run_id: run.id }, { runStore, workflowStore });
    expect(state.next_actions_status).toBe('awaiting_human');
    expect(state.next_actions).toEqual([]);
  });

  it('skipped_terminal: terminal run', async () => {
    const { run } = await runStore.create({
      workflowId: 'agentflow',
      workflowVersion: 1,
      params: {},
    });
    await runStore.update({
      ...run,
      completed_steps: ['review'],
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
    });
    const state = await handleGetRunState({ run_id: run.id }, { runStore, workflowStore });
    expect(state.next_actions_status).toBe('skipped_terminal');
    expect(state.next_actions).toEqual([]);
  });

  it('workflow_unresolved: no workflow store provided', async () => {
    const { run } = await runStore.create({
      workflowId: 'agentflow',
      workflowVersion: 1,
      params: {},
    });
    const state = await handleGetRunState({ run_id: run.id }, { runStore }); // no workflowStore
    expect(state.next_actions_status).toBe('workflow_unresolved');
    expect(state.next_actions).toEqual([]);
  });
});

describe('get_run_state — claim liveness (issue #101 wedge detection)', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    runStore = new JsonFileStore(await mkdtemp(join(tmpdir(), 'claim-run-')));
    workflowStore = new JsonWorkflowStore(await mkdtemp(join(tmpdir(), 'claim-wf-')));
    await workflowStore.register(autoFirst);
  });

  async function wedgeRun(
    claims: Record<string, { deadline: string | null }> | undefined,
  ): Promise<string> {
    const { run } = await runStore.create({
      workflowId: 'autoflow',
      workflowVersion: 1,
      params: {},
    });
    await runStore.update({
      ...run,
      in_progress_steps: ['compute'],
      ...(claims !== undefined ? { claims } : {}),
    });
    return run.id;
  }

  it('claim_stale: an in-progress claim past its deadline (carved out of ok)', async () => {
    const id = await wedgeRun({ compute: { deadline: new Date(Date.now() - 1000).toISOString() } });
    const state = await handleGetRunState({ run_id: id }, { runStore, workflowStore });
    expect(state.next_actions_status).toBe('claim_stale');
  });

  it('claim_unknown_age: an in-progress claim with a null deadline', async () => {
    const id = await wedgeRun({ compute: { deadline: null } });
    const state = await handleGetRunState({ run_id: id }, { runStore, workflowStore });
    expect(state.next_actions_status).toBe('claim_unknown_age');
  });

  it("stays 'ok' when a healthy claim is in flight (a live runner is presumed on it)", async () => {
    const id = await wedgeRun({
      compute: { deadline: new Date(Date.now() + 3_600_000).toISOString() },
    });
    const state = await handleGetRunState({ run_id: id }, { runStore, workflowStore });
    expect(state.next_actions_status).toBe('ok');
  });

  it('reports the wedge even when the workflow is unresolved (definition-free detection)', async () => {
    const id = await wedgeRun({ compute: { deadline: new Date(Date.now() - 1000).toISOString() } });
    const state = await handleGetRunState({ run_id: id }, { runStore }); // no workflowStore
    expect(state.next_actions_status).toBe('claim_stale');
  });

  it('a legacy run with no claims entry → claim_unknown_age', async () => {
    const id = await wedgeRun(undefined); // in_progress set, but no claims field at all
    const state = await handleGetRunState({ run_id: id }, { runStore, workflowStore });
    expect(state.next_actions_status).toBe('claim_unknown_age');
  });
});
