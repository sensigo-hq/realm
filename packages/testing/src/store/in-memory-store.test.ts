// InMemoryStore parity for the per-claim liveness clock (issue #101) — mirrors JsonFileStore so
// reclaim/detection are testable on the testing default store.
import { describe, it, expect } from 'vitest';
import { InMemoryStore } from './in-memory-store.js';
import type { WorkflowDefinition } from '@sensigo/realm';

const autoFree: WorkflowDefinition = {
  id: 'p',
  name: 'Auto free',
  version: 1,
  steps: { work: { description: 'w', execution: 'auto', depends_on: [], handler: 'h' } },
};
const agentWf: WorkflowDefinition = {
  id: 'a',
  name: 'Agent',
  version: 1,
  steps: { work: { description: 'w', execution: 'agent', depends_on: [] } },
};

describe('InMemoryStore — claims parity (#101)', () => {
  it('declares persistsClaims', () => {
    expect(new InMemoryStore().persistsClaims).toBe(true);
  });

  it('claimStep writes a concrete deadline (auto step, finalizer-free) atomically with in_progress', async () => {
    const store = new InMemoryStore();
    const { run } = await store.create({ workflowId: 'p', workflowVersion: 1, params: {} });
    const claimed = await store.claimStep(run.id, 'work', autoFree);
    expect(claimed.in_progress_steps).toContain('work');
    expect(claimed.claims?.['work']?.deadline).toEqual(expect.any(String));
    expect(new Date(claimed.claims!['work']!.deadline!).getTime()).toBeGreaterThan(Date.now());
  });

  it('claimStep writes deadline: null for an agent step', async () => {
    const store = new InMemoryStore();
    const { run } = await store.create({ workflowId: 'a', workflowVersion: 1, params: {} });
    const claimed = await store.claimStep(run.id, 'work', agentWf);
    expect(claimed.claims?.['work']).toEqual({ deadline: null });
  });
});
