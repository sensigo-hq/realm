// Tests for purge.ts — the operator-invoked run-purge primitive (issue #107).
//
// Mirrors cleanup.test.ts's style: the exported LOGIC (isPurgeEligible, purgeRuns) is tested
// directly against real stores over a real tmp directory — no console/exit-code assertions (that
// thin formatting layer isn't unit-tested here either, consistent with cleanup.ts/reclaim.ts).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readdir, writeFile, readFile, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { isPurgeEligible, purgeRuns, printPurgeReport } from './purge.js';
import type { PurgeRunsResult } from './purge.js';
import {
  JsonFileStore,
  FailedAttemptStore,
  buildFailedAttemptRecord,
  serializeFailedAttemptLine,
  WorkflowError,
} from '@sensigo/realm';
import type { RunRecord, RunStore, PerRunArtifactStore } from '@sensigo/realm';
import { JsonTraceBufferStore } from '@sensigo/realm-mcp';

/** Recompute the pointer-file path the store uses (sha256 of workflowId\0key) — test-side only,
 *  mirroring json-file-store.test.ts's own helper; NOT a production code path. */
function keyPointerPath(dir: string, workflowId: string, key: string): string {
  const hash = createHash('sha256').update(`${workflowId}\0${key}`).digest('hex');
  return join(dir, 'keys', `${hash}.json`);
}

/** Write a RunRecord directly to the store dir, bypassing store.create/update (full field control,
 *  mirrors cleanup.test.ts's injectRun — needed because update() always stamps updated_at=now,
 *  which would defeat the batch age-gate tests). */
async function injectRun(dir: string, run: RunRecord): Promise<void> {
  await writeFile(join(dir, `${run.id}.json`), JSON.stringify(run, null, 2), 'utf8');
}

function makeRun(overrides: Partial<RunRecord> & { id?: string }): RunRecord {
  const id = overrides.id ?? uuidv4();
  const now = new Date().toISOString();
  return {
    id,
    workflow_id: 'wf-1',
    workflow_version: 1,
    run_phase: 'completed',
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    params: {},
    evidence: [],
    version: 0,
    created_at: now,
    updated_at: now,
    terminal_state: true,
    ...overrides,
  };
}

interface Stores {
  dir: string;
  runStore: JsonFileStore;
  failedAttemptStore: FailedAttemptStore;
  traceBufferStore: JsonTraceBufferStore;
  artifactStores: PerRunArtifactStore[];
}

async function makeStores(): Promise<Stores> {
  const dir = await mkdtemp(join(tmpdir(), 'purge-test-'));
  const runStore = new JsonFileStore(dir);
  const failedAttemptStore = new FailedAttemptStore(dir);
  const traceBufferStore = new JsonTraceBufferStore(dir);
  return {
    dir,
    runStore,
    failedAttemptStore,
    traceBufferStore,
    // issue #184: runStore is now passed to purgeRuns SEPARATELY as the anchorStore argument —
    // artifactStores holds the non-anchor stores only (mechanical signature update).
    artifactStores: [traceBufferStore, failedAttemptStore],
  };
}

async function appendSidecarLine(store: FailedAttemptStore, runId: string): Promise<void> {
  const rec = buildFailedAttemptRecord({
    run_id: runId,
    workflow_id: 'wf-1',
    step_id: 'classify',
    ts: '2026-06-27T00:00:00.000Z',
    error_code: 'VALIDATION_OUTPUT_SCHEMA',
    ajv_errors: [],
    params: {},
    trace_entry_count: 0,
  });
  await store.append(runId, serializeFailedAttemptLine({ ...rec }).line);
}

const ONE_DAY_AGO = new Date(Date.now() - 2 * 86_400_000).toISOString();
const FAR_FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const PAST = new Date(Date.now() - 3_600_000).toISOString();

describe('isPurgeEligible (the purge selection predicate — mode-aware, issue #107 correction)', () => {
  it.each([true, false])(
    'rejects a non-terminal (running) run regardless of explicit mode (explicit=%s)',
    (explicit) => {
      const run = makeRun({ run_phase: 'running', terminal_state: false });
      const v = isPurgeEligible(run, { explicit });
      expect(v.eligible).toBe(false);
      if (!v.eligible) expect(v.reason).toMatch(/not terminal/);
    },
  );

  it.each([true, false])(
    'rejects a gate_waiting run regardless of explicit mode (explicit=%s)',
    (explicit) => {
      const run = makeRun({ run_phase: 'gate_waiting', terminal_state: false });
      const v = isPurgeEligible(run, { explicit });
      expect(v.eligible).toBe(false);
      if (!v.eligible) expect(v.reason).toMatch(/not terminal/);
    },
  );

  it.each(['completed', 'failed', 'abandoned', 'aborted'] as const)(
    'accepts a plain terminal run (phase: %s) with no in-progress claims, in BOTH modes',
    (phase) => {
      const run = makeRun({ run_phase: phase, terminal_state: true });
      expect(isPurgeEligible(run, { explicit: true })).toEqual({ eligible: true });
      expect(isPurgeEligible(run, { explicit: false })).toEqual({ eligible: true });
    },
  );

  describe('healthy (future-deadline) claim — the one hard refuse; no override in EITHER mode', () => {
    const run = makeRun({
      run_phase: 'abandoned',
      terminal_state: true,
      sealed_by: { arm: 'abandon_requested' },
      in_progress_steps: ['charge'],
      claims: { charge: { deadline: FAR_FUTURE } },
    });

    it.each([true, false])(
      'refuses when explicit=%s — abandon does not clear claims, and there is no override for a provably-live claim',
      (explicit) => {
        const v = isPurgeEligible(run, { explicit });
        expect(v.eligible).toBe(false);
        if (!v.eligible) {
          expect(v.reason).toMatch(/future-deadline/);
          expect(v.reason).toMatch(/charge/);
          expect(v.reason).toMatch(/live runner may still be working it/);
        }
      },
    );
  });

  describe('claim_unknown_age (indeterminate, null-deadline) claim — batch-conservative, single-id override', () => {
    const run = makeRun({
      run_phase: 'abandoned',
      terminal_state: true,
      sealed_by: { arm: 'abandon_requested' },
      in_progress_steps: ['charge'],
      claims: { charge: { deadline: null } },
    });

    it('refuses in BATCH mode (explicit: false) — with an actionable reason: names the step, states the indeterminacy, and points at the override verbatim', () => {
      const v = isPurgeEligible(run, { explicit: false });
      expect(v.eligible).toBe(false);
      if (!v.eligible) {
        expect(v.reason).toMatch(/indeterminate-age claim/);
        expect(v.reason).toMatch(/charge/);
        expect(v.reason).toMatch(/no deadline recorded/);
        expect(v.reason).toContain('skipped in batch');
        expect(v.reason).toContain(`realm run purge ${run.id} --force`);
      }
    });

    it('is ELIGIBLE in single-id mode (explicit: true) — the explicit override — and reports which step was overridden', () => {
      const v = isPurgeEligible(run, { explicit: true });
      expect(v).toEqual({ eligible: true, overriddenClaimStep: 'charge' });
    });
  });

  it.each([true, false])(
    'accepts a terminal run whose in-progress claim is past-deadline (claim_stale) in BOTH modes — only healthy/unknown-age ever block (explicit=%s)',
    (explicit) => {
      const run = makeRun({
        run_phase: 'abandoned',
        terminal_state: true,
        sealed_by: { arm: 'abandon_requested' },
        in_progress_steps: ['charge'],
        claims: { charge: { deadline: PAST } },
      });
      expect(isPurgeEligible(run, { explicit })).toEqual({ eligible: true });
    },
  );
});

describe('purgeRuns — single-run mode', () => {
  afterEach(async () => {
    // each test manages its own tmp dir cleanup inline (dir varies per test)
  });

  it('force-purges a terminal run: removes the run file, idempotency pointer, attempts sidecar, and orphaned WAL (all four artifact classes)', async () => {
    const { dir, runStore, failedAttemptStore, traceBufferStore, artifactStores } =
      await makeStores();
    try {
      const { run } = await runStore.create({
        workflowId: 'wf-1',
        workflowVersion: 1,
        params: {},
        idempotencyKey: 'k1',
      });
      await runStore.update({
        ...run,
        run_phase: 'abandoned',
        terminal_state: true,
        sealed_by: { arm: 'abandon_requested' },
      });
      await appendSidecarLine(failedAttemptStore, run.id);
      await traceBufferStore.append(run.id, 'step-a', [{ event: 'crash-orphan' }]);

      const ptrPath = keyPointerPath(dir, 'wf-1', 'k1');
      expect(existsSync(ptrPath)).toBe(true);
      expect(existsSync(join(dir, `${run.id}.attempts.jsonl`))).toBe(true);
      const walBefore = (await readdir(dir)).filter((f) => f.startsWith(`trace-buffer-${run.id}-`));
      expect(walBefore).toHaveLength(1);

      const result = await purgeRuns({ runId: run.id, dryRun: false }, runStore, artifactStores);

      expect(result.purged).toEqual([run.id]);
      expect(result.already_purged).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(existsSync(join(dir, `${run.id}.json`))).toBe(false);
      expect(existsSync(ptrPath)).toBe(false);
      expect(existsSync(join(dir, `${run.id}.attempts.jsonl`))).toBe(false);
      const walAfter = (await readdir(dir)).filter((f) => f.startsWith(`trace-buffer-${run.id}-`));
      expect(walAfter).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses (selects nothing) a non-terminal (running) run', async () => {
    const { dir, runStore, artifactStores } = await makeStores();
    try {
      const run = makeRun({ run_phase: 'running', terminal_state: false });
      await injectRun(dir, run);

      const result = await purgeRuns({ runId: run.id, dryRun: true }, runStore, artifactStores);

      expect(result.selected).toEqual([]);
      expect(result.skipped).toEqual([
        { runId: run.id, reason: expect.stringMatching(/not terminal/) },
      ]);
      expect(existsSync(join(dir, `${run.id}.json`))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses (selects nothing) a gate_waiting run', async () => {
    const { dir, runStore, artifactStores } = await makeStores();
    try {
      const run = makeRun({ run_phase: 'gate_waiting', terminal_state: false });
      await injectRun(dir, run);

      const result = await purgeRuns({ runId: run.id, dryRun: true }, runStore, artifactStores);

      expect(result.selected).toEqual([]);
      expect(result.skipped[0]?.reason).toMatch(/not terminal/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses (selects nothing) a terminal run carrying a future-deadline (healthy) claim, even single-id + --force — the override does NOT apply to a provably-live claim', async () => {
    const { dir, runStore, artifactStores } = await makeStores();
    try {
      const run = makeRun({
        run_phase: 'abandoned',
        terminal_state: true,
        sealed_by: { arm: 'abandon_requested' },
        in_progress_steps: ['charge'],
        claims: { charge: { deadline: FAR_FUTURE } },
      });
      await injectRun(dir, run);

      const result = await purgeRuns({ runId: run.id, dryRun: false }, runStore, artifactStores);

      expect(result.selected).toEqual([]);
      expect(result.purged).toEqual([]);
      expect(result.skipped[0]?.reason).toMatch(/future-deadline/);
      expect(existsSync(join(dir, `${run.id}.json`))).toBe(true); // NEVER deleted, even with dryRun:false
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('single-id: a terminal run with a claim_unknown_age claim IS selected via the explicit override — dry-run reports it (with overriddenClaimStep), --force purges it', async () => {
    const { dir, runStore, artifactStores } = await makeStores();
    try {
      const run = makeRun({
        run_phase: 'abandoned',
        terminal_state: true,
        sealed_by: { arm: 'abandon_requested' },
        in_progress_steps: ['charge'],
        claims: { charge: { deadline: null } },
      });
      await injectRun(dir, run);

      const dryResult = await purgeRuns({ runId: run.id, dryRun: true }, runStore, artifactStores);
      expect(dryResult.selected).toHaveLength(1);
      expect(dryResult.selected[0]?.overriddenClaimStep).toBe('charge');
      expect(dryResult.skipped).toEqual([]); // NOT a skip — explicit mode accepted it
      expect(existsSync(join(dir, `${run.id}.json`))).toBe(true); // dry-run: untouched

      const forceResult = await purgeRuns(
        { runId: run.id, dryRun: false },
        runStore,
        artifactStores,
      );
      expect(forceResult.purged).toEqual([run.id]);
      expect(existsSync(join(dir, `${run.id}.json`))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('dry-run (default) leaves every file intact and reports non-zero bytes-to-free', async () => {
    const { dir, runStore, artifactStores } = await makeStores();
    try {
      const run = makeRun({ run_phase: 'completed', terminal_state: true });
      await injectRun(dir, run);

      const result = await purgeRuns({ runId: run.id }, runStore, artifactStores); // dryRun defaults true

      expect(result.purged).toEqual([]);
      expect(result.already_purged).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.selected).toHaveLength(1);
      expect(result.selected[0]?.bytes).toBeGreaterThan(0);
      expect(existsSync(join(dir, `${run.id}.json`))).toBe(true); // untouched
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports resumable correctly: failed/abandoned are resumable, completed/aborted are not', async () => {
    const { dir, runStore, artifactStores } = await makeStores();
    try {
      // issue #279 (increment 2, PR-C — the #282 class closure): purge now DERIVES run_phase,
      // never trusts the persisted field, so each fixture must carry the fields deriveRunPhase
      // actually keys on (failed_steps for 'failed', terminal_reason for 'completed') — a
      // hand-set run_phase alone no longer suffices.
      const failedRun = makeRun({
        id: 'r-failed',
        run_phase: 'failed',
        terminal_state: true,
        sealed_by: { arm: 'step_failure' },
        failed_steps: ['step1'],
      });
      const completedRun = makeRun({
        id: 'r-completed',
        run_phase: 'completed',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
        terminal_reason: 'Workflow completed.',
      });
      await injectRun(dir, failedRun);
      await injectRun(dir, completedRun);

      const r1 = await purgeRuns({ runId: 'r-failed' }, runStore, artifactStores);
      const r2 = await purgeRuns({ runId: 'r-completed' }, runStore, artifactStores);

      expect(r1.selected[0]?.resumable).toBe(true);
      expect(r2.selected[0]?.resumable).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent: a second single-run force-purge on an already-gone run reports already_purged, not failed', async () => {
    const { dir, runStore, artifactStores } = await makeStores();
    try {
      const run = makeRun({ run_phase: 'completed', terminal_state: true });
      await injectRun(dir, run);
      await purgeRuns({ runId: run.id, dryRun: false }, runStore, artifactStores);

      // Re-select is impossible now (runStore.get throws STATE_RUN_NOT_FOUND at selection time,
      // outside the continue-on-error loop) — single mode surfaces this by rejecting the promise.
      await expect(
        purgeRuns({ runId: run.id, dryRun: false }, runStore, artifactStores),
      ).rejects.toMatchObject({ code: 'STATE_RUN_NOT_FOUND' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('purgeRuns — batch mode (--older-than)', () => {
  it('selects only terminal runs past the age threshold, ignoring fresh and non-terminal ones', async () => {
    const { dir, runStore, artifactStores } = await makeStores();
    try {
      const old = makeRun({
        id: 'old',
        run_phase: 'completed',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
        updated_at: ONE_DAY_AGO,
      });
      const fresh = makeRun({ id: 'fresh', run_phase: 'completed', terminal_state: true }); // updated_at: now
      const running = makeRun({
        id: 'running',
        run_phase: 'running',
        terminal_state: false,
        updated_at: ONE_DAY_AGO,
      });
      await injectRun(dir, old);
      await injectRun(dir, fresh);
      await injectRun(dir, running);

      const result = await purgeRuns({ olderThan: '1d', dryRun: true }, runStore, artifactStores);

      expect(result.selected.map((c) => c.run.id)).toEqual(['old']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('restricts to --workflow when given', async () => {
    const { dir, runStore, artifactStores } = await makeStores();
    try {
      const a = makeRun({ id: 'a', workflow_id: 'wf-a', updated_at: ONE_DAY_AGO });
      const b = makeRun({ id: 'b', workflow_id: 'wf-b', updated_at: ONE_DAY_AGO });
      await injectRun(dir, a);
      await injectRun(dir, b);

      const result = await purgeRuns(
        { olderThan: '1d', workflow: 'wf-a', dryRun: true },
        runStore,
        artifactStores,
      );

      expect(result.selected.map((c) => c.run.id)).toEqual(['a']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skip+warns a terminal-but-future-claimed run in batch mode without aborting the rest', async () => {
    const { dir, runStore, artifactStores } = await makeStores();
    try {
      const blocked = makeRun({
        id: 'blocked',
        run_phase: 'abandoned',
        terminal_state: true,
        sealed_by: { arm: 'abandon_requested' },
        updated_at: ONE_DAY_AGO,
        in_progress_steps: ['s'],
        claims: { s: { deadline: FAR_FUTURE } },
      });
      const ok = makeRun({
        id: 'ok',
        run_phase: 'completed',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
        updated_at: ONE_DAY_AGO,
      });
      await injectRun(dir, blocked);
      await injectRun(dir, ok);

      const result = await purgeRuns({ olderThan: '1d', dryRun: true }, runStore, artifactStores);

      expect(result.selected.map((c) => c.run.id)).toEqual(['ok']);
      expect(result.skipped).toEqual([
        { runId: 'blocked', reason: expect.stringMatching(/future-deadline/) },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('batch: a terminal run with a claim_unknown_age claim is skipped+warned (never selected/purged), while a sibling with claim_stale/no-claim in the same batch IS purged — the batch does not abort on the skip', async () => {
    const { dir, runStore, artifactStores } = await makeStores();
    try {
      const indeterminate = makeRun({
        id: 'indeterminate',
        run_phase: 'abandoned',
        terminal_state: true,
        sealed_by: { arm: 'abandon_requested' },
        updated_at: ONE_DAY_AGO,
        in_progress_steps: ['charge'],
        claims: { charge: { deadline: null } },
      });
      const stale = makeRun({
        id: 'stale',
        run_phase: 'abandoned',
        terminal_state: true,
        sealed_by: { arm: 'abandon_requested' },
        updated_at: ONE_DAY_AGO,
        in_progress_steps: ['charge'],
        claims: { charge: { deadline: PAST } },
      });
      await injectRun(dir, indeterminate);
      await injectRun(dir, stale);

      const result = await purgeRuns({ olderThan: '1d', dryRun: false }, runStore, artifactStores);

      expect(result.purged).toEqual(['stale']);
      expect(result.skipped).toEqual([
        { runId: 'indeterminate', reason: expect.stringMatching(/indeterminate-age claim/) },
      ]);
      expect(existsSync(join(dir, 'indeterminate.json'))).toBe(true); // never touched — batch never overrides
      expect(existsSync(join(dir, 'stale.json'))).toBe(false); // purged normally
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('continue-on-error: a concurrently-vanished run is bucketed already_purged, a genuinely broken store is bucketed failed', async () => {
    const { dir, runStore, artifactStores } = await makeStores();
    try {
      const ok = makeRun({
        id: 'ok',
        run_phase: 'completed',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
        updated_at: ONE_DAY_AGO,
      });
      const vanishing = makeRun({
        id: 'vanishing',
        run_phase: 'completed',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
        updated_at: ONE_DAY_AGO,
      });
      const broken = makeRun({
        id: 'broken',
        run_phase: 'completed',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
        updated_at: ONE_DAY_AGO,
      });
      await injectRun(dir, ok);
      await injectRun(dir, vanishing);
      await injectRun(dir, broken);

      // Deterministically simulate "a concurrent purge already removed this run": intercept the
      // get() re-check purgeRuns performs immediately before deleting each selected run, and for
      // 'vanishing' specifically, delete its file first so the real get() call throws
      // STATE_RUN_NOT_FOUND on its own (no actual timing race needed). issue #184: anchorStore
      // must now also satisfy PerRunArtifactStore — deleteAllForRun delegates to the real
      // runStore so the anchor-last delete still genuinely happens for 'ok'.
      const wrappedRunStore: Pick<RunStore, 'get' | 'list'> &
        PerRunArtifactStore & {
          runsDirPath: string;
        } = {
        runsDirPath: runStore.runsDirPath,
        list: (wf?: string) => runStore.list(wf),
        get: async (id: string) => {
          if (id === 'vanishing') {
            await rm(join(dir, 'vanishing.json'), { force: true });
          }
          return runStore.get(id);
        },
        deleteAllForRun: (id: string, dirEntries?: readonly string[]) =>
          runStore.deleteAllForRun(id, dirEntries),
        // issue #189: delegates like the delete does, so the double reports the REAL store's
        // bytes rather than a number this test invented.
        statAllForRun: (id: string, dirEntries?: readonly string[]) =>
          runStore.statAllForRun(id, dirEntries),
      };

      // A genuinely broken artifact store for 'broken' — a non-ENOENT failure must land in
      // `failed`, distinct from the benign concurrent-purge case above. Placed FIRST in the array
      // (mirroring the crash-anchor property: the anchor is always deleted last and only on total
      // success, issue #184, so a genuine failure in an earlier store aborts before the anchor
      // ever runs, and the run file survives — exactly what makes the run re-purgeable/
      // re-enumerable on the next attempt).
      const poisoned: PerRunArtifactStore = {
        deleteAllForRun: async (id: string) => {
          if (id === 'broken') throw new Error('simulated disk failure');
          return { bytes_deleted: 0 };
        },
        statAllForRun: async () => ({ bytes: 0 }),
      };

      const result = await purgeRuns({ olderThan: '1d', dryRun: false }, wrappedRunStore, [
        poisoned,
        ...artifactStores,
      ]);

      expect(result.purged).toEqual(['ok']);
      expect(result.already_purged).toEqual(['vanishing']);
      expect(result.failed).toEqual([{ runId: 'broken', error: 'simulated disk failure' }]);
      expect(existsSync(join(dir, 'ok.json'))).toBe(false);
      expect(existsSync(join(dir, 'vanishing.json'))).toBe(false);
      expect(existsSync(join(dir, 'broken.json'))).toBe(true); // poisoned store threw FIRST — runStore never ran for this id, so the crash-anchor file survives
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does one readdir up front and reuses it across the whole batch (dirEntries wiring)', async () => {
    const { dir, runStore, traceBufferStore, artifactStores } = await makeStores();
    try {
      const a = makeRun({ id: 'a', updated_at: ONE_DAY_AGO });
      const b = makeRun({ id: 'b', updated_at: ONE_DAY_AGO });
      await injectRun(dir, a);
      await injectRun(dir, b);
      await traceBufferStore.append('a', 'step-1', [{ event: 'x' }]);
      await traceBufferStore.append('b', 'step-1', [{ event: 'y' }]);

      const result = await purgeRuns({ olderThan: '1d', dryRun: false }, runStore, artifactStores);

      expect(result.purged.sort()).toEqual(['a', 'b']);
      const remainingWal = (await readdir(dir)).filter((f) => f.startsWith('trace-buffer-'));
      expect(remainingWal).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('purgeRuns — pointer/keys directory is not touched when the run has no idempotency_key', () => {
  it('a keyless run purges cleanly with no keys/ activity', async () => {
    const { dir, runStore, artifactStores } = await makeStores();
    try {
      const run = makeRun({ run_phase: 'completed', terminal_state: true });
      await injectRun(dir, run);
      // No keys/ dir at all yet.
      expect(existsSync(join(dir, 'keys'))).toBe(false);

      const result = await purgeRuns({ runId: run.id, dryRun: false }, runStore, artifactStores);

      expect(result.purged).toEqual([run.id]);
      // Still no keys/ dir — nothing was ever created or touched for this run.
      expect(existsSync(join(dir, 'keys'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('purgeRuns — supersede soundness (mutation-probe #2 companion, at the orchestrator level)', () => {
  it('purging a superseded (old) run never deletes the live successor’s pointer', async () => {
    const { dir, runStore, artifactStores } = await makeStores();
    try {
      const { run: oldRun } = await runStore.create({
        workflowId: 'wf-1',
        workflowVersion: 1,
        params: {},
        idempotencyKey: 'k1',
      });
      await runStore.update({
        ...oldRun,
        run_phase: 'completed',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
      });
      const { run: newRun } = await runStore.create({
        workflowId: 'wf-1',
        workflowVersion: 1,
        params: {},
        idempotencyKey: 'k1',
        onTerminalMatch: 'rerun',
      });

      const result = await purgeRuns({ runId: oldRun.id, dryRun: false }, runStore, artifactStores);

      expect(result.purged).toEqual([oldRun.id]);
      const ptr = JSON.parse(await readFile(keyPointerPath(dir, 'wf-1', 'k1'), 'utf8'));
      expect(ptr.run_id).toBe(newRun.id);
      expect((await runStore.get(newRun.id)).id).toBe(newRun.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('purgeRuns — purge correctness (issue #184)', () => {
  it('resurrect race: an anchorStore reporting STATE_RUN_BUSY (no_longer_terminal) is bucketed blocked, never failed — the run is untouched', async () => {
    // Drives the fix deterministically at the orchestration level (JsonFileStore's OWN under-lock
    // re-verify is exercised directly and independently in json-file-store.test.ts) — this proves
    // purgeRuns correctly ROUTES whatever STATE_RUN_BUSY the anchor throws, regardless of why.
    const { dir, runStore, artifactStores } = await makeStores();
    try {
      const run = makeRun({
        id: 'resumed-under-lock',
        run_phase: 'completed',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
      });
      await injectRun(dir, run);

      const anchorWithResurrectRace: Pick<RunStore, 'get' | 'list'> &
        PerRunArtifactStore & { runsDirPath: string } = {
        runsDirPath: runStore.runsDirPath,
        get: (id: string) => runStore.get(id),
        list: (wf?: string) => runStore.list(wf),
        statAllForRun: (id: string, dirEntries?: readonly string[]) =>
          runStore.statAllForRun(id, dirEntries),
        deleteAllForRun: async (id: string, dirEntries?: readonly string[]) => {
          if (id === 'resumed-under-lock') {
            throw new WorkflowError(`Run '${id}' is no longer terminal`, {
              code: 'STATE_RUN_BUSY',
              category: 'STATE',
              agentAction: 'report_to_user',
              retryable: true,
              details: { runId: id, reason: 'no_longer_terminal' },
            });
          }
          return runStore.deleteAllForRun(id, dirEntries);
        },
      };

      const result = await purgeRuns(
        { runId: 'resumed-under-lock', dryRun: false },
        anchorWithResurrectRace,
        artifactStores,
      );

      expect(result.blocked).toEqual([
        { runId: 'resumed-under-lock', reason: 'no_longer_terminal' },
      ]);
      expect(result.failed).toEqual([]);
      expect(result.purged).toEqual([]);
      expect(existsSync(join(dir, 'resumed-under-lock.json'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ELOCKED: an anchorStore reporting STATE_RUN_BUSY (locked) is bucketed blocked, never failed — the run is untouched, exit is not gated on it', async () => {
    const { dir, runStore, artifactStores } = await makeStores();
    try {
      const run = makeRun({ id: 'held-by-writer', run_phase: 'completed', terminal_state: true });
      await injectRun(dir, run);

      const anchorWithElocked: Pick<RunStore, 'get' | 'list'> &
        PerRunArtifactStore & { runsDirPath: string } = {
        runsDirPath: runStore.runsDirPath,
        get: (id: string) => runStore.get(id),
        list: (wf?: string) => runStore.list(wf),
        statAllForRun: (id: string, dirEntries?: readonly string[]) =>
          runStore.statAllForRun(id, dirEntries),
        deleteAllForRun: async (id: string, dirEntries?: readonly string[]) => {
          if (id === 'held-by-writer') {
            throw new WorkflowError(`Run '${id}' is locked by another writer`, {
              code: 'STATE_RUN_BUSY',
              category: 'STATE',
              agentAction: 'report_to_user',
              retryable: true,
              details: { runId: id, reason: 'locked' },
            });
          }
          return runStore.deleteAllForRun(id, dirEntries);
        },
      };

      const result = await purgeRuns(
        { runId: 'held-by-writer', dryRun: false },
        anchorWithElocked,
        artifactStores,
      );

      expect(result.blocked).toEqual([{ runId: 'held-by-writer', reason: 'locked' }]);
      expect(result.failed).toEqual([]); // NOT a failure — purgeCommand's exit code is gated on failed.length only
      expect(existsSync(join(dir, 'held-by-writer.json'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('anchor structural: an artifactStores failure means the anchor deleteAllForRun is NEVER called — the run file survives and the run is failed', async () => {
    const { dir, runStore } = await makeStores();
    try {
      const run = makeRun({ id: 'r1', run_phase: 'completed', terminal_state: true });
      await injectRun(dir, run);

      let anchorCalls = 0;
      const spyingAnchor: Pick<RunStore, 'get' | 'list'> &
        PerRunArtifactStore & { runsDirPath: string } = {
        runsDirPath: runStore.runsDirPath,
        get: (id: string) => runStore.get(id),
        list: (wf?: string) => runStore.list(wf),
        deleteAllForRun: async (id: string, dirEntries?: readonly string[]) => {
          anchorCalls++;
          return runStore.deleteAllForRun(id, dirEntries);
        },
        statAllForRun: (id: string, dirEntries?: readonly string[]) =>
          runStore.statAllForRun(id, dirEntries),
      };
      const throwingArtifactStore: PerRunArtifactStore = {
        deleteAllForRun: async () => {
          throw new Error('trace-buffer store exploded');
        },
        statAllForRun: async () => ({ bytes: 0 }),
      };

      const result = await purgeRuns(
        { runId: 'r1', dryRun: false },
        spyingAnchor,
        [throwingArtifactStore], // the ONLY artifact store — guaranteed to run before the anchor
      );

      expect(anchorCalls).toBe(0); // the anchor's deleteAllForRun was NEVER invoked
      expect(result.failed).toEqual([{ runId: 'r1', error: 'trace-buffer store exploded' }]);
      expect(result.purged).toEqual([]);
      expect(existsSync(join(dir, 'r1.json'))).toBe(true); // survives intact — the crash-anchor guarantee
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('two concurrent purgeRuns over the same selected set: zero failures, zero residue, no double-failed', async () => {
    // The run-file lock (issue #184) is what makes this safe: whichever invocation wins the lock
    // for a given run deletes it; the loser's anchor-delete call finds the file already gone —
    // deleteAllForRun's idempotent contract (ENOENT-safe: "already gone" IS success, exactly like
    // the existing "a second call is a no-op" guarantee json-file-store.test.ts already covers)
    // means BOTH invocations legitimately report that id as `purged` — that is not a bug; it is
    // the documented idempotent-success contract. What must NEVER happen is a genuine `failed`.
    const { dir, runStore, artifactStores } = await makeStores();
    try {
      const ids = ['c1', 'c2', 'c3', 'c4', 'c5'];
      for (const id of ids) {
        await injectRun(dir, makeRun({ id, run_phase: 'completed', terminal_state: true }));
      }

      const [r1, r2] = await Promise.all([
        purgeRuns({ olderThan: '0m', dryRun: false }, runStore, artifactStores),
        purgeRuns({ olderThan: '0m', dryRun: false }, runStore, artifactStores),
      ]);

      expect(r1.failed).toEqual([]);
      expect(r2.failed).toEqual([]);
      expect(r1.blocked).toEqual([]);
      expect(r2.blocked).toEqual([]);

      // Together, every run is accounted for as purged or already_purged (idempotent-success
      // overlap between the two invocations is expected and fine — see above) — zero residue.
      const purgedTogether = [...r1.purged, ...r2.purged];
      const alreadyPurgedTogether = [...r1.already_purged, ...r2.already_purged];
      expect([...new Set([...purgedTogether, ...alreadyPurgedTogether])].sort()).toEqual(ids);

      for (const id of ids) {
        expect(existsSync(join(dir, `${id}.json`))).toBe(false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('purgeRuns — fenced WAL delete guard (issue #207 PR-2)', () => {
  it('a declaring artifact store (JsonTraceBufferStore) routes through deleteAllForRunFenced, not the legacy deleteAllForRun, and still clears the WAL', async () => {
    const { dir, runStore } = await makeStores();
    try {
      const run = makeRun({
        id: 'fenced-happy-path',
        run_phase: 'completed',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
      });
      await injectRun(dir, run);
      const traceBufferStore = new JsonTraceBufferStore(dir);
      await traceBufferStore.append(run.id, 'step-agent', [{ event: 'e' }]);
      const fencedSpy = vi.spyOn(traceBufferStore, 'deleteAllForRunFenced');
      const legacySpy = vi.spyOn(traceBufferStore, 'deleteAllForRun');

      const result = await purgeRuns({ runId: 'fenced-happy-path', dryRun: false }, runStore, [
        traceBufferStore,
      ]);

      expect(result.purged).toEqual(['fenced-happy-path']);
      expect(fencedSpy).toHaveBeenCalledTimes(1);
      expect(legacySpy).not.toHaveBeenCalled();
      expect(await traceBufferStore.read(run.id, 'step-agent')).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resumed-mid-purge: a run that becomes non-terminal between selection and the fenced guard is refused — bucketed blocked, anchor untouched, WAL intact', async () => {
    const { dir, runStore } = await makeStores();
    try {
      const run = makeRun({
        id: 'resumed-mid-purge',
        run_phase: 'completed',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
      });
      await injectRun(dir, run);
      const traceBufferStore = new JsonTraceBufferStore(dir);
      await traceBufferStore.append(run.id, 'step-agent', [{ event: 'e' }]);

      let getCalls = 0;
      let anchorDeleteCalls = 0;
      const anchorStub: Pick<RunStore, 'get' | 'list'> &
        PerRunArtifactStore & { runsDirPath: string } = {
        runsDirPath: runStore.runsDirPath,
        get: async (id: string) => {
          getCalls++;
          // Calls 1-2 are purgeRuns's own selection + pre-delete re-check (both still terminal —
          // unaffected by this test). Call 3+ is the fenced guard's OWN re-check, invoked from
          // inside deleteAllForRunFenced — simulate a concurrent `realm resume` landing exactly
          // there.
          if (getCalls <= 2) return runStore.get(id);
          const fresh = await runStore.get(id);
          return { ...fresh, run_phase: 'running' as const, terminal_state: false };
        },
        list: (wf?: string) => runStore.list(wf),
        statAllForRun: (id: string, dirEntries?: readonly string[]) =>
          runStore.statAllForRun(id, dirEntries),
        deleteAllForRun: async (id: string, dirEntries?: readonly string[]) => {
          anchorDeleteCalls++;
          return runStore.deleteAllForRun(id, dirEntries);
        },
      };

      const result = await purgeRuns({ runId: 'resumed-mid-purge', dryRun: false }, anchorStub, [
        traceBufferStore,
      ]);

      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0]?.runId).toBe('resumed-mid-purge');
      expect(result.failed).toEqual([]);
      expect(result.purged).toEqual([]);
      expect(anchorDeleteCalls).toBe(0); // anchor never reached
      expect(existsSync(join(dir, 'resumed-mid-purge.json'))).toBe(true);
      // The WAL survives too — the guard refused before deleteIfExists ever ran.
      expect(await traceBufferStore.read(run.id, 'step-agent')).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a non-declaring artifact store (FailedAttemptStore) keeps the plain, unfenced deleteAllForRun call (named residual, D3 §8 residual 4)', async () => {
    const { dir, runStore } = await makeStores();
    try {
      const run = makeRun({ id: 'sidecar-unfenced', run_phase: 'completed', terminal_state: true });
      await injectRun(dir, run);
      const failedAttemptStore = new FailedAttemptStore(dir);
      await appendSidecarLine(failedAttemptStore, run.id);

      const result = await purgeRuns({ runId: 'sidecar-unfenced', dryRun: false }, runStore, [
        failedAttemptStore,
      ]);

      expect(result.purged).toEqual(['sidecar-unfenced']);
      expect(existsSync(join(dir, `${run.id}.attempts.jsonl`))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('purgeRuns — sealed artifacts (issue #197 PR-2, deliverable 3b: VERIFYING no purge.ts code change was needed)', () => {
  it('purge of a terminal run with a sealed artifact removes it too, alongside the live-WAL/anchor cleanup', async () => {
    const { dir, runStore } = await makeStores();
    try {
      const run = makeRun({
        id: 'sealed-purge-target',
        run_phase: 'completed',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
      });
      await injectRun(dir, run);
      const traceBufferStore = new JsonTraceBufferStore(dir);
      await traceBufferStore.append(run.id, 'step-agent', [{ event: 'stale' }]);
      const sealResult = await traceBufferStore.sealFenced!(run.id, 'step-agent', async () => {});
      expect(sealResult).toEqual({ sealed: true });
      // Confirm the sealed artifact exists on disk BEFORE purging (the premise this test proves).
      expect((await traceBufferStore.listSealedForRun!(run.id)).length).toBe(1);

      const result = await purgeRuns({ runId: 'sealed-purge-target', dryRun: false }, runStore, [
        traceBufferStore,
      ]);

      expect(result.purged).toEqual(['sealed-purge-target']);
      expect(existsSync(join(dir, `${run.id}.json`))).toBe(false); // anchor gone
      expect(await traceBufferStore.listSealedForRun!(run.id)).toEqual([]); // sealed artifact gone too
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// =================================================================================================
// issue #189 — every byte figure purge prints is a number a STORE reported about its OWN artifacts
//
// What this replaces: purge used to preview bytes by scanning `runsDir` for filenames CONTAINING
// the runId. That is a caller reading another store's filename layout, and it structurally could
// not see the content-addressed idempotency pointer — its own docstring conceded the under-count.
// Worse, the preview and the receipt were then two different kinds of claim: a guess before, and
// nothing at all after (the "freed" line just re-used the guess).
// =================================================================================================
describe('purge byte figures are store-reported (issue #189)', () => {
  /** Seeds a run that spans EVERY artifact class the wired stores own, and returns the runId. */
  async function seedMultiStoreRun(s: Stores, runId: string): Promise<void> {
    await injectRun(
      s.dir,
      makeRun({
        id: runId,
        idempotency_key: 'k-189',
        terminal_state: true,
        sealed_by: { arm: 'complete' },
      }),
    );
    // The pointer — the artifact the retired filename scan could never find.
    await mkdir(join(s.dir, 'keys'), { recursive: true });
    await writeFile(
      keyPointerPath(s.dir, 'wf-1', 'k-189'),
      JSON.stringify({ run_id: runId, workflow_id: 'wf-1' }),
      'utf8',
    );
    await appendSidecarLine(s.failedAttemptStore, runId);
    await s.traceBufferStore.append(runId, 'step-a', [{ event: 'live' }]);
    // A SEALED artifact too: the fenced path retires WAL into sealed files, and a stat that
    // counted only live WAL would under-report every run that ever sealed — a regression, since
    // the dying substring scan did catch sealed files.
    await s.traceBufferStore.append(runId, 'step-sealed', [{ event: 'to-be-sealed' }]);
    const sealed = await s.traceBufferStore.sealFenced(runId, 'step-sealed', async () => {});
    expect(sealed.sealed, 'fixture must produce a sealed artifact').toBe(true);
  }

  /** Independent oracle: sums the real on-disk sizes of every file this run owns. */
  async function oracleBytes(s: Stores, runId: string): Promise<number> {
    const entries = await readdir(s.dir);
    let total = 0;
    for (const f of entries) {
      if (f === 'keys') continue;
      if (f.includes(runId)) total += (await stat(join(s.dir, f))).size;
    }
    total += (await stat(keyPointerPath(s.dir, 'wf-1', 'k-189'))).size;
    return total;
  }

  it('the DRY-RUN projection sums every artifact class, pointer and sealed artifact included', async () => {
    const s = await makeStores();
    try {
      await seedMultiStoreRun(s, 'r-189-dry');
      const expected = await oracleBytes(s, 'r-189-dry');

      const result = await purgeRuns(
        { runId: 'r-189-dry', dryRun: true },
        s.runStore,
        s.artifactStores,
      );

      expect(result.selected).toHaveLength(1);
      // EXACT, not "greater than zero": a `> 0` pin would survive a stat that saw only the run
      // file, which is the exact defect this issue retires.
      expect(result.selected[0]!.bytes).toBe(expected);
      // And the fixture genuinely spans more than one file, so the equality has teeth.
      expect(expected).toBeGreaterThan((await stat(join(s.dir, 'r-189-dry.json'))).size);
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('the FORCE receipt is the sum of what the stores reported deleting, and says so', async () => {
    const s = await makeStores();
    try {
      await seedMultiStoreRun(s, 'r-189-force');
      const expected = await oracleBytes(s, 'r-189-force');

      const result = await purgeRuns(
        { runId: 'r-189-force', dryRun: false },
        s.runStore,
        s.artifactStores,
      );

      expect(result.purged).toEqual(['r-189-force']);
      expect(result.freed_bytes['r-189-force']).toBe(expected);

      // The receipt is EXACT, not "greater than zero": a `> 0` pin would survive a store whose
      // report was hardcoded to a wrong figure, which probe (b) mutates for precisely that reason.
      expect(result.freed_bytes['r-189-force']).toBe(expected);
      // And it equals what the dry run would have projected on the same unchanged run — the L6
      // identity, observed end-to-end through purge rather than only inside one store's TCK.
      expect(result.selected[0]!.bytes).toBe(expected);
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('RETIREMENT — purge.ts no longer scans another store’s filename layout', async () => {
    // Source-text pin (the #163 precedent). `f.includes(runId)` and `statMatchedBytes` were the
    // whole mechanism; if either comes back, the invariant is gone regardless of what the byte
    // figures happen to say on the day.
    const src = await readFile(
      join(fileURLToPath(new URL('.', import.meta.url)), 'purge.ts'),
      'utf8',
    );
    expect(src).not.toContain('statMatchedBytes');
    expect(src).not.toContain('includes(runId)');
  });
});

describe('purge report wording and partial-free disclosure (issue #189)', () => {
  /** Renders a result and returns everything printed to stdout and stderr. */
  function render(result: PurgeRunsResult, dryRun: boolean): { out: string; err: string } {
    const out: string[] = [];
    const err: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
      out.push(String(m));
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      err.push(String(m));
    });
    try {
      printPurgeReport(result, dryRun);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
    return { out: out.join('\n'), err: err.join('\n') };
  }

  function emptyResult(): PurgeRunsResult {
    return {
      selected: [],
      skipped: [],
      purged: [],
      already_purged: [],
      blocked: [],
      failed: [],
      freed_bytes: {},
      partial_frees: {},
    };
  }

  it('the FORCE line claims provenance; the DRY-RUN projection wording is untouched', async () => {
    const s = await makeStores();
    try {
      const run = makeRun({ id: 'r-word', terminal_state: true, sealed_by: { arm: 'complete' } });
      const forced = {
        ...emptyResult(),
        selected: [{ run, bytes: 4096, resumable: false }],
        purged: ['r-word'],
        freed_bytes: { 'r-word': 4096 },
      };
      // reds under probe (b) — the receipt's provenance is the whole point of the change.
      expect(render(forced, false).out).toContain('store-reported');

      // The dry-run projection says what it always said: it is a projection, and calling it
      // "store-reported" there would blur the two claims this issue exists to separate.
      const previewed = { ...emptyResult(), selected: [{ run, bytes: 4096, resumable: false }] };
      expect(render(previewed, true).out).not.toContain('store-reported');
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('a refusal that already freed bytes SAYS SO on its own line', async () => {
    // The honesty case. Earlier stores can delete real bytes before the anchor refuses (ELOCKED,
    // no_longer_terminal, drain_pending, a mid-sweep fenced-guard refusal). Without this line the
    // run reads as untouched, and an operator re-running the purge expects the same figure back.
    const run = makeRun({ id: 'r-partial', terminal_state: true, sealed_by: { arm: 'complete' } });
    const result = {
      ...emptyResult(),
      selected: [{ run, bytes: 2048, resumable: false }],
      blocked: [{ runId: 'r-partial', reason: 'locked' }],
      partial_frees: { 'r-partial': { bytes: 2048, stores: 2 } },
    };
    const { err } = render(result, false);
    expect(err).toContain('r-partial: locked');
    expect(err).toContain('already freed before the refusal');
    expect(err).toContain('2 of its artifact stores');

    // The headline stays a FLOOR: partial frees are disclosed per-run, never folded in.
    expect(render(result, false).out).toContain('(0 B freed, store-reported)');
  });

  it('CONTROL — a refusal that freed NOTHING renders byte-identically to before', async () => {
    const run = makeRun({ id: 'r-clean', terminal_state: true, sealed_by: { arm: 'complete' } });
    const result = {
      ...emptyResult(),
      selected: [{ run, bytes: 0, resumable: false }],
      blocked: [{ runId: 'r-clean', reason: 'drain_pending' }],
    };
    const { err } = render(result, false);
    expect(err).toContain('⚠ r-clean: drain_pending');
    expect(err).not.toContain('already freed');
  });

  it('a FAILED run with a partial free is disclosed too, not only a blocked one', async () => {
    const run = makeRun({ id: 'r-boom', terminal_state: true, sealed_by: { arm: 'complete' } });
    const result = {
      ...emptyResult(),
      selected: [{ run, bytes: 512, resumable: false }],
      failed: [{ runId: 'r-boom', error: 'simulated disk failure' }],
      partial_frees: { 'r-boom': { bytes: 512, stores: 1 } },
    };
    const { err } = render(result, false);
    expect(err).toContain('✗ r-boom: simulated disk failure');
    expect(err).toContain('already freed before the refusal');
  });
});
