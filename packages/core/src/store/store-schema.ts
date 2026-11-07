// store-schema.ts — issue #616 (PR-1a unit 6; design D4 r3 §3 and §7): the SQLite store's schema,
// owned by core as data. No I/O and no SQLite here: the store package creates a fresh `realm.db` from
// `REALM_STORE_SCHEMA` (unit 7) and compares the file's `sqlite_master` with it on every open, because a
// foreign `DROP TRIGGER` followed by a statement the trigger refused lands (design §3), so the stored
// text itself is the check.
//
// Every statement is written in the form SQLite keeps in `sqlite_master` (no `IF NOT EXISTS`, no
// trailing semicolon), so a created file's text equals this constant byte for byte. Later units APPEND
// to version 1 (PR-1b: the other stores' tables): nothing is released in between (SEAMS S2). After the first release these statements are
// version 1's and never change: a schema change adds the next version to `REALM_STORE_VERSIONS`.
//
// Every rule a writer that is not Realm must obey is a TRIGGER, because a connection that sets
// `PRAGMA ignore_check_constraints = 1` turns every CHECK off while triggers stay on; the CHECKs state
// the same rules for a reader of the schema. The triggers' messages are final at the first release:
// the store maps them to typed errors by their exact text (units 7 and 8). Three choices differ from
// the frozen design's §3 by the design owner's ruling of 2026-11-05 (DELTAS row 23): every key and
// payload column is NOT NULL; a malformed run record is refused by SQLite's own "malformed JSON" (the
// generated columns read the record before any trigger runs); the insert guard against a purged id is
// created after the table it reads (unit 6b). The guards on the tables' hidden row number, a record's
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
 * stores it. Tables: `runs` (the run's core document, placeholders in place, with a generated column
 * for every field a read filters on), `evidence` (append-only rows), `run_blobs` (the write-once
 * fields); `store_meta` (the store's one meta row: its tombstone counter and horizon), `write_clock`
 * (the instant of the deleting write), and the tombstones a deleted run leaves: `purged_ids` (its id,
 * kept forever) and `purged_runs` (its detail, compactable below the horizon). PR-1b appends the other
 * stores' tables: `webhook_dedup` (B8, the duplicate-webhook memory), and the workflow registry (B3):
 * `workflow_versions` (each distinct definition text once, by its hash), `workflow_registrations` (every
 * move of a workflow's pointer, in order) and `workflows` (the pointer).
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
  // Every column the choice of a key's holder reads (`rerun_of`: a finished run another run of its key
  // superseded does not hold the key, unit 15a).
  `CREATE INDEX runs_by_key ON runs (workflow_id, key_hash, terminal_state, created_at, id, rerun_of)`,
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

  // ---- store_meta: the store's one meta row (unit 6b; design §3). Unit 7 writes it at creation ----
  // Every column NOT NULL: a NULL passes a "never lower" comparison (NULL < old is NULL).
  `CREATE TABLE store_meta (
  one INTEGER PRIMARY KEY NOT NULL CHECK (one = 1),
  page_size INTEGER NOT NULL,
  commit_epoch INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  tomb_seq INTEGER NOT NULL,
  tombstones_through_seq INTEGER NOT NULL,
  tombstones_since TEXT NOT NULL
)`,
  // One row: a second insert, INSERT OR REPLACE included, is refused before its conflict is resolved.
  `CREATE TRIGGER store_meta_insert_once BEFORE INSERT ON store_meta
WHEN EXISTS (SELECT 1 FROM store_meta)
BEGIN SELECT RAISE(ABORT, 'realm.db: the store''s meta row cannot be replaced or deleted'); END`,
  `CREATE TRIGGER store_meta_no_delete BEFORE DELETE ON store_meta
BEGIN SELECT RAISE(ABORT, 'realm.db: the store''s meta row cannot be replaced or deleted'); END`,
  `CREATE TRIGGER store_meta_immutable BEFORE UPDATE ON store_meta
WHEN new.one IS NOT old.one
  OR new.page_size IS NOT old.page_size
  OR new.created_at IS NOT old.created_at
BEGIN SELECT RAISE(ABORT, 'realm.db: the store''s meta row cannot be replaced or deleted'); END`,
  // The counter and the horizon only move forward, and the horizon never passes the counter. A value
  // of the wrong type is left to the type guards below, so one statement trips one guard.
  `CREATE TRIGGER store_meta_forward BEFORE UPDATE ON store_meta
WHEN new.commit_epoch IS NULL
  OR (typeof(new.commit_epoch) = 'integer' AND new.commit_epoch < old.commit_epoch)
  OR new.tomb_seq IS NULL
  OR (typeof(new.tomb_seq) = 'integer' AND new.tomb_seq < old.tomb_seq)
  OR new.tombstones_through_seq IS NULL
  OR (typeof(new.tombstones_through_seq) = 'integer' AND new.tombstones_through_seq < old.tombstones_through_seq)
  OR new.tombstones_since IS NULL
  OR (new.tombstones_since GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND new.tombstones_since < old.tombstones_since)
  OR (typeof(new.tombstones_through_seq) = 'integer' AND typeof(new.tomb_seq) = 'integer'
    AND new.tombstones_through_seq > new.tomb_seq)
BEGIN SELECT RAISE(ABORT, 'realm.db: the store''s recorded horizon cannot move backwards'); END`,
  // Whole numbers and stamps of the one shape only (DELTAS row 25): SQLite sorts every text above every
  // number, and a TEXT column stores a number as text, so a value of another type passes "never lower"
  // and then refuses every later write. The first row is judged in full; an update, on the columns
  // that may change (the others cannot change at all). NULL is left to NOT NULL and the guard above.
  // A whole number stays at most 9007199254740991 (DELTAS row 26): Realm reads the row as JavaScript
  // numbers, so a larger one makes the next +1 refused or the row unreadable. The horizon counter needs
  // no cap on update: the forward guard already refuses it above the counter.
  `CREATE TRIGGER store_meta_insert_types BEFORE INSERT ON store_meta
WHEN NOT EXISTS (SELECT 1 FROM store_meta)
  AND (typeof(new.page_size) NOT IN ('integer', 'null')
    OR typeof(new.commit_epoch) NOT IN ('integer', 'null')
    OR typeof(new.tomb_seq) NOT IN ('integer', 'null')
    OR typeof(new.tombstones_through_seq) NOT IN ('integer', 'null')
    OR (typeof(new.page_size) = 'integer' AND new.page_size > 9007199254740991)
    OR (typeof(new.commit_epoch) = 'integer' AND new.commit_epoch > 9007199254740991)
    OR (typeof(new.tomb_seq) = 'integer' AND new.tomb_seq > 9007199254740991)
    OR (typeof(new.tombstones_through_seq) = 'integer' AND new.tombstones_through_seq > 9007199254740991)
    OR (new.created_at IS NOT NULL AND (typeof(new.created_at) IS NOT 'text' OR new.created_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'))
    OR (new.tombstones_since IS NOT NULL AND (typeof(new.tombstones_since) IS NOT 'text' OR new.tombstones_since NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')))
BEGIN SELECT RAISE(ABORT, 'realm.db: the store''s meta row holds whole numbers and timestamps of one shape'); END`,
  `CREATE TRIGGER store_meta_update_types BEFORE UPDATE ON store_meta
WHEN typeof(new.commit_epoch) NOT IN ('integer', 'null')
  OR typeof(new.tomb_seq) NOT IN ('integer', 'null')
  OR typeof(new.tombstones_through_seq) NOT IN ('integer', 'null')
  OR (typeof(new.commit_epoch) = 'integer' AND new.commit_epoch > 9007199254740991)
  OR (typeof(new.tomb_seq) = 'integer' AND new.tomb_seq > 9007199254740991)
  OR (new.tombstones_since IS NOT NULL AND (typeof(new.tombstones_since) IS NOT 'text' OR new.tombstones_since NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'))
BEGIN SELECT RAISE(ABORT, 'realm.db: the store''s meta row holds whole numbers and timestamps of one shape'); END`,

  // ---- write_clock: the instant of the write that deletes a run (design R4-01). It starts empty;
  // the store sets it with an upsert and clears it (at = NULL) before COMMIT. A plain UPDATE on the
  // empty table matches no row, so the upsert is the only way to set it ----
  `CREATE TABLE write_clock (
  one INTEGER PRIMARY KEY NOT NULL CHECK (one = 1),
  at TEXT
)`,

  // ---- purged_ids: every id that ever left runs, kept forever ----
  `CREATE TABLE purged_ids (
  id TEXT PRIMARY KEY NOT NULL,
  purged_at TEXT NOT NULL
) WITHOUT ROWID`,
  // A purged run is never created again (DELTAS row 23: created after the table it reads).
  `CREATE TRIGGER runs_insert_not_purged BEFORE INSERT ON runs
WHEN EXISTS (SELECT 1 FROM purged_ids WHERE id = new.id)
BEGIN SELECT RAISE(ABORT, 'realm.db: a purged run id cannot be created again'); END`,
  // A REPLACE would delete and re-insert the id: refused here, before its delete.
  `CREATE TRIGGER purged_ids_insert_once BEFORE INSERT ON purged_ids
WHEN EXISTS (SELECT 1 FROM purged_ids WHERE id = new.id)
BEGIN SELECT RAISE(ABORT, 'realm.db: the tombstone record is append-only'); END`,
  // A live run's id recorded as purged would refuse that run's later purge.
  `CREATE TRIGGER purged_ids_not_live BEFORE INSERT ON purged_ids
WHEN EXISTS (SELECT 1 FROM runs WHERE id = new.id)
BEGIN SELECT RAISE(ABORT, 'realm.db: a live run cannot be recorded as purged'); END`,
  `CREATE TRIGGER purged_ids_no_update BEFORE UPDATE ON purged_ids
BEGIN SELECT RAISE(ABORT, 'realm.db: the tombstone record is append-only'); END`,
  `CREATE TRIGGER purged_ids_no_delete BEFORE DELETE ON purged_ids
BEGIN SELECT RAISE(ABORT, 'realm.db: the tombstone record is append-only'); END`,

  // ---- purged_runs: a deleted run's detail, ordered by seq (never by the clock), compactable ----
  `CREATE TABLE purged_runs (
  seq INTEGER PRIMARY KEY NOT NULL,
  id TEXT NOT NULL UNIQUE,
  purged_at TEXT NOT NULL,
  workflow_id TEXT,
  key_hash TEXT,
  sealed_by_arm TEXT,
  run_phase TEXT NOT NULL,
  phase_version TEXT NOT NULL
)`,
  `CREATE INDEX purged_runs_by_key ON purged_runs (workflow_id, key_hash, id, purged_at)`,
  // Only the deleting trigger's own row: its seq is the counter, its id is purged and not live, and no
  // row holds that seq or id (a REPLACE fires no update guard, and a delete guard only with recursive
  // triggers on).
  `CREATE TRIGGER purged_runs_insert_own BEFORE INSERT ON purged_runs
WHEN new.seq IS NOT (SELECT tomb_seq FROM store_meta)
  OR NOT EXISTS (SELECT 1 FROM purged_ids WHERE id = new.id)
  OR EXISTS (SELECT 1 FROM runs WHERE id = new.id)
  OR EXISTS (SELECT 1 FROM purged_runs WHERE seq = new.seq OR id = new.id)
BEGIN SELECT RAISE(ABORT, 'realm.db: the tombstone record is append-only'); END`,
  `CREATE TRIGGER purged_runs_no_update BEFORE UPDATE ON purged_runs
BEGIN SELECT RAISE(ABORT, 'realm.db: the tombstone record is append-only'); END`,
  // Compaction moves the horizon first, then deletes what is below it on both counts.
  `CREATE TRIGGER purged_runs_delete_below_horizon BEFORE DELETE ON purged_runs
WHEN (old.seq <= (SELECT tombstones_through_seq FROM store_meta)
  AND old.purged_at <= (SELECT tombstones_since FROM store_meta)) IS NOT 1
BEGIN SELECT RAISE(ABORT, 'realm.db: the tombstone record is append-only'); END`,

  // A run that leaves runs, by any writer, leaves both rows under the next seq. purged_at is the
  // deleting write's instant from write_clock; only when it is not set (a delete by anything other
  // than Realm) does SQLite's own clock stamp it, in the store's one shape.
  `CREATE TRIGGER runs_tombstone AFTER DELETE ON runs
BEGIN
  UPDATE store_meta SET tomb_seq = tomb_seq + 1;
  INSERT INTO purged_ids (id, purged_at) VALUES (old.id, COALESCE((SELECT at FROM write_clock WHERE one = 1), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
  INSERT INTO purged_runs (seq, id, purged_at, workflow_id, key_hash, sealed_by_arm, run_phase, phase_version)
  VALUES ((SELECT tomb_seq FROM store_meta), old.id, COALESCE((SELECT at FROM write_clock WHERE one = 1), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), old.workflow_id, old.key_hash, old.sealed_by_arm, old.run_phase, old.phase_version);
END`,

  // ---- webhook_dedup (#616 PR-1b B8): the webhook ids `realm listen` has seen, one row per id per
  // scope (the workflow id): the id's hash, never the raw id, and the instants of the write that
  // recorded it, in the store's one text shape, so text order is time order. Its rows are tiny:
  // WITHOUT ROWID. No guard of its own: a row removed by a writer outside Realm only shortens a
  // best-effort window, which the run's idempotency key stands behind ----
  `CREATE TABLE webhook_dedup (
  scope TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (scope, key_hash)
) WITHOUT ROWID`,
  `CREATE INDEX webhook_dedup_by_expiry ON webhook_dedup (scope, expires_at)`,

  // ---- the workflow registry (PR-1b B3): each distinct definition text once, under the lowercase hex
  // sha256 of its UTF-8 bytes; one pointer per workflow to its current text; and the history of every
  // move of that pointer, in order. Every instant is a write's one reading, in the store's one shape.
  // The tables are created in the order the guards read them: versions, then registrations, then
  // the pointers. The guards' messages map to no typed code ----
  // A definition is tens of KB, so this stays an ordinary rowid table (WITHOUT ROWID is slow for large
  // rows), with the guards on its hidden row number below (DELTAS rows 24 and 24b).
  `CREATE TABLE workflow_versions (
  hash TEXT PRIMARY KEY NOT NULL,
  id TEXT NOT NULL,
  definition TEXT NOT NULL,
  first_registered_at TEXT NOT NULL
)`,
  `CREATE INDEX workflow_versions_by_id ON workflow_versions (id)`,
  // G4: a version is its own workflow's text: a JSON object stored as text, whose `$.id` is JSON text
  // equal to the row's id, with no repeated top-level key (SQLite reads the first of two equal keys
  // and JSON.parse the last, so a repeated `id` would pass this guard as one workflow and be read as
  // another; DELTAS row 24, as for a run record). A value that is not an object has no `$.id`, so the
  // text test refuses it; that test is needed of its own: `json_extract` returns an array or object
  // as its JSON text, which can equal the row's id. A CASE, so each test runs only after the ones
  // before it passed: in a plain OR chain SQLite may run the key count first and refuse text that is
  // not JSON with its own "malformed JSON". `IS NOT` throughout: `=` would let a missing `$.id`
  // through (a NULL WHEN does not fire).
  `CREATE TRIGGER workflow_versions_insert_valid BEFORE INSERT ON workflow_versions
WHEN CASE
    WHEN typeof(new.definition) IS NOT 'text' THEN 1
    WHEN json_valid(new.definition) IS NOT 1 THEN 1
    WHEN (SELECT count(*) <> count(DISTINCT key) FROM json_each(new.definition)) THEN 1
    WHEN json_type(new.definition, '$.id') IS NOT 'text' THEN 1
    WHEN json_extract(new.definition, '$.id') IS NOT new.id THEN 1
    ELSE 0
  END
BEGIN SELECT RAISE(ABORT, 'realm.db: a workflow version must be a JSON object that carries its own id'); END`,
  // G5: a hash always names the same text. A second insert of a hash (INSERT OR REPLACE included) is
  // refused before its conflict is resolved, and so is an insert aimed at a taken row number: a
  // REPLACE there deletes that row without firing any delete trigger. Judged by looking for the row,
  // never by whether a number was given. Every update and delete is refused, on any column (a guard
  // scoped to `rowid` alone lets `SET oid = …` through).
  `CREATE TRIGGER workflow_versions_insert_once BEFORE INSERT ON workflow_versions
WHEN EXISTS (SELECT 1 FROM workflow_versions WHERE hash = new.hash)
  OR EXISTS (SELECT 1 FROM workflow_versions WHERE rowid = new.rowid)
BEGIN SELECT RAISE(ABORT, 'realm.db: a workflow version cannot change'); END`,
  `CREATE TRIGGER workflow_versions_no_update BEFORE UPDATE ON workflow_versions
BEGIN SELECT RAISE(ABORT, 'realm.db: a workflow version cannot change'); END`,
  `CREATE TRIGGER workflow_versions_no_delete BEFORE DELETE ON workflow_versions
BEGIN SELECT RAISE(ABORT, 'realm.db: a workflow version cannot change'); END`,
  // G8: inside an insert guard SQLite gives "no number given" as -1, so one row planted at -1 would
  // make the row-number arm above refuse every later insert.
  `CREATE TRIGGER workflow_versions_rowid_positive AFTER INSERT ON workflow_versions
WHEN new.rowid < 1
BEGIN SELECT RAISE(ABORT, 'realm.db: a row number must be 1 or more'); END`,
  // ---- workflow_registrations: one row per move of a workflow's pointer, numbered 0, 1, 2… per
  // workflow, append-only (#493 reads it) ----
  `CREATE TABLE workflow_registrations (
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  hash TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  PRIMARY KEY (id, seq)
) WITHOUT ROWID`,
  // G6: a row names one of its own workflow's texts, at that workflow's next number: no gap, and no
  // replaced row (INSERT OR REPLACE at a taken number is not the next number).
  `CREATE TRIGGER workflow_registrations_insert_own BEFORE INSERT ON workflow_registrations
WHEN NOT EXISTS (SELECT 1 FROM workflow_versions WHERE hash = new.hash AND id = new.id)
  OR new.seq IS NOT (SELECT COALESCE(MAX(seq), -1) + 1 FROM workflow_registrations WHERE id = new.id)
BEGIN SELECT RAISE(ABORT, 'realm.db: a registration can only name one of its own workflow''s versions'); END`,
  // G7: the history is append-only.
  `CREATE TRIGGER workflow_registrations_no_update BEFORE UPDATE ON workflow_registrations
BEGIN SELECT RAISE(ABORT, 'realm.db: the registration history cannot change'); END`,
  `CREATE TRIGGER workflow_registrations_no_delete BEFORE DELETE ON workflow_registrations
BEGIN SELECT RAISE(ABORT, 'realm.db: the registration history cannot change'); END`,
  // ---- workflows: the pointer, one row per workflow ----
  `CREATE TABLE workflows (
  id TEXT PRIMARY KEY NOT NULL,
  current_hash TEXT NOT NULL,
  registered_at TEXT NOT NULL
) WITHOUT ROWID`,
  // G1: a pointer names one of its own workflow's versions, and that workflow's newest registration,
  // so no pointer moves without its history row (Realm writes the version, then the registration, then
  // the pointer). The update arm keeps `id`, so no statement fires both G1 and G2.
  `CREATE TRIGGER workflows_insert_own BEFORE INSERT ON workflows
WHEN NOT EXISTS (SELECT 1 FROM workflow_versions WHERE hash = new.current_hash AND id = new.id)
  OR new.current_hash IS NOT (SELECT hash FROM workflow_registrations WHERE id = new.id ORDER BY seq DESC LIMIT 1)
BEGIN SELECT RAISE(ABORT, 'realm.db: a workflow can only point at one of its own versions'); END`,
  `CREATE TRIGGER workflows_update_own BEFORE UPDATE ON workflows
WHEN new.id IS old.id
  AND (NOT EXISTS (SELECT 1 FROM workflow_versions WHERE hash = new.current_hash AND id = new.id)
    OR new.current_hash IS NOT (SELECT hash FROM workflow_registrations WHERE id = new.id ORDER BY seq DESC LIMIT 1))
BEGIN SELECT RAISE(ABORT, 'realm.db: a workflow can only point at one of its own versions'); END`,
  // G2: an id change would serve one workflow's text under another's id. On any column, so
  // `UPDATE OR REPLACE … SET id` cannot land and erase the workflow it collides with.
  `CREATE TRIGGER workflows_id_fixed BEFORE UPDATE ON workflows
WHEN new.id IS NOT old.id
BEGIN SELECT RAISE(ABORT, 'realm.db: a workflow''s id cannot change'); END`,
  // G3: no Realm path deletes a workflow.
  `CREATE TRIGGER workflows_no_delete BEFORE DELETE ON workflows
BEGIN SELECT RAISE(ABORT, 'realm.db: a registered workflow cannot be deleted'); END`,
];
