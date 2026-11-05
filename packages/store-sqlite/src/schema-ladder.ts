// schema-ladder.ts — issue #616 (PR-1a unit 6c; design D4 r3 §2 "Schema evolution", L-MIGRATE): the
// mechanism that moves a `realm.db` forward one schema version at a time, and the one compare of a
// file's stored schema with a version's schema (the open, unit 7b, uses the same compare, so a file the
// ladder accepts at a version is a file the open accepts at it).
//
// Each step runs in its own `BEGIN IMMEDIATE`: the file's version read again under the lock, the step's
// statements, the compare with that version's schema, every evidence entry re-checked against its stored
// hash, and only then `user_version` moved and the transaction committed. SQLite's DDL is transactional
// and `user_version` rolls back with it, so a step that fails anywhere leaves the file at the version
// before, with nothing of the step in it. The command that runs the ladder (`realm db migrate`, a later
// unit) takes the backup first and words the report; nothing here is read by a user, and the errors
// here are plain errors that the command's refusals replace.
import {
  REALM_STORE_VERSIONS,
  type StoreSchemaVersion,
  type StoreSchemaVersions,
} from '@sensigo/realm';
import { openDatabase, type DatabaseLike } from './driver.js';
import { evidenceEntrySha256 } from './evidence-hash.js';

/** What one step did. The command that runs the ladder words it. */
export interface SchemaStepReport {
  /** The version the file was at. */
  readonly from: number;
  /** The version the step took it to. */
  readonly to: number;
  /** How many of the step's statements ran. */
  readonly statements: number;
  /** How many evidence entries were re-checked against their stored hash. */
  readonly evidenceChecked: number;
}

/** How a file's stored schema differs from a version's schema: each object as `<type> <name>`. */
export interface SchemaDifference {
  /** In the version's schema, not in the file. */
  readonly missing: readonly string[];
  /** In the file, not in the version's schema. */
  readonly extra: readonly string[];
  /** In both, with another text. */
  readonly changed: readonly string[];
}

/**
 * The objects of a schema: every row of `sqlite_master` except those SQLite adds by itself, which no
 * version's schema holds — the statistics tables (`ANALYZE`, `PRAGMA optimize`), the counter table an
 * `AUTOINCREMENT` column creates, and the index behind a key or a UNIQUE constraint, which has no text.
 */
const SCHEMA_OBJECTS = `SELECT type, name, sql FROM sqlite_master
WHERE NOT (name GLOB 'sqlite_stat*' OR name = 'sqlite_sequence'
  OR (sql IS NULL AND name GLOB 'sqlite_autoindex_*'))`;

function schemaObjects(db: DatabaseLike): Map<string, unknown> {
  const objects = new Map<string, unknown>();
  for (const row of db.prepare(SCHEMA_OBJECTS).all()) {
    objects.set(`${String(row['type'])} ${String(row['name'])}`, row['sql']);
  }
  return objects;
}

/**
 * How the schema stored in `db` differs from `schema`, object by object (type and name), each object's
 * text compared exactly. Order is not compared: a step that rebuilds a table leaves it after the objects
 * created later, where a fresh file holds it in the schema's order. `schema` is read by creating it in a
 * database in memory, so SQLite itself names each statement's object.
 */
export function storedSchemaDifference(
  db: DatabaseLike,
  schema: readonly string[],
): SchemaDifference {
  const reference = openDatabase(':memory:');
  let expected: Map<string, unknown>;
  try {
    for (const statement of schema) reference.exec(statement);
    expected = schemaObjects(reference);
  } finally {
    reference.close();
  }
  const stored = schemaObjects(db);
  return {
    missing: [...expected.keys()].filter((key) => !stored.has(key)),
    extra: [...stored.keys()].filter((key) => !expected.has(key)),
    changed: [...expected.keys()].filter(
      (key) => stored.has(key) && stored.get(key) !== expected.get(key),
    ),
  };
}

/** How many evidence entries the re-check reads at a time: a store's evidence can outgrow memory. */
export const EVIDENCE_RECHECK_PAGE = 500;

const EVIDENCE_FIRST_PAGE =
  'SELECT rowid AS r, run_id, seq, entry, entry_sha256 FROM evidence ORDER BY rowid LIMIT ?';
const EVIDENCE_NEXT_PAGE =
  'SELECT rowid AS r, run_id, seq, entry, entry_sha256 FROM evidence WHERE rowid > ? ORDER BY rowid LIMIT ?';

/** Re-checks every evidence entry against its stored hash, a page at a time; returns how many it read. */
function recheckEvidence(db: DatabaseLike): number {
  const next = db.prepare(EVIDENCE_NEXT_PAGE);
  let page = db.prepare(EVIDENCE_FIRST_PAGE).all(EVIDENCE_RECHECK_PAGE);
  let checked = 0;
  while (page.length > 0) {
    for (const row of page) {
      if (evidenceEntrySha256(String(row['entry'])) !== row['entry_sha256']) {
        throw new Error(
          `Evidence entry ${String(row['seq'])} of run ${String(row['run_id'])} does not match its stored hash.`,
        );
      }
    }
    checked += page.length;
    if (page.length < EVIDENCE_RECHECK_PAGE) break;
    page = next.all(page[page.length - 1]!['r'], EVIDENCE_RECHECK_PAGE);
  }
  return checked;
}

function userVersion(db: DatabaseLike): number {
  return Number(db.prepare('PRAGMA user_version').get()?.['user_version']);
}

function describeDifference(difference: SchemaDifference): string {
  return [
    ...difference.missing.map((object) => `${object} is missing`),
    ...difference.extra.map((object) => `${object} is extra`),
    ...difference.changed.map((object) => `${object} has another text`),
  ].join('; ');
}

/** One step, in its own transaction: the file moves from `to - 1` to `to`, or not at all. */
function step(db: DatabaseLike, to: number, version: StoreSchemaVersion): SchemaStepReport {
  // Outside the try: a BEGIN that fails has opened nothing, so the ladder has nothing to roll back.
  db.exec('BEGIN IMMEDIATE');
  try {
    // Read again under the write lock: another process may have moved the file since it was read.
    const at = userVersion(db);
    if (at !== to - 1) {
      throw new Error(
        `The file moved to schema version ${at} while the ladder was taking it from version ${to - 1} to ${to}.`,
      );
    }
    for (const statement of version.upgrade) db.exec(statement);
    const difference = storedSchemaDifference(db, version.schema);
    if (difference.missing.length + difference.extra.length + difference.changed.length > 0) {
      throw new Error(
        `After the step to schema version ${to}, the file's schema is not version ${to}'s: ${describeDifference(difference)}.`,
      );
    }
    const evidenceChecked = recheckEvidence(db);
    db.exec(`PRAGMA user_version = ${to}`);
    db.exec('COMMIT');
    return { from: to - 1, to, statements: version.upgrade.length, evidenceChecked };
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Moves the file open on `db` from its schema version to `target`, one version at a time, each step in
 * its own transaction; returns one report per step, none when the file is already at `target`. Before
 * any step it throws a plain error for a transaction already open on `db` (a failing step's rollback
 * would end it), a `target` that `versions` does not hold, a file newer than `target`, and a file whose
 * version, or any version between it and `target`, `versions` does not hold (version 0, a file never
 * set up, included). A step that fails leaves the file at the version before it and throws.
 */
export function migrateSchema(
  db: DatabaseLike,
  target: number,
  versions: StoreSchemaVersions = REALM_STORE_VERSIONS,
): SchemaStepReport[] {
  if (db.isTransaction) {
    throw new Error(
      'The schema ladder runs each step in its own transaction, and a transaction is already open on this connection.',
    );
  }
  if (!versions.has(target))
    throw new Error(`Schema version ${target} is not one this Realm knows.`);
  const start = userVersion(db);
  if (start > target) {
    throw new Error(`The file is at schema version ${start}, newer than version ${target}.`);
  }
  for (let version = start; version <= target; version++) {
    if (!versions.has(version)) {
      throw new Error(
        `Schema version ${version} is not one this Realm knows, so the file cannot move from version ${start} to ${target}.`,
      );
    }
  }
  const reports: SchemaStepReport[] = [];
  for (let to = start + 1; to <= target; to++) reports.push(step(db, to, versions.get(to)!));
  return reports;
}
