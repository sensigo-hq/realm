// store-schema-616.test.ts — issue #616 unit 6: the run tables' schema and the guards that bind any
// writer. The real case: a tool that is not Realm (a SQLite shell, a script, a sync tool) opens the
// user's `realm.db` and rewrites a run's evidence, changes a run's identity, re-creates a run, or skips
// a version, perhaps after switching CHECKs off with `PRAGMA ignore_check_constraints = 1`. Each cell
// opens a database through the loader, creates the schema from core's constant, and acts as that
// foreign writer with plain SQL; there is no store class yet.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import {
  REALM_STORE_APPLICATION_ID,
  REALM_STORE_PAGE_SIZE,
  REALM_STORE_SCHEMA,
  REALM_STORE_SCHEMA_VERSION,
  WRITE_ONCE_RUN_FIELDS,
} from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseLike } from './driver.js';

/** The guards' messages, written out here so a typo in the schema is a red cell (prompt's table). */
const MSG = {
  fence: "realm.db: a run's version can only advance by one",
  identity: "realm.db: a run's identity cannot change",
  exists: 'realm.db: a run with this id already exists',
  invalidRun:
    'realm.db: a run record must be valid JSON, carry its own id, and pair its key hash with its key',
  unfinished: 'realm.db: a run that is not finished cannot be deleted',
  evidence: 'realm.db: evidence rows are append-only',
  writeOnce: 'realm.db: a write-once field cannot change',
  invalidJson: 'realm.db: evidence and fields must be valid JSON',
  rowNumber: 'realm.db: a row number must be 1 or more',
  // Unit 6b.
  purged: 'realm.db: a purged run id cannot be created again',
  tombstone: 'realm.db: the tombstone record is append-only',
  liveAsPurged: 'realm.db: a live run cannot be recorded as purged',
  metaReplaced: "realm.db: the store's meta row cannot be replaced or deleted",
  horizon: "realm.db: the store's recorded horizon cannot move backwards",
  metaTypes: "realm.db: the store's meta row holds whole numbers and timestamps of one shape",
} as const;

const PHASE_STAMP = '0123456789abcdef';
/** When the test store was created: its meta row's `created_at` and first horizon (unit 6b). */
const CREATED = '2026-11-05T09:00:00.000Z';
/** The store's meta row as unit 7 writes it at creation: page size, counters at 0, horizon at creation. */
const META_ROW =
  'INSERT INTO store_meta (one, page_size, commit_epoch, created_at, tomb_seq, tombstones_through_seq, tombstones_since) VALUES (1, ?, 0, ?, 0, 0, ?)';
const open: DatabaseLike[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

/**
 * A database holding the schema, made the way unit 7 will make one: each statement in order, then the
 * store's meta row (without it a run cannot be deleted: its tombstone takes the meta row's counter).
 */
function fresh(): DatabaseLike {
  const db = openDatabase(':memory:');
  open.push(db);
  for (const statement of REALM_STORE_SCHEMA) db.exec(statement);
  db.prepare(META_ROW).run(REALM_STORE_PAGE_SIZE, CREATED, CREATED);
  return db;
}

/** What one statement does: `'landed'`, or the message it was refused with. */
function outcome(db: DatabaseLike, sql: string, ...params: unknown[]): string {
  try {
    db.prepare(sql).run(...params);
    return 'landed';
  } catch (err) {
    return (err as Error).message;
  }
}

/** A stored run document as the store keeps it (phase placeholder in place). */
function doc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run-1',
    workflow_id: 'wf',
    version: 1,
    created_at: '2026-11-05T10:00:00.000Z',
    updated_at: '2026-11-05T10:00:00.000Z',
    terminal_state: false,
    run_phase: { $realm_derived: 'run_phase' },
    ...over,
  };
}

const INSERT_RUN =
  'INSERT INTO runs (id, record, run_phase, phase_version, key_hash) VALUES (?, ?, ?, ?, ?)';

/** Inserts a run as Realm will: its id, its document, its phase index and its key's hash. */
function addRun(db: DatabaseLike, record: Record<string, unknown>, keyHash: string | null = null) {
  db.prepare(INSERT_RUN).run(record['id'], JSON.stringify(record), 'running', PHASE_STAMP, keyHash);
}

/** Sets a pragma for the cells that run the same statement with the CHECKs on and off. */
function pragma(db: DatabaseLike, name: string, value: 0 | 1) {
  db.exec(`PRAGMA ${name} = ${value}`);
}

describe('#616 unit 6 — the schema constant', () => {
  it('a database created from the constant stores exactly its text, and holds its nine tables, four indexes and thirty-six triggers', () => {
    const db = fresh();
    const rows = db
      .prepare('SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid')
      .all();
    // (1) red when a statement in the constant is written in a form SQLite stores differently (with
    //     `IF NOT EXISTS`, or a trailing `;`), so the open's compare would call every fresh file
    //     tampered; when a guard named in the prompt is missing, renamed or added without this list;
    //     (2) prints the stored texts against the constant, and the stored objects by type and name.
    expect({
      texts: rows.map((r) => r['sql']),
      objects: rows.map((r) => `${String(r['type'])} ${String(r['name'])}`),
    }).toEqual({
      texts: [...REALM_STORE_SCHEMA],
      objects: [
        'table runs',
        'index runs_by_phase',
        'index runs_by_phase_version',
        'index runs_by_key',
        'trigger runs_version_fence',
        'trigger runs_identity',
        'trigger runs_insert_once',
        'trigger runs_insert_valid',
        'trigger runs_delete_finished',
        'table evidence',
        'trigger evidence_insert_valid',
        'trigger evidence_insert_once',
        'trigger evidence_no_update',
        'trigger evidence_delete_after_run',
        'table run_blobs',
        'trigger run_blobs_insert_valid',
        'trigger run_blobs_insert_once',
        'trigger run_blobs_no_update',
        'trigger run_blobs_delete_after_run',
        'trigger runs_update_valid',
        'trigger runs_insert_rowid_free',
        'trigger runs_rowid_fixed',
        'trigger evidence_insert_rowid_free',
        'trigger run_blobs_insert_rowid_free',
        'trigger runs_rowid_positive',
        'trigger evidence_rowid_positive',
        'trigger run_blobs_rowid_positive',
        'table store_meta',
        'trigger store_meta_insert_once',
        'trigger store_meta_no_delete',
        'trigger store_meta_immutable',
        'trigger store_meta_forward',
        'trigger store_meta_insert_types',
        'trigger store_meta_update_types',
        'table write_clock',
        'table purged_ids',
        'trigger runs_insert_not_purged',
        'trigger purged_ids_insert_once',
        'trigger purged_ids_not_live',
        'trigger purged_ids_no_update',
        'trigger purged_ids_no_delete',
        'table purged_runs',
        'index purged_runs_by_key',
        'trigger purged_runs_insert_own',
        'trigger purged_runs_no_update',
        'trigger purged_runs_delete_below_horizon',
        'trigger runs_tombstone',
        'table failed_attempts',
        'table replays',
      ],
    });
  });

  it("the file's header values are the design's, and SQLite takes them", () => {
    const db = openDatabase(':memory:');
    open.push(db);
    db.exec(`PRAGMA page_size = ${REALM_STORE_PAGE_SIZE}`);
    db.exec(`PRAGMA application_id = ${REALM_STORE_APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${REALM_STORE_SCHEMA_VERSION}`);
    for (const statement of REALM_STORE_SCHEMA) db.exec(statement);
    const read = (name: string) => Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0];
    const id = REALM_STORE_APPLICATION_ID;
    // (1) red when one of the three values changes (each is fixed in every user's file from the first
    //     release), or when SQLite ignores one (a page size it does not accept is silently dropped);
    //     (2) prints the values the database reports and the id spelled as four characters.
    expect({
      pageSize: read('page_size'),
      applicationId: read('application_id'),
      spelled: String.fromCharCode(id >>> 24, (id >>> 16) & 255, (id >>> 8) & 255, id & 255),
      userVersion: read('user_version'),
    }).toEqual({ pageSize: 16384, applicationId: 0x5245414c, spelled: 'REAL', userVersion: 1 });
  });
});

describe('#616 unit 6 — a run record moves its version by exactly one', () => {
  const UPDATE = 'UPDATE runs SET record = ? WHERE id = ?';

  it('an update of the record by +1 lands; +2, +0 and a step back are refused', () => {
    const db = fresh();
    addRun(db, doc({ version: 5 }));
    const to = (version: number) => outcome(db, UPDATE, JSON.stringify(doc({ version })), 'run-1');
    const refused = { plus2: to(7), same: to(5), back: to(4) };
    const plus1 = to(6);
    // (1) red when the fence is dropped (the three refused updates land) or written so it refuses +1;
    //     (2) prints each update's outcome.
    expect({ refused, plus1 }).toEqual({
      refused: { plus2: MSG.fence, same: MSG.fence, back: MSG.fence },
      plus1: 'landed',
    });
  });

  it('the re-stamp of the phase index (run_phase and phase_version only) needs no version bump', () => {
    const db = fresh();
    addRun(db, doc());
    const restamp = outcome(
      db,
      'UPDATE runs SET run_phase = ?, phase_version = ? WHERE id = ?',
      'completed',
      'fedcba9876543210',
      'run-1',
    );
    const row = db.prepare('SELECT run_phase, phase_version, version, workflow_id FROM runs').get();
    // (1) red when the fence fires on every update instead of only on an update of the record (the
    //     re-stamp is refused), or when a guard compares generated columns that read NULL here;
    //     (2) prints the outcome and the row after it.
    expect({ restamp, row }).toEqual({
      restamp: 'landed',
      row: {
        run_phase: 'completed',
        phase_version: 'fedcba9876543210',
        version: 1,
        workflow_id: 'wf',
      },
    });
  });
});

describe("#616 unit 6 — a run's identity cannot change", () => {
  // Each cell changes ONE part of the identity, with the version moved by one where the record is
  // set, so only that part's clause stands between the statement and the file.
  const keyed = () => doc({ idempotency_key: 'key-1' });
  const cases: Array<[string, string, unknown[]]> = [
    ['the id', 'UPDATE runs SET id = ? WHERE id = ?', ['run-2', 'run-1']],
    ['the key hash', 'UPDATE runs SET key_hash = ? WHERE id = ?', ['hash-2', 'run-1']],
    [
      "the record's id",
      'UPDATE runs SET record = ? WHERE id = ?',
      [JSON.stringify({ ...keyed(), id: 'run-2', version: 2 }), 'run-1'],
    ],
    [
      "the record's workflow id",
      'UPDATE runs SET record = ? WHERE id = ?',
      [JSON.stringify({ ...keyed(), workflow_id: 'wf-2', version: 2 }), 'run-1'],
    ],
    [
      "the record's idempotency key",
      'UPDATE runs SET record = ? WHERE id = ?',
      [JSON.stringify({ ...keyed(), idempotency_key: 'key-2', version: 2 }), 'run-1'],
    ],
    [
      "the record's creation time",
      'UPDATE runs SET record = ? WHERE id = ?',
      [JSON.stringify({ ...keyed(), created_at: '2026-11-04T10:00:00.000Z', version: 2 }), 'run-1'],
    ],
  ];

  for (const [part, sql, params] of cases) {
    it(`a change of ${part} is refused, also with CHECKs off`, () => {
      const results: string[] = [];
      for (const checksOff of [0, 1] as const) {
        const db = fresh();
        addRun(db, keyed(), 'hash-1');
        pragma(db, 'ignore_check_constraints', checksOff);
        results.push(outcome(db, sql, ...params));
      }
      // (1) red when this part's clause is removed from the identity guard (the change lands with
      //     CHECKs off, or meets a CHECK's message with them on), whatever the other clauses hold;
      //     (2) prints the outcome with CHECKs on, then off.
      expect(results).toEqual([MSG.identity, MSG.identity]);
    });
  }
});

describe('#616 unit 6 — a run is created once, from a record that carries its own identity', () => {
  it('an existing id is refused by a plain insert, INSERT OR REPLACE, REPLACE INTO and an upsert, on a finished run, with recursive triggers off and on', () => {
    // A finished run: the delete guard would let REPLACE's implicit delete through, so only the
    // insert guard can refuse (on a live run with recursive triggers on, the delete guard also would).
    const finished = doc({ terminal_state: true });
    const again = JSON.stringify({ ...finished, version: 2 });
    const forms: Record<string, string> = {
      insert: INSERT_RUN,
      insertOrReplace: INSERT_RUN.replace('INSERT INTO', 'INSERT OR REPLACE INTO'),
      replaceInto: INSERT_RUN.replace('INSERT INTO', 'REPLACE INTO'),
      upsert: `${INSERT_RUN} ON CONFLICT(id) DO UPDATE SET record = excluded.record`,
    };
    const results: Record<string, string> = {};
    for (const recursive of [0, 1] as const) {
      for (const [form, sql] of Object.entries(forms)) {
        const db = fresh();
        addRun(db, finished);
        pragma(db, 'recursive_triggers', recursive);
        const res = outcome(db, sql, 'run-1', again, 'running', PHASE_STAMP, null);
        const count = db.prepare('SELECT count(*) AS n FROM runs').get()?.['n'];
        results[`${form}/recursive=${recursive}`] = `${res} (rows: ${String(count)})`;
      }
    }
    const want = `${MSG.exists} (rows: 1)`;
    // (1) red when the insert guard is dropped: the plain insert meets the key's own UNIQUE message,
    //     the two REPLACE forms re-create the run (it lands), the upsert becomes an update;
    //     (2) prints each form's outcome and the row count after it.
    expect(results).toEqual({
      'insert/recursive=0': want,
      'insertOrReplace/recursive=0': want,
      'replaceInto/recursive=0': want,
      'upsert/recursive=0': want,
      'insert/recursive=1': want,
      'insertOrReplace/recursive=1': want,
      'replaceInto/recursive=1': want,
      'upsert/recursive=1': want,
    });
  });

  it('a record that is JSON5 rather than JSON, is absent, has no id, has another id, or does not pair its key hash with its key is refused, also with CHECKs off', () => {
    const cases: Record<string, unknown[]> = {
      // SQLite reads JSON5 (unquoted keys) without error, so only the guard's validity clause stops it.
      'JSON5, not JSON': [
        'run-1',
        '{id:"run-1",workflow_id:"wf",version:1}',
        'running',
        PHASE_STAMP,
        null,
      ],
      'no record': ['run-1', null, 'running', PHASE_STAMP, null],
      'no id anywhere': [
        null,
        JSON.stringify(doc({ id: undefined })),
        'running',
        PHASE_STAMP,
        null,
      ],
      'another id': ['run-9', JSON.stringify(doc()), 'running', PHASE_STAMP, null],
      'a key hash without a key': [
        'run-1',
        JSON.stringify(doc()),
        'running',
        PHASE_STAMP,
        'hash-1',
      ],
      'a key without a key hash': [
        'run-1',
        JSON.stringify(doc({ idempotency_key: 'key-1' })),
        'running',
        PHASE_STAMP,
        null,
      ],
    };
    const results: Record<string, string> = {};
    for (const checksOff of [0, 1] as const) {
      for (const [name, params] of Object.entries(cases)) {
        const db = fresh();
        pragma(db, 'ignore_check_constraints', checksOff);
        results[`${name}/checksOff=${checksOff}`] = outcome(db, INSERT_RUN, ...params);
      }
    }
    // (1) red when a clause of the validity guard is removed: that case lands with CHECKs off, or
    //     meets SQLite's own NOT NULL or CHECK message instead of the guard's; (2) prints each case.
    expect(results).toEqual(
      Object.fromEntries(
        Object.keys(cases).flatMap((name) => [
          [`${name}/checksOff=0`, MSG.invalidRun],
          [`${name}/checksOff=1`, MSG.invalidRun],
        ]),
      ),
    );
  });

  it("a record that is not JSON at all is refused by SQLite's own words, before any guard runs, also with CHECKs off (DELTAS row 23)", () => {
    const results: string[] = [];
    for (const checksOff of [0, 1] as const) {
      const db = fresh();
      pragma(db, 'ignore_check_constraints', checksOff);
      results.push(
        outcome(db, INSERT_RUN, 'run-1', '{"id": "run-1",', 'running', PHASE_STAMP, null),
      );
    }
    // (1) red when malformed text reaches the file (a generated column that no longer reads the
    //     record, with the validity guard gone), or when the refusal's words change, which the store's
    //     error mapping matches; (2) prints the outcome with CHECKs on, then off.
    expect(results).toEqual(['malformed JSON', 'malformed JSON']);
  });

  it('a well-formed run lands, keyed or not', () => {
    const db = fresh();
    addRun(db, doc());
    const keyed = outcome(
      db,
      INSERT_RUN,
      'run-2',
      JSON.stringify(doc({ id: 'run-2', idempotency_key: 'key-1' })),
      'running',
      PHASE_STAMP,
      'hash-1',
    );
    const ids = db.prepare('SELECT id, key_hash FROM runs ORDER BY id').all();
    // (1) red when a guard refuses a valid run (a clause written the wrong way round);
    //     (2) prints the keyed insert's outcome and the rows.
    expect({ keyed, ids }).toEqual({
      keyed: 'landed',
      ids: [
        { id: 'run-1', key_hash: null },
        { id: 'run-2', key_hash: 'hash-1' },
      ],
    });
  });
});

describe('#616 unit 6 — only a finished run is deleted', () => {
  it('a run whose terminal state is true deletes; false and absent are refused', () => {
    const results: Record<string, string> = {};
    for (const [name, state] of [
      ['true', true],
      ['false', false],
      ['absent', undefined],
    ] as const) {
      const db = fresh();
      addRun(db, doc({ terminal_state: state }));
      results[name] = outcome(db, 'DELETE FROM runs WHERE id = ?', 'run-1');
    }
    // (1) red when the delete guard is dropped (false and absent are deleted), or when it treats an
    //     absent state as finished, or refuses a finished run; (2) prints each outcome.
    expect(results).toEqual({ true: 'landed', false: MSG.unfinished, absent: MSG.unfinished });
  });
});

describe('#616 unit 6 — evidence rows and write-once fields', () => {
  const tables = [
    {
      table: 'evidence',
      key: 'seq',
      payload: 'entry',
      message: MSG.evidence,
      insert: 'INSERT INTO evidence (run_id, seq, entry, entry_sha256) VALUES (?, ?, ?, ?)',
      row: (key: number | string, payload: string) => ['run-1', key, payload, 'sha-' + String(key)],
      first: 0 as number | string,
      next: 1 as number | string | undefined,
    },
    {
      table: 'run_blobs',
      key: 'name',
      payload: 'value',
      message: MSG.writeOnce,
      insert: 'INSERT INTO run_blobs (run_id, name, value) VALUES (?, ?, ?)',
      row: (key: number | string, payload: string) => ['run-1', key, payload],
      first: 'workflow_context_snapshots' as number | string,
      // A run has one row per write-once field; the list has one member today.
      next: undefined as number | string | undefined,
    },
  ];

  for (const t of tables) {
    it(`${t.table}: an update, INSERT OR REPLACE, REPLACE INTO, a repeated key and a delete while the run exists are refused`, () => {
      const statements: Record<string, [string, unknown[]]> = {
        update: [`UPDATE ${t.table} SET ${t.payload} = ? WHERE run_id = ?`, ['{"b":2}', 'run-1']],
        insertOrReplace: [
          t.insert.replace('INSERT INTO', 'INSERT OR REPLACE INTO'),
          t.row(t.first, '{"b":2}'),
        ],
        replaceInto: [t.insert.replace('INSERT INTO', 'REPLACE INTO'), t.row(t.first, '{"b":2}')],
        repeatedKey: [t.insert, t.row(t.first, '{"b":2}')],
        deleteWhileRunExists: [`DELETE FROM ${t.table} WHERE run_id = ?`, ['run-1']],
      };
      const results: Record<string, string> = {};
      for (const [name, [sql, params]] of Object.entries(statements)) {
        const db = fresh();
        addRun(db, doc({ terminal_state: true }));
        db.prepare(t.insert).run(...t.row(t.first, '{"a":1}'));
        const res = outcome(db, sql, ...params);
        const stored = db.prepare(`SELECT ${t.payload} AS p FROM ${t.table}`).all();
        results[name] = `${res} ${JSON.stringify(stored.map((r) => r['p']))}`;
      }
      const want = `${t.message} ["{\\"a\\":1}"]`;
      // (1) red when one of the table's guards is dropped: the update or a replace rewrites the row,
      //     the repeated key meets the key's UNIQUE message, the delete removes it while its run
      //     exists; (2) prints each statement's outcome and the rows left.
      expect(results).toEqual({
        update: want,
        insertOrReplace: want,
        replaceInto: want,
        repeatedKey: want,
        deleteWhileRunExists: want,
      });
    });

    it(`${t.table}: a payload that is not valid JSON is refused, also with CHECKs off`, () => {
      const results: string[] = [];
      for (const checksOff of [0, 1] as const) {
        const db = fresh();
        addRun(db, doc());
        pragma(db, 'ignore_check_constraints', checksOff);
        results.push(outcome(db, t.insert, ...t.row(t.first, '{"a":')));
      }
      // (1) red when the table's validity guard is dropped (CHECK's message with CHECKs on; the row
      //     lands with them off); (2) prints the outcome with CHECKs on, then off.
      expect(results).toEqual([MSG.invalidJson, MSG.invalidJson]);
    });

    it(`${t.table}: ${t.next === undefined ? '' : 'the next key inserts while the run exists; '}after the run row is deleted, its rows delete`, () => {
      const db = fresh();
      addRun(db, doc({ terminal_state: true }));
      db.prepare(t.insert).run(...t.row(t.first, '{"a":1}'));
      const nextKey =
        t.next === undefined ? 'landed' : outcome(db, t.insert, ...t.row(t.next, '{"a":2}'));
      const runGone = outcome(db, 'DELETE FROM runs WHERE id = ?', 'run-1');
      const rowsGone = outcome(db, `DELETE FROM ${t.table} WHERE run_id = ?`, 'run-1');
      const left = db.prepare(`SELECT count(*) AS n FROM ${t.table}`).get()?.['n'];
      // (1) red when the insert guard refuses a new key, or the delete guard refuses with no run row
      //     (an unconditional guard would forbid purge); (2) prints each step and the rows left.
      expect({ nextKey, runGone, rowsGone, left }).toEqual({
        nextKey: 'landed',
        runGone: 'landed',
        rowsGone: 'landed',
        left: 0,
      });
    });
  }

  it('every key and payload column refuses NULL by itself, also with CHECKs off (DELTAS row 23)', () => {
    const E = 'INSERT INTO evidence (run_id, seq, entry, entry_sha256) VALUES (?, ?, ?, ?)';
    const B = 'INSERT INTO run_blobs (run_id, name, value) VALUES (?, ?, ?)';
    const run = JSON.stringify(doc());
    const cases: Record<string, [string, unknown[]]> = {
      'runs.id': [INSERT_RUN, [null, run, 'running', PHASE_STAMP, null]],
      'runs.record': [INSERT_RUN, ['run-1', null, 'running', PHASE_STAMP, null]],
      'evidence.run_id': [E, [null, 0, '{}', 'sha']],
      'evidence.seq': [E, ['run-1', null, '{}', 'sha']],
      'evidence.entry': [E, ['run-1', 0, null, 'sha']],
      'evidence.entry_sha256': [E, ['run-1', 0, '{}', null]],
      'run_blobs.run_id': [B, [null, 'f', '{}']],
      'run_blobs.name': [B, ['run-1', null, '{}']],
      'run_blobs.value': [B, ['run-1', 'f', null]],
    };
    const results: Record<string, string> = {};
    for (const [name, [sql, params]] of Object.entries(cases)) {
      const db = fresh();
      // The validity guards would refuse a NULL record or payload first: drop them here so each
      // column's own constraint is what is measured.
      for (const guard of [
        'runs_insert_valid',
        'evidence_insert_valid',
        'run_blobs_insert_valid',
      ]) {
        db.exec(`DROP TRIGGER ${guard}`);
      }
      pragma(db, 'ignore_check_constraints', 1);
      results[name] = outcome(db, sql, ...params);
    }
    // (1) red when a column loses NOT NULL: the row lands (on a key column, two such rows both land
    //     and slip past the repeated-key guard); (2) prints each case's outcome.
    expect(results).toEqual(
      Object.fromEntries(
        Object.keys(cases).map((column) => [column, `NOT NULL constraint failed: ${column}`]),
      ),
    );
  });
});

describe('#616 unit 6 — the write-once list', () => {
  it("is the design's set, and a changed stored member is refused", () => {
    const refused: Record<string, string> = {};
    for (const field of WRITE_ONCE_RUN_FIELDS) {
      const db = fresh();
      addRun(db, doc({ [field]: { $realm_blob: field } }));
      db.prepare('INSERT INTO run_blobs (run_id, name, value) VALUES (?, ?, ?)').run(
        'run-1',
        field,
        '{"s":1}',
      );
      refused[field] = outcome(
        db,
        'UPDATE run_blobs SET value = ? WHERE run_id = ? AND name = ?',
        '{"s":2}',
        'run-1',
        field,
      );
    }
    // (1) red when a member is removed from or added to the list without the design (the census of
    //     its writers), or when the blob guard lets a member change; (2) prints the list and, per
    //     member, the outcome of changing it.
    expect({ list: [...WRITE_ONCE_RUN_FIELDS], refused }).toEqual({
      list: ['workflow_context_snapshots'],
      refused: { workflow_context_snapshots: MSG.writeOnce },
    });
  });
});

describe('#616 unit 6 — GROUNDING for unit 7: tampering is visible only in the stored text', () => {
  it('after a foreign DROP TRIGGER the refused statement lands, and the stored text differs from the constant', () => {
    const db = fresh();
    addRun(db, doc());
    db.prepare('INSERT INTO evidence (run_id, seq, entry, entry_sha256) VALUES (?, ?, ?, ?)').run(
      'run-1',
      0,
      '{"a":1}',
      'sha-0',
    );
    db.exec('DROP TRIGGER evidence_no_update');
    const rewrite = outcome(
      db,
      'UPDATE evidence SET entry = ? WHERE run_id = ?',
      '{"a":2}',
      'run-1',
    );
    const texts = db
      .prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid')
      .all()
      .map((r) => r['sql']);
    // GROUNDING, not acceptance: it shows why unit 7 compares the stored text on every open. (1) red
    // when a guard no longer lives in the stored schema (the rewrite is refused without it), or when
    // a dropped trigger leaves the text unchanged; (2) prints the rewrite's outcome and the count.
    expect({
      rewrite,
      sameText: JSON.stringify(texts) === JSON.stringify(REALM_STORE_SCHEMA),
    }).toEqual({ rewrite: 'landed', sameText: false });
  });
});

// ---- The correction (review of unit 6, DELTAS row 24): what a foreign writer could still do ----

const INSERT_EVIDENCE =
  'INSERT INTO evidence (run_id, seq, entry, entry_sha256) VALUES (?, ?, ?, ?)';
const INSERT_BLOB = 'INSERT INTO run_blobs (run_id, name, value) VALUES (?, ?, ?)';

/** The connection settings each new attack runs under: SQLite's defaults, and the ones Realm opens with. */
const SETTINGS: Record<string, readonly string[]> = {
  default: [],
  realm: ['PRAGMA trusted_schema = OFF', 'PRAGMA foreign_keys = ON'],
};

/** `fresh()` under the given connection settings and recursive-trigger mode. */
function freshWith(
  settings: readonly string[],
  recursive: 0 | 1 = 0,
  metaRow = true,
): DatabaseLike {
  const db = openDatabase(':memory:');
  open.push(db);
  for (const statement of settings) db.exec(statement);
  for (const statement of REALM_STORE_SCHEMA) db.exec(statement);
  if (metaRow) db.prepare(META_ROW).run(REALM_STORE_PAGE_SIZE, CREATED, CREATED);
  pragma(db, 'recursive_triggers', recursive);
  return db;
}

/** Every combination the row-number attacks run under. */
const MODES = Object.entries(SETTINGS).flatMap(([name, settings]) =>
  ([0, 1] as const).map((recursive) => ({
    label: `${name}/recursive=${recursive}`,
    settings,
    recursive,
  })),
);

describe('#616 unit 6 correction — the hidden row number', () => {
  /** A database holding the victims at row number 1: live run-1, its evidence row and its field; run-2 at 2. */
  function withVictims(settings: readonly string[], recursive: 0 | 1): DatabaseLike {
    const db = freshWith(settings, recursive);
    addRun(db, doc());
    addRun(db, doc({ id: 'run-2' }));
    db.prepare(INSERT_EVIDENCE).run('run-1', 0, '{"a":1}', 'sha-0');
    db.prepare(INSERT_BLOB).run('run-1', 'workflow_context_snapshots', '{"s":1}');
    return db;
  }
  /** Every row of the three tables, with its row number. */
  const rows = (db: DatabaseLike) =>
    JSON.stringify([
      db.prepare('SELECT rowid, id FROM runs ORDER BY rowid').all(),
      db.prepare('SELECT rowid, run_id, seq, entry FROM evidence ORDER BY rowid').all(),
      db.prepare('SELECT rowid, run_id, name, value FROM run_blobs ORDER BY rowid').all(),
    ]);

  /** Runs `sql` against the victims in every mode: its outcome, and whether every row is as before. */
  function attack(sql: string, ...params: unknown[]) {
    const results: Record<string, { outcome: string; rowsUnchanged: boolean }> = {};
    for (const mode of MODES) {
      const db = withVictims(mode.settings, mode.recursive);
      const before = rows(db);
      const res = outcome(db, sql, ...params);
      results[mode.label] = { outcome: res, rowsUnchanged: rows(db) === before };
    }
    return results;
  }
  const refusedEverywhere = (message: string) =>
    Object.fromEntries(MODES.map((m) => [m.label, { outcome: message, rowsUnchanged: true }]));

  it("runs: INSERT OR REPLACE aimed at a live run's row number, by each of its three names, is refused and the run stays", () => {
    const results: Record<string, unknown> = {};
    for (const name of ['rowid', 'oid', '_rowid_']) {
      results[name] = attack(
        `INSERT OR REPLACE INTO runs (${name}, id, record, run_phase, phase_version, key_hash) VALUES (1, ?, ?, ?, ?, ?)`,
        'run-x',
        JSON.stringify(doc({ id: 'run-x' })),
        'running',
        PHASE_STAMP,
        null,
      );
    }
    // (1) red when the runs row-number guard is dropped: the REPLACE deletes run-1 with recursive
    //     triggers off (no trigger fires) and meets the delete guard's message with them on;
    //     (2) prints, per name and mode, the outcome and whether every row is as before.
    expect(results).toEqual({
      rowid: refusedEverywhere(MSG.exists),
      oid: refusedEverywhere(MSG.exists),
      _rowid_: refusedEverywhere(MSG.exists),
    });
  });

  it("runs: UPDATE OR REPLACE moving a run onto another run's row number, by each of its three names, is refused and both runs stay", () => {
    const results: Record<string, unknown> = {};
    for (const name of ['rowid', 'oid', '_rowid_']) {
      results[name] = attack(`UPDATE OR REPLACE runs SET ${name} = 1 WHERE id = ?`, 'run-2');
    }
    // (1) red when the row-number update guard is dropped, or scoped to `rowid` alone (the `oid` and
    //     `_rowid_` spellings then delete run-1); (2) prints, per name and mode, the outcome and
    //     whether every row is as before.
    expect(results).toEqual({
      rowid: refusedEverywhere(MSG.identity),
      oid: refusedEverywhere(MSG.identity),
      _rowid_: refusedEverywhere(MSG.identity),
    });
  });

  it("evidence: INSERT OR REPLACE aimed at an evidence row's row number is refused and the row stays", () => {
    const results = attack(
      'INSERT OR REPLACE INTO evidence (rowid, run_id, seq, entry, entry_sha256) VALUES (1, ?, ?, ?, ?)',
      'run-1',
      5,
      '{"f":1}',
      'sha-5',
    );
    // (1) red when the evidence row-number guard is dropped: with recursive triggers off the REPLACE
    //     deletes seq 0 and no trigger fires; (2) prints, per mode, the outcome and whether every row
    //     is as before.
    expect(results).toEqual(refusedEverywhere(MSG.evidence));
  });

  it("run_blobs: INSERT OR REPLACE aimed at a write-once field's row number is refused and the field stays", () => {
    const results = attack(
      'INSERT OR REPLACE INTO run_blobs (rowid, run_id, name, value) VALUES (1, ?, ?, ?)',
      'run-1',
      'other_field',
      '{"f":1}',
    );
    // (1) red when the run_blobs row-number guard is dropped: with recursive triggers off the REPLACE
    //     deletes the field and no trigger fires; (2) prints, per mode, the outcome and whether every
    //     row is as before.
    expect(results).toEqual(refusedEverywhere(MSG.writeOnce));
  });
});

/** A record's JSON text with a second copy of `key` at the end: SQLite reads the first, JSON.parse the last. */
function repeating(record: Record<string, unknown>, key: string, value: unknown): string {
  const text = JSON.stringify(record);
  return `${text.slice(0, -1)},${JSON.stringify(key)}:${JSON.stringify(value)}}`;
}

describe('#616 unit 6 correction — what Realm reads is what the guards judge', () => {
  /** Each key a guard reads, with the value a second copy would make Realm read instead. */
  const REPEATS: Array<[string, unknown]> = [
    ['id', 'run-x'],
    ['workflow_id', 'wf-x'],
    ['created_at', '2026-01-01T00:00:00.000Z'],
    ['version', 9],
    ['terminal_state', true],
  ];

  it('a run record that repeats a top-level key is refused on insert and on update, CHECKs on and off, in both connection settings', () => {
    const results: Record<string, string> = {};
    for (const [setting, settings] of Object.entries(SETTINGS)) {
      for (const checksOff of [0, 1] as const) {
        for (const [key, value] of REPEATS) {
          const label = `${key}/${setting}/checksOff=${checksOff}`;
          const ins = freshWith(settings);
          pragma(ins, 'ignore_check_constraints', checksOff);
          // The first copy is what a guard reads: the right id, the right version, a live run.
          results[`insert ${label}`] = outcome(
            ins,
            INSERT_RUN,
            'run-1',
            repeating(doc(), key, value),
            'running',
            PHASE_STAMP,
            null,
          );
          const upd = freshWith(settings);
          addRun(upd, doc());
          pragma(upd, 'ignore_check_constraints', checksOff);
          // The first copies move the version by one and keep the identity: every other guard passes.
          results[`update ${label}`] = outcome(
            upd,
            'UPDATE runs SET record = ? WHERE id = ?',
            repeating(doc({ version: 2 }), key, value),
            'run-1',
          );
        }
      }
    }
    // (1) red when the repeated-key clause is removed from the insert or the update validity guard:
    //     the record lands while Realm would read the second copy (another id, another version, a
    //     finished run); (2) prints each case's outcome.
    expect(results).toEqual(
      Object.fromEntries(Object.keys(results).map((k) => [k, MSG.invalidRun])),
    );
  });

  it('an update of the record to JSON5, and a record, evidence entry or field stored as a BLOB, are refused, CHECKs on and off, in both connection settings', () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    const results: Record<string, string> = {};
    for (const [setting, settings] of Object.entries(SETTINGS)) {
      for (const checksOff of [0, 1] as const) {
        const label = `${setting}/checksOff=${checksOff}`;
        const db = freshWith(settings);
        addRun(db, doc());
        pragma(db, 'ignore_check_constraints', checksOff);
        results[`JSON5 record update ${label}`] = outcome(
          db,
          'UPDATE runs SET record = ? WHERE id = ?',
          '{id:"run-1",workflow_id:"wf",version:2,created_at:"2026-11-05T10:00:00.000Z",terminal_state:false}',
          'run-1',
        );
        results[`BLOB record update ${label}`] = outcome(
          db,
          'UPDATE runs SET record = ? WHERE id = ?',
          bytes(JSON.stringify(doc({ version: 2 }))),
          'run-1',
        );
        results[`BLOB record insert ${label}`] = outcome(
          db,
          INSERT_RUN,
          'run-2',
          bytes(JSON.stringify(doc({ id: 'run-2' }))),
          'running',
          PHASE_STAMP,
          null,
        );
        results[`BLOB evidence entry ${label}`] = outcome(
          db,
          INSERT_EVIDENCE,
          'run-1',
          0,
          bytes('{"a":1}'),
          'sha-0',
        );
        results[`BLOB field value ${label}`] = outcome(
          db,
          INSERT_BLOB,
          'run-1',
          'workflow_context_snapshots',
          bytes('{"s":1}'),
        );
      }
    }
    // (1) red when the update validity guard's JSON clause is removed (the JSON5 update lands with
    //     CHECKs off), or a guard's text clause is removed (that BLOB lands, CHECKs on or off);
    //     (2) prints each case's outcome.
    expect(results).toEqual(
      Object.fromEntries(
        Object.keys(results).map((k) => [
          k,
          k.startsWith('BLOB evidence') || k.startsWith('BLOB field')
            ? MSG.invalidJson
            : MSG.invalidRun,
        ]),
      ),
    );
  });
});

describe("#616 unit 6 correction — Realm's own writes still land", () => {
  it('a plain and a multi-row insert, an insert at a free row number, a +1 update, a re-stamp, evidence at the next seq, a field, and deleting a finished run, in both connection settings', () => {
    const results: Record<string, Record<string, string>> = {};
    for (const [setting, settings] of Object.entries(SETTINGS)) {
      const db = freshWith(settings);
      const steps: Record<string, string> = {};
      steps['insert'] = outcome(
        db,
        INSERT_RUN,
        'run-1',
        JSON.stringify(doc()),
        'running',
        PHASE_STAMP,
        null,
      );
      steps['multi-row insert'] = outcome(
        db,
        `${INSERT_RUN}, (?, ?, ?, ?, ?)`,
        'run-2',
        JSON.stringify(doc({ id: 'run-2' })),
        'running',
        PHASE_STAMP,
        null,
        'run-3',
        JSON.stringify(doc({ id: 'run-3' })),
        'running',
        PHASE_STAMP,
        null,
      );
      steps['insert at a free row number'] = outcome(
        db,
        'INSERT INTO runs (rowid, id, record, run_phase, phase_version, key_hash) VALUES (500, ?, ?, ?, ?, ?)',
        'run-9',
        JSON.stringify(doc({ id: 'run-9' })),
        'running',
        PHASE_STAMP,
        null,
      );
      steps['+1 update'] = outcome(
        db,
        'UPDATE runs SET record = ? WHERE id = ?',
        JSON.stringify(doc({ version: 2 })),
        'run-1',
      );
      steps['re-stamp'] = outcome(
        db,
        'UPDATE runs SET run_phase = ?, phase_version = ? WHERE id = ?',
        'waiting',
        'fedcba9876543210',
        'run-1',
      );
      steps['evidence seq 0'] = outcome(db, INSERT_EVIDENCE, 'run-1', 0, '{"a":1}', 'sha-0');
      steps['evidence seq 1'] = outcome(db, INSERT_EVIDENCE, 'run-1', 1, '{"a":2}', 'sha-1');
      steps['field'] = outcome(db, INSERT_BLOB, 'run-1', 'workflow_context_snapshots', '{"s":1}');
      steps['finish run-2'] = outcome(
        db,
        'UPDATE runs SET record = ? WHERE id = ?',
        JSON.stringify(doc({ id: 'run-2', version: 2, terminal_state: true })),
        'run-2',
      );
      steps['delete run-2'] = outcome(db, 'DELETE FROM runs WHERE id = ?', 'run-2');
      results[setting] = steps;
    }
    const allLand = Object.fromEntries(
      Object.keys(results['default'] ?? {}).map((k) => [k, 'landed']),
    );
    // (1) red when a new guard refuses Realm's own write: the row-number guard written as "a number
    //     was given" (it is always set inside the trigger), the repeated-key or text clause catching a
    //     valid record, the row-number update guard firing on an update that keeps the number;
    //     (2) prints each step's outcome per connection setting.
    expect(results).toEqual({ default: allLand, realm: allLand });
  });
});

describe('#616 unit 6 correction — two runs side by side', () => {
  it("with two runs, each one's first evidence row and its field land beside the other's, and the finished run's row, then its evidence and field, delete while the other run is live", () => {
    const results: Record<string, unknown> = {};
    for (const [setting, settings] of Object.entries(SETTINGS)) {
      const db = freshWith(settings);
      addRun(db, doc({ terminal_state: true }));
      addRun(db, doc({ id: 'run-2' }));
      const steps = {
        'run-1 evidence seq 0': outcome(db, INSERT_EVIDENCE, 'run-1', 0, '{"a":1}', 'sha-0'),
        'run-2 evidence seq 0': outcome(db, INSERT_EVIDENCE, 'run-2', 0, '{"b":1}', 'sha-0'),
        'run-1 field': outcome(db, INSERT_BLOB, 'run-1', 'workflow_context_snapshots', '{"s":1}'),
        'run-2 field': outcome(db, INSERT_BLOB, 'run-2', 'workflow_context_snapshots', '{"s":2}'),
        'delete run-1': outcome(db, 'DELETE FROM runs WHERE id = ?', 'run-1'),
        'delete run-1 evidence': outcome(db, 'DELETE FROM evidence WHERE run_id = ?', 'run-1'),
        'delete run-1 field': outcome(db, 'DELETE FROM run_blobs WHERE run_id = ?', 'run-1'),
      };
      const left = {
        evidence: db.prepare('SELECT run_id, seq FROM evidence').all(),
        fields: db.prepare('SELECT run_id, name FROM run_blobs').all(),
      };
      results[setting] = { steps, left };
    }
    const want = {
      steps: {
        'run-1 evidence seq 0': 'landed',
        'run-2 evidence seq 0': 'landed',
        'run-1 field': 'landed',
        'run-2 field': 'landed',
        'delete run-1': 'landed',
        'delete run-1 evidence': 'landed',
        'delete run-1 field': 'landed',
      },
      left: {
        evidence: [{ run_id: 'run-2', seq: 0 }],
        fields: [{ run_id: 'run-2', name: 'workflow_context_snapshots' }],
      },
    };
    // (1) red when a guard refuses too much across runs: the evidence repeated-key guard keyed on
    //     `seq` alone or the field's on `name` alone (the second run's first row is refused), or a
    //     delete guard that looks for any run instead of this row's run (the finished run's rows
    //     cannot be deleted while the other run lives); (2) prints each step and the rows left.
    expect(results).toEqual({ default: want, realm: want });
  });
});

describe('#616 unit 6 correction — no row is stored below row number 1 (DELTAS row 24b)', () => {
  /** Per table: an insert with an explicit row number, and Realm's plain insert. */
  const TABLES = [
    {
      table: 'runs',
      at: (n: number) =>
        [
          'INSERT INTO runs (rowid, id, record, run_phase, phase_version, key_hash) VALUES (?, ?, ?, ?, ?, ?)',
          [n, 'run-x', JSON.stringify(doc({ id: 'run-x' })), 'running', PHASE_STAMP, null],
        ] as const,
      plain: [INSERT_RUN, ['run-1', JSON.stringify(doc()), 'running', PHASE_STAMP, null]] as const,
    },
    {
      table: 'evidence',
      at: (n: number) =>
        [
          'INSERT INTO evidence (rowid, run_id, seq, entry, entry_sha256) VALUES (?, ?, ?, ?, ?)',
          [n, 'run-x', 0, '{"x":1}', 'sha-x'],
        ] as const,
      plain: [INSERT_EVIDENCE, ['run-1', 0, '{"a":1}', 'sha-0']] as const,
    },
    {
      table: 'run_blobs',
      at: (n: number) =>
        [
          'INSERT INTO run_blobs (rowid, run_id, name, value) VALUES (?, ?, ?, ?)',
          [n, 'run-x', 'workflow_context_snapshots', '{"x":1}'],
        ] as const,
      plain: [INSERT_BLOB, ['run-1', 'workflow_context_snapshots', '{"a":1}']] as const,
    },
  ];

  for (const t of TABLES) {
    it(`${t.table}: an explicit row number of -1 or 0 is refused, also by INSERT OR REPLACE, and a plain insert lands after it`, () => {
      const results: Record<string, unknown> = {};
      for (const mode of MODES) {
        for (const n of [-1, 0]) {
          for (const form of ['INSERT INTO', 'INSERT OR REPLACE INTO']) {
            const db = freshWith(mode.settings, mode.recursive);
            const [sql, params] = t.at(n);
            const planted = outcome(db, sql.replace('INSERT INTO', form), ...params);
            const [plainSql, plainParams] = t.plain;
            const plain = outcome(db, plainSql, ...plainParams);
            results[`${mode.label}/${form}/${n}`] = { planted, plain };
          }
        }
      }
      // (1) red when the table's row-number-below-1 guard is dropped: the row is stored at -1 (or 0),
      //     and after the -1 row Realm's plain insert is refused by the row-number guard;
      //     (2) prints, per mode, form and number, the attempt's outcome and the plain insert's.
      expect(results).toEqual(
        Object.fromEntries(
          Object.keys(results).map((k) => [k, { planted: MSG.rowNumber, plain: 'landed' }]),
        ),
      );
    });
  }
});

// ---- Unit 6b: the tombstones a deleted run leaves, the store's meta row, the write clock ----

/** The store's one stamp shape (`toISOString()`; never `datetime('now')`, which has a space and no Z). */
const STAMP_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** How the store sets the deleting write's instant: an upsert (a plain UPDATE on the empty table sets nothing). */
const SET_CLOCK =
  'INSERT INTO write_clock (one, at) VALUES (1, ?) ON CONFLICT(one) DO UPDATE SET at = excluded.at';
const CLEAR_CLOCK = 'UPDATE write_clock SET at = NULL';
const DELETE_RUN = 'DELETE FROM runs WHERE id = ?';

/** A finished run with a key and a seal, so every detail column of its tombstone has a value. */
function addFinished(db: DatabaseLike, id: string) {
  db.prepare(INSERT_RUN).run(
    id,
    JSON.stringify(
      doc({
        id,
        terminal_state: true,
        idempotency_key: `key-${id}`,
        sealed_by: { arm: 'completed' },
      }),
    ),
    'completed',
    PHASE_STAMP,
    `hash-${id}`,
  );
}
/** The tombstones and the meta row's counter. */
function tombstones(db: DatabaseLike) {
  return {
    ids: db.prepare('SELECT id, purged_at FROM purged_ids ORDER BY id').all(),
    detail: db.prepare('SELECT * FROM purged_runs ORDER BY seq').all(),
    tombSeq: db.prepare('SELECT tomb_seq FROM store_meta').get()?.['tomb_seq'],
  };
}
/** Every row of the tombstone and meta tables, to show a refused statement changed nothing. */
const tombRows = (db: DatabaseLike) =>
  JSON.stringify([
    db.prepare('SELECT * FROM purged_ids ORDER BY id').all(),
    db.prepare('SELECT * FROM purged_runs ORDER BY seq').all(),
    db.prepare('SELECT * FROM store_meta').all(),
  ]);

describe('#616 unit 6b — a deleted run leaves its id and its detail', () => {
  it('a finished run deleted by plain SQL leaves one id row and one detail row under the next seq, and its id cannot be created again, also after its detail is compacted', () => {
    const results: Record<string, unknown> = {};
    for (const [setting, settings] of Object.entries(SETTINGS)) {
      const db = freshWith(settings);
      addFinished(db, 'run-1');
      const deleted = outcome(db, DELETE_RUN, 'run-1');
      const { ids, detail, tombSeq } = tombstones(db);
      const stamp = String(ids[0]?.['purged_at']);
      const again = () =>
        outcome(db, INSERT_RUN, 'run-1', JSON.stringify(doc()), 'running', PHASE_STAMP, null);
      const createdAgain = again();
      // Compaction's order: move the horizon over the row on both counts, then delete it.
      const raised = outcome(
        db,
        'UPDATE store_meta SET tombstones_through_seq = 1, tombstones_since = ?',
        stamp,
      );
      const compacted = outcome(db, 'DELETE FROM purged_runs WHERE seq = 1');
      const createdAfterCompaction = again();
      results[setting] = {
        deleted,
        ids: ids.map((r) => r['id']),
        detail: detail.map((r) => ({ ...r, purged_at: r['purged_at'] === stamp })),
        tombSeq,
        createdAgain,
        raised,
        compacted,
        createdAfterCompaction,
        idsLeft: db.prepare('SELECT count(*) AS n FROM purged_ids').get()?.['n'],
      };
    }
    const want = {
      deleted: 'landed',
      ids: ['run-1'],
      detail: [
        {
          seq: 1,
          id: 'run-1',
          purged_at: true,
          workflow_id: 'wf',
          key_hash: 'hash-run-1',
          sealed_by_arm: 'completed',
          run_phase: 'completed',
          phase_version: PHASE_STAMP,
        },
      ],
      tombSeq: 1,
      createdAgain: MSG.purged,
      raised: 'landed',
      compacted: 'landed',
      createdAfterCompaction: MSG.purged,
      idsLeft: 1,
    };
    // (1) red when the tombstone trigger is dropped (no rows, the id can be created again) or writes a
    //     wrong detail column or seq, or when the purged-id insert guard is dropped (the id comes back,
    //     before or after compaction); (2) prints, per connection setting, every step and the rows.
    expect(results).toEqual({ default: want, realm: want });
  });

  it("purged_at is the deleting write's instant when the store set it, and SQLite's own clock, in the store's one shape, only when it did not", () => {
    const AWAY = '2031-03-04T05:06:07.089Z';
    /** Deletes run-1 the way `act` does, then judges the stamp its two tombstone rows carry. */
    function stampWhen(act: (db: DatabaseLike) => void): string {
      const db = fresh();
      addFinished(db, 'run-1');
      act(db);
      const { ids, detail } = tombstones(db);
      const a = String(ids[0]?.['purged_at']);
      const b = String(detail[0]?.['purged_at']);
      if (a !== b) return `two stamps: ${a} / ${b}`;
      if (a === AWAY) return 'the set instant';
      const now = STAMP_SHAPE.test(a) && Math.abs(Date.parse(a) - Date.now()) < 60_000;
      return now ? "SQLite's clock, now, in the one shape" : `another stamp: ${a}`;
    }
    const remove = (db: DatabaseLike) => db.prepare(DELETE_RUN).run('run-1');
    const results = {
      // The store's own delete: set by the upsert inside the transaction, cleared before COMMIT.
      setInTheTransaction: stampWhen((db) => {
        db.exec('BEGIN');
        db.prepare(SET_CLOCK).run(AWAY);
        remove(db);
        db.exec(CLEAR_CLOCK);
        db.exec('COMMIT');
      }),
      afterTheClear: stampWhen((db) => {
        db.prepare(SET_CLOCK).run(AWAY);
        db.exec(CLEAR_CLOCK);
        remove(db);
      }),
      afterARollback: stampWhen((db) => {
        db.exec('BEGIN');
        db.prepare(SET_CLOCK).run(AWAY);
        db.exec('ROLLBACK');
        remove(db);
      }),
      plainUpdateOnTheEmptyTable: stampWhen((db) => {
        db.prepare('UPDATE write_clock SET at = ? WHERE one = 1').run(AWAY);
        remove(db);
      }),
    };
    // (1) red when the trigger reads SQLite's clock before the write clock (the set instant is lost),
    //     or stamps with datetime('now') (a space and no Z: not the shape), or the two rows get
    //     different stamps; (2) prints, per case, which clock stamped the tombstone.
    expect(results).toEqual({
      setInTheTransaction: 'the set instant',
      afterTheClear: "SQLite's clock, now, in the one shape",
      afterARollback: "SQLite's clock, now, in the one shape",
      plainUpdateOnTheEmptyTable: "SQLite's clock, now, in the one shape",
    });
  });

  it('tombstones are ordered by seq, not by the clock: with the clock stepped back between two deletions, the later has the later seq and the earlier stamp', () => {
    const db = fresh();
    addFinished(db, 'run-1');
    addFinished(db, 'run-2');
    db.prepare(SET_CLOCK).run('2031-01-02T00:00:00.000Z');
    db.prepare(DELETE_RUN).run('run-1');
    db.prepare(SET_CLOCK).run('2031-01-01T00:00:00.000Z');
    db.prepare(DELETE_RUN).run('run-2');
    db.exec(CLEAR_CLOCK);
    // Compaction's selection: the oldest tombstones first, by seq.
    const order = db
      .prepare('SELECT seq, id, purged_at FROM purged_runs WHERE seq <= ? ORDER BY seq')
      .all(2);
    // (1) red when the order is taken from the clock (`ORDER BY purged_at` puts the later deletion
    //     first), or the trigger numbers tombstones by anything but the counter; (2) prints the order.
    expect(order).toEqual([
      { seq: 1, id: 'run-1', purged_at: '2031-01-02T00:00:00.000Z' },
      { seq: 2, id: 'run-2', purged_at: '2031-01-01T00:00:00.000Z' },
    ]);
  });
});

describe('#616 unit 6b — the tombstones cannot be rewritten', () => {
  /** run-1 purged (seq 1), run-2 live; the horizon at creation. */
  function purgedAndLive(settings: readonly string[], recursive: 0 | 1 = 0): DatabaseLike {
    const db = freshWith(settings, recursive);
    addFinished(db, 'run-1');
    db.prepare(DELETE_RUN).run('run-1');
    addRun(db, doc({ id: 'run-2' }));
    return db;
  }
  /** Runs each statement on its own copy, after `setup`: its outcome and whether the rows stayed. */
  function each(
    statements: Record<
      string,
      [string, unknown[]] | [string, unknown[], (db: DatabaseLike) => void]
    >,
    recursive: 0 | 1 = 0,
  ) {
    const results: Record<string, { outcome: string; rowsUnchanged: boolean }> = {};
    for (const [setting, settings] of Object.entries(SETTINGS)) {
      for (const [name, [sql, params, setup]] of Object.entries(statements)) {
        const db = purgedAndLive(settings, recursive);
        setup?.(db);
        const before = tombRows(db);
        const res = outcome(db, sql, ...params);
        results[`${name}/${setting}`] = { outcome: res, rowsUnchanged: tombRows(db) === before };
      }
    }
    return results;
  }
  const refused = (results: Record<string, unknown>, byName: Record<string, string>) =>
    Object.fromEntries(
      Object.keys(results).map((k) => [
        k,
        { outcome: byName[k.split('/')[0] ?? ''], rowsUnchanged: true },
      ]),
    );
  const T = '2026-11-05T11:00:00.000Z';

  it("purged_ids: an update, a delete, a repeated id, INSERT OR REPLACE and a live run's id are each refused", () => {
    const results = each({
      update: ['UPDATE purged_ids SET purged_at = ? WHERE id = ?', [T, 'run-1']],
      delete: ['DELETE FROM purged_ids WHERE id = ?', ['run-1']],
      repeatedId: ['INSERT INTO purged_ids (id, purged_at) VALUES (?, ?)', ['run-1', T]],
      insertOrReplace: [
        'INSERT OR REPLACE INTO purged_ids (id, purged_at) VALUES (?, ?)',
        ['run-1', T],
      ],
      liveRun: ['INSERT INTO purged_ids (id, purged_at) VALUES (?, ?)', ['run-2', T]],
    });
    // (1) red when one of purged_ids' guards is dropped: the update or delete rewrites the record of a
    //     purged id, the repeat meets the key's UNIQUE message or the REPLACE re-stamps it, a live run is
    //     recorded as purged (its later purge would be refused); (2) prints each outcome per setting.
    expect(results).toEqual(
      refused(results, {
        update: MSG.tombstone,
        delete: MSG.tombstone,
        repeatedId: MSG.tombstone,
        insertOrReplace: MSG.tombstone,
        liveRun: MSG.liveAsPurged,
      }),
    );
  });

  it('purged_runs: an update, a row off the counter, a row whose id is not purged or is live, a repeated seq or id, and a delete above the horizon on either count are each refused', () => {
    const ghost = (db: DatabaseLike) =>
      db.prepare('INSERT INTO purged_ids (id, purged_at) VALUES (?, ?)').run('ghost', T);
    const nextSeq = (db: DatabaseLike) => db.exec('UPDATE store_meta SET tomb_seq = tomb_seq + 1');
    const ROW =
      'INSERT INTO purged_runs (seq, id, purged_at, run_phase, phase_version) VALUES (?, ?, ?, ?, ?)';
    const results = each({
      update: ['UPDATE purged_runs SET purged_at = ? WHERE seq = 1', [T]],
      // Each insert below breaks ONE condition of the insert guard; the others hold.
      offTheCounter: [ROW, [5, 'ghost', T, 'p', 'v'], ghost],
      idNotPurged: [ROW, [2, 'nobody', T, 'p', 'v'], nextSeq],
      // Unreachable alone: an id cannot be both live and purged while the other guards stand, so
      // this is refused by the "not purged" condition as well.
      idLive: [ROW, [2, 'run-2', T, 'p', 'v'], nextSeq],
      seqTaken: [ROW, [1, 'ghost', T, 'p', 'v'], ghost],
      idTaken: [ROW, [2, 'run-1', T, 'p', 'v'], nextSeq],
      deleteAboveTheHorizon: ['DELETE FROM purged_runs WHERE seq = 1', []],
      // The horizon passes the row by seq, not by time: still kept.
      deleteAboveTheHorizonInTime: [
        'DELETE FROM purged_runs WHERE seq = 1',
        [],
        (db) => db.exec('UPDATE store_meta SET tombstones_through_seq = 1'),
      ],
    });
    // (1) red when the update guard, a condition of the insert guard, or the delete guard (or its
    //     time half) is dropped: the forged row or the delete lands, or meets SQLite's UNIQUE message;
    //     (2) prints each outcome per setting.
    expect(results).toEqual(
      refused(
        results,
        Object.fromEntries(
          [
            'update',
            'offTheCounter',
            'idNotPurged',
            'idLive',
            'seqTaken',
            'idTaken',
            'deleteAboveTheHorizon',
            'deleteAboveTheHorizonInTime',
          ].map((n) => [n, MSG.tombstone]),
        ),
      ),
    );
  });

  it('purged_runs: INSERT OR REPLACE onto a tombstone below the horizon is refused with recursive triggers on, and a delete at or below the horizon on both counts lands', () => {
    /** Moves the horizon over seq 1 on both counts. */
    const pastRow1 = (db: DatabaseLike) => {
      const at = db.prepare('SELECT purged_at FROM purged_runs WHERE seq = 1').get()?.['purged_at'];
      db.prepare('UPDATE store_meta SET tombstones_through_seq = 1, tombstones_since = ?').run(at);
    };
    // Below the horizon the delete guard would let REPLACE's delete through: only the insert guard
    // stands between the REPLACE and the tombstone.
    const replaced = each(
      {
        insertOrReplace: [
          'INSERT OR REPLACE INTO purged_runs (seq, id, purged_at, run_phase, phase_version) VALUES (1, ?, ?, ?, ?)',
          ['ghost', T, 'p', 'v'],
          (db) => {
            db.prepare('INSERT INTO purged_ids (id, purged_at) VALUES (?, ?)').run('ghost', T);
            pastRow1(db);
          },
        ],
      },
      1,
    );
    const compacted: Record<string, string> = {};
    for (const [setting, settings] of Object.entries(SETTINGS)) {
      const db = purgedAndLive(settings);
      pastRow1(db);
      compacted[setting] = outcome(db, 'DELETE FROM purged_runs WHERE seq = 1');
    }
    // (1) red when the insert guard is dropped (the REPLACE swaps the tombstone for a forged one), or
    //     the delete guard refuses even below the horizon (compaction impossible); (2) prints both.
    expect({ replaced, compacted }).toEqual({
      replaced: refused(replaced, { insertOrReplace: MSG.tombstone }),
      compacted: { default: 'landed', realm: 'landed' },
    });
  });

  it("purged_runs: a tombstone written under a clock stepped back before the horizon's time is kept by its seq, and compaction's selection by seq removes only what the horizon passed (DELTAS row 26)", () => {
    const results: Record<string, unknown> = {};
    for (const [setting, settings] of Object.entries(SETTINGS)) {
      const db = freshWith(settings);
      addFinished(db, 'run-1');
      addFinished(db, 'run-2');
      db.prepare(SET_CLOCK).run('2031-01-02T00:00:00.000Z');
      db.prepare(DELETE_RUN).run('run-1');
      db.exec(CLEAR_CLOCK);
      // Compaction's order: the horizon passes run-1's tombstone on both counts.
      db.exec(
        "UPDATE store_meta SET tombstones_through_seq = 1, tombstones_since = '2031-01-02T00:00:00.000Z'",
      );
      // The clock steps back: run-2 is deleted later (seq 2) with a stamp before the horizon's time.
      db.prepare(SET_CLOCK).run('2031-01-01T00:00:00.000Z');
      db.prepare(DELETE_RUN).run('run-2');
      db.exec(CLEAR_CLOCK);
      const before = tombRows(db);
      // A delete chosen by the clock: both tombstones are at or before the horizon's time, so only
      // the guard's seq half stands between run-2's tombstone (seq 2, above the horizon) and the delete.
      const byTime = outcome(
        db,
        'DELETE FROM purged_runs WHERE purged_at <= (SELECT tombstones_since FROM store_meta)',
      );
      const rowsUnchanged = tombRows(db) === before;
      const bySeq = outcome(
        db,
        'DELETE FROM purged_runs WHERE seq <= (SELECT tombstones_through_seq FROM store_meta)',
      );
      const left = db.prepare('SELECT seq, id FROM purged_runs ORDER BY seq').all();
      results[setting] = { byTime, rowsUnchanged, bySeq, left };
    }
    const want = {
      byTime: MSG.tombstone,
      rowsUnchanged: true,
      bySeq: 'landed',
      left: [{ seq: 2, id: 'run-2' }],
    };
    // (1) red when the delete guard's seq half is removed: the delete by time lands and both
    //     tombstones are gone, run-2's above the horizon; also red when the guard refuses below the
    //     horizon (compaction's delete by seq refused); (2) prints, per connection setting, both
    //     outcomes, whether the rows stayed, and the tombstones left.
    expect(results).toEqual({ default: want, realm: want });
  });
});

describe("#616 unit 6b — the store's meta row", () => {
  /** A meta row moved forward from creation: commit 5, counter 3, horizon 2 at noon. */
  const moved = (settings: readonly string[]) => {
    const db = freshWith(settings);
    db.exec(
      "UPDATE store_meta SET commit_epoch = 5, tomb_seq = 3, tombstones_through_seq = 2, tombstones_since = '2026-11-05T12:00:00.000Z'",
    );
    return db;
  };
  const metaRow = (db: DatabaseLike) =>
    JSON.stringify(db.prepare('SELECT * FROM store_meta').all());

  /** Each statement on its own copy of the moved row, CHECKs on and off: outcome, row unchanged. */
  function each(statements: Record<string, string>) {
    const results: Record<string, { outcome: string; rowUnchanged: boolean }> = {};
    for (const [setting, settings] of Object.entries(SETTINGS)) {
      for (const checksOff of [0, 1] as const) {
        for (const [name, sql] of Object.entries(statements)) {
          const db = moved(settings);
          pragma(db, 'ignore_check_constraints', checksOff);
          const before = metaRow(db);
          const res = outcome(db, sql);
          results[`${name}/${setting}/checksOff=${checksOff}`] = {
            outcome: res,
            rowUnchanged: metaRow(db) === before,
          };
        }
      }
    }
    return results;
  }
  const all = (results: Record<string, unknown>, message: string) =>
    Object.fromEntries(
      Object.keys(results).map((k) => [k, { outcome: message, rowUnchanged: true }]),
    );
  const second = `(1, 16384, 0, '${CREATED}', 0, 0, '${CREATED}')`;

  it('a second row, INSERT OR REPLACE, a delete, and a change of the singleton key, the page size or the creation time are each refused', () => {
    const results = each({
      secondInsert: `INSERT INTO store_meta VALUES ${second}`,
      insertOrReplace: `INSERT OR REPLACE INTO store_meta VALUES ${second}`,
      delete: 'DELETE FROM store_meta',
      key: 'UPDATE store_meta SET one = 2',
      keyByRowNumber: 'UPDATE store_meta SET _rowid_ = 2',
      pageSize: 'UPDATE store_meta SET page_size = 4096',
      createdAt: "UPDATE store_meta SET created_at = '2026-11-05T09:30:00.000Z'",
      createdAtNull: 'UPDATE store_meta SET created_at = NULL',
    });
    // (1) red when the one-row, no-delete or immutable guard is dropped, or an immutable column leaves
    //     its list; (2) prints each outcome per setting and CHECK mode, and whether the row stayed.
    expect(results).toEqual(all(results, MSG.metaReplaced));
  });

  it('each counter and the horizon moved backwards, set to NULL, or the horizon past the counter, are each refused, also with CHECKs off', () => {
    const results = each({
      commitEpochBack: 'UPDATE store_meta SET commit_epoch = 4',
      tombSeqBack: 'UPDATE store_meta SET tomb_seq = 2',
      throughSeqBack: 'UPDATE store_meta SET tombstones_through_seq = 1',
      sinceBack: "UPDATE store_meta SET tombstones_since = '2026-11-05T11:00:00.000Z'",
      commitEpochNull: 'UPDATE store_meta SET commit_epoch = NULL',
      tombSeqNull: 'UPDATE store_meta SET tomb_seq = NULL',
      throughSeqNull: 'UPDATE store_meta SET tombstones_through_seq = NULL',
      sinceNull: 'UPDATE store_meta SET tombstones_since = NULL',
      throughPastCounter: 'UPDATE store_meta SET tombstones_through_seq = 4',
    });
    // (1) red when one clause of the forward guard is removed: that decrease or NULL lands (a NULL
    //     passes "never lower", NULL < old being NULL), or the horizon passes the counter;
    //     (2) prints each outcome per setting and CHECK mode, and whether the row stayed.
    expect(results).toEqual(all(results, MSG.horizon));
  });

  it('a value of the wrong type in a counter or a stamp is refused on update, also with CHECKs off (DELTAS row 25)', () => {
    const results = each({
      commitEpochText: "UPDATE store_meta SET commit_epoch = 'x'",
      commitEpochFraction: 'UPDATE store_meta SET commit_epoch = 5.5',
      tombSeqText: "UPDATE store_meta SET tomb_seq = 'x'",
      throughSeqText: "UPDATE store_meta SET tombstones_through_seq = 'x'",
      sinceNumber: 'UPDATE store_meta SET tombstones_since = 99',
      sinceOtherShape: "UPDATE store_meta SET tombstones_since = '2026-11-05 13:00:00'",
    });
    // (1) red when a column's type clause is removed from the update type guard: the value lands and
    //     every later write that moves that column is refused as backwards (text sorts above numbers;
    //     '99' above any stamp); (2) prints each outcome per setting and CHECK mode.
    expect(results).toEqual(all(results, MSG.metaTypes));
  });

  it('the first row is refused when a counter is not a whole number or a stamp is not in the one shape, also with CHECKs off', () => {
    const META =
      'INSERT INTO store_meta (one, page_size, commit_epoch, created_at, tomb_seq, tombstones_through_seq, tombstones_since) VALUES (1, ?, ?, ?, ?, ?, ?)';
    const good = [16384, 0, CREATED, 0, 0, CREATED] as const;
    const bad: Record<string, [number, unknown]> = {
      pageSizeText: [0, 'x'],
      commitEpochText: [1, 'x'],
      createdAtOtherShape: [2, '2026-11-05 09:00:00'],
      tombSeqFraction: [3, 0.5],
      throughSeqText: [4, 'x'],
      sinceNumber: [5, 7],
    };
    const results: Record<string, string> = {};
    for (const [setting, settings] of Object.entries(SETTINGS)) {
      for (const checksOff of [0, 1] as const) {
        for (const [name, [at, value]] of Object.entries(bad)) {
          const db = freshWith(settings, 0, false);
          pragma(db, 'ignore_check_constraints', checksOff);
          const row: unknown[] = [...good];
          row[at] = value;
          results[`${name}/${setting}/checksOff=${checksOff}`] = outcome(db, META, ...row);
        }
        const db = freshWith(settings, 0, false);
        results[`good/${setting}/checksOff=${checksOff}`] = outcome(db, META, ...good);
      }
    }
    // (1) red when a column's clause is removed from the first-row type guard (that row is stored, and
    //     its first forward move is refused), or the guard refuses a good row; (2) prints each case.
    expect(results).toEqual(
      Object.fromEntries(
        Object.keys(results).map((k) => [k, k.startsWith('good/') ? 'landed' : MSG.metaTypes]),
      ),
    );
  });

  it('moving forward lands: a +1 of the commit counter, the tombstone counter, a later horizon stamp and seq; and a purged id stays refused after the horizon passes it', () => {
    const results: Record<string, unknown> = {};
    for (const [setting, settings] of Object.entries(SETTINGS)) {
      const db = moved(settings);
      addFinished(db, 'run-1');
      const steps = {
        commitEpoch: outcome(db, 'UPDATE store_meta SET commit_epoch = commit_epoch + 1'),
        tombSeq: outcome(db, 'UPDATE store_meta SET tomb_seq = tomb_seq + 1'),
        horizon: outcome(
          db,
          "UPDATE store_meta SET tombstones_through_seq = 3, tombstones_since = '2026-11-05T13:00:00.000Z'",
        ),
        deleteRun: outcome(db, DELETE_RUN, 'run-1'),
        horizonPastTheRun: outcome(
          db,
          "UPDATE store_meta SET tombstones_through_seq = 5, tombstones_since = '2999-01-01T00:00:00.000Z'",
        ),
        createdAgain: outcome(
          db,
          INSERT_RUN,
          'run-1',
          JSON.stringify(doc()),
          'running',
          PHASE_STAMP,
          null,
        ),
      };
      results[setting] = steps;
    }
    const want = {
      commitEpoch: 'landed',
      tombSeq: 'landed',
      horizon: 'landed',
      deleteRun: 'landed',
      horizonPastTheRun: 'landed',
      createdAgain: MSG.purged,
    };
    // (1) red when a guard refuses a forward move (the commit counter's +1 is every write's), or the
    //     purged id is forgotten once the horizon passes it; (2) prints each step per setting.
    expect(results).toEqual({ default: want, realm: want });
  });

  it("a whole number above 9007199254740991 is refused on update and in the first row, at that number it lands, and Realm's +1 from just below it lands, also with CHECKs off (DELTAS row 26)", () => {
    // Literals in the SQL text: the largest 64-bit whole number has no exact JavaScript number.
    const CAP = '9007199254740991';
    const levels = { atTheCap: CAP, overTheCap: '9007199254740992', max64: '9223372036854775807' };
    const want = (level: string) => (level === 'atTheCap' ? 'landed' : MSG.metaTypes);
    // On update: the two counters that may move up (the horizon counter is held below the counter by
    // the forward guard).
    const updates: Record<string, string> = {};
    for (const column of ['commit_epoch', 'tomb_seq']) {
      for (const [level, n] of Object.entries(levels)) {
        updates[`${column}:${level}`] = `UPDATE store_meta SET ${column} = ${n}`;
      }
    }
    // The row read as SQL text, so a value past 2^53 that lands prints instead of throwing RangeError.
    const rowText = (db: DatabaseLike) =>
      String(
        db
          .prepare(
            'SELECT json_array(one, page_size, commit_epoch, created_at, tomb_seq, tombstones_through_seq, tombstones_since) AS r FROM store_meta',
          )
          .get()?.['r'],
      );
    const onUpdate: Record<string, { outcome: string; rowUnchanged: boolean }> = {};
    for (const [setting, settings] of Object.entries(SETTINGS)) {
      for (const checksOff of [0, 1] as const) {
        for (const [name, sql] of Object.entries(updates)) {
          const db = moved(settings);
          pragma(db, 'ignore_check_constraints', checksOff);
          const before = rowText(db);
          const res = outcome(db, sql);
          onUpdate[`${name}/${setting}/checksOff=${checksOff}`] = {
            outcome: res,
            rowUnchanged: rowText(db) === before,
          };
        }
      }
    }
    // The first row: the page size and the three counters, each alone at a level, the rest good.
    const firstRow: Record<string, string> = {};
    const plusOne: Record<string, unknown> = {};
    for (const [setting, settings] of Object.entries(SETTINGS)) {
      for (const checksOff of [0, 1] as const) {
        const mode = `${setting}/checksOff=${checksOff}`;
        for (const column of ['page_size', 'commit_epoch', 'tomb_seq', 'tombstones_through_seq']) {
          for (const [level, n] of Object.entries(levels)) {
            const value = (c: string, good: string) => (c === column ? n : good);
            const db = freshWith(settings, 0, false);
            pragma(db, 'ignore_check_constraints', checksOff);
            firstRow[`${column}:${level}/${mode}`] = outcome(
              db,
              `INSERT INTO store_meta (one, page_size, commit_epoch, created_at, tomb_seq, tombstones_through_seq, tombstones_since) VALUES (1, ${value('page_size', '16384')}, ${value('commit_epoch', '0')}, '${CREATED}', ${value('tomb_seq', '0')}, ${value('tombstones_through_seq', '0')}, '${CREATED}')`,
            );
          }
        }
        // Realm's own +1 from just below: every write's commit bump, and a purge's tombstone bump.
        const db = moved(settings);
        pragma(db, 'ignore_check_constraints', checksOff);
        addFinished(db, 'run-1');
        db.exec(
          'UPDATE store_meta SET commit_epoch = 9007199254740990, tomb_seq = 9007199254740990',
        );
        plusOne[mode] = {
          commitEpoch: outcome(db, 'UPDATE store_meta SET commit_epoch = commit_epoch + 1'),
          deleteRun: outcome(db, DELETE_RUN, 'run-1'),
          row: db.prepare('SELECT commit_epoch, tomb_seq FROM store_meta').get(),
          seq: db.prepare('SELECT seq FROM purged_runs WHERE id = ?').get('run-1')?.['seq'],
        };
      }
    }
    // (1) red when one column's cap clause is removed from the update or the first-row guard (that
    //     column's value past the cap lands: Realm's next +1 is refused, or from 2^53 the row cannot
    //     be read as a number), or when the cap refuses the cap itself or Realm's +1 up to it;
    //     (2) prints each case per setting and CHECK mode, whether the row stayed, and the counters.
    expect({ onUpdate, firstRow, plusOne }).toEqual({
      onUpdate: Object.fromEntries(
        Object.keys(onUpdate).map((k) => {
          const level = k.split('/')[0]?.split(':')[1] ?? '';
          return [k, { outcome: want(level), rowUnchanged: level !== 'atTheCap' }];
        }),
      ),
      firstRow: Object.fromEntries(
        Object.keys(firstRow).map((k) => [k, want(k.split('/')[0]?.split(':')[1] ?? '')]),
      ),
      plusOne: Object.fromEntries(
        Object.keys(plusOne).map((k) => [
          k,
          {
            commitEpoch: 'landed',
            deleteRun: 'landed',
            row: { commit_epoch: 9007199254740991, tomb_seq: 9007199254740991 },
            seq: 9007199254740991,
          },
        ]),
      ),
    });
  });
});

describe('#616 unit 6b — the hidden row number on the new tables (SEAMS, DELTAS row 24)', () => {
  it("a REPLACE or an update aimed at a tombstone's or the meta row's row number is refused, and purged_ids has none", () => {
    const results: Record<string, unknown> = {};
    for (const mode of MODES) {
      const attacks: Record<string, string> = {
        purgedRunsReplace:
          "INSERT OR REPLACE INTO purged_runs (rowid, seq, id, purged_at, run_phase, phase_version) VALUES (1, 1, 'ghost', 'x', 'p', 'v')",
        purgedRunsUpdate: 'UPDATE purged_runs SET oid = 9',
        storeMetaReplace: `INSERT OR REPLACE INTO store_meta (rowid, one, page_size, commit_epoch, created_at, tomb_seq, tombstones_through_seq, tombstones_since) VALUES (1, 1, 16384, 0, '${CREATED}', 0, 0, '${CREATED}')`,
        storeMetaUpdate: 'UPDATE store_meta SET oid = 2',
        purgedIdsByRowNumber:
          "INSERT INTO purged_ids (rowid, id, purged_at) VALUES (1, 'ghost', 'x')",
      };
      for (const [name, sql] of Object.entries(attacks)) {
        const db = freshWith(mode.settings, mode.recursive);
        addFinished(db, 'run-1');
        db.prepare(DELETE_RUN).run('run-1');
        const before = tombRows(db);
        results[`${name}/${mode.label}`] = {
          outcome: outcome(db, sql),
          rowsUnchanged: tombRows(db) === before,
        };
      }
    }
    const want: Record<string, string> = {
      purgedRunsReplace: MSG.tombstone,
      purgedRunsUpdate: MSG.tombstone,
      storeMetaReplace: MSG.metaReplaced,
      storeMetaUpdate: MSG.metaReplaced,
      purgedIdsByRowNumber: 'table purged_ids has no column named rowid',
    };
    // (1) red when purged_runs' insert or update guard, or the meta row's one-row or immutable guard,
    //     is dropped (the REPLACE swaps the row there), or purged_ids gains a hidden row number;
    //     (2) prints each outcome per mode, and whether the rows stayed.
    expect(results).toEqual(
      Object.fromEntries(
        Object.keys(results).map((k) => [
          k,
          { outcome: want[k.split('/')[0] ?? ''], rowsUnchanged: true },
        ]),
      ),
    );
  });
});
