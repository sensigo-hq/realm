// listen-sweep-expired-gates.test.ts — issue #291, Deliverable 4f: the `realm listen` opt-in
// store-wide expired-gate sweeper. sweepExpiredGates is exercised directly (pure I/O
// orchestration) — no HTTP server needed. #715 (b): the store's clock decides (a settable clock at NOW).
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { listing } from '../test-support/snapshot-double.js';
import { WorkflowError, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition, PendingGate, WorkflowRegistrar } from '@sensigo/realm';
import {
  sweepExpiredGates,
  startListen,
  type ListenDeps,
  type Logger,
  type WorkflowEntry,
} from './listen.js';
import { makeTempHome } from '../test-support/temp-home.js';

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function wf(): WorkflowDefinition {
  return {
    id: 'sweep-wf',
    name: 'Sweep WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      approve: { description: 'a', execution: 'auto', depends_on: [], trust: 'human_confirmed' },
    },
  };
}

/** Minimal Map-backed WorkflowRegistrar double — no on-disk registrar needed for these tests. */
function makeWorkflowStore(
  defs: WorkflowDefinition[],
): Pick<WorkflowRegistrar, 'register' | 'get'> {
  const byId = new Map(defs.map((d) => [d.id, d]));
  return {
    register: async (d: WorkflowDefinition) => {
      byId.set(d.id, d);
    },
    get: async (id: string) => {
      const found = byId.get(id);
      if (found === undefined) {
        throw new WorkflowError(`Workflow '${id}' not found`, {
          code: 'STATE_WORKFLOW_NOT_FOUND',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      }
      return found;
    },
  };
}

function makeGate(overrides: Partial<PendingGate> = {}): PendingGate {
  return {
    gate_id: 'gate-1',
    step_name: 'approve',
    preview: {},
    choices: ['approve', 'reject'],
    opened_at: '2020-01-01T00:00:00.000Z',
    expires_at: '2020-01-01T00:05:00.000Z',
    ...overrides,
  };
}

async function seedGatedRun(
  store: Pick<InMemoryStore, 'create' | 'update'>,
  def: WorkflowDefinition,
  gate: PendingGate,
) {
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

const NOW = new Date('2020-01-01T01:00:00.000Z'); // well past the fixture expires_at above

describe('sweepExpiredGates (issue #291, Deliverable 4f)', () => {
  it('enacts an expired, enactable (settle_default) gate', async () => {
    const runStore = new InMemoryStore({ clock: settableClock(NOW) });
    const def = wf();
    const workflowStore = makeWorkflowStore([def]);
    const gate = makeGate({ on_expiry: 'settle_default', default_choice: 'approve' });
    const run = await seedGatedRun(runStore, def, gate);

    const deps: Pick<ListenDeps, 'runStore' | 'workflowStore' | 'logger'> = {
      runStore,
      workflowStore,
      logger: silentLogger,
    };
    const result = await sweepExpiredGates(deps);

    expect(result).toMatchObject({ scanned: 1, enacted: 1, skipped_unregistered: 0, errors: 0 });
    const { record: final } = await runStore.get(run.id);
    expect(final.pending_gate).toBeUndefined();
    expect(final.completed_steps).toContain('approve');
    expect(final.settled?.['approve']).toMatchObject({ resolved_by: 'timeout' });
  });

  it('enacts an expired abort disposition, terminalizing the run — logs the drain advisory, never drains itself', async () => {
    const runStore = new InMemoryStore({ clock: settableClock(NOW) });
    const def = wf();
    const workflowStore = makeWorkflowStore([def]);
    const gate = makeGate({ on_expiry: 'abort' });
    const run = await seedGatedRun(runStore, def, gate);
    const infoSpy = vi.fn();

    const deps: Pick<ListenDeps, 'runStore' | 'workflowStore' | 'logger'> = {
      runStore,
      workflowStore,
      logger: { ...silentLogger, info: infoSpy },
    };
    await sweepExpiredGates(deps);

    const { record: final } = await runStore.get(run.id);
    expect(final.terminal_state).toBe(true);
    expect(final.skip_details?.['approve']).toEqual({ kind: 'gate_expired', gate_id: 'gate-1' });
    expect(infoSpy.mock.calls.some((c) => String(c[0]).includes('drain --expired'))).toBe(true);
  });

  it('a non-expired gate is never touched', async () => {
    const runStore = new InMemoryStore({ clock: settableClock(NOW) });
    const def = wf();
    const workflowStore = makeWorkflowStore([def]);
    const gate = makeGate({
      on_expiry: 'abort',
      expires_at: new Date(NOW.getTime() + 999_999_000).toISOString(),
    });
    const run = await seedGatedRun(runStore, def, gate);

    const result = await sweepExpiredGates({ runStore, workflowStore, logger: silentLogger });
    expect(result).toMatchObject({ scanned: 0, enacted: 0 });
    const { record: final } = await runStore.get(run.id);
    expect(final.pending_gate).toBeDefined();
  });

  it('a finding-only gate (no on_expiry) is never touched', async () => {
    const runStore = new InMemoryStore({ clock: settableClock(NOW) });
    const def = wf();
    const workflowStore = makeWorkflowStore([def]);
    // makeGate's base carries NO on_expiry, so omitting the override yields the same finding-only
    // gate the explicit `on_expiry: undefined` produced (nothing is being erased here).
    const gate = makeGate();
    const run = await seedGatedRun(runStore, def, gate);

    const result = await sweepExpiredGates({ runStore, workflowStore, logger: silentLogger });
    expect(result).toMatchObject({ scanned: 0, enacted: 0 });
    const { record: final } = await runStore.get(run.id);
    expect(final.pending_gate).toBeDefined();
  });

  it('unregistered-workflow skip arm: a run whose workflow this listen process never mounted is skipped, not thrown', async () => {
    const runStore = new InMemoryStore({ clock: settableClock(NOW) });
    const def = wf();
    const workflowStore = makeWorkflowStore([]); // deliberately empty — 'sweep-wf' unregistered
    const gate = makeGate({ on_expiry: 'abort' });
    const run = await seedGatedRun(runStore, def, gate);

    const result = await sweepExpiredGates({ runStore, workflowStore, logger: silentLogger });
    expect(result).toMatchObject({ scanned: 1, enacted: 0, skipped_unregistered: 1, errors: 0 });
    const { record: final } = await runStore.get(run.id);
    expect(final.pending_gate).toBeDefined(); // untouched
  });

  it('ELOCKED (STATE_RUN_BUSY) catch-and-continue arm: one locked run never aborts the whole sweep pass', async () => {
    const def = wf();
    const workflowStore = makeWorkflowStore([def]);
    const busyErr = new WorkflowError('locked', {
      code: 'STATE_RUN_BUSY',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: true,
    });
    const runA = {
      id: 'run-a',
      workflow_id: def.id,
      pending_gate: makeGate({ on_expiry: 'abort' }),
    };
    const runB = {
      id: 'run-b',
      workflow_id: def.id,
      pending_gate: makeGate({
        gate_id: 'gate-2',
        on_expiry: 'settle_default',
        default_choice: 'approve',
      }),
    };
    const settleStep = vi
      .fn()
      .mockRejectedValueOnce(busyErr)
      .mockResolvedValueOnce({ applied: true, transitioned: true, run: {}, pendingFinalizers: [] });
    const runStore: Pick<ListenDeps['runStore'], 'list' | 'settleStep'> = {
      // #715 (b): a listing is snapshots (each row judged at its own reading — here the host's).
      list: async () =>
        listing(
          [runA, runB].map((r) => ({
            ...r,
            workflow_version: 1,
            completed_steps: [],
            in_progress_steps: ['approve'],
            failed_steps: [],
            skipped_steps: [],
            run_phase: 'gate_waiting' as const,
            version: 1,
            params: {},
            evidence: [],
            created_at: '2020-01-01T00:00:00.000Z',
            updated_at: '2020-01-01T00:00:00.000Z',
            terminal_state: false,
          })),
        ),
      settleStep,
    };

    const result = await sweepExpiredGates({
      runStore: runStore as ListenDeps['runStore'],
      workflowStore,
      logger: silentLogger,
    });
    expect(result.scanned).toBe(2);
    expect(result.skipped_locked).toBe(1);
    expect(result.enacted).toBe(1);
    expect(settleStep).toHaveBeenCalledTimes(2);
  });
});

describe('issue #719 — a sweeper pass that fails is logged', () => {
  it('a sweeper pass whose listing the store refuses: `listen: sweeper pass failed`, with the store’s error, and listen keeps running', async () => {
    const h = await makeTempHome();
    const errors: Array<{ msg: string; data: unknown }> = [];
    const logger: Logger = {
      ...silentLogger,
      error: (msg: string, data?: unknown) => errors.push({ msg, data }),
    };
    // #616 PR-2c, c10a-2b: a double over the handle's run store whose listing rejects — both verbs
    // the sweep may call (`listWithDiagnostics` where the store has it, as the JSON store does;
    // `list` otherwise), with one Realm error.
    const err = new WorkflowError('The store could not list the runs: a fake refusal.', {
      code: 'ENGINE_STORE_FAILED',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: false,
    });
    const runStore = new Proxy(h.home.runStore, {
      get(target, prop) {
        if (prop === 'listWithDiagnostics' || prop === 'list') {
          return async (): Promise<never> => Promise.reject(err);
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    const tick = vi.spyOn(global, 'setInterval');
    let handle: Awaited<ReturnType<typeof startListen>> | undefined;
    try {
      const deps: ListenDeps = {
        workflowStore: makeWorkflowStore([]) as unknown as ListenDeps['workflowStore'],
        runStore,
        dedupStoreFor: () => ({
          check: async () => false,
          record: async () => {},
          cleanup: async () => {},
        }),
        spawnAgent: async () => ({ pid: 1 }),
        logger,
      };
      handle = await startListen(
        new Map<string, WorkflowEntry>(),
        {
          port: 0,
          host: '127.0.0.1',
          bodyTimeoutMs: 5000,
          maxBodyBytes: 1_048_576,
          maxConcurrent: 20,
          sweepExpiredGatesIntervalMs: 60_000,
        },
        deps,
      );
      const fire = tick.mock.calls.find(([, ms]) => ms === 60_000)?.[0] as (() => void) | undefined;
      fire?.();
      await vi.waitFor(() => expect(errors.length).toBe(1));
      // The server lived through the failed pass: it shuts down cleanly.
      await handle.shutdown('test-cleanup');
      handle = undefined;
      // (a) red when the failed pass is not logged, or logged without the store's error; (b) prints
      //     the message and the logged error.
      expect({
        msg: errors[0]?.msg,
        error: (errors[0]?.data as { error?: unknown } | undefined)?.error,
      }).toEqual({ msg: 'listen: sweeper pass failed', error: String(err) });
    } finally {
      tick.mockRestore();
      if (handle !== undefined) await handle.shutdown('test-cleanup');
      await h.cleanup();
    }
  });
});

describe('#715 (b) 03 §A.4 — the sweeper waits for a gate’s expiry on the store’s clock', () => {
  it('a gate the pass finds not yet due is carried out when the store’s clock reaches its expires_at — without another pass', async () => {
    // (a) red when the pass registers no waiter on the store's clock (the gate stays open until the
    //     next real-time pass); (b) prints the run's gate and phase before and after the clock moves.
    const clock = settableClock(new Date('2020-01-01T00:04:00.000Z'));
    const store = new InMemoryStore({ clock });
    const def = wf();
    const run = await seedGatedRun(store, def, makeGate({ on_expiry: 'abort' }));
    const waits = new Map<string, () => void>();
    const pass = await sweepExpiredGates({
      runStore: store,
      workflowStore: makeWorkflowStore([def]),
      logger: silentLogger,
      waits,
    });
    const before = (await store.get(run.id)).record;
    await clock.advance(60_000);
    const after = (await store.get(run.id)).record;
    expect({
      pass: pass.enacted,
      waiting: [...waits.keys()],
      before: [before.pending_gate?.gate_id, before.run_phase],
      after: [after.pending_gate?.gate_id, after.run_phase],
    }).toEqual({
      pass: 0,
      waiting: [],
      before: ['gate-1', before.run_phase],
      after: [undefined, 'aborted'],
    });
  });

  it('a waiter whose gate a later pass no longer finds open is cancelled', async () => {
    // (a) red when an answered gate's waiter stays armed (it would write at the old deadline); (b)
    //     prints the waiters after each pass.
    const clock = settableClock(new Date('2020-01-01T00:04:00.000Z'));
    const store = new InMemoryStore({ clock });
    const def = wf();
    const run = await seedGatedRun(store, def, makeGate({ on_expiry: 'abort' }));
    const waits = new Map<string, () => void>();
    const deps = {
      runStore: store,
      workflowStore: makeWorkflowStore([def]),
      logger: silentLogger,
      waits,
    };
    await sweepExpiredGates(deps);
    const first = [...waits.keys()];
    const { record } = await store.get(run.id);
    const { pending_gate: _gate, ...rest } = record;
    await store.update({ ...rest, in_progress_steps: [] });
    await sweepExpiredGates(deps);
    expect({ first, second: [...waits.keys()] }).toEqual({ first: ['gate-1'], second: [] });
  });
});
