// snapshot.ts — issue #729 PR-0 (D2 D-9, D3 A-9; #715 D6-16, D6-17, D6-18, D6-33, D6-59): one record
// and the reading it is judged at, built in ONE place, and the stamp a reply carries about it.
//
// Every judge of the ways (`composeWaysOn`, `admitWay`) takes a `Snapshot` — one value, so a record
// from one load is never judged at another load's reading (D6-17). The reading is taken BEFORE the
// load (D6-16): every statement made about the loaded copy is true at its `at`. #715 (b): the store
// takes that reading (`store.get` returns the Snapshot); `loadSnapshot` is `store.get`. The
// source-text witness: no `{ record, at }` literal is built outside this module — every Snapshot is
// built by `writtenSnapshot`.
import type { RunRecord } from '../types/run-record.js';
import type { RunStore } from '../store/store-interface.js';
import type { DefinitionAbsence, LoadErrorCode } from './ways.js';

/** One record and the reading it is judged at (#715 D6-17). Built only by this module. */
export interface Snapshot {
  readonly record: RunRecord;
  /** The clock reading taken BEFORE the record was loaded (D6-16), or the reading its write used. */
  readonly at: Date;
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
 * The ONE constructor of a `Snapshot` (PR0-CONTRACT §2; #715 (b), D-15): a record and the reading it
 * is judged at — no clock is read here. A store builds every snapshot it returns through it (the
 * reading its read or write took); the engine builds one from a write's returned `{ record, at }`.
 * A reply's ways speak of the record as written, never of a record read again.
 */
export function writtenSnapshot(record: RunRecord, at: Date): Snapshot {
  return { record, at };
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
 * The snapshot — the run record and the reading — an engine reply was judged on (#715 (b), D6-17):
 * what a host that composes after the call judges, instead of reading the run again. FOR JUDGING,
 * NEVER FOR PRINTING: the record is raw (undisclosed); a sentence about it is composed through the
 * door's disclosed view. Carried privately: a copy of the reply (`{ ...reply }`, `structuredClone`,
 * JSON) does not carry it, and a reply from another loaded copy of core is not known here.
 * `undefined` when the reply loaded no run (no `basis`).
 */
export function judgedSnapshotOf(reply: object): Snapshot | undefined {
  return JUDGED.get(reply);
}

/** A reply's stamp about one record (#715 D6-18, D6-59). */
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
 * The program that judges the ways (D2 D-9): this program with its registry, an observer that passed
 * none (C33: a read surface never executes project code), or a program whose project code failed to
 * load. A renderer sees the kind and the error code only — never the registry or an `Error` (A-9).
 */
export type EnactorBasis =
  | { kind: 'this_program' }
  | { kind: 'observer' }
  | { kind: 'load_failed'; error_code: LoadErrorCode };

/**
 * The definition the ways were judged against (D4 P-7; Amendment 13, Q8): the run's workflow by id,
 * or why it is absent — in the ONE vocabulary of `definition_absent`'s facts (A-5's arms), never a
 * second list. Not the author's `version:` (P-7: not identity). #493's content hash enters with
 * #493, its producer (the membership rule) — no run records one today.
 */
export type DefinitionBasis = { workflow_id: string } | { absent: DefinitionAbsence };

/**
 * What a reply's ways were judged on (D2 D-9, D3 A-9): the record's stamp, the enactor's kind, whether
 * the store persists claims (absent ⇒ false, fail closed) and the definition.
 */
export interface Basis extends Stamp {
  enactor: EnactorBasis;
  store: { persists_claims: boolean };
  definition: DefinitionBasis;
}
