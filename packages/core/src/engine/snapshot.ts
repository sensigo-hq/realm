// snapshot.ts — issue #729 PR-0 (D2 D-9, D3 A-9; #715 D6-16, D6-17, D6-18, D6-33, D6-59): one record
// and the reading it is judged at, built in ONE place, and the stamp a reply carries about it.
//
// Every judge of the ways (`composeWaysOn`, `admitWay`) takes a `Snapshot` — one value, so a record
// from one load is never judged at another load's reading (D6-17). The reading is taken BEFORE the
// load (D6-16): every statement made about the loaded copy is true at its `at`. #715 (b): the store
// takes that reading (`store.get` returns the Snapshot); `loadSnapshot` is `store.get`. The
// source-text witness: no `{ record, at }` literal is built outside this module — every Snapshot is
// built by `writtenSnapshot`.
import type { ListedRecord, RunRecord } from '../types/run-record.js';
import type { RunStore } from '../store/store-interface.js';
import { NO_LEASE_FACTS, type LeaseFacts } from '../store/lease-facts.js';
import type { DefinitionAbsence, LoadErrorCode } from './ways.js';

/**
 * One record and the reading it is judged at.
 * Built only by this module.
 * @public
 */
export interface Snapshot {
  readonly record: RunRecord;
  /** The clock reading taken BEFORE the record was loaded (D6-16), or the reading its write used. */
  readonly at: Date;
  /**
   * #729 CW-1b: what the store's lease port found about the leases of the record's in-progress
   * claims, observed after the read or write (`held` holds at the reading; `not_held` from the check,
   * which follows it in the same call). Present only when a claim names a lease and the store has a
   * lease port; read it through `leaseFactOf`, which reads a missing fact as `not_checked`.
   */
  readonly lease_facts?: LeaseFacts;
}

/**
 * One run and the reading it is judged at, as a listing of runs gives it: a {@link Snapshot}
 * whose record is a {@link ListedRecord}, with the model calls' texts left out. Every `Snapshot`
 * fits into it.
 * @public
 */
export interface ListedSnapshot {
  readonly record: ListedRecord;
  /** The clock reading taken before the record was loaded, as in a `Snapshot`. */
  readonly at: Date;
  /** The facts about the leases of the record's in-progress claims, as in a `Snapshot`. */
  readonly lease_facts?: LeaseFacts;
}

/** Gap 1, unit A0: the key a listing leaves out of each evidence entry and drive-failure entry. */
const MODEL_TEXT = 'model_text';

/** `entry` without `model_text`: a new object when it holds the key, else the entry itself. */
function withoutModelText<T extends object>(entry: T): T {
  if (!Object.prototype.hasOwnProperty.call(entry, MODEL_TEXT)) return entry;
  const copy = { ...entry } as Record<string, unknown>;
  delete copy[MODEL_TEXT];
  return copy as T;
}

/**
 * Gap 1, unit A0: `snapshot` as a listing of runs gives it, for a store with no `scanListed`. Each
 * evidence entry and each drive-failure entry that holds `model_text` is copied without it, into new
 * arrays and a new record; nothing is changed in place, because a store may hand out its own stored
 * objects (the in-memory store's `scan` does). The reading and the lease facts are kept.
 * @internal
 */
export function listedSnapshotOf(snapshot: Snapshot): ListedSnapshot {
  const record = snapshot.record;
  const failures = record.drive_failures;
  const listed: ListedRecord = {
    ...record,
    evidence: Array.isArray(record.evidence)
      ? record.evidence.map(withoutModelText)
      : record.evidence,
    ...(failures !== undefined && Array.isArray(failures.entries)
      ? { drive_failures: { ...failures, entries: failures.entries.map(withoutModelText) } }
      : {}),
  };
  return { ...snapshot, record: listed };
}

/**
 * Gap 1, unit A0: a listing's record as the ways engine judges it, for `classifyRunHealth`'s
 * `cannot_go_on` probe, its one caller (a witness cell holds it to one). It is a copy
 * (`structuredClone`) and shares nothing with the listed record. It is safe because:
 * - the ways engine only reads the record it judges, and never writes it;
 * - no judge reads a model call's text, so the texts a listing left out change no judgement;
 * - a store refuses a write that drops a stored evidence entry's `model_text`: the in-memory store's
 *   own refusal, and SQLite's `STATE_EVIDENCE_REWRITTEN` for a changed evidence entry.
 * Not exported from core's index.
 * @internal
 */
export function recordToJudge(record: ListedRecord): RunRecord {
  return structuredClone(record) as RunRecord;
}

/**
 * Loads one run and the reading it is judged at (D3 A-9; #715 (b), D-17): `store.get`, which takes
 * the store's ONE raw reading BEFORE it loads and returns the `Snapshot` (D6-16) — so every statement
 * about the loaded copy holds at `at`. No caller passes a clock: the store's clock decides.
 */
export async function loadSnapshot(store: Pick<RunStore, 'get'>, runId: string): Promise<Snapshot> {
  return store.get(runId);
}

/**
 * The one constructor of a `Snapshot`: a record and the reading it is judged at; it reads no clock.
 * A store builds every snapshot it returns through it (the
 * reading its read or write took); the engine builds one from a write's returned `{ record, at }`.
 * A reply's ways speak of the record as written, never of a record read again.
 *
 * #729 CW-1b: with `facts`, the `lease_facts` from `leaseFactsOf` when the store has a lease port; a
 * snapshot with no facts (none passed, or `NO_LEASE_FACTS`) is `{ record, at }` exactly, as before.
 * @public
 */
export function writtenSnapshot(record: RunRecord, at: Date, facts?: LeaseFacts): Snapshot {
  if (facts === undefined || facts === NO_LEASE_FACTS) return { record, at };
  return { record, at, lease_facts: facts };
}

/**
 * #715 (b) (Amendment 4, D6-17): the PRIVATE carrier of the snapshot an engine reply was judged on.
 * Two `WeakMap`s, never a key of the reply: `BASIS_SNAPSHOTS` remembers, for each `Basis` object
 * `basisOf` (ways.ts) builds, the snapshot it was built from; `JUDGED` maps a reply
 * the engine returns to that same snapshot. A WeakMap has no reflection path, so `JSON.stringify`,
 * `{ ...reply }`, `structuredClone` and `util.inspect` see nothing of it, and it works on a frozen
 * reply. Its limit: a reply built by ANOTHER loaded copy of core (two copies of `@sensigo/realm` in
 * one process) is unknown to this copy's accessor — `judgedSnapshotOf` returns `undefined` for it.
 */
const BASIS_SNAPSHOTS = new WeakMap<object, Snapshot>();
const JUDGED = new WeakMap<object, Snapshot>();

/** Internal to core (not exported from the package): the snapshot a `Basis` object was built from. */
export function noteBasisSnapshot(basis: object, snapshot: Snapshot): void {
  BASIS_SNAPSHOTS.set(basis, snapshot);
}

/**
 * Internal to core (not exported from the package): the snapshot an error reply WITHOUT ways (so
 * without a `basis`) describes — the record the call read or wrote and that reading — keyed on the
 * reply's `error` object, which every later spread of the reply keeps. #715 (b): an error reply about
 * a record the call holds is judged on it as any other reply is (the late answer whose expiry ended
 * the run; a guard settle that lost to another attempt; a failed step that ended the run).
 */
export function noteErrorSnapshot(error: object, snapshot: Snapshot): void {
  BASIS_SNAPSHOTS.set(error, snapshot);
}

/**
 * Internal to core (not exported from the package): the snapshot a reply's `basis` was built from —
 * what the engine itself judges a sentence on when it composes after its own reply (the advance
 * loop's end hint), so the sentence and the reply's `as_of` stand on one reading. `undefined` when
 * the reply has no `basis`.
 */
export function snapshotOfBasis(reply: object): Snapshot | undefined {
  const { basis, error } = reply as { basis?: unknown; error?: unknown };
  if (typeof basis === 'object' && basis !== null) return BASIS_SNAPSHOTS.get(basis);
  // An error reply with no ways: the snapshot noted on its `error` (noteErrorSnapshot), if any.
  return typeof error === 'object' && error !== null ? BASIS_SNAPSHOTS.get(error) : undefined;
}

/**
 * Internal to core (not exported from the package): attaches to an engine entry's FINAL reply the
 * snapshot its `basis` was built from — so `snapshot.at` is `basis.as_of` and its record's version
 * `basis.run_version` by construction, a replayed request's new reply included (its basis is built
 * from its fresh load). A reply with no `basis` gets nothing. Returns the reply.
 */
export function attachJudged<T extends object>(reply: T): T {
  const snapshot = snapshotOfBasis(reply);
  if (snapshot !== undefined) JUDGED.set(reply, snapshot);
  return reply;
}

/**
 * The run record and the reading an engine reply was judged on, for a host that judges after the
 * call instead of reading the run again.
 * FOR JUDGING,
 * NEVER FOR PRINTING: the record is raw (undisclosed); a sentence about it is composed through the
 * door's disclosed view. Carried privately: a copy of the reply (`{ ...reply }`, `structuredClone`,
 * JSON) does not carry it, and a reply from another loaded copy of core is not known here.
 * `undefined` when the reply loaded no run (no `basis`).
 * @public
 */
export function judgedSnapshotOf(reply: object): Snapshot | undefined {
  return JUDGED.get(reply);
}

/**
 * A reply's stamp about one record: the time it is judged at and the run's version.
 * @public
 */
export interface Stamp {
  /** The snapshot's `at`, ISO 8601: the instant every time statement about the record was judged at. */
  as_of: string;
  run_version: number;
  /**
   * #715 (b) (02 §C.1, D-24): `'test_clock'` when the store's clock is a marked TEST clock
   * (`clockBasis`); absent for every other clock, a host-built one included.
   */
  as_of_basis?: 'test_clock';
}

/**
 * The stamp of one snapshot (#715 D6-59): `as_of` minted here, once, paired with `run_version`; with
 * `as_of_basis` when `basis` (the store clock's `clockBasis`) says the instant is a test clock's.
 */
export function stampOf(snapshot: Snapshot, basis?: 'test_clock'): Stamp {
  return {
    as_of: snapshot.at.toISOString(),
    run_version: snapshot.record.version,
    ...(basis === 'test_clock' ? { as_of_basis: basis } : {}),
  };
}

/**
 * The program that judges the ways: this program with its registry, an observer that passed none,
 * or a program whose project code failed to load. An observer passes no registry because a read
 * surface never executes project code.
 * A renderer sees the kind and the error code only — never the registry or an `Error` (A-9).
 * @public
 */
export type EnactorBasis =
  | { kind: 'this_program' }
  | { kind: 'observer' }
  | { kind: 'load_failed'; error_code: LoadErrorCode };

/**
 * Every kind a reply's enactor basis can name, in the type's order.
 * Compile-checked both ways: a word added to the type and not to the list fails the build,
 * and so does a word in the list the type does not have (Q1, #592, unit d1b).
 * @public
 */
export const ENACTOR_KINDS = [
  'this_program',
  'observer',
  'load_failed',
] as const satisfies readonly EnactorBasis['kind'][];
type MissingEnactorKinds = Exclude<EnactorBasis['kind'], (typeof ENACTOR_KINDS)[number]>;
const _everyEnactorKindsListed: [MissingEnactorKinds] extends [never] ? true : MissingEnactorKinds =
  true;
void _everyEnactorKindsListed;

/**
 * The definition the ways were judged against: the run's workflow by id, or why it is absent. The
 * absence is in the one vocabulary of `definition_absent`'s facts, never a second list.
 * Not the author's `version:` (P-7: not identity). #493's content hash enters with
 * #493, its producer (the membership rule) — no run records one today.
 * @public
 */
export type DefinitionBasis = { workflow_id: string } | { absent: DefinitionAbsence };

/**
 * What a reply's ways were judged on: the record's stamp, the enactor's kind, whether the store
 * persists claims, and the definition. An absent claims fact reads as false (fail closed).
 * @public
 */
export interface Basis extends Stamp {
  enactor: EnactorBasis;
  store: { persists_claims: boolean };
  definition: DefinitionBasis;
}
