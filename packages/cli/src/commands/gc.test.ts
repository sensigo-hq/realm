// Tests for sweepOrphans — the pure orphaned-.tmp reaper behind `realm run gc` (issue #160).
//
// Mirrors purge.test.ts's style: the exported LOGIC is tested directly against a real, isolated
// tmp directory (NEVER `~/.realm/runs`) with an injected `now` and real `utimes` backdating — no
// console/exit-code assertions (the command's thin report-formatting layer isn't unit-tested here
// either, consistent with cleanup.ts/reclaim.ts/purge.ts). The CLI wiring itself (--help, a
// non-destructive dry-run, the not-reaped footer) is smoke-tested against the built binary — see
// the implementation report — mirroring how purge.ts's own `.action()` has no dedicated test file.
import { describe, it, expect, vi } from 'vitest';
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  symlink,
  utimes,
  stat,
  chmod,
  readFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  FailedAttemptStore,
  deriveRunPhase,
  atomicWriteFile,
  WorkflowError,
} from '@sensigo/realm';
import type { RunRecord } from '@sensigo/realm';
import { JsonTraceBufferStore } from '@sensigo/realm-mcp';
import { sweepOrphans, sweepOrphanArtifacts, sweepStalePhases, gcExitCode } from './gc.js';
import type {
  SweepOrphansResult,
  OrphanArtifactSweepResult,
  SweepStalePhasesResult,
} from './gc.js';

/** Matches the module-private `FLOOR_MS` in gc.ts (1 hour) — not imported (the reap logic stays
 *  module-private by design; only the pure sweep functions themselves are exported). */
const ONE_HOUR_MS = 3_600_000;
const FIVE_MIN_MS = 5 * 60_000; // margin, chosen in MINUTES per the WSL mtime-granularity trap

async function makeTmpRunsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'gc-test-'));
}

/** Writes a file and backdates its mtime (and atime, for good measure) by `ageMs` relative to
 *  `now`. Uses real `utimes` — no fake timers — so the on-disk mtime genuinely reflects the age. */
async function seedTemp(path: string, now: Date, ageMs: number, content = 'x'): Promise<void> {
  await writeFile(path, content);
  const backdated = new Date(now.getTime() - ageMs);
  await utimes(path, backdated, backdated);
}

describe('sweepOrphans', () => {
  it('boundary: a temp older than the floor by a margin (minutes) IS reaped; one younger by the same margin is NOT', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const now = new Date();
      const oldEnough = join(dir, 'old-run.json.111.0.tmp');
      const tooFresh = join(dir, 'fresh-run.json.222.0.tmp');
      await seedTemp(oldEnough, now, ONE_HOUR_MS + FIVE_MIN_MS);
      await seedTemp(tooFresh, now, ONE_HOUR_MS - FIVE_MIN_MS);

      const result = await sweepOrphans(dir, { olderThanMs: ONE_HOUR_MS, dryRun: false, now });

      expect(result.reaped).toEqual([oldEnough]);
      expect(result.failed).toEqual([]);
      expect(result.already_gone).toEqual([]);
      expect(existsSync(oldEnough)).toBe(false);
      expect(existsSync(tooFresh)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('floor-rejection: a parseable but sub-floor --older-than (59m, 1m) is rejected with the FLOOR message, not a parse error, and reaps nothing', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const now = new Date();
      // Seed a temp that would be trivially eligible if the floor didn't block the call outright.
      const ancient = join(dir, 'ancient-run.json.1.0.tmp');
      await seedTemp(ancient, now, 365 * 24 * ONE_HOUR_MS); // ~1 year old

      const subFloorValuesMs = [59 * 60_000, 1 * 60_000]; // '59m' and '1m' — both parse fine
      for (const olderThanMs of subFloorValuesMs) {
        await expect(sweepOrphans(dir, { olderThanMs, dryRun: false, now })).rejects.toMatchObject({
          message: expect.stringMatching(/at least 1h/),
        });
      }

      // The throw happens before any filesystem access — nothing was ever examined or touched.
      expect(existsSync(ancient)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('floor-rejection error does NOT read like parseDuration\'s "Invalid duration" message', async () => {
    const dir = await makeTmpRunsDir();
    try {
      await expect(
        sweepOrphans(dir, { olderThanMs: 60_000, dryRun: true, now: new Date() }),
      ).rejects.toMatchObject({
        message: expect.not.stringMatching(/Invalid duration/),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recurses into keys/ — a keys/<hash>.json.*.tmp is discovered and reaped (guards the top-level-only-readdir trap)', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const now = new Date();
      await mkdir(join(dir, 'keys'), { recursive: true });
      const keyTemp = join(dir, 'keys', 'deadbeefhash.json.999.0.tmp');
      await seedTemp(keyTemp, now, ONE_HOUR_MS + FIVE_MIN_MS);

      const result = await sweepOrphans(dir, { olderThanMs: ONE_HOUR_MS, dryRun: false, now });

      expect(result.reaped).toEqual([keyTemp]);
      expect(existsSync(keyTemp)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('tolerates a missing keys/ subdirectory entirely (no crash, zero candidates from it)', async () => {
    const dir = await makeTmpRunsDir();
    try {
      // No keys/ dir created at all.
      const result = await sweepOrphans(dir, {
        olderThanMs: ONE_HOUR_MS,
        dryRun: true,
        now: new Date(),
      });
      expect(result).toEqual({ reaped: [], already_gone: [], failed: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('tolerates a missing runsDir entirely (no crash, zero candidates)', async () => {
    const dir = join(await makeTmpRunsDir(), 'does', 'not', 'exist');
    const result = await sweepOrphans(dir, {
      olderThanMs: ONE_HOUR_MS,
      dryRun: true,
      now: new Date(),
    });
    expect(result).toEqual({ reaped: [], already_gone: [], failed: [] });
  });

  it('dry-run-default: leaves every temp intact and reports it in `reaped` (the would-reap list)', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const now = new Date();
      const p = join(dir, 'ancient-run.json.1.0.tmp');
      await seedTemp(p, now, ONE_HOUR_MS + FIVE_MIN_MS, 'some run json content');

      const result = await sweepOrphans(dir, { olderThanMs: ONE_HOUR_MS, dryRun: true, now });

      expect(result.reaped).toEqual([p]);
      expect(result.already_gone).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(existsSync(p)).toBe(true); // untouched
      const info = await stat(p);
      expect(info.size).toBeGreaterThan(0); // still fully intact and statable
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ENOENT-tolerance: a temp vanishing mid-sweep (a concurrent competing sweep) is bucketed already_gone, never failed', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const now = new Date();
      const paths: string[] = [];
      for (let i = 0; i < 12; i++) {
        const p = join(dir, `run-${i}.json.${1000 + i}.0.tmp`);
        await seedTemp(p, now, ONE_HOUR_MS + FIVE_MIN_MS);
        paths.push(p);
      }

      // Race two force-mode sweeps against the SAME candidate set. Both readdir() near-
      // simultaneously (before either has deleted anything), so both see the full set; unlink is
      // atomic at the OS level, so for each file exactly one call's unlink succeeds and the other
      // hits ENOENT (at lstat or unlink time) — which must land in already_gone, never failed.
      const [r1, r2] = await Promise.all([
        sweepOrphans(dir, { olderThanMs: ONE_HOUR_MS, dryRun: false, now }),
        sweepOrphans(dir, { olderThanMs: ONE_HOUR_MS, dryRun: false, now }),
      ]);

      expect(r1.failed).toEqual([]);
      expect(r2.failed).toEqual([]);

      for (const p of paths) {
        expect(existsSync(p)).toBe(false); // reaped by exactly one of the two racing sweeps
      }

      // every file is accounted for in at least one of the two results' reaped/already_gone
      const accountedFor = new Set([
        ...r1.reaped,
        ...r1.already_gone,
        ...r2.reaped,
        ...r2.already_gone,
      ]);
      for (const p of paths) {
        expect(accountedFor.has(p)).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('symlink skip: a symlinked *.tmp is never unlinked or followed, even when it would otherwise be selected', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const target = join(dir, 'real-target.txt');
      await writeFile(target, 'do not touch me');
      const symlinkPath = join(dir, 'sneaky-run.json.1.0.tmp');
      await symlink(target, symlinkPath);

      // Inject a `now` far in the future so a freshly-created symlink would look ancient by age
      // math alone — proving the skip is TYPE-based (isSymbolicLink), not staleness-based.
      const farFutureNow = new Date(Date.now() + 10 * ONE_HOUR_MS);

      const result = await sweepOrphans(dir, {
        olderThanMs: ONE_HOUR_MS,
        dryRun: false,
        now: farFutureNow,
      });

      expect(existsSync(symlinkPath)).toBe(true);
      expect(existsSync(target)).toBe(true);
      expect(result.reaped).toEqual([]);
      expect(result.already_gone).toEqual([]);
      expect(result.failed).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('type-mismatch: a directory unexpectedly named *.tmp is bucketed failed (loud), never silently skipped or ENOENT-swallowed', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const dirPath = join(dir, 'oops-a-directory.json.1.0.tmp');
      await mkdir(dirPath);
      const farFutureNow = new Date(Date.now() + 10 * ONE_HOUR_MS);

      const result = await sweepOrphans(dir, {
        olderThanMs: ONE_HOUR_MS,
        dryRun: false,
        now: farFutureNow,
      });

      expect(result.failed.map((f) => f.path)).toEqual([dirPath]);
      expect(result.reaped).toEqual([]);
      expect(result.already_gone).toEqual([]);
      expect(existsSync(dirPath)).toBe(true); // never touched
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('type-mismatch is surfaced in dry-run too (not deferred until --force)', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const dirPath = join(dir, 'oops-a-directory.json.1.0.tmp');
      await mkdir(dirPath);
      const farFutureNow = new Date(Date.now() + 10 * ONE_HOUR_MS);

      const result = await sweepOrphans(dir, {
        olderThanMs: ONE_HOUR_MS,
        dryRun: true,
        now: farFutureNow,
      });

      expect(result.failed.map((f) => f.path)).toEqual([dirPath]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('future-mtime: a *.tmp whose mtime is after `now` (clock skew) is skipped, never reaped', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const p = join(dir, 'from-the-future.json.1.0.tmp');
      await writeFile(p, 'x');
      const future = new Date(Date.now() + 10 * ONE_HOUR_MS);
      await utimes(p, future, future);
      const now = new Date(); // now is BEFORE the file's own mtime

      const result = await sweepOrphans(dir, { olderThanMs: ONE_HOUR_MS, dryRun: false, now });

      expect(existsSync(p)).toBe(true);
      expect(result.reaped).toEqual([]);
      expect(result.already_gone).toEqual([]);
      expect(result.failed).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores non-.tmp files entirely (a run file, a sidecar, a WAL file all survive untouched)', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const now = new Date();
      const runFile = join(dir, 'some-run.json');
      const sidecar = join(dir, 'some-run.attempts.jsonl');
      const wal = join(dir, 'trace-buffer-some-run-c3RlcA.jsonl');
      for (const p of [runFile, sidecar, wal]) {
        await seedTemp(p, now, 365 * ONE_HOUR_MS); // ancient — would be selected if the glob were wrong
      }

      const result = await sweepOrphans(dir, { olderThanMs: ONE_HOUR_MS, dryRun: false, now });

      expect(result).toEqual({ reaped: [], already_gone: [], failed: [] });
      for (const p of [runFile, sidecar, wal]) {
        expect(existsSync(p)).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// --- sweepOrphanArtifacts — the run-less WAL/sidecar sweep (issue #163) ---
//
// Unlike sweepOrphans above (pure path-list in, path-list out), this sweep's inputs are REAL
// OrphanSweepableStore instances (JsonTraceBufferStore, FailedAttemptStore) plus a REAL
// JsonFileStore for computing `liveRunIds` — mirroring purge.test.ts's convention of testing
// against real stores over a real tmp dir rather than mocks, since the thing actually under test
// (correct runId-by-UUID-length parsing, correct live/orphan classification, the fail-closed
// wiring between listRunIds() and the sweep) lives at the boundary between these real
// implementations, not in any one of them alone.

function walPathFor(dir: string, runId: string, stepId: string): string {
  return join(dir, `trace-buffer-${runId}-${Buffer.from(stepId).toString('base64url')}.jsonl`);
}

function sidecarPathFor(dir: string, runId: string): string {
  return join(dir, `${runId}.attempts.jsonl`);
}

describe('sweepOrphanArtifacts (issue #163)', () => {
  it('a run-less WAL + a run-less sidecar older than the floor are both reaped in --force mode; dry-run lists them first without touching either', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const now = new Date();
      const traceBufferStore = new JsonTraceBufferStore(dir);
      const failedAttemptStore = new FailedAttemptStore(dir);
      const runStore = new JsonFileStore(dir);

      // No run file is ever created for this id — it is run-less from the start.
      const orphanId = '22222222-2222-4222-8222-222222222222';
      await traceBufferStore.append(orphanId, 'step-a', [{ event: 'x' }]);
      await failedAttemptStore.append(orphanId, '{}');

      const walPath = walPathFor(dir, orphanId, 'step-a');
      const sidecarPath = sidecarPathFor(dir, orphanId);
      const backdated = new Date(now.getTime() - (ONE_HOUR_MS + FIVE_MIN_MS));
      await utimes(walPath, backdated, backdated);
      await utimes(sidecarPath, backdated, backdated);

      const liveRunIds = await runStore.listRunIds();
      expect(liveRunIds.has(orphanId)).toBe(false);

      const preview = await sweepOrphanArtifacts(
        [traceBufferStore, failedAttemptStore],
        liveRunIds,
        {
          olderThanMs: ONE_HOUR_MS,
          dryRun: true,
          now,
        },
      );
      expect(preview.reaped.map((e) => e.path).sort()).toEqual([sidecarPath, walPath].sort());
      expect(preview.reaped.every((e) => e.runId === orphanId)).toBe(true);
      expect(existsSync(walPath)).toBe(true); // dry-run never mutates
      expect(existsSync(sidecarPath)).toBe(true);

      const result = await sweepOrphanArtifacts(
        [traceBufferStore, failedAttemptStore],
        liveRunIds,
        {
          olderThanMs: ONE_HOUR_MS,
          dryRun: false,
          now,
        },
      );
      expect(result.reaped.map((e) => e.path).sort()).toEqual([sidecarPath, walPath].sort());
      expect(result.failed).toEqual([]);
      expect(result.already_gone).toEqual([]);
      expect(existsSync(walPath)).toBe(false);
      expect(existsSync(sidecarPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a WAL/sidecar whose run file EXISTS is never reaped, no matter how old', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const now = new Date();
      const traceBufferStore = new JsonTraceBufferStore(dir);
      const failedAttemptStore = new FailedAttemptStore(dir);
      const runStore = new JsonFileStore(dir);

      const { run } = await runStore.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
      await traceBufferStore.append(run.id, 'step-a', [{ event: 'x' }]);
      await failedAttemptStore.append(run.id, '{}');

      const walPath = walPathFor(dir, run.id, 'step-a');
      const sidecarPath = sidecarPathFor(dir, run.id);
      const ancient = new Date(now.getTime() - 365 * ONE_HOUR_MS);
      await utimes(walPath, ancient, ancient);
      await utimes(sidecarPath, ancient, ancient);

      const liveRunIds = await runStore.listRunIds();
      expect(liveRunIds.has(run.id)).toBe(true);

      const result = await sweepOrphanArtifacts(
        [traceBufferStore, failedAttemptStore],
        liveRunIds,
        {
          olderThanMs: ONE_HOUR_MS,
          dryRun: false,
          now,
        },
      );

      expect(result.reaped).toEqual([]);
      expect(existsSync(walPath)).toBe(true);
      expect(existsSync(sidecarPath)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a run-less WAL younger than the floor is NOT reaped — the create-temp-window guard', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const now = new Date();
      const traceBufferStore = new JsonTraceBufferStore(dir);
      const runStore = new JsonFileStore(dir);

      const orphanId = '33333333-3333-4333-8333-333333333333';
      await traceBufferStore.append(orphanId, 'step-a', [{ event: 'x' }]);
      const walPath = walPathFor(dir, orphanId, 'step-a');
      const tooFresh = new Date(now.getTime() - (ONE_HOUR_MS - FIVE_MIN_MS));
      await utimes(walPath, tooFresh, tooFresh);

      const liveRunIds = await runStore.listRunIds();
      const result = await sweepOrphanArtifacts([traceBufferStore], liveRunIds, {
        olderThanMs: ONE_HOUR_MS,
        dryRun: false,
        now,
      });

      expect(result.reaped).toEqual([]);
      expect(existsSync(walPath)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a corrupt-but-present <id>.json still counts as LIVE — its WAL survives (proves listRunIds is basename-only, never JSON.parse-gated)', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const now = new Date();
      const traceBufferStore = new JsonTraceBufferStore(dir);
      const runStore = new JsonFileStore(dir);

      const corruptId = 'deadbeef-dead-4eef-8eef-deadbeefdead';
      await writeFile(join(dir, `${corruptId}.json`), '{ not actually valid json', 'utf8');
      // Sanity: list() (JSON.parse-based) chokes on this file — listRunIds() must not be built on it.
      await expect(runStore.list()).rejects.toThrow();

      await traceBufferStore.append(corruptId, 'step-a', [{ event: 'x' }]);
      const walPath = walPathFor(dir, corruptId, 'step-a');
      const ancient = new Date(now.getTime() - (ONE_HOUR_MS + FIVE_MIN_MS));
      await utimes(walPath, ancient, ancient);

      const liveRunIds = await runStore.listRunIds();
      expect(liveRunIds.has(corruptId)).toBe(true);

      const result = await sweepOrphanArtifacts([traceBufferStore], liveRunIds, {
        olderThanMs: ONE_HOUR_MS,
        dryRun: false,
        now,
      });

      expect(result.reaped).toEqual([]);
      expect(existsSync(walPath)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a step whose base64url-encoded id ends in "-" or "_" is still parsed correctly by exact-length runId slicing — the ambiguous-delimiter case', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const now = new Date();
      const traceBufferStore = new JsonTraceBufferStore(dir);
      const runStore = new JsonFileStore(dir);

      // 'step->' -> base64url 'c3RlcC0-' (ends in '-'); 'step-?' -> 'c3RlcC0_' (ends in '_'). Both
      // are realistic step ids whose encoding could be misparsed by a delimiter-split approach.
      const { run: liveRun } = await runStore.create({
        workflowId: 'wf-1',
        workflowVersion: 1,
        params: {},
      });
      await traceBufferStore.append(liveRun.id, 'step->', [{ event: 'x' }]);
      const liveWalPath = walPathFor(dir, liveRun.id, 'step->');

      const orphanId = '66666666-6666-4666-8666-666666666666';
      await traceBufferStore.append(orphanId, 'step-?', [{ event: 'x' }]);
      const orphanWalPath = walPathFor(dir, orphanId, 'step-?');

      const ancient = new Date(now.getTime() - (ONE_HOUR_MS + FIVE_MIN_MS));
      await utimes(liveWalPath, ancient, ancient);
      await utimes(orphanWalPath, ancient, ancient);

      const liveRunIds = await runStore.listRunIds();
      const result = await sweepOrphanArtifacts([traceBufferStore], liveRunIds, {
        olderThanMs: ONE_HOUR_MS,
        dryRun: false,
        now,
      });

      expect(result.reaped.map((e) => e.path)).toEqual([orphanWalPath]);
      expect(existsSync(liveWalPath)).toBe(true); // the live run's WAL, despite the '-'-ending encoding, survives
      expect(existsSync(orphanWalPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Recomputes the exact on-disk SEALED artifact filename `JsonTraceBufferStore`'s private
 *  `sealedWalPath` uses (issue #197 PR-2) — test-side only, mirroring `walPathFor` above. */
function sealedPathFor(dir: string, runId: string, stepId: string, seq: number): string {
  return join(
    dir,
    `sealed-trace-${runId}-${Buffer.from(stepId).toString('base64url')}.${seq}.jsonl`,
  );
}

describe('sweepOrphanArtifacts — sealed artifacts (issue #197 PR-2, deliverable 3b: VERIFYING no gc.ts code change was needed)', () => {
  it('gc reaps a run-less SEALED artifact older than the floor, in --force mode', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const now = new Date();
      const traceBufferStore = new JsonTraceBufferStore(dir);
      const runStore = new JsonFileStore(dir);

      // No run file is ever created for this id — it is run-less from the start.
      const orphanId = '33333333-3333-4333-8333-333333333333';
      await traceBufferStore.append(orphanId, 'step-a', [{ event: 'x' }]);
      const sealResult = await traceBufferStore.sealFenced!(orphanId, 'step-a', async () => {});
      expect(sealResult).toEqual({ sealed: true });

      const sealedPath = sealedPathFor(dir, orphanId, 'step-a', 0);
      expect(existsSync(sealedPath)).toBe(true);
      const backdated = new Date(now.getTime() - (ONE_HOUR_MS + FIVE_MIN_MS));
      await utimes(sealedPath, backdated, backdated);

      const liveRunIds = await runStore.listRunIds();
      expect(liveRunIds.has(orphanId)).toBe(false);

      const preview = await sweepOrphanArtifacts([traceBufferStore], liveRunIds, {
        olderThanMs: ONE_HOUR_MS,
        dryRun: true,
        now,
      });
      expect(preview.reaped.map((e) => e.path)).toContain(sealedPath);
      expect(existsSync(sealedPath)).toBe(true); // dry-run never mutates

      const result = await sweepOrphanArtifacts([traceBufferStore], liveRunIds, {
        olderThanMs: ONE_HOUR_MS,
        dryRun: false,
        now,
      });

      expect(result.reaped.map((e) => e.path)).toContain(sealedPath);
      expect(result.failed).toEqual([]);
      expect(existsSync(sealedPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a SEALED artifact whose run file EXISTS is never reaped, no matter how old', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const now = new Date();
      const traceBufferStore = new JsonTraceBufferStore(dir);
      const runStore = new JsonFileStore(dir);

      const { run } = await runStore.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
      await traceBufferStore.append(run.id, 'step-a', [{ event: 'x' }]);
      await traceBufferStore.sealFenced!(run.id, 'step-a', async () => {});

      const sealedPath = sealedPathFor(dir, run.id, 'step-a', 0);
      const backdated = new Date(now.getTime() - (ONE_HOUR_MS + FIVE_MIN_MS));
      await utimes(sealedPath, backdated, backdated);

      const liveRunIds = await runStore.listRunIds();
      expect(liveRunIds.has(run.id)).toBe(true);

      const result = await sweepOrphanArtifacts([traceBufferStore], liveRunIds, {
        olderThanMs: ONE_HOUR_MS,
        dryRun: false,
        now,
      });

      expect(result.reaped).toEqual([]);
      expect(existsSync(sealedPath)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('sweepOrphanArtifacts — fenced reap path (issue #207 PR-2)', () => {
  it('orphan swept normally (run absent): routes through deleteAllForRunFenced (not the legacy per-file path) and is reaped', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const now = new Date();
      const traceBufferStore = new JsonTraceBufferStore(dir);
      const runStore = new JsonFileStore(dir);

      const orphanId = '11111111-1111-4111-8111-111111111111';
      await traceBufferStore.append(orphanId, 'step-a', [{ event: 'x' }]);
      const walPath = walPathFor(dir, orphanId, 'step-a');
      const ancient = new Date(now.getTime() - (ONE_HOUR_MS + FIVE_MIN_MS));
      await utimes(walPath, ancient, ancient);

      const fencedSpy = vi.spyOn(traceBufferStore, 'deleteAllForRunFenced');
      const legacySpy = vi.spyOn(traceBufferStore, 'deleteAllForRun');

      const liveRunIds = await runStore.listRunIds();
      const result = await sweepOrphanArtifacts(
        [traceBufferStore],
        liveRunIds,
        { olderThanMs: ONE_HOUR_MS, dryRun: false, now },
        runStore,
      );

      expect(result.reaped.map((e) => e.path)).toEqual([walPath]);
      expect(result.resurrected).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(fencedSpy).toHaveBeenCalledTimes(1);
      expect(legacySpy).not.toHaveBeenCalled();
      expect(existsSync(walPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('floor-sibling scoping: of TWO orphan WALs for the SAME runId, only the one past the floor is reaped — the younger sibling survives (pins the dirEntries grouping against regression, issue #207 correction item 4c)', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const now = new Date();
      const traceBufferStore = new JsonTraceBufferStore(dir);
      const runStore = new JsonFileStore(dir);

      const orphanId = '22222222-3333-4444-8555-666677778888';
      await traceBufferStore.append(orphanId, 'step-old', [{ event: 'old' }]);
      await traceBufferStore.append(orphanId, 'step-young', [{ event: 'young' }]);
      const oldWalPath = walPathFor(dir, orphanId, 'step-old');
      const youngWalPath = walPathFor(dir, orphanId, 'step-young');

      const ancient = new Date(now.getTime() - (ONE_HOUR_MS + FIVE_MIN_MS));
      await utimes(oldWalPath, ancient, ancient);
      const tooFresh = new Date(now.getTime() - (ONE_HOUR_MS - FIVE_MIN_MS));
      await utimes(youngWalPath, tooFresh, tooFresh);

      const liveRunIds = await runStore.listRunIds();
      expect(liveRunIds.has(orphanId)).toBe(false);

      const result = await sweepOrphanArtifacts(
        [traceBufferStore],
        liveRunIds,
        { olderThanMs: ONE_HOUR_MS, dryRun: false, now },
        runStore,
      );

      expect(result.reaped.map((e) => e.path)).toEqual([oldWalPath]);
      expect(result.failed).toEqual([]);
      expect(result.resurrected).toEqual([]);
      expect(existsSync(oldWalPath)).toBe(false); // reaped
      expect(existsSync(youngWalPath)).toBe(true); // survives — too fresh, excluded from dirEntries
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resurrect race: a run re-imported between the sweep snapshot and the reap is SKIPPED (resurrected bucket), never failed — exit code unaffected, file survives', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const now = new Date();
      const traceBufferStore = new JsonTraceBufferStore(dir);
      const runStore = new JsonFileStore(dir);

      // Genuinely run-less at snapshot time (listRunIds below sees it as orphaned)...
      const resurrectedId = '44444444-4444-4444-8444-444444444444';
      await traceBufferStore.append(resurrectedId, 'step-a', [{ event: 'x' }]);
      const walPath = walPathFor(dir, resurrectedId, 'step-a');
      const ancient = new Date(now.getTime() - (ONE_HOUR_MS + FIVE_MIN_MS));
      await utimes(walPath, ancient, ancient);
      const liveRunIds = await runStore.listRunIds();
      expect(liveRunIds.has(resurrectedId)).toBe(false);

      // ...but a save() re-import lands (with that SAME id) before the fenced guard's own read —
      // simulated by writing the run file directly between the snapshot above and the sweep call
      // below (the guard's own runStore.get() runs INSIDE the sweep, after this).
      await runStore.create({
        workflowId: 'wf-1',
        workflowVersion: 1,
        params: {},
      });
      // Force the re-imported run to have the EXACT id the WAL names (create() mints a fresh
      // uuid; overwrite the file directly to land on resurrectedId, mirroring how save() would
      // re-import a specific, already-known id).
      const created = await runStore.list();
      const justCreated = created.find((r) => r.workflow_id === 'wf-1')!;
      await rm(join(dir, `${justCreated.id}.json`));
      await writeFile(
        join(dir, `${resurrectedId}.json`),
        JSON.stringify({ ...justCreated, id: resurrectedId }, null, 2),
        'utf8',
      );

      const result = await sweepOrphanArtifacts(
        [traceBufferStore],
        liveRunIds, // the SNAPSHOT taken before the re-import — still shows resurrectedId absent
        { olderThanMs: ONE_HOUR_MS, dryRun: false, now },
        runStore,
      );

      expect(result.reaped).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.resurrected.map((e) => e.path)).toEqual([walPath]);
      expect(existsSync(walPath)).toBe(true); // the WAL survives — never deleted
      expect(existsSync(join(dir, `${resurrectedId}.json`))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a store without deleteAllForRunFenced (or no runStore supplied) keeps the legacy per-file path — unaffected by the fenced adoption', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const now = new Date();
      const failedAttemptStore = new FailedAttemptStore(dir);
      const runStore = new JsonFileStore(dir);

      const orphanId = '55555555-5555-4555-8555-555555555555';
      await failedAttemptStore.append(orphanId, '{}');
      const sidecarPath = sidecarPathFor(dir, orphanId);
      const ancient = new Date(now.getTime() - (ONE_HOUR_MS + FIVE_MIN_MS));
      await utimes(sidecarPath, ancient, ancient);

      const liveRunIds = await runStore.listRunIds();
      // runStore intentionally OMITTED — the legacy path must still work exactly as before.
      const result = await sweepOrphanArtifacts([failedAttemptStore], liveRunIds, {
        olderThanMs: ONE_HOUR_MS,
        dryRun: false,
        now,
      });

      expect(result.reaped.map((e) => e.path)).toEqual([sidecarPath]);
      expect(result.resurrected).toEqual([]);
      expect(existsSync(sidecarPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('fail-closed wiring: a listRunIds() failure must abort the orphan sweep entirely (issue #163)', () => {
  it('when listRunIds() throws, the CLI-style wiring never even reaches sweepOrphanArtifacts — a live run and a genuine orphan both survive untouched', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const now = new Date();
      const traceBufferStore = new JsonTraceBufferStore(dir);
      const failedAttemptStore = new FailedAttemptStore(dir);
      const runStore = new JsonFileStore(dir);

      // Seed BOTH a live run's WAL and a genuinely run-less orphan, ancient enough that either
      // would be reaped by a correctly-computed sweep — this is what a fabricated empty
      // liveRunIds (the catastrophic bug the mutation-probe below simulates) would wrongly reap.
      const { run } = await runStore.create({ workflowId: 'wf-1', workflowVersion: 1, params: {} });
      await traceBufferStore.append(run.id, 'step-a', [{ event: 'live' }]);
      const liveWalPath = walPathFor(dir, run.id, 'step-a');

      const orphanId = '77777777-7777-4777-8777-777777777777';
      await traceBufferStore.append(orphanId, 'step-a', [{ event: 'orphan' }]);
      const orphanWalPath = walPathFor(dir, orphanId, 'step-a');

      const ancient = new Date(now.getTime() - 365 * ONE_HOUR_MS);
      await utimes(liveWalPath, ancient, ancient);
      await utimes(orphanWalPath, ancient, ancient);

      // Deny read/execute on runsDir itself — readdir() throws EACCES. The files inside are
      // untouched; only LISTING the directory is blocked (never run as root in this repo's CI/dev
      // environment, so this genuinely denies access rather than being silently bypassed).
      await chmod(dir, 0o000);

      let sweepAttempted = false;
      let caughtError: unknown;
      try {
        // Mirrors gc.ts's own action wiring EXACTLY: listRunIds() is awaited FIRST; only on
        // success does the code ever reach sweepOrphanArtifacts. A throw here must propagate
        // out whole — never be swallowed into a fabricated empty set.
        const liveRunIds = await runStore.listRunIds();
        sweepAttempted = true;
        await sweepOrphanArtifacts([traceBufferStore, failedAttemptStore], liveRunIds, {
          olderThanMs: ONE_HOUR_MS,
          dryRun: false,
          now,
        });
      } catch (err) {
        caughtError = err;
      } finally {
        await chmod(dir, 0o700); // restore so afterward cleanup (rm) can actually work
      }

      expect(sweepAttempted).toBe(false); // the sweep call was never even reached
      expect(caughtError).toBeDefined();
      expect((caughtError as NodeJS.ErrnoException).code).toBe('EACCES');

      expect(existsSync(liveWalPath)).toBe(true); // the live run's WAL survives
      expect(existsSync(orphanWalPath)).toBe(true); // the genuine orphan ALSO survives — nothing ran
    } finally {
      await chmod(dir, 0o700).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// --- sweepStalePhases — the grandfathered stale-run_phase heal (issue #293) ---

/**
 * Hand-shapes a #282-class stale-phase run record — terminal ∧ a leftover `pending_gate`, with a
 * STALE persisted `run_phase` ('gate_waiting', the pre-#282-fix mis-derivation — see
 * eligibility.ts's own `deriveRunPhase` doc) that disagrees with what `deriveRunPhase` computes
 * for it TODAY ('completed', since terminal_state is now checked before pending_gate).
 *
 * Written via `atomicWriteFile` DIRECTLY — the exact bytes the store's own write path would
 * produce, but bypassing `store.update()`/`.save()` entirely: BOTH heal `run_phase` at write time
 * (json-file-store.ts's own write tail always re-derives it from the record, discarding whatever
 * the caller passed), so seeding through either would silently persist the CORRECT phase and
 * vacuate every test below.
 *
 * Built from a REAL `store.create()` run (a realistic, fully-populated shape) mutated in memory,
 * never hand-typed field-by-field — mirrors this file's own "resurrect race" test's technique.
 */
async function writeStalePhaseFixture(
  runStore: JsonFileStore,
  dir: string,
): Promise<{ id: string; stale: RunRecord }> {
  const { run } = await runStore.create({ workflowId: 'wf-282', workflowVersion: 1, params: {} });
  const stale: RunRecord = {
    ...run,
    completed_steps: ['a', 'b'],
    terminal_state: true,
    terminal_reason: 'Workflow completed.',
    pending_gate: {
      gate_id: 'zombie',
      step_name: 'a',
      preview: {},
      choices: ['approve'],
      opened_at: '2026-01-01T00:00:00.000Z',
    },
    run_phase: 'gate_waiting', // STALE — pre-#282; deriveRunPhase(this) computes 'completed' today.
  };
  await atomicWriteFile(join(dir, `${run.id}.json`), JSON.stringify(stale, null, 2));
  return { id: run.id, stale };
}

describe('sweepStalePhases (issue #293)', () => {
  it('dry-run LISTS a stale-phase record without writing (mtime/bytes unchanged); a genuinely matching record is never even considered', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const runStore = new JsonFileStore(dir);
      const { id, stale } = await writeStalePhaseFixture(runStore, dir);
      const path = join(dir, `${id}.json`);
      const before = await stat(path);
      const beforeContent = await readFile(path, 'utf8');

      const { run: matching } = await runStore.create({
        workflowId: 'wf-clean',
        workflowVersion: 1,
        params: {},
      });
      const matchingPath = join(dir, `${matching.id}.json`);
      const matchingBefore = await readFile(matchingPath, 'utf8');

      const result = await sweepStalePhases(runStore, { force: false, deriveRunPhase });

      expect(result.would_heal).toEqual([
        { id, persisted_phase: 'gate_waiting', derived_phase: deriveRunPhase(stale) },
      ]);
      expect(result.healed).toEqual([]);
      expect(result.skipped_conflict).toEqual([]);
      expect(result.failed).toEqual([]);

      const after = await stat(path);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(await readFile(path, 'utf8')).toBe(beforeContent);
      expect(await readFile(matchingPath, 'utf8')).toBe(matchingBefore);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--force heals a stale-phase record: persisted == derived after, and every OTHER field is identical except run_phase/version/updated_at', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const runStore = new JsonFileStore(dir);
      const { id, stale } = await writeStalePhaseFixture(runStore, dir);
      const expectedDerived = deriveRunPhase(stale);

      const result = await sweepStalePhases(runStore, { force: true, deriveRunPhase });

      expect(result.healed).toEqual([
        { id, persisted_phase: 'gate_waiting', derived_phase: expectedDerived },
      ]);
      expect(result.would_heal).toEqual([]);
      expect(result.skipped_conflict).toEqual([]);
      expect(result.failed).toEqual([]);

      const healed = JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8')) as RunRecord;
      expect(healed.run_phase).toBe(expectedDerived);
      expect(healed.version).toBe(stale.version + 1);
      expect(healed.updated_at).not.toBe(stale.updated_at);

      // Compare parsed fields: everything identical EXCEPT run_phase/version/updated_at — a
      // byte-diff-minus-two-fields criterion would red against a CORRECT implementation, since
      // the store's write tail rewrites all THREE (json-file-store.ts's update()).
      const { run_phase: _rp1, version: _v1, updated_at: _ua1, ...staleRest } = stale;
      const { run_phase: _rp2, version: _v2, updated_at: _ua2, ...healedRest } = healed;
      expect(healedRest).toEqual(staleRest);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('idempotent: a SECOND --force run finds ZERO mismatches after the first heal', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const runStore = new JsonFileStore(dir);
      await writeStalePhaseFixture(runStore, dir);

      const first = await sweepStalePhases(runStore, { force: true, deriveRunPhase });
      expect(first.healed.length).toBe(1);

      const second = await sweepStalePhases(runStore, { force: true, deriveRunPhase });
      expect(second).toEqual({ healed: [], would_heal: [], skipped_conflict: [], failed: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('matching records are NEVER passed to update() — untouched, byte-identical, across a mixed population', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const runStore = new JsonFileStore(dir);
      const { run: clean1 } = await runStore.create({
        workflowId: 'wf-a',
        workflowVersion: 1,
        params: {},
      });
      const { run: clean2 } = await runStore.create({
        workflowId: 'wf-b',
        workflowVersion: 1,
        params: {},
      });
      await writeStalePhaseFixture(runStore, dir);

      const before1 = await readFile(join(dir, `${clean1.id}.json`), 'utf8');
      const before2 = await readFile(join(dir, `${clean2.id}.json`), 'utf8');

      await sweepStalePhases(runStore, { force: true, deriveRunPhase });

      expect(await readFile(join(dir, `${clean1.id}.json`), 'utf8')).toBe(before1);
      expect(await readFile(join(dir, `${clean2.id}.json`), 'utf8')).toBe(before2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('conflict-skip arm: a version bump between list() and update() is skipped-and-counted, never a crash, never failed', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const runStore = new JsonFileStore(dir);
      const { id, stale } = await writeStalePhaseFixture(runStore, dir);
      const expectedDerived = deriveRunPhase(stale);

      // A wrapping store double simulating the exact race #293's own doc describes: "a live
      // writer got there first — which itself heals." update() is intercepted so that a
      // CONCURRENT write (the live writer's own heal) lands between our list() snapshot and our
      // own update() call, genuinely conflicting on version.
      const racyStore: Pick<JsonFileStore, 'list' | 'update'> = {
        list: () => runStore.list(),
        update: async (record) => {
          await runStore.update({ ...record }); // the concurrent writer's own heal, lands FIRST.
          return runStore.update(record); // OUR call, now genuinely stale — must conflict.
        },
      };

      const result = await sweepStalePhases(racyStore, { force: true, deriveRunPhase });

      expect(result.skipped_conflict).toEqual([
        { id, persisted_phase: 'gate_waiting', derived_phase: expectedDerived },
      ]);
      expect(result.healed).toEqual([]);
      expect(result.failed).toEqual([]);

      // The concurrent writer's own heal already fixed it — retrying would have been pointless.
      const finalRecord = JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8')) as RunRecord;
      expect(finalRecord.run_phase).toBe(expectedDerived);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // --- gc-heal-293 correction, Leg 2: per-conjunct discrimination through the REAL catch —
  // the existing conflict-skip test above only exercises STATE_SNAPSHOT_MISMATCH; these three pin
  // the remaining conjuncts of `err instanceof WorkflowError && (code === SNAPSHOT_MISMATCH ||
  // code === RUN_BUSY)`, each via the SAME wrapping-double idiom (a `Pick<JsonFileStore, 'list' |
  // 'update'>` whose `update()` throws), never a hand-built result object.

  it('non-WorkflowError from update() (e.g. a raw EACCES) lands in `failed`, never `skipped_conflict` — and the REAL result composes into gcExitCode as 1', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const runStore = new JsonFileStore(dir);
      const { id } = await writeStalePhaseFixture(runStore, dir);

      const throwingStore: Pick<JsonFileStore, 'list' | 'update'> = {
        list: () => runStore.list(),
        update: async () => {
          throw new Error('EACCES: permission denied');
        },
      };

      const result = await sweepStalePhases(throwingStore, { force: true, deriveRunPhase });

      expect(result.failed).toEqual([{ id, error: 'EACCES: permission denied' }]);
      expect(result.skipped_conflict).toEqual([]);
      expect(result.healed).toEqual([]);

      // The exit path exercised with a genuine catch product, not a hand-built object.
      expect(gcExitCode(undefined, undefined, undefined, result, undefined)).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a WorkflowError with a FOREIGN code (e.g. STATE_RUN_NOT_FOUND) lands in `failed`, not `skipped_conflict`', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const runStore = new JsonFileStore(dir);
      const { id } = await writeStalePhaseFixture(runStore, dir);

      const throwingStore: Pick<JsonFileStore, 'list' | 'update'> = {
        list: () => runStore.list(),
        update: async () => {
          throw new WorkflowError(`Run '${id}' not found`, {
            code: 'STATE_RUN_NOT_FOUND',
            category: 'STATE',
            agentAction: 'report_to_user',
            retryable: false,
          });
        },
      };

      const result = await sweepStalePhases(throwingStore, { force: true, deriveRunPhase });

      expect(result.failed).toEqual([{ id, error: `Run '${id}' not found` }]);
      expect(result.skipped_conflict).toEqual([]);
      expect(result.healed).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a WorkflowError STATE_RUN_BUSY (ELOCKED) lands in `skipped_conflict` — the conjunct the existing race test never exercised', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const runStore = new JsonFileStore(dir);
      const { id, stale } = await writeStalePhaseFixture(runStore, dir);
      const expectedDerived = deriveRunPhase(stale);

      const throwingStore: Pick<JsonFileStore, 'list' | 'update'> = {
        list: () => runStore.list(),
        update: async () => {
          throw new WorkflowError(`Run '${id}' is locked by another writer`, {
            code: 'STATE_RUN_BUSY',
            category: 'STATE',
            agentAction: 'report_to_user',
            retryable: true,
          });
        },
      };

      const result = await sweepStalePhases(throwingStore, { force: true, deriveRunPhase });

      expect(result.skipped_conflict).toEqual([
        { id, persisted_phase: 'gate_waiting', derived_phase: expectedDerived },
      ]);
      expect(result.failed).toEqual([]);
      expect(result.healed).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('list() throwing (a corrupt run file, #132/#183 fail-closed) aborts the WHOLE heal pass — no per-file salvage', async () => {
    const dir = await makeTmpRunsDir();
    try {
      const runStore = new JsonFileStore(dir);
      await writeStalePhaseFixture(runStore, dir);
      await writeFile(join(dir, 'corrupt.json'), '{ not valid json');

      await expect(sweepStalePhases(runStore, { force: false, deriveRunPhase })).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('gcExitCode (issue #163 exit-code correction)', () => {
  const clean: SweepOrphansResult = { reaped: [], already_gone: [], failed: [] };
  const cleanArtifacts: OrphanArtifactSweepResult = {
    reaped: [],
    already_gone: [],
    failed: [],
    resurrected: [],
  };

  it('all-clean: no temp failures, no artifact failures, no abort → 0', () => {
    expect(gcExitCode(clean, cleanArtifacts, undefined)).toBe(0);
  });

  it('a failed temp unlink → 1', () => {
    const tempResult: SweepOrphansResult = {
      reaped: [],
      already_gone: [],
      failed: [{ path: '/some/path.tmp', error: 'EACCES' }],
    };
    expect(gcExitCode(tempResult, cleanArtifacts, undefined)).toBe(1);
  });

  it('a failed orphan-artifact reap → 1', () => {
    const artifactResult: OrphanArtifactSweepResult = {
      reaped: [],
      already_gone: [],
      failed: [{ path: '/some/wal.jsonl', runId: 'x', error: 'EACCES' }],
      resurrected: [],
    };
    expect(gcExitCode(clean, artifactResult, undefined)).toBe(1);
  });

  it('an aborted orphan sweep (artifactSweepError defined) → 1 — the case that was exit-0 before this correction', () => {
    expect(gcExitCode(clean, undefined, 'EACCES: permission denied')).toBe(1);
  });

  it('an abort ALONGSIDE an otherwise-clean temp sweep and no artifactResult → 1 (the abort dominates)', () => {
    expect(gcExitCode(clean, undefined, 'listRunIds failed')).toBe(1);
  });

  // --- issue #293 extensions: a pass that never ran contributes no failure; heal-specific cells ---
  const cleanHeal: SweepStalePhasesResult = {
    healed: [],
    would_heal: [],
    skipped_conflict: [],
    failed: [],
  };

  it('neither temp/artifact result NOR heal result/error supplied (both undefined) → 0 — a --heal-only run with nothing to report', () => {
    expect(gcExitCode(undefined, undefined, undefined, cleanHeal, undefined)).toBe(0);
  });

  it('a --older-than-only invocation (heal params both undefined) → identical to the pre-#293 signature — 0 when clean', () => {
    expect(gcExitCode(clean, cleanArtifacts, undefined)).toBe(0);
  });

  it('a failed heal write → 1', () => {
    const healResult: SweepStalePhasesResult = {
      healed: [],
      would_heal: [],
      skipped_conflict: [],
      failed: [{ id: 'run-1', error: 'EACCES' }],
    };
    expect(gcExitCode(undefined, undefined, undefined, healResult, undefined)).toBe(1);
  });

  it('an aborted heal sweep (healSweepError defined, no healResult) → 1', () => {
    expect(
      gcExitCode(undefined, undefined, undefined, undefined, 'list() failed: corrupt run file'),
    ).toBe(1);
  });

  it('heal found/healed mismatches with zero failures → 0 (merely finding or healing is not a failure)', () => {
    const healResult: SweepStalePhasesResult = {
      healed: [{ id: 'run-1', persisted_phase: 'gate_waiting', derived_phase: 'completed' }],
      would_heal: [],
      skipped_conflict: [
        { id: 'run-2', persisted_phase: 'gate_waiting', derived_phase: 'completed' },
      ],
      failed: [],
    };
    expect(gcExitCode(undefined, undefined, undefined, healResult, undefined)).toBe(0);
  });

  it('heal failure ALONGSIDE otherwise-clean temp+artifact results → 1 (the heal failure dominates)', () => {
    const healResult: SweepStalePhasesResult = {
      healed: [],
      would_heal: [],
      skipped_conflict: [],
      failed: [{ id: 'run-1', error: 'ELOCKED' }],
    };
    expect(gcExitCode(clean, cleanArtifacts, undefined, healResult, undefined)).toBe(1);
  });
});
