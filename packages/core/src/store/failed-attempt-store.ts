// failed-attempt-store.ts — durable, co-located per-run sidecar for failed agent-attempt telemetry.
//
// A pure observability SIDE-CHANNEL: it never touches the run file, never bumps version, never
// affects eligibility/phase/failed_steps[]. It lives in `runsDir` alongside run files and adopts the
// same operator-managed retention (Realm has no run-GC by design — see #107).
//
// File: <runsDir>/<runId>.attempts.jsonl — one JSON record per line.
//   - The `.jsonl` suffix is MANDATORY: JsonFileStore.list() does readdir → filter(.json) → JSON.parse
//     as a RunRecord with no try/catch, so a `<id>.attempts.json` sibling would corrupt
//     list()/cleanup/reconcile. `.jsonl` is invisible to that filter (like trace-buffer-*.jsonl and
//     the keys/ subdir).
//   - The path is derived ONLY from the server-generated UUIDv4 runId (`[0-9a-f-]`), never from
//     caller-supplied input — a path-safety invariant.
import { appendFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FailedAttemptRecord } from '../observability/failed-attempt-record.js';
import type { PerRunArtifactStore } from './per-run-artifact-store.js';
import type { OrphanSweepableStore, OrphanArtifact } from './orphan-sweepable-store.js';
import {
  readIfExists,
  deleteIfExists,
  statIfExists,
  toArtifactDeleteFailedError,
} from './fs-io.js';
import type { ArtifactDeletionReport } from './per-run-artifact-store.js';

/** The sidecar filename suffix — everything before it (the runId) is derived ONLY from the
 *  server-generated UUIDv4 runId, so stripping it back off is unambiguous (no delimiter
 *  ambiguity the way the WAL filename has, since there is no second segment after the runId
 *  here — see JsonTraceBufferStore.listOrphans for the trickier case). */
const SIDECAR_SUFFIX = '.attempts.jsonl';

/**
 * Append-and-stop byte ceiling per sidecar (~80+ full ≤3072B records — ample forensics). Approximate
 * under concurrency: bounded overshoot ≈ concurrent-writers × max-record. Kept lock-free deliberately.
 */
export const FAILED_ATTEMPT_SIDECAR_MAX_BYTES = 256 * 1024;

export interface FailedAttemptReadResult {
  /** Parsed records, in append order; torn/unparseable lines are skipped. */
  records: FailedAttemptRecord[];
  /** True when the sidecar reached the byte ceiling — later attempts were dropped (append-and-stop). */
  capped: boolean;
}

/**
 * File-backed store for failed agent-attempt sidecars. Append (MCP server) + read (CLI). Best-effort:
 * append never throws/propagates. Lock-free: each line is ≤PIPE_BUF, so a single O_APPEND write is
 * atomic and interleave-safe across concurrent processes (the size bound is what buys lock-freedom —
 * the deliberate difference from the WAL store).
 */
export class FailedAttemptStore implements PerRunArtifactStore, OrphanSweepableStore {
  private readonly runsDir: string;

  constructor(runsDir: string) {
    this.runsDir = runsDir;
  }

  /** Sidecar path — derived ONLY from the (server-generated UUID) runId. `.jsonl` is mandatory. */
  private sidecarPath(runId: string): string {
    return join(this.runsDir, `${runId}.attempts.jsonl`);
  }

  /**
   * Append one already-serialized line (from `serializeFailedAttemptLine`, guaranteed ≤3072B ≤ PIPE_BUF).
   * Append-and-stop: if the file is already at the ceiling the record is dropped. Best-effort — a
   * failed append (disk full, perms) never propagates and never alters the caller's response.
   */
  async append(runId: string, line: string): Promise<void> {
    const path = this.sidecarPath(runId);
    try {
      // O(1) ceiling check via stat — never read+count the file (that would be quadratic under a
      // retry storm). Missing file → treat as size 0 and proceed.
      try {
        const info = await stat(path);
        if (info.size >= FAILED_ATTEMPT_SIDECAR_MAX_BYTES) return; // append-and-stop (drop)
      } catch {
        // file does not exist yet → proceed with the first append
      }
      // Exactly one O_APPEND write — one record per line, atomic because line + '\n' ≤ PIPE_BUF.
      await appendFile(path, line + '\n', 'utf8');
    } catch {
      // Best-effort observability side-channel — never propagate.
    }
  }

  /**
   * Read the sidecar for a run. Parses line-by-line, skipping blank/torn/unparseable lines; never
   * throws. Missing file → empty result. `capped` is reported per the (race-free) size≥ceiling rule.
   */
  async read(runId: string): Promise<FailedAttemptReadResult> {
    const path = this.sidecarPath(runId);
    // issue #183: readIfExists distinguishes absence (undefined → empty result, the pre-existing
    // behavior) from a genuine I/O failure (now propagates, rather than being silently swallowed
    // into the same empty result an absent file produces — that conflation is exactly what let a
    // real read failure masquerade as "no failed attempts recorded").
    const content = await readIfExists(path);
    if (content === undefined) return { records: [], capped: false };

    let capped = false;
    try {
      const info = await stat(path);
      capped = info.size >= FAILED_ATTEMPT_SIDECAR_MAX_BYTES;
    } catch {
      // ignore — capped stays false
    }

    const records: FailedAttemptRecord[] = [];
    for (const raw of content.split('\n')) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      try {
        records.push(JSON.parse(trimmed) as FailedAttemptRecord);
      } catch {
        // skip a torn/partial/unparseable line — never throw
      }
    }
    return { records, capped };
  }

  /**
   * Deletes the `.attempts.jsonl` sidecar for `runId` (issue #107). Exact-path — ignores
   * `dirEntries` (the path is derived directly from the runId, no directory listing needed).
   * Idempotent: a missing sidecar (no failed attempts were ever recorded, or a concurrent purge /
   * double-invocation already removed it) is a no-op, never an error.
   */
  async deleteAllForRun(
    runId: string,
    _dirEntries?: readonly string[],
  ): Promise<ArtifactDeletionReport> {
    const path = this.sidecarPath(runId);
    // Stat-then-delete (issue #189's accounting rule): a sidecar that vanishes between the two
    // still counts as deleted, so the figure is a floor rather than a fiction.
    const bytes = (await statIfExists(path))?.size ?? 0;
    try {
      const didDelete = await deleteIfExists(path);
      return { bytes_deleted: didDelete ? bytes : 0 };
    } catch (err) {
      throw toArtifactDeleteFailedError(runId, 'FailedAttemptStore', [], path, err);
    }
  }

  /**
   * Issue #189 — the bytes of this run's one sidecar, without deleting it. Absent ⇒ 0;
   * unreachable THROWS (via `statIfExists`), symmetrically with the delete above.
   */
  async statAllForRun(runId: string, _dirEntries?: readonly string[]): Promise<{ bytes: number }> {
    return { bytes: (await statIfExists(this.sidecarPath(runId)))?.size ?? 0 };
  }

  /**
   * Returns every `.attempts.jsonl` sidecar whose runId is NOT in `liveRunIds` (issue #163) —
   * candidate orphans for `realm run gc`'s remediation sweep. Does not apply an age floor or
   * delete anything — see `OrphanSweepableStore`'s own doc for why that's the caller's job.
   *
   * FAIL-CLOSED: `ENOENT` on `runsDir` itself → `[]` (nothing has ever been created here). Any
   * OTHER `readdir` or `stat` error THROWS — never fabricate an empty/partial list, which would
   * make a live run's sidecar look orphaned.
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
      if (!name.endsWith(SIDECAR_SUFFIX)) continue;
      const runId = name.slice(0, -SIDECAR_SUFFIX.length);
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
