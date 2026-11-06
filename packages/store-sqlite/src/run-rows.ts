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
// writer is all or nothing by its own savepoint: inside the caller's `BEGIN IMMEDIATE` it takes no
// lock of its own and a failed call leaves none of its rows in that transaction; with no transaction
// open its savepoint is the transaction, holds the write lock for the call and commits the run whole.
// Neither reads a clock. The limits are checked before the caller's `BEGIN`.
import { createHash } from 'node:crypto';
import {
  deriveRunPhase,
  runPhaseDerivationFingerprint,
  WorkflowError,
  WRITE_ONCE_RUN_FIELDS,
  type RunRecord,
} from '@sensigo/realm';
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
 * The key's hash the `runs` row carries: the sha256, in lowercase hex, of the workflow id, one zero
 * byte and the idempotency key, as UTF-8; NULL when the record has no key (absent or null). An empty
 * key is a key.
 */
function keyHash(record: RunRecord): string | null {
  const key: unknown = record.idempotency_key;
  if (key === undefined || key === null) return null;
  return createHash('sha256')
    .update(record.workflow_id, 'utf8')
    .update('\0', 'utf8')
    .update(key as string, 'utf8')
    .digest('hex');
}

const INSERT_RUN =
  'INSERT INTO runs (id, record, run_phase, phase_version, key_hash) VALUES (?, ?, ?, ?, ?)';
const INSERT_EVIDENCE =
  'INSERT INTO evidence (run_id, seq, entry, entry_sha256) VALUES (?, ?, ?, ?)';
const INSERT_BLOB = 'INSERT INTO run_blobs (run_id, name, value) VALUES (?, ?, ?)';
/** The writer's own savepoint (SEAMS, "unit 10 review (PR #993)", the amendment). */
const SAVEPOINT = 'realm_insert_run';

/**
 * Writes `record` in its stored form: the `runs` row (the core document, placeholders in place, with
 * the derived phase and the derivation's fingerprint in the index columns, and the key's hash), one
 * `evidence` row per entry with the sha256 of its stored text, and one `run_blobs` row per write-once
 * field. Synchronous; every stamp is the record's own, and it throws what SQLite and the file's
 * guards throw, unmapped. The caller checks {@link assertRunRecordWithinLimits} before its `BEGIN`.
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
  const source = record as unknown as JsonObject;
  const evidence: unknown = source['evidence'];
  if (!Array.isArray(evidence)) {
    throw new Error(`Run ${String(record.id)} is not a run record: its evidence is not an array.`);
  }
  const core: JsonObject = {};
  const blobs: Array<{ name: string; value: string }> = [];
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
      blobs.push({ name: key, value: text });
    } else {
      core[key] = value;
    }
  }
  // An imported record with no phase gets the placeholder too (design §3): the read derives it.
  if (!Object.hasOwn(core, 'run_phase')) core['run_phase'] = { [DERIVED]: 'run_phase' };

  // SQLite uses the most recent savepoint of a name, so a caller's own of the same name is no clash.
  db.exec(`SAVEPOINT ${SAVEPOINT}`);
  try {
    db.prepare(INSERT_RUN).run(
      record.id,
      JSON.stringify(core),
      deriveRunPhase(record),
      runPhaseDerivationFingerprint(),
      keyHash(record),
    );
    const insertEntry = db.prepare(INSERT_EVIDENCE);
    // By index, not `map`: a hole in the array is an entry too, which JSON holds as null.
    for (let seq = 0; seq < evidence.length; seq++) {
      const text = JSON.stringify(evidence[seq]) ?? 'null';
      insertEntry.run(record.id, seq, text, evidenceEntrySha256(text));
    }
    if (blobs.length > 0) {
      const insertBlob = db.prepare(INSERT_BLOB);
      for (const blob of blobs) insertBlob.run(record.id, blob.name, blob.value);
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
