// open-file.ts — issue #616 PR-1a unit 7b (design d4-frozen-r3 §2 "The one open", steps 4-6, and
// "Initialising a fresh file"): THE OPEN. `RealmDb.open` (the seam) runs this module's
// `openRealmDb`, and it is the only code that opens a connection on `realm.db`. In this order:
//   1. the loader's version check (it opens only an in-memory database);
//   2. the filesystem gate (unit 5), which judges a home that does not exist yet by the folder above;
//   3. the home's preparation (unit 7a): the folder, the old-store guard, the fences, and an absent
//      `realm.db` created empty and owner-only. Nothing before this step writes anything;
//   4. `realm.db` must be a regular file, judged by `lstat` before SQLite opens anything (SQLite
//      itself creates the target of a dangling link when it opens one); then the operating system is
//      asked whether Realm may write it (`access`, which reads and writes nothing): SQLite would open
//      a file it cannot write read-only, and the first write would fail after the open said ready;
//   5. the file's checks. Its application id, schema version, schema object count and three
//      persistent settings are read by ONE statement in autocommit: one statement is one snapshot, so
//      another first opener's COMMIT cannot fall between two of them, and nothing gated on the
//      version reads the file before its application id is judged. An uninitialised file
//      (application id 0, user_version 0, no schema object) is set up (below) and then checked like
//      any other. Otherwise, in this order: the application id; the version (lower: older, higher:
//      newer); ONLY at an equal version the stored schema, in a read transaction (so a file one
//      release behind reads as older, never as tampered) — or, for the maintenance entry's older
//      file (`acceptOlderSchema`, unit c6), against that older version's own schema when this Realm
//      holds it — and only when it matches, the meta row (a
//      dropped or renamed meta table is tampering, not a missing row); then the journal mode,
//      `auto_vacuum` and the page size the file recorded, every difference named at once. A file
//      that is not SQLite or is damaged is refused too. A refused file is never changed or replaced;
//   6. the connection pragmas, each through `autocommit` and read back;
//   7. the phase derivation's fingerprint, computed once per process by core.
// The first-open setup: in autocommit, before anything is written, the page count, page size and
// `auto_vacuum` by one statement. A file with no page gets Realm's `page_size` and `auto_vacuum`. A
// file that already has pages (another program wrote to the empty file; another Realm opener's own
// switch to WAL makes one with Realm's values) is refused, with nothing written, when either value
// is not Realm's: SQLite fixes both once the file has a page, only a VACUUM changes them, and Realm
// does not change a file by itself. Then `journal_mode = WAL` with its answer checked (inside a
// transaction SQLite ignores all three); then in `BEGIN IMMEDIATE` the uninitialised test again, the
// schema, the application id, `user_version` and the store's meta row, its time from the home's
// clock. A second first opener waits at its `BEGIN IMMEDIATE`, finds the schema and does nothing.
//
// The maintenance entry's check (`check`, PR-2c c8a1; DELTAS 50 Q1, 52 (0)) runs the same open and
// writes nothing: the connection and any reopen are read-only (`SQLITE_OPEN_READONLY`, so no close
// copies the WAL into the file); step 3 only looks (the folder's writability and the old-store guard;
// no folder, fence or file is made); an uninitialised file is not set up, so it is refused as a file
// that is not a Realm store (its application id). Every other refusal is the same.
//
// The reopen `RealmDb` needs after a poisoned connection opens the same file again and applies the
// same pragmas, read back. It runs inside a call of the class (the lock is held, the busy wait is
// around it), so it applies them directly: the class is synchronous there.
//
// This module and `connection.ts` import each other; neither reads the other's bindings at the top
// level, so either may be loaded first.
import { accessSync, constants, lstatSync } from 'node:fs';
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
import {
  BUSY_SLICE_MS,
  mapSqliteError,
  readOnlyError,
  RealmDb,
  versionNewerError,
} from './connection.js';
import { loadSqlite, openDatabase, type DatabaseLike } from './driver.js';
import { assertLocalFilesystem, SYSTEM_PROBE, type FilesystemProbe } from './filesystem-gate.js';
import { prepareHome, systemErrorText } from './home.js';
import { storedSchemaDifference, type SchemaDifference } from './schema-ladder.js';

/** The options of the open: the home's clock, and the busy budget of every call on the store. */
export interface OpenOptions {
  readonly clock: Clock;
  /** How long a call waits for a busy store, in milliseconds; the class's default if left out. */
  readonly budgetMs?: number;
  /**
   * The maintenance entry's parameter (`maintenance.ts`; DELTAS 41 (2)): a file at a schema version
   * BELOW this Realm's passes the version rule when this Realm holds that version's schema, and its
   * stored schema is compared with that version's. A version below the oldest held, and a newer one,
   * stay refused. Every other open leaves it out and refuses an older file.
   */
  readonly acceptOlderSchema?: true;
  /**
   * The maintenance entry opened for `'check'` (`maintenance.ts`; DELTAS 50 Q1, 52 (0)): the verb is
   * the switch. The connection and any reopen are read-only, the home is looked at but nothing is
   * made in it, and an uninitialised file is refused, never set up (see the module comment).
   */
  readonly check?: true;
}

/**
 * What a test replaces, package-internal (the package's entry does not export it). Each defaults to
 * what production uses.
 */
export interface OpenSeams {
  /** The loader's version check; the one loader's by default. */
  readonly loadSqlite?: () => { version: string };
  /** Opens a connection on the store file (read-only for the check); the one loader's by default. */
  readonly openFile?: (path: string, options?: { readonly readOnly: true }) => DatabaseLike;
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

/**
 * The store file is not one this Realm can use; nothing about it was changed. `holdsNoStore`: the
 * file has no store in it yet (the setup refused it before writing), so removing it is the way on.
 */
function settingsRefused(
  path: string,
  differences: readonly string[],
  holdsNoStore = false,
): WorkflowError {
  const lead = holdsNoStore ? 'it holds no store yet, but ' : '';
  const remedy = holdsNoStore ? 'Remove it and Realm makes a new one. ' : '';
  return new WorkflowError(
    `The store file ${path} is not a Realm store this Realm can use: ${lead}${differences.join('; ')}. ` +
      `${remedy}Realm does not change or replace a store file by itself.`,
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

/**
 * Refuses a store file the operating system does not let Realm write, in its own words (unit 7a's
 * sentence). `access` reads and writes nothing; SQLite would open such a file read-only.
 */
function assertWritable(path: string): void {
  try {
    accessSync(path, constants.W_OK);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).errno;
    if (typeof errno === 'number') throw readOnlyError(path, systemErrorText(errno));
    throw err;
  }
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
  versions: StoreSchemaVersions,
  acceptOlderSchema: boolean,
  check = false,
): Promise<'uninitialised' | 'ready'> {
  try {
    const header = await db.autocommit((c) => readHeader(c));
    // The check sets nothing up: an uninitialised file meets the application id's refusal below.
    if (isUninitialised(header) && !check) return 'uninitialised';
    if (header.applicationId !== REALM_STORE_APPLICATION_ID) {
      throw settingsRefused(path, [
        `its application id is ${header.applicationId}, not Realm's ${REALM_STORE_APPLICATION_ID}`,
      ]);
    }
    // The version whose schema the file is held to: this Realm's, or, for the maintenance entry
    // (DELTAS 41 (2)), an older file's own, when this Realm holds that version's schema.
    let version = realm;
    let expected = schema;
    if (header.version < realm) {
      const older = acceptOlderSchema ? versions.get(header.version)?.schema : undefined;
      if (older === undefined) throw versionOlder(header.version, realm);
      version = header.version;
      expected = older;
    }
    if (header.version > realm) throw versionNewerError(header.version, realm);
    // The meta row is read only when the schema matches: a dropped or renamed meta table (or its
    // `page_size` column) is then reported as the tampering it is, never as SQLite's own error. Every
    // version's schema holds version 1's, so the meta row and the settings are judged alike for each.
    const stored = await db.snapshot((c) => {
      const difference = storedSchemaDifference(c, expected);
      const { missing, extra, changed } = difference;
      const tampered = missing.length + extra.length + changed.length > 0;
      const recorded = tampered
        ? undefined
        : c.prepare('SELECT page_size FROM store_meta WHERE one = 1').get()?.['page_size'];
      return { difference, tampered, recorded };
    });
    if (stored.tampered) throw schemaTampered(path, version, stored.difference);
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

/** What the setup reads of a file before it writes anything, by one statement. */
const FIRST_PAGES = `SELECT (SELECT page_count FROM pragma_page_count) AS page_count,
  (SELECT auto_vacuum FROM pragma_auto_vacuum) AS auto_vacuum,
  (SELECT page_size FROM pragma_page_size) AS page_size`;

/** The first-open setup (see the module comment). */
async function setUp(
  db: RealmDb,
  path: string,
  realm: number,
  schema: readonly string[],
): Promise<void> {
  await db.autocommit((c) => {
    const row = c.prepare(FIRST_PAGES).get() ?? {};
    if (Number(row['page_count']) === 0) {
      // Both take effect at the first write; SQLite ignores them once the file has a page.
      c.exec(`PRAGMA page_size = ${REALM_STORE_PAGE_SIZE}`);
      c.exec('PRAGMA auto_vacuum = INCREMENTAL');
      return;
    }
    // The file already has pages, and no store: refused before anything is written (the switch to
    // WAL below is itself a write to a file in rollback-journal mode) when either value is not
    // Realm's. With Realm's two values (another Realm opener's own switch to WAL) the setup goes on.
    const differences: string[] = [];
    const autoVacuum = Number(row['auto_vacuum']);
    if (autoVacuum !== 2) differences.push(`its auto_vacuum is ${autoVacuum}, not 2 (incremental)`);
    const pageSize = Number(row['page_size']);
    if (pageSize !== REALM_STORE_PAGE_SIZE) {
      differences.push(
        `its page size is ${pageSize} bytes, not the ${REALM_STORE_PAGE_SIZE} Realm needs`,
      );
    }
    if (differences.length > 0) throw settingsRefused(path, differences, true);
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
function connect(
  path: string,
  openFile: (path: string, options?: { readonly readOnly: true }) => DatabaseLike,
  readOnly: boolean,
): DatabaseLike {
  try {
    return readOnly ? openFile(path, { readOnly: true }) : openFile(path);
  } catch (err) {
    throw mapSqliteError(err, path);
  }
}

/** The one loader's open of the store file (the source law that keeps one opener names this). */
function openFileThroughTheLoader(
  path: string,
  options?: { readonly readOnly: true },
): DatabaseLike {
  return openDatabase(path, options);
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
  const check = options.check === true;
  const path = prepareHome(home, check);
  const kind = notAFile(path);
  if (kind !== undefined) throw settingsRefused(path, [kind]);
  assertWritable(path);

  const realm = seams.schemaVersion ?? REALM_STORE_SCHEMA_VERSION;
  const versions = seams.versions ?? REALM_STORE_VERSIONS;
  const schema = versions.get(realm)?.schema;
  const older = options.acceptOlderSchema === true;
  if (schema === undefined) {
    throw new Error(
      `Schema version ${realm} is not one this Realm knows: the open has no schema for it.`,
    );
  }
  const openFile = seams.openFile ?? openFileThroughTheLoader;
  const pragmas = connectionPragmas(probe.platform);
  const reopen = (): DatabaseLike => {
    const connection = connect(path, openFile, check);
    try {
      for (const pragma of pragmas) applyPragma(connection, path, pragma);
    } catch (err) {
      connection.close();
      throw err;
    }
    return connection;
  };
  const db = new RealmDb(connect(path, openFile, check), {
    path,
    clock: options.clock,
    reopen,
    schemaVersion: realm,
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
  });
  try {
    if ((await checkFile(db, path, realm, schema, versions, older, check)) === 'uninitialised') {
      await setUp(db, path, realm, schema);
      if ((await checkFile(db, path, realm, schema, versions, older)) !== 'ready') {
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
