// gate-expiry-timer.test.ts — issue #291, Deliverable 4e: the attending-process enactment timer.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { systemClock, unreadableRunFileError } from '@sensigo/realm';
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
  const { record: run } = await store.create({
    workflowId: def.id,
    workflowVersion: 1,
    params: {},
  });
  return (
    await store.update({
      ...run,
      in_progress_steps: ['approve'],
      claims: { approve: { deadline: null } },
      pending_gate: gate,
    })
  ).record;
}

// #715 (b) (03 §A.3, D6-24: a change from "unchanged"): the timer waits on the STORE's clock
// (`store.clock.at`), so every cell runs on a settable store clock — `advance` reaches the deadline and
// awaits the enactment (D6-20); no fake timers in a file that builds a store.
const T = Date.parse('2030-01-01T00:00:00.000Z');
const at = (ms: number) => new Date(T + ms).toISOString();

/** A store on a settable clock at T, and a gate opened at T. */
function onClock() {
  const clock = settableClock(new Date(T));
  return { clock, store: new InMemoryStore({ clock }) };
}

describe('scheduleGateExpiryTimer (issue #291)', () => {
  it('fires when the store’s clock reaches expires_at and enacts the frozen disposition (settle_default); advance awaits it', async () => {
    // (a) red when the timer waits on a host timer (the store's clock reaching the deadline does not
    //     run it) or `advance` does not await the enactment; (b) prints the run after the advance.
    const { clock, store } = onClock();
    const gate = makeGate({
      opened_at: at(0),
      expires_at: at(1000),
      on_expiry: 'settle_default',
      default_choice: 'approve',
    });
    const run = await seedGatedRun(store, gate);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const cancel = scheduleGateExpiryTimer(run.id, gate, { store, definition: def });
    await clock.advance(1500);
    cancel();
    log.mockRestore();

    const { record: final } = await store.get(run.id);
    expect({
      gate: final.pending_gate,
      completed: final.completed_steps.includes('approve'),
      by: final.settled?.['approve']?.resolved_by,
    }).toEqual({ gate: undefined, completed: true, by: 'timeout' });
  });

  it('never fires before expires_at', async () => {
    // (a) red when the timer runs before the store's clock reaches the deadline; (b) prints the gate.
    const { clock, store } = onClock();
    const gate = makeGate({ opened_at: at(0), expires_at: at(10_000), on_expiry: 'abort' });
    const run = await seedGatedRun(store, gate);

    const cancel = scheduleGateExpiryTimer(run.id, gate, { store, definition: def });
    await clock.advance(1000);
    cancel();

    const { record: stillOpen } = await store.get(run.id);
    expect(stillOpen.pending_gate?.gate_id).toBe('gate-1');
  });

  it('a deadline already past when the timer is scheduled runs at the next advance', async () => {
    // (a) red when a past deadline is never run (or run at scheduling, before any advance); (b)
    //     prints the gate before and after the advance.
    const { clock, store } = onClock();
    const gate = makeGate({ opened_at: at(-5000), expires_at: at(-1000), on_expiry: 'abort' });
    const run = await seedGatedRun(store, gate);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const cancel = scheduleGateExpiryTimer(run.id, gate, { store, definition: def });
    const before = (await store.get(run.id)).record.pending_gate?.gate_id;
    await clock.advance(0);
    cancel();
    log.mockRestore();
    const after = (await store.get(run.id)).record;
    expect({ before, after: after.pending_gate?.gate_id, phase: after.run_phase }).toEqual({
      before: 'gate-1',
      after: undefined,
      phase: 'aborted',
    });
  });

  it('cancel() prevents a later fire from enacting anything', async () => {
    // (a) red when the cancel does not reach the store clock's waiter; (b) prints the gate.
    const { clock, store } = onClock();
    const gate = makeGate({ opened_at: at(0), expires_at: at(1000), on_expiry: 'abort' });
    const run = await seedGatedRun(store, gate);

    const cancel = scheduleGateExpiryTimer(run.id, gate, { store, definition: def });
    cancel();
    await clock.advance(5000);

    const { record: stillOpen } = await store.get(run.id);
    expect(stillOpen.pending_gate?.gate_id).toBe('gate-1');
  });

  it('a finding-only gate (no on_expiry), a gate with no expires_at, and one whose expires_at does not parse register nothing on the clock', async () => {
    // (a) red when any of them registers a waiter; (b) prints how many waiters were registered.
    const { store } = onClock();
    const atSpy = vi.spyOn(store.clock, 'at');
    for (const gate of [
      makeGate({ opened_at: at(0), expires_at: at(1000) }),
      makeGate({ opened_at: at(0) }),
      makeGate({ opened_at: at(0), expires_at: 'soon', on_expiry: 'abort' }),
    ]) {
      scheduleGateExpiryTimer('r', gate, { store, definition: def })();
    }
    expect(atSpy.mock.calls.length).toBe(0);
  });

  it('a race with another enactment point (it carries the expiry out first, at the same instant) NOOPs harmlessly; onApplied is not called', async () => {
    // (a) red when the timer double-applies, throws, or reports a write it did not make; (b) prints
    //     the run and the onApplied calls.
    const { clock, store } = onClock();
    const gate = makeGate({
      opened_at: at(0),
      expires_at: at(1000),
      on_expiry: 'settle_default',
      default_choice: 'approve',
    });
    const run = await seedGatedRun(store, gate);
    // Another enactment point (e.g. drain --expired), registered first, wins at the same instant.
    clock.at(new Date(T + 1000), async () => {
      await store.settleStep(run.id, { kind: 'expire_gate', gateId: gate.gate_id }, def);
    });
    const onApplied = vi.fn();
    const cancel = scheduleGateExpiryTimer(run.id, gate, { store, definition: def, onApplied });
    await clock.advance(2000);
    cancel();
    const { record: afterRace } = await store.get(run.id);
    expect({
      completed: afterRace.completed_steps.filter((s) => s === 'approve').length,
      applied: onApplied.mock.calls.length,
    }).toEqual({ completed: 1, applied: 0 });
  });

  it("#625 PR-2a, C158: onApplied is called once, after the timer's own write carried the expiry out and its line printed", async () => {
    // (a) red when the timer no longer tells its host it carried the expiry out (the prompt would
    //     wait for its watch), or tells it before its line; (b) prints the order.
    const { clock, store } = onClock();
    const gate = makeGate({
      opened_at: at(0),
      expires_at: at(1000),
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
    await clock.advance(1500);
    cancel();
    log.mockRestore();
    expect(order).toEqual(['the timer line', 'applied']);
  });
});

// issue #719 (F6.4): the timer's tail per branch. A retryable read error may pass, so another
// enactment point may still catch the gate; a read error that will not pass, or damaged bytes,
// stops every enactment point until the file can be read (or is repaired) or is moved out. #729
// PR-0 (A10, Amendment 7d): the error is core's own builder `unreadableRunFileError`, now exported —
// its facts typed (`scope: 'file'`), its retryability core's own rule (EBUSY retryable; EACCES and
// damaged bytes not), never restated here.
describe('issue #719 F6.4 — the expiry timer’s tail says what the error allows', () => {
  const path = '/srv/realm/runs/r-719.json';
  const ANOTHER =
    ' — another enactment point (submit/execute_step/reclaim/drain --expired/listen) will still catch it.';
  it.each([
    [
      'a retryable read error (EBUSY)',
      unreadableRunFileError({ resource: 'run_file', class: 'unreadable', path, errno: 'EBUSY' }),
      ANOTHER,
    ],
    [
      'a read error that will not pass (EACCES)',
      unreadableRunFileError({ resource: 'run_file', class: 'unreadable', path, errno: 'EACCES' }),
      ' — no enactment point can read this run until its file can be read or is moved out.',
    ],
    [
      'damaged bytes (parse)',
      unreadableRunFileError({ resource: 'run_file', class: 'parse', path }),
      ' — no enactment point can read this run until its file is repaired or moved out.',
    ],
  ])('%s', async (_name, error, tail) => {
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => {
      warns.push(String(m));
    });
    try {
      const gate = makeGate({
        expires_at: new Date(Date.now() - 1000).toISOString(),
        on_expiry: 'abort',
      });
      // #715 (b), C.1: the timer reaches the run only through settleStep (the legacy fallback's own
      // `get` is gone) — the store's settle reads the file and throws the read error.
      // #715 (b) (03 §A.3): the timer waits on the store's clock — the host's, here (the deadline has
      // passed, so it runs on the next tick).
      const store = {
        clock: systemClock,
        get: async () => {
          throw error;
        },
        settleStep: async () => {
          throw error;
        },
      } as unknown as Parameters<typeof scheduleGateExpiryTimer>[2]['store'];
      const cancel = scheduleGateExpiryTimer('r-719', gate, { store, definition: def });
      for (let i = 0; i < 50 && warns.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      cancel();
      const line = warns.join('\n');
      // (a) red when the tail ignores the error's retryability or its class; (b) prints the line
      //     count and booleans only.
      expect({
        lines: warns.length,
        message: line.includes(`The run file '${path}'`),
        tail: line.endsWith(tail),
      }).toEqual({ lines: 1, message: true, tail: true });
    } finally {
      spy.mockRestore();
    }
  });
});
