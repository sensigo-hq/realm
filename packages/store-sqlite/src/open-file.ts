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
// The maintenance entry's check (`openForCheck`, PR-2c c8a1 and c8a3; DELTAS 50 Q1, 52) runs the same
// checks and writes nothing: the connection and any reopen are read-only (`SQLITE_OPEN_READONLY`, so
// no close copies the WAL into the file); step 3 only looks (whether the home can be searched, and the
// old-store guard; no folder, fence or file is made); nothing is set up. It still refuses what makes
// reading impossible or wrong: the floor, a network filesystem, a home folder it cannot search, the
// old-store guard, and a `realm.db` that is not a regular file. Every
// other refusal of steps 4-6 becomes an outcome, and the checks go on (c8a3): whether Realm may write
// the file and its folder (asked whenever the file exists); SQLite's own error at the connection or
// the header read, taken before the store maps it (26 and 11 there: the header cannot be read); then
// step 5's checks, each kept, an older file held to its own version's schema (`acceptOlderSchema` is
// on), the meta row read whenever the meta table is intact; then the connection pragmas. The check
// (`store-check.ts`) composes each outcome's words and the checks it stops.
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
  isBusy,
  mapSqliteError,
  readOnlyError,
  RealmDb,
  versionNewerError,
} from './connection.js';
import { loadSqlite, openDatabase, type DatabaseLike } from './driver.js';
import { assertLocalFilesystem, SYSTEM_PROBE, type FilesystemProbe } from './filesystem-gate.js';
import { homeIsWritable, prepareHome, systemErrorText } from './home.js';
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
}

/**
 * What the check's open found wrong with the file, each with what the check's words need (c8a3;
 * `store-check.ts` composes them). The `kind` is the finding's code.
 */
export type FileOutcome =
  /** SQLite's own error at the connection or the header read, before the store maps it. */
  | { readonly kind: 'open_failed'; readonly errcode: number; readonly errstr: string }
  /** 26 or 11 at the header read: the header or the schema cannot be read. */
  | { readonly kind: 'header_damaged' }
  | { readonly kind: 'newer_version'; readonly file: number; readonly realm: number }
  /** A version this Realm holds the schema of; the schema is checked against it. */
  | { readonly kind: 'older_version'; readonly file: number; readonly realm: number }
  /** 0, or any version this Realm holds no schema of: no schema is checked. */
  | { readonly kind: 'version_unknown'; readonly file: number }
  | {
      readonly kind: 'schema_differs';
      /** The version whose schema the file was compared with. */
      readonly version: number;
      readonly difference: SchemaDifference;
      /** The meta table is missing or changed, so its row was not read. */
      readonly metaTable: boolean;
    }
  /** One setting: its name, the value found and the value Realm needs, in words. */
  | {
      readonly kind: 'settings_differ';
      readonly setting: string;
      readonly found: string;
      readonly expected: string;
    }
  /** The operating system does not let Realm write the file or its folder. */
  | { readonly kind: 'not_writable' };

/** The options of the check's open: the home's clock, and the busy budget of every read. */
export interface CheckOpenOptions {
  readonly clock: Clock;
  readonly budgetMs?: number;
}

/** What the check's open returns (c8a3): the connection, when the file could be read, and its outcomes. */
export interface CheckedFile {
  /** The read-only connection; absent when the file could not be read (`open_failed`, `header_damaged`). */
  readonly db: RealmDb | undefined;
  /** Every outcome, in the order the checks ran (`writable` first); empty when the file passed every check. */
  readonly outcomes: readonly FileOutcome[];
  /** The file's `user_version`; absent when its header could not be read. */
  readonly schemaVersion: number | undefined;
  /** The newest schema version this Realm reads. */
  readonly readsUpTo: number;
  /**
   * Whether a caller other than `check()` may read the store through `db` (MA 3's ruling, DELTAS 56):
   * true exactly when the file is at this Realm's schema version, its schema is this version's, and
   * the connection's version ceiling is this Realm's. Set here, in the open, once; no caller keeps
   * its own list of codes. `not_writable` and `settings_differ` alone leave it true.
   */
  readonly usable: boolean;
  /**
   * When `usable` is false: the code of the first outcome, in the outcomes' order, that made it false
   * (never `not_writable`), for a caller to pass on. Absent when `usable` is true.
   */
  readonly blockedBy?: FileOutcome['kind'];
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
 * Whether the operating system lets Realm write the store file: `undefined` when it does, else its
 * own words. `access` reads and writes nothing; SQLite would open such a file read-only.
 */
function writeRefusal(path: string): string | undefined {
  try {
    accessSync(path, constants.W_OK);
    return undefined;
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).errno;
    if (typeof errno === 'number') return systemErrorText(errno);
    throw err;
  }
}

/** Refuses a store file the operating system does not let Realm write (unit 7a's sentence). */
function assertWritable(path: string): void {
  const reason = writeRefusal(path);
  if (reason !== undefined) throw readOnlyError(path, reason);
}

/** SQLite's own code and words of an error, before the store maps them; `undefined` for any other error. */
function sqliteFailure(err: unknown): { errcode: number; errstr: string } | undefined {
  const e = err as { code?: unknown; errcode?: unknown; errstr?: unknown; message?: unknown };
  if (e.code !== 'ERR_SQLITE_ERROR' || typeof e.errcode !== 'number') return undefined;
  const errstr = typeof e.errstr === 'string' ? e.errstr : String(e.message);
  return { errcode: e.errcode, errstr };
}

/** The check's outcome of SQLite's error at the connection or the header read (c8a3). */
function unreadOutcome(failure: { errcode: number; errstr: string }): FileOutcome {
  const primary = failure.errcode & 0xff;
  return primary === 26 || primary === 11
    ? { kind: 'header_damaged' }
    : { kind: 'open_failed', ...failure };
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

/** A persistent setting that differs from Realm's: the refusal's clause, and the check's words. */
interface SettingDifference {
  readonly clause: string;
  readonly setting: string;
  readonly found: string;
  readonly expected: string;
}

/**
 * The persistent settings that differ from Realm's. The page size is compared with the one the meta
 * row recorded, so only when it was read (`recordedPageSize`; the check reads on without it).
 */
function settingsDifferences(
  header: FileHeader,
  recordedPageSize: number | undefined,
): SettingDifference[] {
  const differences: SettingDifference[] = [];
  if (header.journalMode !== 'wal') {
    differences.push({
      clause: `its journal mode is ${header.journalMode}, not wal`,
      setting: 'journal_mode',
      found: header.journalMode,
      expected: 'wal',
    });
  }
  if (header.autoVacuum !== 2) {
    differences.push({
      clause: `its auto_vacuum is ${header.autoVacuum}, not 2 (incremental)`,
      setting: 'auto_vacuum',
      found: String(header.autoVacuum),
      expected: '2',
    });
  }
  if (recordedPageSize !== undefined && header.pageSize !== recordedPageSize) {
    differences.push({
      clause: `its page size is ${header.pageSize} bytes, not the ${recordedPageSize} it recorded when it was created`,
      setting: 'page_size',
      found: String(header.pageSize),
      expected: String(recordedPageSize),
    });
  }
  return differences;
}

/** The meta table's key in a schema difference (`schema-ladder.ts`: type and name). */
const META_TABLE = 'table store_meta';

/** The meta row as a setting, and as the `part` of `settings` the check could not run without it. */
export const META_ROW_PART = 'meta row';

/**
 * The check's schema read met SQLite's damaged-file error (26, 11): thrown out of the read
 * transaction so that it rolls back. Returning from it instead would COMMIT, and SQLite reports the
 * damage again there, as an error of the whole read.
 */
class SchemaUnreadable extends Error {}

/** SQLite's error says the file is not a database (26) or is damaged (11, extended codes included). */
function isDamaged(err: unknown): boolean {
  const errcode = (err as { errcode?: unknown }).errcode;
  return typeof errcode === 'number' && [26, 11].includes(errcode & 0xff);
}

/**
 * The file's checks (see the module comment): `'uninitialised'` for a file to set up, `'ready'` for a
 * file this Realm can use, or the refusal. With `report` (the check, c8a3) each refusal is kept there
 * as its outcome instead and the checks go on; `'unread'` when the header or the schema could not be
 * read. `matches`: the file is at this Realm's version and its schema is this version's.
 */
async function checkFile(
  db: RealmDb,
  path: string,
  realm: number,
  schema: readonly string[],
  versions: StoreSchemaVersions,
  acceptOlderSchema: boolean,
  report?: FileOutcome[],
): Promise<{
  readonly state: 'uninitialised' | 'ready' | 'unread';
  readonly version?: number;
  readonly matches?: boolean;
}> {
  // The open throws a refusal where the check keeps the outcome and goes on.
  const refuse = (outcome: FileOutcome, refusal: () => WorkflowError): void => {
    if (report === undefined) throw refusal();
    report.push(outcome);
  };
  try {
    let header: FileHeader;
    if (report === undefined) {
      header = await db.autocommit((c) => readHeader(c));
    } else {
      // SQLite's own error, caught before the store maps it (8 and 14 would become a refusal).
      const read = await db.autocommit((c) => {
        try {
          return readHeader(c);
        } catch (err) {
          if (isBusy(err)) throw err;
          const failure = sqliteFailure(err);
          if (failure === undefined) throw err;
          return failure;
        }
      });
      if ('errcode' in read) {
        report.push(unreadOutcome(read));
        return { state: 'unread' };
      }
      header = read;
    }
    if (isUninitialised(header) && report === undefined) return { state: 'uninitialised' };
    if (header.applicationId !== REALM_STORE_APPLICATION_ID) {
      refuse(
        {
          kind: 'settings_differ',
          setting: 'application_id',
          found: String(header.applicationId),
          expected: String(REALM_STORE_APPLICATION_ID),
        },
        () =>
          settingsRefused(path, [
            `its application id is ${header.applicationId}, not Realm's ${REALM_STORE_APPLICATION_ID}`,
          ]),
      );
    }
    // The version whose schema the file is held to: this Realm's, or, for the maintenance entry
    // (DELTAS 41 (2)), an older file's own, when this Realm holds that version's schema; none for a
    // newer file or a version this Realm holds no schema of (the check only).
    let version: number | undefined = realm;
    let expected: readonly string[] | undefined = schema;
    if (header.version < realm) {
      const older = acceptOlderSchema ? versions.get(header.version)?.schema : undefined;
      if (older === undefined) {
        refuse({ kind: 'version_unknown', file: header.version }, () =>
          versionOlder(header.version, realm),
        );
        version = undefined;
        expected = undefined;
      } else {
        report?.push({ kind: 'older_version', file: header.version, realm });
        version = header.version;
        expected = older;
      }
    }
    if (header.version > realm) {
      refuse({ kind: 'newer_version', file: header.version, realm }, () =>
        versionNewerError(header.version, realm),
      );
      version = undefined;
      expected = undefined;
    }
    // The meta row is read only when the schema matches: a dropped or renamed meta table (or its
    // `page_size` column) is then reported as the tampering it is, never as SQLite's own error. Every
    // version's schema holds version 1's, so the meta row and the settings are judged alike for each.
    // The check reads it whenever the meta table itself is intact.
    let recorded: number | undefined;
    let matches = false;
    if (version !== undefined && expected !== undefined) {
      const against = expected;
      const read = db.snapshot((c) => {
        let difference: SchemaDifference;
        try {
          difference = storedSchemaDifference(c, against);
        } catch (err) {
          // The check: the schema cannot be read (26, 11), as at the header read. The meta row's
          // read below keeps the open's damaged-file refusal: the version and the schema were read.
          if (report !== undefined && !isBusy(err) && isDamaged(err)) {
            throw new SchemaUnreadable('The schema cannot be read.', { cause: err });
          }
          throw err;
        }
        const { missing, extra, changed } = difference;
        const tampered = missing.length + extra.length + changed.length > 0;
        const metaTable = missing.includes(META_TABLE) || changed.includes(META_TABLE);
        const reads = report === undefined ? !tampered : !metaTable;
        const row = reads
          ? c.prepare('SELECT page_size FROM store_meta WHERE one = 1').get()?.['page_size']
          : undefined;
        return { difference, tampered, metaTable, row };
      });
      const stored = await read.catch((err: unknown) => {
        if (!(err instanceof SchemaUnreadable)) throw err;
        return undefined;
      });
      if (stored === undefined) {
        report?.push({ kind: 'header_damaged' });
        return { state: 'unread' };
      }
      matches = version === realm && !stored.tampered;
      const at = version;
      if (stored.tampered) {
        refuse(
          {
            kind: 'schema_differs',
            version: at,
            difference: stored.difference,
            metaTable: stored.metaTable,
          },
          () => schemaTampered(path, at, stored.difference),
        );
      }
      if (!stored.metaTable && stored.row === undefined) {
        refuse(
          { kind: 'settings_differ', setting: META_ROW_PART, found: 'absent', expected: 'one row' },
          () => settingsRefused(path, ['its meta row is missing']),
        );
      } else if (!stored.metaTable) {
        recorded = Number(stored.row);
      }
    }
    const differences = settingsDifferences(header, recorded);
    if (differences.length > 0) {
      if (report === undefined)
        throw settingsRefused(
          path,
          differences.map((d) => d.clause),
        );
      for (const { setting, found, expected: needed } of differences) {
        report.push({ kind: 'settings_differ', setting, found, expected: needed });
      }
    }
    return { state: 'ready', version: header.version, matches };
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

/** Steps 1 and 2 of the open and of the check: the loader's floor and the filesystem gate. */
function gate(home: string, seams: OpenSeams): FilesystemProbe {
  (seams.loadSqlite ?? loadSqlite)();
  const probe = seams.probe ?? SYSTEM_PROBE;
  assertLocalFilesystem(home, probe);
  return probe;
}

/**
 * Step 4's first half, for the open and the check: `realm.db` must be a regular file. (Each caller
 * prepares the home itself: the source law on the store file's path follows `prepareHome`'s result.)
 */
function assertAFile(path: string): void {
  const kind = notAFile(path);
  if (kind !== undefined) throw settingsRefused(path, [kind]);
}

/** The schema version this Realm writes, the versions it holds, and the schema of its own. */
function theSchema(seams: OpenSeams): {
  readonly realm: number;
  readonly versions: StoreSchemaVersions;
  readonly schema: readonly string[];
} {
  const realm = seams.schemaVersion ?? REALM_STORE_SCHEMA_VERSION;
  const versions = seams.versions ?? REALM_STORE_VERSIONS;
  const schema = versions.get(realm)?.schema;
  if (schema === undefined) {
    throw new Error(
      `Schema version ${realm} is not one this Realm knows: the open has no schema for it.`,
    );
  }
  return { realm, versions, schema };
}

/** The reopen `RealmDb` needs: the same file, the same pragmas, each read back. */
function reopener(
  path: string,
  openFile: (path: string, options?: { readonly readOnly: true }) => DatabaseLike,
  readOnly: boolean,
  pragmas: readonly ConnectionPragma[],
): () => DatabaseLike {
  return () => {
    const connection = connect(path, openFile, readOnly);
    try {
      for (const pragma of pragmas) applyPragma(connection, path, pragma);
    } catch (err) {
      connection.close();
      throw err;
    }
    return connection;
  };
}

/** The open (see the module comment); `RealmDb.open` runs it. */
export async function openRealmDb(
  home: string,
  options: OpenOptions,
  seams: OpenSeams = {},
): Promise<RealmDb> {
  const probe = gate(home, seams);
  const path = prepareHome(home, false);
  assertAFile(path);
  assertWritable(path);

  const { realm, versions, schema } = theSchema(seams);
  const older = options.acceptOlderSchema === true;
  const openFile = seams.openFile ?? openFileThroughTheLoader;
  const pragmas = connectionPragmas(probe.platform);
  const db = new RealmDb(connect(path, openFile, false), {
    path,
    clock: options.clock,
    reopen: reopener(path, openFile, false, pragmas),
    schemaVersion: realm,
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
  });
  try {
    const file = await checkFile(db, path, realm, schema, versions, older);
    if (file.state === 'uninitialised') {
      await setUp(db, path, realm, schema);
      if ((await checkFile(db, path, realm, schema, versions, older)).state !== 'ready') {
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

/**
 * The maintenance entry's check opens the file through this (c8a1, c8a3; see the module comment): a
 * read-only connection, and every outcome of the open's checks instead of its first refusal. It
 * still refuses the floor, a network filesystem, a home folder it cannot search, the old-store guard,
 * a `realm.db` that is not a regular file, a connection pragma that does not read back, and a store
 * busy past its budget.
 */
export async function openForCheck(
  home: string,
  options: CheckOpenOptions,
  seams: OpenSeams = {},
): Promise<CheckedFile> {
  const probe = gate(home, seams);
  const path = prepareHome(home, true);
  assertAFile(path);
  // Asked whenever the file exists: of the folder (SQLite makes the side files there) and of the file.
  const writable = homeIsWritable(home) && writeRefusal(path) === undefined;
  const { realm, versions, schema } = theSchema(seams);
  const outcomes: FileOutcome[] = writable ? [] : [{ kind: 'not_writable' }];
  const checked = (
    db: RealmDb | undefined,
    schemaVersion: number | undefined,
    matches = false,
  ): CheckedFile => {
    // The one place `usable` and `blockedBy` are decided: a file at this Realm's version with this
    // version's schema, read under this Realm's ceiling. Of the outcomes, only these two leave it so.
    const blocking = outcomes.find(
      (o) => o.kind !== 'not_writable' && o.kind !== 'settings_differ',
    );
    const usable =
      blocking === undefined && db !== undefined && db.schemaVersion === realm && matches;
    return {
      db,
      outcomes,
      schemaVersion,
      readsUpTo: realm,
      usable,
      ...(usable || blocking === undefined ? {} : { blockedBy: blocking.kind }),
    };
  };
  const openFile = seams.openFile ?? openFileThroughTheLoader;
  const pragmas = connectionPragmas(probe.platform);
  let connection: DatabaseLike;
  try {
    connection = openFile(path, { readOnly: true });
  } catch (err) {
    // SQLite's own error, before the store maps it.
    const failure = sqliteFailure(err);
    if (failure === undefined) throw err;
    outcomes.push(unreadOutcome(failure));
    return checked(undefined, undefined);
  }
  const reopen = reopener(path, openFile, true, pragmas);
  const over = (ceiling: number): RealmDb =>
    new RealmDb(connection, {
      path,
      clock: options.clock,
      reopen,
      schemaVersion: ceiling,
      ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
    });
  let db = over(realm);
  try {
    const file = await checkFile(db, path, realm, schema, versions, true, outcomes);
    if (file.state === 'unread') {
      db.close();
      return checked(undefined, undefined);
    }
    // A newer file is read too (`newer_version` stops only the schema and the data checks): its
    // connection's ceiling is the file's version, so its read transactions run. The check writes
    // nothing, whatever the version; `usable` is then false. The connection is the same one: the
    // class it was wrapped in first holds no transaction and no lock, and is dropped.
    if (file.version !== undefined && file.version > realm) db = over(file.version);
    for (const pragma of pragmas) await db.autocommit((c) => applyPragma(c, path, pragma));
    runPhaseDerivationFingerprint();
    return checked(db, file.version, file.matches === true);
  } catch (err) {
    db.close();
    throw err;
  }
}
