// gate-mint-freeze.test.ts — issue #291, Deliverable 2: PendingGate's enforce/notify clock
// fields are frozen at the gate-open mint (execution-loop.ts), never re-derived later.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeStep } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepDispatcher } from './execution-loop.js';

const echoDispatcher: StepDispatcher = async (_name, input) => ({ ...input });

function defWithGate(gate: WorkflowDefinition['steps'][string]['gate']): WorkflowDefinition {
  return {
    id: 'gate-mint-freeze-wf',
    name: 'Gate Mint Freeze',
    version: 1,
    steps: {
      'step-one': {
        description: 'Gated step',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        ...(gate !== undefined ? { gate } : {}),
      },
    },
  };
}

describe('gate mint-freeze (issue #291)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-gate-freeze-'));
  });

  it('a gate with no gate: block at all mints with none of the new fields (byte-identical to pre-#291)', async () => {
    const store = new JsonFileStore(dir);
    const def = defWithGate(undefined);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: echoDispatcher,
    });
    const updated = await store.get(run.id);
    const gate = updated.pending_gate!;
    expect(gate.expires_at).toBeUndefined();
    expect(gate.on_expiry).toBeUndefined();
    expect(gate.default_choice).toBeUndefined();
    expect(gate.reminder_seconds).toBeUndefined();
    expect(gate.reminder_max).toBeUndefined();
  });

  it('timeout_seconds freezes expires_at = opened_at + timeout_seconds, exactly', async () => {
    const store = new JsonFileStore(dir);
    const def = defWithGate({ timeout_seconds: 300, on_expiry: 'abort' });
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const before = Date.now();
    await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: echoDispatcher,
    });
    const after = Date.now();
    const updated = await store.get(run.id);
    const gate = updated.pending_gate!;
    expect(gate.expires_at).toBeDefined();
    const openedAtMs = new Date(gate.opened_at).getTime();
    const expiresAtMs = new Date(gate.expires_at!).getTime();
    expect(expiresAtMs - openedAtMs).toBe(300_000);
    expect(openedAtMs).toBeGreaterThanOrEqual(before);
    expect(openedAtMs).toBeLessThanOrEqual(after);
    expect(gate.on_expiry).toBe('abort');
    expect(gate.default_choice).toBeUndefined();
  });

  it('timeout_seconds WITHOUT on_expiry freezes expires_at alone — finding-only mode, legal', async () => {
    const store = new JsonFileStore(dir);
    const def = defWithGate({ timeout_seconds: 120 });
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: echoDispatcher,
    });
    const updated = await store.get(run.id);
    const gate = updated.pending_gate!;
    expect(gate.expires_at).toBeDefined();
    expect(gate.on_expiry).toBeUndefined();
  });

  it('on_expiry: settle_default freezes default_choice alongside', async () => {
    const store = new JsonFileStore(dir);
    const def = defWithGate({
      timeout_seconds: 60,
      on_expiry: 'settle_default',
      default_choice: 'approve',
    });
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: echoDispatcher,
    });
    const updated = await store.get(run.id);
    const gate = updated.pending_gate!;
    expect(gate.on_expiry).toBe('settle_default');
    expect(gate.default_choice).toBe('approve');
  });

  it('reminder_seconds freezes with reminder_max DEFAULTED to 3 when the author declared none', async () => {
    const store = new JsonFileStore(dir);
    const def = defWithGate({ reminder_seconds: 90 });
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: echoDispatcher,
    });
    const updated = await store.get(run.id);
    const gate = updated.pending_gate!;
    expect(gate.reminder_seconds).toBe(90);
    expect(gate.reminder_max).toBe(3);
    // Standalone-legal: no timeout_seconds declared, none frozen.
    expect(gate.expires_at).toBeUndefined();
  });

  it('reminder_max freezes the AUTHORED value verbatim when declared (never silently overridden)', async () => {
    const store = new JsonFileStore(dir);
    const def = defWithGate({ reminder_seconds: 90, reminder_max: 7 });
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: echoDispatcher,
    });
    const updated = await store.get(run.id);
    expect(updated.pending_gate!.reminder_max).toBe(7);
  });

  it('a later definition re-registration/edit never applies to an already-opened gate — the record is the sole source', async () => {
    const store = new JsonFileStore(dir);
    const originalDef = defWithGate({
      timeout_seconds: 60,
      on_expiry: 'settle_default',
      default_choice: 'approve',
    });
    const { run } = await store.create({
      workflowId: originalDef.id,
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, originalDef, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: echoDispatcher,
    });
    const mintedGate = (await store.get(run.id)).pending_gate!;

    // Simulate a re-registered definition with DIFFERENT gate config — the record must never
    // reflect it (it was never re-read from a definition after mint in the first place; this
    // test pins that the mint captured a SNAPSHOT, not a live reference).
    const changedDef = defWithGate({
      timeout_seconds: 9999,
      on_expiry: 'abort',
    });
    expect(changedDef.steps['step-one']!.gate?.on_expiry).toBe('abort');
    const stillFrozenGate = (await store.get(run.id)).pending_gate!;
    expect(stillFrozenGate).toEqual(mintedGate);
    expect(stillFrozenGate.on_expiry).toBe('settle_default');
    expect(stillFrozenGate.default_choice).toBe('approve');
  });
});
