// snapshot.ts — issue #729 PR-0 (D2 D-9, D3 A-9; #715 D6-16, D6-17, D6-18, D6-33, D6-59): one record
// and the reading it is judged at, built in ONE place, and the stamp a reply carries about it.
//
// Every judge of the ways (`composeWaysOn`, `admitWay`) takes a `Snapshot` — one value, so a record
// from one load is never judged at another load's reading (D6-17). The reading is taken BEFORE the
// load (D6-16): every statement made about the loaded copy is true at its `at`. #715 later changes the
// body of `loadSnapshot` (its store clock and `takeReading`), never the composers that take a
// Snapshot. The source-text witness: no `Snapshot` value is built outside this module.
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
 * Loads one run and the reading it is judged at (D3 A-9): the clock is read BEFORE `store.get`, so
 * every statement about the loaded copy holds at `at`. `now` is a caller's injectable clock (the
 * engine entries' `options.now`); absent, the system clock. #715 changes this body (its store clock),
 * never its callers.
 */
export async function loadSnapshot(
  store: Pick<RunStore, 'get'>,
  runId: string,
  opts: { now?: Date } = {},
): Promise<Snapshot> {
  const at = opts.now ?? new Date();
  const record = await store.get(runId);
  return { record, at };
}

/**
 * The snapshot a write returns (PR0-CONTRACT §2, MA 8's condition: judgement words are judged "at the
 * settle's returned `{ record, at }`"; Amendment 13, Q2): the record as this call wrote it, and the
 * instant the settle returned — no clock is read here. The second of this module's two constructors;
 * a reply's ways speak of the record as written, never of a record read again.
 */
export function writtenSnapshot(record: RunRecord, at: Date): Snapshot {
  return { record, at };
}

/** A reply's stamp about one record (#715 D6-18, D6-59 minus `as_of_basis`, which #715 adds). */
export interface Stamp {
  /** The snapshot's `at`, ISO 8601. */
  as_of: string;
  run_version: number;
}

/** The stamp of one snapshot (#715 D6-59): `as_of` minted here, once, paired with `run_version`. */
export function stampOf(snapshot: Snapshot): Stamp {
  return { as_of: snapshot.at.toISOString(), run_version: snapshot.record.version };
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
