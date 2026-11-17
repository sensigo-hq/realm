// restore.ts — #616 R1b (prompts/feat-616-r1b-restore.md; part one, and part two R1c,
// prompts/feat-616-r1c-damaged-file.md): `realm db restore <backup>`, the maintenance entry opened
// for `'restore'`. It puts a backup in place of the store file, keeps the
// file it replaces, and says how the two differ. In this order:
//   A. the backup is proven first, in a private scratch folder (`mkdtemp` under the system's
//      temporary folder, 0700), before the store file is opened, so each of its refusals changes
//      nothing: a regular file (`lstat`), not the store file nor a side file of it by any route
//      (device and inode); copied in, owner-only; its application id and schema version read first
//      (Realm's, at least 1: an empty SQLite file is never set up into a store), switched to WAL,
//      SQLite's quick check run, then the store's own check (`openMaintenance` for `'check'`, the
//      scratch folder as the home, its copy linked there as `realm.db`). Not a store, damaged or
//      newer is refused in the check's words; an older store is allowed, and the report says so;
//   B. the file in place decides the route. None (B1): the home's own preparation without the file,
//      then the copy placed by `link`, which never replaces a name; a zero-length one: D's lock rule,
//      then the rename over it; nothing kept. A `-wal` or `-shm` beside an existing file: SQLite is
//      asked first whether it reads the file without them (read-only, immutable: nothing touched),
//      because the store's open would apply that log and delete them when no other process holds
//      them (R1c item 2, executed); it cannot ⇒ refused, nothing changed. Then the store file opened
//      as `backup` and `migrate` open it (older formats included): a refusal on the allow-list of an
//      unreadable file (B4) takes D's path; every other passes unchanged (a newer file). The copy the
//      swap renames is made beside `realm.db`; then R1's hold; then the kept copy by `backup`'s
//      machinery in the backups folder beside the home: SQLite cannot read the file while copying it,
//      or the copy fails its quick check ⇒ D's path under the same hold; any other refusal is
//      `backup`'s own, with " Nothing was replaced." appended;
//   C. one order: hold → kept copy → the counts → `wal_checkpoint(TRUNCATE)` (busy 0) → the old
//      `-wal` and `-shm` unlinked → ONE rename of the copy over `realm.db` → the folder flushed →
//      the hold let go last. Nothing runs after the rename: the hold covers only the OLD file. On the
//      damaged path there is no checkpoint (SQLite cannot), so the file in place is not promised
//      whole before the rename: the as-found pair is;
//   D. the damaged path, on a raw connection: where SQLite reads page 1, its answer to an exclusive
//      lock decides; where it cannot (26, 11), the side files decide, looked at BEFORE that connection
//      opens (either one there ⇒ refused; none ⇒ one line on standard error). After the lock, the path
//      must still name the file the connection opened (another restore's rename ⇒ refused). The file
//      is set aside by BYTE COPY of it and its `-wal` under `-as-found` names (never a rename: it may
//      cross devices; never a hard link: a close would checkpoint into it); it is not counted;
//   E. the runs only are counted, by their record text, on the hold's connection with the scratch
//      copy attached: nothing is opened beside the kept file or the backup.
// This module is the one that touches `realm.db` and its side files with the filesystem for the
// restore: the source law L-FS (`open-laws-616.test.ts`) names each of those calls. Every call on
// those paths is spelled out with its `node:fs` function, and the store file's path is passed to each
// step as a parameter (never in an object's property), so that law sees it.
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  REALM_STORE_APPLICATION_ID,
  REALM_STORE_SCHEMA_VERSION,
  systemClock,
  WorkflowError,
} from '@sensigo/realm';
import { isBusy, type RealmDb } from './connection.js';
import type { DatabaseLike } from './driver.js';
import { assertLocalFilesystem, SYSTEM_PROBE } from './filesystem-gate.js';
import { DATABASE_FILE, prepareHome, systemErrorText } from './home.js';
import {
  backupStamp,
  backupsFolderOf,
  causeText,
  clause,
  copyPragma,
  FOLDER_FLUSH_SKIPPED,
  holdStoreFile,
  isSystemError,
  makeFolder,
  openMaintenance,
  openStore,
  quickCheckRows,
  removeCopy,
  restoreRefused,
  sourceUnreadable,
  storeInUse,
  syncFileOnDisk,
  syncFolderOnDisk,
  type BackupReport,
  type MaintenanceSeams,
  type OpenedStore,
} from './maintenance.js';
import { gate, openRawConnection } from './open-file.js';
import type { CheckFindingCode } from './store-check.js';

/** How the runs of the file a restore replaced and of the backup differ (counts only). */
export interface RunDifference {
  /** Runs the replaced file had that the backup lacks. */
  readonly onlyReplaced: number;
  /** Runs both hold whose stored record differs. */
  readonly changed: number;
  /** Runs the backup has that the replaced file lacked: they are back. */
  readonly onlyRestored: number;
}

/** What was in place of the backup before the restore. */
export type RestoreReplaced =
  /** No store file, or (`empty`) an empty one (R1c): nothing kept. */
  | { readonly kind: 'nothing'; readonly empty: boolean }
  /** A store: kept by `backup`'s machinery, its runs counted against the backup's. */
  | { readonly kind: 'store'; readonly kept: BackupReport; readonly difference: RunDifference }
  /** A file the store could not read (R1c): copied as it was to `asFound` (and its `-wal` to `wal`). */
  | { readonly kind: 'damaged'; readonly asFound: string; readonly wal: string | undefined };

/** What `restore` did. */
export interface RestoreReport {
  /** The store file: `<home>/realm.db`. */
  readonly path: string;
  /** The backup's absolute path. */
  readonly backup: string;
  /** The restored file's schema version (the backup's). */
  readonly schemaVersion: number;
  /** The schema version this Realm writes. */
  readonly writes: number;
  readonly replaced: RestoreReplaced;
}

/** One line `realm db restore` prints as the restore reaches it, before its report. */
export type RestoreProgress =
  /** The kept copy of the store file in place, made and checked (`backup`'s report). */
  | { readonly kind: 'kept'; readonly report: BackupReport }
  /** R1c: SQLite cannot read the file in place and no `-wal` or `-shm` is beside it, so it could not
   *  say whether another process has it open (standard error; the restore goes on). */
  | { readonly kind: 'unchecked_lock'; readonly path: string }
  /** R1c: the file in place, unreadable as a store, copied as it was to `asFound` (and `wal`). */
  | { readonly kind: 'as_found'; readonly asFound: string; readonly wal: string | undefined };

/** A Realm home opened for `'restore'`: the store file, its restore, and `close()`. */
export interface MaintenanceRestoreHome {
  /** The store file a restore replaces: `<home>/realm.db`. */
  readonly path: string;
  /**
   * Puts the backup at `backup` in place of the store file (see the module comment) and resolves to
   * its report; `progress` is called with each line's event as it happens. Refused with
   * `STATE_STORE_RESTORE_REFUSED` (the backup is not a file, is the store file, is not a store, is
   * damaged or newer; a `-wal` or `-shm` beside a store file SQLite cannot read, or beside a missing
   * one; a store file that appeared meanwhile; a failure of the restore, which says whether the store
   * file was replaced), `STATE_STORE_IN_USE` (another process has the store file open), `backup`'s
   * refusals of the kept copy, and the store's other open refusals (a newer store file). After
   * `close()`, it rejects.
   */
  restore(backup: string, progress?: (event: RestoreProgress) => void): Promise<RestoreReport>;
  /** Marks the handle closed: it holds nothing between restores. A second `close()` does nothing. */
  close(): void;
}

/** The scratch folder's copy of the backup; `realm.db` beside it is a second name of it. */
const SCRATCH_COPY = 'backup.db';

/** The check's findings that refuse a backup: not a store this Realm can use, newer, damaged. */
const REFUSING: ReadonlySet<CheckFindingCode> = new Set<CheckFindingCode>([
  'open_failed',
  'header_damaged',
  'newer_version',
  'version_unknown',
  'schema_differs',
  'settings_differ',
  'integrity_failed',
  'integrity_unreadable',
  'data_unreadable',
]);

/** The open's refusals of a file it cannot read as a store: D's path (CB-AU-R1B-22). */
const UNREADABLE: ReadonlySet<unknown> = new Set([
  'STATE_STORE_SETTINGS_REFUSED',
  'STATE_STORE_SCHEMA_TAMPERED',
  'STATE_STORE_VERSION_OLDER',
]);

/**
 * One restore's facts, passed from step to step. The store file's path is not one of them: every
 * step that touches it takes it as a parameter, so the source law L-FS follows it there.
 */
interface Restore {
  readonly home: string;
  readonly backup: string;
  /** The scratch folder's checked copy of the backup. */
  readonly copy: string;
  readonly at: Date;
  readonly seams: MaintenanceSeams;
  readonly progress: (event: RestoreProgress) => void;
}

/** The backup is refused before anything was touched. */
function backupRefused(backup: string, reason: string): WorkflowError {
  return restoreRefused(
    `Cannot restore from ${backup}: ${clause(reason)}. Nothing was changed.`,
    backup,
    reason,
  );
}

/**
 * A failure before the rename: the store file is not replaced; the copy made of it is named, if one
 * was (`copy`: the kept file, or the as-found pair, then the only whole original).
 */
function notReplaced(
  r: Restore,
  source: string,
  err: unknown,
  copy: string | undefined,
): WorkflowError {
  const reason = causeText(err);
  const at = copy === undefined ? '' : ` A copy of it is at ${copy}.`;
  return restoreRefused(
    `Cannot restore from ${r.backup}: ${clause(reason)}. ${source} was not replaced.${at}`,
    source,
    reason,
  );
}

/** What `lstat` shows at `path`: its entry, or nothing when it could not look. */
function lookAt(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** The device and inode `path` names now, or nothing when it cannot be looked at. */
function fileAt(path: string): string | undefined {
  const entry = lookAt(path);
  return entry === undefined ? undefined : `${entry.dev}:${entry.ino}`;
}

/** Whether a `-wal` or a `-shm` is beside the store file now (`lstat`). */
function hasSideFiles(source: string): boolean {
  return lookAt(`${source}-wal`) !== undefined || lookAt(`${source}-shm`) !== undefined;
}

/** D's refusal: SQLite cannot read the store file, and a side file is beside it. */
function sideFilesRefused(source: string): WorkflowError {
  return restoreRefused(
    `${source} cannot be read as a store, and a -wal or -shm file is beside it: another process ` +
      'may have it open, or a process that was killed left them. Stop every process that uses the ' +
      `home; if none is running, move ${source} and those files aside by hand, then run this ` +
      'again. Nothing was changed.',
    source,
    'side files beside an unreadable store file',
  );
}

/** SQLite's primary code when it cannot read the file (26: not a database; 11: damaged), else none. */
function unreadable(err: unknown): boolean {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && ((code & 0xff) === 26 || (code & 0xff) === 11);
}

/**
 * B's look before the store's open: with a `-wal` or `-shm` beside the store file, SQLite reads the
 * file without them (immutable, read-only: nothing is opened, applied or removed). If it cannot, the
 * side files are D's evidence and the store's open would apply and delete them when no other process
 * holds them (executed, R1c item 2): refused, nothing changed.
 */
function refuseUnreadableWithSideFiles(r: Restore, source: string): void {
  if (!hasSideFiles(source)) return;
  const probe = openRawConnection(source, r.seams, true);
  try {
    probe.prepare('PRAGMA application_id').get();
  } catch (err) {
    if (unreadable(err)) throw sideFilesRefused(source);
    throw err;
  } finally {
    probe.close();
  }
}

/** A1: the backup is an existing, non-empty regular file and not the store file or a side file of it. */
function refuseBackupEntry(backup: string, source: string): void {
  let entry: Stats;
  try {
    entry = lstatSync(backup);
  } catch (err) {
    if (isSystemError(err)) throw backupRefused(backup, systemErrorText(err.errno));
    throw err;
  }
  if (entry.isSymbolicLink()) throw backupRefused(backup, 'it is a symbolic link');
  if (!entry.isFile()) throw backupRefused(backup, 'it is not a file');
  const same = (other: Stats | undefined): boolean =>
    other !== undefined && other.dev === entry.dev && other.ino === entry.ino;
  if (same(lookAt(source))) throw backupRefused(backup, 'it is the store file itself');
  if (same(lookAt(`${source}-wal`)))
    throw backupRefused(backup, "it is the store file's -wal file");
  if (same(lookAt(`${source}-shm`)))
    throw backupRefused(backup, "it is the store file's -shm file");
  if (entry.size === 0) throw backupRefused(backup, 'it is empty: it holds no store');
}

/**
 * A2, A3: the backup copied into the scratch folder and proven there; resolves to its schema version.
 * Refused, in the check's words with the scratch paths replaced by the backup's, when it is not a
 * Realm store, is damaged or is newer.
 */
async function proveBackup(
  backup: string,
  scratch: string,
  copy: string,
  seams: MaintenanceSeams,
): Promise<number> {
  try {
    copyFileSync(backup, copy, constants.COPYFILE_EXCL);
    chmodSync(copy, 0o600);
  } catch (err) {
    if (isSystemError(err)) throw backupRefused(backup, systemErrorText(err.errno));
    throw err;
  }
  // The header first: the application id and the schema version, read before anything writes.
  let realm = false;
  let failedCheck: string | undefined;
  const db = openRawConnection(copy, seams);
  try {
    const id = Number(copyPragma(db, 'PRAGMA application_id'));
    const version = Number(copyPragma(db, 'PRAGMA user_version'));
    realm = id === REALM_STORE_APPLICATION_ID && version >= 1;
    if (realm) {
      copyPragma(db, 'PRAGMA journal_mode = WAL');
      const rows = (seams.quickCheck ?? quickCheckRows)(db);
      failedCheck =
        rows.find((row) => row !== 'ok') ?? (rows.length === 0 ? 'no answer' : undefined);
    }
  } catch (err) {
    // SQLite cannot read it (26, 11): the check names how; anything else is the system's.
    const primary = (err as { errcode?: unknown }).errcode;
    if (typeof primary !== 'number' || ((primary & 0xff) !== 26 && (primary & 0xff) !== 11)) {
      throw backupRefused(backup, causeText(err));
    }
  } finally {
    db.close();
  }
  const named = join(scratch, DATABASE_FILE);
  linkSync(copy, named);
  const home = await openMaintenance({ home: scratch, verb: 'check' }, seams);
  let report;
  try {
    report = await home.check();
  } finally {
    home.close();
  }
  const words = report.findings.filter((f) => REFUSING.has(f.code)).map((f) => f.message);
  if (words.length === 0 && failedCheck !== undefined) {
    words.push(`SQLite's quick check of it failed: ${failedCheck}.`);
  }
  if (words.length === 0 && !realm) words.push('It is not a Realm store.');
  if (words.length > 0) {
    throw backupRefused(backup, words.join(' ').split(named).join(backup).split(copy).join(backup));
  }
  return report.schema_version ?? 0;
}

/**
 * The copy the swap renames: made beside the store file from the scratch copy, owner-only, flushed.
 * It takes no store path (its words name the store file from the home): a path made from one would
 * be followed by the source law L-FS into every helper it reaches.
 */
function placeTemporary(r: Restore): string {
  const temporary = join(
    r.home,
    `.realm-restore-${process.pid}-${randomBytes(6).toString('hex')}.db`,
  );
  try {
    // From the 0600 scratch copy: the new file is created with that mode, so never readable by others.
    copyFileSync(r.copy, temporary, constants.COPYFILE_EXCL);
    chmodSync(temporary, 0o600);
    (r.seams.syncFile ?? syncFileOnDisk)(temporary);
  } catch (err) {
    removeCopy(temporary);
    throw notReplaced(r, join(r.home, DATABASE_FILE), err, undefined);
  }
  return temporary;
}

/** C's unlink: the old `-wal` and `-shm`, under the hold, each its own call; one already gone is fine. */
function removeSideFiles(source: string): void {
  const gone = (err: unknown): void => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  };
  try {
    unlinkSync(`${source}-wal`);
  } catch (err) {
    gone(err);
  }
  try {
    unlinkSync(`${source}-shm`);
  } catch (err) {
    gone(err);
  }
}

/** The hold's connection checkpoints the whole log into the file and empties it (TRUNCATE). */
async function checkpointed(db: RealmDb): Promise<void> {
  const row = await db.autocommit((c) => c.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get());
  if (Number(row?.['busy']) !== 0) {
    throw new Error("SQLite could not checkpoint the store file's write-ahead log");
  }
}

/**
 * C from the checkpoint on, under the caller's hold: the checkpoint, the side files unlinked, the ONE
 * rename, the folder flushed. A failure before the rename leaves the store file in place, whole; after
 * it, the words say it was replaced.
 */
async function swap(
  r: Restore,
  source: string,
  temporary: string,
  copy: string | undefined,
  db: RealmDb | undefined,
): Promise<void> {
  try {
    // The damaged path has no store connection: SQLite cannot checkpoint a file it cannot read.
    if (db !== undefined) await checkpointed(db);
    removeSideFiles(source);
    if (r.seams.rename === undefined) renameSync(temporary, source);
    else r.seams.rename(temporary, source);
  } catch (err) {
    throw notReplaced(r, source, err, copy);
  }
  flushHome(r, source);
}

/** The home folder flushed after the store file's name changed: a failure says it was replaced. */
function flushHome(r: Restore, source: string): void {
  try {
    (r.seams.syncFolder ?? syncFolderOnDisk)(r.home);
  } catch (err) {
    if (!FOLDER_FLUSH_SKIPPED.has(String((err as NodeJS.ErrnoException).code))) {
      const reason = causeText(err);
      throw restoreRefused(
        `Cannot restore from ${r.backup}: ${clause(reason)}. ${source} was replaced.`,
        source,
        reason,
      );
    }
  }
}

/** E: the runs of the store file in place against the scratch copy's, attached to the hold's connection. */
async function countRuns(db: RealmDb, copy: string): Promise<RunDifference> {
  return db.autocommit((c) => {
    c.prepare('ATTACH DATABASE ? AS restored').run(copy);
    try {
      const row = c
        .prepare(
          'SELECT (SELECT count(*) FROM main.runs AS k WHERE NOT EXISTS ' +
            '(SELECT 1 FROM restored.runs AS r WHERE r.id = k.id)) AS a, ' +
            '(SELECT count(*) FROM main.runs AS k JOIN restored.runs AS r ON r.id = k.id ' +
            'WHERE r.record IS NOT k.record) AS b, ' +
            '(SELECT count(*) FROM restored.runs AS r WHERE NOT EXISTS ' +
            '(SELECT 1 FROM main.runs AS k WHERE k.id = r.id)) AS c',
        )
        .get();
      return {
        onlyReplaced: Number(row?.['a']),
        changed: Number(row?.['b']),
        onlyRestored: Number(row?.['c']),
      };
    } finally {
      c.exec('DETACH DATABASE restored');
    }
  });
}

/** `backup`'s own refusal of the kept copy, with " Nothing was replaced." appended. */
function keptCopyRefused(err: unknown): unknown {
  if (!(err instanceof WorkflowError)) return err;
  return new WorkflowError(`${err.message} Nothing was replaced.`, {
    code: err.code,
    category: err.category,
    agentAction: err.agentAction,
    retryable: err.retryable,
    details: err.details,
  });
}

/** B, C and E on a store the open reads: the copy beside it, R1's hold, the kept copy, the swap. */
async function replaceStore(
  r: Restore,
  source: string,
  store: OpenedStore,
): Promise<RestoreReplaced> {
  try {
    // The file the open settled on (its own check made the path name it): the hold must be on it.
    const opened = fileAt(source);
    const temporary = placeTemporary(r);
    try {
      await r.seams.beforeHold?.();
      await holdStoreFile(store.db, source);
      // Another restore's rename between this open and this hold leaves the hold on the file it
      // replaced: nothing is copied, unlinked or renamed (correction 1).
      if (fileAt(source) !== opened) {
        const err = new Error(
          'another restore put a new store file in place while this one waited',
        );
        throw notReplaced(r, source, err, undefined);
      }
      const folder = backupsFolder(r, source);
      let kept: BackupReport;
      try {
        kept = await store.handle.backup(
          join(folder, `realm-before-restore-${backupStamp(r.at)}.db`),
        );
      } catch (err) {
        // SQLite could not read the file, or the copy failed its quick check: D, under this hold.
        if (
          (err as { code?: unknown }).code !== 'STATE_STORE_BACKUP_UNVERIFIED' &&
          !sourceUnreadable(err)
        ) {
          throw keptCopyRefused(err);
        }
        const replaced = setAside(r, source);
        await swap(r, source, temporary, asFoundWords(replaced), undefined);
        return replaced;
      }
      r.progress({ kind: 'kept', report: kept });
      let difference: RunDifference;
      try {
        difference = await countRuns(store.db, r.copy);
      } catch (err) {
        throw notReplaced(r, source, err, kept.path);
      }
      await swap(r, source, temporary, kept.path, store.db);
      return { kind: 'store', kept, difference };
    } finally {
      removeCopy(temporary);
    }
  } finally {
    // The hold is let go last: closing the connection releases it.
    store.handle.close();
  }
}

/** The backups folder beside the home, made owner-only when missing; refused when it cannot be used. */
function backupsFolder(r: Restore, source: string): string {
  const folder = backupsFolderOf(r.home);
  const unmade = makeFolder(folder);
  if (unmade === undefined) return folder;
  const err = new Error(`the backups folder ${folder} cannot be used: ${unmade}`);
  throw notReplaced(r, source, err, undefined);
}

/**
 * D's set-aside: the store file and its `-wal` byte-copied into the backups folder under the
 * `-as-found` names, owner-only and flushed, before anything of the original is unlinked. A `-wal`
 * is copied only when it holds bytes: an empty one is this command's own open's, not the file's.
 */
function setAside(r: Restore, source: string): RestoreReplaced {
  const folder = backupsFolder(r, source);
  const asFound = join(folder, `realm-before-restore-${backupStamp(r.at)}-as-found.db`);
  let wal: string | undefined =
    (lookAt(`${source}-wal`)?.size ?? 0) > 0 ? `${asFound}-wal` : undefined;
  const made: string[] = [];
  try {
    copyFileSync(source, asFound, constants.COPYFILE_EXCL);
    made.push(asFound);
    try {
      if (wal !== undefined) copyFileSync(`${source}-wal`, wal, constants.COPYFILE_EXCL);
      if (wal !== undefined) made.push(wal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      wal = undefined;
    }
    for (const copied of made) {
      chmodSync(copied, 0o600);
      (r.seams.syncFile ?? syncFileOnDisk)(copied);
    }
    (r.seams.syncFolder ?? syncFolderOnDisk)(folder);
  } catch (err) {
    // Only this call's own copies are removed (COPYFILE_EXCL: never a file that was there).
    for (const copied of made) removeCopy(copied);
    const taken = (err as NodeJS.ErrnoException).code === 'EEXIST';
    const cause = new Error(
      taken
        ? `the as-found copy ${made.length === 0 ? asFound : wal} already exists (another restore ran in the same second)`
        : `the copy of it as it was could not be made: ${clause(causeText(err))}; what was copied was removed`,
    );
    throw notReplaced(r, source, cause, undefined);
  }
  r.progress({ kind: 'as_found', asFound, wal });
  return { kind: 'damaged', asFound, wal };
}

/** A store file appeared (or an empty one was set up) while the restore ran: nothing replaced. */
function appeared(source: string): WorkflowError {
  return restoreRefused(
    `${DATABASE_FILE} appeared while the restore ran; nothing was replaced.`,
    source,
    'the store file appeared',
  );
}

/** The as-found pair, as a failure's words name it: the file, and its `-wal` when there is one. */
function asFoundWords(replaced: RestoreReplaced): string | undefined {
  if (replaced.kind !== 'damaged') return undefined;
  return replaced.wal === undefined
    ? replaced.asFound
    : `${replaced.asFound}, and its -wal at ${replaced.wal}`;
}

/**
 * D's hold on the store file, on a raw connection: SQLite's answer to an exclusive lock where it reads
 * page 1 (busy: another process has it open); where it cannot, the side files looked at before the
 * connection opened (`sides`). Then, as the swap's own guard (part one's correction 1), the path must
 * still name the file the connection opened.
 */
async function rawHold(r: Restore, source: string, sides: boolean): Promise<DatabaseLike> {
  const raw = openRawConnection(source, r.seams);
  try {
    const opened = fileAt(source);
    await r.seams.beforeHold?.();
    raw.exec('PRAGMA busy_timeout = 0');
    raw.exec('PRAGMA locking_mode = EXCLUSIVE');
    try {
      raw.exec('BEGIN EXCLUSIVE');
      raw.exec('COMMIT');
    } catch (err) {
      if (isBusy(err)) throw storeInUse(source);
      if (!unreadable(err)) throw err;
      if (sides) throw sideFilesRefused(source);
      r.progress({ kind: 'unchecked_lock', path: source });
    }
    if (fileAt(source) !== opened) {
      const err = new Error('another restore put a new store file in place while this one waited');
      throw notReplaced(r, source, err, undefined);
    }
    return raw;
  } catch (err) {
    raw.close();
    throw err;
  }
}

/**
 * B1: a home with no store file (the home's own preparation without the file, the copy placed by
 * `link`), or with a zero-length one (D's lock rule, then the rename over it). Nothing is kept.
 */
async function placeInEmptyHome(
  r: Restore,
  source: string,
  empty: boolean,
): Promise<RestoreReplaced> {
  gate(r.home, r.seams);
  // Looked at before the home's preparation makes its folder or fences: a refusal changes nothing.
  const sides = hasSideFiles(source);
  if (sides && empty) throw sideFilesRefused(source);
  if (sides) {
    throw restoreRefused(
      `There is no store file at ${source}, but a -wal or -shm file is beside where it would be: ` +
        'they may hold the writes of a store file that was moved or deleted. Move them aside by ' +
        'hand, then run this again. Nothing was changed.',
      source,
      'side files beside a missing store file',
    );
  }
  prepareHome(r.home, 'no-file');
  const temporary = placeTemporary(r);
  try {
    if (empty) {
      const raw = await rawHold(r, source, sides);
      try {
        // Classified before the hold: a command may have set the file up and written meanwhile. (The
        // size cannot tell: SQLite's own exclusive lock writes an empty first page into a 0-byte file.)
        const objects = Number(copyPragma(raw, 'SELECT count(*) FROM sqlite_master'));
        if (objects !== 0 || hasSideFiles(source)) throw appeared(source);
        await swap(r, source, temporary, undefined, undefined);
      } finally {
        raw.close();
      }
      return { kind: 'nothing', empty: true };
    }
    try {
      if (r.seams.link === undefined) linkSync(temporary, source);
      else r.seams.link(temporary, source);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST')
        throw notReplaced(r, source, err, undefined);
      throw appeared(source);
    }
    removeCopy(temporary);
    flushHome(r, source);
    return { kind: 'nothing', empty: false };
  } finally {
    removeCopy(temporary);
  }
}

/** B4: a file the store's open refused as unreadable: D, on a raw connection. */
async function replaceUnreadable(
  r: Restore,
  source: string,
  refusal: unknown,
): Promise<RestoreReplaced> {
  const entry = lookAt(source);
  // A link or a folder at the name keeps the store's refusal; a FIFO would block a byte copy.
  if (entry === undefined || !entry.isFile()) throw refusal;
  assertLocalFilesystem(r.home, r.seams.probe ?? SYSTEM_PROBE);
  // Looked at BEFORE the raw open: SQLite's open of a truncated file makes a `-wal` of its own.
  const sides = hasSideFiles(source);
  const temporary = placeTemporary(r);
  try {
    const raw = await rawHold(r, source, sides);
    try {
      const replaced = setAside(r, source);
      await swap(r, source, temporary, asFoundWords(replaced), undefined);
      return replaced;
    } finally {
      raw.close();
    }
  } finally {
    removeCopy(temporary);
  }
}

/** B2 to B4: the store's open decides: a store it reads, one it cannot read (D), or its refusal. */
async function replaceOpened(r: Restore, source: string): Promise<RestoreReplaced> {
  refuseUnreadableWithSideFiles(r, source);
  let store: OpenedStore;
  try {
    store = await openStore(r.home, source, r.seams);
  } catch (err) {
    if (!UNREADABLE.has((err as { code?: unknown } | null)?.code)) throw err;
    return replaceUnreadable(r, source, err);
  }
  return replaceStore(r, source, store);
}

/** A, then B, C, D and E: see the module comment. */
async function restoreFrom(
  home: string,
  source: string,
  backup: string,
  seams: MaintenanceSeams,
  progress: (event: RestoreProgress) => void,
): Promise<RestoreReport> {
  refuseBackupEntry(backup, source);
  const scratch = mkdtempSync(join(tmpdir(), 'realm-restore-'));
  try {
    const copy = join(scratch, SCRATCH_COPY);
    const schemaVersion = await proveBackup(backup, scratch, copy, seams);
    const r: Restore = { home, backup, copy, at: systemClock.now(), seams, progress };
    const entry = lookAt(source);
    const replaced =
      entry === undefined
        ? await placeInEmptyHome(r, source, false)
        : entry.isFile() && entry.size === 0
          ? await placeInEmptyHome(r, source, true)
          : await replaceOpened(r, source);
    const writes = seams.schemaVersion ?? REALM_STORE_SCHEMA_VERSION;
    return { path: source, backup, schemaVersion, writes, replaced };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The entry opened for `'restore'`: nothing is opened until `restore` runs (A comes first). */
export function openRestore(
  home: string,
  source: string,
  seams: MaintenanceSeams,
): MaintenanceRestoreHome {
  let closed = false;
  return {
    path: source,
    async restore(given, progress = (): void => undefined): Promise<RestoreReport> {
      if (closed) throw new Error(`The maintenance handle on ${source} is closed.`);
      return restoreFrom(home, source, resolve(given), seams, progress);
    },
    close(): void {
      closed = true;
    },
  };
}
