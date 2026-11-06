// open-file.test.ts — issue #616 PR-1a unit 7b: the open, `RealmDb.open`, on real homes in a temp
// directory. The real cases: a new user's first run, where several Realm processes start at once on a
// home that does not exist yet; a store file another program wrote or changed (a SQLite shell, a sync
// tool, a damaged disk), or a `realm.db` that is a folder or a link; a store one schema version behind
// or ahead; a Node whose SQLite has the WAL-reset bug and a home on a network drive, both refused
// before anything is written; a pragma that silently did not take; a connection a crash left poisoned;
// and a write the file's own guards refuse.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  REALM_STORE_SCHEMA,
  REALM_STORE_SCHEMA_VERSION,
  REALM_STORE_VERSIONS,
  versionConflictError,
  WorkflowError,
  type Clock,
  type StoreSchemaVersions,
} from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { BUSY_SLICE_MS, MAPPED_GUARD_MESSAGES, mapSqliteError, RealmDb } from './connection.js';
import { createSqliteLoader, openDatabase, type DatabaseLike } from './driver.js';
import { SYSTEM_PROBE } from './filesystem-gate.js';
import { DATABASE_FILE } from './home.js';
import { JOURNAL_SIZE_LIMIT_BYTES, type OpenSeams } from './open-file.js';
import { migrateSchema, storedSchemaDifference } from './schema-ladder.js';
import { MOUNT_TABLE_MACOS_14 } from './test-support/darwin-mount-tables.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AS_ROOT = process.getuid?.() === 0;
if (AS_ROOT) {
  console.warn(
    '#616 unit 7b: the two cells of a store file Realm may not write are skipped: root can write any file.',
  );
}

/** The home's clock in every cell: a fixed instant, so the meta row's time can be checked. */
const AT = '2026-11-06T09:00:00.000Z';
const clock: Clock = { now: () => new Date(AT), at: () => () => undefined };
/** `REALM_STORE_APPLICATION_ID`, as SQLite prints it. */
const REALM_ID = 1380270412;

const dirs: string[] = [];
const stores: RealmDb[] = [];
const connections: DatabaseLike[] = [];
const locked: string[] = [];
afterEach(() => {
  for (const db of stores.splice(0)) {
    try {
      db.close();
    } catch {
      // closed by its cell
    }
  }
  for (const c of connections.splice(0)) {
    try {
      c.close();
    } catch {
      // closed by its cell, or by the class after a reopen
    }
  }
  for (const p of locked.splice(0)) chmodSync(p, 0o600);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-u07b-'));
  dirs.push(dir);
  return dir;
}

async function open(home: string, seams?: OpenSeams): Promise<RealmDb> {
  const db = await RealmDb.open(home, { clock }, seams);
  stores.push(db);
  return db;
}

/** What an open does: `'opened'`, or the typed refusal (code, message, details), or a plain error. */
async function outcome(home: string, seams?: OpenSeams): Promise<unknown> {
  try {
    await open(home, seams);
    return 'opened';
  } catch (err) {
    if (err instanceof WorkflowError) {
      return { code: err.code, message: err.message, details: err.details };
    }
    return { plainError: String(err) };
  }
}

/** The settings refusal as a user reads it. */
function settings(path: string, ...differences: string[]): unknown {
  return {
    code: 'STATE_STORE_SETTINGS_REFUSED',
    message: `The store file ${path} is not a Realm store this Realm can use: ${differences.join('; ')}. Realm does not change or replace a store file by itself.`,
    details: { path, differences },
  };
}

/**
 * The settings refusal of an empty file that already has pages, as a user reads it: the lead and
 * the remedy are in the message only, `details` lists the differences alone.
 */
function noStoreYet(path: string, ...differences: string[]): unknown {
  return {
    code: 'STATE_STORE_SETTINGS_REFUSED',
    message: `The store file ${path} is not a Realm store this Realm can use: it holds no store yet, but ${differences.join('; ')}. Remove it and Realm makes a new one. Realm does not change or replace a store file by itself.`,
    details: { path, differences },
  };
}

/** A Realm store made by a first open and closed again. */
async function realmStore(): Promise<{ home: string; file: string }> {
  const home = join(tmp(), '.realm');
  (await RealmDb.open(home, { clock })).close();
  return { home, file: join(home, DATABASE_FILE) };
}

/** A home folder holding `realm.db` as the cell makes it (no open has run there). */
function homeWith(make: (file: string) => void): { home: string; file: string } {
  const home = join(tmp(), '.realm');
  mkdirSync(home);
  const file = join(home, DATABASE_FILE);
  make(file);
  return { home, file };
}

/** Another program's connection on a file: the cell acts through it, then closes it. */
function foreign(file: string, act: (db: DatabaseLike) => void): void {
  const db = openDatabase(file);
  try {
    act(db);
  } finally {
    db.close();
  }
}

/** A file's bytes (as a hash) and inode: what a refusal must leave exactly as it was. */
function identity(path: string): { sha256: string; ino: number } {
  return {
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    ino: statSync(path).ino,
  };
}

/** Core's versions with a version 2 that adds one table (unit 6c's way of testing a later version). */
const LADDER_2: StoreSchemaVersions = new Map([
  ...REALM_STORE_VERSIONS,
  [
    2,
    {
      schema: [...REALM_STORE_SCHEMA, 'CREATE TABLE ladder_notes (k TEXT NOT NULL)'],
      upgrade: ['CREATE TABLE ladder_notes (k TEXT NOT NULL)'],
    },
  ],
]);

/** The same, with a version 3 that adds a second table. */
const LADDER_3: StoreSchemaVersions = new Map([
  ...LADDER_2,
  [
    3,
    {
      schema: [...LADDER_2.get(2)!.schema, 'CREATE TABLE ladder_tags (tag TEXT NOT NULL)'],
      upgrade: ['CREATE TABLE ladder_tags (tag TEXT NOT NULL)'],
    },
  ],
]);

/** Opens through the one loader and keeps every connection the open makes, in order. */
function recordingOpens(): { opened: DatabaseLike[]; openFile: (path: string) => DatabaseLike } {
  const opened: DatabaseLike[] = [];
  return {
    opened,
    openFile: (path) => {
      const db = openDatabase(path);
      opened.push(db);
      connections.push(db);
      return db;
    },
  };
}

/** A real connection whose statements go through `exec` and `prepare` as given. */
function wrapping(
  path: string,
  exec: (real: DatabaseLike, sql: string) => void,
  prepare: (real: DatabaseLike, sql: string) => ReturnType<DatabaseLike['prepare']>,
): DatabaseLike {
  const real = openDatabase(path);
  connections.push(real);
  return {
    exec: (sql) => exec(real, sql),
    prepare: (sql) => prepare(real, sql),
    close: () => real.close(),
    get isTransaction() {
      return real.isTransaction;
    },
  };
}

/**
 * Opens connections on which one statement does nothing: SQLite's answer to a pragma it ignores (as
 * it does inside a transaction) is no error and no change.
 */
function ignoring(statement: string): (path: string) => DatabaseLike {
  return (path) =>
    wrapping(
      path,
      (real, sql) => (sql === statement ? undefined : real.exec(sql)),
      (real, sql) => real.prepare(sql),
    );
}

/**
 * Opens connections whose switch to WAL answers `mode`: SQLite's answer when it cannot change the
 * journal mode is the mode the file keeps (sqlite.org pragma.html#pragma_journal_mode: "If the
 * journal mode could not be changed, the original journal mode is returned").
 */
function walAnswering(mode: string): (path: string) => DatabaseLike {
  return (path) =>
    wrapping(
      path,
      (real, sql) => real.exec(sql),
      (real, sql) =>
        sql === 'PRAGMA journal_mode = WAL'
          ? {
              run: () => ({ changes: 0, lastInsertRowid: 0 }),
              get: () => ({ journal_mode: mode }),
              all: () => [{ journal_mode: mode }],
            }
          : real.prepare(sql),
    );
}

/** Counts the connections `openFile` makes and the closes they get. */
function counting(openFile: (path: string) => DatabaseLike): {
  count: { made: number; closed: number };
  openFile: (path: string) => DatabaseLike;
} {
  const count = { made: 0, closed: 0 };
  return {
    count,
    openFile: (path) => {
      const db = openFile(path);
      count.made += 1;
      return {
        exec: (sql) => db.exec(sql),
        prepare: (sql) => db.prepare(sql),
        close: () => {
          count.closed += 1;
          db.close();
        },
        get isTransaction() {
          return db.isTransaction;
        },
      };
    },
  };
}

/** The `realm.db-*` files beside the store file (SQLite's write-ahead log and shared memory). */
function sideFiles(home: string): string[] {
  return readdirSync(home)
    .filter((name) => name.startsWith(`${DATABASE_FILE}-`))
    .sort();
}

/** A pragma's value as SQLite reads it back. */
function pragma(db: DatabaseLike, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return row === undefined ? undefined : Object.values(row)[0];
}

describe('#616 unit 7b — the order of the open', () => {
  it('a home that does not exist, on a filesystem the gate refuses, is refused before anything is made', async () => {
    const parent = join(tmp(), 'new');
    const home = join(parent, '.realm');
    // The gate's probe of this machine, with the filesystem answering NFS's statfs type.
    const nfs = { ...SYSTEM_PROBE, platform: 'linux', env: {}, statfsType: () => 0x6969 };
    const result = (await outcome(home, { probe: nfs })) as { code?: unknown };
    // (1) red when the home is prepared before the gate runs (the folder, its fences and realm.db
    //     are then made on a drive the store cannot use), or when the gate does not run; (2) prints
    //     the open's outcome and whether the folder above the home exists.
    expect({ code: result.code, made: existsSync(parent) }).toEqual({
      code: 'STATE_STORE_FILESYSTEM_REFUSED',
      made: false,
    });
  });

  it('a SQLite below the floor is refused before the home is made', async () => {
    const home = join(tmp(), '.realm');
    // Node 24.13.1's built-in, as the loader reads it: its in-memory database answers 3.51.2.
    const below = createSqliteLoader({
      loadBuiltin: () => ({
        DatabaseSync: class {
          prepare() {
            return { get: () => ({ v: '3.51.2' }) };
          }
          close() {}
        },
      }),
      nodeVersion: 'v24.13.1',
    });
    const result = (await outcome(home, { loadSqlite: () => below.load() })) as {
      code?: unknown;
      details?: unknown;
    };
    // (1) red when the home is prepared before the version check, or the check does not run;
    //     (2) prints the open's code and details and whether the home exists.
    expect({ code: result.code, details: result.details, made: existsSync(home) }).toEqual({
      code: 'STATE_STORE_DRIVER_UNAVAILABLE',
      details: { node: 'v24.13.1', sqlite: '3.51.2' },
      made: false,
    });
  });
});

describe('#616 unit 7b — the first open', () => {
  it('80 first opens in separate processes at once make one store: one schema, one meta row, WAL, incremental vacuum, 16 KiB pages', async () => {
    const connection = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'connection.js')).href;
    const home = join(tmp(), '.realm');
    const plan = JSON.stringify({ home, start: Date.now() + 3_000 });
    const opener =
      `import { RealmDb } from ${JSON.stringify(connection)};` +
      'const { home, start } = JSON.parse(process.env.U07B_FIRST); while (Date.now() < start) {}' +
      'const clock = { now: () => new Date(), at: () => () => undefined };' +
      'try { (await RealmDb.open(home, { clock })).close(); console.log("ok"); }' +
      ' catch (e) { console.log(String(e.code ?? e.message)); }';
    const run = (): Promise<{ status: number | null; out: string }> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', opener], {
          env: { ...process.env, U07B_FIRST: plan },
          timeout: 60_000,
        });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.on('close', (status) => resolve({ status, out: out.trim() }));
      });
    const OPENERS = 80;
    const results = await Promise.all(Array.from({ length: OPENERS }, run));
    const db = openDatabase(join(home, DATABASE_FILE));
    connections.push(db);
    let file: unknown;
    try {
      file = {
        metaRows: Number(db.prepare('SELECT count(*) AS n FROM store_meta').get()?.['n']),
        schema: storedSchemaDifference(db, REALM_STORE_SCHEMA),
        journalMode: pragma(db, 'journal_mode'),
        autoVacuum: pragma(db, 'auto_vacuum'),
        pageSize: pragma(db, 'page_size'),
      };
    } catch (err) {
      // A file the openers left without Realm's tables: printed beside the openers' answers.
      file = { unreadable: String(err) };
    }
    // (1) red when the persistent pragmas are set inside the setup's transaction (SQLite ignores
    //     them there: the file stays in delete mode with 4 KiB pages and no vacuum), when the
    //     "uninitialised" test reads the file's size (a WAL switch alone writes 4,096 bytes, so a
    //     later opener refuses the half-made file), or when the setup does not test again under its
    //     write lock (a second meta row is refused by its guard, and an opener fails); (2) prints
    //     every opener whose exit status or output was not "ok" with what it printed, and the file.
    expect({
      failed: results.filter((r) => r.status !== 0 || r.out !== 'ok'),
      file,
    }).toEqual({
      failed: [],
      file: {
        metaRows: 1,
        schema: { missing: [], extra: [], changed: [] },
        journalMode: 'wal',
        autoVacuum: 2,
        pageSize: 16384,
      },
    });
  }, 120_000); // it starts 80 Node processes

  it("a first open sets the file up with Realm's id and version and a meta row timed by the home's clock", async () => {
    const { file } = await realmStore();
    const db = openDatabase(file);
    connections.push(db);
    // (1) red when the meta row's time comes from the system clock and not the home's, when a
    //     counter or the horizon starts elsewhere, when the page size recorded is not 16 KiB, or the
    //     application id or version is not set; (2) prints the four values.
    expect({
      applicationId: pragma(db, 'application_id'),
      version: pragma(db, 'user_version'),
      meta: db
        .prepare('SELECT * FROM store_meta')
        .all()
        .map((r) => ({ ...r })),
      mode: (statSync(file).mode & 0o777).toString(8),
    }).toEqual({
      applicationId: REALM_ID,
      version: 1,
      meta: [
        {
          one: 1,
          page_size: 16384,
          commit_epoch: 0,
          created_at: AT,
          tomb_seq: 0,
          tombstones_through_seq: 0,
          tombstones_since: AT,
        },
      ],
      mode: '600',
    });
  });

  it('the version this Realm writes is the newest in its table of versions, and a first open creates that version’s schema', async () => {
    const newest = Math.max(...REALM_STORE_VERSIONS.keys());
    const { file } = await realmStore();
    const db = openDatabase(file);
    connections.push(db);
    // (1) red when the version constant is moved without its entry in the table (set it to 2 with
    //     the table unchanged: the open then has no schema for it), or when a first open creates
    //     another schema than the newest entry's; (2) prints the constant, the newest version and
    //     the difference from that version's schema.
    expect({
      constant: REALM_STORE_SCHEMA_VERSION,
      newest,
      difference: storedSchemaDifference(db, REALM_STORE_VERSIONS.get(newest)!.schema),
    }).toEqual({ constant: newest, newest, difference: { missing: [], extra: [], changed: [] } });
  });

  it('a WAL switch SQLite does not make is refused, and the file is not set up', async () => {
    const home = join(tmp(), '.realm');
    // The connection is the real one; only the switch's answer is the file's old mode.
    const result = await outcome(home, { openFile: walAnswering('delete') });
    const file = join(home, DATABASE_FILE);
    const db = openDatabase(file);
    connections.push(db);
    // (1) red when the WAL switch's answer is not checked (the setup then runs: the file gets
    //     Realm's schema in delete mode, and the open refuses it later with another clause);
    //     (2) prints the open's outcome and the file's application id.
    expect({ result, applicationId: pragma(db, 'application_id') }).toEqual({
      result: settings(file, 'SQLite left its journal mode at delete when Realm set wal'),
      applicationId: 0,
    });
  });
});

describe('#616 unit 7b — an empty store file that another program already wrote to', () => {
  // Realm creates `realm.db` empty and sets it up in the same open. Another program that writes to
  // the empty file in between (or after a first open killed before its setup) gives it pages, and
  // with them a page size and an `auto_vacuum` that can no longer change once it is in WAL.
  it.each([
    [
      'switched to WAL (4096-byte pages, auto_vacuum 0)',
      ['PRAGMA journal_mode = WAL'],
      [
        'its auto_vacuum is 0, not 2 (incremental)',
        'its page size is 4096 bytes, not the 16384 Realm needs',
      ],
      'wal',
    ],
    [
      'given auto_vacuum 2 and switched to WAL (4096-byte pages)',
      ['PRAGMA auto_vacuum = 2', 'PRAGMA journal_mode = WAL'],
      ['its page size is 4096 bytes, not the 16384 Realm needs'],
      'wal',
    ],
    [
      'given 16384-byte pages and switched to WAL (auto_vacuum 0)',
      ['PRAGMA page_size = 16384', 'PRAGMA journal_mode = WAL'],
      ['its auto_vacuum is 0, not 2 (incremental)'],
      'wal',
    ],
    [
      'given a table and dropped it again, in rollback-journal mode (4096-byte pages, auto_vacuum 0)',
      ['CREATE TABLE notes (body TEXT)', 'DROP TABLE notes'],
      [
        'its auto_vacuum is 0, not 2 (incremental)',
        'its page size is 4096 bytes, not the 16384 Realm needs',
      ],
      'delete',
    ],
  ])(
    'an empty file another program %s is refused before anything is written, every time',
    async (_, statements, differences, journalMode) => {
      const { home, file } = homeWith((f) =>
        foreign(f, (db) => {
          for (const statement of statements) db.exec(statement);
        }),
      );
      const before = { ...identity(file), size: statSync(file).size };
      const result = await outcome(home);
      const again = await outcome(home);
      const after = { ...identity(file), size: statSync(file).size };
      let state: unknown;
      foreign(file, (db) => {
        state = {
          applicationId: pragma(db, 'application_id'),
          journalMode: pragma(db, 'journal_mode'),
        };
      });
      // (1) red when the setup does not check a file that already has pages (the open then stamps
      //     the file as Realm's and refuses it with the page size "it recorded"), or checks it only
      //     after its switch to WAL (the rollback-journal file is then written: its journal mode,
      //     hash and size change), or the sentence loses its remedy; (2) prints both outcomes, the
      //     file's hash, inode and size before and after, its application id and journal mode.
      expect({ result, again, after, file: state }).toEqual({
        result: noStoreYet(file, ...differences),
        again: noStoreYet(file, ...differences),
        after: before,
        file: { applicationId: 0, journalMode },
      });
    },
  );

  it('the remedy the refusal names works: with the file removed, the next open makes a new store', async () => {
    const { home, file } = homeWith((f) =>
      foreign(f, (db) => db.exec('PRAGMA journal_mode = WAL')),
    );
    const refused = await outcome(home);
    // What the sentence says, and nothing else: the store file is removed.
    rmSync(file);
    const result = await outcome(home);
    let made: unknown;
    foreign(file, (db) => {
      made = {
        applicationId: pragma(db, 'application_id'),
        pageSize: pragma(db, 'page_size'),
        autoVacuum: pragma(db, 'auto_vacuum'),
      };
    });
    // (1) red when the sentence's promise stops being true (an open that refuses a path it once
    //     refused, or a removed file that is not made again); (2) prints the first outcome's code,
    //     the second outcome and the new file's application id, page size and auto_vacuum.
    expect({
      refused: (refused as { code?: unknown }).code,
      result,
      made,
    }).toEqual({
      refused: 'STATE_STORE_SETTINGS_REFUSED',
      result: 'opened',
      made: { applicationId: REALM_ID, pageSize: 16384, autoVacuum: 2 },
    });
  });

  it("an empty file that already has pages with Realm's page size and auto_vacuum is set up", async () => {
    // What another Realm opener's own switch to WAL leaves; here another program does the same.
    const { home, file } = homeWith((f) =>
      foreign(f, (db) =>
        db.exec('PRAGMA page_size = 16384; PRAGMA auto_vacuum = 2; PRAGMA journal_mode = WAL'),
      ),
    );
    const result = await outcome(home);
    let made: unknown;
    foreign(file, (db) => {
      made = { applicationId: pragma(db, 'application_id'), version: pragma(db, 'user_version') };
    });
    // (1) red when the setup refuses a file for having pages alone (a first opener would then refuse
    //     the file another Realm opener has just switched to WAL); (2) prints the outcome and the
    //     file's application id and schema version.
    expect({ result, made }).toEqual({
      result: 'opened',
      made: { applicationId: REALM_ID, version: 1 },
    });
  });
});

describe('#616 unit 7b — a realm.db that is not a regular file', () => {
  it('a directory is refused and left as it was', async () => {
    const { home, file } = homeWith((f) => mkdirSync(f));
    const ino = statSync(file).ino;
    const result = await outcome(home);
    // (1) red when the store file's kind is not checked by lstat (SQLite then fails to open it and
    //     the refusal says Realm cannot write to it); (2) prints the outcome and the directory.
    expect({
      result,
      after: {
        dir: statSync(file).isDirectory(),
        ino: statSync(file).ino,
        entries: readdirSync(file),
      },
    }).toEqual({
      result: settings(file, 'it is a directory'),
      after: { dir: true, ino, entries: [] },
    });
  });

  it('a symbolic link to a store file is refused, and neither the link nor its target changes', async () => {
    const target = join(tmp(), 'elsewhere.db');
    const { file: elsewhere } = await realmStore();
    writeFileSync(target, readFileSync(elsewhere));
    const { home, file } = homeWith((f) => symlinkSync(target, f));
    const before = identity(target);
    const result = await outcome(home);
    // (1) red when a link at the store's name is opened (SQLite follows it to the file elsewhere);
    //     (2) prints the outcome, the link's text and the target's hash and inode.
    expect({ result, link: readlinkSync(file), target: identity(target) }).toEqual({
      result: settings(
        file,
        'it is a symbolic link; link the home folder instead, never the store file',
      ),
      link: target,
      target: before,
    });
  });

  it('a dangling symbolic link is refused, and its target is not created', async () => {
    const target = join(tmp(), 'nowhere.db');
    const { home, file } = homeWith((f) => symlinkSync(target, f));
    const result = await outcome(home);
    // (1) red when SQLite opens the file before the lstat check (SQLite creates the target of a
    //     dangling link when it opens it); (2) prints the outcome and whether the target exists.
    expect({ result, targetMade: existsSync(target), link: readlinkSync(file) }).toEqual({
      result: settings(
        file,
        'it is a symbolic link; link the home folder instead, never the store file',
      ),
      targetMade: false,
      link: target,
    });
  });

  it('a named pipe is refused and left as it was', async () => {
    const { home, file } = homeWith((f) => execFileSync('mkfifo', [f]));
    const result = await outcome(home);
    // (1) red when only directories and links are refused (SQLite then fails with a plain
    //     "disk I/O error"); (2) prints the outcome and whether the pipe is still there.
    expect({ result, pipe: lstatSync(file).isFIFO() }).toEqual({
      result: settings(file, 'it is not a regular file (a named pipe, a socket or a device)'),
      pipe: true,
    });
  }, 30_000); // it starts mkfifo, a child process
});

describe('#616 unit 7b — the checks of an existing file', () => {
  it('a text file named realm.db is refused and left as it was', async () => {
    const { home, file } = homeWith((f) => writeFileSync(f, 'notes, not a database\n'.repeat(40)));
    const before = identity(file);
    const result = await outcome(home);
    // (1) red when SQLite's "file is not a database" (26) is not turned into the refusal (it leaves
    //     as a plain error), or the file is replaced; (2) prints the outcome and the file's hash and
    //     inode.
    expect({ result, after: identity(file) }).toEqual({
      result: settings(file, 'it is not a SQLite database (SQLite: file is not a database)'),
      after: before,
    });
  });

  it('a damaged store file is refused and left as it was', async () => {
    const { home, file } = await realmStore();
    // The first page's b-tree header (offset 100) overwritten: the schema can no longer be read.
    const fd = openSync(file, 'r+');
    writeSync(fd, Buffer.alloc(16, 0xee), 0, 16, 100);
    closeSync(fd);
    const before = identity(file);
    const result = await outcome(home);
    // (1) red when SQLite's "database disk image is malformed" (11) is not turned into the refusal,
    //     or the file is replaced; (2) prints the outcome and the file's hash and inode.
    expect({ result, after: identity(file) }).toEqual({
      result: settings(file, 'it is damaged (SQLite: database disk image is malformed)'),
      after: before,
    });
  });

  it("another program's database with a schema version above Realm's is refused for its application id, never as a newer Realm's", async () => {
    const { home, file } = homeWith((f) =>
      foreign(f, (db) => db.exec('CREATE TABLE notes (body TEXT); PRAGMA user_version = 9')),
    );
    const before = identity(file);
    const result = await outcome(home);
    // (1) red when the version is judged before the application id, or read through a form that
    //     refuses a newer version first (the refusal then says a newer Realm migrated it); (2) prints
    //     the outcome and the file's hash and inode.
    expect({ result, after: identity(file) }).toEqual({
      result: settings(file, `its application id is 0, not Realm's ${REALM_ID}`),
      after: before,
    });
  });

  it.each([
    ['only its application id is set', 'PRAGMA application_id = 305419896', 305419896],
    ['only its schema version is set', 'PRAGMA user_version = 1', 0],
    ['only a table is in it', 'CREATE TABLE notes (body TEXT)', 0],
  ])(
    'a file that is uninitialised but for one thing (%s) is refused, not set up',
    async (_, sql, applicationId) => {
      const { home, file } = homeWith((f) => foreign(f, (db) => db.exec(sql)));
      const before = identity(file);
      const result = await outcome(home);
      // (1) red when that one conjunct of "uninitialised" (application id 0, schema version 0, no
      //     schema object) is dropped: the file is then set up as Realm's and opened; (2) prints the
      //     outcome and the file's hash and inode.
      expect({ result, after: identity(file) }).toEqual({
        result: settings(file, `its application id is ${applicationId}, not Realm's ${REALM_ID}`),
        after: before,
      });
    },
  );

  it('a store one schema version behind is refused as older, never as tampered', async () => {
    const { home, file } = await realmStore();
    const before = identity(file);
    // A Realm that writes version 2 (unit 6c's way: version 1 plus one table) opens a version-1 file.
    const result = await outcome(home, { schemaVersion: 2, versions: LADDER_2 });
    // (1) red when the stored schema is compared with this Realm's version before the versions are
    //     compared (the file then reads as tampered), or the file is changed; (2) prints the
    //     outcome and the file's hash and inode.
    expect({ result, after: identity(file) }).toEqual({
      result: {
        code: 'STATE_STORE_VERSION_OLDER',
        message:
          "This store's file is at schema version 1; this Realm writes version 2. Run `realm db migrate` with Realm stopped to upgrade it.",
        details: { file: 1, realm: 2 },
      },
      after: before,
    });
  });

  it('a store a newer Realm migrated is refused as newer by the open, naming the version this Realm writes', async () => {
    const { home, file } = await realmStore();
    // A file climbed to version 3, opened by a Realm that writes version 2. The read transactions'
    // own gate compares with core's version (1), so this cell tells the open's refusal from it.
    foreign(file, (db) => migrateSchema(db, 3, LADDER_3));
    const before = identity(file);
    const result = await outcome(home, { schemaVersion: 2, versions: LADDER_3 });
    // (1) red when the open does not refuse a version above its own from its first read (the read
    //     transactions' gate then refuses, naming core's version 1 as this Realm's), or the file is
    //     changed; (2) prints the outcome and the file's hash and inode.
    expect({ result, after: identity(file) }).toEqual({
      result: {
        code: 'STATE_STORE_VERSION_NEWER',
        message:
          'This store was migrated by a newer Realm: its schema is version 3 and this Realm writes version 2. Upgrade Realm to read or write it.',
        details: { file: 3, realm: 2 },
      },
      after: before,
    });
  });

  it.each([
    [
      'a table changed by another program',
      'ALTER TABLE runs ADD COLUMN note TEXT',
      { missing: [], extra: [], changed: ['table runs'] },
    ],
    [
      'a guard dropped by another program',
      'DROP TRIGGER store_meta_no_delete',
      { missing: ['trigger store_meta_no_delete'], extra: [], changed: [] },
    ],
  ])('a store with %s at this version is refused as tampered', async (_, sql, difference) => {
    const { home, file } = await realmStore();
    foreign(file, (db) => db.exec(sql));
    const before = identity(file);
    const result = await outcome(home);
    // (1) red when the stored schema is not compared with this version's (the store opens without
    //     the guard, or with a table Realm did not make), or the file is changed; (2) prints the
    //     outcome with the objects that differ, and the file's hash and inode.
    expect({ result, after: identity(file) }).toEqual({
      result: {
        code: 'STATE_STORE_SCHEMA_TAMPERED',
        message: `The tables in ${file} do not match what this Realm writes for schema version 1. This usually means someone changed the store outside Realm. Realm will not use it; restore a backup made before the change.`,
        details: { path: file, version: 1, ...difference },
      },
      after: before,
    });
  });

  it.each([
    [
      'its meta table dropped',
      'DROP TABLE store_meta',
      {
        // A table's triggers go with it.
        missing: [
          'table store_meta',
          'trigger store_meta_insert_once',
          'trigger store_meta_no_delete',
          'trigger store_meta_immutable',
          'trigger store_meta_forward',
          'trigger store_meta_insert_types',
          'trigger store_meta_update_types',
        ],
        extra: [],
        changed: [],
      },
    ],
    [
      'its meta table renamed',
      'ALTER TABLE store_meta RENAME TO sm',
      {
        missing: ['table store_meta'],
        extra: ['table sm'],
        // SQLite rewrites every trigger that names the table.
        changed: [
          'trigger store_meta_insert_once',
          'trigger store_meta_no_delete',
          'trigger store_meta_immutable',
          'trigger store_meta_forward',
          'trigger store_meta_insert_types',
          'trigger store_meta_update_types',
          'trigger purged_runs_insert_own',
          'trigger purged_runs_delete_below_horizon',
          'trigger runs_tombstone',
        ],
      },
    ],
    [
      "its meta table's page_size column renamed",
      'ALTER TABLE store_meta RENAME COLUMN page_size TO ps',
      {
        missing: [],
        extra: [],
        changed: [
          'table store_meta',
          'trigger store_meta_immutable',
          'trigger store_meta_insert_types',
        ],
      },
    ],
  ])('a store with %s by another program is refused as tampered', async (_, sql, difference) => {
    const { home, file } = await realmStore();
    foreign(file, (db) => db.exec(sql));
    const before = identity(file);
    const result = await outcome(home);
    // (1) red when the meta row is read in the same step as the schema's difference, before it is
    //     judged (the read then fails first and leaves as SQLite's plain "no such table" or "no such
    //     column"), or the file is changed; (2) prints the outcome with the objects that differ,
    //     and the file's hash and inode.
    expect({ result, after: identity(file) }).toEqual({
      result: {
        code: 'STATE_STORE_SCHEMA_TAMPERED',
        message: `The tables in ${file} do not match what this Realm writes for schema version 1. This usually means someone changed the store outside Realm. Realm will not use it; restore a backup made before the change.`,
        details: { path: file, version: 1, ...difference },
      },
      after: before,
    });
  });

  it('a store whose meta row another program removed is refused', async () => {
    const { home, file } = await realmStore();
    const guard = REALM_STORE_SCHEMA.find((s) =>
      s.startsWith('CREATE TRIGGER store_meta_no_delete'),
    )!;
    // The guard dropped, the row deleted, the guard put back with its exact text: the schema is
    // whole again and only the row is gone.
    foreign(file, (db) =>
      db.exec(`DROP TRIGGER store_meta_no_delete; DELETE FROM store_meta; ${guard}`),
    );
    const before = identity(file);
    const result = await outcome(home);
    // (1) red when the meta row's absence is not refused (the page size is then compared with
    //     nothing); (2) prints the outcome and the file's hash and inode.
    expect({ result, after: identity(file) }).toEqual({
      result: settings(file, 'its meta row is missing'),
      after: before,
    });
  });

  it.each([
    ['journal mode', ['PRAGMA journal_mode = DELETE'], ['its journal mode is delete, not wal']],
    [
      'auto_vacuum',
      [
        'PRAGMA journal_mode = DELETE',
        'PRAGMA auto_vacuum = NONE',
        'VACUUM',
        'PRAGMA journal_mode = WAL',
      ],
      ['its auto_vacuum is 0, not 2 (incremental)'],
    ],
    [
      'page size',
      [
        'PRAGMA journal_mode = DELETE',
        'PRAGMA page_size = 4096',
        'VACUUM',
        'PRAGMA journal_mode = WAL',
      ],
      ['its page size is 4096 bytes, not the 16384 it recorded when it was created'],
    ],
    [
      'journal mode, auto_vacuum and page size at once',
      [
        'PRAGMA journal_mode = DELETE',
        'PRAGMA auto_vacuum = NONE',
        'PRAGMA page_size = 4096',
        'VACUUM',
      ],
      [
        'its journal mode is delete, not wal',
        'its auto_vacuum is 0, not 2 (incremental)',
        'its page size is 4096 bytes, not the 16384 it recorded when it was created',
      ],
    ],
  ])(
    'a store whose %s another program changed is refused, naming each difference',
    async (_, statements, differences) => {
      const { home, file } = await realmStore();
      foreign(file, (db) => {
        for (const statement of statements) db.exec(statement);
      });
      const before = identity(file);
      const result = await outcome(home);
      // (1) red when that setting is not checked, or only the first difference is named;
      //     (2) prints the outcome and the file's hash and inode.
      expect({ result, after: identity(file) }).toEqual({
        result: settings(file, ...differences),
        after: before,
      });
    },
  );

  it.skipIf(AS_ROOT)('a store file Realm may not open is refused as not writable', async () => {
    const { home, file } = await realmStore();
    const before = identity(file);
    chmodSync(file, 0o000);
    locked.push(file);
    const result = await outcome(home);
    chmodSync(file, 0o600);
    // (1) red when the open does not ask the operating system whether it may write the file (SQLite
    //     then fails at its own open and the reason is its "unable to open database file"), or the
    //     file is changed; (2) prints the outcome and the file's hash and inode.
    expect({ result, after: identity(file) }).toEqual({
      result: {
        code: 'STATE_STORE_READONLY',
        message: `Realm cannot write to ${file}: permission denied. The store needs a home that Realm can write to.`,
        details: { path: file, reason: 'permission denied' },
      },
      after: before,
    });
  });

  it.skipIf(AS_ROOT)(
    'a store file Realm may read but not write is refused as not writable, and SQLite makes no file beside it',
    async () => {
      // A store restored read-only (from a backup, or after `chmod a-w`), closed: no log beside it.
      const { home, file } = await realmStore();
      const sideBefore = sideFiles(home);
      const before = identity(file);
      chmodSync(file, 0o400);
      locked.push(file);
      const result = await outcome(home);
      const sideAfter = sideFiles(home);
      chmodSync(file, 0o600);
      // (1) red when the open does not ask whether it may write the file (SQLite then opens it
      //     read-only, the open says ready, leaves `-wal` and `-shm` files it made read-only too,
      //     and the first write fails), or the file is changed; (2) prints the outcome, the files
      //     beside the store before and after, and the file's hash and inode.
      expect({ result, sideBefore, sideAfter, after: identity(file) }).toEqual({
        result: {
          code: 'STATE_STORE_READONLY',
          message: `Realm cannot write to ${file}: permission denied. The store needs a home that Realm can write to.`,
          details: { path: file, reason: 'permission denied' },
        },
        sideBefore: [],
        sideAfter: [],
        after: before,
      });
    },
  );
});

describe('#616 unit 7b — the connection pragmas', () => {
  it('every connection pragma is set on the connection the open returns, and reads back', async () => {
    const { home } = await realmStore();
    const { opened, openFile } = recordingOpens();
    await open(home, { openFile });
    const db = opened[0]!;
    // (1) red when a pragma is left out of the open, or set to another value (the busy timeout
    //     from a literal and not the class's own slice); (2) prints the values read back.
    expect({
      busyTimeout: pragma(db, 'busy_timeout'),
      synchronous: pragma(db, 'synchronous'),
      foreignKeys: pragma(db, 'foreign_keys'),
      trustedSchema: pragma(db, 'trusted_schema'),
      secureDelete: pragma(db, 'secure_delete'),
      journalSizeLimit: pragma(db, 'journal_size_limit'),
    }).toEqual({
      busyTimeout: BUSY_SLICE_MS,
      synchronous: 2,
      foreignKeys: 1,
      trustedSchema: 0,
      secureDelete: 2,
      journalSizeLimit: JOURNAL_SIZE_LIMIT_BYTES,
    });
  });

  it('on macOS the two full-fsync pragmas are also set and read back', async () => {
    const { home } = await realmStore();
    const { opened, openFile } = recordingOpens();
    // The gate's probe as macOS answers it (a GitHub runner's mount table: the root is local).
    const mac = {
      ...SYSTEM_PROBE,
      platform: 'darwin',
      env: {},
      mountTable: () => MOUNT_TABLE_MACOS_14,
    };
    await open(home, { openFile, probe: mac });
    const db = opened[0]!;
    // (1) red when the macOS pragmas are left out (a commit there is then flushed to the drive's
    //     cache only); (2) prints the two values read back.
    expect({
      fullfsync: pragma(db, 'fullfsync'),
      checkpointFullfsync: pragma(db, 'checkpoint_fullfsync'),
    }).toEqual({ fullfsync: 1, checkpointFullfsync: 1 });
  });

  it('a connection on which a pragma does not take is refused', async () => {
    const { home, file } = await realmStore();
    // The connection is the real one; only the one statement does nothing.
    const result = await outcome(home, { openFile: ignoring('PRAGMA secure_delete = FAST') });
    // (1) red when a pragma is set and not read back (the open then returns a connection without
    //     it); (2) prints the outcome.
    expect(result).toEqual(
      settings(file, 'the connection setting secure_delete reads 0 after Realm set it to FAST'),
    );
  });
});

describe('#616 unit 7b — the reopen', () => {
  it("a poisoned connection is replaced by a fresh one with the open's pragmas, and the call succeeds", async () => {
    const { home } = await realmStore();
    const { opened, openFile } = recordingOpens();
    const db = await open(home, { openFile });
    // A transaction the class does not know about: the next BEGIN is told one is already open.
    opened[0]!.exec('BEGIN');
    const runs = await db.snapshot((c) =>
      Number(c.prepare('SELECT count(*) AS n FROM runs').get()?.['n']),
    );
    const fresh = opened[1];
    // (1) red when the reopen skips the pragmas (the new connection keeps SQLite's defaults: a busy
    //     timeout of 0, trusted schema on, secure delete off, no log limit), or does not reopen;
    //     (2) prints the call's answer, how many connections were opened, and the new one's values.
    expect({
      runs,
      opens: opened.length,
      pragmas: fresh && {
        busyTimeout: pragma(fresh, 'busy_timeout'),
        trustedSchema: pragma(fresh, 'trusted_schema'),
        secureDelete: pragma(fresh, 'secure_delete'),
        journalSizeLimit: pragma(fresh, 'journal_size_limit'),
      },
    }).toEqual({
      runs: 0,
      opens: 2,
      pragmas: {
        busyTimeout: BUSY_SLICE_MS,
        trustedSchema: 0,
        secureDelete: 2,
        journalSizeLimit: JOURNAL_SIZE_LIMIT_BYTES,
      },
    });
  });
});

describe('#616 unit 7b — what the open hands on and what it closes', () => {
  it("the open's busy budget reaches the store's calls", async () => {
    // Another program holds the empty store file locked for 1.5 s: longer than the budget given,
    // shorter than the class's default. It ends with ROLLBACK, which leaves the file empty (a COMMIT
    // would write a first 4096-byte page, and the open would then refuse that file for it).
    const { home, file } = homeWith((f) => writeFileSync(f, ''));
    const holder = openDatabase(file);
    connections.push(holder);
    holder.exec('BEGIN EXCLUSIVE');
    const released = new Promise<void>((resolve) =>
      setTimeout(() => {
        holder.exec('ROLLBACK');
        resolve();
      }, 1500),
    );
    let result: unknown;
    try {
      stores.push(await RealmDb.open(home, { clock, budgetMs: 300 }));
      result = 'opened';
    } catch (err) {
      result =
        err instanceof WorkflowError
          ? { code: err.code, budget: (err.details as { budget_ms?: unknown }).budget_ms }
          : { plainError: String(err) };
    }
    await released;
    // (1) red when the open does not pass its budget to the class (the open then waits with the
    //     default budget, the lock is released, and it opens); (2) prints the outcome: the code and
    //     the budget the refusal names, or "opened".
    expect(result).toEqual({ code: 'STATE_RUN_BUSY', budget: 300 });
  });

  it('a refused open closes every connection it made, at each stage that refuses', async () => {
    // One refusal from each stage: the file's checks (a text file), the setup (a switch to WAL that
    // SQLite does not make) and the connection pragmas (one that does not take).
    const textFile = homeWith((f) => writeFileSync(f, 'notes, not a database\n'.repeat(40)));
    const atChecks = counting(openDatabase);
    const checks = await outcome(textFile.home, { openFile: atChecks.openFile });
    const atSetup = counting(walAnswering('delete'));
    const setup = await outcome(join(tmp(), '.realm'), { openFile: atSetup.openFile });
    const atPragmas = counting(ignoring('PRAGMA secure_delete = FAST'));
    const pragmas = await outcome((await realmStore()).home, { openFile: atPragmas.openFile });
    const code = (r: unknown): unknown => (r as { code?: unknown }).code;
    // (1) red when a refused open does not close its connection (each refusal then leaves a file
    //     descriptor open in the process); (2) prints each refusal's code and its connections
    //     made and closed.
    expect({
      checks: { code: code(checks), ...atChecks.count },
      setup: { code: code(setup), ...atSetup.count },
      pragmas: { code: code(pragmas), ...atPragmas.count },
    }).toEqual({
      checks: { code: 'STATE_STORE_SETTINGS_REFUSED', made: 1, closed: 1 },
      setup: { code: 'STATE_STORE_SETTINGS_REFUSED', made: 1, closed: 1 },
      pragmas: { code: 'STATE_STORE_SETTINGS_REFUSED', made: 1, closed: 1 },
    });
  });
});

describe("#616 unit 7b — the mapper's guard slice", () => {
  const PHASE_STAMP = '0123456789abcdef';
  const INSERT_RUN =
    'INSERT INTO runs (id, record, run_phase, phase_version, key_hash) VALUES (?, ?, ?, ?, ?)';
  const doc = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      id: 'run-1',
      workflow_id: 'wf',
      version: 1,
      created_at: '2026-11-05T10:00:00.000Z',
      updated_at: '2026-11-05T10:00:00.000Z',
      terminal_state: false,
      run_phase: { $realm_derived: 'run_phase' },
      ...over,
    });
  /** What a write through the class ends with: `'landed'`, or the error it was refused with. */
  async function write(db: RealmDb, act: (c: DatabaseLike) => void): Promise<unknown> {
    try {
      await db.immediate(act, () => true, { takesReading: false });
      return 'landed';
    } catch (err) {
      if (err instanceof WorkflowError) {
        return {
          code: err.code,
          message: err.message,
          retryable: err.retryable,
          details: err.details,
        };
      }
      return { plain: (err as Error).message };
    }
  }

  it("each guard of the file with a typed code is refused with it; the others stay plain errors with SQLite's text", async () => {
    const { home } = await realmStore();
    const db = await open(home);
    const setup = await write(db, (c) => {
      c.prepare(INSERT_RUN).run('run-1', doc(), 'running', PHASE_STAMP, null);
      c.prepare('INSERT INTO evidence (run_id, seq, entry, entry_sha256) VALUES (?, ?, ?, ?)').run(
        'run-1',
        0,
        '{}',
        'sha-0',
      );
      c.prepare('INSERT INTO run_blobs (run_id, name, value) VALUES (?, ?, ?)').run(
        'run-1',
        'workflow_context_snapshots',
        '{}',
      );
      // A finished run, deleted as a purge deletes it (the deleting write's instant set, then cleared).
      c.prepare(INSERT_RUN).run(
        'run-2',
        doc({ id: 'run-2', terminal_state: true }),
        'completed',
        PHASE_STAMP,
        null,
      );
      c.prepare(
        'INSERT INTO write_clock (one, at) VALUES (1, ?) ON CONFLICT(one) DO UPDATE SET at = excluded.at',
      ).run(AT);
      c.prepare('DELETE FROM runs WHERE id = ?').run('run-2');
      c.prepare('UPDATE write_clock SET at = NULL').run();
    });
    const update = 'UPDATE runs SET record = ? WHERE id = ?';
    const results = {
      setup,
      versionFence: await write(db, (c) => c.prepare(update).run(doc({ version: 3 }), 'run-1')),
      identity: await write(db, (c) =>
        c.prepare(update).run(doc({ workflow_id: 'wf-2', version: 2 }), 'run-1'),
      ),
      purged: await write(db, (c) =>
        c.prepare(INSERT_RUN).run('run-2', doc({ id: 'run-2' }), 'running', PHASE_STAMP, null),
      ),
      evidence: await write(db, (c) =>
        c.prepare("UPDATE evidence SET entry = '[]' WHERE run_id = 'run-1'").run(),
      ),
      writeOnce: await write(db, (c) =>
        c.prepare("UPDATE run_blobs SET value = '[]' WHERE run_id = 'run-1'").run(),
      ),
      unmapped: await write(db, (c) =>
        c.prepare(INSERT_RUN).run('run-1', doc(), 'running', PHASE_STAMP, null),
      ),
    };
    const refused = (code: string, message: string, retryable = false) => ({
      code,
      message,
      retryable,
      details: {},
    });
    // (1) red when a row of the mapper's table is dropped (that guard's refusal leaves as a plain
    //     error), when a message is matched loosely (the unmapped guard gets a code), or when a
    //     sentence changes; (2) prints what each write ended with.
    expect(results).toEqual({
      setup: 'landed',
      versionFence: refused(
        'STATE_SNAPSHOT_MISMATCH',
        'Version conflict — run was modified by another process',
        true,
      ),
      identity: refused(
        'STATE_RUN_IDENTITY',
        "The store refused a write that would change a run's id, idempotency key, workflow or creation time.",
      ),
      purged: refused(
        'STATE_RUN_PURGED',
        'The store refused to create a run whose id was deleted earlier: a purged run id is never created again.',
      ),
      evidence: refused(
        'STATE_EVIDENCE_REWRITTEN',
        "The store refused a write that would change or remove a run's stored evidence, which is append-only.",
      ),
      writeOnce: refused(
        'STATE_WRITE_ONCE_REWRITTEN',
        'The store refused a write that would change a run field that is written once and then never changes.',
      ),
      unmapped: { plain: 'realm.db: a run with this id already exists (SQLite error 1811)' },
    });
  });

  it("a guard's text on an error that is not a constraint error is not given the guard's code", () => {
    // A SQLite error shaped as Node throws it (code, errcode, errstr), carrying a guard's message
    // with another code than SQLite's constraint family (19); no real statement makes one.
    const err = Object.assign(new Error("realm.db: a run's identity cannot change"), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 1,
      errstr: 'SQL logic error',
    });
    const mapped = mapSqliteError(err, '/home/u/.realm/realm.db');
    // (1) red when the constraint-code half of the match is dropped (the text alone gives the code);
    //     (2) prints what the error became.
    expect(
      mapped instanceof WorkflowError ? (mapped as WorkflowError).code : (mapped as Error).message,
    ).toBe("realm.db: a run's identity cannot change (SQLite error 1)");
  });

  it("the version fence's refusal reads as core's version conflict", async () => {
    const { home } = await realmStore();
    const db = await open(home);
    await write(db, (c) => c.prepare(INSERT_RUN).run('run-1', doc(), 'running', PHASE_STAMP, null));
    let err: unknown;
    try {
      await db.immediate(
        (c) =>
          c.prepare('UPDATE runs SET record = ? WHERE id = ?').run(doc({ version: 3 }), 'run-1'),
        () => true,
        { takesReading: false },
      );
    } catch (e) {
      err = e;
    }
    const core = versionConflictError('run-1', 2, 3);
    const fields = (e: WorkflowError) => ({
      message: e.message,
      code: e.code,
      category: e.category,
      agentAction: e.agentAction,
      retryable: e.retryable,
    });
    // (1) red when the mapped sentence, its code, category, action or retryability drifts from
    //     core's version conflict; (2) prints both.
    expect(err instanceof WorkflowError ? fields(err) : String(err)).toEqual(fields(core));
  });

  it('every guard message in the schema is either mapped to a code or listed as unmapped', () => {
    // The ten guards whose refusal stays a plain error, by design (SEAMS, 7b's rulings, point 5).
    const UNMAPPED = [
      'realm.db: the tombstone record is append-only',
      "realm.db: the store's meta row cannot be replaced or deleted",
      'realm.db: a row number must be 1 or more',
      "realm.db: the store's meta row holds whole numbers and timestamps of one shape",
      'realm.db: evidence and fields must be valid JSON',
      'realm.db: a run with this id already exists',
      'realm.db: a run record must be valid JSON, carry its own id, and pair its key hash with its key',
      "realm.db: the store's recorded horizon cannot move backwards",
      'realm.db: a run that is not finished cannot be deleted',
      'realm.db: a live run cannot be recorded as purged',
    ];
    const inSchema = new Set<string>();
    for (const statement of REALM_STORE_SCHEMA) {
      for (const m of statement.matchAll(/RAISE\(ABORT, '((?:[^']|'')*)'\)/g)) {
        inSchema.add(m[1]!.replaceAll("''", "'"));
      }
    }
    // (1) red when a guard is added to the schema with a message that is neither mapped nor listed,
    //     when a mapped or listed message leaves the schema, or when the scan finds nothing; (2)
    //     prints both sets, sorted.
    expect([...inSchema].sort()).toEqual([...MAPPED_GUARD_MESSAGES, ...UNMAPPED].sort());
  });
});
