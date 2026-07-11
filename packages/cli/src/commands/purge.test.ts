// Tests for purge.ts — the operator-invoked run-purge primitive (issue #107).
//
// Mirrors cleanup.test.ts's style: the exported LOGIC (isPurgeEligible, purgeRuns) is tested
// directly against real stores over a real tmp directory — no console/exit-code assertions (that
// thin formatting layer isn't unit-tested here either, consistent with cleanup.ts/reclaim.ts).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { isPurgeEligible, purgeRuns } from './purge.js';
import {
  JsonFileStore,
  FailedAttemptStore,
  buildFailedAttemptRecord,
  serializeFailedAttemptLine,
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
    artifactStores: [traceBufferStore, failedAttemptStore, runStore],
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
  await store.append(runId, serializeFailedAttemptLine(rec).line);
}

const ONE_DAY_AGO = new Date(Date.now() - 2 * 86_400_000).toISOString();
const FAR_FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const PAST = new Date(Date.now() - 3_600_000).toISOString();

describe('isPurgeEligible (the purge selection predicate)', () => {
  it('rejects a non-terminal (running) run', () => {
    const run = makeRun({ run_phase: 'running', terminal_state: false });
    const v = isPurgeEligible(run);
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.reason).toMatch(/not terminal/);
  });

  it('rejects a gate_waiting run', () => {
    const run = makeRun({ run_phase: 'gate_waiting', terminal_state: false });
    const v = isPurgeEligible(run);
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.reason).toMatch(/not terminal/);
  });

  it.each(['completed', 'failed', 'abandoned', 'aborted'] as const)(
    'accepts a plain terminal run (phase: %s) with no in-progress claims',
    (phase) => {
      const run = makeRun({ run_phase: phase, terminal_state: true });
      expect(isPurgeEligible(run)).toEqual({ eligible: true });
    },
  );

  it('rejects a terminal run carrying a future-deadline ("healthy") claim — abandon does not clear claims', () => {
    const run = makeRun({
      run_phase: 'abandoned',
      terminal_state: true,
      in_progress_steps: ['charge'],
      claims: { charge: { deadline: FAR_FUTURE } },
    });
    const v = isPurgeEligible(run);
    expect(v.eligible).toBe(false);
    if (!v.eligible) {
      expect(v.reason).toMatch(/future-deadline/);
      expect(v.reason).toMatch(/charge/);
    }
  });

  it('accepts a terminal run whose in-progress claim is past-deadline (claim_stale) — only a future deadline blocks', () => {
    const run = makeRun({
      run_phase: 'abandoned',
      terminal_state: true,
      in_progress_steps: ['charge'],
      claims: { charge: { deadline: PAST } },
    });
    expect(isPurgeEligible(run)).toEqual({ eligible: true });
  });

  it('accepts a terminal run whose in-progress claim has no deadline (claim_unknown_age) — indeterminate, not "future"', () => {
    const run = makeRun({
      run_phase: 'abandoned',
      terminal_state: true,
      in_progress_steps: ['charge'],
      claims: { charge: { deadline: null } },
    });
    expect(isPurgeEligible(run)).toEqual({ eligible: true });
  });
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
      await runStore.update({ ...run, run_phase: 'abandoned', terminal_state: true });
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

  it('refuses (selects nothing) a terminal run carrying a future-deadline claim — skip+warn, never deleted', async () => {
    const { dir, runStore, artifactStores } = await makeStores();
    try {
      const run = makeRun({
        run_phase: 'abandoned',
        terminal_state: true,
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
      const failedRun = makeRun({ id: 'r-failed', run_phase: 'failed', terminal_state: true });
      const completedRun = makeRun({
        id: 'r-completed',
        run_phase: 'completed',
        terminal_state: true,
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
        updated_at: ONE_DAY_AGO,
        in_progress_steps: ['s'],
        claims: { s: { deadline: FAR_FUTURE } },
      });
      const ok = makeRun({
        id: 'ok',
        run_phase: 'completed',
        terminal_state: true,
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

  it('continue-on-error: a concurrently-vanished run is bucketed already_purged, a genuinely broken store is bucketed failed', async () => {
    const { dir, runStore, artifactStores } = await makeStores();
    try {
      const ok = makeRun({
        id: 'ok',
        run_phase: 'completed',
        terminal_state: true,
        updated_at: ONE_DAY_AGO,
      });
      const vanishing = makeRun({
        id: 'vanishing',
        run_phase: 'completed',
        terminal_state: true,
        updated_at: ONE_DAY_AGO,
      });
      const broken = makeRun({
        id: 'broken',
        run_phase: 'completed',
        terminal_state: true,
        updated_at: ONE_DAY_AGO,
      });
      await injectRun(dir, ok);
      await injectRun(dir, vanishing);
      await injectRun(dir, broken);

      // Deterministically simulate "a concurrent purge already removed this run": intercept the
      // get() re-check purgeRuns performs immediately before deleting each selected run, and for
      // 'vanishing' specifically, delete its file first so the real get() call throws
      // STATE_RUN_NOT_FOUND on its own (no actual timing race needed).
      const wrappedRunStore: Pick<RunStore, 'get' | 'list'> & { runsDirPath: string } = {
        runsDirPath: runStore.runsDirPath,
        list: (wf?: string) => runStore.list(wf),
        get: async (id: string) => {
          if (id === 'vanishing') {
            await rm(join(dir, 'vanishing.json'), { force: true });
          }
          return runStore.get(id);
        },
      };

      // A genuinely broken artifact store for 'broken' — a non-ENOENT failure must land in
      // `failed`, distinct from the benign concurrent-purge case above. Placed FIRST in the array
      // (mirroring the crash-anchor property: runStore is always last in production, so a genuine
      // failure in an earlier store aborts before runStore ever runs, and the run file survives —
      // exactly what makes the run re-purgeable/re-enumerable on the next attempt).
      const poisoned: PerRunArtifactStore = {
        deleteAllForRun: async (id: string) => {
          if (id === 'broken') throw new Error('simulated disk failure');
        },
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
      await runStore.update({ ...oldRun, run_phase: 'completed', terminal_state: true });
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
