// json-trace-buffer-store.ts — File-based TraceBufferStore using JSONL WAL files.
import { existsSync } from 'node:fs';
import { readFile, appendFile, unlink, readdir } from 'node:fs/promises';
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
    if (!existsSync(walPath)) {
      return { count: 0, bytes: 0, lines: [] };
    }
    try {
      const content = await readFile(walPath, 'utf8');
      const lines: WalLine[] = content
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as WalLine);
      const count = lines.reduce((acc, l) => acc + l.entries.length, 0);
      const bytes = Buffer.byteLength(content);
      return { count, bytes, lines };
    } catch {
      // Treat corrupted WAL as empty.
      return { count: 0, bytes: 0, lines: [] };
    }
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
    const walPath = this.walPath(runId, stepId);
    await unlink(walPath).catch(() => {});
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
      } catch {
        return;
      }
    }
    await Promise.all(
      files
        .filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl'))
        .map((f) => unlink(join(this.runsDir, f)).catch(() => {})),
    );
  }
}
