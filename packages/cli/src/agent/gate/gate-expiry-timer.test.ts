// gate-expiry-timer.test.ts — issue #291, Deliverable 4e: the attending-process enactment timer.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import { JsonFileStore } from '@sensigo/realm';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it("#625 PR-2a, C158: onApplied is called once, after the timer's own write carried the expiry out and its line printed", async () => {
    vi.useFakeTimers();
    const store = new InMemoryStore();
    const gate = makeGate({
      expires_at: new Date(Date.now() + 1000).toISOString(),
      on_expiry: 'settle_default',
      default_choice: 'approve',
    });
    const run = await seedGatedRun(store, gate);
    const order: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      order.push(String(line).startsWith('⏰ ') ? 'the timer line' : String(line));
    });
    const onApplied = vi.fn(() => order.push('applied'));
    const cancel = scheduleGateExpiryTimer(run.id, gate, { store, definition: def, onApplied });
    await vi.advanceTimersByTimeAsync(1500);
    cancel();
    log.mockRestore();
    // (a) red when the timer no longer tells its host it carried the expiry out (the prompt would
    //     wait for its watch), or tells it before its line; (b) prints the order.
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['the timer line', 'applied']);
  });

  it('#625 PR-2a, C158: onApplied is not called when another enactment point carried the expiry out first', async () => {
    vi.useFakeTimers();
    const store = new InMemoryStore();
    const gate = makeGate({
      expires_at: new Date(Date.now() + 1000).toISOString(),
      on_expiry: 'settle_default',
      default_choice: 'approve',
    });
    const run = await seedGatedRun(store, gate);
    const onApplied = vi.fn();
    const cancel = scheduleGateExpiryTimer(run.id, gate, { store, definition: def, onApplied });
    await store.settleStep!(run.id, { kind: 'expire_gate', gateId: gate.gate_id }, def, {
      now: new Date(Date.now() + 1500),
    });
    await vi.advanceTimersByTimeAsync(2000);
    cancel();
    // (a) red when the timer reports a write it did not make; (b) prints the calls.
    expect(onApplied).not.toHaveBeenCalled();
  });
});

describe('issue #719 — the expiry timer on a run file that cannot be read', () => {
  it('logs the file’s message (its way out), never its text', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'realm-719-timer-'));
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => {
      warns.push(String(m));
    });
    try {
      writeFileSync(join(runsDir, 'bad.json'), '{"params":{"token": ghp_FAKE719}}');
      const gate = makeGate({
        expires_at: new Date(Date.now() - 1000).toISOString(),
        on_expiry: 'abort',
      });
      const cancel = scheduleGateExpiryTimer('bad', gate, {
        store: new JsonFileStore(runsDir),
        definition: def,
      });
      for (let i = 0; i < 50 && warns.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      cancel();
      const line = warns.join('\n');
      // (a) red when the timer's line loses the file's message, or carries the parser's text; (b)
      //     prints the line count and booleans only.
      expect({
        lines: warns.length,
        message: line.includes(`The run file '${join(runsDir, 'bad.json')}' is not JSON.`),
        leaked: line.includes('ghp_FAKE7'),
      }).toEqual({ lines: 1, message: true, leaked: false });
    } finally {
      spy.mockRestore();
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
