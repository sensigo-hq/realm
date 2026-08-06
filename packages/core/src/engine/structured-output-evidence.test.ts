// structured-output-evidence.test.ts — issue #236, Deliverable 6: the diagnostics.structured_output
// disclosure at the real dispatch-loop evidence-capture site, the external-agent stamp, and the
// evidence round-trip through a real store (the cloud-punch-list TCK note's own local proof).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeStep } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepDispatcher } from './execution-loop.js';
import type { StructuredOutputMeta } from '../types/run-record.js';

const declaredDef: WorkflowDefinition = {
  id: 'so-evidence-wf',
  name: 'Structured Output Evidence Workflow',
  version: 1,
  steps: {
    classify: {
      description: 'Classify',
      execution: 'agent',
      structured_output: 'strict',
      output_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['category'],
        properties: { category: { type: 'string' } },
      },
    },
  },
};

const plainDef: WorkflowDefinition = {
  id: 'so-plain-wf',
  name: 'Plain Workflow',
  version: 1,
  steps: {
    work: { description: 'Work', execution: 'agent', depends_on: [] },
  },
};

const echoDispatcher: StepDispatcher = async (_step, input) => ({ ...input, category: 'billing' });

describe('structured_output evidence disclosure (issue #236, Deliverable 6)', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-so-evidence-'));
    store = new JsonFileStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a real meta from stepMeta.structuredOutput flows verbatim into diagnostics.structured_output', async () => {
    const { run } = await store.create({
      workflowId: declaredDef.id,
      workflowVersion: 1,
      params: {},
    });
    const meta: StructuredOutputMeta = {
      requested: true,
      sent: true,
      submission_channel: 'tool',
    };
    const envelope = await executeStep(store, declaredDef, {
      runId: run.id,
      command: 'classify',
      // Agent-step output_schema validates the SUBMITTED input directly (there is no dispatcher
      // in the loop for an agent step's own output) — must already be schema-valid.
      input: { category: 'billing' },
      dispatcher: echoDispatcher,
      stepMeta: { structuredOutput: meta },
    });
    expect(envelope.status).toBe('ok');
    expect(envelope.evidence[0]?.diagnostics?.structured_output).toEqual(meta);
  });

  it('a declared step with NO stepMeta.structuredOutput at all gets the external_agent stamp', async () => {
    const { run } = await store.create({
      workflowId: declaredDef.id,
      workflowVersion: 1,
      params: {},
    });
    const envelope = await executeStep(store, declaredDef, {
      runId: run.id,
      command: 'classify',
      input: { category: 'billing' },
      dispatcher: echoDispatcher,
      // NO stepMeta at all — mirrors an external agent driving execute_step over MCP directly.
    });
    expect(envelope.status).toBe('ok');
    expect(envelope.evidence[0]?.diagnostics?.structured_output).toEqual({
      requested: true,
      sent: false,
      downgrade_reason: 'external_agent',
    });
  });

  it('a step that never declared structured_output carries NO structured_output diagnostics key at all, even if stepMeta.structuredOutput is (erroneously) supplied', async () => {
    const { run } = await store.create({
      workflowId: plainDef.id,
      workflowVersion: 1,
      params: {},
    });
    const envelope = await executeStep(store, plainDef, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: echoDispatcher,
      stepMeta: { structuredOutput: { requested: true, sent: true } },
    });
    expect(envelope.status).toBe('ok');
    expect(envelope.evidence[0]?.diagnostics?.structured_output).toBeUndefined();
  });

  it('evidence round-trip: the structured_output field survives a real persist + read through JsonFileStore', async () => {
    const { run } = await store.create({
      workflowId: declaredDef.id,
      workflowVersion: 1,
      params: {},
    });
    const meta: StructuredOutputMeta = {
      requested: true,
      sent: false,
      downgrade_reason: 'api_rejected_schema',
      api_message:
        "tools.0.custom: For 'object' type, 'additionalProperties' must be explicitly set to false",
    };
    await executeStep(store, declaredDef, {
      runId: run.id,
      command: 'classify',
      input: { category: 'billing' },
      dispatcher: echoDispatcher,
      stepMeta: { structuredOutput: meta },
    });
    // Fresh read — proves this isn't just an in-memory reference surviving, but a real
    // serialize/deserialize round-trip (JsonFileStore writes/reads real JSON on disk).
    const reread = await store.get(run.id);
    expect(reread.evidence[0]?.diagnostics?.structured_output).toEqual(meta);
    // TCK note (cloud punch-list, the #188 silent-drop class): a Postgres-backed RunStore's own
    // JSON/JSONB evidence column must round-trip this field identically — flagged in the report
    // for the cloud punch-list; JsonFileStore's own round-trip is proven here.
  });
});
