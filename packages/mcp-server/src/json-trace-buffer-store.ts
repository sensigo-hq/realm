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
  normalizeEntryForBuffer,
  BUFFER_LIMIT_COUNT,
  BUFFER_LIMIT_BYTES,
  FINAL_LIMIT_ENTRIES,
  FINAL_LIMIT_BYTES,
  readIfExists,
  deleteIfExists,
  toArtifactDeleteFailedError,
} from '@sensigo/realm';
import type { AgentTraceEntry } from '@sensigo/realm';
import { WorkflowError } from '@sensigo/realm';

/** Line format stored in the JSONL WAL file. */
interface WalLine {
  ts: number;
  entries: AgentTraceEntry[];
}

/**
 * File-based TraceBufferStore that persists WAL entries to JSONL files on disk.
 * WAL file path: <runsDir>/trace-buffer-<runId>-<base64url(stepId)>.jsonl
 */
export class JsonTraceBufferStore implements TraceBufferStore, PerRunArtifactStore {
  private readonly runsDir: string;

  constructor(runsDir: string) {
    this.runsDir = runsDir;
  }

  private walPath(runId: string, stepId: string): string {
    const safeStepId = Buffer.from(stepId).toString('base64url');
    return join(this.runsDir, `trace-buffer-${runId}-${safeStepId}.jsonl`);
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
      release = await lockfile.lock(walPath, { retries: 10, stale: 5000, realpath: false });

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
    } finally {
      if (release !== undefined) {
        await release();
      }
    }
  }

  async read(runId: string, stepId: string): Promise<BufferedEntry[]> {
    const walPath = this.walPath(runId, stepId);
    const { lines } = await this.readWal(walPath);
    return lines.flatMap((line) =>
      line.entries.map((entry) => ({ ...entry, _internalTs: line.ts })),
    );
  }

  async delete(runId: string, stepId: string): Promise<void> {
    // issue #183: this single-step cleanup is best-effort BY CONVENTION at every call site (all
    // four callers — execution-loop.ts ×3, reclaim-step.ts ×1 — already wrap this call in their
    // own try/catch that converts a failure into a warning, never treating success as load-bearing
    // the way deleteAllForRun/purge do). Converting the raw unlink to deleteIfExists here doesn't
    // change that contract (delete() can still fail — callers already expect and handle it); it
    // just stops a real I/O error from being invisibly swallowed with NO signal at all, which the
    // source-text guard (store-fs-guard.test.ts) also requires (no raw unlink in this file).
    const walPath = this.walPath(runId, stepId);
    await deleteIfExists(walPath);
  }

  /**
   * Deletes every orphaned WAL file for `runId` (issue #107).
   *
   * @param dirEntries Optional pre-scanned `readdir(runsDir)` listing supplied by a batch purge —
   *   when present, this method filters it in-memory instead of re-scanning the directory itself
   *   (O(N runs × readdir) → O(readdir) for a batch of N). Falls back to its own `readdir` when
   *   omitted, exactly as before.
   */
  async deleteAllForRun(runId: string, dirEntries?: readonly string[]): Promise<void> {
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
    const matching = [...files].filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl')).sort();

    const deleted: string[] = [];
    for (const file of matching) {
      const path = join(this.runsDir, file);
      try {
        const didDelete = await deleteIfExists(path);
        if (didDelete) deleted.push(file);
      } catch (err) {
        // Sequential stop-on-first-hard-error: don't attempt the remaining candidates once one
        // has genuinely failed — report exactly what succeeded before the failure.
        throw toArtifactDeleteFailedError(runId, 'JsonTraceBufferStore', deleted, file, err);
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
}
