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

  /**
   * **The fenced trio (issue #207).** `appendFenced`, `deleteFenced`, and `deleteAllForRunFenced`
   * are an ALL-OR-NOTHING optional capability: declaring ANY of the three requires declaring ALL
   * THREE (the TCK's STRUCTURAL law enforces this deterministically). Declaring the trio is also
   * a commitment that `read()`, `delete()`, and `deleteAllForRun()` serialize on the SAME
   * per-(runId, stepId) critical sections the fenced methods use — a store that declares the trio
   * but lets a legacy `read()`/`delete()`/`deleteAllForRun()` call bypass those critical sections
   * has not actually implemented the capability.
   *
   * Guard contract, shared by all three methods:
   * - `guard` is invoked at least once per call. Implementations MAY retry internally — every TCK
   *   assertion about guard invocation is count-TOLERANT ("at least one"), never an exact count.
   * - ALL guard invocations complete BEFORE the method's destructive/mutating effect (the write
   *   for `appendFenced`; the delete for `deleteFenced`/`deleteAllForRunFenced`).
   * - `guard` performs exactly one lock-free `runStore.get` read (the #132 atomic-rename-safe
   *   read) — never more than one, and never a locked read.
   * - `guard` never acquires a lock of its own. Global lock-ordering rule: a WAL critical-section
   *   holder must never acquire the run-file lock, and a run-file-lock holder must never acquire a
   *   WAL lock — callers that touch both (e.g. purge) always delete artifacts strictly BEFORE
   *   their run-locked anchor delete, never the other way around.
   * - A guard rejection propagates to the caller UNWRAPPED — the method performs no write/delete,
   *   and the store's own error-wrapping (e.g. `toArtifactDeleteFailedError`) never touches it.
   *
   * Two-obligation form for a transaction-scoped store that enforces the race via a native SQL
   * predicate instead of an in-process critical section (`fenceForm: 'native-predicate'` in the
   * TCK): (1) `guard` is still invoked at least once per call, but MAY run outside the store's
   * atomic section — it must never `await` foreign code while holding a transaction/row lock, and
   * must never open a second pooled connection while the first is held. (2) The actual racing
   * predicate must be enforced by a CONFLICT-INDUCING read in the SAME transaction as the
   * buffer write (e.g. `SELECT ... FOR SHARE` at minimum — a plain same-transaction `WHERE` under
   * READ COMMITTED is insufficient; it is vulnerable to statement-snapshot staleness). **A
   * native-predicate store's race closure is NOT verified by a green TCK run** — the latch-based
   * laws (`CS_OCCUPANCY`, `PER_KEY_INDEPENDENCE`, `NO_SILENT_LOSS`) produce an explicit, visible
   * documented skip for such a store, never a silent pass; that store's OWN in-transaction fencing
   * suite is what must verify race closure (the same posture `RunStore.claimStep`'s cross-host
   * obligation already states for `CLAIM_SINGLE_OWNER`, issue #188).
   *
   * Legacy `append`/`delete`/`deleteAllForRun` remain on the interface, byte-frozen, for any store
   * that does not declare the fenced trio.
   */
  appendFenced?(
    runId: string,
    stepId: string,
    entries: AgentTraceEntry[],
    guard: () => Promise<void>,
  ): Promise<AppendResult>;

  /**
   * See `appendFenced`'s doc (above) for the shared guard contract and the all-or-nothing
   * declaration rule. Runs `guard` inside the SAME per-(runId, stepId) critical section
   * `appendFenced` uses, immediately before deleting the buffer. Returns the number of entries
   * actually deleted — `0` means the buffer was already absent (absence is success; the guard
   * still runs first, and still gates the no-op). This same-critical-section count is what lets a
   * caller (e.g. reclaim) report how many entries a destructive drain actually destroyed without a
   * separate, lock-re-entrant `read()` call — a store's own critical section must never be
   * re-entered from within itself.
   */
  deleteFenced?(runId: string, stepId: string, guard: () => Promise<void>): Promise<number>;

  /**
   * See `appendFenced`'s doc (above) for the shared guard contract and the all-or-nothing
   * declaration rule. Deletes every buffer for `runId` across all steps. `guard` is RE-INVOKED
   * inside EACH per-file (per-(runId, stepId)) critical section, immediately before that file's
   * delete — a refusal on any one file aborts the whole sweep with that file's error
   * (stop-on-first-error, matching the legacy `deleteAllForRun`'s own semantics). When zero files
   * match `runId` at all, `guard` is still invoked at least once, before the (empty) scan —
   * refusal on an empty sweep is never a required behavior, only that the guard is consulted (the
   * TCK asserts invocation count, not a refusal outcome, for this case). A guard rejection (e.g. a
   * typed `STATE_RUN_BUSY`) propagates to the caller UNWRAPPED, past the store's own
   * `toArtifactDeleteFailedError` wrapping — which still wraps genuine unlink/I-O failures,
   * preserving the #183 absence/unreachable/corrupt trichotomy: a guard refusal is neither
   * "absent" nor a genuine I/O failure, it is a third, distinct outcome that must reach the caller
   * exactly as the guard threw it.
   *
   * @param dirEntries Optional pre-scanned directory listing (see the legacy method's own doc) —
   *   ignored by non-fs implementations.
   */
  deleteAllForRunFenced?(
    runId: string,
    guard: () => Promise<void>,
    dirEntries?: readonly string[],
  ): Promise<void>;
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
 *
 * Declares the fenced trio (issue #207): `append`, `read`, `delete`, and `deleteAllForRun` all
 * serialize on the SAME per-(runId, stepId) critical section `appendFenced`/`deleteFenced` use,
 * via a per-key async mutex (a promise-chain map) — every one of the six operations for a given
 * key runs strictly after the previous operation on THAT SAME key has settled (success or
 * failure). Liveness posture: a hung guard hangs only that key's chain — a different key's chain
 * is untouched and proceeds normally (this per-key granularity is load-bearing; see the TCK's
 * PER_KEY_INDEPENDENCE law). The chain map's entry for a key is deleted once its own tail
 * settles and no newer call has chained after it, so an idle key holds no Map entry (no leak).
 */
export class InMemoryTraceBufferStore implements TraceBufferStore {
  private buffers = new Map<string, BufferedEntry[]>();
  private chains = new Map<string, Promise<void>>();

  private key(runId: string, stepId: string): string {
    return `${runId}:${stepId}`;
  }

  /**
   * Runs `fn` strictly after the current tail of the per-key chain for `k` has settled (whether
   * that prior link resolved or rejected), and installs `fn`'s own settlement as the new tail.
   * Returns/throws `fn`'s real result — chain-tracking never swallows or reshapes it. Removes the
   * map entry for `k` once this call's tail settles, but only if no NEWER call has since replaced
   * it (an identity check against the exact promise reference this call stored).
   */
  private async withKeyLock<T>(k: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(k) ?? Promise.resolve();
    // Neutralize prior's rejection for CHAINING purposes only — a failed operation on this key
    // must not permanently wedge every future operation on the same key.
    const settledPrior = prior.then(
      () => undefined,
      () => undefined,
    );
    const result = settledPrior.then(fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(k, tail);
    void tail.then(() => {
      if (this.chains.get(k) === tail) {
        this.chains.delete(k);
      }
    });
    return result;
  }

  private appendUnlocked(k: string, entries: AgentTraceEntry[]): AppendResult {
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

  async append(runId: string, stepId: string, entries: AgentTraceEntry[]): Promise<AppendResult> {
    const k = this.key(runId, stepId);
    return this.withKeyLock(k, async () => this.appendUnlocked(k, entries));
  }

  /** guard runs INSIDE the per-key critical section, immediately before the write — see the
   *  interface doc for the full guard contract. */
  async appendFenced(
    runId: string,
    stepId: string,
    entries: AgentTraceEntry[],
    guard: () => Promise<void>,
  ): Promise<AppendResult> {
    const k = this.key(runId, stepId);
    return this.withKeyLock(k, async () => {
      await guard();
      return this.appendUnlocked(k, entries);
    });
  }

  async read(runId: string, stepId: string): Promise<BufferedEntry[]> {
    const k = this.key(runId, stepId);
    return this.withKeyLock(k, async () => this.buffers.get(k) ?? []);
  }

  async delete(runId: string, stepId: string): Promise<void> {
    const k = this.key(runId, stepId);
    await this.withKeyLock(k, async () => {
      this.buffers.delete(k);
    });
  }

  /** guard runs INSIDE the same per-key critical section `appendFenced` uses, immediately before
   *  the delete — see the interface doc for the full guard contract. Returns the number of
   *  entries actually deleted (0 = buffer already absent; the guard still ran first). */
  async deleteFenced(runId: string, stepId: string, guard: () => Promise<void>): Promise<number> {
    const k = this.key(runId, stepId);
    return this.withKeyLock(k, async () => {
      await guard();
      const existing = this.buffers.get(k);
      this.buffers.delete(k);
      return existing?.length ?? 0;
    });
  }

  async deleteAllForRun(runId: string, _dirEntries?: readonly string[]): Promise<void> {
    const prefix = `${runId}:`;
    const keys = [...this.buffers.keys()].filter((k) => k.startsWith(prefix));
    for (const k of keys) {
      await this.withKeyLock(k, async () => {
        this.buffers.delete(k);
      });
    }
  }

  /** guard is RE-INVOKED inside EACH per-(runId, stepId) critical section, immediately before
   *  that key's delete — see the interface doc for the full guard contract, including the
   *  zero-match-sweep invocation requirement (handled below: the guard still runs at least once
   *  even when this run has no buffers at all). */
  async deleteAllForRunFenced(
    runId: string,
    guard: () => Promise<void>,
    _dirEntries?: readonly string[],
  ): Promise<void> {
    const prefix = `${runId}:`;
    const keys = [...this.buffers.keys()].filter((k) => k.startsWith(prefix));
    if (keys.length === 0) {
      await guard();
      return;
    }
    for (const k of keys) {
      await this.withKeyLock(k, async () => {
        await guard();
        this.buffers.delete(k);
      });
    }
  }

  /** Returns each in-memory buffer for the run, keyed by stepId, as its stored `BufferedEntry[]`
   *  (already-flattened individual entries — this store's own natural shape; see `append`).
   *  Lock-free point-in-time diagnostic, matching #159's shipped `export`/`readAllForRun` posture
   *  — deliberately NOT serialized through the per-key mutex (see D3 residual 9). */
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
