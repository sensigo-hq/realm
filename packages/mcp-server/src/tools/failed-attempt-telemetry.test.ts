// P2 observability: the MCP execute_step handler emits a metadata-only `agent_step_attempt_failed`
// stderr line on a pre-claim validation rejection (and nothing on success / blocked / other codes).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, JsonWorkflowStore, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { handleExecuteStep, handleExecuteStepTool } from './execute-step.js';

// First step is an agent step with an output_schema → a missing-field submission fails
// VALIDATION_OUTPUT_SCHEMA on the write-free pre-claim path.
const wf: WorkflowDefinition = {
  id: 'classify-wf',
  name: 'Classify',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    classify: {
      description: 'Classify a ticket',
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

describe('execute_step failed-attempt telemetry', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    runStore = new JsonFileStore(await mkdtemp(join(tmpdir(), 'fat-run-')));
    workflowStore = new JsonWorkflowStore(await mkdtemp(join(tmpdir(), 'fat-wf-')));
    await workflowStore.register(wf);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  /** Lines emitted by the telemetry hook (filtered by event). */
  function emittedEvents(): Array<Record<string, unknown>> {
    return errSpy.mock.calls
      .map((c) => String(c[0]))
      .map((s) => {
        try {
          return JSON.parse(s) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(
        (o): o is Record<string, unknown> =>
          o !== null && o['event'] === 'agent_step_attempt_failed',
      );
  }

  it('emits exactly one agent_step_attempt_failed line with the right metadata and no raw output', async () => {
    const { run } = await runStore.create({
      workflowId: 'classify-wf',
      workflowVersion: 1,
      params: {},
    });

    const result = await handleExecuteStep(
      {
        run_id: run.id,
        command: 'classify',
        // Missing required 'category'; carries PII in another field.
        params: { ticket_body: 'jane@example.com is furious' },
      },
      { runStore, workflowStore },
    );
    expect(result.status).toBe('error');
    expect(result.error_code).toBe('VALIDATION_OUTPUT_SCHEMA');

    const events = emittedEvents();
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev['event']).toBe('agent_step_attempt_failed');
    expect(ev['run_id']).toBe(run.id);
    expect(ev['step_id']).toBe('classify');
    expect(ev['error_code']).toBe('VALIDATION_OUTPUT_SCHEMA');
    expect(ev['submitted_keys']).toEqual(['ticket_body']);
    expect(ev['submitted_key_count']).toBe(1);
    // Metadata-only: the raw PII value must never appear in the emitted line.
    expect(JSON.stringify(ev)).not.toContain('jane@example.com');
  });

  it('emits nothing on a successful step', async () => {
    const { run } = await runStore.create({
      workflowId: 'classify-wf',
      workflowVersion: 1,
      params: {},
    });
    const result = await handleExecuteStep(
      { run_id: run.id, command: 'classify', params: { category: 'billing' } },
      { runStore, workflowStore },
    );
    expect(result.status).toBe('ok');
    expect(emittedEvents()).toHaveLength(0);
  });

  it('emits nothing on a blocked result (wrong step for current state)', async () => {
    const { run } = await runStore.create({
      workflowId: 'classify-wf',
      workflowVersion: 1,
      params: {},
    });
    // 'no_such_step' is not eligible → status 'blocked', not a VALIDATION_* error.
    const result = await handleExecuteStep(
      { run_id: run.id, command: 'no_such_step', params: {} },
      { runStore, workflowStore },
    );
    expect(result.status).toBe('blocked');
    expect(emittedEvents()).toHaveLength(0);
  });

  it('emits via the MCP tool wrapper too, reading the pre-strip envelope', async () => {
    const { run } = await runStore.create({
      workflowId: 'classify-wf',
      workflowVersion: 1,
      params: {},
    });
    await handleExecuteStepTool(
      { run_id: run.id, command: 'classify', params: { wrong: 1 } },
      { runStore, workflowStore },
    );
    const events = emittedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!['error_code']).toBe('VALIDATION_OUTPUT_SCHEMA');
    // The summarized validation error is present (metadata), proving pre-strip error_details was read.
    expect(Array.isArray(events[0]!['validation_error_summary'])).toBe(true);
    expect((events[0]!['validation_error_summary'] as unknown[]).length).toBeGreaterThan(0);
  });
});
