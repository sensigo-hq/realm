// json-trace-buffer-store.ts — File-based TraceBufferStore using JSONL WAL files.
import { existsSync } from 'node:fs';
import { appendFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import lockfile from 'proper-lockfile';
import {
  type ArtifactDeletionReport,
  type TraceBufferStore,
  type BufferedEntry,
  type AppendResult,
  type AppendOptions,
  type TraceCapability,
  type SealResult,
  type SealedWalLine,
  type SealedArtifact,
  type PerRunArtifactStore,
  type OrphanSweepableStore,
  type OrphanArtifact,
  normalizeEntryForBuffer,
  BUFFER_LIMIT_COUNT,
  BUFFER_LIMIT_BYTES,
  FINAL_LIMIT_ENTRIES,
  FINAL_LIMIT_BYTES,
  BUFFER_BACKSTOP_COUNT,
  BUFFER_BACKSTOP_BYTES,
  SEALED_ARTIFACTS_LIMIT_PER_STEP,
  checkBufferBudget,
  bufferFullError,
  flattenWalBatches,
  readIfExists,
  deleteIfExists,
  statIfExists,
  toArtifactDeleteFailedError,
  linkNoClobberThenUnlink,
  errnoCode,
  FsIoError,
} from '@sensigo/realm';
import type { AgentTraceEntry } from '@sensigo/realm';
import { WorkflowError } from '@sensigo/realm';

/** Line format stored in the JSONL WAL file — literally `SealedWalLine` (issue #197 PR-1: a
 *  sealed artifact is exactly "the WAL, moved", so both the live and sealed representations share
 *  one shape rather than two structurally-identical types). */
type WalLine = SealedWalLine;

/** WAL filename shape: `trace-buffer-<runId>-<base64url(stepId)>.jsonl`. `runId` is a
 *  server-generated UUIDv4 — always exactly 36 characters (8-4-4-4-12 hex, RFC 4122 string
 *  form) — so it can be recovered by FIXED-LENGTH slicing rather than splitting on `-`, which
 *  would break the moment a base64url step segment itself contains `-` or `_` (both are valid
 *  base64url alphabet characters). See `listOrphans` below for where this matters (issue #163). */
const WAL_PREFIX = 'trace-buffer-';
const WAL_SUFFIX = '.jsonl';
const RUN_ID_LENGTH = 36;

/** Sealed-artifact filename shape (issue #197 PR-1, the `seal` rung — design §4):
 *  `sealed-trace-<runId>-<base64url(stepId)>.<seq>.jsonl`. Distinct, non-overlapping prefix from
 *  `WAL_PREFIX` (`'sealed-trace-'` vs `'trace-buffer-'` — neither is a prefix of the other, so no
 *  filename can ever satisfy both matchers — see the collision test in the co-located spec). The
 *  `.`-delimited `seq` is unambiguous against the rest of the name: neither a UUID nor the
 *  base64url alphabet ever contains a literal `.`, so the LAST `.` in the middle segment is always
 *  the seq separator, never part of the runId or step segment. */
const SEALED_PREFIX = 'sealed-trace-';

/** Parses a sealed-artifact filename back into its constituent parts, mirroring
 *  `runIdFromWalPath`'s fixed-length-36 discipline for the runId portion. Returns `undefined` for
 *  anything that doesn't match the shape this store itself ever writes (defensive — never throws,
 *  never guesses) rather than a malformed/foreign file being mis-parsed. */
function parseSealedFilename(
  name: string,
): { runId: string; safeStepId: string; seq: number } | undefined {
  if (!name.startsWith(SEALED_PREFIX) || !name.endsWith(WAL_SUFFIX)) return undefined;
  const middle = name.slice(SEALED_PREFIX.length, -WAL_SUFFIX.length); // "<runId>-<safeStepId>.<seq>"
  const lastDot = middle.lastIndexOf('.');
  if (lastDot === -1) return undefined;
  const beforeSeq = middle.slice(0, lastDot);
  const seqStr = middle.slice(lastDot + 1);
  if (!/^\d+$/.test(seqStr)) return undefined;
  if (beforeSeq.length <= RUN_ID_LENGTH || beforeSeq[RUN_ID_LENGTH] !== '-') return undefined;
  const runId = beforeSeq.slice(0, RUN_ID_LENGTH);
  const safeStepId = beforeSeq.slice(RUN_ID_LENGTH + 1);
  return { runId, safeStepId, seq: Number(seqStr) };
}

/** A `proper-lockfile` retry policy: either a bare retry count (its own simple default backoff)
 *  or an explicit `retry`-module-compatible options object. `randomize` (issue #191 ride-along —
 *  `json-file-store.ts`'s own `LOCK_RETRIES` doc has the full jitter rationale) is optional so
 *  every existing caller/conformance-suite override that predates it stays valid unchanged. */
type LockRetries =
  number | { retries: number; minTimeout?: number; maxTimeout?: number; randomize?: boolean };

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
 *  hangs an engine path for minutes on genuine contention. `randomize: true` (issue #191
 *  ride-along) de-synchronizes contenders under fan-out — the same thundering-herd fix
 *  `json-file-store.ts`'s `LOCK_RETRIES` applies; this store already had a bounded `maxTimeout`
 *  where the run-file store didn't, but neither had jitter until now.
 *  Exported ONLY for this file's own test (issue #191) — not part of this module's intended
 *  public surface (`TraceBufferLockProfile`/the constructor's injection point are). */
export const DEFAULT_LOCK_PROFILE: TraceBufferLockProfile = {
  retries: { retries: 6, minTimeout: 50, maxTimeout: 1000, randomize: true },
  stale: 5000,
  realpath: false,
};

/** `append`/`appendFenced` keep the pre-existing, more patient retry count (today's shipped
 *  behavior, unchanged) — appends are the highest-frequency, most latency-sensitive operation. */
const APPEND_RETRIES = 10;

/** Best-effort extraction of the runId from a WAL path's basename, for the `onCompromised` warn
 *  message only (issue #207 correction) — mirrors `listOrphans`'s fixed-length-36 slice (never
 *  string-splits on '-', which the base64url-encoded stepId segment can legitimately contain).
 *  Returns `undefined` if the basename doesn't match the expected shape; never throws — this is
 *  purely a best-effort logging aid, not a parser any control-flow depends on. */
function runIdFromWalPath(walPath: string): string | undefined {
  const base = basename(walPath);
  if (!base.startsWith(WAL_PREFIX) || !base.endsWith(WAL_SUFFIX)) return undefined;
  const afterPrefix = base.slice(WAL_PREFIX.length, -WAL_SUFFIX.length);
  if (afterPrefix.length <= RUN_ID_LENGTH || afterPrefix[RUN_ID_LENGTH] !== '-') return undefined;
  return afterPrefix.slice(0, RUN_ID_LENGTH);
}

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
 *
 * Issue #197 PR-1 additionally declares BOTH capability-ladder rungs (`seal` and
 * `writer_nonce_carriage`, `traceCapabilities`). `sealFenced` retires a live WAL file to a sealed
 * artifact (`sealed-trace-<runId>-<base64url(stepId)>.<seq>.jsonl`) via the SAME `lockWal`
 * chokepoint every other operation uses — see `sealFenced`'s own doc for the no-clobber move
 * mechanics.
 */
export class JsonTraceBufferStore
  implements TraceBufferStore, PerRunArtifactStore, OrphanSweepableStore
{
  readonly traceCapabilities: ReadonlySet<TraceCapability> = new Set([
    'seal',
    'writer_nonce_carriage',
  ]);

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

  /** Builds the on-disk path for one sealed artifact — see `SEALED_PREFIX`'s doc for the shape
   *  and why it never collides with a live WAL path. */
  private sealedWalPath(runId: string, stepId: string, seq: number): string {
    const safeStepId = Buffer.from(stepId).toString('base64url');
    return join(this.runsDir, `${SEALED_PREFIX}${runId}-${safeStepId}.${seq}.jsonl`);
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
        // issue #207 correction: decode the runId (fixed-length slice, mirrors listOrphans) so
        // the warn carries genuine run/step context rather than only the raw path — the stepId
        // segment stays base64url-encoded in that path (not decoded here; this is a best-effort
        // logging aid, not a place to risk throwing on a malformed name).
        const runId = runIdFromWalPath(walPath);
        const context =
          runId !== undefined
            ? ` (runId=${runId}; stepId is base64url-encoded within the path)`
            : '';
        console.warn(
          `[JsonTraceBufferStore] lock compromised for '${walPath}'${context}: ${err.message} — ` +
            'a stale lock was stolen; this is the accepted cost of tokenless mutual exclusion ' +
            '(issue #207 residual 1), never a silent crash',
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
   * Count + bytes for exactly the batches belonging to `writerNonce` (issue #197 PR-1, design §5's
   * byte-attribution rule) — `undefined` = ⊥, the bare/anonymous writer class.
   *
   * A NONCED writer's stats are computed DIRECTLY: sum the `entries.length` and re-serialized
   * byte size of exactly its own successfully-parsed lines. `JSON.stringify` of a parsed
   * `WalLine` reproduces its ORIGINAL on-disk bytes exactly — this file only ever writes lines via
   * `JSON.stringify({ts, entries[, nonce]})`, and V8 preserves string-key insertion order through
   * parse→re-stringify, so re-serializing a parsed line is bit-for-bit identical to how it was
   * actually written.
   *
   * ⊥'s stats are a RESIDUAL, not a direct sum: `bytes = fileBytes - Σ(every DISTINCT nonced
   * partition's own bytes)`. This is what makes ⊥ "inherit all unattributable bytes" — a
   * torn/unparseable line's raw bytes are captured in `fileBytes` (computed from the whole raw
   * file content, not from re-stringifying parsed lines) but can never be subtracted out as part
   * of any nonced partition (it never parsed into one), so they remain in ⊥'s residual exactly as
   * they always silently were before this capability existed. For an all-bare file (no nonced
   * lines at all), the residual is arithmetically the WHOLE file — byte-identical to the pre-#197
   * formula, emergent rather than special-cased.
   */
  private partitionStats(
    lines: readonly WalLine[],
    fileBytes: number,
    writerNonce: string | undefined,
  ): { count: number; bytes: number } {
    if (writerNonce !== undefined) {
      const own = lines.filter((l) => l.nonce === writerNonce);
      const count = own.reduce((acc, l) => acc + l.entries.length, 0);
      const bytes = own.reduce((acc, l) => acc + Buffer.byteLength(JSON.stringify(l) + '\n'), 0);
      return { count, bytes };
    }
    const noncedLines = lines.filter((l) => l.nonce !== undefined);
    const noncedBytes = noncedLines.reduce(
      (acc, l) => acc + Buffer.byteLength(JSON.stringify(l) + '\n'),
      0,
    );
    const bareCount = lines
      .filter((l) => l.nonce === undefined)
      .reduce((acc, l) => acc + l.entries.length, 0);
    return { count: bareCount, bytes: fileBytes - noncedBytes };
  }

  /**
   * The actual write logic, shared by `append` and `appendFenced` (issue #207) so BUFFER_FULL /
   * normalization / `AppendResult` shape live in exactly one place. Assumes the caller already
   * holds the per-path critical section. `writerNonce` (issue #197 PR-1) is `undefined` for a bare
   * call — the byte-identical legacy path (this file's own `newLine` shape omits the `nonce` key
   * entirely when so, exactly matching the pre-#197 JSONL bytes for all-bare traffic).
   */
  private async appendWithinCS(
    walPath: string,
    entries: AgentTraceEntry[],
    writerNonce: string | undefined,
  ): Promise<AppendResult> {
    const { count: fileCountBefore, bytes: fileBytesBefore, lines } = await this.readWal(walPath);
    const writerBefore = this.partitionStats(lines, fileBytesBefore, writerNonce);

    const normalized = entries
      .map((e) => normalizeEntryForBuffer(e))
      .filter((e): e is AgentTraceEntry => e !== null);

    if (normalized.length === 0) {
      return {
        buffer_count: writerBefore.count,
        buffer_bytes: writerBefore.bytes,
        limit_count: BUFFER_LIMIT_COUNT,
        limit_bytes: BUFFER_LIMIT_BYTES,
        final_limit_entries: FINAL_LIMIT_ENTRIES,
        final_limit_bytes: FINAL_LIMIT_BYTES,
        file_count: fileCountBefore,
        file_bytes: fileBytesBefore,
        file_limit_count: BUFFER_BACKSTOP_COUNT,
        file_limit_bytes: BUFFER_BACKSTOP_BYTES,
      };
    }

    const newLineObj: WalLine =
      writerNonce !== undefined
        ? { ts: Date.now(), entries: normalized, nonce: writerNonce }
        : { ts: Date.now(), entries: normalized };
    const newLine = JSON.stringify(newLineObj);
    const newBytes = Buffer.byteLength(newLine + '\n');

    // JSONL is genuinely additive (unlike the in-memory store's whole-array restringify): the
    // file-scope and this-writer's-own "after" numbers are simply "before" plus this one new
    // line's own contribution — see `partitionStats`'s doc for why this holds for ⊥ too.
    const writerCountAfter = writerBefore.count + normalized.length;
    const writerBytesAfter = writerBefore.bytes + newBytes;
    const fileCountAfter = fileCountBefore + normalized.length;
    const fileBytesAfter = fileBytesBefore + newBytes;

    const overflow = checkBufferBudget({
      writerCountBefore: writerBefore.count,
      writerBytesBefore: writerBefore.bytes,
      writerCountAfter,
      writerBytesAfter,
      fileCountBefore,
      fileBytesBefore,
      fileCountAfter,
      fileBytesAfter,
    });
    if (overflow) {
      throw bufferFullError(overflow);
    }

    await appendFile(walPath, newLine + '\n', 'utf8');

    return {
      buffer_count: writerCountAfter,
      buffer_bytes: writerBytesAfter,
      limit_count: BUFFER_LIMIT_COUNT,
      limit_bytes: BUFFER_LIMIT_BYTES,
      final_limit_entries: FINAL_LIMIT_ENTRIES,
      final_limit_bytes: FINAL_LIMIT_BYTES,
      file_count: fileCountAfter,
      file_bytes: fileBytesAfter,
      file_limit_count: BUFFER_BACKSTOP_COUNT,
      file_limit_bytes: BUFFER_BACKSTOP_BYTES,
    };
  }

  async append(
    runId: string,
    stepId: string,
    entries: AgentTraceEntry[],
    options?: AppendOptions,
  ): Promise<AppendResult> {
    const walPath = this.walPath(runId, stepId);

    if (entries.length === 0) {
      const { count: fileCount, bytes: fileBytes, lines } = await this.readWal(walPath);
      const writer = this.partitionStats(lines, fileBytes, options?.writerNonce);
      return {
        buffer_count: writer.count,
        buffer_bytes: writer.bytes,
        limit_count: BUFFER_LIMIT_COUNT,
        limit_bytes: BUFFER_LIMIT_BYTES,
        final_limit_entries: FINAL_LIMIT_ENTRIES,
        final_limit_bytes: FINAL_LIMIT_BYTES,
        file_count: fileCount,
        file_bytes: fileBytes,
        file_limit_count: BUFFER_BACKSTOP_COUNT,
        file_limit_bytes: BUFFER_BACKSTOP_BYTES,
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
      return await this.appendWithinCS(walPath, entries, options?.writerNonce);
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
    options?: AppendOptions,
  ): Promise<AppendResult> {
    const walPath = this.walPath(runId, stepId);
    const release = await this.lockWal(walPath, APPEND_RETRIES);
    try {
      await guard();
      return await this.appendWithinCS(walPath, entries, options?.writerNonce);
    } finally {
      await release();
    }
  }

  /** `_nonce` is re-attached per-line ONLY when that line actually carried one — via the SAME
   *  `flattenWalBatches` core helper the in-memory store uses, so "never fabricate `_nonce` for a
   *  bare line" is enforced from exactly one shared code path rather than reimplemented twice. */
  async read(runId: string, stepId: string): Promise<BufferedEntry[]> {
    const walPath = this.walPath(runId, stepId);
    const release = await this.lockWal(walPath);
    try {
      const { lines } = await this.readWal(walPath);
      return flattenWalBatches(lines);
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

  /**
   * `guard` runs INSIDE the SAME per-path critical section every other operation on this key
   * uses (issue #197 PR-1, the `seal` rung — design §4: "no second locking path"), immediately
   * before the seal-move. Atomically retires the live WAL file to a new sealed artifact via the
   * no-clobber `link`-then-`unlink` primitive (`linkNoClobberThenUnlink`) — plain `rename()` is
   * FORBIDDEN here, since it would silently overwrite an existing sealed artifact at the same
   * `seq`.
   *
   * `seq` is probed by the link attempt ITSELF (no pre-listing, no separate TOCTOU-prone scan):
   * starting at 0, an `EEXIST` on the link means that `seq` is already taken by an earlier seal —
   * bump and retry, bounded by `SEALED_ARTIFACTS_LIMIT_PER_STEP`. Exhausting the bound without
   * success returns `{sealed: false, reason: 'capped'}` — the caller falls back to the existing
   * destructive drain (`deleteFenced`), never a silent eviction of an already-sealed artifact.
   *
   * `{sealed: false, reason: 'absent'}` when no live WAL file exists for this key AT ALL (checked
   * via `statIfExists` — #183's ENOENT-is-absence discipline) — nothing to seal is success, not a
   * failure. A present-but-empty file (e.g. `append()`'s legacy placeholder) is NOT "absent" — it
   * gets sealed like any other live WAL (a harmless, if pointless, empty sealed artifact).
   */
  async sealFenced(runId: string, stepId: string, guard: () => Promise<void>): Promise<SealResult> {
    const walPath = this.walPath(runId, stepId);
    const release = await this.lockWal(walPath);
    try {
      await guard();

      const stat = await statIfExists(walPath);
      if (stat === undefined) {
        return { sealed: false, reason: 'absent' };
      }

      for (let seq = 0; seq < SEALED_ARTIFACTS_LIMIT_PER_STEP; seq++) {
        const sealedPath = this.sealedWalPath(runId, stepId, seq);
        try {
          await linkNoClobberThenUnlink(walPath, sealedPath);
          return { sealed: true };
        } catch (err) {
          if (errnoCode(err) === 'EEXIST') continue; // this seq already taken — bump and retry
          throw err;
        }
      }
      return { sealed: false, reason: 'capped' };
    } finally {
      await release();
    }
  }

  /**
   * Lock-free point-in-time read of every sealed artifact for `runId`, across all its steps
   * (issue #197 PR-1, the `seal` rung) — matches `readAllForRun`'s deliberately-unlocked posture.
   * Parses each sealed file torn-tolerant, per-line, exactly like `readWal`/`readAllForRun` (a
   * sealed artifact's raw bytes moved verbatim from the live WAL, including any trailing torn
   * line it already had at seal time — this is a READ concern, not something sealing fixes).
   */
  async listSealedForRun(runId: string): Promise<SealedArtifact[]> {
    let entries: string[];
    try {
      entries = await readdir(this.runsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    // Unlike `listOrphans` (which must DISCOVER an unknown runId from an arbitrary filename, and
    // so needs `parseSealedFilename`'s fixed-length-36 recovery), `runId` here is already KNOWN —
    // filtering by literal prefix is both sufficient and correct regardless of whether `runId`
    // happens to be UUID-shaped (real server-generated runIds always are; test doubles need not
    // be). Only the step + seq portion (genuinely unknown) needs parsing out of each match.
    const prefix = `${SEALED_PREFIX}${runId}-`;
    const matching = entries.filter((f) => f.startsWith(prefix) && f.endsWith(WAL_SUFFIX)).sort();

    const result: SealedArtifact[] = [];
    for (const file of matching) {
      const afterPrefix = file.slice(prefix.length, -WAL_SUFFIX.length); // "<safeStepId>.<seq>"
      const lastDot = afterPrefix.lastIndexOf('.');
      if (lastDot === -1) continue;
      const safeStepId = afterPrefix.slice(0, lastDot);
      const seqStr = afterPrefix.slice(lastDot + 1);
      if (!/^\d+$/.test(seqStr)) continue;
      const seq = Number(seqStr);

      let stepId: string;
      try {
        stepId = Buffer.from(safeStepId, 'base64url').toString('utf8');
      } catch {
        continue; // malformed filename — skip this one artifact, not the whole listing
      }

      // issue #183: readIfExists discriminates ENOENT (vanished between readdir and this read —
      // a benign race) from a genuine I/O failure (now throws).
      const content = await readIfExists(join(this.runsDir, file));
      if (content === undefined) continue;

      const lines: SealedWalLine[] = [];
      for (const raw of content.split('\n')) {
        const trimmed = raw.trim();
        if (trimmed.length === 0) continue;
        try {
          lines.push(JSON.parse(trimmed) as SealedWalLine);
        } catch {
          console.warn(`⚠ realm: skipping unparseable sealed-trace WAL line in '${file}'`);
        }
      }
      result.push({ step_id: stepId, seq, lines });
    }
    return result;
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

  /** Resolves the candidate SEALED artifact files for `runId`, sorted deterministically — the
   *  same shared-`dirEntries`-or-own-`readdir` shape as `matchingWalFiles` (issue #197 PR-1: a
   *  sealed artifact is retained only until its owning run itself is purged — design §4). */
  private async matchingSealedFiles(
    runId: string,
    dirEntries: readonly string[] | undefined,
  ): Promise<string[]> {
    const prefix = `${SEALED_PREFIX}${runId}-`;
    let files: readonly string[];
    if (dirEntries !== undefined) {
      files = dirEntries;
    } else {
      try {
        files = await readdir(this.runsDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          files = [];
        } else {
          throw toArtifactDeleteFailedError(runId, 'JsonTraceBufferStore', [], this.runsDir, err);
        }
      }
    }
    return [...files].filter((f) => f.startsWith(prefix) && f.endsWith(WAL_SUFFIX)).sort();
  }

  /**
   * Deletes every orphaned WAL file for `runId` (issue #107). Now serialized per-file on the same
   * critical section `appendFenced`/`deleteFenced` use (issue #207) — declaring the fenced trio
   * commits this legacy method too. Issue #197 PR-1: sealed artifacts for this run join the same
   * sweep (`matchingSealedFiles`) — a sealed artifact outlives its step but not its run.
   *
   * @param dirEntries Optional pre-scanned `readdir(runsDir)` listing supplied by a batch purge —
   *   when present, this method filters it in-memory instead of re-scanning the directory itself
   *   (O(N runs × readdir) → O(readdir) for a batch of N). Falls back to its own `readdir` when
   *   omitted, exactly as before.
   */
  /**
   * Issue #189 — the bytes this store holds for `runId`, without deleting anything.
   *
   * Counts BOTH artifact classes, exactly as both delete paths do: live WAL files AND sealed
   * artifacts. A WAL-only stat would re-ship the very under-count this issue retires — the dying
   * filename scan, for all its faults, did catch sealed files, so missing them here would be a
   * REGRESSION dressed as a fix.
   *
   * Lock-free by contract (this answers a dry run). Unreachability throws via `statIfExists`.
   */
  async statAllForRun(runId: string, dirEntries?: readonly string[]): Promise<{ bytes: number }> {
    const matching = [
      ...(await this.matchingWalFiles(runId, dirEntries)),
      ...(await this.matchingSealedFiles(runId, dirEntries)),
    ];
    let bytes = 0;
    for (const file of matching) {
      bytes += (await statIfExists(join(this.runsDir, file)))?.size ?? 0;
    }
    return { bytes };
  }

  async deleteAllForRun(
    runId: string,
    dirEntries?: readonly string[],
  ): Promise<ArtifactDeletionReport> {
    const matching = [
      ...(await this.matchingWalFiles(runId, dirEntries)),
      ...(await this.matchingSealedFiles(runId, dirEntries)),
    ];

    const deleted: string[] = [];
    // Stat-then-delete (issue #189's accounting rule): a file that vanishes between the two still
    // counts as deleted, making the figure a floor rather than a fiction.
    let bytes_deleted = 0;
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
        const bytes = (await statIfExists(path))?.size ?? 0;
        const didDelete = await deleteIfExists(path);
        if (didDelete) {
          deleted.push(file);
          bytes_deleted += bytes;
        }
      } catch (err) {
        // Sequential stop-on-first-hard-error: don't attempt the remaining candidates once one
        // has genuinely failed — report exactly what succeeded before the failure.
        throw toArtifactDeleteFailedError(runId, 'JsonTraceBufferStore', deleted, file, err);
      } finally {
        await release();
      }
    }
    return { bytes_deleted };
  }

  /**
   * `guard` is RE-INVOKED inside EACH per-file critical section, immediately before that file's
   * delete (issue #207) — a refusal on any one file aborts the whole sweep with that file's error
   * (stop-on-first-error, matching the legacy method's own semantics). When zero files match
   * `runId` at all, `guard` is still consulted at least once (issue #207 correction: the scan
   * — resolving which files match — necessarily runs FIRST, since there is nothing to invoke a
   * per-file guard against otherwise; the guard is then invoked once for the empty case). If it
   * throws, the sweep rejects with that error exactly as it would for a non-empty sweep —
   * propagation is UNIFORM across the zero-match and non-empty cases (the TCK asserts rejection
   * here, not merely invocation count: a refusing guard makes even a zero-match sweep reject). A
   * guard rejection, and a per-file lock-contention failure (classified `STATE_RUN_BUSY`,
   * mirroring `deleteAllForRun`'s own classification above), both propagate UNWRAPPED — never
   * touched by `toArtifactDeleteFailedError`, which still wraps genuine unlink/I-O failures (the
   * #183 absence/unreachable/corrupt trichotomy, extended with this third, distinct guard-refusal
   * outcome). The guard call itself sits OUTSIDE the try/catch scope that performs this wrapping
   * (see the loop body below) — so a guard that happens to throw an `FsIoError` (e.g. its own
   * lock-free `runStore.get` hitting EACCES) is never mistaken for `deleteIfExists`'s own failure.
   *
   * Issue #197 PR-1: sealed artifacts for this run join the same fenced sweep, same as the
   * unfenced `deleteAllForRun` above.
   */
  async deleteAllForRunFenced(
    runId: string,
    guard: () => Promise<void>,
    dirEntries?: readonly string[],
  ): Promise<ArtifactDeletionReport> {
    const matching = [
      ...(await this.matchingWalFiles(runId, dirEntries)),
      ...(await this.matchingSealedFiles(runId, dirEntries)),
    ];

    if (matching.length === 0) {
      await guard();
      return { bytes_deleted: 0 };
    }

    const deleted: string[] = [];
    let bytes_deleted = 0;
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
        // issue #207 correction: `guard()` sits OUTSIDE the FsIoError-wrap scope below — a guard
        // rejection of ANY type, including one that happens to itself be an FsIoError (a
        // realistic case: the guard's lock-free `runStore.get` hitting EACCES), must propagate
        // exactly as thrown. The earlier shape wrapped BOTH the guard call and `deleteIfExists`
        // in one try/catch keyed only on `err instanceof FsIoError` — which mistook a
        // guard-thrown FsIoError for deleteIfExists's own failure and wrapped it too.
        await guard();
        try {
          const bytes = (await statIfExists(path))?.size ?? 0;
          const didDelete = await deleteIfExists(path);
          if (didDelete) {
            deleted.push(file);
            bytes_deleted += bytes;
          }
        } catch (err) {
          // Only deleteIfExists's own failure mode (FsIoError) gets wrapped here.
          if (err instanceof FsIoError) {
            throw toArtifactDeleteFailedError(runId, 'JsonTraceBufferStore', deleted, file, err);
          }
          throw err;
        }
      } finally {
        await release();
      }
    }
    return { bytes_deleted };
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
      let runId: string | undefined;

      if (name.startsWith(WAL_PREFIX) && name.endsWith(WAL_SUFFIX)) {
        // Everything between the fixed prefix and suffix is "<uuid>-<b64url step>" — slice the
        // UUID off by its KNOWN length, then require the very next character to be the '-'
        // separator `walPath` always writes. A name that's too short, or missing that separator
        // at exactly this position, is malformed (never produced by this store) — skip it rather
        // than guess.
        const afterPrefix = name.slice(WAL_PREFIX.length, -WAL_SUFFIX.length);
        if (afterPrefix.length > RUN_ID_LENGTH && afterPrefix[RUN_ID_LENGTH] === '-') {
          runId = afterPrefix.slice(0, RUN_ID_LENGTH);
        }
      } else if (name.startsWith(SEALED_PREFIX) && name.endsWith(WAL_SUFFIX)) {
        // issue #197 PR-1: a sealed artifact is an orphan candidate too — same run-liveness rule,
        // parsed via `parseSealedFilename` instead (distinct, non-overlapping prefix — see its
        // doc — so this branch and the one above are mutually exclusive for any given `name`).
        runId = parseSealedFilename(name)?.runId;
      } else {
        continue;
      }

      if (runId === undefined || liveRunIds.has(runId)) continue;

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
