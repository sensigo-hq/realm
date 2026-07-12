// gc command — sweep orphaned atomic-write temps (issue #160, Phase 1: .tmp only).
//
// atomicWriteFile (packages/core/src/store/atomic-write.ts) writes a unique sibling temp
// (`${path}.<pid>.<counter>.tmp`) then POSIX-renames it over the target. A process dying between
// the write and the rename orphans that temp forever — it is not runId-keyed for the key-pointer
// case (`keys/<hash>.json.<pid>.*.tmp`), so `realm run purge` (#107), which acts by runId, can
// never reach it. Temps are invisible to `list()` (no `.json` suffix) but accumulate on disk
// regardless. Windows never produces a temp at all (`atomicWriteFile` falls back to plain
// `writeFile` on win32) — this sweep is a documented no-op there, not a design driver.
//
// Reaping a `.tmp` is unconditionally safe: if the sweep unlinks a temp mid-rename, the pending
// `rename` gets ENOENT, `atomicWriteFile`'s own catch best-effort-unlinks its temp + rethrows — the
// TARGET file is never touched (worst case: a spurious write error surfaces to the writer, never a
// torn file). Combined with the 1h floor below, an in-flight write's temp (age ≪ floor) is never
// even selected.
//
// Phase 1 = `.tmp` only. `.lock` reaping is deliberately split to #164 (deferred — proper-lockfile
// self-heals a live-path lock; only a purged-target's lock lingers, which is negligible). Run-less
// `trace-buffer-*.jsonl` WAL cleanup is #163. Neither is this command's job — see the report footer.
import { readdir, lstat, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { WorkflowError } from '@sensigo/realm';
import { parseDuration } from '../lib/parse-duration.js';

/**
 * Minimum `--older-than` the sweep will ever honor (1 hour) — a conservative floor for hygiene of
 * non-urgent crash residue, and, forward-consistency-wise, the safety guard the deferred `.lock`
 * reaping (#164) will also require; enforcing it here means #164 inherits an already-tested guard.
 * Temps themselves are safe to reap at any age past a few seconds (see the module doc above) — this
 * floor is conservatism, not the temp-safety mechanism. Module-private: the only way to reach a
 * delete is through `sweepOrphans`, which checks this FIRST, before any filesystem access.
 */
const FLOOR_MS = 3_600_000;

export interface SweepOrphansOptions {
  /** Minimum age (ms) a `.tmp` must have to be reaped. Rejected below `FLOOR_MS` — see above. */
  olderThanMs: number;
  /** true (default caller behavior): report only, never unlink. */
  dryRun: boolean;
  /** Injected clock for deterministic age math in tests; defaults to `new Date()`. */
  now?: Date;
}

export interface SweepOrphansResult {
  /** Reaped (force mode) or would-be-reaped (dry-run) `.tmp` paths. */
  reaped: string[];
  /** A candidate vanished on its own (lstat or unlink hit ENOENT) — benign, never a failure. */
  already_gone: string[];
  /** A candidate lstat'd to something other than ENOENT/regular-file/symlink (e.g. a directory
   *  unexpectedly named `*.tmp`), or a genuine unlink error (permissions, I/O). Loud on purpose —
   *  a type mismatch is never silently swallowed, in either dry-run or force mode. */
  failed: Array<{ path: string; error: string }>;
}

/**
 * Every top-level `*.tmp` in `runsDir`, plus one level of recursion into `runsDir/keys/*.tmp` —
 * `keys/` is the ONLY subdirectory any store ever creates in `runsDir` (verified: `JsonFileStore`'s
 * `keysDir()`/`mkdir` calls are the only subdirectory creation anywhere in this codebase's
 * `runsDir` usage). A plain `readdir(runsDir)` sees the `keys` entry itself (no `.json`/`.tmp`
 * suffix, so it's filtered out) but NOT what's inside it — hence the explicit second `readdir`.
 * Nothing else is recursed into; nothing else is globbed (no `*.lock` — that's #164).
 * Tolerates a missing `runsDir` or a missing `keys/` (a fresh install, or one that never wrote a
 * keyed run, legitimately lacks either) — a missing directory yields zero candidates, not a throw.
 */
async function findTempCandidates(runsDir: string): Promise<string[]> {
  const topLevel = await readdir(runsDir).catch(() => [] as string[]);
  const paths = topLevel.filter((f) => f.endsWith('.tmp')).map((f) => join(runsDir, f));

  const keysDir = join(runsDir, 'keys');
  const keysEntries = await readdir(keysDir).catch(() => [] as string[]);
  paths.push(...keysEntries.filter((f) => f.endsWith('.tmp')).map((f) => join(keysDir, f)));

  return paths;
}

/**
 * Reaps orphaned atomic-write `.tmp` files older than `options.olderThanMs`. `FLOOR_MS` is
 * checked FIRST, before any filesystem access, so no caller — CLI action, test, or future
 * consumer — can reach a delete without crossing it.
 *
 * Per-candidate rule (uses `lstat`, never `readdir({ withFileTypes: true })` — on WSL/9p
 * `Dirent.d_type` can be `DT_UNKNOWN`, which would make every type check false and the sweep
 * reap nothing):
 *  - `lstat` ENOENT (vanished before we could even examine it, or during the later `unlink`) →
 *    `already_gone`, in either mode — a benign race, never a failure.
 *  - a **symlink** → skipped silently (appears in no bucket). Never `unlink`ed, never followed.
 *  - anything else that is **not a regular file** (a directory unexpectedly named `*.tmp`, a
 *    socket, …) → `failed`, loud, in either mode — a type mismatch is never an ENOENT-style
 *    silent swallow, because it signals something anomalous in `runsDir` worth surfacing even
 *    from a dry-run.
 *  - a **future mtime** (negative age — clock skew) → skipped silently, never reaped.
 *  - a regular file younger than `olderThanMs` → skipped silently (almost certainly an in-flight
 *    write's temp).
 *  - a regular file older than `olderThanMs` → a reap candidate: in dry-run, its path lands in
 *    `reaped` (interpreted as "would reap") without any filesystem mutation; in force mode, it is
 *    `unlink`ed — success → `reaped`; ENOENT → `already_gone`; anything else → `failed`.
 */
export async function sweepOrphans(
  runsDir: string,
  options: SweepOrphansOptions,
): Promise<SweepOrphansResult> {
  if (options.olderThanMs < FLOOR_MS) {
    throw new WorkflowError(
      `--older-than must resolve to at least 1h (got ${options.olderThanMs}ms) — gc refuses to ` +
        `reap crash residue younger than that, even with --force.`,
      {
        code: 'VALIDATION_INPUT_SCHEMA',
        category: 'VALIDATION',
        agentAction: 'provide_input',
        retryable: false,
        details: { olderThanMs: options.olderThanMs, floorMs: FLOOR_MS },
      },
    );
  }

  const now = options.now ?? new Date();
  const candidatePaths = await findTempCandidates(runsDir);

  const result: SweepOrphansResult = { reaped: [], already_gone: [], failed: [] };
  const toReap: string[] = [];

  for (const path of candidatePaths) {
    let info;
    try {
      info = await lstat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        result.already_gone.push(path); // vanished between readdir and lstat
      } else {
        result.failed.push({ path, error: err instanceof Error ? err.message : String(err) });
      }
      continue;
    }

    if (info.isSymbolicLink()) continue; // never unlink or follow a symlink — silent skip

    if (!info.isFile()) {
      result.failed.push({
        path,
        error: 'expected a regular file but found a different type (unexpected for a *.tmp name)',
      });
      continue;
    }

    const ageMs = now.getTime() - info.mtime.getTime();
    if (ageMs < 0) continue; // future mtime (clock skew) — skip, never reap
    if (ageMs <= options.olderThanMs) continue; // too fresh — most likely an in-flight write's temp

    toReap.push(path);
  }

  if (options.dryRun) {
    result.reaped = toReap;
    return result;
  }

  for (const path of toReap) {
    try {
      await unlink(path);
      result.reaped.push(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        result.already_gone.push(path); // vanished between lstat and unlink
      } else {
        result.failed.push({ path, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return result;
}

/** Best-effort total bytes for a known list of paths — reporting-only, never gates reaping.
 *  Called against a fresh dry-run preview, so the paths are still on disk when stat'd. */
async function statPathBytes(paths: readonly string[]): Promise<number> {
  let total = 0;
  await Promise.all(
    paths.map(async (p) => {
      try {
        const info = await stat(p);
        total += info.size;
      } catch {
        // vanished between the preview pass and this stat — best-effort, ignore.
      }
    }),
  );
  return total;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** So an operator doesn't distrust the tool when `runsDir` still holds residue gc deliberately
 *  does not touch — printed on every report, dry-run or force, empty or not. */
const NOT_REAPED_FOOTER =
  'gc does NOT reap orphaned .lock dirs (deferred — issue #164) or run-less trace-buffer-*.jsonl ' +
  'WAL files (issue #163). Their presence in runsDir is expected and not a sign gc is broken.';

/** Prints the dry-run / force report shared by both code paths. `previewBytes` always comes from
 *  the initial (always non-destructive) preview pass — see the action below for why. */
function printGcReport(result: SweepOrphansResult, previewBytes: number, dryRun: boolean): void {
  const nothingToReport =
    result.reaped.length === 0 && result.already_gone.length === 0 && result.failed.length === 0;

  if (nothingToReport) {
    console.log('No orphaned .tmp files found to reap.');
  } else if (dryRun) {
    console.log(
      `${result.reaped.length} orphaned .tmp file(s) WOULD be reaped (${formatBytes(previewBytes)} to free):`,
    );
    for (const p of result.reaped) console.log(`  • ${p}`);
    if (result.already_gone.length > 0) {
      console.log(`(${result.already_gone.length} candidate(s) already vanished on their own.)`);
    }
  } else {
    console.log(
      `Reaped ${result.reaped.length} orphaned .tmp file(s) (${formatBytes(previewBytes)} freed). ` +
        `${result.already_gone.length} already gone, ${result.failed.length} failed.`,
    );
  }

  for (const f of result.failed) {
    console.error(`  ✗ ${f.path}: ${f.error}`);
  }
  if (dryRun && !nothingToReport) {
    console.log('\nRe-run with --force to actually delete.');
  }
  console.log(`\n${NOT_REAPED_FOOTER}`);
}

export const gcCommand = new Command('gc')
  .description(
    'Sweep orphaned atomic-write .tmp files — crash residue from a process that died mid-write (dry-run by default)',
  )
  .requiredOption(
    '--older-than <duration>',
    'Reap temps idle at least this long (minimum 1h; e.g. 1h, 6h, 30d)',
  )
  .option('--force', 'Actually delete (without this, gc only reports what WOULD be reaped)')
  .action(async (opts: { olderThan: string; force?: boolean }) => {
    let olderThanMs: number;
    try {
      olderThanMs = parseDuration(opts.olderThan);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
      return;
    }

    // Defense-in-depth over sweepOrphans's own floor check — reject before touching the
    // filesystem at all, with a CLI-friendly message naming the flag the operator just typed.
    if (olderThanMs < FLOOR_MS) {
      console.error(
        `--older-than must be at least 1h (got '${opts.olderThan}'). gc refuses to reap crash ` +
          `residue younger than that, even with --force.`,
      );
      process.exit(1);
      return;
    }

    const { JsonFileStore } = await import('@sensigo/realm');
    const runsDir = new JsonFileStore().runsDirPath;
    const now = new Date();

    try {
      // Always preview first — this NEVER mutates, in either mode — because it is the only
      // reliable moment to `stat()` the candidates for the report's byte total: a force-mode
      // reap deletes the files before sweepOrphans returns, so statting them afterward is
      // impossible. The preview and the (optional) real pass share the same olderThanMs/now, so
      // the candidate set is consistent bar a narrow, benign concurrent-activity window — which
      // already_gone exists to absorb.
      const preview = await sweepOrphans(runsDir, { olderThanMs, dryRun: true, now });
      const bytes = await statPathBytes(preview.reaped);

      if (opts.force !== true) {
        printGcReport(preview, bytes, true);
        return;
      }

      const result = await sweepOrphans(runsDir, { olderThanMs, dryRun: false, now });
      printGcReport(result, bytes, false);
      if (result.failed.length > 0) process.exit(1);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
