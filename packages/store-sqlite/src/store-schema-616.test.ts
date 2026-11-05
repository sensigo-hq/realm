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
} as const;

const PHASE_STAMP = '0123456789abcdef';
const open: DatabaseLike[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

/** A database holding the schema, made the way unit 7 will make one: each statement in order. */
function fresh(): DatabaseLike {
  const db = openDatabase(':memory:');
  open.push(db);
  for (const statement of REALM_STORE_SCHEMA) db.exec(statement);
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
  it('a database created from the constant stores exactly its text, and holds the three tables, three indexes and thirteen guards of this unit', () => {
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
