// run-rows.ts — issue #616 PR-1a unit 10 (design D4 r3 §3 "Stored text", "Tables", "SQLite's JSON
// limits"; SEAMS S4 and S15): a run record as the store keeps it, and back. Package-internal: the store
// class (units 12 onward) and PR-1b's stores call these; the package's entry exports none of them.
//
// A record is kept as three kinds of rows, one per life cycle: the `runs` row holds the record's core
// document, which changes on every step; `evidence` holds one row per entry, which only grows;
// `run_blobs` holds each write-once field. The keys moved out stay in the core document as
// placeholders AT THEIR OWN POSITIONS, so the read puts each piece back where it was and the record's
// key order is exactly what was written:
//   - `"evidence": {"$realm_rows": <n>}`, with n rows at `seq` 0 … n-1 (the entry's index);
//   - `"<field>": {"$realm_blob": "<field>"}` for each `WRITE_ONCE_RUN_FIELDS` member the record holds;
//   - `"run_phase": {"$realm_derived": "run_phase"}`: the stored text never carries a phase. The read
//     substitutes the derivation's answer; the plain `run_phase` column is an index only.
// Each stored piece is exactly what `JSON.stringify(record)` holds at that place: an entry that JSON
// cannot hold (`undefined`, a function) is `null` there, and a field whose value JSON leaves out is
// left out (no placeholder, no blob).
//
// The reader runs inside a transaction the caller holds and begins, commits or locks nothing. The
// insert is all or nothing by its own savepoint: inside the caller's `BEGIN IMMEDIATE` it takes no
// lock of its own and a failed call leaves none of its rows in that transaction; with no transaction
// open its savepoint is the transaction, holds the write lock for the call and commits the run whole.
// The update's writer (`writeRunUpdate`, unit 12b) runs inside the caller's `BEGIN IMMEDIATE` and
// refuses before its first write. None reads a clock. The limits are checked before the caller's
// `BEGIN`, and so is the split of an update's record (`splitRunRecord`): ONE function makes every
// stored piece, for the insert and the update alike, so an entry's stored text and hash cannot differ
// between the two.
//
// A key's holder (unit 15a): `keyHashOf` is the one function that hashes an idempotency key, for the
// insert and the lookup alike, and `findKeyHolder` derives which of a key's runs holds it from the
// runs' own rows, in the caller's transaction (no key table, no pointer).
import { createHash } from 'node:crypto';
import {
  deriveRunPhase,
  pickCanonical,
  runPhaseDerivationFingerprint,
  WorkflowError,
  WRITE_ONCE_RUN_FIELDS,
  type KeyHolderFields,
  type RunRecord,
} from '@sensigo/realm';
import { guardRefusalError } from './connection.js';
import type { DatabaseLike } from './driver.js';
import { evidenceEntrySha256 } from './evidence-hash.js';

/** SQLite's JSON nesting limit: a document nested 1,000 deep is valid, 1,001 is "malformed JSON". */
export const RUN_RECORD_MAX_DEPTH = 1000;

/** SQLite's `SQLITE_MAX_LENGTH`: the most bytes one stored value can hold. */
export const RUN_RECORD_MAX_BYTES = 1_000_000_000;

const ROWS = '$realm_rows';
const BLOB = '$realm_blob';
const DERIVED = '$realm_derived';
const WRITE_ONCE: ReadonlySet<string> = new Set(WRITE_ONCE_RUN_FIELDS);

/** The record's own JSON value at a key, as an untyped object (the split walks every key). */
type JsonObject = Record<string, unknown>;

/**
 * A run's core document as the `runs` row keeps it: the record's keys in its own order, with the
 * placeholders of the module comment in place of its evidence, its write-once fields and its phase.
 */
export type CoreDocument = Record<string, unknown>;

/** One evidence entry as the store keeps it: its stored text, and that text's sha256. */
export interface StoredEntry {
  readonly text: string;
  readonly sha256: string;
}

/** One write-once field as the store keeps it: its name, and its stored text. */
export interface StoredField {
  readonly name: string;
  readonly text: string;
}

/** A run record split into the pieces the store keeps (see {@link splitRunRecord}). */
export interface SplitRunRecord {
  readonly core: CoreDocument;
  /** Every evidence entry, by index: entry `seq` is at `entries[seq]`. */
  readonly entries: readonly StoredEntry[];
  /** Every write-once field the record holds a value for that JSON keeps. */
  readonly fields: readonly StoredField[];
}

/** Whether `value` is a placeholder: an object whose one key is `marker`, holding `expected`. */
function isPlaceholder(
  value: unknown,
  marker: string,
  expected: (held: unknown) => boolean,
): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === marker && expected((value as JsonObject)[marker]);
}

/**
 * How deep `value` is nested, counting each object and array on the deepest path (a scalar is 0, the
 * record itself 1), as SQLite counts JSON nesting. Iterative, so a record nested far deeper than the
 * limit cannot overflow the stack; it stops as soon as a path reaches `stopAt`, which also ends the
 * walk of a record that refers to itself.
 */
function nestingDepth(value: unknown, stopAt: number): number {
  if (typeof value !== 'object' || value === null) return 0;
  let deepest = 0;
  const pending: Array<{ node: object; depth: number }> = [{ node: value, depth: 1 }];
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    if (depth > deepest) {
      deepest = depth;
      if (deepest >= stopAt) return deepest;
    }
    for (const child of Object.values(node)) {
      if (typeof child === 'object' && child !== null)
        pending.push({ node: child, depth: depth + 1 });
    }
  }
  return deepest;
}

function limitExceeded(limit: string, max: number, actual: number, shown: string): WorkflowError {
  return new WorkflowError(
    `This run record is too large for the store: its ${limit} is ${shown}, and the most the store accepts is ${max}. Nothing was written.`,
    {
      code: 'STATE_STORE_LIMIT_EXCEEDED',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { limit, max, actual },
    },
  );
}

/**
 * The limits a record must fit before the store writes it, checked BEFORE the caller's `BEGIN`: a
 * record nested deeper than SQLite's JSON limit, or longer than `maxBytes` (SQLite's own length limit
 * by default; a test lowers it), is refused with `STATE_STORE_LIMIT_EXCEEDED` and never truncated.
 * Both are measured on the whole record: its nesting, and the UTF-8 length of `JSON.stringify(record)`.
 * The depth is walked first, because `JSON.stringify` overflows the stack on a record nested far
 * deeper than the limit. The walk stops at the first level over the limit, so a depth refusal's
 * `actual` is that level (1,001): the depth is at least this. The SQL layer alone cannot name the
 * limit: a record too deep reaches the caller as SQLite's "malformed JSON" from a generated column.
 * Pure: it reads nothing but the record.
 */
export function assertRunRecordWithinLimits(
  record: RunRecord,
  maxBytes: number = RUN_RECORD_MAX_BYTES,
): void {
  const depth = nestingDepth(record, RUN_RECORD_MAX_DEPTH + 1);
  if (depth > RUN_RECORD_MAX_DEPTH) {
    // The walk stops at the first path deeper than the limit, so the sentence says only that.
    throw limitExceeded(
      'nesting depth',
      RUN_RECORD_MAX_DEPTH,
      depth,
      `more than ${RUN_RECORD_MAX_DEPTH}`,
    );
  }
  const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
  if (bytes > maxBytes) throw limitExceeded('size in bytes', maxBytes, bytes, String(bytes));
}

/**
 * The key's hash a `runs` row carries, and the one a key's holder is looked up by: the sha256, in
 * lowercase hex, of the workflow id, one zero byte and the idempotency key, as UTF-8. An empty key is
 * a key. Unit 13's `save` calls it too: its name and signature are fixed.
 */
export function keyHashOf(workflowId: string, key: string): string {
  return createHash('sha256')
    .update(workflowId, 'utf8')
    .update('\0', 'utf8')
    .update(key, 'utf8')
    .digest('hex');
}

/** The key hash `record`'s row carries: NULL when the record has no key (absent or null). */
function keyHashOfRecord(record: RunRecord): string | null {
  const key: unknown = record.idempotency_key;
  if (key === undefined || key === null) return null;
  return keyHashOf(record.workflow_id, key as string);
}

const KEY_ROWS =
  'SELECT id, terminal_state, created_at, rerun_of FROM runs WHERE workflow_id = ? AND key_hash = ?';

/**
 * The run that holds `workflowId`'s idempotency key `key`, or `undefined` when no run carries it,
 * read in the caller's transaction (a call with none open is refused with a plain error): ONE select
 * of the key's rows over the `runs_by_key` index, which holds every column it reads, so no record is
 * read. Then the candidates:
 *   - a FINISHED run that another run of the key names in `rerun_of` does not hold the key: it was
 *     superseded (a live run is never dropped, DELTAS row 27). A rerun stamped before its holder (the
 *     clock more than five seconds behind the holder's stamp) would otherwise give the key back to
 *     the replaced run once the rerun finishes;
 *   - a run naming itself in `rerun_of` drops nothing;
 *   - when that would drop every run, every run is a candidate: a key with rows always has a holder.
 * Then core's `pickCanonical` decides (one live run → it; several → the newest live; none → the
 * newest). Unit 13's `save` calls it too: its name and signature are fixed.
 */
export function findKeyHolder(
  db: DatabaseLike,
  workflowId: string,
  key: string,
): KeyHolderFields | undefined {
  if (!db.isTransaction) {
    throw new Error(
      "findKeyHolder reads a key's runs in one snapshot, so it needs a transaction open on its connection, and none is open.",
    );
  }
  const rows = db.prepare(KEY_ROWS).all(workflowId, keyHashOf(workflowId, key));
  if (rows.length === 0) return undefined;
  const runs: KeyHolderFields[] = [];
  /** The runs the key's runs name in `rerun_of`, other than themselves. */
  const supersedes = new Set<string>();
  for (const row of rows) {
    const id = String(row['id']);
    const rerunOf: unknown = row['rerun_of'];
    if (typeof rerunOf === 'string' && rerunOf !== id) supersedes.add(rerunOf);
    // eslint-disable-next-line no-restricted-syntax -- a read of the stored column for the key holder; reaches no store
    runs.push({
      id,
      created_at: String(row['created_at']),
      terminal_state: row['terminal_state'] === 1,
    });
  }
  const held = runs.filter((run) => !(run.terminal_state && supersedes.has(run.id)));
  return pickCanonical(held.length > 0 ? held : runs).canonical;
}

const INSERT_RUN =
  'INSERT INTO runs (id, record, run_phase, phase_version, key_hash) VALUES (?, ?, ?, ?, ?)';
const INSERT_EVIDENCE =
  'INSERT INTO evidence (run_id, seq, entry, entry_sha256) VALUES (?, ?, ?, ?)';
const INSERT_BLOB = 'INSERT INTO run_blobs (run_id, name, value) VALUES (?, ?, ?)';
/** The writer's own savepoint (SEAMS, "unit 10 review (PR #993)", the amendment). */
const SAVEPOINT = 'realm_insert_run';

/**
 * Splits `record` into the pieces the store keeps: its core document (its keys in its own order,
 * placeholders in place; a record with no phase gets the phase's placeholder last), each evidence
 * entry's stored text and that text's sha256, and each write-once field's stored text. The ONE split:
 * {@link insertRunRecord} writes what it returns, and an update makes it before its `BEGIN`, so the
 * texts and hashes are never made while the write lock is held for an update. An entry JSON cannot
 * hold (`undefined`, a function, a hole) is stored as `null`; a write-once field whose value JSON
 * leaves out of the record is left out here too (no placeholder, no text). A record whose evidence is
 * not an array is refused with a plain error naming the run. Pure: it reads nothing but the record.
 */
export function splitRunRecord(record: RunRecord): SplitRunRecord {
  const source = record as unknown as JsonObject;
  const evidence: unknown = source['evidence'];
  if (!Array.isArray(evidence)) {
    throw new Error(`Run ${String(record.id)} is not a run record: its evidence is not an array.`);
  }
  const core: CoreDocument = {};
  const fields: StoredField[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (key === 'evidence') {
      core[key] = { [ROWS]: evidence.length };
    } else if (key === 'run_phase') {
      core[key] = { [DERIVED]: 'run_phase' };
    } else if (WRITE_ONCE.has(key)) {
      const text = JSON.stringify(value);
      // A value JSON leaves out of the record (undefined, a function) leaves the field out here too.
      if (text === undefined) continue;
      core[key] = { [BLOB]: key };
      fields.push({ name: key, text });
    } else {
      core[key] = value;
    }
  }
  // An imported record with no phase gets the placeholder too (design §3): the read derives it.
  if (!Object.hasOwn(core, 'run_phase')) core['run_phase'] = { [DERIVED]: 'run_phase' };
  const entries: StoredEntry[] = [];
  // By index, not `map`: a hole in the array is an entry too, which JSON holds as null.
  for (let seq = 0; seq < evidence.length; seq++) {
    const text = JSON.stringify(evidence[seq]) ?? 'null';
    entries.push({ text, sha256: evidenceEntrySha256(text) });
  }
  return { core, entries, fields };
}

/**
 * Writes `record` in its stored form: the `runs` row (the core document, placeholders in place, with
 * the derived phase and the derivation's fingerprint in the index columns, and the key's hash), one
 * `evidence` row per entry with the sha256 of its stored text, and one `run_blobs` row per write-once
 * field, all as {@link splitRunRecord} makes them. Synchronous; every stamp is the record's own, and
 * it throws what SQLite and the file's guards throw, unmapped. The caller checks
 * {@link assertRunRecordWithinLimits} before its `BEGIN`.
 *
 * All or nothing, by its own savepoint around the INSERTs: a throw leaves nothing of this call behind,
 * whether the caller then rolls back, swallows the throw or goes on, and the caller's earlier work in
 * the transaction is as it was. Inside the caller's `BEGIN IMMEDIATE` it takes no lock of its own;
 * with no transaction open the savepoint is the transaction, holds the write lock for the call and
 * commits the run whole. When SQLite has rolled the whole transaction back by itself (a full disk, an
 * I/O error) there is no savepoint left, so the cleanup is skipped and the caller's own `ROLLBACK`
 * has nothing to do: the caller asks `isTransaction` first, or treats "no transaction is active" as
 * done, as `RealmDb` does.
 */
export function insertRunRecord(db: DatabaseLike, record: RunRecord): void {
  const { core, entries, fields } = splitRunRecord(record);

  // SQLite uses the most recent savepoint of a name, so a caller's own of the same name is no clash.
  db.exec(`SAVEPOINT ${SAVEPOINT}`);
  try {
    db.prepare(INSERT_RUN).run(
      record.id,
      JSON.stringify(core),
      deriveRunPhase(record),
      runPhaseDerivationFingerprint(),
      keyHashOfRecord(record),
    );
    const insertEntry = db.prepare(INSERT_EVIDENCE);
    entries.forEach((entry, seq) => insertEntry.run(record.id, seq, entry.text, entry.sha256));
    if (fields.length > 0) {
      const insertBlob = db.prepare(INSERT_BLOB);
      for (const field of fields) insertBlob.run(record.id, field.name, field.text);
    }
    // Inside the guarded region: with no transaction open this RELEASE is the commit, and a failing
    // one is cleaned up like any other failure, so the connection is not left in a transaction.
    db.exec(`RELEASE ${SAVEPOINT}`);
  } catch (err) {
    // A transaction SQLite rolled back by itself (a full disk, an I/O error) has no savepoint left.
    if (db.isTransaction) {
      db.exec(`ROLLBACK TO ${SAVEPOINT}`);
      db.exec(`RELEASE ${SAVEPOINT}`);
    }
    throw err;
  }
}

/**
 * What an update writes of a run's evidence and write-once fields ({@link writeRunUpdate}):
 *   - `unchanged`: none of it; the core document carries the stored placeholders as they are (a
 *     claim, which changes only the core document);
 *   - `prepared`: the pieces of the incoming record, made by {@link splitRunRecord} before `BEGIN`
 *     (an update): compared with the stored ones, and the new ones written.
 */
export type EvidenceWrite =
  { readonly unchanged: true } | { readonly prepared: Pick<SplitRunRecord, 'entries' | 'fields'> };

const UPDATE_RUN = 'UPDATE runs SET record = ?, run_phase = ?, phase_version = ? WHERE id = ?';
/** The update writer's own savepoint (MA 3, 2026-11-07: every multi-row writer is atomic itself). */
const UPDATE_SAVEPOINT = 'realm_update_run';

/**
 * Writes the next state of the stored run `runId` inside the caller's `BEGIN IMMEDIATE`, the caller
 * having read the run's row in that transaction: `nextCore` is the new core document, placeholders in
 * place, and `evidence` says what else is written ({@link EvidenceWrite}). The one writer of a run's
 * later states: `update` and `claimStep` call it, and so do unit 13's settle, seal and save.
 *
 * For `prepared` it first reads the stored `entry_sha256` sequence and the stored write-once fields,
 * and refuses, before its first write, an update that would change or remove what is stored: fewer
 * entries than stored, or an entry whose hash differs from the stored one at its position, is
 * `STATE_EVIDENCE_REWRITTEN`; a stored write-once field the incoming record changes or leaves out is
 * `STATE_WRITE_ONCE_REWRITTEN` (with the guards' own sentences: the file's guards stay the backstop
 * for a writer outside Realm). For `unchanged` it reads nothing.
 *
 * Then, all or nothing by its own savepoint (as {@link insertRunRecord}): it `UPDATE`s the `runs` row
 * (the core document, and the phase index re-stamped: {@link deriveRunPhase} of `nextCore`, whose
 * every input is a key of the core document, and the derivation's fingerprint), and for `prepared`
 * inserts the entries beyond the stored count and every write-once field not yet stored. Returns the
 * core document's text as it wrote it: the write's own check compares the stored text with it.
 * Synchronous; reads no clock; throws what SQLite and the file's guards throw, unmapped.
 */
export function writeRunUpdate(
  db: DatabaseLike,
  runId: string,
  nextCore: CoreDocument,
  evidence: EvidenceWrite,
): string {
  let newEntries: readonly StoredEntry[] = [];
  let firstNewSeq = 0;
  let newFields: readonly StoredField[] = [];
  if ('prepared' in evidence) {
    const { entries, fields } = evidence.prepared;
    const stored = db
      .prepare('SELECT entry_sha256 FROM evidence WHERE run_id = ? ORDER BY seq')
      .all(runId)
      .map((row) => String(row['entry_sha256']));
    if (
      entries.length < stored.length ||
      stored.some((hash, seq) => entries[seq]!.sha256 !== hash)
    ) {
      throw guardRefusalError('STATE_EVIDENCE_REWRITTEN');
    }
    const storedFields = db
      .prepare('SELECT name, value FROM run_blobs WHERE run_id = ?')
      .all(runId)
      .map((row) => ({ name: String(row['name']), text: String(row['value']) }));
    const incoming = new Map(fields.map((field) => [field.name, field.text]));
    if (storedFields.some((field) => incoming.get(field.name) !== field.text)) {
      throw guardRefusalError('STATE_WRITE_ONCE_REWRITTEN');
    }
    const storedNames = new Set(storedFields.map((field) => field.name));
    newEntries = entries.slice(stored.length);
    firstNewSeq = stored.length;
    newFields = fields.filter((field) => !storedNames.has(field.name));
  }
  const text = JSON.stringify(nextCore);

  // SQLite uses the most recent savepoint of a name, so a caller's own of the same name is no clash.
  db.exec(`SAVEPOINT ${UPDATE_SAVEPOINT}`);
  try {
    db.prepare(UPDATE_RUN).run(
      text,
      deriveRunPhase(nextCore as unknown as RunRecord),
      runPhaseDerivationFingerprint(),
      runId,
    );
    if (newEntries.length > 0) {
      const insertEntry = db.prepare(INSERT_EVIDENCE);
      newEntries.forEach((entry, index) =>
        insertEntry.run(runId, firstNewSeq + index, entry.text, entry.sha256),
      );
    }
    if (newFields.length > 0) {
      const insertBlob = db.prepare(INSERT_BLOB);
      for (const field of newFields) insertBlob.run(runId, field.name, field.text);
    }
    db.exec(`RELEASE ${UPDATE_SAVEPOINT}`);
  } catch (err) {
    // A transaction SQLite rolled back by itself (a full disk, an I/O error) has no savepoint left.
    if (db.isTransaction) {
      db.exec(`ROLLBACK TO ${UPDATE_SAVEPOINT}`);
      db.exec(`RELEASE ${UPDATE_SAVEPOINT}`);
    }
    throw err;
  }
  return text;
}

/** The stored run cannot be read back: its record and its rows disagree. */
function disagreement(runId: string, what: string): Error {
  return new Error(`The stored run ${runId} cannot be read back: ${what}.`);
}

/**
 * Reads the run `runId` as `get()` returns it, or `null` when no run has that id: the `runs` row, its
 * evidence `ORDER BY seq` and its blobs, in the caller's ONE snapshot: the caller holds the
 * transaction, and a call with none open is refused with a plain error. It first asserts that every
 * placeholder has its rows or blob and every row or blob has its placeholder, throwing a plain error
 * naming the run when they disagree (a store whose guards a foreign writer dropped can hold that);
 * then puts each piece back where its placeholder is, so the key order is the written one, and sets
 * the phase to {@link deriveRunPhase}'s answer, never the stored column.
 */
export function readRunInTransaction(db: DatabaseLike, runId: string): RunRecord | null {
  // Three reads outside a transaction are three snapshots: a write between them could pass unseen.
  if (!db.isTransaction) {
    throw new Error(
      'readRunInTransaction reads a run in one snapshot, so it needs a transaction open on its connection, and none is open.',
    );
  }
  const row = db.prepare('SELECT record FROM runs WHERE id = ?').get(runId);
  if (row === undefined) return null;
  const core = JSON.parse(String(row['record'])) as JsonObject;
  const entries = db
    .prepare('SELECT seq, entry FROM evidence WHERE run_id = ? ORDER BY seq')
    .all(runId);
  const blobs = db.prepare('SELECT name, value FROM run_blobs WHERE run_id = ?').all(runId);

  if (isPlaceholder(core['evidence'], ROWS, (n) => Number.isSafeInteger(n) && (n as number) >= 0)) {
    const count = (core['evidence'] as JsonObject)[ROWS] as number;
    if (entries.length !== count) {
      throw disagreement(
        runId,
        `its record holds ${count} evidence entries and the store has ${entries.length} evidence rows`,
      );
    }
    entries.forEach((entry, index) => {
      if (Number(entry['seq']) !== index) {
        throw disagreement(runId, `evidence row ${index} has seq ${String(entry['seq'])}`);
      }
    });
    core['evidence'] = entries.map((entry) => JSON.parse(String(entry['entry'])) as unknown);
  } else if (entries.length > 0) {
    throw disagreement(
      runId,
      `the store has ${entries.length} evidence rows and its record no evidence placeholder`,
    );
  }

  const stored = new Map(blobs.map((blob) => [String(blob['name']), String(blob['value'])]));
  for (const name of stored.keys()) {
    if (!WRITE_ONCE.has(name) || !isPlaceholder(core[name], BLOB, (held) => held === name)) {
      throw disagreement(
        runId,
        `the store holds field ${name} and its record no placeholder for it`,
      );
    }
  }
  for (const name of WRITE_ONCE) {
    if (!isPlaceholder(core[name], BLOB, (held) => held === name)) continue;
    const value = stored.get(name);
    if (value === undefined) {
      throw disagreement(
        runId,
        `its record has a placeholder for field ${name} and the store no value`,
      );
    }
    core[name] = JSON.parse(value) as unknown;
  }

  // Assigned in place: the key keeps its position. The derivation reads only fields the core holds.
  const run = core as unknown as RunRecord;
  run.run_phase = deriveRunPhase(run);
  return run;
}
