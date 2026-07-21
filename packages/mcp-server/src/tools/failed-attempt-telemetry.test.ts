// P2 observability: the MCP execute_step handler emits a metadata-only `agent_step_attempt_failed`
// stderr line on a pre-claim validation rejection (and nothing on success / blocked / other codes).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  FailedAttemptStore,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD,
} from '@sensigo/realm';
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

describe('execute_step failed-attempt sidecar (P3 durable sink)', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  let failedAttemptStore: FailedAttemptStore;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'fat3-run-'));
    runStore = new JsonFileStore(runsDir);
    workflowStore = new JsonWorkflowStore(await mkdtemp(join(tmpdir(), 'fat3-wf-')));
    failedAttemptStore = new FailedAttemptStore(runsDir);
    await workflowStore.register(wf);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it('appends a metadata-only record to the sidecar (no event tag) and is a pure side-channel', async () => {
    const { run } = await runStore.create({
      workflowId: 'classify-wf',
      workflowVersion: 1,
      params: {},
    });
    const versionBefore = run.version;

    const result = await handleExecuteStep(
      { run_id: run.id, command: 'classify', params: { ticket_body: 'jane@example.com' } },
      { runStore, workflowStore, failedAttemptStore },
    );
    expect(result.status).toBe('error');

    const { records, capped } = await failedAttemptStore.read(run.id);
    expect(records).toHaveLength(1);
    expect(capped).toBe(false);
    expect(records[0]!.step_id).toBe('classify');
    expect(records[0]!.error_code).toBe('VALIDATION_OUTPUT_SCHEMA');
    // The FILE line omits the `event` wrapper (the file IS the event stream).
    expect((records[0]! as Record<string, unknown>)['event']).toBeUndefined();
    // Metadata-only: no raw PII value persisted.
    expect(JSON.stringify(records[0])).not.toContain('jane@example.com');

    // issue #220 blast radius (sanctioned, record P-M3): this rejection is now COUNTED — a
    // persisted CAS write bumps validation_rejections (and the version), even though the
    // rejection's own ENVELOPE still reports the pre-write version (bump-and-report, pin (a)).
    // The side-channel INTENT this test guards survives unchanged: the run's DAG state
    // (failed_steps) is still untouched — only the new counter moved.
    const after = await runStore.get(run.id);
    expect(after.version).toBe(versionBefore + 1);
    expect(after.failed_steps).not.toContain('classify');
    // stderr sink still fired too (both sinks independent).
    expect(errSpy).toHaveBeenCalled();
  });

  it('writes nothing to the sidecar on a successful step', async () => {
    const { run } = await runStore.create({
      workflowId: 'classify-wf',
      workflowVersion: 1,
      params: {},
    });
    const result = await handleExecuteStep(
      { run_id: run.id, command: 'classify', params: { category: 'billing' } },
      { runStore, workflowStore, failedAttemptStore },
    );
    expect(result.status).toBe('ok');
    expect((await failedAttemptStore.read(run.id)).records).toHaveLength(0);
  });

  it('best-effort independence: a broken sidecar store does not throw and stderr still fires', async () => {
    const { run } = await runStore.create({
      workflowId: 'classify-wf',
      workflowVersion: 1,
      params: {},
    });
    const brokenStore = new FailedAttemptStore(join('/does', 'not', 'exist'));

    const result = await handleExecuteStep(
      { run_id: run.id, command: 'classify', params: { wrong: 1 } },
      { runStore, workflowStore, failedAttemptStore: brokenStore },
    );
    // Response unaffected.
    expect(result.status).toBe('error');
    expect(result.error_code).toBe('VALIDATION_OUTPUT_SCHEMA');
    // stderr sink (sink 1) fired despite the sidecar (sink 2) being unwritable.
    const emitted = errSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('agent_step_attempt_failed'));
    expect(emitted.length).toBeGreaterThan(0);
  });
});

describe('execute_step failed-attempt telemetry — VALIDATION_EXHAUSTED (issue #220, pin (t))', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  let failedAttemptStore: FailedAttemptStore;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'fat4-run-'));
    runStore = new JsonFileStore(runsDir);
    workflowStore = new JsonWorkflowStore(await mkdtemp(join(tmpdir(), 'fat4-wf-')));
    failedAttemptStore = new FailedAttemptStore(runsDir);
    await workflowStore.register(wf);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it('the terminalizing call reaches the failed-attempt sidecar with ajv_errors sourced from last_ajv_errors', async () => {
    const { run } = await runStore.create({
      workflowId: 'classify-wf',
      workflowVersion: 1,
      params: {},
    });
    await runStore.update({
      ...run,
      validation_rejections: { classify: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1 },
    });

    const result = await handleExecuteStep(
      { run_id: run.id, command: 'classify', params: { ticket_body: 'jane@example.com' } },
      { runStore, workflowStore, failedAttemptStore },
    );
    expect(result.status).toBe('error');
    expect(result.error_code).toBe('VALIDATION_EXHAUSTED');

    const { records } = await failedAttemptStore.read(run.id);
    expect(records).toHaveLength(1);
    expect(records[0]!.step_id).toBe('classify');
    expect(records[0]!.error_code).toBe('VALIDATION_EXHAUSTED');
    // last_ajv_errors sourcing: the summary is non-empty (built FROM error_details.last_ajv_errors,
    // not the — absent on this code — `errors` key).
    expect(records[0]!.validation_error_summary.length).toBeGreaterThan(0);
  });
});
