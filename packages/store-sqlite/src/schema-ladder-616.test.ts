// schema-ladder-616.test.ts — issue #616 unit 6c: the upgrade ladder. The real case: the first release
// that changes the store's schema ships a step, and `realm db migrate` runs it over a user's populated
// `realm.db`. A step that dies halfway, a step whose result differs from what a fresh file of that
// version holds, a step that rewrites evidence, a second migrator at the same moment: each must leave the
// file at a version whose schema and rows are exactly that version's.
//
// Only version 1 exists, so the cells climb a synthetic ladder (`test-support/schema-versions.ts`). Version 1 is core's own entry
// (its schema IS the constant: no cell copies or counts its text); version 2 adds two tables and fills
// the first; version 3 rebuilds the first table with a new column, the design owner's way (the old table renamed away,
// the new one created under its final name with its exact text, the rows copied, the old one dropped),
// and adds an index. Every cell works on a real file through the loader.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REALM_STORE_SCHEMA, REALM_STORE_VERSIONS, type StoreSchemaVersions } from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseLike } from './driver.js';
import { EVIDENCE_RECHECK_PAGE, migrateSchema, storedSchemaDifference } from './schema-ladder.js';
// The synthetic ladder (versions 2 and 3, their steps and tables), shared with c6's maintenance cells.
import { ladder, STEP_3, V2_SCHEMA, V3_SCHEMA } from './test-support/schema-versions.js';

const dirs: string[] = [];
const connections: DatabaseLike[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) {
    try {
      db.close();
    } catch {
      // closed by its cell
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-6c-'));
  dirs.push(dir);
  return join(dir, 'realm.db');
}

function connect(file: string): DatabaseLike {
  const db = openDatabase(file);
  connections.push(db);
  return db;
}

/** The entry hash, computed here and not by the package, so a package that hashes otherwise is red. */
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * A version-1 file as unit 7 will make one (core's schema, then the version), holding one run with
 * `entries` evidence entries and its write-once field.
 */
function versionOneFile(entries = 2): { file: string; db: DatabaseLike } {
  const file = newFile();
  const db = connect(file);
  for (const statement of REALM_STORE_SCHEMA) db.exec(statement);
  db.exec('PRAGMA user_version = 1');
  const record = {
    id: 'run-1',
    workflow_id: 'wf',
    version: 1,
    created_at: '2026-11-05T10:00:00.000Z',
    updated_at: '2026-11-05T10:00:00.000Z',
    terminal_state: false,
    run_phase: { $realm_derived: 'run_phase' },
  };
  db.prepare(
    'INSERT INTO runs (id, record, run_phase, phase_version, key_hash) VALUES (?, ?, ?, ?, ?)',
  ).run('run-1', JSON.stringify(record), 'running', '0123456789abcdef', null);
  const evidence = db.prepare(
    'INSERT INTO evidence (run_id, seq, entry, entry_sha256) VALUES (?, ?, ?, ?)',
  );
  db.exec('BEGIN');
  for (let seq = 0; seq < entries; seq++) {
    const entry = JSON.stringify({ step: `step-${seq}`, said: 'café' });
    evidence.run('run-1', seq, entry, sha256(entry));
  }
  db.exec('COMMIT');
  db.prepare('INSERT INTO run_blobs (run_id, name, value) VALUES (?, ?, ?)').run(
    'run-1',
    'workflow_context_snapshots',
    '{"a":1}',
  );
  return { file, db };
}

/** What a second connection reads in the file: its version, its schema's texts sorted, its rows. */
function onDisk(file: string) {
  const db = openDatabase(file);
  try {
    const all = (sql: string) => db.prepare(sql).all();
    const hasNotes = all("SELECT 1 FROM sqlite_master WHERE name = 'ladder_notes'").length > 0;
    return {
      version: Number(db.prepare('PRAGMA user_version').get()?.['user_version']),
      schema: all('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY sql').map(
        (row) => row['sql'],
      ),
      runs: all('SELECT id, record FROM runs ORDER BY id'),
      evidence: all('SELECT run_id, seq, entry, entry_sha256 FROM evidence ORDER BY run_id, seq'),
      blobs: all('SELECT run_id, name, value FROM run_blobs ORDER BY run_id, name'),
      notes: hasNotes ? all('SELECT * FROM ladder_notes ORDER BY rowid') : 'no table',
    };
  } finally {
    db.close();
  }
}

/** The error a call throws, as its message; `'no error'` when it returns. */
function thrown(call: () => unknown): string {
  try {
    call();
    return 'no error';
  } catch (err) {
    return (err as Error).message;
  }
}

describe('#616 unit 6c — the upgrade ladder', () => {
  it('a populated version-1 file climbs through versions 2 and 3: it ends at version 3 with version 3’s schema and its rows, and the ladder reports one record per step', () => {
    const { file, db } = versionOneFile();
    const before = onDisk(file);
    const reports = migrateSchema(db, 3, ladder());
    // (1) Can it fail: red when a step's statements do not run, its version is not stamped (the
    //     named break: the stamp left out, so step 3 finds the file still at 1), a step's record is
    //     missing or miscounts its statements or the entries it re-checked, or a step loses rows.
    // (2) Prints: the step records and, read by a second connection, the version, the schema's texts
    //     and the rows (one test run of synthetic data; no secret).
    expect({ reports, file: onDisk(file) }).toEqual({
      reports: [
        { from: 1, to: 2, statements: 3, evidenceChecked: 2 },
        { from: 2, to: 3, statements: 5, evidenceChecked: 2 },
      ],
      file: {
        ...before,
        version: 3,
        schema: [...V3_SCHEMA].sort(),
        notes: [{ k: 'written by step 2', w: null }],
      },
    });
  });

  it('a step whose result is not its version’s schema is refused inside its own transaction: the file stays at version 2 with version 2’s schema', () => {
    const { file, db } = versionOneFile();
    // Version 3's step builds its index on the other column.
    const drift = [...STEP_3.slice(0, -1), 'CREATE INDEX ladder_notes_by_k ON ladder_notes (w)'];
    const error = thrown(() => migrateSchema(db, 3, ladder(drift)));
    // (1) Can it fail: red when the step's result is not compared with its version's schema (the
    //     named break: the comparison skipped), so step 3 commits a schema no fresh version-3 file
    //     holds, or when the comparison runs after the version moves.
    // (2) Prints: the error and the file's version and schema texts.
    expect({ error, file: onDisk(file) }).toMatchObject({
      error:
        "After the step to schema version 3, the file's schema is not version 3's: index ladder_notes_by_k has another text.",
      file: { version: 2, schema: [...V2_SCHEMA].sort() },
    });
  });

  it('a step that fails partway leaves version 2 intact: its schema, its version and its rows, as a second connection reads them', () => {
    const { file, db } = versionOneFile();
    migrateSchema(db, 2, ladder());
    const atTwo = onDisk(file);
    const failing = [
      ...STEP_3,
      "INSERT INTO ladder_notes (k) VALUES ('written by step 3')",
      'INSERT INTO ladder_missing_table VALUES (1)',
    ];
    const error = thrown(() => migrateSchema(db, 3, ladder(failing)));
    // (1) Can it fail: red when the version is stamped outside the step's transaction (the named
    //     break: the stamp committed in a transaction of its own before the step's statements, as
    //     products that stamp in a separate step do), so a failed step leaves version 3 over
    //     version 2's tables; or when a statement of the failed step stays in the file.
    // (2) Prints: SQLite's error and the file's version, schema texts and rows.
    expect({ error, file: onDisk(file) }).toEqual({
      error: 'no such table: ladder_missing_table',
      file: atTwo,
    });
  });

  it('a file that climbed to version 3 holds the same schema objects as a file created at version 3, though its rebuilt table sits elsewhere in its order', () => {
    const { db } = versionOneFile();
    migrateSchema(db, 3, ladder());
    const fresh = connect(newFile());
    for (const statement of V3_SCHEMA) fresh.exec(statement);
    fresh.exec('PRAGMA user_version = 3');
    const objects = (d: DatabaseLike) =>
      d.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all();
    const order = (d: DatabaseLike) =>
      d
        .prepare('SELECT name FROM sqlite_master ORDER BY rowid')
        .all()
        .map((row) => String(row['name']))
        .join(' ');
    // (1) Can it fail: red when a step leaves an object a fresh file of its version lacks (the named
    //     break: version 3's step also creates `ladder_extra`), or when the climb's compare reads
    //     order (the rebuilt table sits after the objects created later; `orderDiffers` keeps this
    //     cell about that case).
    // (2) Prints: both files' objects by type and name, and whether the orders differ.
    expect({ objects: objects(db), orderDiffers: order(db) !== order(fresh) }).toEqual({
      objects: objects(fresh),
      orderDiffers: true,
    });
  });

  it('a step that rewrites an evidence entry fails, even when it puts back the guard it lifted exactly as it was: the entry and the version stay', () => {
    // More entries than one page of the re-check reads; the last one is rewritten.
    const { file, db } = versionOneFile(EVIDENCE_RECHECK_PAGE + 1);
    const before = onDisk(file);
    const guard = REALM_STORE_SCHEMA.find((s) =>
      s.startsWith('CREATE TRIGGER evidence_no_update '),
    );
    const rewrite: StoreSchemaVersions = new Map([
      ...REALM_STORE_VERSIONS,
      [
        2,
        {
          schema: REALM_STORE_SCHEMA,
          upgrade: [
            'DROP TRIGGER evidence_no_update',
            `UPDATE evidence SET entry = '{"rewritten":true}' WHERE run_id = 'run-1' AND seq = ${EVIDENCE_RECHECK_PAGE}`,
            String(guard),
          ],
        },
      ],
    ]);
    const error = thrown(() => migrateSchema(db, 2, rewrite));
    // (1) Can it fail: red when the step does not re-check the evidence hashes (the named break: the
    //     re-check dropped), or reads only the first page of entries; the schema compare cannot see
    //     this step, because the guard it lifted is back with its exact text.
    // (2) Prints: the error (an entry number and a test run id) and the file's version, schema and rows.
    expect({ guardFound: guard !== undefined, error, file: onDisk(file) }).toEqual({
      guardFound: true,
      error: `Evidence entry ${EVIDENCE_RECHECK_PAGE} of run run-1 does not match its stored hash.`,
      file: before,
    });
  });

  it('a file already at the target is left as it is, byte for byte; a file made from core’s constant is at version 1 of core’s table', () => {
    const { file: one, db: atOne } = versionOneFile();
    const oneBytes = readFileSync(one);
    const { file: two, db: atTwo } = versionOneFile();
    migrateSchema(atTwo, 2, ladder());
    const twoBytes = readFileSync(two);
    // (1) Can it fail: red when the climb starts at the file's own version (the named break), which
    //     runs a step into the version the file is already at; or when core's version 1 is not the
    //     schema a file made from the constant holds (7b's open of every fresh file would refuse it).
    // (2) Prints: the step records, the differences found, and whether each file's bytes changed.
    expect({
      coreReports: migrateSchema(atOne, 1),
      coreDifference: storedSchemaDifference(atOne, REALM_STORE_VERSIONS.get(1)?.schema ?? []),
      oneUnchanged: readFileSync(one).equals(oneBytes),
      ladderReports: migrateSchema(atTwo, 2, ladder()),
      twoUnchanged: readFileSync(two).equals(twoBytes),
    }).toEqual({
      coreReports: [],
      coreDifference: { missing: [], extra: [], changed: [] },
      oneUnchanged: true,
      ladderReports: [],
      twoUnchanged: true,
    });
  });

  it('a file newer than the target is refused before any step, and stays as it is', () => {
    const { file, db } = versionOneFile();
    migrateSchema(db, 3, ladder());
    const bytes = readFileSync(file);
    const error = thrown(() => migrateSchema(db, 2, ladder()));
    // (1) Can it fail: red when a newer file is not refused (the named break: the check removed;
    //     the climb then finds no step and returns as if done).
    // (2) Prints: the error and whether the file's bytes changed.
    expect({ error, unchanged: readFileSync(file).equals(bytes) }).toEqual({
      error: 'The file is at schema version 3, newer than version 2.',
      unchanged: true,
    });
  });

  it('what the ladder cannot climb is refused before any step: a file never set up, a target the table lacks, a table with a gap, and a transaction already open, which it leaves open', () => {
    const empty = newFile();
    const neverSetUp = connect(empty);
    const { file, db } = versionOneFile();
    const bytes = readFileSync(file);
    const gap: StoreSchemaVersions = new Map([
      ...REALM_STORE_VERSIONS,
      [3, { schema: V3_SCHEMA, upgrade: STEP_3 }],
    ]);
    const rows = {
      neverSetUp: thrown(() => migrateSchema(neverSetUp, 1)),
      targetLacking: thrown(() => migrateSchema(db, 4, ladder())),
      gap: thrown(() => migrateSchema(db, 3, gap)),
    };
    const unchanged = readFileSync(file).equals(bytes) && readFileSync(empty).length === 0;
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO run_blobs (run_id, name, value) VALUES (?, ?, ?)').run(
      'run-2',
      'workflow_context_snapshots',
      '{}',
    );
    const open = thrown(() => migrateSchema(db, 2, ladder()));
    const callersWork = {
      stillOpen: db.isTransaction,
      rowSeen: db.prepare("SELECT count(*) AS n FROM run_blobs WHERE run_id = 'run-2'").get()?.[
        'n'
      ],
    };
    db.exec('ROLLBACK');
    // (1) Can it fail: red when a version outside the table reaches a step (the named breaks: the
    //     table check removed, so a file at version 0 is compared with version 1 and a gap throws a
    //     TypeError; the target check removed, so the target is caught later in other words), or
    //     when a transaction already open is not refused before the ladder's own BEGIN (the named
    //     break: the check removed, so SQLite's own words arrive), or is ended by the ladder.
    // (2) Prints: each refusal's words, whether the files changed, and the caller's transaction.
    expect({ ...rows, unchanged, open, callersWork }).toEqual({
      neverSetUp:
        'Schema version 0 is not one this Realm knows, so the file cannot move from version 0 to 1.',
      targetLacking: 'Schema version 4 is not one this Realm knows.',
      gap: 'Schema version 2 is not one this Realm knows, so the file cannot move from version 1 to 3.',
      unchanged: true,
      open: 'The schema ladder runs each step in its own transaction, and a transaction is already open on this connection.',
      callersWork: { stillOpen: true, rowSeen: 1 },
    });
  });

  it('a file another migrator moves while the ladder waits for its lock is refused under the lock, so a data step is never applied twice', () => {
    // Two data steps: the schema stays version 1's; each moves the run's record on by one.
    const bump = (to: number) =>
      `UPDATE runs SET record = json_set(record, '$.version', json_extract(record, '$.version') + 1, '$.migrated_to', ${to})`;
    const dataLadder: StoreSchemaVersions = new Map([
      ...REALM_STORE_VERSIONS,
      [2, { schema: REALM_STORE_SCHEMA, upgrade: [bump(2)] }],
      [3, { schema: REALM_STORE_SCHEMA, upgrade: [bump(3)] }],
    ]);
    const { file, db } = versionOneFile();
    const other = connect(file);
    // Our connection, except that the other migrator runs the whole climb at the moment between the
    // ladder's first read of the version and its first lock.
    let raced = false;
    const racing: DatabaseLike = {
      exec(sql) {
        if (!raced && sql === 'BEGIN IMMEDIATE') {
          raced = true;
          migrateSchema(other, 3, dataLadder);
        }
        db.exec(sql);
      },
      prepare: (sql) => db.prepare(sql),
      close: () => db.close(),
      get isTransaction() {
        return db.isTransaction;
      },
    };
    const error = thrown(() => migrateSchema(racing, 3, dataLadder));
    const run = JSON.parse(String(onDisk(file).runs[0]?.['record'])) as Record<string, unknown>;
    // (1) Can it fail: red when the step does not read the version again under its lock (the named
    //     break: the re-read removed), so steps 2 and 3 run a second time over a file already at 3.
    // (2) Prints: the error, the file's version and the run's record version and last step.
    expect({
      raced,
      error,
      version: onDisk(file).version,
      record: [run['version'], run['migrated_to']],
    }).toEqual({
      raced: true,
      error:
        'The file moved to schema version 3 while the ladder was taking it from version 1 to 2.',
      version: 3,
      record: [3, 3],
    });
  });
});

describe('#616 unit 6c — the one compare of a stored schema with a version’s', () => {
  it('ignores the statistics table ANALYZE adds, and names an object missing, an object extra and an object with another text', () => {
    const { db } = versionOneFile();
    migrateSchema(db, 3, ladder());
    const after = (change: string) => {
      db.exec(change);
      return storedSchemaDifference(db, V3_SCHEMA);
    };
    const rows = {
      analyzed: after('ANALYZE'),
      missing: after('DROP INDEX ladder_notes_by_k'),
      changed: after('CREATE INDEX ladder_notes_by_k ON ladder_notes (w)'),
      extra: after(
        "CREATE TRIGGER ladder_foreign BEFORE DELETE ON ladder_notes BEGIN SELECT RAISE(ABORT, 'no'); END",
      ),
    };
    const none = { missing: [], extra: [], changed: [] };
    // (1) Can it fail: red when the statistics table counts as a difference (the named break: it is
    //     no longer skipped), so a file someone ran ANALYZE on reads as not its version; or when a
    //     missing, extra or changed object is not named.
    // (2) Prints: each row's differences, as type and name (test objects only).
    expect(rows).toEqual({
      analyzed: none,
      missing: { ...none, missing: ['index ladder_notes_by_k'] },
      changed: { ...none, changed: ['index ladder_notes_by_k'] },
      extra: {
        ...none,
        changed: ['index ladder_notes_by_k'],
        extra: ['trigger ladder_foreign'],
      },
    });
  });
});
