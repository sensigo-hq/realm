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
// `backup(target)` (§8) never puts anything but a finished copy at the operator's path:
//   1. the target is refused when its folder is the home or inside it (judged by real paths), and
//      when anything exists at it (`lstat`, so a dangling link counts): Realm never replaces one;
//   2. the copy is made BESIDE it, in `<target>.part-<pid>-<12 hex>` (random, as `placeFence` names
//      its temporary files, so two runs, or two containers whose process is pid 1, never meet),
//      created exclusively and owner-only (0600) so it is never readable by others, not even for a
//      moment; ONE `VACUUM INTO` in autocommit writes the copy into it (SQLite takes an empty one);
//   3. that file, opened on its own, is switched to WAL (Realm's own open refuses any other journal
//      mode), checked with `PRAGMA quick_check`, its mode read back, closed (closing a WAL file no
//      one else holds leaves no sidecar) and flushed to the disk;
//   4. it is published under the target's name by `link` then `unlink`, which never replaces
//      anything; where the filesystem has no hard links it is renamed instead, after one more look;
//      then the target's folder is flushed, so the new name survives a crash.
// So the target only ever holds a finished copy: a run killed before the publish leaves nothing
// there, only files whose names begin `<target>.part-`. Every failure after the up-front checks
// removes the temporary file, and the `-wal`, `-shm` and `-journal` files SQLite names from it (a WAL
// switch that fails on a nearly full disk leaves the first two), and is one
// `STATE_STORE_BACKUP_REFUSED` (`copyFailed`) that blames a file only when the cause points at it.
// A copy that fails the quick check is still published, and refused `STATE_STORE_BACKUP_UNVERIFIED`
// (DELTAS 31: the source is named as possibly damaged and the copy is kept). Realm writes nothing
// of its own to `realm.db`; SQLite may first replay a write-ahead log a crashed Realm left beside
// it, as any open does. Restoring is a documented procedure, never a command.
//
// `migrate(options)` (c7; §2 "Schema evolution", §3 "The re-stamp", §8) upgrades the file, in order:
//   1. `backup(target)` first, every refusal of it included (a copy that fails the quick check
//      ends the verb: a store that may be damaged is not migrated), unless the operator stated
//      `backup: false` (`--no-backup`);
//   2. the schema ladder (`migrateSchema`, unit 6c) ONE VERSION AT A TIME, each version its own
//      `autocommit` body: the step's own `BEGIN IMMEDIATE`, its statements, the compare with its
//      version's schema, the evidence re-check, `user_version` moved, COMMIT. Each step is reported
//      before the next starts, and a busy store re-runs one step's body, never a committed step.
//      The first step that fails ends the verb `STATE_STORE_MIGRATE_FAILED`, with the version READ
//      after the failure, never assumed (the ladder's COMMIT is raw: an error it reports may come
//      after the step landed);
//   3. the re-stamp, after the ladder (it is this Realm's SQL, so it meets this Realm's schema):
//      every run whose `phase_version` is not the running derivation's fingerprint gets the phase
//      its stored record derives and that fingerprint. The stale stamps are found by the read API's
//      loose index scan (`staleStampsOf`); each batch reads one stamp's rows over
//      `runs_by_phase_version` and writes them in ONE write transaction, by a statement that sets
//      only `run_phase` and `phase_version` and holds only while the row's `version` is the one
//      read. It mints no instant and takes no reading. A busy store beyond its budget ends it
//      `STATE_RUN_BUSY`; the batches already committed stay, and their count is reported first.
// The handle's `schemaVersion` stays what the open found.
//
// Opened for `'check'` (c8a1; DELTAS 50 Q1, 52 (0)), the entry returns a check handle instead:
// `{ path, check(), close() }`, with no `backup` and no `migrate`. The verb is the open's switch: the
// open (`check`) reads the file through a read-only connection and makes nothing in the home (no
// fence, no set-up, no checkpoint), and every refusal of it is unchanged; an older file is refused
// too, since the check opens without `acceptOlderSchema`. `check()` returns the published report
// (`store-check.ts`).
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  deriveRunPhase,
  REALM_STORE_VERSIONS,
  realmHomePath,
  runPhaseDerivationFingerprint,
  SCAN_MAX_PAGE_SIZE,
  systemClock,
  WorkflowError,
  type RunPhase,
  type RunRecord,
} from '@sensigo/realm';
import type { RealmDb, Verify } from './connection.js';
import { loadSqlite, openDatabase, type DatabaseLike } from './driver.js';
import { assertLocalFilesystem, SYSTEM_PROBE } from './filesystem-gate.js';
import { DATABASE_FILE, systemErrorText } from './home.js';
import { openRealmDb, type OpenSeams } from './open-file.js';
import { runCheck, type CheckReport } from './store-check.js';
import { staleStampsOf } from './run-scan.js';
import { migrateSchema, type SchemaStepReport } from './schema-ladder.js';

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
   * exists, a target that cannot be created, a copy that fails or cannot be published) and
   * `STATE_STORE_BACKUP_UNVERIFIED` (the copy fails SQLite's quick check). After `close()`, it
   * rejects.
   */
  backup(target: string): Promise<BackupReport>;
  /**
   * Upgrades the store file (see the module comment): `backup` first unless `backup: false`, then
   * each pending schema step in its own transaction, then the re-stamp. Refused with `backup`'s
   * refusals, `STATE_STORE_MIGRATE_FAILED` at the first step that fails, and the store's own
   * (`STATE_RUN_BUSY` during the re-stamp, after the batches already committed). After `close()`,
   * it rejects.
   */
  migrate(options: MigrateOptions): Promise<MigrateReport>;
  /** Closes the handle's connection. A second `close()` does nothing. */
  close(): void;
}

/**
 * A Realm home opened for `'check'` (c8a1): the store file, its read-only check and `close()`. It
 * has no `backup` and no `migrate`.
 */
export interface MaintenanceCheckHome {
  /** The store file this handle checks: `<home>/realm.db`. */
  readonly path: string;
  /**
   * Checks the store file through the handle's read-only connection, writing nothing to it, and
   * resolves to the published report (`store-check.ts`). It never rejects for a finding. It rejects with
   * the store's busy refusal (`STATE_RUN_BUSY`, past its budget), with any error of the integrity check
   * other than a damaged file's (passed on as every store read passes it), and after `close()`.
   */
  check(): Promise<CheckReport>;
  /** Closes the handle's connection. A second `close()` does nothing. */
  close(): void;
}

/** The verb a maintenance entry is opened for: its two pre-check refusals carry its code and words. */
export type MaintenanceVerb = 'backup' | 'migrate' | 'check';

/** One line `realm db migrate` prints, as `migrate` reaches it. */
export type MigrateProgress =
  /** The backup made first. */
  | { readonly kind: 'backup'; readonly report: BackupReport }
  /** One schema step, committed. */
  | { readonly kind: 'step'; readonly report: SchemaStepReport }
  /** No step was pending: the file is at this Realm's version. */
  | { readonly kind: 'current'; readonly schemaVersion: number }
  /** The re-stamp's count: when it finished, or the count so far before a busy refusal. */
  | { readonly kind: 'restamped'; readonly runs: number };

/** What `migrate` is asked to do. */
export interface MigrateOptions {
  /** Where `backup` puts its copy before anything changes; `false` makes none (`--no-backup`). */
  readonly backup: string | false;
  /** Called with each line's event, in order, as it happens. */
  readonly progress?: (event: MigrateProgress) => void;
}

/** What `migrate` did. */
export interface MigrateReport {
  /** The copy made first; `undefined` with `backup: false`. */
  readonly backup: BackupReport | undefined;
  /** The steps, in order; none when the file was already at this Realm's version. */
  readonly steps: readonly SchemaStepReport[];
  /** The file's schema version now: this Realm's. */
  readonly schemaVersion: number;
  /** How many runs the re-stamp stamped with the running derivation. */
  readonly restamped: number;
}

/** What a test replaces besides the open's seams (package-internal). */
export type MaintenanceSeams = OpenSeams & {
  /** Runs SQLite's quick check on the copy and returns its rows' texts; the real check by default. */
  readonly quickCheck?: (db: DatabaseLike) => string[];
  /** Publishes the finished copy under the target's name; `linkSync` by default. */
  readonly link?: (from: string, to: string) => void;
  /** Flushes a file to the disk; by default it is opened, `fsyncSync`-ed and closed. */
  readonly syncFile?: (path: string) => void;
  /** Flushes a folder's names to the disk; by default opened read-only, `fsyncSync`-ed, closed. */
  readonly syncFolder?: (path: string) => void;
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

/** A refusal of `realm db migrate` before the open, with the path it is about and the reason. */
function migrateRefused(message: string, path: string, reason: string): WorkflowError {
  return new WorkflowError(message, {
    code: 'STATE_STORE_MIGRATE_REFUSED',
    category: 'STATE',
    agentAction: 'report_to_user',
    retryable: false,
    details: { path, reason },
  });
}

/** A refusal of a store check before the open, with the path it is about and the reason. */
function checkRefused(message: string, path: string, reason: string): WorkflowError {
  return new WorkflowError(message, {
    code: 'STATE_STORE_CHECK_REFUSED',
    category: 'STATE',
    agentAction: 'report_to_user',
    retryable: false,
    details: { path, reason },
  });
}

/**
 * The pre-check's refusal of the store file (`missing`: none there; else an empty one), in the words
 * and with the code of the verb the entry was opened for. An exhaustive switch: a verb added to
 * {@link MaintenanceVerb} does not compile until it names its code and its two sentences here (MA 3's
 * rider R1, DELTAS row 48b).
 */
function sourceRefused(verb: MaintenanceVerb, source: string, missing: boolean): WorkflowError {
  switch (verb) {
    case 'backup':
      return missing
        ? backupRefused(
            `There is no store file at ${source} to back up.`,
            source,
            `there is no store file at ${source} to back up`,
          )
        : backupRefused(
            `${source} holds no store yet: there is nothing to back up.`,
            source,
            `${source} holds no store yet`,
          );
    case 'migrate':
      return missing
        ? migrateRefused(
            `There is no store file at ${source} to migrate.`,
            source,
            `there is no store file at ${source} to migrate`,
          )
        : migrateRefused(
            `${source} holds no store yet: there is nothing to migrate.`,
            source,
            `${source} holds no store yet`,
          );
    case 'check':
      return missing
        ? checkRefused(
            `There is no store file at ${source} to check.`,
            source,
            `there is no store file at ${source} to check`,
          )
        : checkRefused(
            `${source} holds no store yet: there is nothing to check.`,
            source,
            `${source} holds no store yet`,
          );
    default: {
      const unknown: never = verb;
      throw new Error(`The maintenance entry has no verb ${String(unknown)}.`);
    }
  }
}

/**
 * A schema step of `migrate` failed. `at` is the file's version READ after the failure: `from` when
 * nothing of the step is in the file, higher when it is (a COMMIT that reported an error after the
 * step landed, or another process that moved the file). `backup` is the copy's path, when one was
 * made. The reason is the error's own text, its final period dropped.
 */
function migrateFailed(
  source: string,
  from: number,
  to: number,
  err: unknown,
  at: number,
  backup: string | undefined,
): WorkflowError {
  const reason = (err instanceof Error ? err.message : String(err)).replace(/\.$/, '');
  const state =
    at > from
      ? `${source} is at schema version ${at}: the step is in it. Run the command again to ` +
        'continue from there.'
      : `${source} is at schema version ${at}; nothing of the step is in it. Run the command ` +
        'again once the cause is fixed.';
  const kept = backup === undefined ? '' : ` The backup made before the step is at ${backup}.`;
  return new WorkflowError(
    `The step from schema version ${from} to ${to} failed: ${reason}. ${state}${kept}`,
    {
      code: 'STATE_STORE_MIGRATE_FAILED',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      details: {
        path: source,
        from,
        to,
        at,
        reason,
        ...(backup === undefined ? {} : { backup }),
      },
    },
  );
}

/** A refusal about the target of a backup. */
function targetRefused(target: string, reason: string, remedy: string): WorkflowError {
  return backupRefused(
    `Cannot back up the store to ${target}: ${reason}. ${remedy}`,
    target,
    reason,
  );
}

/** Something already exists at the target: Realm never replaces a file. */
function alreadyThere(target: string): WorkflowError {
  return targetRefused(
    target,
    'a file already exists there',
    'Realm never replaces a file; name a path where nothing exists.',
  );
}

/** An error the operating system gave a filesystem call (`errno`, `code`). */
function isSystemError(err: unknown): err is NodeJS.ErrnoException & { errno: number } {
  return (
    err instanceof Error &&
    typeof (err as NodeJS.ErrnoException).errno === 'number' &&
    typeof (err as NodeJS.ErrnoException).code === 'string'
  );
}

/** SQLite's own error, as the built-in SQLite throws it on a connection the primitive doesn't own. */
function isRawSqliteError(err: unknown): err is Error & { errcode: number } {
  return (
    err instanceof Error &&
    (err as { code?: unknown }).code === 'ERR_SQLITE_ERROR' &&
    typeof (err as { errcode?: unknown }).errcode === 'number'
  );
}

/**
 * The cause's own text: the system's words for a system error; SQLite's message with its code for
 * a SQLite error (the primitive's plain errors already end `(SQLite error N)`); else the message.
 */
function causeText(err: unknown): string {
  if (isSystemError(err)) return systemErrorText(err.errno);
  if (isRawSqliteError(err)) return `${err.message} (SQLite error ${err.errcode})`;
  return err instanceof Error ? err.message : String(err);
}

/** A sentence part that ends where the next sentence starts: one trailing period dropped. */
function clause(text: string): string {
  return text.endsWith('.') ? text.slice(0, -1) : text;
}

/** A typed refusal's code, read by its field (another copy of core's refusal is not `instanceof`). */
function codeOf(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
}

/** The refusals `copyFailed` passes on as they are: made here already, or the CLI prints them. */
const PASSED_ON = new Set([
  'STATE_STORE_BACKUP_UNVERIFIED',
  'STATE_STORE_BACKUP_REFUSED',
  'STATE_STORE_VERSION_NEWER',
]);

/**
 * A failure after the up-front checks (the copy, the steps on it, its publish), as ONE refusal
 * naming the target, its sentence chosen by what failed: it blames the store file only when SQLite
 * could not read it (11, 26 from the store's connection), and says the copy could not be written
 * when SQLite (10, 13, 14, 8, or the typed full / read-only refusals the primitive makes of them,
 * whose own texts are about the store file) or the system (an fsync, a rename) could not write it:
 * one sentence for both (MA 3's ruling, 2026-11-08). The caller removed the temporary file first,
 * so nothing is at the target.
 */
function copyFailed(target: string, source: string, err: unknown): unknown {
  const code = codeOf(err);
  if (typeof code === 'string' && PASSED_ON.has(code)) return err;
  const nothing = `Nothing was written at ${target}.`;
  const refuse = (reason: string, sentence: string): WorkflowError =>
    backupRefused(`Cannot back up the store to ${target}: ${sentence} ${nothing}`, target, reason);
  if (code === 'STATE_STORE_FULL') {
    return refuse('the disk is full', 'the copy could not be written: the disk is full.');
  }
  if (code === 'STATE_STORE_READONLY') {
    const details = (err as { details?: { reason?: unknown } }).details;
    const reason = typeof details?.reason === 'string' ? details.reason : causeText(err);
    return refuse(reason, `the copy could not be written: ${clause(reason)}.`);
  }
  if (isSystemError(err)) {
    const reason = causeText(err);
    return refuse(reason, `the copy could not be written: ${clause(reason)}.`);
  }
  const errcode = (err as { errcode?: unknown } | null)?.errcode;
  if (typeof errcode === 'number') {
    const primary = errcode & 0xff;
    const reason = causeText(err);
    // A plain error of the primitive (no code) comes from the store's connection: VACUUM INTO.
    if ((primary === 11 || primary === 26) && code === undefined) {
      return refuse(
        reason,
        `SQLite could not read ${source}: ${clause(reason)}. The store file may be damaged.`,
      );
    }
    if (primary === 13) {
      return refuse('the disk is full', 'the copy could not be written: the disk is full.');
    }
    if (primary === 10 || primary === 14 || primary === 8) {
      return refuse(reason, `the copy could not be written: ${clause(reason)}.`);
    }
  }
  const reason = causeText(err);
  return refuse(reason, `${clause(reason)}.`);
}

/** The copy is at the target, but the folder holding its name could not be flushed to the disk. */
function folderFlushFailed(target: string, err: unknown): WorkflowError {
  const reason = causeText(err);
  return backupRefused(
    `Cannot back up the store to ${target}: the copy was made and published, but its folder could ` +
      `not be flushed: ${clause(reason)}. Check the copy before you rely on it.`,
    target,
    reason,
  );
}

/**
 * Refused when anything is at `target` (a dangling link too); a path that cannot be looked at is
 * refused in the system's words.
 */
function refuseIfTaken(target: string): void {
  try {
    lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (isSystemError(err))
      throw targetRefused(target, systemErrorText(err.errno), 'Check the path.');
    throw err;
  }
  throw alreadyThere(target);
}

/** Removes the temporary file this call made; one that cannot be removed is left (its name says). */
function removeTemporary(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Gone already, or not removable: the refusal the caller throws is what the operator needs.
  }
}

/**
 * Removes what a failed run made beside the target: the temporary file and the three files SQLite
 * names from it by appending `-wal`, `-shm` and `-journal`, each as `removeTemporary` does.
 */
function removeCopy(temporary: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) removeTemporary(`${temporary}${suffix}`);
}

/** The real `syncFile`: opened, flushed, closed. */
function syncFileOnDisk(path: string): void {
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The real `syncFolder`: opened read-only, flushed, closed. */
function syncFolderOnDisk(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A folder flush the platform does not offer (Windows refuses to open a folder): skipped. */
const FOLDER_FLUSH_SKIPPED = new Set(['EISDIR', 'EPERM', 'EACCES']);

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

/** The store file's schema version, read now. */
function fileVersion(db: RealmDb): Promise<number> {
  return db.autocommit((c) => Number(copyPragma(c, 'PRAGMA user_version')));
}

/** How many rows one re-stamp batch reads: the page size the store's read API already names. */
const RESTAMP_BATCH = SCAN_MAX_PAGE_SIZE;

/** A batch's candidates: one stale stamp's rows after a cursor, over that stamp's index (§3). */
const STAMP_ROWS =
  'SELECT id, version, record FROM runs INDEXED BY runs_by_phase_version ' +
  'WHERE phase_version = ? AND id > ? ORDER BY id LIMIT ?';

/** One run re-stamped: the two phase columns only, and only while its version is the one read. */
const RESTAMP = 'UPDATE runs SET run_phase = ?, phase_version = ? WHERE id = ? AND version = ?';

/** A re-stamped run's two phase columns, read back by the COMMIT outcome protocol. */
const STAMP_OF = 'SELECT run_phase, phase_version FROM runs WHERE id = ?';

/** What one re-stamp batch wrote, and where the next batch of its stamp starts. */
interface RestampBatch {
  /** The runs stamped again, with the phase each was given. */
  readonly stamped: ReadonlyArray<{ readonly id: string; readonly phase: RunPhase }>;
  /** The last id the batch read: the next batch reads after it. */
  readonly last: string;
  /** True when the batch read a full batch, so the stamp may have more rows. */
  readonly full: boolean;
}

/**
 * One batch of the re-stamp, inside its write transaction: the rows of `stamp` after `after`, each
 * given the phase its stored record derives and `running`, by a statement predicated on the version
 * read (a row an engine wrote since is left as the engine stamped it, and not counted).
 */
function restampBatch(
  c: DatabaseLike,
  stamp: unknown,
  after: string,
  running: string,
): RestampBatch {
  const rows = c.prepare(STAMP_ROWS).all(stamp, after, RESTAMP_BATCH);
  const update = c.prepare(RESTAMP);
  const stamped: Array<{ id: string; phase: RunPhase }> = [];
  for (const row of rows) {
    const id = String(row['id']);
    // The derivation reads seven core fields of the record, as the read API's does (run-scan.ts).
    const phase = deriveRunPhase(JSON.parse(String(row['record'])) as RunRecord);
    if (Number(update.run(phase, running, id, row['version']).changes) === 1) {
      stamped.push({ id, phase });
    }
  }
  return {
    stamped,
    last: rows.length === 0 ? after : String(rows[rows.length - 1]!['id']),
    full: rows.length === RESTAMP_BATCH,
  };
}

/** The re-stamp batch's content check: every run it stamped carries the phase and the stamp given. */
function restampLanded(running: string): Verify<RestampBatch> {
  return (c: DatabaseLike, batch: RestampBatch): boolean => {
    const read = c.prepare(STAMP_OF);
    return batch.stamped.every(({ id, phase }) => {
      const row = read.get(id);
      return row?.['run_phase'] === phase && row['phase_version'] === running;
    });
  };
}

/** A refusal of the busy family, by its code. */
function isBusyRefusal(err: unknown): boolean {
  return err instanceof WorkflowError && err.code === 'STATE_RUN_BUSY';
}

/**
 * Opens the Realm home for maintenance (see the module comment). `home` is an absolute path;
 * `~/.realm` (core's resolver) when left out. `verb` is the verb it is opened for: its two
 * pre-check refusals carry that verb's code and words; `backup` when left out. Opened for
 * `'check'`, it resolves to a check handle (c8a1).
 */
export function openRealmHomeForMaintenance(options: {
  readonly home?: string;
  readonly verb: 'check';
}): Promise<MaintenanceCheckHome>;
export function openRealmHomeForMaintenance(options?: {
  readonly home?: string;
  readonly verb?: 'backup' | 'migrate';
}): Promise<MaintenanceHome>;
export function openRealmHomeForMaintenance(options: {
  readonly home?: string;
  readonly verb?: MaintenanceVerb;
}): Promise<MaintenanceHome | MaintenanceCheckHome>;
export function openRealmHomeForMaintenance(
  options: { readonly home?: string; readonly verb?: MaintenanceVerb } = {},
): Promise<MaintenanceHome | MaintenanceCheckHome> {
  return openMaintenance(options, {});
}

/** `openRealmHomeForMaintenance` with the open's seams and the quick check's (package-internal). */
export function openMaintenance(
  options: { readonly home?: string; readonly verb: 'check' },
  seams: MaintenanceSeams,
): Promise<MaintenanceCheckHome>;
export function openMaintenance(
  options: { readonly home?: string; readonly verb?: 'backup' | 'migrate' },
  seams: MaintenanceSeams,
): Promise<MaintenanceHome>;
export function openMaintenance(
  options: { readonly home?: string; readonly verb?: MaintenanceVerb },
  seams: MaintenanceSeams,
): Promise<MaintenanceHome | MaintenanceCheckHome>;
export async function openMaintenance(
  options: { readonly home?: string; readonly verb?: MaintenanceVerb },
  seams: MaintenanceSeams,
): Promise<MaintenanceHome | MaintenanceCheckHome> {
  const verb = options.verb ?? 'backup';
  const home = realmHomePath(options.home);
  const source = join(home, DATABASE_FILE);
  let size: number | undefined;
  try {
    size = lstatSync(source).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw sourceRefused(verb, source, true);
    // Anything else (a folder that cannot be read, a file where a folder should be): the open judges.
  }
  if (size === 0) throw sourceRefused(verb, source, false);
  if (verb === 'check') return openCheck(home, source, seams);
  const db = await openRealmDb(home, { clock: systemClock, acceptOlderSchema: true }, seams);
  let schemaVersion: number;
  try {
    schemaVersion = await fileVersion(db);
  } catch (err) {
    db.close();
    throw err;
  }
  const versions = seams.versions ?? REALM_STORE_VERSIONS;
  const quickCheck = seams.quickCheck ?? quickCheckRows;
  const link = seams.link ?? linkSync;
  const syncFile = seams.syncFile ?? syncFileOnDisk;
  const syncFolder = seams.syncFolder ?? syncFolderOnDisk;
  let closed = false;
  const handle: MaintenanceHome = {
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
      // (ii) Nothing at the target: Realm never replaces a file.
      refuseIfTaken(target);
      // (iii) The copy is made beside the target, in a file created empty, owner-only and
      // exclusively, so it is never readable by others, not even for a moment.
      const temporary = `${target}.part-${process.pid}-${randomBytes(6).toString('hex')}`;
      try {
        closeSync(openSync(temporary, 'wx', 0o600));
      } catch (err) {
        if (isSystemError(err)) {
          throw targetRefused(target, systemErrorText(err.errno), 'Check the path.');
        }
        throw err;
      }
      // (iv) One VACUUM INTO in autocommit (VACUUM cannot run inside a transaction); then the copy
      // on its own: WAL, the quick check, the mode read back, closed and flushed to the disk.
      let unverified: string | undefined;
      let copied = 0;
      try {
        await db.autocommit((c) => {
          c.prepare('VACUUM INTO ?').run(temporary);
        });
        const copy = openDatabase(temporary);
        try {
          const mode = String(copyPragma(copy, 'PRAGMA journal_mode = WAL'));
          if (mode !== 'wal') {
            throw new Error(
              `SQLite left the copy in journal mode ${mode} when Realm set wal, and Realm opens ` +
                'only WAL files',
            );
          }
          const rows = quickCheck(copy);
          if (rows.length === 0 || rows.some((row) => row !== 'ok')) {
            unverified = rows.find((row) => row !== 'ok') ?? 'no answer';
          } else {
            const after = String(copyPragma(copy, 'PRAGMA journal_mode'));
            if (after !== 'wal') {
              throw new Error(
                `the copy reads journal mode ${after} after Realm set wal, and Realm opens only ` +
                  'WAL files',
              );
            }
            copied = Number(copyPragma(copy, 'PRAGMA user_version'));
          }
        } finally {
          copy.close();
        }
        syncFile(temporary);
      } catch (err) {
        removeCopy(temporary);
        throw copyFailed(target, source, err);
      }
      // (v) Published under the target's name without replacing anything: a hard link fails if
      // anything appeared there meanwhile. Where the filesystem has no hard links (FAT, exFAT, some
      // FUSE and network filesystems), git's rule: look once more, then rename.
      try {
        link(temporary, target);
        // A failed unlink AFTER a good link is ignored (MA 3's ruling, 2026-11-08): the copy is
        // published, and the leftover is a second name of the same file, one the page's `.part-`
        // sentence tells the operator to delete.
        removeTemporary(temporary);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          removeCopy(temporary);
          throw alreadyThere(target);
        }
        try {
          refuseIfTaken(target);
        } catch (refused) {
          removeCopy(temporary);
          throw refused;
        }
        // The one place a file created between this look and the rename could be replaced: the
        // rename cannot refuse an existing name, and nothing narrower is offered without links.
        try {
          renameSync(temporary, target);
        } catch (renameErr) {
          removeCopy(temporary);
          throw copyFailed(target, source, renameErr);
        }
      }
      // (vi) The folder flushed, so the new name survives a crash (Litestream #1342).
      try {
        syncFolder(dirname(target));
      } catch (err) {
        if (!FOLDER_FLUSH_SKIPPED.has(String((err as NodeJS.ErrnoException).code))) {
          throw folderFlushFailed(target, err);
        }
      }
      if (unverified !== undefined) throw backupUnverified(target, source, unverified);
      return {
        path: target,
        bytes: statSync(target).size,
        schemaVersion: copied,
        quickCheck: 'ok',
      };
    },
    async migrate(options: MigrateOptions): Promise<MigrateReport> {
      if (closed) throw new Error(`The maintenance handle on ${source} is closed.`);
      const progress = options.progress ?? ((): void => undefined);
      // 1. The backup first: its refusals, and a copy that fails the quick check, end the verb here.
      const copy = options.backup === false ? undefined : await handle.backup(options.backup);
      if (copy !== undefined) progress({ kind: 'backup', report: copy });
      // 2. The ladder, one version per autocommit body (the ladder opens each step's transaction).
      const target = db.schemaVersion;
      const steps: SchemaStepReport[] = [];
      let at = await fileVersion(db);
      while (at < target) {
        const to = at + 1;
        let reports: SchemaStepReport[];
        try {
          reports = await db.autocommit((c) => migrateSchema(c, to, versions));
        } catch (err) {
          throw migrateFailed(source, to - 1, to, err, await fileVersion(db), copy?.path);
        }
        for (const report of reports) {
          steps.push(report);
          progress({ kind: 'step', report });
        }
        at = to;
      }
      if (steps.length === 0) progress({ kind: 'current', schemaVersion: at });
      // 3. The re-stamp: each stale stamp's rows, a batch per write transaction, no reading taken.
      const running = runPhaseDerivationFingerprint();
      let restamped = 0;
      try {
        const stamps = await db.snapshot((c) => staleStampsOf(c, running), {
          takesReading: false,
        });
        for (const stamp of stamps) {
          let after = '';
          for (;;) {
            const from = after;
            const batch = await db.immediate(
              (c) => restampBatch(c, stamp, from, running),
              restampLanded(running),
              { takesReading: false },
            );
            restamped += batch.stamped.length;
            if (!batch.full) break;
            after = batch.last;
          }
        }
      } catch (err) {
        if (isBusyRefusal(err)) progress({ kind: 'restamped', runs: restamped });
        throw err;
      }
      progress({ kind: 'restamped', runs: restamped });
      return { backup: copy, steps, schemaVersion: at, restamped };
    },
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
  return handle;
}

/**
 * The entry opened for `'check'` (c8a1): the open's read-only path (`check`), without
 * `acceptOlderSchema`, so an older file is refused as `refused_files` says; then the handle.
 */
async function openCheck(
  home: string,
  source: string,
  seams: MaintenanceSeams,
): Promise<MaintenanceCheckHome> {
  const db = await openRealmDb(home, { clock: systemClock, check: true }, seams);
  let schemaVersion: number;
  try {
    schemaVersion = await fileVersion(db);
  } catch (err) {
    db.close();
    throw err;
  }
  const probe = seams.probe ?? SYSTEM_PROBE;
  // The facts the file cannot give: the library's version, and what the filesystem gate judged (it
  // asks again; it reads and writes nothing).
  const sqliteVersion = (seams.loadSqlite ?? loadSqlite)().version;
  const judged = assertLocalFilesystem(home, probe);
  const filesystem = judged.escaped
    ? ({ escaped: true } as const)
    : judged.filesystem === undefined
      ? undefined
      : ({ escaped: false, type: judged.filesystem } as const);
  let closed = false;
  return {
    path: source,
    async check(): Promise<CheckReport> {
      if (closed) throw new Error(`The maintenance handle on ${source} is closed.`);
      return runCheck(db, {
        path: source,
        schemaVersion,
        readsUpTo: db.schemaVersion,
        sqliteVersion,
        filesystem,
        platform: probe.platform,
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
