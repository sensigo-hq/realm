// maintenance.ts — issue #616 PR-2c, unit c6 (design d4-frozen-r3 §8 `realm db backup`, §2 "every
// open except `db check`, `db backup` and `db migrate` refuses an older file"; DELTAS 31 and 41):
// `openRealmHomeForMaintenance`, the store package's second entry. The maintenance verbs act on the
// store FILE, never on its data, so the handle carries no store: `backup` here (c6), `migrate` and
// `check` when units c7 and c8 add them. `openRealmHome` keeps refusing an older file.
//
// The handle runs THE open (`openRealmDb`, `open-file.ts`), with its one maintenance parameter
// (`acceptOlderSchema`): a file at an older schema version this Realm holds passes the version rule
// and is held to that version's schema; below the oldest held, or newer, it stays refused. It opens
// its own connection, outside `openRealmHome`'s per-process cache: the one stated exception to
// "one connection per home per process" (SEAMS S5; DELTAS 41 (3)). Its clock is the system's: the
// open's own readings are its only clock use, so a test location's clock file never refuses it.
//
// Before the open, the store file is looked at with `lstat`: a home with no store file, or an empty
// one, is refused there, because the open would create the file or set the empty one up, and a
// maintenance verb writes no store. Any other answer of `lstat` is left to the open to judge.
//
// `backup(target)` (§8): the target is refused when its folder is the home or inside it (judged by
// real paths), then created EMPTY and owner-only, exclusively (`O_EXCL` refuses anything at the
// path, a dangling link included), so the copy is owner-only from its first byte; then ONE
// `VACUUM INTO` in autocommit writes the copy into it (SQLite takes an empty file as its target);
// then the copy, opened on its own, is switched to WAL (Realm's own open refuses any other journal
// mode), checked with `PRAGMA quick_check` (DELTAS 31: a failure names the SOURCE as possibly
// damaged and keeps the copy), its mode read back, and closed. `realm.db` is never written,
// renamed or replaced. Restoring is a documented procedure, never a command.
import { closeSync, lstatSync, openSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { getSystemErrorMessage } from 'node:util';
import { realmHomePath, systemClock, WorkflowError } from '@sensigo/realm';
import { openDatabase, type DatabaseLike } from './driver.js';
import { DATABASE_FILE } from './home.js';
import { openRealmDb, type OpenSeams } from './open-file.js';

/** What `backup` reports of the copy it made and checked. */
export interface BackupReport {
  /** The copy's absolute path. */
  readonly path: string;
  /** The copy's size in bytes. */
  readonly bytes: number;
  /** The copy's schema version (`user_version`): the store file's, unchanged. */
  readonly schemaVersion: number;
  /** SQLite's quick check of the copy found nothing wrong. */
  readonly quickCheck: 'ok';
}

/** A Realm home opened for maintenance: no stores, the file's verbs, and `close()`. */
export interface MaintenanceHome {
  /** The store file this handle maintains: `<home>/realm.db`. */
  readonly path: string;
  /** The store file's schema version, as the open found it (older than this Realm's, or equal). */
  readonly schemaVersion: number;
  /**
   * Copies the store file to `target` (see the module comment) and resolves to the copy's report.
   * Refused with `STATE_STORE_BACKUP_REFUSED` (a target inside the home, a target where anything
   * exists, a target that cannot be created) and `STATE_STORE_BACKUP_UNVERIFIED` (the copy fails
   * SQLite's quick check). After `close()`, it rejects.
   */
  backup(target: string): Promise<BackupReport>;
  /** Closes the handle's connection. A second `close()` does nothing. */
  close(): void;
}

/** What a test replaces besides the open's seams (package-internal). */
export type MaintenanceSeams = OpenSeams & {
  /** Runs SQLite's quick check on the copy and returns its rows' texts; the real check by default. */
  readonly quickCheck?: (db: DatabaseLike) => string[];
};

/** A refusal to back up, with the path it is about and the reason. */
function backupRefused(message: string, path: string, reason: string): WorkflowError {
  return new WorkflowError(message, {
    code: 'STATE_STORE_BACKUP_REFUSED',
    category: 'STATE',
    agentAction: 'report_to_user',
    retryable: false,
    details: { path, reason },
  });
}

/** A refusal about the store file to back up (none there, or an empty one). */
function sourceRefused(source: string, reason: string, message: string): WorkflowError {
  return backupRefused(message, source, reason);
}

/** A refusal about the target of a backup. */
function targetRefused(target: string, reason: string, remedy: string): WorkflowError {
  return backupRefused(
    `Cannot back up the store to ${target}: ${reason}. ${remedy}`,
    target,
    reason,
  );
}

/** The copy fails SQLite's quick check: the file it was copied from may be damaged (DELTAS 31). */
function backupUnverified(copy: string, source: string, firstLine: string): WorkflowError {
  return new WorkflowError(
    `SQLite's quick check of the copy at ${copy} failed: ${firstLine}. The store file ${source} it ` +
      `was copied from may be damaged. The copy was kept at ${copy}.`,
    {
      code: 'STATE_STORE_BACKUP_UNVERIFIED',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: { path: copy, source, firstLine },
    },
  );
}

/**
 * The real path of `path`: the system's answer, or, for a path that does not exist yet, its nearest
 * existing folder's with the rest joined to it (as `openRealmHome`'s cache resolves a home).
 */
function realPathOf(path: string): string {
  const rest: string[] = [];
  let at = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(at), ...rest);
    } catch {
      const up = dirname(at);
      if (up === at) return resolve(path);
      rest.unshift(basename(at));
      at = up;
    }
  }
}

/** SQLite's quick check, each row's text. */
function quickCheckRows(db: DatabaseLike): string[] {
  return db
    .prepare('PRAGMA quick_check')
    .all()
    .map((row) => String(Object.values(row)[0]));
}

/** A pragma's first column on the copy. */
function copyPragma(db: DatabaseLike, sql: string): unknown {
  const row = db.prepare(sql).get();
  return row === undefined ? undefined : Object.values(row)[0];
}

/**
 * Opens the Realm home for maintenance (see the module comment). `home` is an absolute path;
 * `~/.realm` (core's resolver) when left out.
 */
export function openRealmHomeForMaintenance(
  options: { readonly home?: string } = {},
): Promise<MaintenanceHome> {
  return openMaintenance(options, {});
}

/** `openRealmHomeForMaintenance` with the open's seams and the quick check's (package-internal). */
export async function openMaintenance(
  options: { readonly home?: string },
  seams: MaintenanceSeams,
): Promise<MaintenanceHome> {
  const home = realmHomePath(options.home);
  const source = join(home, DATABASE_FILE);
  let size: number | undefined;
  try {
    size = lstatSync(source).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw sourceRefused(
        source,
        `there is no store file at ${source} to back up`,
        `There is no store file at ${source} to back up.`,
      );
    }
    // Anything else (a folder that cannot be read, a file where a folder should be): the open judges.
  }
  if (size === 0) {
    throw sourceRefused(
      source,
      `${source} holds no store yet`,
      `${source} holds no store yet: there is nothing to back up.`,
    );
  }
  const db = await openRealmDb(home, { clock: systemClock, acceptOlderSchema: true }, seams);
  let schemaVersion: number;
  try {
    schemaVersion = await db.autocommit((c) => Number(copyPragma(c, 'PRAGMA user_version')));
  } catch (err) {
    db.close();
    throw err;
  }
  const quickCheck = seams.quickCheck ?? quickCheckRows;
  let closed = false;
  return {
    path: source,
    schemaVersion,
    async backup(given: string): Promise<BackupReport> {
      if (closed) throw new Error(`The maintenance handle on ${source} is closed.`);
      const target = resolve(given);
      // (i) Not inside the home: a copy there would sit beside the file it copies.
      const realHome = realPathOf(home);
      const realFolder = realPathOf(dirname(target));
      if (realFolder === realHome || realFolder.startsWith(realHome + sep)) {
        throw targetRefused(
          target,
          `it is inside the Realm home ${home}`,
          'Write the copy outside the home.',
        );
      }
      // (ii) The copy's file, created empty and owner-only, exclusively: nothing at the path is
      // ever replaced, and the copy is never readable by others, not even for a moment.
      let fd: number;
      try {
        fd = openSync(target, 'wx', 0o600);
      } catch (err) {
        const { code, errno } = err as NodeJS.ErrnoException;
        if (code === 'EEXIST') {
          throw targetRefused(
            target,
            'a file already exists there',
            'Realm never replaces a file; name a path where nothing exists.',
          );
        }
        if (typeof errno === 'number') {
          throw targetRefused(target, getSystemErrorMessage(errno), 'Check the path.');
        }
        throw err;
      }
      closeSync(fd);
      // (iii) The copy, by one VACUUM INTO in autocommit (VACUUM cannot run inside a transaction).
      try {
        await db.autocommit((c) => {
          c.prepare('VACUUM INTO ?').run(target);
        });
      } catch (err) {
        // The file this call made, whatever SQLite left in it: the user's path as it was.
        try {
          unlinkSync(target);
        } catch {
          // Gone already, or not removable: the error below is what the caller needs.
        }
        throw err;
      }
      // (iv) The copy finished: WAL (Realm's own open refuses any other journal mode), checked,
      // its mode read back, closed (closing a WAL file that no one else holds leaves no sidecar).
      const copy = openDatabase(target);
      let copied: number;
      try {
        const mode = String(copyPragma(copy, 'PRAGMA journal_mode = WAL'));
        if (mode !== 'wal') {
          throw new Error(
            `SQLite left the copy at ${target} in journal mode ${mode} when Realm set wal; the copy ` +
              'was kept, but Realm will not open it.',
          );
        }
        const rows = quickCheck(copy);
        if (rows.length === 0 || rows.some((row) => row !== 'ok')) {
          throw backupUnverified(target, source, rows.find((row) => row !== 'ok') ?? 'no answer');
        }
        const after = String(copyPragma(copy, 'PRAGMA journal_mode'));
        if (after !== 'wal') {
          throw new Error(
            `The copy at ${target} reads journal mode ${after} after Realm set wal; the copy was ` +
              'kept, but Realm will not open it.',
          );
        }
        copied = Number(copyPragma(copy, 'PRAGMA user_version'));
      } finally {
        copy.close();
      }
      return {
        path: target,
        bytes: statSync(target).size,
        schemaVersion: copied,
        quickCheck: 'ok',
      };
    },
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
