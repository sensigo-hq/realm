// issue #279 (increment 1, PR-B), design record §6: an idempotent 'reuse' match on a TERMINAL run
// carrying undelivered (pending) finalizers gets ONE extra advisory warning pointing at the
// recovery verb — disclosure only, never a policy input (decideIdempotencyPolicy's own domain is
// unchanged; this warning is added by the CALLER after the policy already decided 'reuse').
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, JsonWorkflowStore, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { handleStartRun } from './start-run.js';

const workflow: WorkflowDefinition = {
  id: 'pending-drain-advisory-wf',
  name: 'Pending Drain Advisory WF',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    work: { description: 'w', execution: 'agent', depends_on: [] },
  },
};

const IDEMPOTENCY_KEY = 'pending-drain-advisory-key';

describe('start_run — pending-drain advisory on idempotent reuse (issue #279, increment 1, PR-B)', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'pending-drain-run-'));
    const wfDir = await mkdtemp(join(tmpdir(), 'pending-drain-wf-'));
    runStore = new JsonFileStore(runDir);
    workflowStore = new JsonWorkflowStore(wfDir);
    await workflowStore.register(workflow);
  });

  it('a terminal run with a pending finalizer gets the "completion recorded; N finalizer(s) not yet delivered" advisory on reuse', async () => {
    const { run } = await runStore.create({
      workflowId: 'pending-drain-advisory-wf',
      workflowVersion: 1,
      params: {},
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await runStore.update({
      ...run,
      run_phase: 'completed',
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
      completed_steps: ['work'],
      finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
    });

    const result = await handleStartRun(
      { workflow_id: 'pending-drain-advisory-wf', idempotency_key: IDEMPOTENCY_KEY },
      { runStore, workflowStore },
    );

    expect(result.deduped).toBe(true);
    expect(
      result.warnings.some(
        (w) => w.includes('completion recorded') && w.includes(`realm run drain ${run.id}`),
      ),
    ).toBe(true);
  });

  it('a terminal run with NO pending finalizers gets no such advisory', async () => {
    const { run } = await runStore.create({
      workflowId: 'pending-drain-advisory-wf',
      workflowVersion: 1,
      params: {},
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await runStore.update({
      ...run,
      run_phase: 'completed',
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
      completed_steps: ['work'],
    });

    const result = await handleStartRun(
      { workflow_id: 'pending-drain-advisory-wf', idempotency_key: IDEMPOTENCY_KEY },
      { runStore, workflowStore },
    );

    expect(result.deduped).toBe(true);
    expect(result.warnings.some((w) => w.includes('completion recorded'))).toBe(false);
  });

  it('a NON-terminal run with a pending finalizer (defensive fixture) gets no advisory — pendings imply terminal in-contract', async () => {
    const { run } = await runStore.create({
      workflowId: 'pending-drain-advisory-wf',
      workflowVersion: 1,
      params: {},
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await runStore.update({
      ...run,
      finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
    });

    const result = await handleStartRun(
      { workflow_id: 'pending-drain-advisory-wf', idempotency_key: IDEMPOTENCY_KEY },
      { runStore, workflowStore },
    );

    expect(result.warnings.some((w) => w.includes('completion recorded'))).toBe(false);
  });
});
