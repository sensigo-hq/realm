// late-answer-625.test.ts — issue #625 PR-2a, decision C9: the two refused answers that leave the run
// open AND moved on name what the run owes now (the different-choice late answer; the
// gate_choice_conflict on a gate ANOTHER writer expired). Every other refusal keeps [].
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { executeStep, submitHumanResponse } from './execution-loop.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const def: WorkflowDefinition = {
  id: 'late-owed-wf',
  name: 'late owed',
  version: 1,
  steps: {
    confirm: {
      description: 'Confirm',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: {
        choices: ['approve', 'reject'],
        timeout_seconds: 1,
        on_expiry: 'settle_default',
        default_choice: 'approve',
      },
    },
    after: { description: 'After', execution: 'auto', depends_on: ['confirm'] },
  },
};

async function opened(store: JsonFileStore) {
  const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  await executeStep(store, def, {
    runId: run.id,
    command: 'confirm',
    input: {},
    dispatcher: async () => ({}),
  });
  const gate = (await store.get(run.id)).pending_gate!;
  const afterExpiry = new Date(new Date(gate.expires_at!).getTime() + 60_000);
  return { runId: run.id, gateId: gate.gate_id, afterExpiry };
}

describe('#625 PR-2a — C9: a refused answer on a run that moved on names the owed work', () => {
  it('the different-choice late answer (its own expiry write settled another default): next_actions ends with advance_run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-late-625-'));
    try {
      const store = new JsonFileStore(dir);
      const { runId, gateId, afterExpiry } = await opened(store);
      const reply = await submitHumanResponse(store, def, {
        runId,
        gateId,
        choice: 'reject',
        now: afterExpiry,
      });
      expect(reply.status).toBe('error');
      expect(reply.error_code).toBe('STATE_BLOCKED');
      expect(reply.next_actions.map((a) => a.instruction?.tool)).toEqual(['advance_run']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('gate_choice_conflict on a gate another writer expired: next_actions ends with advance_run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-late-625-'));
    try {
      const store = new JsonFileStore(dir);
      const { runId, gateId, afterExpiry } = await opened(store);
      await store.settleStep(runId, { kind: 'expire_gate', gateId }, def, { now: afterExpiry });
      const reply = await submitHumanResponse(store, def, {
        runId,
        gateId,
        choice: 'reject',
        now: afterExpiry,
      });
      expect(reply.status).toBe('error');
      expect(reply.next_actions.map((a) => a.instruction?.tool)).toEqual(['advance_run']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CONTROL: a refusal while the gate is still open (a choice not on the list) keeps next_actions empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-late-625-'));
    try {
      const store = new JsonFileStore(dir);
      const { runId, gateId } = await opened(store);
      const reply = await submitHumanResponse(store, def, { runId, gateId, choice: 'maybe' });
      expect(reply.status).toBe('error');
      expect(reply.next_actions).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('#625 PR-2a — advanceRun on a terminal run', () => {
  it('runs nothing and says so', async () => {
    const { advanceRun } = await import('./execution-loop.js');
    const dir = await mkdtemp(join(tmpdir(), 'realm-late-625-'));
    try {
      const store = new JsonFileStore(dir);
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await store.update({
        ...run,
        terminal_state: true,
        sealed_by: { arm: 'abandon_requested' },
        terminal_reason: 'Abandoned',
      } as never);
      const reply = await advanceRun(store, def, { runId: run.id });
      expect(reply.context_hint).toBe(
        `Run '${run.id}' is already terminal (abandoned); nothing ran.`,
      );
      expect(reply.next_actions).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
