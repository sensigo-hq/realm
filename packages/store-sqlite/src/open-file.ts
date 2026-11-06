// open-file.ts — issue #616 PR-1a unit 7b (design d4-frozen-r3 §2 "The one open", steps 4-6, and
// "Initialising a fresh file"): THE OPEN. `RealmDb.open` (the seam) runs this module's
// `openRealmDb`, and it is the only code that opens a connection on `realm.db`. In this order:
//   1. the loader's version check (it opens only an in-memory database);
//   2. the filesystem gate (unit 5), which judges a home that does not exist yet by the folder above;
//   3. the home's preparation (unit 7a): the folder, the old-store guard, the fences, and an absent
//      `realm.db` created empty and owner-only. Nothing before this step writes anything;
//   4. `realm.db` must be a regular file, judged by `lstat` before SQLite opens anything (SQLite
//      itself creates the target of a dangling link when it opens one);
//   5. the file's checks. Its application id, schema version, schema object count and three
//      persistent settings are read by ONE statement in autocommit: one statement is one snapshot, so
//      another first opener's COMMIT cannot fall between two of them, and nothing gated on the
//      version reads the file before its application id is judged. An uninitialised file
//      (application id 0, user_version 0, no schema object) is set up (below) and then checked like
//      any other. Otherwise, in this order: the application id; the version (lower: older, higher:
//      newer); ONLY at an equal version the stored schema and the meta row, in a read transaction
//      (so a file one release behind reads as older, never as tampered); then the journal mode,
//      `auto_vacuum` and the page size the file recorded, every difference named at once. A file
//      that is not SQLite or is damaged is refused too. A refused file is never changed or replaced;
//   6. the connection pragmas, each through `autocommit` and read back;
//   7. the phase derivation's fingerprint, computed once per process by core.
// The first-open setup: in autocommit, `page_size` and `auto_vacuum` while the file has no page, then
// `journal_mode = WAL` with its answer checked (inside a transaction SQLite ignores all three); then
// in `BEGIN IMMEDIATE` the uninitialised test again, the schema, the application id, `user_version`
// and the store's meta row, its time from the home's clock. A second first opener waits at its
// `BEGIN IMMEDIATE`, finds the schema and does nothing.
//
// The reopen `RealmDb` needs after a poisoned connection opens the same file again and applies the
// same pragmas, read back. It runs inside a call of the class (the lock is held, the busy wait is
// around it), so it applies them directly: the class is synchronous there.
//
// This module and `connection.ts` import each other; neither reads the other's bindings at the top
// level, so either may be loaded first.
import { lstatSync } from 'node:fs';
import {
  REALM_STORE_APPLICATION_ID,
  REALM_STORE_PAGE_SIZE,
  REALM_STORE_SCHEMA_VERSION,
  REALM_STORE_VERSIONS,
  runPhaseDerivationFingerprint,
  WorkflowError,
  type Clock,
  type StoreSchemaVersions,
} from '@sensigo/realm';
import { BUSY_SLICE_MS, mapSqliteError, RealmDb, versionNewerError } from './connection.js';
import { loadSqlite, openDatabase, type DatabaseLike } from './driver.js';
import { assertLocalFilesystem, SYSTEM_PROBE, type FilesystemProbe } from './filesystem-gate.js';
import { prepareHome } from './home.js';
import { storedSchemaDifference, type SchemaDifference } from './schema-ladder.js';

/** The options of the open: the home's clock, and the busy budget of every call on the store. */
export interface OpenOptions {
  readonly clock: Clock;
  /** How long a call waits for a busy store, in milliseconds; the class's default if left out. */
  readonly budgetMs?: number;
}

/**
 * What a test replaces, package-internal (the package's entry does not export it). Each defaults to
 * what production uses.
 */
export interface OpenSeams {
  /** The loader's version check; the one loader's by default. */
  readonly loadSqlite?: () => { version: string };
  /** Opens a connection on the store file; the one loader's by default. */
  readonly openFile?: (path: string) => DatabaseLike;
  /** What the filesystem gate asks the system; this machine by default. Its platform also decides
   *  the macOS pragmas. */
  readonly probe?: FilesystemProbe;
  /** The schema version this Realm writes; core's by default. */
  readonly schemaVersion?: number;
  /** The schema versions this Realm knows; core's by default. */
  readonly versions?: StoreSchemaVersions;
}

/** `journal_size_limit`: the most the write-ahead log keeps on disk after a checkpoint (64 MiB). */
export const JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

/** A connection pragma: the value set, and what reading it back must give. */
interface ConnectionPragma {
  readonly name: string;
  readonly value: string;
  readonly expected: number;
}

/** The connection pragmas the open sets, in order; on macOS also the two full-fsync pragmas. */
function connectionPragmas(platform: string): readonly ConnectionPragma[] {
  const pragmas: ConnectionPragma[] = [
    { name: 'busy_timeout', value: String(BUSY_SLICE_MS), expected: BUSY_SLICE_MS },
    { name: 'synchronous', value: 'FULL', expected: 2 },
    { name: 'foreign_keys', value: 'ON', expected: 1 },
    { name: 'trusted_schema', value: 'OFF', expected: 0 },
    { name: 'secure_delete', value: 'FAST', expected: 2 },
    {
      name: 'journal_size_limit',
      value: String(JOURNAL_SIZE_LIMIT_BYTES),
      expected: JOURNAL_SIZE_LIMIT_BYTES,
    },
  ];
  if (platform === 'darwin') {
    pragmas.push(
      { name: 'fullfsync', value: 'ON', expected: 1 },
      { name: 'checkpoint_fullfsync', value: 'ON', expected: 1 },
    );
  }
  return pragmas;
}

/** The store file is not one this Realm can use; nothing about it was changed. */
function settingsRefused(path: string, differences: readonly string[]): WorkflowError {
  return new WorkflowError(
    `The store file ${path} is not a Realm store this Realm can use: ${differences.join('; ')}. ` +
      'Realm does not change or replace a store file by itself.',
    {
      code: 'STATE_STORE_SETTINGS_REFUSED',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { path, differences: [...differences] },
    },
  );
}

function versionOlder(file: number, realm: number): WorkflowError {
  return new WorkflowError(
    `This store's file is at schema version ${file}; this Realm writes version ${realm}. ` +
      'Run `realm db migrate` with Realm stopped to upgrade it.',
    {
      code: 'STATE_STORE_VERSION_OLDER',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { file, realm },
    },
  );
}

function schemaTampered(
  path: string,
  version: number,
  difference: SchemaDifference,
): WorkflowError {
  return new WorkflowError(
    `The tables in ${path} do not match what this Realm writes for schema version ${version}. ` +
      'This usually means someone changed the store outside Realm. Realm will not use it; restore ' +
      'a backup made before the change.',
    {
      code: 'STATE_STORE_SCHEMA_TAMPERED',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: {
        path,
        version,
        missing: [...difference.missing],
        extra: [...difference.extra],
        changed: [...difference.changed],
      },
    },
  );
}

/** What `lstat` shows at the store's name, when it is not a regular file. */
function notAFile(path: string): string | undefined {
  const entry = lstatSync(path);
  if (entry.isFile()) return undefined;
  if (entry.isDirectory()) return 'it is a directory';
  if (entry.isSymbolicLink()) {
    return 'it is a symbolic link; link the home folder instead, never the store file';
  }
  return 'it is not a regular file (a named pipe, a socket or a device)';
}

/** SQLite's answer when the file is not a database (26) or is damaged (11), as a refusal. */
function notADatabase(err: unknown, path: string): WorkflowError | undefined {
  const errcode = (err as { errcode?: unknown }).errcode;
  if (typeof errcode !== 'number') return undefined;
  if ((errcode & 0xff) === 26) {
    return settingsRefused(path, ['it is not a SQLite database (SQLite: file is not a database)']);
  }
  if ((errcode & 0xff) === 11) {
    return settingsRefused(path, ['it is damaged (SQLite: database disk image is malformed)']);
  }
  return undefined;
}

/** A pragma's value as SQLite reads it back (the first column: `busy_timeout` names it `timeout`). */
function pragmaValue(db: DatabaseLike, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return row === undefined ? undefined : Object.values(row)[0];
}

/** Sets one connection pragma and reads it back; a value that did not stick is refused. */
function applyPragma(db: DatabaseLike, path: string, pragma: ConnectionPragma): void {
  db.exec(`PRAGMA ${pragma.name} = ${pragma.value}`);
  const got = pragmaValue(db, pragma.name);
  if (Number(got) !== pragma.expected) {
    throw settingsRefused(path, [
      `the connection setting ${pragma.name} reads ${String(got)} after Realm set it to ${pragma.value}`,
    ]);
  }
}

/** What the open reads of a file first, by one statement (one snapshot). */
interface FileHeader {
  readonly applicationId: number;
  readonly version: number;
  /** How many rows `sqlite_master` holds. */
  readonly objects: number;
  readonly journalMode: string;
  readonly autoVacuum: number;
  readonly pageSize: number;
}

const HEADER = `SELECT (SELECT application_id FROM pragma_application_id) AS application_id,
  (SELECT user_version FROM pragma_user_version) AS user_version,
  (SELECT count(*) FROM sqlite_master) AS objects,
  (SELECT journal_mode FROM pragma_journal_mode) AS journal_mode,
  (SELECT auto_vacuum FROM pragma_auto_vacuum) AS auto_vacuum,
  (SELECT page_size FROM pragma_page_size) AS page_size`;

function readHeader(db: DatabaseLike): FileHeader {
  const row = db.prepare(HEADER).get() ?? {};
  return {
    applicationId: Number(row['application_id']),
    version: Number(row['user_version']),
    objects: Number(row['objects']),
    journalMode: String(row['journal_mode']),
    autoVacuum: Number(row['auto_vacuum']),
    pageSize: Number(row['page_size']),
  };
}

/** The design's uninitialised file: application id 0, `user_version` 0 and no schema object. */
function isUninitialised(header: FileHeader): boolean {
  return header.applicationId === 0 && header.version === 0 && header.objects === 0;
}

/** The three persistent settings that differ from Realm's, each as its clause. */
function settingsDifferences(header: FileHeader, recordedPageSize: number): string[] {
  const differences: string[] = [];
  if (header.journalMode !== 'wal') {
    differences.push(`its journal mode is ${header.journalMode}, not wal`);
  }
  if (header.autoVacuum !== 2) {
    differences.push(`its auto_vacuum is ${header.autoVacuum}, not 2 (incremental)`);
  }
  if (header.pageSize !== recordedPageSize) {
    differences.push(
      `its page size is ${header.pageSize} bytes, not the ${recordedPageSize} it recorded when it was created`,
    );
  }
  return differences;
}

/**
 * The file's checks (see the module comment): `'uninitialised'` for a file to set up, `'ready'` for a
 * file this Realm can use, or the refusal.
 */
async function checkFile(
  db: RealmDb,
  path: string,
  realm: number,
  schema: readonly string[],
): Promise<'uninitialised' | 'ready'> {
  try {
    const header = await db.autocommit((c) => readHeader(c));
    if (isUninitialised(header)) return 'uninitialised';
    if (header.applicationId !== REALM_STORE_APPLICATION_ID) {
      throw settingsRefused(path, [
        `its application id is ${header.applicationId}, not Realm's ${REALM_STORE_APPLICATION_ID}`,
      ]);
    }
    if (header.version < realm) throw versionOlder(header.version, realm);
    if (header.version > realm) throw versionNewerError(header.version, realm);
    const stored = await db.snapshot((c) => ({
      difference: storedSchemaDifference(c, schema),
      recorded: c.prepare('SELECT page_size FROM store_meta WHERE one = 1').get()?.['page_size'],
    }));
    const { missing, extra, changed } = stored.difference;
    if (missing.length + extra.length + changed.length > 0) {
      throw schemaTampered(path, realm, stored.difference);
    }
    if (stored.recorded === undefined) throw settingsRefused(path, ['its meta row is missing']);
    const differences = settingsDifferences(header, Number(stored.recorded));
    if (differences.length > 0) throw settingsRefused(path, differences);
    return 'ready';
  } catch (err) {
    throw notADatabase(err, path) ?? err;
  }
}

/** The store's meta row at creation (design §3, unit 6b): counters at 0, the horizon at creation. */
const META_ROW =
  'INSERT INTO store_meta (one, page_size, commit_epoch, created_at, tomb_seq, tombstones_through_seq, tombstones_since) VALUES (1, ?, 0, ?, 0, 0, ?)';

/** The first-open setup (see the module comment). */
async function setUp(
  db: RealmDb,
  path: string,
  realm: number,
  schema: readonly string[],
): Promise<void> {
  await db.autocommit((c) => {
    // Both only while the file has no page; SQLite would ignore them later anyway.
    if (Number(pragmaValue(c, 'page_count')) === 0) {
      c.exec(`PRAGMA page_size = ${REALM_STORE_PAGE_SIZE}`);
      c.exec('PRAGMA auto_vacuum = INCREMENTAL');
    }
  });
  await db.autocommit((c) => {
    const mode = String(c.prepare('PRAGMA journal_mode = WAL').get()?.['journal_mode']);
    if (mode !== 'wal') {
      throw settingsRefused(path, [`SQLite left its journal mode at ${mode} when Realm set wal`]);
    }
  });
  await db.immediate(
    (c, reading) => {
      // Again under the write lock: another first opener may have set the file up meanwhile.
      if (!isUninitialised(readHeader(c))) return false;
      for (const statement of schema) c.exec(statement);
      c.exec(`PRAGMA application_id = ${REALM_STORE_APPLICATION_ID}`);
      c.exec(`PRAGMA user_version = ${realm}`);
      const at = reading.toISOString();
      c.prepare(META_ROW).run(REALM_STORE_PAGE_SIZE, at, at);
      return true;
    },
    // The setup landed when the file carries Realm's id, this version and the meta row.
    (c, created) =>
      !created ||
      (Number(pragmaValue(c, 'application_id')) === REALM_STORE_APPLICATION_ID &&
        Number(pragmaValue(c, 'user_version')) === realm &&
        c.prepare('SELECT 1 AS one FROM store_meta').get() !== undefined),
  );
}

/** Opens a connection on the store file; a SQLite error leaves mapped (14: the read-only refusal). */
function connect(path: string, openFile: (path: string) => DatabaseLike): DatabaseLike {
  try {
    return openFile(path);
  } catch (err) {
    throw mapSqliteError(err, path);
  }
}

/** The one loader's open of the store file (the source law that keeps one opener names this). */
function openFileThroughTheLoader(path: string): DatabaseLike {
  return openDatabase(path);
}

/** The open (see the module comment); `RealmDb.open` runs it. */
export async function openRealmDb(
  home: string,
  options: OpenOptions,
  seams: OpenSeams = {},
): Promise<RealmDb> {
  (seams.loadSqlite ?? loadSqlite)();
  const probe = seams.probe ?? SYSTEM_PROBE;
  assertLocalFilesystem(home, probe);
  const path = prepareHome(home);
  const kind = notAFile(path);
  if (kind !== undefined) throw settingsRefused(path, [kind]);

  const realm = seams.schemaVersion ?? REALM_STORE_SCHEMA_VERSION;
  const schema = (seams.versions ?? REALM_STORE_VERSIONS).get(realm)?.schema;
  if (schema === undefined) {
    throw new Error(
      `Schema version ${realm} is not one this Realm knows: the open has no schema for it.`,
    );
  }
  const openFile = seams.openFile ?? openFileThroughTheLoader;
  const pragmas = connectionPragmas(probe.platform);
  const reopen = (): DatabaseLike => {
    const connection = connect(path, openFile);
    try {
      for (const pragma of pragmas) applyPragma(connection, path, pragma);
    } catch (err) {
      connection.close();
      throw err;
    }
    return connection;
  };
  const db = new RealmDb(connect(path, openFile), {
    path,
    clock: options.clock,
    reopen,
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
  });
  try {
    if ((await checkFile(db, path, realm, schema)) === 'uninitialised') {
      await setUp(db, path, realm, schema);
      if ((await checkFile(db, path, realm, schema)) !== 'ready') {
        throw new Error(
          `The store file ${path} is still uninitialised after its setup. This is a bug in the store.`,
        );
      }
    }
    for (const pragma of pragmas) await db.autocommit((c) => applyPragma(c, path, pragma));
    runPhaseDerivationFingerprint();
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
