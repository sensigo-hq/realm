// issue #759 over MCP: the agent's refused answer reaches the wire with every problem — ten rows in
// `error_details.errors` and the total in `error_count` (the one carrier publishes the typed facts,
// Amendment 11) — and the failed-attempt sidecar, written from the CORE reply through core's one
// reader, keeps the same ten and the same total. A failure prints codes and counts only.
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
import { handleExecuteStepTool } from './execute-step.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';

const fields = Array.from({ length: 13 }, (_, i) => `f${String(i + 1).padStart(2, '0')}`);
const wf: WorkflowDefinition = {
  id: 'extract-759',
  name: 'Extract',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    extract: {
      description: 'Extract thirteen fields',
      execution: 'agent',
      depends_on: [],
      output_schema: {
        type: 'object',
        required: fields,
        properties: Object.fromEntries(fields.map((f) => [f, { type: 'string' }])),
      },
    },
  },
};

describe('issue #759 — the wire and the sidecar carry the same ten and the total', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  let failedAttemptStore: FailedAttemptStore;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'r759-run-'));
    runStore = new JsonFileStore(runsDir);
    workflowStore = new JsonWorkflowStore(await mkdtemp(join(tmpdir(), 'r759-wf-')));
    failedAttemptStore = new FailedAttemptStore(runsDir);
    await workflowStore.register(wf);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  async function submit(runId: string): Promise<Record<string, unknown>> {
    const raw = (await handleExecuteStepTool(
      { run_id: runId, command: 'extract', params: {} },
      { runStore, workflowStore, failedAttemptStore },
    )) as { content: Array<{ text: string }> };
    return JSON.parse(raw.content[0]!.text) as Record<string, unknown>;
  }

  it('13 problems → the wire shows ten rows, `error_count: 13` and the countdown; the sidecar record ten entries and `error_count: 13` (reds: thirteen rows; no count; the sidecar reading `error_details` on the core reply)', async () => {
    const { run } = await runStore.create({ workflowId: wf.id, workflowVersion: 1, params: {} });
    const wire = await submit(run.id);
    const details = wire['error_details'] as Record<string, unknown> | undefined;
    const errors = details?.['errors'] as Array<{ params?: { missingProperty?: string } }>;
    const [record] = (await failedAttemptStore.read(run.id)).records;
    expect({
      code: wire['error_code'],
      keys: Object.keys(details ?? {}),
      rows: errors?.length,
      firstMissing: errors?.[0]?.params?.missingProperty,
      total: details?.['error_count'],
      rejections: details?.['rejections'],
      threshold: details?.['threshold'],
      recordEntries: record?.validation_error_summary.length,
      recordFirst: record?.validation_error_summary[0]?.missing_property,
      recordTotal: record?.error_count,
    }).toEqual({
      code: 'VALIDATION_OUTPUT_SCHEMA',
      keys: ['errors', 'error_count', 'rejections', 'threshold'],
      rows: 10,
      firstMissing: 'f01',
      total: 13,
      rejections: 1,
      threshold: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD,
      recordEntries: 10,
      recordFirst: 'f01',
      recordTotal: 13,
    });
  });

  it("the exhausting sixth refusal's sidecar record keeps the last ten and the total (red: the bag's count dropped)", async () => {
    const { run } = await runStore.create({ workflowId: wf.id, workflowVersion: 1, params: {} });
    let wire: Record<string, unknown> = {};
    for (let i = 0; i < DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD; i += 1)
      wire = await submit(run.id);
    const records = (await failedAttemptStore.read(run.id)).records;
    const last = records.at(-1);
    expect({
      code: wire['error_code'],
      records: records.length,
      lastCode: last?.error_code,
      lastEntries: last?.validation_error_summary.length,
      lastTotal: last?.error_count,
    }).toEqual({
      code: 'VALIDATION_EXHAUSTED',
      records: DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD,
      lastCode: 'VALIDATION_EXHAUSTED',
      lastEntries: 10,
      lastTotal: 13,
    });
  });

  it("start_run's params refusal names an extra property by its key (#759 correction 1, C2; red: the old `(root) must NOT have additional properties`)", async () => {
    const withParams: WorkflowDefinition = {
      id: 'params-759',
      name: 'Params',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      params_schema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        additionalProperties: false,
      },
      steps: { first: { description: 'First.', execution: 'agent', depends_on: [] } },
    } as WorkflowDefinition;
    await workflowStore.register(withParams);
    const server = createRealmMcpServer({ runStore, workflowStore });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'refusal-759', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const raw = (await client.callTool({
      name: 'start_run',
      arguments: { workflow_id: withParams.id, params: { name: 'n', zzextra: 1 } },
    })) as { content: Array<{ text: string }> };
    await client.close();
    const r = JSON.parse(raw.content[0]!.text) as Record<string, unknown>;
    // (a) red when the pointer words lose the key; (b) prints the status, code and message.
    expect([r['status'], r['error_code'], r['errors']]).toEqual([
      'error',
      'VALIDATION_INPUT_SCHEMA',
      ["Invalid params for workflow 'params-759': /zzextra is not allowed"],
    ]);
  });
});
