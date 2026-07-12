// Tests for sweepOrphans — the pure orphaned-.tmp reaper behind `realm run gc` (issue #160).
//
// Mirrors purge.test.ts's style: the exported LOGIC is tested directly against a real, isolated
// tmp directory (NEVER `~/.realm/runs`) with an injected `now` and real `utimes` backdating — no
// console/exit-code assertions (the command's thin report-formatting layer isn't unit-tested here
// either, consistent with cleanup.ts/reclaim.ts/purge.ts). The CLI wiring itself (--help, a
// non-destructive dry-run, the not-reaped footer) is smoke-tested against the built binary — see
// the implementation report — mirroring how purge.ts's own `.action()` has no dedicated test file.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, symlink, utimes, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepOrphans } from './gc.js';

/** Matches the module-private `FLOOR_MS` in gc.ts (1 hour) — not imported (sweepOrphans is the
 *  ONLY export; the floor is enforced inside it, per the design's "reap logic module-private"). */
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
