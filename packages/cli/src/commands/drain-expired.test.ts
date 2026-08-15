// drain-expired.test.ts — issue #291, Deliverable 4d ([F5] `drain --expired` opt-in flag): a
// non-terminal run with an expired, enactable gate is invisible to bare `drain` (the damage
// rail: byte-stable terminal-only behavior, incl. batch --force) and only reported/enacted under
// `--expired`. finding-only gates are listed but never acted on.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  drainFinalizers,
  captureEvidence,
  DRAIN_LEASE_MAX,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { classifyGateExpiry, runDrainAction, type DrainRuntimeDeps } from './drain.js';

const DEPS: DrainRuntimeDeps = { drainFinalizers, captureEvidence, drainLeaseMax: DRAIN_LEASE_MAX };

const gatedWf: WorkflowDefinition = {
  id: 'drain-expired-wf',
  name: 'Drain Expired WF',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { approve: { description: 'a', execution: 'auto', depends_on: [], handler: 'h' } },
};

describe('classifyGateExpiry (issue #291)', () => {
  const NOW = new Date('2026-07-08T12:00:00.000Z');
  it('none: no pending_gate at all', () => {
    expect(
      classifyGateExpiry(
        { pending_gate: undefined } as unknown as Parameters<typeof classifyGateExpiry>[0],
        NOW,
      ).kind,
    ).toBe('none');
  });
});

describe('runDrainAction --expired (issue #291, [F5])', () => {
  let dir: string;
  let store: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-drain-expired-'));
    store = new JsonFileStore(dir);
    workflowStore = new JsonWorkflowStore(join(dir, 'workflows'));
    await workflowStore.register(gatedWf);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });
  afterEach(async () => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  async function seedExpiredGateRun(
    on_expiry: 'settle_default' | 'abort' | undefined,
    default_choice?: string,
  ) {
    const { run } = await store.create({
      workflowId: gatedWf.id,
      workflowVersion: 1,
      params: {},
    });
    return store.update({
      ...run,
      in_progress_steps: ['approve'],
      claims: { approve: { deadline: null } },
      pending_gate: {
        gate_id: 'gate-1',
        step_name: 'approve',
        preview: {},
        choices: ['approve', 'reject'],
        opened_at: '2020-01-01T00:00:00.000Z',
        expires_at: '2020-01-01T00:05:00.000Z',
        ...(on_expiry !== undefined ? { on_expiry } : {}),
        ...(default_choice !== undefined ? { default_choice } : {}),
      },
    });
  }

  describe('bare drain (no --expired) — byte-stable, never sees the gate', () => {
    it('per-run dry-run: no gate line, non-terminal "nothing to drain" message', async () => {
      const run = await seedExpiredGateRun('abort');
      await runDrainAction(run.id, {}, store, workflowStore, DEPS);
      expect(logSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('gate expired'))).toBe(
        false,
      );
      expect(logSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('not terminal'))).toBe(
        true,
      );
    });

    it('per-run --force: refuses (not terminal) — never enacts the gate', async () => {
      const run = await seedExpiredGateRun('abort');
      await expect(
        runDrainAction(run.id, { force: true }, store, workflowStore, DEPS),
      ).rejects.toThrow('process.exit');
      const reloaded = await store.get(run.id);
      expect(reloaded.pending_gate).toBeDefined(); // untouched
    });

    it('--all: the expired-gate run is invisible, byte-stable', async () => {
      await seedExpiredGateRun('abort');
      await runDrainAction(undefined, { all: true }, store, workflowStore, DEPS);
      expect(
        logSpy.mock.calls.some((c: unknown[]) =>
          String(c[0]).includes('No runs with an actionable'),
        ),
      ).toBe(true);
    });

    it('--all --force: byte-stable, never enacts', async () => {
      const run = await seedExpiredGateRun('abort');
      await runDrainAction(undefined, { all: true, force: true }, store, workflowStore, DEPS);
      const reloaded = await store.get(run.id);
      expect(reloaded.pending_gate).toBeDefined();
    });
  });

  describe('--expired: per-run dry-run', () => {
    it('renders "would enact <disposition>" for an enactable gate', async () => {
      const run = await seedExpiredGateRun('abort');
      await runDrainAction(run.id, { expired: true }, store, workflowStore, DEPS);
      expect(
        logSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('would enact abort')),
      ).toBe(true);
    });

    it('renders the finding-only line for a gate with no on_expiry — never "would enact"', async () => {
      const run = await seedExpiredGateRun(undefined);
      await runDrainAction(run.id, { expired: true }, store, workflowStore, DEPS);
      expect(logSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('finding-only'))).toBe(
        true,
      );
      expect(logSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('would enact'))).toBe(
        false,
      );
    });
  });

  describe('--expired --force: per-run enactment', () => {
    it('settle_default: enacts, completes the step, and (sole step) drains straight through to terminal', async () => {
      const run = await seedExpiredGateRun('settle_default', 'approve');
      await runDrainAction(run.id, { expired: true, force: true }, store, workflowStore, DEPS);
      const reloaded = await store.get(run.id);
      expect(reloaded.pending_gate).toBeUndefined();
      expect(reloaded.completed_steps).toContain('approve');
      expect(reloaded.settled?.['approve']).toMatchObject({ resolved_by: 'timeout' });
    });

    it('abort: enacts, terminalizes, and the SAME invocation runs the native finalizer pass', async () => {
      const run = await seedExpiredGateRun('abort');
      await runDrainAction(run.id, { expired: true, force: true }, store, workflowStore, DEPS);
      const reloaded = await store.get(run.id);
      expect(reloaded.terminal_state).toBe(true);
      expect(reloaded.pending_gate).toBeUndefined();
      expect(reloaded.skip_details?.['approve']).toEqual({
        kind: 'gate_expired',
        gate_id: 'gate-1',
      });
      expect(logSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('gate enacted'))).toBe(
        true,
      );
    });

    it('finding-only: --force refuses (still not terminal, nothing enactable) — never silently enacts', async () => {
      const run = await seedExpiredGateRun(undefined);
      await expect(
        runDrainAction(run.id, { expired: true, force: true }, store, workflowStore, DEPS),
      ).rejects.toThrow('process.exit');
      const reloaded = await store.get(run.id);
      expect(reloaded.pending_gate).toBeDefined();
    });
  });

  describe('--expired: batch mode', () => {
    it('dry-run lists the expired-gate run with its disposition, separately from finalizer-actionable runs', async () => {
      const run = await seedExpiredGateRun('settle_default', 'approve');
      await runDrainAction(undefined, { all: true, expired: true }, store, workflowStore, DEPS);
      expect(
        logSpy.mock.calls.some(
          (c: unknown[]) =>
            String(c[0]).includes(run.id) && String(c[0]).includes('would enact settle_default'),
        ),
      ).toBe(true);
    });

    it('--force enacts the expired gate and reports it drained', async () => {
      const run = await seedExpiredGateRun('settle_default', 'approve');
      await runDrainAction(
        undefined,
        { all: true, expired: true, force: true },
        store,
        workflowStore,
        DEPS,
      );
      const reloaded = await store.get(run.id);
      expect(reloaded.completed_steps).toContain('approve');
      expect(
        logSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes(`${run.id}: gate enacted`)),
      ).toBe(true);
    });

    it('finding-only gates are listed but excluded from the actionable/force set', async () => {
      const run = await seedExpiredGateRun(undefined);
      await runDrainAction(undefined, { all: true, expired: true }, store, workflowStore, DEPS);
      expect(
        logSpy.mock.calls.some(
          (c: unknown[]) => String(c[0]).includes(run.id) && String(c[0]).includes('finding-only'),
        ),
      ).toBe(true);
      await runDrainAction(
        undefined,
        { all: true, expired: true, force: true },
        store,
        workflowStore,
        DEPS,
      );
      const reloaded = await store.get(run.id);
      expect(reloaded.pending_gate).toBeDefined(); // untouched — finding-only never enacted
    });
  });
});
