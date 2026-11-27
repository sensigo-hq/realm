// memory-store.ts — gap 3 (memory across runs), unit 2a: the memory row, declared in core.
//
// Memory lives in its own table, written in the same transaction as the run's evidence. Every store
// derives that table's rows the same way: core declares the row, the port a store implements, and
// ONE pure function, `memoryRowsOf`, that each store calls inside its write transaction (the
// callback store's pattern, `callbackRowOf`). A second write path kept in step by hand would leave a
// store's memory silently empty. No store implements the port yet, and nothing reads a row.
//
// `memoryRowsOf` checks every stamp again, whatever wrote it: an imported run's entries are not
// checked strictly at import, and a masked export keeps mask markers in a key, so a masked key would
// let two customers share a row. It reads only its arguments: no clock, no store, no environment.
import { isStoredInstant, parseStamp } from '../engine/instants.js';
import { REMEMBER_KEY_PART_MAX_BYTES, REMEMBER_VALUE_MAX_BYTES } from '../engine/remember-stamp.js';
import { markersIn } from '../utils/redaction.js';
import { NAME_PATTERN, REMEMBER_KEEP_DAYS_MAX } from '../workflow/remember-block.js';
import { hashParams } from './params-hash.js';

/**
 * One memory row: what one evidence entry remembered for later runs, as a store keeps it.
 *
 * @remarks
 * A store must write a run's rows in the same transaction as the run's evidence, and never change
 * one. The row holds the value and the supplier itself, read from the run's evidence when the row
 * is derived (a gate answer's supplier from the entry its question opened on), so it needs no
 * other part of the run. Times are ISO 8601 in `toISOString()`'s form.
 * @beta
 */
export interface MemoryRow {
  /** The run whose entry remembered it. */
  readonly run_id: string;
  /** The entry's place in the run's evidence, from 0; with `run_id`, the row's identity. */
  readonly seq: number;
  /** The run's workflow. */
  readonly workflow_id: string;
  /** The run's workflow version. */
  readonly workflow_version: number;
  /** The step that remembered it: the entry's `step_id`. */
  readonly step: string;
  /** The memory's name: the stamp's `as`. */
  readonly memory: string;
  /** The key's named parts as text, in name order. */
  readonly key: Readonly<Record<string, string>>;
  /** The sha256 hex of the key's canonical JSON: two keys with the same parts hash alike. */
  readonly key_hash: string;
  /** When the entry was written: its `completed_at`. */
  readonly at: string;
  /** When the row stops counting: `at` plus the step's `keep_days`. */
  readonly expires_at: string;
  /** A gated step's choice, on the row its answer wrote. */
  readonly choice?: string;
  /**
   * Who supplied the writing entry's output (`agent`), as stored; for a gate answer, the supplier of
   * the entry its question opened on. A later Realm may write another word.
   */
  readonly supplied_by?: string;
  /** What is remembered: the stamp's `value`, or the entry's own output when the stamp has none. */
  readonly value: Readonly<Record<string, unknown>>;
}

/**
 * A store's memory: the rows it derived from its runs' `remembered` stamps.
 * @beta
 */
export interface MemoryStore {
  /** One run's memory rows, in `seq` order; `[]` for a run with none. It reads no clock. */
  rowsOfRun(runId: string): Promise<MemoryRow[]>;
}

/**
 * A forget marker: `memory`'s rows under `key_hash` written at or before `forgotten_at` are never
 * derived again.
 * @internal
 */
export interface MemoryForgetMarker {
  readonly memory: string;
  readonly key_hash: string;
  readonly forgotten_at: string;
}

/**
 * A memory's horizon: its rows written at or before `through` are never derived again.
 * @internal
 */
export interface MemoryHorizon {
  readonly memory: string;
  readonly through: string;
}

/**
 * Why `memoryRowsOf` derived no row for an entry: its item cannot be read, its key was forgotten,
 * it was written before its memory's horizon, or its time had passed by `now`.
 * @internal
 */
export type MemoryRowSkipReason = 'invalid' | 'forgotten' | 'before_horizon' | 'expired';

/**
 * What `memoryRowsOf` reads. `evidence` is the run's whole evidence after the write, each entry's
 * `seq` its place in it; rows are derived only from `fromSeq` on (the count stored before the write,
 * 0 at an import). `now` is a reading the caller took; without it, no row is judged expired.
 * @internal
 */
export interface MemoryRowsInput {
  readonly workflowId: string;
  readonly workflowVersion: number;
  readonly runId: string;
  readonly evidence: readonly unknown[];
  readonly fromSeq: number;
  readonly forgotten: readonly MemoryForgetMarker[];
  readonly horizons: readonly MemoryHorizon[];
  readonly now?: Date;
}

/**
 * The rows `memoryRowsOf` derived, and each remembered entry it derived none for, in entry order.
 * @internal
 */
export interface MemoryRowsResult {
  readonly rows: MemoryRow[];
  readonly skipped: { readonly seq: number; readonly reason: MemoryRowSkipReason }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NAME = new RegExp(NAME_PATTERN);

/** A stored instant's milliseconds (core's one stamp parser); only called on a checked instant. */
const msOf = (stamp: string): number => parseStamp(stamp) ?? Number.NaN;

type Fields = Readonly<Record<string, unknown>>;

/** A plain object, or `undefined` for anything else (`null`, an array, a class's instance). */
function fieldsOf(value: unknown): Fields | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null ? (value as Fields) : undefined;
}

/** An object's own field, never an inherited one. */
function own(fields: Fields, name: string): unknown {
  return Object.hasOwn(fields, name) ? fields[name] : undefined;
}

/**
 * The key's hash, as a row and a forget marker hold it: the sha256 hex of its canonical JSON, names
 * sorted. `{ customer_id: '123' }` and `{ order_id: '123' }` hash apart; parts compare byte for byte.
 * @internal
 */
export function memoryKeyHashOf(key: Readonly<Record<string, string>>): string {
  return hashParams(key);
}

/** A key part the stamp could have kept: text, not blank, no mask marker, at most 1 KB in UTF-8. */
function isKeyPart(part: unknown): part is string {
  return (
    typeof part === 'string' &&
    part.trim() !== '' &&
    markersIn(part).length === 0 &&
    Buffer.byteLength(part, 'utf8') <= REMEMBER_KEY_PART_MAX_BYTES
  );
}

/**
 * The supplier of the entry at `seq`: its own `supplied_by`; for a gate answer, which never carries
 * one, that of the step's last earlier entry that is not a gate answer, the entry its question
 * opened on (the stamp's own lookup for a defaulted answer).
 */
function supplierOf(evidence: readonly unknown[], seq: number, entry: Fields): unknown {
  if (own(entry, 'kind') !== 'gate_response') return own(entry, 'supplied_by');
  for (let i = seq - 1; i >= 0; i -= 1) {
    const prior = fieldsOf(evidence[i]);
    if (prior === undefined || own(prior, 'step_id') !== own(entry, 'step_id')) continue;
    if (own(prior, 'kind') === 'gate_response') continue;
    return own(prior, 'supplied_by');
  }
  return undefined;
}

/** The row a remembered item gives, or `undefined` when any part of it cannot be read. */
function readableRow(
  input: MemoryRowsInput,
  seq: number,
  entry: Fields,
  item: Fields,
): MemoryRow | undefined {
  const as = own(item, 'as');
  const parts = fieldsOf(own(item, 'key'));
  const choice = own(item, 'choice');
  const step = own(entry, 'step_id');
  const at = own(entry, 'completed_at');
  const expiresAt = own(item, 'expires_at');
  const declared = own(item, 'value');
  const value = fieldsOf(declared !== undefined ? declared : own(entry, 'output_summary'));
  const supplier = supplierOf(input.evidence, seq, entry);
  if (typeof as !== 'string' || !NAME.test(as) || parts === undefined) return undefined;
  const names = Object.keys(parts).sort();
  if (names.length === 0) return undefined;
  if (!names.every((name) => NAME.test(name) && isKeyPart(parts[name]))) return undefined;
  if (choice !== undefined && typeof choice !== 'string') return undefined;
  if (typeof step !== 'string' || !isStoredInstant(at) || !isStoredInstant(expiresAt)) {
    return undefined;
  }
  // The stamp's own rule: `expires_at` is `completed_at` plus a whole `keep_days`, 1 to 3,650.
  const days = (msOf(expiresAt) - msOf(at)) / DAY_MS;
  if (!Number.isInteger(days) || days < 1 || days > REMEMBER_KEEP_DAYS_MAX) return undefined;
  if (value === undefined) return undefined;
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > REMEMBER_VALUE_MAX_BYTES) return undefined;
  if (supplier !== undefined && typeof supplier !== 'string') return undefined;
  const key = Object.fromEntries(names.map((name) => [name, parts[name] as string]));
  return {
    run_id: input.runId,
    seq,
    workflow_id: input.workflowId,
    workflow_version: input.workflowVersion,
    step,
    memory: as,
    key,
    key_hash: memoryKeyHashOf(key),
    at,
    expires_at: expiresAt,
    ...(choice !== undefined ? { choice } : {}),
    ...(supplier !== undefined ? { supplied_by: supplier } : {}),
    value,
  };
}

/** Whether a marker's or a horizon's time is before `at`; one that is not a stored instant never
 *  is, so it covers every row of its memory (it fails closed). */
function before(mark: unknown, at: string): boolean {
  return isStoredInstant(mark) && msOf(mark) < msOf(at);
}

/** One entry's row, the reason it gives none, or `undefined` when it remembered nothing. */
function judged(input: MemoryRowsInput, seq: number): MemoryRow | MemoryRowSkipReason | undefined {
  const entry = fieldsOf(input.evidence[seq]);
  if (entry === undefined) return 'invalid';
  const stamp = own(entry, 'remembered');
  if (stamp === undefined) return undefined;
  const item = fieldsOf(stamp);
  if (item !== undefined && Object.hasOwn(item, 'not_remembered')) return undefined;
  const row = item === undefined ? undefined : readableRow(input, seq, entry, item);
  if (row === undefined) return 'invalid';
  const { memory, key_hash, at } = row;
  if (
    input.forgotten.some(
      (m) => m.memory === memory && m.key_hash === key_hash && !before(m.forgotten_at, at),
    )
  ) {
    return 'forgotten';
  }
  if (input.horizons.some((h) => h.memory === memory && !before(h.through, at))) {
    return 'before_horizon';
  }
  if (input.now !== undefined && msOf(row.expires_at) <= input.now.getTime()) return 'expired';
  return row;
}

/**
 * The memory rows a write's new evidence entries give, and why each remembered entry that gives none
 * was skipped. Every store calls it inside the transaction that writes the entries.
 *
 * @remarks
 * Each entry is judged by the first rule that holds: not an object, skipped `invalid`; no
 * `remembered`, or a stamp that remembered nothing, nothing; an item that cannot be read (a name, a
 * key part, a time, the value, the supplier), `invalid`; its memory and key forgotten at or after
 * its time, `forgotten`; its memory's horizon at or after its time, `before_horizon`; `now` given
 * and its `expires_at` at or before it, `expired`. Otherwise one row. Two entries with the same
 * memory and key give two rows. It never throws, whatever `evidence` holds.
 * @internal
 */
export function memoryRowsOf(input: MemoryRowsInput): MemoryRowsResult {
  const rows: MemoryRow[] = [];
  const skipped: { seq: number; reason: MemoryRowSkipReason }[] = [];
  for (let seq = input.fromSeq; seq < input.evidence.length; seq += 1) {
    let outcome: MemoryRow | MemoryRowSkipReason | undefined;
    try {
      outcome = judged(input, seq);
    } catch {
      outcome = 'invalid';
    }
    if (typeof outcome === 'string') skipped.push({ seq, reason: outcome });
    else if (outcome !== undefined) rows.push(outcome);
  }
  return { rows, skipped };
}
