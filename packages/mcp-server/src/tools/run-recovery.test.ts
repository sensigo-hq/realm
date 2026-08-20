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
    // issue #367: a FRESH abandon must not carry the no-change clause — otherwise the clause below
    // would be meaningless.
    expect(summary.note).not.toContain('no change this call');
  });

  it('issue #367: re-abandoning an already-abandoned run says so — it is a no-op, and looked identical before', async () => {
    const { run } = await runStore.create({
      workflowId: 'agentflow',
      workflowVersion: 1,
      params: {},
    });
    await handleAbandonRun({ run_id: run.id, reason: 'first' }, { runStore });
    const second = await handleAbandonRun({ run_id: run.id, reason: 'second' }, { runStore });
    expect(second.note).toContain('already abandoned (no change this call)');
    // And it really was a no-op: the reason from the FIRST call still stands.
    expect(second.terminal_reason).toBe('first');
    // The kill advisory still rides along — it is unconditional on every success response.
    expect(second.note).toContain('abandon is a kill');
  });

  // issue #302 (D-B, M2): the abandon kill-advisory — unconditional on every success response.
  it('success: the summary carries the unconditional kill-advisory note, and finalizers still do NOT run', async () => {
    const withFinalizer: WorkflowDefinition = {
      id: 'agentflow-with-finalizer',
      name: 'Agent First (with a finalizer)',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        review: { description: 'Agent step', execution: 'agent', depends_on: [] },
        cleanup: {
          description: 'cleanup',
          execution: 'finalizer',
          on_outcome: 'always',
          handler: 'h_always',
        },
      },
    };
    await workflowStore.register(withFinalizer);
    const { run } = await runStore.create({
      workflowId: 'agentflow-with-finalizer',
      workflowVersion: 1,
      params: {},
    });
    const summary = await handleAbandonRun({ run_id: run.id }, { runStore });
    expect(summary.note).toBe(
      "abandon is a kill — declared finalizers (if any) did NOT run; 'abort' is the graceful path.",
    );
    // core abandonRun has no handler-dispatch code path at all — structurally impossible for
    // 'cleanup' to have run; this re-confirms it at the record level, alongside the new note.
    const finalRun = await runStore.get(run.id);
    expect(finalRun.completed_steps).not.toContain('cleanup');
    expect(finalRun.failed_steps).not.toContain('cleanup');
    expect(finalRun.evidence.some((e) => e.step_id === 'cleanup')).toBe(false);
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
      sealed_by: { arm: 'complete' as const },
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
      sealed_by: { arm: 'complete' as const },
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

  it('surfaces a stale claim in stuck_claims on the running path (alongside the elevated status)', async () => {
    const id = await wedgeRun({ compute: { deadline: new Date(Date.now() - 1000).toISOString() } });
    const state = await handleGetRunState({ run_id: id }, { runStore, workflowStore });
    expect(state.next_actions_status).toBe('claim_stale');
    expect(state.stuck_claims).toEqual([{ step: 'compute', state: 'claim_stale' }]);
  });
});

describe('get_run_state — gate_waiting + fan-out wedge (issue #101 gate/fan-out correction)', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    runStore = new JsonFileStore(await mkdtemp(join(tmpdir(), 'gatewedge-run-')));
    workflowStore = new JsonWorkflowStore(await mkdtemp(join(tmpdir(), 'gatewedge-wf-')));
    await workflowStore.register(agentFirst);
  });

  async function gateRun(
    claims: Record<string, { deadline: string | null }>,
    inProgress: string[],
  ): Promise<string> {
    const { run } = await runStore.create({
      workflowId: 'agentflow',
      workflowVersion: 1,
      params: {},
    });
    await runStore.update({
      ...run,
      in_progress_steps: inProgress,
      claims,
      pending_gate: {
        gate_id: 'g1',
        step_name: 'review',
        choices: ['approve'],
        opened_at: new Date().toISOString(),
        preview: {},
      },
    });
    return run.id;
  }

  it('a wedged NON-gated sibling is surfaced in stuck_claims while next_actions_status stays awaiting_human', async () => {
    const id = await gateRun(
      {
        review: { deadline: new Date(Date.now() - 1000).toISOString() }, // the gated step, even if stale
        branch_b: { deadline: new Date(Date.now() - 1000).toISOString() },
      },
      ['review', 'branch_b'],
    );
    const state = await handleGetRunState({ run_id: id }, { runStore, workflowStore });
    // The gate status and pending_gate are UNCHANGED — drivers still key on them.
    expect(state.next_actions_status).toBe('awaiting_human');
    expect(state.pending_gate?.step_name).toBe('review');
    // The crashed sibling is surfaced; the gated step is NEVER included.
    expect(state.stuck_claims).toEqual([{ step: 'branch_b', state: 'claim_stale' }]);
  });

  it('an UNKNOWN-AGE non-gated sibling is surfaced too', async () => {
    const id = await gateRun({ review: { deadline: null }, branch_b: { deadline: null } }, [
      'review',
      'branch_b',
    ]);
    const state = await handleGetRunState({ run_id: id }, { runStore, workflowStore });
    expect(state.next_actions_status).toBe('awaiting_human');
    expect(state.stuck_claims).toEqual([{ step: 'branch_b', state: 'claim_unknown_age' }]);
  });

  it('a plain gate_waiting run (only the gated claim) is unchanged — no stuck_claims', async () => {
    const id = await gateRun({ review: { deadline: new Date(Date.now() - 1000).toISOString() } }, [
      'review',
    ]);
    const state = await handleGetRunState({ run_id: id }, { runStore, workflowStore });
    expect(state.next_actions_status).toBe('awaiting_human');
    expect(state.pending_gate?.step_name).toBe('review');
    expect(state.stuck_claims).toBeUndefined();
  });
});

describe('get_run_state — skip_details surfacing (issue #111)', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    runStore = new JsonFileStore(await mkdtemp(join(tmpdir(), 'skip-details-run-')));
    workflowStore = new JsonWorkflowStore(await mkdtemp(join(tmpdir(), 'skip-details-wf-')));
    await workflowStore.register(agentFirst);
  });

  it('present when non-empty — a run with a recorded skip reason surfaces skip_details', async () => {
    const { run } = await runStore.create({
      workflowId: 'agentflow',
      workflowVersion: 1,
      params: {},
    });
    await runStore.update({
      ...run,
      skipped_steps: ['review'],
      skip_details: { review: { kind: 'handler_abort' } },
    });
    const state = await handleGetRunState({ run_id: run.id }, { runStore, workflowStore });
    expect(state.skip_details).toEqual({ review: { kind: 'handler_abort' } });
  });

  it('omitted when empty — a run with no skips has no skip_details key at all', async () => {
    const { run } = await runStore.create({
      workflowId: 'agentflow',
      workflowVersion: 1,
      params: {},
    });
    const state = await handleGetRunState({ run_id: run.id }, { runStore, workflowStore });
    expect(state.skip_details).toBeUndefined();
  });

  it('omitted when skipped_steps is non-empty but skip_details is absent (legacy run)', async () => {
    const { run } = await runStore.create({
      workflowId: 'agentflow',
      workflowVersion: 1,
      params: {},
    });
    // A legacy record: skipped_steps populated, but skip_details never written.
    await runStore.update({ ...run, skipped_steps: ['review'] });
    const state = await handleGetRunState({ run_id: run.id }, { runStore, workflowStore });
    expect(state.skip_details).toBeUndefined();
  });
});
