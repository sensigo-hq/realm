// trace-buffer-store.ts — Buffer store interface for incremental trace ingestion (B-lite).
import type { AgentTraceEntry } from '../types/run-record.js';
import { WorkflowError } from '../types/workflow-error.js';

export interface AppendResult {
  buffer_count: number;
  buffer_bytes: number;
  limit_count: number;
  limit_bytes: number;
  final_limit_entries: number;
  final_limit_bytes: number;
}

export interface TraceBufferStore {
  /**
   * Appends normalized entries to the buffer for (runId, stepId).
   * Each entry is per-entry normalized at append time (reserved prefix drop, field caps).
   * Batch timestamp (_internalTs) is assigned at write time.
   * Throws BUFFER_FULL WorkflowError if the WAL limit would be exceeded.
   */
  append(runId: string, stepId: string, entries: AgentTraceEntry[]): Promise<AppendResult>;

  /**
   * Reads all buffered entries for (runId, stepId) with their batch timestamps attached.
   * Returns empty array if no buffer exists.
   * Entries carry _internalTs for ordering at finalization.
   */
  read(runId: string, stepId: string): Promise<BufferedEntry[]>;

  /** Deletes the buffer for (runId, stepId). No-op if absent. */
  delete(runId: string, stepId: string): Promise<void>;

  /**
   * Deletes all buffers for a run. Called when the run is deleted.
   *
   * @param dirEntries Optional pre-scanned directory listing (issue #107 batch purge). Ignored by
   *   this in-memory implementation; a filesystem-backed implementation may use it to avoid a
   *   per-run `readdir`.
   */
  deleteAllForRun(runId: string, dirEntries?: readonly string[]): Promise<void>;

  /**
   * Reads every buffered/WAL entry for a run, across ALL steps, keyed by stepId — the read-only
   * counterpart to `deleteAllForRun` (issue #159, `realm run export`'s evidence assembly). Each
   * value is that step's buffer/WAL contents in this store's own natural per-line/per-entry shape
   * (implementations differ here — see each implementer's own doc). `{}` if the run has none.
   * Never mutates; never throws on a missing run (an absent run/store location is just `{}`).
   */
  readAllForRun(runId: string): Promise<Record<string, unknown[]>>;
}

/** An AgentTraceEntry extended with engine-assigned ordering timestamp (milliseconds). */
export interface BufferedEntry extends AgentTraceEntry {
  _internalTs: number;
}

export const BUFFER_LIMIT_COUNT = 200;
export const BUFFER_LIMIT_BYTES = 100 * 1024; // 100 KB
export const FINAL_LIMIT_ENTRIES = 100;
export const FINAL_LIMIT_BYTES = 50 * 1024; // 50 KB (must match MAX_BYTES in trace-normalizer.ts)

const MAX_EVENT_LENGTH = 100;
const RESERVED_PREFIX = 'trace.';
const MAX_DATA_KEYS = 20;
const MAX_STRING_VALUE = 500;

/**
 * Per-entry normalization run at append time (not at finalization).
 * Mirrors the normalization in normalizeTrace for the parts that don't need seq or byte-budget context.
 * Returns null if the entry should be dropped (reserved prefix).
 */
export function normalizeEntryForBuffer(entry: AgentTraceEntry): AgentTraceEntry | null {
  // Normalize event: trim, replace empty with 'unknown_event', cap to MAX_EVENT_LENGTH.
  let event = (entry.event ?? '').trim();
  if (event.length === 0) event = 'unknown_event';
  if (event.length > MAX_EVENT_LENGTH) event = event.slice(0, MAX_EVENT_LENGTH);

  // Drop if event starts with reserved prefix.
  if (event.startsWith(RESERVED_PREFIX)) return null;

  // Normalize data: keep first 20 keys, cap string values to 500 chars, drop non-primitive values.
  let data: Record<string, string | number | boolean | null> | undefined;
  if (entry.data !== undefined) {
    const keys = Object.keys(entry.data).slice(0, MAX_DATA_KEYS);
    const normalized: Record<string, string | number | boolean | null> = {};
    for (const key of keys) {
      const val = entry.data[key];
      if (val === null || typeof val === 'boolean' || typeof val === 'number') {
        normalized[key] = val;
      } else if (typeof val === 'string') {
        normalized[key] = val.length > MAX_STRING_VALUE ? val.slice(0, MAX_STRING_VALUE) : val;
      }
      // Drop non-primitive values (objects, arrays, undefined).
    }
    data = Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  return {
    event,
    ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
    ...(data !== undefined ? { data } : {}),
  };
}

/**
 * In-memory TraceBufferStore for use in tests and non-persistent environments.
 * Entries are lost on process restart (no file I/O).
 */
export class InMemoryTraceBufferStore implements TraceBufferStore {
  private buffers = new Map<string, BufferedEntry[]>();

  private key(runId: string, stepId: string): string {
    return `${runId}:${stepId}`;
  }

  async append(runId: string, stepId: string, entries: AgentTraceEntry[]): Promise<AppendResult> {
    const k = this.key(runId, stepId);
    const existing = this.buffers.get(k) ?? [];

    if (entries.length === 0) {
      const bytes = Buffer.byteLength(JSON.stringify(existing));
      return {
        buffer_count: existing.length,
        buffer_bytes: bytes,
        limit_count: BUFFER_LIMIT_COUNT,
        limit_bytes: BUFFER_LIMIT_BYTES,
        final_limit_entries: FINAL_LIMIT_ENTRIES,
        final_limit_bytes: FINAL_LIMIT_BYTES,
      };
    }

    const ts = Date.now();
    const normalized: BufferedEntry[] = entries
      .map((e) => normalizeEntryForBuffer(e))
      .filter((e): e is AgentTraceEntry => e !== null)
      .map((e) => ({ ...e, _internalTs: ts }));

    const proposed = [...existing, ...normalized];
    const proposedBytes = Buffer.byteLength(JSON.stringify(proposed));
    if (proposed.length > BUFFER_LIMIT_COUNT || proposedBytes > BUFFER_LIMIT_BYTES) {
      const existingBytes = Buffer.byteLength(JSON.stringify(existing));
      throw new WorkflowError('Trace buffer full for step', {
        code: 'BUFFER_FULL',
        category: 'ENGINE',
        agentAction: 'provide_input',
        retryable: false,
        details: { buffer_count: existing.length, buffer_bytes: existingBytes },
      });
    }

    this.buffers.set(k, proposed);
    const bytes = Buffer.byteLength(JSON.stringify(proposed));
    return {
      buffer_count: proposed.length,
      buffer_bytes: bytes,
      limit_count: BUFFER_LIMIT_COUNT,
      limit_bytes: BUFFER_LIMIT_BYTES,
      final_limit_entries: FINAL_LIMIT_ENTRIES,
      final_limit_bytes: FINAL_LIMIT_BYTES,
    };
  }

  async read(runId: string, stepId: string): Promise<BufferedEntry[]> {
    return this.buffers.get(this.key(runId, stepId)) ?? [];
  }

  async delete(runId: string, stepId: string): Promise<void> {
    this.buffers.delete(this.key(runId, stepId));
  }

  async deleteAllForRun(runId: string, _dirEntries?: readonly string[]): Promise<void> {
    for (const key of [...this.buffers.keys()]) {
      if (key.startsWith(`${runId}:`)) {
        this.buffers.delete(key);
      }
    }
  }

  /** Returns each in-memory buffer for the run, keyed by stepId, as its stored `BufferedEntry[]`
   *  (already-flattened individual entries — this store's own natural shape; see `append`). */
  async readAllForRun(runId: string): Promise<Record<string, unknown[]>> {
    const result: Record<string, unknown[]> = {};
    const prefix = `${runId}:`;
    for (const [key, entries] of this.buffers.entries()) {
      if (key.startsWith(prefix)) {
        result[key.slice(prefix.length)] = entries;
      }
    }
    return result;
  }
}
