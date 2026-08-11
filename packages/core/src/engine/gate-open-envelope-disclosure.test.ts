// gate-open-envelope-disclosure.test.ts — issue #291, Deliverable 7 [F-A2-6]: the gate-open
// envelope's `gate` field carries `expires_at` + `first_reminder_due_at` at the exact moment the
// gate opens — no separate get_run_state round-trip needed to see the deadline.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeStep } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepDispatcher } from './execution-loop.js';

const echoDispatcher: StepDispatcher = async (_name, input) => ({ ...input });

function defWithGate(
  gate: NonNullable<WorkflowDefinition['steps'][string]['gate']>,
): WorkflowDefinition {
  return {
    id: 'gate-open-envelope-wf',
    name: 'Gate Open Envelope',
    version: 1,
    steps: {
      approve: {
        description: 'Approve',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate,
      },
    },
  };
}

describe('gate-open envelope disclosure (issue #291, [F-A2-6])', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-gate-open-envelope-'));
  });

  it('carries expires_at when timeout_seconds is declared', async () => {
    const store = new JsonFileStore(dir);
    const def = defWithGate({ timeout_seconds: 300, on_expiry: 'abort' });
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'approve',
      input: {},
      dispatcher: echoDispatcher,
    });
    expect(envelope.status).toBe('confirm_required');
    expect(envelope.gate?.expires_at).toBeDefined();
    const openedMs = new Date((await store.get(run.id)).pending_gate!.opened_at).getTime();
    const expiresMs = new Date(envelope.gate!.expires_at!).getTime();
    expect(expiresMs - openedMs).toBe(300_000);
  });

  it('carries first_reminder_due_at when reminder_seconds is declared', async () => {
    const store = new JsonFileStore(dir);
    const def = defWithGate({ reminder_seconds: 120 });
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'approve',
      input: {},
      dispatcher: echoDispatcher,
    });
    expect(envelope.gate?.first_reminder_due_at).toBeDefined();
    const openedMs = new Date((await store.get(run.id)).pending_gate!.opened_at).getTime();
    const dueMs = new Date(envelope.gate!.first_reminder_due_at!).getTime();
    expect(dueMs - openedMs).toBe(120_000);
  });

  it('neither field present for a plain gate with no timeout/reminder', async () => {
    const store = new JsonFileStore(dir);
    const def = defWithGate(
      undefined as unknown as NonNullable<WorkflowDefinition['steps'][string]['gate']>,
    );
    // Actually a step with NO gate: block at all — but trust: human_confirmed still opens one.
    const plainDef: WorkflowDefinition = {
      ...def,
      steps: {
        approve: { description: 'a', execution: 'auto', trust: 'human_confirmed', depends_on: [] },
      },
    };
    const { run } = await store.create({
      workflowId: plainDef.id,
      workflowVersion: 1,
      params: {},
    });
    const envelope = await executeStep(store, plainDef, {
      runId: run.id,
      command: 'approve',
      input: {},
      dispatcher: echoDispatcher,
    });
    expect(envelope.gate?.expires_at).toBeUndefined();
    expect(envelope.gate?.first_reminder_due_at).toBeUndefined();
  });
});
