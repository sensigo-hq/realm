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
import { existsSync } from 'node:fs';
import { appendFile, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FailedAttemptRecord } from '../observability/failed-attempt-record.js';
import type { PerRunArtifactStore } from './per-run-artifact-store.js';

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
export class FailedAttemptStore implements PerRunArtifactStore {
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
    if (!existsSync(path)) return { records: [], capped: false };

    let capped = false;
    try {
      const info = await stat(path);
      capped = info.size >= FAILED_ATTEMPT_SIDECAR_MAX_BYTES;
    } catch {
      // ignore — capped stays false
    }

    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      return { records: [], capped };
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
  async deleteAllForRun(runId: string, _dirEntries?: readonly string[]): Promise<void> {
    await unlink(this.sidecarPath(runId)).catch(() => {});
  }
}
