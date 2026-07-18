// trace-buffer-store.ts — Buffer store interface for incremental trace ingestion (B-lite).
import type { AgentTraceEntry } from '../types/run-record.js';
import { WorkflowError } from '../types/workflow-error.js';

/**
 * The store-layer capability ladder (issue #197 PR-1, design record `plans/issue-197-design.md`
 * §3). Implication runs **upward-requires-downward ONLY**: `writer_nonce_carriage` requires
 * `seal`; `seal` requires the fenced trio (issue #207). **The fenced trio ALONE stays fully
 * legal** — a store declaring neither rung is still a fully conforming implementation (the
 * shipped realm-cloud Postgres state; non-seal trio stores keep the #207 destructive-drain
 * posture forever, not a transitional gap). `TraceBufferStore.traceCapabilities` below is the
 * declaration; `storeDeclaresSeal`/`storeDeclaresNonceCarriage`/`validateTraceCapabilities`
 * (this file) are the ONLY authoritative way to check a rung — no ad-hoc `typeof` checks for
 * these two rungs anywhere else in the codebase (TCK, tools, or engine).
 */
export type TraceCapability = 'seal' | 'writer_nonce_carriage';

/** Outcome of `sealFenced` (issue #197 PR-1, the `seal` rung — see `TraceBufferStore.sealFenced`
 *  for the full contract). */
export type SealResult =
  | { sealed: true }
  | {
      sealed: false;
      /** `'absent'`: no live WAL existed for (runId, stepId) at all — #183 absence-is-success,
       *  not a failure. `'capped'`: this key already holds `SEALED_ARTIFACTS_LIMIT_PER_STEP`
       *  sealed artifacts — the caller must fall back to the existing destructive drain (bounded,
       *  loud, never silent eviction of a sealed artifact to make room). */
      reason: 'absent' | 'capped';
    };

/**
 * One line of a WAL, as read back — live or sealed (issue #197 PR-1). Defined in CORE, not
 * mcp-server (where the fs store's own file-local `WalLine` type lives), because
 * `listSealedForRun`'s return type must be usable without any core-adjacent caller importing an
 * mcp-server-local type. The fs store's `WalLine` gains the identical optional `nonce` field and
 * stays structurally assignable to this type (never a separate, divergent shape).
 */
export interface SealedWalLine {
  ts: number;
  entries: AgentTraceEntry[];
  /** The writer nonce active when this line was appended, if any (issue #197 PR-1) — absent for
   *  a bare/anonymous append. NEVER fabricated for a line that was genuinely bare. */
  nonce?: string;
}

/** One sealed artifact for a single (runId, stepId) key — issue #197 PR-1, part of the `seal`
 *  rung. A key may accumulate several sealed artifacts (repeated reclaim/settle-time seals),
 *  distinguished by ascending `seq`. */
export interface SealedArtifact {
  step_id: string;
  /** Ascending, per-key sequence number (0-based) — distinguishes repeated seals of the same
   *  (runId, stepId) key from one another. */
  seq: number;
  lines: SealedWalLine[];
}

/**
 * Structured `BUFFER_FULL` refusal detail shape (issue #197 PR-1, design §5) — every
 * `TraceBufferStore.append`/`appendFenced` implementation populates this as the thrown
 * `WorkflowError`'s `details`. `scope` names which budget bound the refusal: `'writer'` (this
 * call's own writer — the nonce that made it, or ⊥ for a bare call — exceeded its per-writer
 * `BUFFER_LIMIT_COUNT`/`BUFFER_LIMIT_BYTES` share) or `'file'` (the whole-file, all-writers-combined
 * `BUFFER_BACKSTOP_COUNT`/`BUFFER_BACKSTOP_BYTES` ceiling). `binding_dimension` names which of the
 * two triples actually caused the refusal — `count`/`bytes` are ALWAYS both populated (a caller
 * can see the whole picture, not just the half that bound). `your_*`/`total_*` (file scope only)
 * are the occupancy evidence: this writer's own share vs. the whole file's combined share —
 * foreign share is stated as an observable FACT; crash causation for that foreign residue is
 * NEVER asserted (design §5's corrected message framing — a foreign writer's residue might be a
 * live concurrent step, not a crash).
 */
export interface BufferFullDetails {
  scope: 'writer' | 'file';
  binding_dimension: 'count' | 'bytes';
  count: { requested: number; used: number; limit: number };
  bytes: { requested: number; used: number; limit: number };
  your_count?: number;
  your_bytes?: number;
  total_count?: number;
  total_bytes?: number;
}

export interface AppendResult {
  /**
   * WRITER-scope numbers (issue #197 PR-1 re-documentation — values and meaning UNCHANGED for
   * bare-only traffic, the compat law, design §5): this call's own writer (the nonce that made
   * it, or ⊥ for a bare call) against the per-writer `BUFFER_LIMIT_COUNT`/`BUFFER_LIMIT_BYTES`
   * ceiling. An all-bare WAL has exactly one writer (⊥), so writer-scope and file-scope coincide
   * there and these fields are numerically IDENTICAL to before this capability existed.
   */
  buffer_count: number;
  buffer_bytes: number;
  limit_count: number;
  limit_bytes: number;
  final_limit_entries: number;
  final_limit_bytes: number;
  /**
   * Whole-FILE scope numbers (issue #197 PR-1, additive) — populated ONLY by a store that
   * declares `writer_nonce_carriage` (a non-declaring store never sets these; they stay
   * `undefined`, never fabricated as `0`). Ride the new `BUFFER_BACKSTOP_COUNT`/
   * `BUFFER_BACKSTOP_BYTES` ceiling — combined usage across every writer sharing this key.
   */
  file_count?: number;
  file_limit_count?: number;
  file_bytes?: number;
  file_limit_bytes?: number;
}

/**
 * Optional trailing options bag for `append`/`appendFenced` (issue #197 PR-1, the
 * `writer_nonce_carriage` rung). Declaration-only: adding this parameter is NOT a separate
 * method-presence check in `storeDeclaresNonceCarriage` (there is no way to detect "did this
 * store implementation read the options bag" other than declared capability + behavior) — a
 * non-declaring implementation is contractually required to IGNORE it, never throw or otherwise
 * error on receiving one; the tool layer (PR-2) is responsible for never passing a nonce to a
 * non-declaring store.
 */
export interface AppendOptions {
  /** Client-minted, opaque per-step-attempt writer identity. Absent ⇒ the bare/anonymous writer
   *  class (⊥) — today's behavior, byte-identical. NEVER validated/shaped by the store itself
   *  (opaque string, store-agnostic) — protocol-level shape validation is a PR-2/tool-layer
   *  concern (design §6). */
  writerNonce?: string;
}

export interface TraceBufferStore {
  /**
   * Declares which of the two optional capability-ladder rungs (issue #197 PR-1) this store
   * implements: `'seal'` and/or `'writer_nonce_carriage'`. See `TraceCapability`'s own doc for
   * the ladder rule (carriage requires seal requires the fenced trio; trio alone stays legal).
   *
   * **Immutability**: this set MUST NOT change after construction — a reader may read it once and
   * cache the result forever (the TCK's STRUCTURAL law asserts two reads are content-identical).
   *
   * **Authoritative only in conjunction with method presence**: a declared rung whose required
   * methods are NOT actually present (or vice versa) is a construction-time defect, not a runtime
   * condition — see `validateTraceCapabilities`. Absent entirely (`undefined`) is equivalent to
   * declaring neither rung (the honest floor — trio-alone, or no fenced trio at all, both legal).
   */
  readonly traceCapabilities?: ReadonlySet<TraceCapability>;

  /**
   * Appends normalized entries to the buffer for (runId, stepId).
   * Each entry is per-entry normalized at append time (reserved prefix drop, field caps).
   * Batch timestamp (_internalTs) is assigned at write time.
   * Throws BUFFER_FULL WorkflowError if the WAL limit would be exceeded (issue #197 PR-1: see
   * `BufferFullDetails` for the refusal's structured `details` shape).
   *
   * @param options Optional trailing options bag (issue #197 PR-1) — see `AppendOptions`.
   */
  append(
    runId: string,
    stepId: string,
    entries: AgentTraceEntry[],
    options?: AppendOptions,
  ): Promise<AppendResult>;

  /**
   * Reads all buffered entries for (runId, stepId) with their batch timestamps attached.
   * Returns empty array if no buffer exists.
   * Entries carry _internalTs for ordering at finalization, and (issue #197 PR-1) an optional
   * `_nonce` re-attached from the line that carried them — see `BufferedEntry._nonce`.
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
    options?: AppendOptions,
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
   * match `runId` at all, `guard` is still consulted at least once — the scan (resolving which
   * files match) necessarily runs first, then the guard is invoked at least once even for that
   * empty result. If it throws, the sweep rejects with that error exactly as it would for a
   * non-empty sweep — propagation is UNIFORM across the zero-match and non-empty cases (the TCK
   * asserts rejection here, not merely invocation count: a refusing guard makes even a zero-match
   * sweep reject). A guard rejection (e.g. a
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

  /**
   * **`sealFenced` (issue #197 PR-1, the `seal` rung — design §4).** Atomically retires the
   * ENTIRE live WAL for (runId, stepId) to a sealed artifact, under the SAME per-key critical
   * section the fenced trio uses. `guard` runs IN-CS, immediately BEFORE the move (same guard
   * contract as the trio: at-least-once invocation, completes before the mutating effect, exactly
   * one lock-free `runStore.get`, never acquires its own lock, a rejection propagates UNWRAPPED —
   * nothing is moved).
   *
   * Semantics:
   * - Absent live WAL ⇒ `{sealed: false, reason: 'absent'}` — #183 absence-is-success, not an
   *   error.
   * - This key already at the per-key seal-budget cap (`SEALED_ARTIFACTS_LIMIT_PER_STEP`) ⇒
   *   `{sealed: false, reason: 'capped'}` — the caller falls back to the existing destructive
   *   drain (`deleteFenced`); bounded, loud, never a silent eviction of an existing sealed
   *   artifact to make room.
   * - Otherwise ⇒ raw bytes move VERBATIM to the sealed artifact — no parse, no copy, no
   *   truncation, no dedup. A torn/corrupt trailing line moves as bytes too (readers of the
   *   sealed artifact skip + warn on it, mirroring the live WAL reader's own #183 corruption
   *   posture) ⇒ `{sealed: true}`.
   * - Any OTHER I/O errno (not absence) ⇒ a typed throw (#183) — the caller warns; this is
   *   residue-not-loss (the live WAL is left exactly as it was; nothing moved).
   *
   * A store implements this ONLY as part of declaring the `seal` rung (`storeDeclaresSeal`) —
   * requires the full fenced trio to already be declared (the ladder).
   */
  sealFenced?(runId: string, stepId: string, guard: () => Promise<void>): Promise<SealResult>;

  /**
   * **`listSealedForRun` (issue #197 PR-1, part of the `seal` rung — design §4).** Returns every
   * sealed artifact for `runId`, across all steps — descriptors plus their parsed lines
   * (torn-tolerant: a corrupt line inside a sealed artifact is skipped + a loud warning emitted,
   * mirroring the live WAL reader's own discipline; the corrupt bytes stay on disk untouched).
   * Absence of any sealed artifacts for this run ⇒ `[]`, never a throw. Lock-free, point-in-time
   * (mirrors `readAllForRun`'s own posture, issue #159) — never mutates.
   */
  listSealedForRun?(runId: string): Promise<SealedArtifact[]>;
}

/** An AgentTraceEntry extended with engine-assigned ordering timestamp (milliseconds), and
 *  (issue #197 PR-1) the writer nonce that carried it, if any — re-attached from the line the
 *  entry was originally appended in. NEVER fabricated for a genuinely bare line. */
export interface BufferedEntry extends AgentTraceEntry {
  _internalTs: number;
  _nonce?: string;
}

/** PER-WRITER budget (issue #197 PR-1 re-documentation — value unchanged): the ceiling for ONE
 *  writer's own share of a (runId, stepId) buffer — the nonce that made the call, or ⊥ (the
 *  bare/anonymous writer class) for a call with no nonce. An all-bare WAL has exactly one writer
 *  (⊥), so this is the ONLY ceiling that can ever bind there — byte-identity with pre-#197
 *  behavior is emergent from that fact, not a special case. */
export const BUFFER_LIMIT_COUNT = 200;
/** See `BUFFER_LIMIT_COUNT` — the per-writer BYTE ceiling. */
export const BUFFER_LIMIT_BYTES = 100 * 1024; // 100 KB
export const FINAL_LIMIT_ENTRIES = 100;
export const FINAL_LIMIT_BYTES = 50 * 1024; // 50 KB (must match MAX_BYTES in trace-normalizer.ts)

/** Whole-FILE backstop (issue #197 PR-1, additive, design §5): the ceiling across EVERY writer
 *  sharing a (runId, stepId) key combined, regardless of nonce — 2× the per-writer ceiling.
 *  Unconditional: enforced even on a store that hasn't seen a single nonced append, though it is
 *  UNREACHABLE in the all-bare case (the lone writer ⊥ already refuses at the per-writer ceiling,
 *  which is half the backstop — the backstop only ever binds when at least one OTHER writer's
 *  residue is sharing the file). */
export const BUFFER_BACKSTOP_COUNT = 2 * BUFFER_LIMIT_COUNT;
/** See `BUFFER_BACKSTOP_COUNT` — the whole-file BYTE backstop. */
export const BUFFER_BACKSTOP_BYTES = 2 * BUFFER_LIMIT_BYTES;

/** Per-(runId, stepId) seal budget (issue #197 PR-1, the `seal` rung, design §4): the maximum
 *  number of sealed artifacts one key may accumulate. On reaching the cap, `sealFenced` returns
 *  `{sealed: false, reason: 'capped'}` — the caller falls back to the existing destructive drain
 *  (`deleteFenced`), bounded and loud, rather than silently evicting an existing sealed artifact
 *  to make room. */
export const SEALED_ARTIFACTS_LIMIT_PER_STEP = 8;

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

// ---------------------------------------------------------------------------------------------
// Capability-ladder predicates (issue #197 PR-1, design §3) — the ONLY authoritative way to check
// a rung. TCK, tools, and engine (PR-2) must all use these; no ad-hoc `typeof` checks for the new
// rungs anywhere else. Each predicate = declared in `traceCapabilities` AND every method that
// rung (and every rung beneath it) requires is actually present — declaration alone, or method
// presence alone, is never sufficient.
// ---------------------------------------------------------------------------------------------

/**
 * True iff `store` both DECLARES the `seal` rung (in `traceCapabilities`) AND actually implements
 * every method that rung requires: the full fenced trio (`appendFenced`/`deleteFenced`/
 * `deleteAllForRunFenced`, issue #207) PLUS `sealFenced` PLUS `listSealedForRun` (the ladder: seal
 * requires the trio). This is the ONLY authoritative `seal` predicate.
 */
export function storeDeclaresSeal(store: TraceBufferStore): boolean {
  const declared = store.traceCapabilities?.has('seal') ?? false;
  const methodsPresent =
    typeof store.appendFenced === 'function' &&
    typeof store.deleteFenced === 'function' &&
    typeof store.deleteAllForRunFenced === 'function' &&
    typeof store.sealFenced === 'function' &&
    typeof store.listSealedForRun === 'function';
  return declared && methodsPresent;
}

/**
 * True iff `store` both DECLARES `writer_nonce_carriage` (in `traceCapabilities`) AND satisfies
 * `storeDeclaresSeal` (the ladder: carriage requires seal requires the trio). Carriage itself
 * adds no NEW required method — the `options` bag on `append`/`appendFenced` is declaration-only
 * (there is no way to detect "does this implementation actually read the options bag" other than
 * declared capability + behavior), so this predicate is exactly "declared AND seal holds". This
 * is the ONLY authoritative `writer_nonce_carriage` predicate.
 */
export function storeDeclaresNonceCarriage(store: TraceBufferStore): boolean {
  const declared = store.traceCapabilities?.has('writer_nonce_carriage') ?? false;
  return declared && storeDeclaresSeal(store);
}

/**
 * Wiring-time validation MECHANISM (issue #197 PR-1, design §3/§12 — INVOKING this at the
 * injection seams, e.g. `server.ts`/CLI executors, is deliberately PR-2's job, not this one's).
 * Typed fail-loud (a `TRACE_CAPABILITY_INCONSISTENT` `WorkflowError`) when a rung is DECLARED but
 * its predicate does not hold (declared-but-inconsistent — a construction-time wiring defect,
 * never a runtime condition worth retrying). Silent success when a rung is simply undeclared —
 * the honest floor: trio-alone, or no capabilities at all, are both fully legal and never an
 * error.
 */
export function validateTraceCapabilities(store: TraceBufferStore): void {
  const caps = store.traceCapabilities;
  if (caps === undefined) return;

  if (caps.has('seal') && !storeDeclaresSeal(store)) {
    throw new WorkflowError(
      "TraceBufferStore declares the 'seal' capability but does not implement all of its " +
        'required methods (the fenced trio + sealFenced + listSealedForRun) — declared but ' +
        'inconsistent.',
      {
        code: 'TRACE_CAPABILITY_INCONSISTENT',
        category: 'ENGINE',
        agentAction: 'stop',
        retryable: false,
        details: { capability: 'seal' },
      },
    );
  }

  if (caps.has('writer_nonce_carriage') && !storeDeclaresNonceCarriage(store)) {
    throw new WorkflowError(
      "TraceBufferStore declares the 'writer_nonce_carriage' capability but its 'seal' " +
        'predicate does not hold (carriage requires seal requires the fenced trio) — declared ' +
        'but inconsistent.',
      {
        code: 'TRACE_CAPABILITY_INCONSISTENT',
        category: 'ENGINE',
        agentAction: 'stop',
        retryable: false,
        details: { capability: 'writer_nonce_carriage' },
      },
    );
  }
}

/**
 * Pure per-writer + whole-file budget decision (issue #197 PR-1, design §5) — shared by every
 * `TraceBufferStore` implementation enforcing this pair, so the decision logic and the
 * `BufferFullDetails` shape live in exactly ONE place rather than being independently
 * (and riskily divergently) reimplemented per store. Deliberately takes BEFORE-and-AFTER pairs
 * (rather than a "delta" this call would add) because the two shipped stores compute "after"
 * differently and both must stay exact: the fs store's JSONL format is genuinely additive (byte
 * delta = the one new line's own serialized size), but the in-memory store's byte-identity
 * constraint requires re-serializing the WHOLE flattened array exactly as its pre-#197 formula
 * always did — forcing a shared "delta" abstraction on top of that would risk being byte-inexact
 * for one of the two stores. Returns `undefined` when neither ceiling would be exceeded.
 *
 * Writer scope is checked FIRST: if the appender's own share alone would exceed the per-writer
 * ceiling, that is what gets reported — a caller whose own share already exceeds the (smaller)
 * per-writer ceiling should be told that specifically, not the (less actionable, and in that
 * case also necessarily true) whole-file ceiling. This ordering is also what makes the compat
 * law hold: an all-bare file's lone writer (⊥) hits `scope:'writer'` at exactly today's legacy
 * limits — the file backstop (2×) is arithmetically unreachable for a single writer alone.
 */
export function checkBufferBudget(params: {
  writerCountBefore: number;
  writerBytesBefore: number;
  writerCountAfter: number;
  writerBytesAfter: number;
  fileCountBefore: number;
  fileBytesBefore: number;
  fileCountAfter: number;
  fileBytesAfter: number;
}): BufferFullDetails | undefined {
  const writerCountOver = params.writerCountAfter > BUFFER_LIMIT_COUNT;
  const writerBytesOver = params.writerBytesAfter > BUFFER_LIMIT_BYTES;
  if (writerCountOver || writerBytesOver) {
    return {
      scope: 'writer',
      binding_dimension: writerCountOver ? 'count' : 'bytes',
      count: {
        requested: params.writerCountAfter,
        used: params.writerCountBefore,
        limit: BUFFER_LIMIT_COUNT,
      },
      bytes: {
        requested: params.writerBytesAfter,
        used: params.writerBytesBefore,
        limit: BUFFER_LIMIT_BYTES,
      },
    };
  }

  const fileCountOver = params.fileCountAfter > BUFFER_BACKSTOP_COUNT;
  const fileBytesOver = params.fileBytesAfter > BUFFER_BACKSTOP_BYTES;
  if (fileCountOver || fileBytesOver) {
    return {
      scope: 'file',
      binding_dimension: fileCountOver ? 'count' : 'bytes',
      count: {
        requested: params.fileCountAfter,
        used: params.fileCountBefore,
        limit: BUFFER_BACKSTOP_COUNT,
      },
      bytes: {
        requested: params.fileBytesAfter,
        used: params.fileBytesBefore,
        limit: BUFFER_BACKSTOP_BYTES,
      },
      your_count: params.writerCountAfter,
      your_bytes: params.writerBytesAfter,
      total_count: params.fileCountAfter,
      total_bytes: params.fileBytesAfter,
    };
  }

  return undefined;
}

/**
 * Builds the `BUFFER_FULL` `WorkflowError` from a `BufferFullDetails` (issue #197 PR-1, design
 * §5) — the SAME message wording, error code, category, and `agentAction` every store uses, so
 * the only thing that ever varies between stores is which concrete numbers went into `details`.
 * Guidance wording is deliberate: foreign share (file scope's `your_*`/`total_*`) is stated as an
 * observable FACT; crash causation for that foreign residue is NEVER asserted (design §5's
 * corrected framing — foreign residue might be a live concurrent writer, not a crash). Code stays
 * `BUFFER_FULL`, category `ENGINE`, `agentAction: 'provide_input'` — unchanged from before this
 * capability existed.
 */
export function bufferFullError(details: BufferFullDetails): WorkflowError {
  const scopeClause =
    details.scope === 'writer'
      ? `this writer's own share of the buffer (${details.binding_dimension} ceiling reached)`
      : `the whole-file ${details.binding_dimension} ceiling (${details.total_count ?? 0} ` +
        `entries / ${details.total_bytes ?? 0} bytes combined across every writer sharing this ` +
        `step; this writer's own share is ${details.your_count ?? 0} entries / ` +
        `${details.your_bytes ?? 0} bytes)`;
  return new WorkflowError(
    `Trace buffer full for step: ${scopeClause} reached. Settle the step to drain residue — ` +
      'it is preserved (sealed) where the store supports it, and your options.trace always ' +
      'survives.',
    {
      code: 'BUFFER_FULL',
      category: 'ENGINE',
      agentAction: 'provide_input',
      retryable: false,
      details: { ...details },
    },
  );
}

/**
 * Flattens WAL batches (`{ts, entries, nonce?}`, issue #197 PR-1's internal batch shape — see
 * `SealedWalLine`) into the read-back `BufferedEntry[]` shape, in batch order: `_internalTs` from
 * the batch's `ts`; `_nonce` re-attached ONLY when the batch actually carried one (never
 * fabricated for a bare batch — the key byte-identity property: a flattened all-bare batch list
 * produces EXACTLY the same shape/bytes as the pre-#197 flat representation always did).
 */
export function flattenWalBatches(batches: readonly SealedWalLine[]): BufferedEntry[] {
  return batches.flatMap((batch) =>
    batch.entries.map((entry) => ({
      ...entry,
      _internalTs: batch.ts,
      ...(batch.nonce !== undefined ? { _nonce: batch.nonce } : {}),
    })),
  );
}

/**
 * In-memory TraceBufferStore for use in tests and non-persistent environments.
 * Entries are lost on process restart (no file I/O).
 *
 * Declares the fenced trio (issue #207): `append`, `read`, `delete`, and `deleteAllForRun` all
 * serialize on the SAME per-(runId, stepId) critical section `appendFenced`/`deleteFenced` use,
 * via a per-key async mutex (a promise-chain map) — every one of the operations for a given key
 * runs strictly after the previous operation on THAT SAME key has settled (success or failure).
 * Liveness posture: a hung guard hangs only that key's chain — a different key's chain is
 * untouched and proceeds normally (this per-key granularity is load-bearing; see the TCK's
 * PER_KEY_INDEPENDENCE law). The chain map's entry for a key is deleted once its own tail
 * settles and no newer call has chained after it, so an idle key holds no Map entry (no leak).
 *
 * Issue #197 PR-1 additionally declares BOTH capability-ladder rungs (`seal` and
 * `writer_nonce_carriage`, `traceCapabilities`). The live-WAL internal representation is
 * BATCH-preserving (`Map<string, SealedWalLine[]>`, one entry per `append`/`appendFenced` call) —
 * NOT flattened — because `sealFenced` must be able to retire a key's exact batch history as one
 * unit, and each batch's own (possibly absent) writer nonce must survive independently for
 * carriage/budget partitioning. Every flattening surface (`read`, `readAllForRun`, `deleteFenced`'s
 * count, the byte-budget arithmetic) derives its answer from this representation via
 * `flattenWalBatches` (or direct batch arithmetic over it), reproducing the exact pre-#197
 * observable shape and byte formula for all-bare traffic — see `appendUnlocked`.
 */
export class InMemoryTraceBufferStore implements TraceBufferStore {
  readonly traceCapabilities: ReadonlySet<TraceCapability> = new Set([
    'seal',
    'writer_nonce_carriage',
  ]);

  // Live WAL per key, in append order — see the class doc for why this stays batch-shaped.
  private buffers = new Map<string, SealedWalLine[]>();
  // Sealed artifacts per key, in ascending `seq` order (issue #197 PR-1, the `seal` rung).
  private sealed = new Map<string, SealedArtifact[]>();
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

  /**
   * Count + bytes for exactly the batches belonging to `writerNonce` (`undefined` = ⊥, the bare
   * writer class) — computed by flattening JUST that writer's own batches and re-stringifying,
   * so the byte number for a single-writer (all-bare) file is bit-for-bit the old whole-array
   * formula. Equality is plain `===` over `batch.nonce ?? undefined`, which implements the
   * design's `adopted(line) ⇔ line.nonce ≡ claimant.nonce, with absent ≡ absent` rule with no
   * special-casing (`undefined === undefined` is `true`).
   */
  private partitionStats(
    batches: readonly SealedWalLine[],
    writerNonce: string | undefined,
  ): { count: number; bytes: number } {
    const own = batches.filter((b) => (b.nonce ?? undefined) === writerNonce);
    const flattened = flattenWalBatches(own);
    return { count: flattened.length, bytes: Buffer.byteLength(JSON.stringify(flattened)) };
  }

  /** Whole-file count + bytes across every writer combined — the pre-#197 formula, applied to
   *  the full batch list regardless of how many distinct writers contributed to it. */
  private fileStats(batches: readonly SealedWalLine[]): { count: number; bytes: number } {
    const flattened = flattenWalBatches(batches);
    return { count: flattened.length, bytes: Buffer.byteLength(JSON.stringify(flattened)) };
  }

  private appendUnlocked(
    k: string,
    entries: AgentTraceEntry[],
    writerNonce: string | undefined,
  ): AppendResult {
    const existingBatches = this.buffers.get(k) ?? [];
    const writerBefore = this.partitionStats(existingBatches, writerNonce);
    const fileBefore = this.fileStats(existingBatches);

    if (entries.length === 0) {
      return {
        buffer_count: writerBefore.count,
        buffer_bytes: writerBefore.bytes,
        limit_count: BUFFER_LIMIT_COUNT,
        limit_bytes: BUFFER_LIMIT_BYTES,
        final_limit_entries: FINAL_LIMIT_ENTRIES,
        final_limit_bytes: FINAL_LIMIT_BYTES,
        file_count: fileBefore.count,
        file_bytes: fileBefore.bytes,
        file_limit_count: BUFFER_BACKSTOP_COUNT,
        file_limit_bytes: BUFFER_BACKSTOP_BYTES,
      };
    }

    const ts = Date.now();
    const normalized: BufferedEntry[] = entries
      .map((e) => normalizeEntryForBuffer(e))
      .filter((e): e is AgentTraceEntry => e !== null)
      .map((e) => ({ ...e, _internalTs: ts }));

    const newBatch: SealedWalLine =
      writerNonce !== undefined
        ? { ts, entries: normalized, nonce: writerNonce }
        : { ts, entries: normalized };
    const proposedBatches = [...existingBatches, newBatch];

    const writerAfter = this.partitionStats(proposedBatches, writerNonce);
    const fileAfter = this.fileStats(proposedBatches);

    const overflow = checkBufferBudget({
      writerCountBefore: writerBefore.count,
      writerBytesBefore: writerBefore.bytes,
      writerCountAfter: writerAfter.count,
      writerBytesAfter: writerAfter.bytes,
      fileCountBefore: fileBefore.count,
      fileBytesBefore: fileBefore.bytes,
      fileCountAfter: fileAfter.count,
      fileBytesAfter: fileAfter.bytes,
    });
    if (overflow) {
      throw bufferFullError(overflow);
    }

    this.buffers.set(k, proposedBatches);
    return {
      buffer_count: writerAfter.count,
      buffer_bytes: writerAfter.bytes,
      limit_count: BUFFER_LIMIT_COUNT,
      limit_bytes: BUFFER_LIMIT_BYTES,
      final_limit_entries: FINAL_LIMIT_ENTRIES,
      final_limit_bytes: FINAL_LIMIT_BYTES,
      file_count: fileAfter.count,
      file_bytes: fileAfter.bytes,
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
    const k = this.key(runId, stepId);
    return this.withKeyLock(k, async () => this.appendUnlocked(k, entries, options?.writerNonce));
  }

  /** guard runs INSIDE the per-key critical section, immediately before the write — see the
   *  interface doc for the full guard contract. */
  async appendFenced(
    runId: string,
    stepId: string,
    entries: AgentTraceEntry[],
    guard: () => Promise<void>,
    options?: AppendOptions,
  ): Promise<AppendResult> {
    const k = this.key(runId, stepId);
    return this.withKeyLock(k, async () => {
      await guard();
      return this.appendUnlocked(k, entries, options?.writerNonce);
    });
  }

  async read(runId: string, stepId: string): Promise<BufferedEntry[]> {
    const k = this.key(runId, stepId);
    return this.withKeyLock(k, async () => flattenWalBatches(this.buffers.get(k) ?? []));
  }

  async delete(runId: string, stepId: string): Promise<void> {
    const k = this.key(runId, stepId);
    await this.withKeyLock(k, async () => {
      this.buffers.delete(k);
    });
  }

  /** guard runs INSIDE the same per-key critical section `appendFenced` uses, immediately before
   *  the delete — see the interface doc for the full guard contract. Returns the number of
   *  entries actually deleted, summed across every live batch (0 = buffer already absent; the
   *  guard still ran first). Sealed artifacts for this key are NOT touched — sealing exists
   *  precisely to move content out of this destructive drain's reach; only `deleteAllForRun*`
   *  (run-level bulk delete) also retires sealed artifacts. */
  async deleteFenced(runId: string, stepId: string, guard: () => Promise<void>): Promise<number> {
    const k = this.key(runId, stepId);
    return this.withKeyLock(k, async () => {
      await guard();
      const existing = this.buffers.get(k);
      this.buffers.delete(k);
      return existing !== undefined ? flattenWalBatches(existing).length : 0;
    });
  }

  async deleteAllForRun(runId: string, _dirEntries?: readonly string[]): Promise<void> {
    const prefix = `${runId}:`;
    const keys = new Set(
      [...this.buffers.keys(), ...this.sealed.keys()].filter((k) => k.startsWith(prefix)),
    );
    for (const k of keys) {
      await this.withKeyLock(k, async () => {
        this.buffers.delete(k);
        this.sealed.delete(k);
      });
    }
  }

  /** guard is RE-INVOKED inside EACH per-(runId, stepId) critical section, immediately before
   *  that key's delete — see the interface doc for the full guard contract, including the
   *  zero-match-sweep invocation requirement (handled below: the guard still runs at least once
   *  even when this run has no buffers at all). Sealed artifacts join this run-level bulk delete
   *  (design §4 — a sealed artifact is retained ONLY until its owning run itself is purged). */
  async deleteAllForRunFenced(
    runId: string,
    guard: () => Promise<void>,
    _dirEntries?: readonly string[],
  ): Promise<void> {
    const prefix = `${runId}:`;
    const keys = new Set(
      [...this.buffers.keys(), ...this.sealed.keys()].filter((k) => k.startsWith(prefix)),
    );
    if (keys.size === 0) {
      await guard();
      return;
    }
    for (const k of keys) {
      await this.withKeyLock(k, async () => {
        await guard();
        this.buffers.delete(k);
        this.sealed.delete(k);
      });
    }
  }

  /** guard runs INSIDE the per-key critical section, immediately before the seal-move — see the
   *  interface doc for the full contract. Atomically retires the ENTIRE live batch history for
   *  (runId, stepId) into a new sealed artifact (ascending `seq`), clearing the live buffer in
   *  the same step — the in-memory analogue of the fs store's no-clobber rename-based seal
   *  (there is no filesystem race to guard against here; the per-key mutex already serializes
   *  every operation on this key, so `seq` can simply be the next array index). */
  async sealFenced(runId: string, stepId: string, guard: () => Promise<void>): Promise<SealResult> {
    const k = this.key(runId, stepId);
    return this.withKeyLock(k, async () => {
      await guard();
      const live = this.buffers.get(k);
      if (live === undefined || live.length === 0) {
        return { sealed: false, reason: 'absent' };
      }
      const existingSealed = this.sealed.get(k) ?? [];
      if (existingSealed.length >= SEALED_ARTIFACTS_LIMIT_PER_STEP) {
        return { sealed: false, reason: 'capped' };
      }
      const artifact: SealedArtifact = { step_id: stepId, seq: existingSealed.length, lines: live };
      this.sealed.set(k, [...existingSealed, artifact]);
      this.buffers.delete(k);
      return { sealed: true };
    });
  }

  /** Lock-free point-in-time snapshot of every sealed artifact for a run, across all its steps —
   *  matches `readAllForRun`'s deliberately-unlocked posture (see D3 residual 9). */
  async listSealedForRun(runId: string): Promise<SealedArtifact[]> {
    const prefix = `${runId}:`;
    const result: SealedArtifact[] = [];
    for (const [k, artifacts] of this.sealed.entries()) {
      if (k.startsWith(prefix)) {
        result.push(...artifacts);
      }
    }
    return result;
  }

  /** Returns each in-memory LIVE buffer for the run, keyed by stepId, flattened to
   *  `BufferedEntry[]` (this store's own natural read shape; see `read`). Lock-free
   *  point-in-time diagnostic, matching #159's shipped `export`/`readAllForRun` posture —
   *  deliberately NOT serialized through the per-key mutex (see D3 residual 9). Sealed artifacts
   *  are NOT included (see `listSealedForRun`) — unchanged scope from before this capability
   *  existed; PR-2 decides how/whether call sites merge the two. */
  async readAllForRun(runId: string): Promise<Record<string, unknown[]>> {
    const result: Record<string, unknown[]> = {};
    const prefix = `${runId}:`;
    for (const [key, batches] of this.buffers.entries()) {
      if (key.startsWith(prefix)) {
        result[key.slice(prefix.length)] = flattenWalBatches(batches);
      }
    }
    return result;
  }
}
