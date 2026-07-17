// json-trace-buffer-store.ts — File-based TraceBufferStore using JSONL WAL files.
import { existsSync } from 'node:fs';
import { appendFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import {
  type TraceBufferStore,
  type BufferedEntry,
  type AppendResult,
  type PerRunArtifactStore,
  type OrphanSweepableStore,
  type OrphanArtifact,
  normalizeEntryForBuffer,
  BUFFER_LIMIT_COUNT,
  BUFFER_LIMIT_BYTES,
  FINAL_LIMIT_ENTRIES,
  FINAL_LIMIT_BYTES,
  readIfExists,
  deleteIfExists,
  statIfExists,
  toArtifactDeleteFailedError,
  FsIoError,
} from '@sensigo/realm';
import type { AgentTraceEntry } from '@sensigo/realm';
import { WorkflowError } from '@sensigo/realm';

/** Line format stored in the JSONL WAL file. */
interface WalLine {
  ts: number;
  entries: AgentTraceEntry[];
}

/** WAL filename shape: `trace-buffer-<runId>-<base64url(stepId)>.jsonl`. `runId` is a
 *  server-generated UUIDv4 — always exactly 36 characters (8-4-4-4-12 hex, RFC 4122 string
 *  form) — so it can be recovered by FIXED-LENGTH slicing rather than splitting on `-`, which
 *  would break the moment a base64url step segment itself contains `-` or `_` (both are valid
 *  base64url alphabet characters). See `listOrphans` below for where this matters (issue #163). */
const WAL_PREFIX = 'trace-buffer-';
const WAL_SUFFIX = '.jsonl';
const RUN_ID_LENGTH = 36;

/** A `proper-lockfile` retry policy: either a bare retry count (its own simple default backoff)
 *  or an explicit `retry`-module-compatible options object. */
type LockRetries = number | { retries: number; minTimeout?: number; maxTimeout?: number };

/** Lock-acquisition profile shared by every `lockWal` call in this file (issue #207).
 *  Constructor-injectable so a conformance suite can inflate the retry budget (e.g. to make a
 *  deliberately slow/latched guard's lock contention observable instead of exhausting the retry
 *  budget too quickly and masking the scenario under test). */
export interface TraceBufferLockProfile {
  retries: LockRetries;
  stale: number;
  realpath: boolean;
}

/** Default profile: ~4s worst-case budget (6 retries, 50ms→1000ms exponential backoff) —
 *  outlasts any legitimate millisecond-scale critical section by orders of magnitude, but never
 *  hangs an engine path for minutes on genuine contention. */
const DEFAULT_LOCK_PROFILE: TraceBufferLockProfile = {
  retries: { retries: 6, minTimeout: 50, maxTimeout: 1000 },
  stale: 5000,
  realpath: false,
};

/** `append`/`appendFenced` keep the pre-existing, more patient retry count (today's shipped
 *  behavior, unchanged) — appends are the highest-frequency, most latency-sensitive operation. */
const APPEND_RETRIES = 10;

/** True iff `err` is `proper-lockfile`'s own lock-contention error (retry budget exhausted). */
function isLockContentionError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ELOCKED';
}

/** Classifies a lock-acquisition failure as `STATE_RUN_BUSY` (issue #207) — the same code/
 *  category/agentAction/retryable convention `JsonFileStore`'s own `runBusyError` uses for the
 *  analogous run-file-lock-contention case. Retryable: a live holder self-heals (the lock is
 *  released), and a genuinely stale lock is eventually stolen by the next contender. */
function lockBusyError(walPath: string): WorkflowError {
  return new WorkflowError(
    `Could not acquire the trace-buffer lock for '${walPath}' — contention exceeded the retry budget`,
    {
      code: 'STATE_RUN_BUSY',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: true,
      details: { walPath },
    },
  );
}

/**
 * File-based TraceBufferStore that persists WAL entries to JSONL files on disk.
 * WAL file path: <runsDir>/trace-buffer-<runId>-<base64url(stepId)>.jsonl
 *
 * Crash model: like `JsonFileStore`, this store never calls `fsync` — process-crash consistency
 * comes from `appendFile`'s per-line granularity plus `readWal`'s per-line, torn-line-tolerant
 * parsing (a crash mid-write can leave one unparseable trailing line, which is skipped; every
 * earlier, already-written line survives intact). Durability across a true power loss (not just a
 * process crash) is outside this store's contract, unchanged from its pre-#207 posture.
 *
 * Declares the fenced trio (issue #207): `read`, `delete`, and `deleteAllForRun` now serialize on
 * the SAME per-(runId, stepId) critical section (a `proper-lockfile` lock on the WAL path)
 * `appendFenced`/`deleteFenced`/`deleteAllForRunFenced` use — see `lockWal` and the interface's
 * own doc for the full contract.
 */
export class JsonTraceBufferStore
  implements TraceBufferStore, PerRunArtifactStore, OrphanSweepableStore
{
  private readonly runsDir: string;
  private readonly lockProfile: TraceBufferLockProfile;

  constructor(runsDir: string, lockProfile?: Partial<TraceBufferLockProfile>) {
    this.runsDir = runsDir;
    this.lockProfile = { ...DEFAULT_LOCK_PROFILE, ...lockProfile };
  }

  private walPath(runId: string, stepId: string): string {
    const safeStepId = Buffer.from(stepId).toString('base64url');
    return join(this.runsDir, `trace-buffer-${runId}-${safeStepId}.jsonl`);
  }

  /**
   * The SOLE `lockfile.lock(` call site in this file (issue #207) — every critical-section
   * acquisition (`append`, `appendFenced`, `read`, `delete`, `deleteFenced`, `deleteAllForRun`,
   * `deleteAllForRunFenced`) goes through this one chokepoint. Pins the shared base options
   * (`stale`/`realpath`) and always installs an explicit `onCompromised` handler — a loud
   * `console.warn` naming the WAL path — never `proper-lockfile`'s own default handler, which
   * THROWS from inside a timer callback and crashes the process. `retriesOverride` lets
   * `append`/`appendFenced` keep their own, more patient retry count; every other caller uses
   * this store's configured `lockProfile.retries` (constructor-injectable — e.g. a conformance
   * suite inflating it to make contention observable rather than exhausted-too-fast).
   *
   * Verified (issue #207): `lockfile.lock(path, { realpath: false })` acquires cleanly against a
   * path that does not yet exist — no pre-lock placeholder file is needed for that. `append()`'s
   * own placeholder-creation below predates this and stays byte-identical for that method, but no
   * fenced method replicates it.
   */
  private async lockWal(
    walPath: string,
    retriesOverride?: LockRetries,
  ): Promise<() => Promise<void>> {
    return lockfile.lock(walPath, {
      retries: retriesOverride ?? this.lockProfile.retries,
      stale: this.lockProfile.stale,
      realpath: this.lockProfile.realpath,
      onCompromised: (err) => {
        console.warn(
          `[JsonTraceBufferStore] lock compromised for '${walPath}': ${err.message} — a stale ` +
            'lock was stolen; this is the accepted cost of tokenless mutual exclusion (issue ' +
            '#207 residual 1), never a silent crash',
        );
      },
    });
  }

  private async readWal(
    walPath: string,
  ): Promise<{ count: number; bytes: number; lines: WalLine[] }> {
    // issue #183: readIfExists distinguishes absence (undefined → empty, the pre-existing
    // behavior) from a genuine I/O failure (now propagates). The old whole-buffer catch treated
    // BOTH a real I/O failure AND a single torn/partial line (e.g. a crash mid-appendFile — the
    // abandoned-agent scenario) as "corrupted WAL, discard everything" — losing every earlier,
    // perfectly good line to one partial write. Per-line parsing below (mirroring
    // readAllForRun's discipline) skips only the bad line and keeps the rest.
    const content = await readIfExists(walPath);
    if (content === undefined) {
      return { count: 0, bytes: 0, lines: [] };
    }

    const lines: WalLine[] = [];
    for (const raw of content.split('\n')) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      try {
        lines.push(JSON.parse(trimmed) as WalLine);
      } catch {
        console.warn(`⚠ realm: skipping unparseable trace-buffer WAL line in '${walPath}'`);
      }
    }
    const count = lines.reduce((acc, l) => acc + l.entries.length, 0);
    const bytes = Buffer.byteLength(content);
    return { count, bytes, lines };
  }

  /**
   * The actual write logic, shared by `append` and `appendFenced` (issue #207) so BUFFER_FULL /
   * normalization / `AppendResult` shape live in exactly one place. Assumes the caller already
   * holds the per-path critical section.
   */
  private async appendWithinCS(walPath: string, entries: AgentTraceEntry[]): Promise<AppendResult> {
    const { count: existingCount, bytes: existingBytes } = await this.readWal(walPath);

    const normalized = entries
      .map((e) => normalizeEntryForBuffer(e))
      .filter((e): e is AgentTraceEntry => e !== null);

    if (normalized.length === 0) {
      return {
        buffer_count: existingCount,
        buffer_bytes: existingBytes,
        limit_count: BUFFER_LIMIT_COUNT,
        limit_bytes: BUFFER_LIMIT_BYTES,
        final_limit_entries: FINAL_LIMIT_ENTRIES,
        final_limit_bytes: FINAL_LIMIT_BYTES,
      };
    }

    const newLine = JSON.stringify({ ts: Date.now(), entries: normalized });
    const newBytes = Buffer.byteLength(newLine + '\n');

    if (
      existingCount + normalized.length > BUFFER_LIMIT_COUNT ||
      existingBytes + newBytes > BUFFER_LIMIT_BYTES
    ) {
      throw new WorkflowError('Trace buffer full for step', {
        code: 'BUFFER_FULL',
        category: 'ENGINE',
        agentAction: 'provide_input',
        retryable: false,
        details: { buffer_count: existingCount, buffer_bytes: existingBytes },
      });
    }

    await appendFile(walPath, newLine + '\n', 'utf8');

    const updatedCount = existingCount + normalized.length;
    const updatedBytes = existingBytes + newBytes;
    return {
      buffer_count: updatedCount,
      buffer_bytes: updatedBytes,
      limit_count: BUFFER_LIMIT_COUNT,
      limit_bytes: BUFFER_LIMIT_BYTES,
      final_limit_entries: FINAL_LIMIT_ENTRIES,
      final_limit_bytes: FINAL_LIMIT_BYTES,
    };
  }

  async append(runId: string, stepId: string, entries: AgentTraceEntry[]): Promise<AppendResult> {
    const walPath = this.walPath(runId, stepId);

    if (entries.length === 0) {
      const { count, bytes } = await this.readWal(walPath);
      return {
        buffer_count: count,
        buffer_bytes: bytes,
        limit_count: BUFFER_LIMIT_COUNT,
        limit_bytes: BUFFER_LIMIT_BYTES,
        final_limit_entries: FINAL_LIMIT_ENTRIES,
        final_limit_bytes: FINAL_LIMIT_BYTES,
      };
    }

    // Acquire lock (realpath: false because file may not yet exist).
    // Create a placeholder file if needed so proper-lockfile has a target.
    if (!existsSync(walPath)) {
      await appendFile(walPath, '');
    }

    let release: (() => Promise<void>) | undefined;
    try {
      release = await this.lockWal(walPath, APPEND_RETRIES);
      return await this.appendWithinCS(walPath, entries);
    } finally {
      if (release !== undefined) {
        await release();
      }
    }
  }

  /**
   * `guard` runs INSIDE the critical section, immediately before the physical write (issue #207)
   * — see the interface doc for the full guard contract. NO pre-lock placeholder file: verified
   * `lockfile.lock(path, { realpath: false })` acquires cleanly against a target that does not yet
   * exist; the legacy `append()`'s placeholder above predates this and stays byte-identical there,
   * but is not needed and is not replicated here — `appendFile`'s own `O_CREAT`, inside the
   * critical section, is the sole creator of the WAL file on this path.
   */
  async appendFenced(
    runId: string,
    stepId: string,
    entries: AgentTraceEntry[],
    guard: () => Promise<void>,
  ): Promise<AppendResult> {
    const walPath = this.walPath(runId, stepId);
    const release = await this.lockWal(walPath, APPEND_RETRIES);
    try {
      await guard();
      return await this.appendWithinCS(walPath, entries);
    } finally {
      await release();
    }
  }

  async read(runId: string, stepId: string): Promise<BufferedEntry[]> {
    const walPath = this.walPath(runId, stepId);
    const release = await this.lockWal(walPath);
    try {
      const { lines } = await this.readWal(walPath);
      return lines.flatMap((line) =>
        line.entries.map((entry) => ({ ...entry, _internalTs: line.ts })),
      );
    } finally {
      await release();
    }
  }

  async delete(runId: string, stepId: string): Promise<void> {
    // issue #207: now serialized on the same per-path critical section append/appendFenced use —
    // declaring the fenced trio commits read/delete/deleteAllForRun to the same CS (see the
    // interface doc).
    //
    // issue #183: this single-step cleanup is best-effort BY CONVENTION at MOST call sites — but
    // NOT ALL FOUR: execution-loop.ts's :1857 success-settle call site does NOT wrap this call in
    // a try/catch today (a follow-up PR fixes that site directly); the other three
    // (execution-loop.ts's other two + reclaim-step.ts's one) do. Converting the raw unlink to
    // deleteIfExists here doesn't change that contract — delete() can still fail; it just stops a
    // real I/O error from being invisibly swallowed with NO signal at all, which the source-text
    // guard (store-fs-guard.test.ts) also requires (no raw unlink in this file).
    const walPath = this.walPath(runId, stepId);
    const release = await this.lockWal(walPath);
    try {
      await deleteIfExists(walPath);
    } finally {
      await release();
    }
  }

  /**
   * `guard` runs INSIDE the same per-path critical section `append`/`appendFenced` use,
   * immediately before the delete (issue #207) — see the interface doc for the full guard
   * contract. Returns the number of entries actually deleted (`0` = buffer already absent; the
   * guard still ran first). Counts via the already-open `readWal` internals — NEVER the public
   * `read()`, which would re-acquire this same lock (a critical section must never be re-entered
   * from within itself — `proper-lockfile` is not reentrant).
   */
  async deleteFenced(runId: string, stepId: string, guard: () => Promise<void>): Promise<number> {
    const walPath = this.walPath(runId, stepId);
    const release = await this.lockWal(walPath);
    try {
      await guard();
      const { count } = await this.readWal(walPath);
      await deleteIfExists(walPath);
      return count;
    } finally {
      await release();
    }
  }

  /** Resolves the candidate WAL files for `runId`, sorted deterministically — shared by
   *  `deleteAllForRun` and `deleteAllForRunFenced` (issue #207). */
  private async matchingWalFiles(
    runId: string,
    dirEntries: readonly string[] | undefined,
  ): Promise<string[]> {
    const prefix = `trace-buffer-${runId}-`;
    let files: readonly string[];
    if (dirEntries !== undefined) {
      files = dirEntries;
    } else {
      try {
        files = await readdir(this.runsDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          files = []; // runsDir itself absent → nothing to delete, success
        } else {
          throw toArtifactDeleteFailedError(runId, 'JsonTraceBufferStore', [], this.runsDir, err);
        }
      }
    }
    // SORTED candidates — deterministic residue (which artifact fails first is reproducible
    // across retries/tests, not dependent on readdir's unspecified ordering).
    return [...files].filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl')).sort();
  }

  /**
   * Deletes every orphaned WAL file for `runId` (issue #107). Now serialized per-file on the same
   * critical section `appendFenced`/`deleteFenced` use (issue #207) — declaring the fenced trio
   * commits this legacy method too.
   *
   * @param dirEntries Optional pre-scanned `readdir(runsDir)` listing supplied by a batch purge —
   *   when present, this method filters it in-memory instead of re-scanning the directory itself
   *   (O(N runs × readdir) → O(readdir) for a batch of N). Falls back to its own `readdir` when
   *   omitted, exactly as before.
   */
  async deleteAllForRun(runId: string, dirEntries?: readonly string[]): Promise<void> {
    const matching = await this.matchingWalFiles(runId, dirEntries);

    const deleted: string[] = [];
    for (const file of matching) {
      const path = join(this.runsDir, file);
      let release: (() => Promise<void>) | undefined;
      try {
        release = await this.lockWal(path);
      } catch (err) {
        if (isLockContentionError(err)) throw lockBusyError(path);
        throw err;
      }
      try {
        const didDelete = await deleteIfExists(path);
        if (didDelete) deleted.push(file);
      } catch (err) {
        // Sequential stop-on-first-hard-error: don't attempt the remaining candidates once one
        // has genuinely failed — report exactly what succeeded before the failure.
        throw toArtifactDeleteFailedError(runId, 'JsonTraceBufferStore', deleted, file, err);
      } finally {
        await release();
      }
    }
  }

  /**
   * `guard` is RE-INVOKED inside EACH per-file critical section, immediately before that file's
   * delete (issue #207) — a refusal on any one file aborts the whole sweep with that file's error
   * (stop-on-first-error, matching the legacy method's own semantics). When zero files match
   * `runId` at all, `guard` is still invoked once, before the (empty) scan. A guard rejection, and
   * a per-file lock-contention failure (classified `STATE_RUN_BUSY`, mirroring `deleteAllForRun`'s
   * own classification above), both propagate UNWRAPPED — never touched by
   * `toArtifactDeleteFailedError`, which still wraps genuine unlink/I-O failures (the #183
   * absence/unreachable/corrupt trichotomy, extended with this third, distinct guard-refusal
   * outcome).
   */
  async deleteAllForRunFenced(
    runId: string,
    guard: () => Promise<void>,
    dirEntries?: readonly string[],
  ): Promise<void> {
    const matching = await this.matchingWalFiles(runId, dirEntries);

    if (matching.length === 0) {
      await guard();
      return;
    }

    const deleted: string[] = [];
    for (const file of matching) {
      const path = join(this.runsDir, file);
      let release: (() => Promise<void>) | undefined;
      try {
        release = await this.lockWal(path);
      } catch (err) {
        if (isLockContentionError(err)) throw lockBusyError(path);
        throw err;
      }
      try {
        await guard();
        const didDelete = await deleteIfExists(path);
        if (didDelete) deleted.push(file);
      } catch (err) {
        // Only deleteIfExists's own failure mode (FsIoError) gets wrapped — a guard rejection
        // (whatever type the caller's guard throws; typically a typed WorkflowError like
        // STATE_RUN_BUSY, but never assumed) propagates exactly as thrown.
        if (err instanceof FsIoError) {
          throw toArtifactDeleteFailedError(runId, 'JsonTraceBufferStore', deleted, file, err);
        }
        throw err;
      } finally {
        await release();
      }
    }
  }

  /**
   * Reads every WAL file for `runId` across all steps — the read-only counterpart to
   * `deleteAllForRun`, for `realm run export`'s evidence assembly (issue #159). Mirrors
   * `deleteAllForRun`'s exact glob (`trace-buffer-<runId>-*.jsonl`) and reverses `walPath`'s
   * base64url stepId encoding to recover the original step name.
   *
   * Parses each file torn-line-safe: blank and unparseable lines are skipped INDIVIDUALLY (the
   * same per-line discipline `FailedAttemptStore.read()` uses), rather than discarding an entire
   * file on one bad line the way `readWal`'s all-or-nothing catch does — a crash/abandon run's WAL
   * is exactly the case export exists for, and it's also the case most likely to have a torn last
   * line, so losing every earlier line to one partial write would defeat the purpose.
   *
   * Each value is the array of parsed WAL lines (`{ts, entries}`-shaped, matching what's actually
   * on disk) for that step, in file order. A missing `runsDir`, or no WAL for this run at all,
   * yields `{}` — never a throw.
   */
  async readAllForRun(runId: string): Promise<Record<string, unknown[]>> {
    const prefix = `trace-buffer-${runId}-`;
    let files: string[];
    try {
      files = await readdir(this.runsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {}; // runsDir itself absent → no WAL for anyone, not just this run
      }
      throw err;
    }

    const result: Record<string, unknown[]> = {};
    const matching = files.filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl'));

    for (const file of matching) {
      const encoded = file.slice(prefix.length, file.length - '.jsonl'.length);
      let stepId: string;
      try {
        stepId = Buffer.from(encoded, 'base64url').toString('utf8');
      } catch {
        continue; // malformed filename — skip this one file, not the whole export
      }

      // issue #183: readIfExists discriminates ENOENT (vanished between readdir and this read — a
      // benign race, skip) from a genuine I/O failure (now throws, rather than being silently
      // treated the same as the benign-vanished case).
      const content = await readIfExists(join(this.runsDir, file));
      if (content === undefined) {
        continue;
      }

      const lines: unknown[] = [];
      for (const raw of content.split('\n')) {
        const trimmed = raw.trim();
        if (trimmed.length === 0) continue;
        try {
          lines.push(JSON.parse(trimmed));
        } catch {
          // torn/partial line (e.g. a crash mid-append) — skip it, keep the rest
        }
      }

      result[stepId] = lines;
    }

    return result;
  }

  /**
   * Returns every WAL file (across all steps, all runs) whose runId is NOT in `liveRunIds`
   * (issue #163) — candidate orphans for `realm run gc`'s remediation sweep. Does not apply an
   * age floor or delete anything — see `OrphanSweepableStore`'s own doc for why that's the
   * caller's job.
   *
   * The runId parse is fixed-length, NOT delimiter-based: a WAL filename is
   * `trace-buffer-<36-char UUID>-<base64url(stepId)>.jsonl`, and the base64url step segment
   * legitimately contains `-`/`_` — splitting on `-` would silently misparse the runId the
   * moment a step name's base64url encoding starts with one of those characters. Slicing by the
   * UUID's known fixed length (36) is unambiguous regardless of what the step segment contains.
   *
   * FAIL-CLOSED: `ENOENT` on `runsDir` itself → `[]`. Any OTHER `readdir`/`stat` error THROWS —
   * never fabricate an empty/partial list, which would make a live run's WAL look orphaned.
   */
  async listOrphans(liveRunIds: ReadonlySet<string>): Promise<OrphanArtifact[]> {
    let entries: string[];
    try {
      entries = await readdir(this.runsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const orphans: OrphanArtifact[] = [];
    for (const name of entries) {
      if (!name.startsWith(WAL_PREFIX) || !name.endsWith(WAL_SUFFIX)) continue;

      // Everything between the fixed prefix and suffix is "<uuid>-<b64url step>" — slice the
      // UUID off by its KNOWN length, then require the very next character to be the '-'
      // separator `walPath` always writes. A name that's too short, or missing that separator
      // at exactly this position, is malformed (never produced by this store) — skip it rather
      // than guess.
      const afterPrefix = name.slice(WAL_PREFIX.length, -WAL_SUFFIX.length);
      if (afterPrefix.length <= RUN_ID_LENGTH || afterPrefix[RUN_ID_LENGTH] !== '-') continue;
      const runId = afterPrefix.slice(0, RUN_ID_LENGTH);
      if (liveRunIds.has(runId)) continue;

      const path = join(this.runsDir, name);
      // #183 discipline: statIfExists returns undefined only on ENOENT (a benign vanished-
      // between-readdir-and-stat race — skip it); any other errno throws, aborting the WHOLE
      // sweep (fail-closed) rather than silently omitting this one artifact.
      const info = await statIfExists(path);
      if (info === undefined) continue;
      orphans.push({ path, runId, mtimeMs: info.mtimeMs });
    }
    return orphans;
  }
}
