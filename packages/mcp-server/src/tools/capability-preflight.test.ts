// Part B pre-flight capability warning (issue #134): run creation WARNS — never refuses — when the
// effective registry can't satisfy the workflow's auto-step handlers/adapters. The `?? createDefaultRegistry()`
// fallback is the HARD invariant: a filesystem-only workflow with NO supplied registry must NOT false-warn.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, JsonWorkflowStore, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { handleStartRun } from './start-run.js';
import { handleStartRunBatch } from './start-run-batch.js';

function filesystemDef(): WorkflowDefinition {
  return {
    id: 'fs-wf',
    name: 'Filesystem WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    services: { store: { adapter: 'filesystem', trust: 'engine_delivered' } },
    steps: {
      persist: { description: 'persist', execution: 'auto', uses_service: 'store' },
    },
  };
}

function handlerDef(): WorkflowDefinition {
  return {
    id: 'handler-wf',
    name: 'Handler WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      validate: { description: 'validate', execution: 'auto', handler: 'custom_handler' },
    },
  };
}

describe('#134 pre-flight capability warning', () => {
  let runDir: string;
  let workflowDir: string;
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-cap-runs-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-cap-wf-'));
    runStore = new JsonFileStore(runDir);
    workflowStore = new JsonWorkflowStore(workflowDir);
  });

  // Test 6 — no-false-warn on a filesystem-only workflow with NO registry supplied.
  it('start_run: filesystem-only workflow, no registry → NO capability warning + run proceeds', async () => {
    await workflowStore.register(filesystemDef());
    const result = await handleStartRun(
      { workflow_id: 'fs-wf', params: {} },
      { runStore, workflowStore },
    );
    // The `filesystem` adapter IS in the default registry, so no capability gap → NO capability warning.
    // (Any auto-drive runtime outcome is orthogonal — the assertion is the ABSENCE of a false warning.)
    const capWarnings = result.warnings.filter((w) => w.includes('block recoverably'));
    expect(capWarnings).toEqual([]);
    expect(result.run_id).toBeDefined();
    await expect(runStore.get(result.run_id)).resolves.toBeDefined();
    // And crucially NOT a capability-block error (the requirement was met).
    expect(result.error_code).not.toBe('ENGINE_ADAPTER_NOT_REGISTERED');
  });

  // Test 7 — warn on a genuine misconfig (unregistered handler), but STILL create the run.
  it('start_run: unregistered handler, no registry → warning names the handler+step, run still created', async () => {
    await workflowStore.register(handlerDef());
    const result = await handleStartRun(
      { workflow_id: 'handler-wf', params: {} },
      { runStore, workflowStore },
    );
    const warned = result.warnings.join('\n');
    expect(warned).toContain("Step 'validate'");
    expect(warned).toContain("handler 'custom_handler'");
    expect(warned).toContain('block recoverably');
    // WARN, never REFUSE — the run is created (and persisted) regardless. start_run auto-drives the
    // first auto step, which recoverably blocks (error_code set, NOT a hard refusal); the run persists.
    expect(result.run_id).toBeDefined();
    await expect(runStore.get(result.run_id)).resolves.toBeDefined();
    if (result.status === 'error') {
      expect(result.error_code).toBe('ENGINE_HANDLER_NOT_REGISTERED');
    }
  });

  // start_run_batch — warns per item with the creation-time caveat, run(s) still created.
  it('start_run_batch: unregistered handler → per-item warning with the creation-time caveat', async () => {
    await workflowStore.register(handlerDef());
    const result = await handleStartRunBatch(
      { workflow_id: 'handler-wf', items: [{ params: {} }, { params: {} }] },
      { runStore, workflowStore },
    );
    expect(result.started).toHaveLength(2);
    for (const item of result.started) {
      const warned = item.warnings.join('\n');
      expect(warned).toContain("handler 'custom_handler'");
      expect(warned).toContain('the driving runner may differ');
    }
  });
});
