// listen-sweep-expired-gates.test.ts — issue #291, Deliverable 4f: the `realm listen` opt-in
// store-wide expired-gate sweeper. sweepExpiredGates is exercised directly (pure I/O
// orchestration, now-injectable) — no HTTP server needed.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStore } from '@sensigo/realm-testing';
import { WorkflowError, CURRENT_WORKFLOW_SCHEMA_VERSION, JsonFileStore } from '@sensigo/realm';
import type { WorkflowDefinition, PendingGate, WorkflowRegistrar } from '@sensigo/realm';
import { sweepExpiredGates, type ListenDeps, type Logger, type SweepSeenFiles } from './listen.js';

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
  const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  return store.update({
    ...run,
    in_progress_steps: ['approve'],
    claims: { approve: { deadline: null } },
    pending_gate: gate,
  });
}

const NOW = new Date('2020-01-01T01:00:00.000Z'); // well past the fixture expires_at above

describe('sweepExpiredGates (issue #291, Deliverable 4f)', () => {
  it('enacts an expired, enactable (settle_default) gate', async () => {
    const runStore = new InMemoryStore();
    const def = wf();
    const workflowStore = makeWorkflowStore([def]);
    const gate = makeGate({ on_expiry: 'settle_default', default_choice: 'approve' });
    const run = await seedGatedRun(runStore, def, gate);

    const deps: Pick<ListenDeps, 'runStore' | 'workflowStore' | 'logger'> = {
      runStore,
      workflowStore,
      logger: silentLogger,
    };
    const result = await sweepExpiredGates(deps, NOW);

    expect(result).toMatchObject({ scanned: 1, enacted: 1, skipped_unregistered: 0, errors: 0 });
    const final = await runStore.get(run.id);
    expect(final.pending_gate).toBeUndefined();
    expect(final.completed_steps).toContain('approve');
    expect(final.settled?.['approve']).toMatchObject({ resolved_by: 'timeout' });
  });

  it('enacts an expired abort disposition, terminalizing the run — logs the drain advisory, never drains itself', async () => {
    const runStore = new InMemoryStore();
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
    await sweepExpiredGates(deps, NOW);

    const final = await runStore.get(run.id);
    expect(final.terminal_state).toBe(true);
    expect(final.skip_details?.['approve']).toEqual({ kind: 'gate_expired', gate_id: 'gate-1' });
    expect(infoSpy.mock.calls.some((c) => String(c[0]).includes('drain --expired'))).toBe(true);
  });

  it('a non-expired gate is never touched', async () => {
    const runStore = new InMemoryStore();
    const def = wf();
    const workflowStore = makeWorkflowStore([def]);
    const gate = makeGate({
      on_expiry: 'abort',
      expires_at: new Date(NOW.getTime() + 999_999_000).toISOString(),
    });
    const run = await seedGatedRun(runStore, def, gate);

    const result = await sweepExpiredGates({ runStore, workflowStore, logger: silentLogger }, NOW);
    expect(result).toMatchObject({ scanned: 0, enacted: 0 });
    const final = await runStore.get(run.id);
    expect(final.pending_gate).toBeDefined();
  });

  it('a finding-only gate (no on_expiry) is never touched', async () => {
    const runStore = new InMemoryStore();
    const def = wf();
    const workflowStore = makeWorkflowStore([def]);
    // makeGate's base carries NO on_expiry, so omitting the override yields the same finding-only
    // gate the explicit `on_expiry: undefined` produced (nothing is being erased here).
    const gate = makeGate();
    const run = await seedGatedRun(runStore, def, gate);

    const result = await sweepExpiredGates({ runStore, workflowStore, logger: silentLogger }, NOW);
    expect(result).toMatchObject({ scanned: 0, enacted: 0 });
    const final = await runStore.get(run.id);
    expect(final.pending_gate).toBeDefined();
  });

  it('unregistered-workflow skip arm: a run whose workflow this listen process never mounted is skipped, not thrown', async () => {
    const runStore = new InMemoryStore();
    const def = wf();
    const workflowStore = makeWorkflowStore([]); // deliberately empty — 'sweep-wf' unregistered
    const gate = makeGate({ on_expiry: 'abort' });
    const run = await seedGatedRun(runStore, def, gate);

    const result = await sweepExpiredGates({ runStore, workflowStore, logger: silentLogger }, NOW);
    expect(result).toMatchObject({ scanned: 1, enacted: 0, skipped_unregistered: 1, errors: 0 });
    const final = await runStore.get(run.id);
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
      list: async () =>
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
      settleStep,
    };

    const result = await sweepExpiredGates(
      {
        runStore: runStore as ListenDeps['runStore'],
        workflowStore,
        logger: silentLogger,
      },
      NOW,
    );
    expect(result.scanned).toBe(2);
    expect(result.skipped_locked).toBe(1);
    expect(result.enacted).toBe(1);
    expect(settleStep).toHaveBeenCalledTimes(2);
  });

  it('dormant when the store declares no settleStep at all — a fast no-op', async () => {
    const def = wf();
    const workflowStore = makeWorkflowStore([def]);
    // `settleStep` OMITTED (the Pick keeps it optional) — the store genuinely "declares no
    // settleStep at all", which is exactly what the dormancy check reads.
    const runStore: Pick<ListenDeps['runStore'], 'list' | 'settleStep'> = {
      list: vi.fn(),
    };
    const result = await sweepExpiredGates(
      { runStore: runStore as ListenDeps['runStore'], workflowStore, logger: silentLogger },
      NOW,
    );
    expect(result).toEqual({
      scanned: 0,
      enacted: 0,
      skipped_unregistered: 0,
      skipped_locked: 0,
      errors: 0,
    });
    expect(runStore.list).not.toHaveBeenCalled();
  });
});

describe('issue #719 — the expiry sweeper on a store with a damaged run file (a real JSON store)', () => {
  function capture() {
    const warns: Array<{ msg: string; data: unknown }> = [];
    const debugs: Array<{ msg: string; data: unknown }> = [];
    const logger: Logger = {
      ...silentLogger,
      warn: (msg: string, data?: unknown) => warns.push({ msg, data }),
      debug: (msg: string, data?: unknown) => debugs.push({ msg, data }),
    };
    return { logger, warns, debugs };
  }

  it('logs the file once across passes, again after it changes, and still enacts the readable run’s gate', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'realm-719-sweep-'));
    try {
      const runStore = new JsonFileStore(runsDir);
      const def = wf();
      const run = await seedGatedRun(
        runStore,
        def,
        makeGate({ on_expiry: 'settle_default', default_choice: 'approve' }),
      );
      const bad = join(runsDir, 'bad.json');
      writeFileSync(bad, '{ not json');
      const { logger, warns, debugs } = capture();
      const sweepSeen: SweepSeenFiles = new Map();
      const deps = { runStore, workflowStore: makeWorkflowStore([def]), logger, sweepSeen };
      const passes = [];
      for (let i = 0; i < 3; i++) passes.push(await sweepExpiredGates(deps, NOW));
      const warnedAfterThree = warns.length;
      utimesSync(bad, new Date('2030-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'));
      await sweepExpiredGates(deps, NOW);
      // (a) red when the damaged file fails the pass, is logged every pass, is not logged again
      //     once it changed, or hides the readable run; (b) prints the enactments, the warn lines
      //     (path, class, reason — no content) and the debug counts.
      expect({
        enacted: passes.map((p) => p.enacted),
        gateSettled: (await runStore.get(run.id)).pending_gate === undefined,
        warnedAfterThree,
        warns: warns.map((w) => [w.msg, w.data]),
        debugs: debugs.map((d) => [d.msg, d.data]),
      }).toEqual({
        enacted: [1, 0, 0],
        gateSettled: true,
        warnedAfterThree: 1,
        warns: [0, 1].map(() => [
          'listen: run file skipped by the expiry sweeper',
          {
            path: bad,
            class: 'parse',
            reason: `The run file '${bad}' is not JSON.`,
          },
        ]),
        debugs: [0, 1, 2, 3].map(() => ['listen: expiry sweeper skipped run files', { count: 1 }]),
      });
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  it('the leak cell (the sweeper’s warn line): a fault AT a token never reaches the log', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'realm-719-sweep-'));
    try {
      writeFileSync(join(runsDir, 'bad.json'), '{"params":{"token": ghp_FAKE719}}');
      const { logger, warns } = capture();
      await sweepExpiredGates(
        {
          runStore: new JsonFileStore(runsDir),
          workflowStore: makeWorkflowStore([]),
          logger,
          sweepSeen: new Map(),
        },
        NOW,
      );
      const leaked = JSON.stringify(warns).includes('ghp_FAKE7');
      // (a) red when the parser's text reaches the log; (b) prints booleans only.
      expect({ warned: warns.length === 1, leaked }).toEqual({ warned: true, leaked: false });
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
