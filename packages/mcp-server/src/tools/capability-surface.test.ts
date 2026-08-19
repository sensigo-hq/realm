// Surface test for the #134 blocked_on_capability status + capability_blocks advisory in get_run_state.
// Detection is DEFINITION-FREE (via findCapabilityBlockedSteps), so it must fire on the workflow_unresolved
// path and behind a healthy in-progress sibling — the exact places a definition-keyed check would go silent.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, JsonWorkflowStore, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition, RunRecord } from '@sensigo/realm';
import { handleGetRunState } from './get-run-state.js';

const twoStep: WorkflowDefinition = {
  id: 'twoflow',
  name: 'Two Step',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    sibling: { description: 'sibling', execution: 'agent', depends_on: [] },
    blocked: {
      description: 'blocked',
      execution: 'auto',
      depends_on: [],
      handler: 'missing_handler',
    },
  },
};

const HANDLER_BLOCK: NonNullable<RunRecord['capability_blocks']> = {
  blocked: {
    requirement: { kind: 'handler', name: 'missing_handler' },
    code: 'ENGINE_HANDLER_NOT_REGISTERED',
    at: '2026-01-01T00:00:00.000Z',
  },
};

describe('get_run_state — blocked_on_capability (#134)', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(async () => {
    runStore = new JsonFileStore(await mkdtemp(join(tmpdir(), 'cap-surf-run-')));
    workflowStore = new JsonWorkflowStore(await mkdtemp(join(tmpdir(), 'cap-surf-wf-')));
    await workflowStore.register(twoStep);
  });

  async function blockedRun(over: Partial<RunRecord>): Promise<string> {
    const { run } = await runStore.create({
      workflowId: 'twoflow',
      workflowVersion: 1,
      params: {},
    });
    await runStore.update({ ...run, capability_blocks: HANDLER_BLOCK, ...over });
    return run.id;
  }

  it('status blocked_on_capability + advisory naming the requirement', async () => {
    const id = await blockedRun({});
    const state = await handleGetRunState({ run_id: id }, { runStore, workflowStore });
    expect(state.next_actions_status).toBe('blocked_on_capability');
    expect(state.capability_blocks).toEqual([
      {
        step: 'blocked',
        requirement: { kind: 'handler', name: 'missing_handler' },
        code: 'ENGINE_HANDLER_NOT_REGISTERED',
      },
    ]);
  });

  it('fires on the workflow_unresolved path (definition-free)', async () => {
    const id = await blockedRun({});
    const state = await handleGetRunState({ run_id: id }, { runStore }); // no workflowStore
    expect(state.next_actions_status).toBe('blocked_on_capability');
    expect(state.capability_blocks?.[0]?.step).toBe('blocked');
  });

  it('surfaces behind a HEALTHY in-progress sibling (fan-out mask that a claim check would hide)', async () => {
    const id = await blockedRun({
      in_progress_steps: ['sibling'],
      claims: { sibling: { deadline: new Date(Date.now() + 3_600_000).toISOString() } },
    });
    const state = await handleGetRunState({ run_id: id }, { runStore, workflowStore });
    // A healthy claim alone would read 'ok'; the capability block outranks it.
    expect(state.next_actions_status).toBe('blocked_on_capability');
    expect(state.capability_blocks?.[0]?.step).toBe('blocked');
  });

  it('coexists with stuck_claims on a fan-out run (both advisory arrays present)', async () => {
    const id = await blockedRun({
      in_progress_steps: ['sibling'],
      claims: { sibling: { deadline: new Date(Date.now() - 1000).toISOString() } }, // stale sibling
    });
    const state = await handleGetRunState({ run_id: id }, { runStore, workflowStore });
    expect(state.next_actions_status).toBe('blocked_on_capability'); // outranks claim_stale
    expect(state.capability_blocks?.[0]?.step).toBe('blocked');
    expect(state.stuck_claims).toEqual([{ step: 'sibling', state: 'claim_stale' }]);
  });

  it('self-suppresses once the blocked step settles (terminal run → no advisory)', async () => {
    const id = await blockedRun({
      completed_steps: ['blocked'],
      terminal_state: true,
      sealed_by: { arm: 'complete' as const },
    });
    const state = await handleGetRunState({ run_id: id }, { runStore, workflowStore });
    expect(state.next_actions_status).not.toBe('blocked_on_capability');
    expect(state.capability_blocks).toBeUndefined();
  });
});
