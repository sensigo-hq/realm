// gate-expiry-timer-625.test.ts — issue #625 (PR-1): the attending-process expiry timer says what
// the guards its own write settled did.
//
// The timer logs ONE line. On a store that declares `settleStep` the expiry's write also settles
// the guard the default makes eligible, so that line carries the ending sentence and its reason
// (or a passed line) — a run a guard ended is never reported as just "expired".
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import { deriveRunPhase } from '@sensigo/realm';
import type { WorkflowDefinition, PendingGate, StepDefinition } from '@sensigo/realm';
import { scheduleGateExpiryTimer } from './gate-expiry-timer.js';

/** gate `approve` → guard `check` (aborts unless the settled choice is `approve`) [→ `finish`]. */
function gateThenGuard(guard?: Partial<StepDefinition>, finish = false): WorkflowDefinition {
  return {
    id: 'timer-625',
    name: 'Timer 625',
    version: 1,
    steps: {
      approve: { description: 'a', execution: 'auto', depends_on: [], trust: 'human_confirmed' },
      check: {
        description: 'c',
        execution: 'guard',
        depends_on: ['approve'],
        abort_unless: ["approve.choice == 'approve'"],
        ...guard,
      },
      ...(finish
        ? {
            finish: {
              description: 'f',
              execution: 'agent' as const,
              depends_on: ['check'],
            },
          }
        : {}),
    },
  };
}

async function seedGatedRun(store: InMemoryStore, def: WorkflowDefinition, gate: PendingGate) {
  const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  return store.update({
    ...run,
    in_progress_steps: ['approve'],
    claims: { approve: { deadline: null } },
    pending_gate: gate,
  });
}

const expiringGate = (defaultChoice: string): PendingGate => ({
  gate_id: 'gate-1',
  step_name: 'approve',
  preview: {},
  choices: ['approve', 'reject'],
  opened_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 1000).toISOString(),
  on_expiry: 'settle_default',
  default_choice: defaultChoice,
});

describe('issue #625 — the attending-process expiry timer reports the guards its write settled', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a default that makes the guard ABORT: the timer's one line carries the ending sentence and its Reason", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const def = gateThenGuard({ abort_message: 'Not approved — stopping the run.' });
    const store = new InMemoryStore();
    const gate = expiringGate('reject');
    const run = await seedGatedRun(store, def, gate);

    const cancel = scheduleGateExpiryTimer(run.id, gate, { store, definition: def });
    await vi.advanceTimersByTimeAsync(1500);
    cancel();

    // (a) red when the timer logs only "expired — enacted" for an expiry whose guard ended the
    //     run, or drops the reason; (b) prints every line the timer logged.
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
      `⏰ gate 'gate-1' on run '${run.id}' expired — enacted via the attending-process timer (enacted_via: timer). ` +
        "Guard step 'check' aborted the run. Reason: Not approved — stopping the run.",
    ]);
    const final = await store.get(run.id);
    // (a) red when the guard is left eligible after the timer's write; (b) prints the phase and
    //     the seal.
    expect({ phase: deriveRunPhase(final), sealed_by: final.sealed_by }).toEqual({
      phase: 'aborted',
      sealed_by: { arm: 'guard_abort', step: 'check' },
    });
  });

  it('a default that makes the guard PASS and the run go on: the line carries the passed line, no Reason', async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const def = gateThenGuard(undefined, true);
    const store = new InMemoryStore();
    const gate = expiringGate('approve');
    const run = await seedGatedRun(store, def, gate);

    const cancel = scheduleGateExpiryTimer(run.id, gate, { store, definition: def });
    await vi.advanceTimersByTimeAsync(1500);
    cancel();

    // (a) red when a guard that passed is not named on the timer's line (a later answer's screen
    //     has no guard lines — this write is the one that reports them); (b) prints the lines.
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
      `⏰ gate 'gate-1' on run '${run.id}' expired — enacted via the attending-process timer (enacted_via: timer). ` +
        "Guard step 'check' passed.",
    ]);
    // (a) red when the guard is not on the record as passed; (b) prints the completed steps.
    expect((await store.get(run.id)).completed_steps).toEqual(['approve', 'check']);
  });

  it('a gate with no guard behind it: the line is unchanged', async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const def: WorkflowDefinition = {
      id: 'timer-625-plain',
      name: 'Timer 625 plain',
      version: 1,
      steps: {
        approve: { description: 'a', execution: 'auto', depends_on: [], trust: 'human_confirmed' },
        finish: { description: 'f', execution: 'agent', depends_on: ['approve'] },
      },
    };
    const store = new InMemoryStore();
    const gate = expiringGate('approve');
    const run = await seedGatedRun(store, def, gate);

    const cancel = scheduleGateExpiryTimer(run.id, gate, { store, definition: def });
    await vi.advanceTimersByTimeAsync(1500);
    cancel();

    // The control. (a) red when the timer appends anything for a write that settled no guard;
    //     (b) prints the lines.
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
      `⏰ gate 'gate-1' on run '${run.id}' expired — enacted via the attending-process timer (enacted_via: timer).`,
    ]);
  });
});
