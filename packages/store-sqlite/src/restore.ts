// restore.ts — #616 R1b part one (prompts/feat-616-r1b-restore.md, split by
// prompts/feat-616-r1b-split.md): `realm db restore <backup>` over a store the open reads, the
// maintenance entry opened for `'restore'`. It puts a backup in place of the store file, keeps the
// file it replaces, and says how the two differ. In this order:
//   A. the backup is proven first, in a private scratch folder (`mkdtemp` under the system's
//      temporary folder, 0700), before the store file is opened, so each of its refusals changes
//      nothing: a regular file (`lstat`), not the store file nor a side file of it by any route
//      (device and inode); copied in, owner-only; its application id and schema version read first
//      (Realm's, at least 1: an empty SQLite file is never set up into a store), switched to WAL,
//      SQLite's quick check run, then the store's own check (`openMaintenance` for `'check'`, the
//      scratch folder as the home, its copy linked there as `realm.db`). Not a store, damaged or
//      newer is refused in the check's words; an older store is allowed, and the report says so;
//   B. the store file opened as `backup` and `migrate` open it (older formats included); every
//      refusal of that open passes unchanged (a newer file, one it cannot read). The copy the swap
//      renames is made beside `realm.db`; then R1's hold; then the kept copy by `backup`'s machinery
//      in the backups folder beside the home (any refusal of it is `backup`'s own, with " Nothing
//      was replaced." appended);
//   C. one order: hold → kept copy → the counts → `wal_checkpoint(TRUNCATE)` (busy 0) → the old
//      `-wal` and `-shm` unlinked → ONE rename of the copy over `realm.db` → the folder flushed →
//      the hold let go last. Nothing runs after the rename: the hold covers only the OLD file;
//   E. the runs only are counted, by their record text, on the hold's connection with the scratch
//      copy attached: nothing is opened beside the kept file or the backup.
// A home with no store file, or an empty one, is refused by the entry's pre-check; a store file the
// open cannot read is refused by the open (part two, #616 R1c, restores over both).
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
import type { RealmDb } from './connection.js';
import { DATABASE_FILE, systemErrorText } from './home.js';
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
  syncFileOnDisk,
  syncFolderOnDisk,
  type BackupReport,
  type MaintenanceSeams,
  type OpenedStore,
} from './maintenance.js';
import { openRawConnection } from './open-file.js';
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

/** What was in place of the backup before the restore: a store, kept and counted. */
export interface RestoreReplaced {
  readonly kind: 'store';
  /** The kept copy of the store file it replaced, made and checked by `backup`'s machinery. */
  readonly kept: BackupReport;
  /** How its runs differ from the backup's. */
  readonly difference: RunDifference;
}

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

/** One line `realm db restore` prints as the restore reaches it, before its report: the kept copy
 *  of the store file in place, made and checked (`backup`'s report). */
export interface RestoreProgress {
  readonly kind: 'kept';
  readonly report: BackupReport;
}

/** A Realm home opened for `'restore'`: the store file, its restore, and `close()`. */
export interface MaintenanceRestoreHome {
  /** The store file a restore replaces: `<home>/realm.db`. */
  readonly path: string;
  /**
   * Puts the backup at `backup` in place of the store file (see the module comment) and resolves to
   * its report; `progress` is called with each line's event as it happens. Refused with
   * `STATE_STORE_RESTORE_REFUSED` (the backup is not a file, is the store file, is not a store, is
   * damaged or newer; a failure of the restore, which says whether the store file was replaced),
   * `STATE_STORE_IN_USE` (another process has the store file open), `backup`'s refusals of the kept
   * copy, and the store's own open refusals (a newer store file, one it cannot read). After
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

/** A failure before the rename: the store file is as it was; the kept copy is named if made. */
function notReplaced(
  r: Restore,
  source: string,
  err: unknown,
  kept: string | undefined,
): WorkflowError {
  const reason = causeText(err);
  const copy = kept === undefined ? '' : ` A copy of it is at ${kept}.`;
  return restoreRefused(
    `Cannot restore from ${r.backup}: ${clause(reason)}. ${source} was not replaced.${copy}`,
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
  kept: string,
  db: RealmDb,
): Promise<void> {
  try {
    await checkpointed(db);
    removeSideFiles(source);
    if (r.seams.rename === undefined) renameSync(temporary, source);
    else r.seams.rename(temporary, source);
  } catch (err) {
    throw notReplaced(r, source, err, kept);
  }
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
      const folder = backupsFolderOf(r.home);
      const unmade = makeFolder(folder);
      if (unmade !== undefined) {
        const err = new Error(`the backups folder ${folder} cannot be used: ${unmade}`);
        throw notReplaced(r, source, err, undefined);
      }
      let kept: BackupReport;
      try {
        kept = await store.handle.backup(
          join(folder, `realm-before-restore-${backupStamp(r.at)}.db`),
        );
      } catch (err) {
        throw keptCopyRefused(err);
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

/** A, then B, C and E: see the module comment. */
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
    // Every refusal of the store's open passes unchanged: a newer file, one it cannot read.
    const replaced = await replaceStore(r, source, await openStore(home, source, seams));
    const writes = seams.schemaVersion ?? REALM_STORE_SCHEMA_VERSION;
    return { path: source, backup, schemaVersion, writes, replaced };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The entry opened for `'restore'`, past its pre-check: nothing else is opened until `restore` runs. */
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
