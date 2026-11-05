// store-schema.ts — issue #616 (PR-1a unit 6; design D4 r3 §3 and §7): the SQLite store's schema,
// owned by core as data. No I/O and no SQLite here: the store package creates a fresh `realm.db` from
// `REALM_STORE_SCHEMA` (unit 7) and compares the file's `sqlite_master` with it on every open, because a
// foreign `DROP TRIGGER` followed by a statement the trigger refused lands (design §3), so the stored
// text itself is the check.
//
// Every statement is written in the form SQLite keeps in `sqlite_master` (no `IF NOT EXISTS`, no
// trailing semicolon), so a created file's text equals this constant byte for byte. Later units APPEND
// to version 1 (unit 6b: the tombstones, `store_meta` and `write_clock`; PR-1b: the other stores'
// tables): nothing is released in between (SEAMS S2). After the first release, changing any statement
// here is a schema change: a new `user_version` and its upgrade step.
//
// Every rule a writer that is not Realm must obey is a TRIGGER, because a connection that sets
// `PRAGMA ignore_check_constraints = 1` turns every CHECK off while triggers stay on; the CHECKs state
// the same rules for a reader of the schema. The triggers' messages are final at the first release:
// the store maps them to typed errors by their exact text (units 7 and 8). Three choices differ from
// the frozen design's §3 by the design owner's ruling of 2026-11-05 (DELTAS row 23): every key and
// payload column is NOT NULL; a malformed run record is refused by SQLite's own "malformed JSON" (the
// generated columns read the record before any trigger runs); the insert guard against a purged id is
// unit 6b's, created with the table it reads. The guards on the tables' hidden row number, a record's
// repeated top-level keys and values not stored as text come from the review of unit 6 (DELTAS rows 24
// and 24b).

/**
 * The run record's fields written once per run and stored in `run_blobs`, one row per field, each left
 * in the stored run document as a `{"$realm_blob": "<field>"}` placeholder at its own position (design
 * §3). A member is admitted only after a writer census confirms it is written once; today the one
 * writer of `workflow_context_snapshots` is the execution loop, which writes it only while it is absent.
 */
export const WRITE_ONCE_RUN_FIELDS = ['workflow_context_snapshots'] as const;
export type WriteOnceRunField = (typeof WRITE_ONCE_RUN_FIELDS)[number];

/** `PRAGMA application_id` of a `realm.db` (the header's 32-bit field at offset 68): ASCII "REAL". */
export const REALM_STORE_APPLICATION_ID = 0x5245414c;

/** The schema version this Realm creates and reads (`PRAGMA user_version`). */
export const REALM_STORE_SCHEMA_VERSION = 1;

/** The page size a fresh `realm.db` is created with, in bytes (design §2: 16 KiB). */
export const REALM_STORE_PAGE_SIZE = 16384;

/**
 * The schema, version 1: one statement per element, in creation order, each exactly as `sqlite_master`
 * stores it. Tables in this part: `runs` (the run's core document, placeholders in place, with a
 * generated column for every field a read filters on), `evidence` (append-only rows) and `run_blobs`
 * (the write-once fields).
 */
export const REALM_STORE_SCHEMA: readonly string[] = [
  // ---- runs: the core document; the generated columns read it, never the reverse ----
  `CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL,
  record TEXT NOT NULL CHECK (json_valid(record)),
  workflow_id TEXT GENERATED ALWAYS AS (json_extract(record, '$.workflow_id')) STORED,
  terminal_state INTEGER GENERATED ALWAYS AS (json_extract(record, '$.terminal_state')) STORED,
  sealed_by_arm TEXT GENERATED ALWAYS AS (json_extract(record, '$.sealed_by.arm')) STORED,
  created_at TEXT GENERATED ALWAYS AS (json_extract(record, '$.created_at')) STORED,
  updated_at TEXT GENERATED ALWAYS AS (json_extract(record, '$.updated_at')) STORED,
  idempotency_key TEXT GENERATED ALWAYS AS (json_extract(record, '$.idempotency_key')) STORED,
  rerun_of TEXT GENERATED ALWAYS AS (json_extract(record, '$.rerun_of')) STORED,
  version INTEGER GENERATED ALWAYS AS (json_extract(record, '$.version')) STORED,
  pending_gate_id TEXT GENERATED ALWAYS AS (json_extract(record, '$.pending_gate.gate_id')) STORED,
  run_phase TEXT NOT NULL,
  phase_version TEXT NOT NULL,
  key_hash TEXT,
  CHECK (id = json_extract(record, '$.id')),
  CHECK ((key_hash IS NULL) = (idempotency_key IS NULL))
)`,
  // The phase index: the stored phase and the fingerprint of the derivation that computed it.
  `CREATE INDEX runs_by_phase ON runs (phase_version, run_phase, id)`,
  `CREATE INDEX runs_by_phase_version ON runs (phase_version, id)`,
  // Every column the choice of a key's holder reads.
  `CREATE INDEX runs_by_key ON runs (workflow_id, key_hash, terminal_state, created_at, id)`,
  // An update of the record moves its version by exactly one. Scoped to the record, so the re-stamp of
  // the phase index (which sets only run_phase and phase_version) needs no bump.
  `CREATE TRIGGER runs_version_fence BEFORE UPDATE OF record ON runs
WHEN json_extract(new.record, '$.version') IS NOT json_extract(old.record, '$.version') + 1
BEGIN SELECT RAISE(ABORT, 'realm.db: a run''s version can only advance by one'); END`,
  // A run's identity never changes. The record's fields are compared through the record itself: a
  // generated column reads NULL in a BEFORE UPDATE trigger when the statement does not set the record.
  `CREATE TRIGGER runs_identity BEFORE UPDATE OF id, record, key_hash ON runs
WHEN new.id IS NOT old.id
  OR new.key_hash IS NOT old.key_hash
  OR json_extract(new.record, '$.id') IS NOT json_extract(old.record, '$.id')
  OR json_extract(new.record, '$.workflow_id') IS NOT json_extract(old.record, '$.workflow_id')
  OR json_extract(new.record, '$.idempotency_key') IS NOT json_extract(old.record, '$.idempotency_key')
  OR json_extract(new.record, '$.created_at') IS NOT json_extract(old.record, '$.created_at')
BEGIN SELECT RAISE(ABORT, 'realm.db: a run''s identity cannot change'); END`,
  // A run is created once. This also refuses INSERT OR REPLACE, REPLACE INTO and an upsert: their
  // BEFORE INSERT trigger fires before the conflict is resolved.
  `CREATE TRIGGER runs_insert_once BEFORE INSERT ON runs
WHEN EXISTS (SELECT 1 FROM runs WHERE id = new.id)
BEGIN SELECT RAISE(ABORT, 'realm.db: a run with this id already exists'); END`,
  // The CHECKs above, as a trigger, so they bind a connection that switches CHECKs off. A record must
  // also be stored as text, and must not repeat a top-level key: SQLite reads the first of two equal
  // keys and JSON.parse the last, so the guards would judge a value Realm does not read.
  `CREATE TRIGGER runs_insert_valid BEFORE INSERT ON runs
WHEN json_valid(new.record) IS NOT 1
  OR typeof(new.record) IS NOT 'text'
  OR (SELECT count(*) <> count(DISTINCT key) FROM json_each(new.record))
  OR json_extract(new.record, '$.id') IS NULL
  OR new.id IS NOT json_extract(new.record, '$.id')
  OR (new.key_hash IS NULL) IS NOT (json_extract(new.record, '$.idempotency_key') IS NULL)
BEGIN SELECT RAISE(ABORT, 'realm.db: a run record must be valid JSON, carry its own id, and pair its key hash with its key'); END`,
  // Only a finished run leaves `runs`; a NULL terminal state is not finished.
  `CREATE TRIGGER runs_delete_finished BEFORE DELETE ON runs
WHEN old.terminal_state IS NOT 1
BEGIN SELECT RAISE(ABORT, 'realm.db: a run that is not finished cannot be deleted'); END`,

  // ---- evidence: one row per entry, append-only while its run exists ----
  `CREATE TABLE evidence (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  entry TEXT NOT NULL CHECK (json_valid(entry)),
  entry_sha256 TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
)`,
  `CREATE TRIGGER evidence_insert_valid BEFORE INSERT ON evidence
WHEN json_valid(new.entry) IS NOT 1
  OR typeof(new.entry) IS NOT 'text'
BEGIN SELECT RAISE(ABORT, 'realm.db: evidence and fields must be valid JSON'); END`,
  // A REPLACE deletes and re-inserts: refused here, before its delete could run.
  `CREATE TRIGGER evidence_insert_once BEFORE INSERT ON evidence
WHEN EXISTS (SELECT 1 FROM evidence WHERE run_id = new.run_id AND seq = new.seq)
BEGIN SELECT RAISE(ABORT, 'realm.db: evidence rows are append-only'); END`,
  `CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence
BEGIN SELECT RAISE(ABORT, 'realm.db: evidence rows are append-only'); END`,
  // Purge deletes the run row first, then its evidence, in one transaction.
  `CREATE TRIGGER evidence_delete_after_run BEFORE DELETE ON evidence
WHEN EXISTS (SELECT 1 FROM runs WHERE id = old.run_id)
BEGIN SELECT RAISE(ABORT, 'realm.db: evidence rows are append-only'); END`,

  // ---- run_blobs: the write-once fields, one row per field ----
  `CREATE TABLE run_blobs (
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  PRIMARY KEY (run_id, name)
)`,
  `CREATE TRIGGER run_blobs_insert_valid BEFORE INSERT ON run_blobs
WHEN json_valid(new.value) IS NOT 1
  OR typeof(new.value) IS NOT 'text'
BEGIN SELECT RAISE(ABORT, 'realm.db: evidence and fields must be valid JSON'); END`,
  `CREATE TRIGGER run_blobs_insert_once BEFORE INSERT ON run_blobs
WHEN EXISTS (SELECT 1 FROM run_blobs WHERE run_id = new.run_id AND name = new.name)
BEGIN SELECT RAISE(ABORT, 'realm.db: a write-once field cannot change'); END`,
  `CREATE TRIGGER run_blobs_no_update BEFORE UPDATE ON run_blobs
BEGIN SELECT RAISE(ABORT, 'realm.db: a write-once field cannot change'); END`,
  `CREATE TRIGGER run_blobs_delete_after_run BEFORE DELETE ON run_blobs
WHEN EXISTS (SELECT 1 FROM runs WHERE id = old.run_id)
BEGIN SELECT RAISE(ABORT, 'realm.db: a write-once field cannot change'); END`,

  // ---- appended by the review of unit 6 (DELTAS row 24) ----
  // The record's validity on update too: text, valid JSON, no repeated top-level key.
  `CREATE TRIGGER runs_update_valid BEFORE UPDATE OF record ON runs
WHEN json_valid(new.record) IS NOT 1
  OR typeof(new.record) IS NOT 'text'
  OR (SELECT count(*) <> count(DISTINCT key) FROM json_each(new.record))
BEGIN SELECT RAISE(ABORT, 'realm.db: a run record must be valid JSON, carry its own id, and pair its key hash with its key'); END`,
  // The hidden row number. INSERT OR REPLACE aimed at a taken row number deletes the row there without
  // firing a delete trigger (unless recursive triggers are on), so an insert is refused when an existing
  // row holds its number. Judged by looking for that row, never by whether a number was given.
  `CREATE TRIGGER runs_insert_rowid_free BEFORE INSERT ON runs
WHEN EXISTS (SELECT 1 FROM runs WHERE rowid = new.rowid)
BEGIN SELECT RAISE(ABORT, 'realm.db: a run with this id already exists'); END`,
  // UPDATE OR REPLACE that moves a run to a taken row number deletes the run there. All three names of
  // the row number are listed: a trigger scoped to one of them does not fire for the others.
  `CREATE TRIGGER runs_rowid_fixed BEFORE UPDATE OF rowid, oid, _rowid_ ON runs
WHEN new.rowid IS NOT old.rowid
BEGIN SELECT RAISE(ABORT, 'realm.db: a run''s identity cannot change'); END`,
  `CREATE TRIGGER evidence_insert_rowid_free BEFORE INSERT ON evidence
WHEN EXISTS (SELECT 1 FROM evidence WHERE rowid = new.rowid)
BEGIN SELECT RAISE(ABORT, 'realm.db: evidence rows are append-only'); END`,
  `CREATE TRIGGER run_blobs_insert_rowid_free BEFORE INSERT ON run_blobs
WHEN EXISTS (SELECT 1 FROM run_blobs WHERE rowid = new.rowid)
BEGIN SELECT RAISE(ABORT, 'realm.db: a write-once field cannot change'); END`,
  // Inside a BEFORE INSERT trigger SQLite gives an insert with no row number the value -1, so a row
  // stored at -1 would make the guards above refuse every plain insert. No row is stored below 1
  // (DELTAS row 24b); Realm's own rows are numbered from 1.
  `CREATE TRIGGER runs_rowid_positive AFTER INSERT ON runs
WHEN new.rowid < 1
BEGIN SELECT RAISE(ABORT, 'realm.db: a row number must be 1 or more'); END`,
  `CREATE TRIGGER evidence_rowid_positive AFTER INSERT ON evidence
WHEN new.rowid < 1
BEGIN SELECT RAISE(ABORT, 'realm.db: a row number must be 1 or more'); END`,
  `CREATE TRIGGER run_blobs_rowid_positive AFTER INSERT ON run_blobs
WHEN new.rowid < 1
BEGIN SELECT RAISE(ABORT, 'realm.db: a row number must be 1 or more'); END`,
];
