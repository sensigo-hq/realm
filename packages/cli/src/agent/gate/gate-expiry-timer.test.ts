// gate-expiry-timer.test.ts — issue #291, Deliverable 4e: the attending-process enactment timer.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import type { WorkflowDefinition, PendingGate } from '@sensigo/realm';
import { scheduleGateExpiryTimer } from './gate-expiry-timer.js';

const def: WorkflowDefinition = {
  id: 'timer-wf',
  name: 'Timer WF',
  version: 1,
  steps: {
    approve: { description: 'a', execution: 'auto', depends_on: [], trust: 'human_confirmed' },
  },
};

function makeGate(overrides: Partial<PendingGate> = {}): PendingGate {
  return {
    gate_id: 'gate-1',
    step_name: 'approve',
    preview: {},
    choices: ['approve', 'reject'],
    opened_at: new Date().toISOString(),
    ...overrides,
  };
}

async function seedGatedRun(store: InMemoryStore, gate: PendingGate) {
  const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  return store.update({
    ...run,
    in_progress_steps: ['approve'],
    claims: { approve: { deadline: null } },
    pending_gate: gate,
  });
}

describe('scheduleGateExpiryTimer (issue #291)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires at expires_at and enacts the frozen disposition (settle_default)', async () => {
    vi.useFakeTimers();
    const store = new InMemoryStore();
    const expiresAt = new Date(Date.now() + 1000).toISOString();
    const gate = makeGate({
      expires_at: expiresAt,
      on_expiry: 'settle_default',
      default_choice: 'approve',
    });
    const run = await seedGatedRun(store, gate);

    const cancel = scheduleGateExpiryTimer(run.id, gate, { store, definition: def });
    await vi.advanceTimersByTimeAsync(1500);
    cancel();

    const final = await store.get(run.id);
    expect(final.pending_gate).toBeUndefined();
    expect(final.completed_steps).toContain('approve');
    expect(final.settled?.['approve']).toMatchObject({ resolved_by: 'timeout' });
  });

  it('never fires before expires_at', async () => {
    vi.useFakeTimers();
    const store = new InMemoryStore();
    const expiresAt = new Date(Date.now() + 10_000).toISOString();
    const gate = makeGate({ expires_at: expiresAt, on_expiry: 'abort' });
    const run = await seedGatedRun(store, gate);

    const cancel = scheduleGateExpiryTimer(run.id, gate, { store, definition: def });
    await vi.advanceTimersByTimeAsync(1000);
    cancel();

    const stillOpen = await store.get(run.id);
    expect(stillOpen.pending_gate).toBeDefined();
  });

  it('cancel() prevents a later fire from enacting anything', async () => {
    vi.useFakeTimers();
    const store = new InMemoryStore();
    const expiresAt = new Date(Date.now() + 1000).toISOString();
    const gate = makeGate({ expires_at: expiresAt, on_expiry: 'abort' });
    const run = await seedGatedRun(store, gate);

    const cancel = scheduleGateExpiryTimer(run.id, gate, { store, definition: def });
    cancel();
    await vi.advanceTimersByTimeAsync(5000);

    const stillOpen = await store.get(run.id);
    expect(stillOpen.pending_gate).toBeDefined();
  });

  it('a finding-only gate (no on_expiry) is a no-op — schedules nothing', async () => {
    vi.useFakeTimers();
    const store = new InMemoryStore();
    const expiresAt = new Date(Date.now() + 1000).toISOString();
    const gate = makeGate({ expires_at: expiresAt }); // no on_expiry
    const run = await seedGatedRun(store, gate);
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    const cancel = scheduleGateExpiryTimer(run.id, gate, { store, definition: def });
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    cancel();
    await vi.advanceTimersByTimeAsync(5000);
    const stillOpen = await store.get(run.id);
    expect(stillOpen.pending_gate).toBeDefined();
  });

  it('a gate with no expires_at at all is a no-op', async () => {
    vi.useFakeTimers();
    const store = new InMemoryStore();
    const gate = makeGate();
    const run = await seedGatedRun(store, gate);
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    scheduleGateExpiryTimer(run.id, gate, { store, definition: def });
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('a race with another enactment point (already enacted before the timer fires) NOOPs harmlessly', async () => {
    vi.useFakeTimers();
    const store = new InMemoryStore();
    const expiresAt = new Date(Date.now() + 1000).toISOString();
    const gate = makeGate({
      expires_at: expiresAt,
      on_expiry: 'settle_default',
      default_choice: 'approve',
    });
    const run = await seedGatedRun(store, gate);

    const cancel = scheduleGateExpiryTimer(run.id, gate, { store, definition: def });

    // A DIFFERENT enactment point (e.g. drain --expired) wins the race first.
    await store.settleStep!(run.id, { kind: 'expire_gate', gateId: gate.gate_id }, def, {
      now: new Date(Date.now() + 1500),
    });
    const afterRace = await store.get(run.id);
    expect(afterRace.completed_steps).toContain('approve');

    // The timer firing afterward must not throw and must not double-apply.
    await expect(vi.advanceTimersByTimeAsync(2000)).resolves.not.toThrow();
    cancel();
  });
});
