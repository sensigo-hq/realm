// Tests for the append_trace MCP tool business logic.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  InMemoryTraceBufferStore,
  BUFFER_LIMIT_COUNT,
} from '@sensigo/realm';
import type { WorkflowDefinition, RunRecord } from '@sensigo/realm';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import { handleAppendTrace, registerAppendTrace } from './append-trace.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client';

function makeWorkflowDef(): WorkflowDefinition {
  return {
    id: 'append-trace-wf',
    name: 'Append Trace Test Workflow',
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

describe('handleAppendTrace', () => {
  let runDir: string;
  let workflowDir: string;
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  let traceBufferStore: InMemoryTraceBufferStore;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-append-trace-runs-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-append-trace-wf-'));
    runStore = new JsonFileStore(runDir);
    workflowStore = new JsonWorkflowStore(workflowDir);
    traceBufferStore = new InMemoryTraceBufferStore();

    const def = makeWorkflowDef();
    await writeFile(join(workflowDir, `${def.id}.json`), JSON.stringify(def, null, 2), 'utf8');
  });

  it('throws STATE_RUN_NOT_FOUND when run_id is unknown', async () => {
    await expect(
      handleAppendTrace(
        { run_id: 'nonexistent-run', step_id: 'step-agent', entries: [] },
        { runStore, workflowStore, traceBufferStore },
      ),
    ).rejects.toMatchObject({
      code: 'STATE_RUN_NOT_FOUND',
      agentAction: 'report_to_user',
    });
  });

  it('throws STEP_NOT_FOUND when step_id is not in the workflow', async () => {
    const { run: run } = await runStore.create({
      workflowId: 'append-trace-wf',
      workflowVersion: 1,
      params: {},
    });
    await expect(
      handleAppendTrace(
        { run_id: run.id, step_id: 'nonexistent-step', entries: [] },
        { runStore, workflowStore, traceBufferStore },
      ),
    ).rejects.toMatchObject({
      code: 'STEP_NOT_FOUND',
      agentAction: 'report_to_user',
    });
  });

  it('throws STATE_STEP_NOT_ELIGIBLE when the step is auto', async () => {
    const { run: run } = await runStore.create({
      workflowId: 'append-trace-wf',
      workflowVersion: 1,
      params: {},
    });
    await expect(
      handleAppendTrace(
        { run_id: run.id, step_id: 'step-auto', entries: [{ event: 'test' }] },
        { runStore, workflowStore, traceBufferStore },
      ),
    ).rejects.toMatchObject({
      code: 'STATE_STEP_NOT_ELIGIBLE',
      agentAction: 'report_to_user',
      details: { step_type: 'auto' },
    });
  });

  it('throws STATE_STEP_NOT_ELIGIBLE (step_state: completed) when step is in completed_steps', async () => {
    const { run: run } = await runStore.create({
      workflowId: 'append-trace-wf',
      workflowVersion: 1,
      params: {},
    });
    await runStore.update({
      ...run,
      completed_steps: ['step-auto', 'step-agent'],
      in_progress_steps: [],
    });
    await expect(
      handleAppendTrace(
        { run_id: run.id, step_id: 'step-agent', entries: [{ event: 'test' }] },
        { runStore, workflowStore, traceBufferStore },
      ),
    ).rejects.toMatchObject({
      code: 'STATE_STEP_NOT_ELIGIBLE',
      agentAction: 'report_to_user',
      // issue #207 PR-2: the granular taxonomy replaces the old lumped 'already_claimed' value.
      details: { step_state: 'completed' },
    });
  });

  it('throws STATE_STEP_NOT_ELIGIBLE (step_state: failed) when step is in failed_steps', async () => {
    const { run: run } = await runStore.create({
      workflowId: 'append-trace-wf',
      workflowVersion: 1,
      params: {},
    });
    await runStore.update({
      ...run,
      failed_steps: ['step-agent'],
      in_progress_steps: [],
    });
    await expect(
      handleAppendTrace(
        { run_id: run.id, step_id: 'step-agent', entries: [{ event: 'test' }] },
        { runStore, workflowStore, traceBufferStore },
      ),
    ).rejects.toMatchObject({
      code: 'STATE_STEP_NOT_ELIGIBLE',
      agentAction: 'report_to_user',
      details: { step_state: 'failed' },
    });
  });

  it('throws STATE_STEP_NOT_ELIGIBLE (step_state: skipped) when step is in skipped_steps (issue #207, the latent omission)', async () => {
    const { run: run } = await runStore.create({
      workflowId: 'append-trace-wf',
      workflowVersion: 1,
      params: {},
    });
    await runStore.update({
      ...run,
      skipped_steps: ['step-agent'],
    });
    await expect(
      handleAppendTrace(
        { run_id: run.id, step_id: 'step-agent', entries: [{ event: 'test' }] },
        { runStore, workflowStore, traceBufferStore },
      ),
    ).rejects.toMatchObject({
      code: 'STATE_STEP_NOT_ELIGIBLE',
      agentAction: 'report_to_user',
      details: { step_state: 'skipped' },
    });
  });

  it('throws STATE_STEP_NOT_ELIGIBLE (step_state: in_progress, agentAction: resolve_precondition) when step is in in_progress_steps', async () => {
    const { run: run } = await runStore.create({
      workflowId: 'append-trace-wf',
      workflowVersion: 1,
      params: {},
    });
    await runStore.update({
      ...run,
      in_progress_steps: ['step-agent'],
    });
    await expect(
      handleAppendTrace(
        { run_id: run.id, step_id: 'step-agent', entries: [{ event: 'test' }] },
        { runStore, workflowStore, traceBufferStore },
      ),
    ).rejects.toMatchObject({
      code: 'STATE_STEP_NOT_ELIGIBLE',
      // issue #207 PR-2: aligned to claimStep's STATE_STEP_ALREADY_CLAIMED precedent — the same
      // in_progress state must never yield two different agent actions across tools.
      agentAction: 'resolve_precondition',
      details: { step_state: 'in_progress' },
    });
  });

  it('returns status: ok with AppendResult fields when step is eligible and entries are valid', async () => {
    const { run: run } = await runStore.create({
      workflowId: 'append-trace-wf',
      workflowVersion: 1,
      params: {},
    });
    const result = await handleAppendTrace(
      {
        run_id: run.id,
        step_id: 'step-agent',
        entries: [{ event: 'tool_call', data: { name: 'search' } }],
      },
      { runStore, workflowStore, traceBufferStore },
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.buffer_count).toBe(1);
      expect(result.buffer_bytes).toBeGreaterThan(0);
      expect(result.limit_count).toBeGreaterThan(0);
      expect(result.limit_bytes).toBeGreaterThan(0);
    }
  });

  it('empty entries array returns current buffer state without writing', async () => {
    const { run: run } = await runStore.create({
      workflowId: 'append-trace-wf',
      workflowVersion: 1,
      params: {},
    });
    // First add an entry.
    await handleAppendTrace(
      { run_id: run.id, step_id: 'step-agent', entries: [{ event: 'existing' }] },
      { runStore, workflowStore, traceBufferStore },
    );
    // Then call with empty entries.
    const result = await handleAppendTrace(
      { run_id: run.id, step_id: 'step-agent', entries: [] },
      { runStore, workflowStore, traceBufferStore },
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.buffer_count).toBe(1);
    }
  });

  it('propagates BUFFER_FULL error from the buffer store', async () => {
    const { run: run } = await runStore.create({
      workflowId: 'append-trace-wf',
      workflowVersion: 1,
      params: {},
    });
    // Fill up to the limit.
    const bigBatch = Array.from({ length: BUFFER_LIMIT_COUNT }, (_, i) => ({ event: `e${i}` }));
    await traceBufferStore.append(run.id, 'step-agent', bigBatch);

    await expect(
      handleAppendTrace(
        { run_id: run.id, step_id: 'step-agent', entries: [{ event: 'overflow' }] },
        { runStore, workflowStore, traceBufferStore },
      ),
    ).rejects.toMatchObject({ code: 'BUFFER_FULL' });
  });

  it('reserved-prefix events are dropped by per-entry normalization; buffer_count reflects only stored entries', async () => {
    const { run: run } = await runStore.create({
      workflowId: 'append-trace-wf',
      workflowVersion: 1,
      params: {},
    });
    const result = await handleAppendTrace(
      {
        run_id: run.id,
        step_id: 'step-agent',
        entries: [
          { event: 'trace.reserved_prefix' },
          { event: 'valid_event' },
          { event: 'trace.another_reserved' },
        ],
      },
      { runStore, workflowStore, traceBufferStore },
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      // Only 'valid_event' survives normalization.
      expect(result.buffer_count).toBe(1);
    }
  });

  it('C10 (issue #456) a workflow-absent run carries the remedy', async () => {
    // NON-terminal — the terminal guard at :254 precedes the workflow fetch at :276, so a
    // terminal fixture would refuse there first and never reach this cell's target.
    const { run: run } = await runStore.create({
      workflowId: 'dev456',
      workflowVersion: 1,
      params: {},
    });
    await expect(
      handleAppendTrace(
        { run_id: run.id, step_id: 'step-agent', entries: [] },
        { runStore, workflowStore, traceBufferStore },
      ),
    ).rejects.toThrow(/most often/);
    await expect(
      handleAppendTrace(
        { run_id: run.id, step_id: 'step-agent', entries: [] },
        { runStore, workflowStore, traceBufferStore },
      ),
    ).rejects.toThrow(/retry/);
  });
});

describe('append_trace terminal-run guard (issue #187)', () => {
  let runDir: string;
  let workflowDir: string;
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  let traceBufferStore: InMemoryTraceBufferStore;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-append-trace-terminal-runs-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-append-trace-terminal-wf-'));
    runStore = new JsonFileStore(runDir);
    workflowStore = new JsonWorkflowStore(workflowDir);
    traceBufferStore = new InMemoryTraceBufferStore();

    const def = makeWorkflowDef();
    await writeFile(join(workflowDir, `${def.id}.json`), JSON.stringify(def, null, 2), 'utf8');
  });

  /** Drives a fresh run to exactly the requested terminal `run_phase` via deriveRunPhase's own
   *  rules (see engine/eligibility.ts) — abandoned_at / aborted_at / terminal_reason /
   *  failed_steps are the ONLY inputs that decide it. */
  async function makeTerminalRun(
    phase: 'completed' | 'failed' | 'abandoned' | 'aborted',
  ): Promise<RunRecord> {
    const { run } = await runStore.create({
      workflowId: 'append-trace-wf',
      workflowVersion: 1,
      params: {},
    });
    const patch: Partial<RunRecord> =
      phase === 'completed'
        ? {
            terminal_state: true,
            sealed_by: { arm: 'complete' as const },
            terminal_reason: 'Workflow completed.',
          }
        : phase === 'failed'
          ? {
              terminal_state: true,
              sealed_by: { arm: 'step_failure' as const },
              terminal_reason: `Step 'step-agent' failed: boom`,
              failed_steps: ['step-agent'],
            }
          : phase === 'aborted'
            ? {
                terminal_state: true,
                sealed_by: { arm: 'guard_abort' as const },
                aborted_at: { step_id: 'step-agent' },
              }
            : {
                terminal_state: true,
                sealed_by: { arm: 'abandon_requested' as const },
                abandoned_at: new Date().toISOString(),
              };
    const updated = await runStore.update({ ...run, ...patch });
    expect(updated.run_phase).toBe(phase); // sanity: confirms the fixture actually reaches the phase under test
    return updated;
  }

  it.each(['completed', 'failed', 'abandoned', 'aborted'] as const)(
    'append_trace to a %s run is rejected (typed error, report_to_user) and writes NO WAL',
    async (phase) => {
      const run = await makeTerminalRun(phase);

      await expect(
        handleAppendTrace(
          { run_id: run.id, step_id: 'step-agent', entries: [{ event: 'late_entry' }] },
          { runStore, workflowStore, traceBufferStore },
        ),
      ).rejects.toMatchObject({
        code: 'STATE_STEP_NOT_ELIGIBLE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { step_state: 'run_terminal', run_phase: phase },
      });

      // No WAL was written — the buffer is empty (append() was never reached).
      const remaining = await traceBufferStore.read(run.id, 'step-agent');
      expect(remaining).toHaveLength(0);
    },
  );

  it('append_trace to a non-terminal run with an eligible step is unaffected — still succeeds, byte-identical to before', async () => {
    const { run } = await runStore.create({
      workflowId: 'append-trace-wf',
      workflowVersion: 1,
      params: {},
    });
    const result = await handleAppendTrace(
      { run_id: run.id, step_id: 'step-agent', entries: [{ event: 'ok_entry' }] },
      { runStore, workflowStore, traceBufferStore },
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.buffer_count).toBe(1);
    }
  });
});

describe('registerAppendTrace — ResponseEnvelope error shape', () => {
  let runDir: string;
  let workflowDir: string;
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  let traceBufferStore: InMemoryTraceBufferStore;
  let client: Client;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-append-reg-runs-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-append-reg-wf-'));
    runStore = new JsonFileStore(runDir);
    workflowStore = new JsonWorkflowStore(workflowDir);
    traceBufferStore = new InMemoryTraceBufferStore();

    const def = makeWorkflowDef();
    await writeFile(join(workflowDir, `${def.id}.json`), JSON.stringify(def, null, 2), 'utf8');

    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerAppendTrace(server, { runStore, workflowStore, traceBufferStore });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  async function callAppendTrace(args: {
    run_id: string;
    step_id: string;
    entries: unknown[];
  }): Promise<Record<string, unknown>> {
    const raw = await client.callTool({ name: 'append_trace', arguments: args });
    const content = (raw as { content: Array<{ type: string; text: string }> }).content;
    return JSON.parse(content[0]!.text) as Record<string, unknown>;
  }

  it('returns ResponseEnvelope with error_code on run_id not found', async () => {
    const envelope = await callAppendTrace({
      run_id: 'ghost-run',
      step_id: 'step-agent',
      entries: [],
    });
    expect(envelope['status']).toBe('error');
    expect(envelope['error_code']).toBe('STATE_RUN_NOT_FOUND');
    expect(envelope['run_id']).toBe('ghost-run');
    expect(envelope['command']).toBe('append_trace');
    expect(typeof envelope['context_hint']).toBe('string');
    expect(Array.isArray(envelope['next_actions'])).toBe(true);
    expect(Array.isArray(envelope['errors'])).toBe(true);
  });

  it('returns ResponseEnvelope with error_code on step not found', async () => {
    const { run: run } = await runStore.create({
      workflowId: 'append-trace-wf',
      workflowVersion: 1,
      params: {},
    });
    const envelope = await callAppendTrace({
      run_id: run.id,
      step_id: 'no-such-step',
      entries: [],
    });
    expect(envelope['status']).toBe('error');
    expect(envelope['error_code']).toBe('STEP_NOT_FOUND');
    expect(envelope['run_id']).toBe(run.id);
    expect(envelope['command']).toBe('append_trace');
    expect(typeof envelope['context_hint']).toBe('string');
  });

  it('returns ResponseEnvelope with error_code on step not eligible', async () => {
    const { run: run } = await runStore.create({
      workflowId: 'append-trace-wf',
      workflowVersion: 1,
      params: {},
    });
    const envelope = await callAppendTrace({
      run_id: run.id,
      step_id: 'step-auto',
      entries: [],
    });
    expect(envelope['status']).toBe('error');
    expect(envelope['error_code']).toBe('STATE_STEP_NOT_ELIGIBLE');
    expect(envelope['run_id']).toBe(run.id);
  });
});
