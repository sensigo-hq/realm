// maintenance-616.test.ts — issue #616 PR-2c, unit c6: `openRealmHomeForMaintenance` and its
// `backup` (design §8; DELTAS 31 and 41). The real cases: a user backs up the store before an upgrade
// and later restores it by the documented procedure (stop Realm, put the copy in place of `realm.db`,
// remove `realm.db-wal` and `realm.db-shm`), and the restored home must open; a user types a path
// inside the home, a path where a file already is, a path whose folder does not exist; a home with no
// store yet; a store file damaged on disk, whose copy SQLite's quick check refuses; a process that
// holds the home open through `openRealmHome` while the backup runs; and the first release that
// changes the schema, whose maintenance verbs must open a file one version behind while every other
// open keeps refusing it. Every cell works on real files through the loader.
//
// The correction (2026-11-08, cells 10-14) adds the cases a review of the built command met: a store
// with a damaged page, a target that cannot be written (an I/O error, a full disk), a run killed in
// the middle (a timeout, a container stop: nothing may be left at the operator's path), a file that
// appears at the path while the copy is made, a filesystem without hard links (FAT and exFAT sticks),
// and the flushes that make the copy and its name survive a crash.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WorkflowError, type Clock, type CreateRunOptions } from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { versionNewerError } from './connection.js';
import { openDatabase } from './driver.js';
import { systemErrorText } from './home.js';
import { openRealmHome, openRealmHomeForMaintenance } from './index.js';
import { openMaintenance, type MaintenanceHome } from './maintenance.js';
import { openHome, type RealmHome } from './open-realm-home.js';
import { faultyFiles, SQLITE, type Fault } from './test-support/commit-faults.js';
import { openForeignConnection } from './test-support/foreign-connection.js';
import { ladder } from './test-support/schema-versions.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const RUN: CreateRunOptions = {
  workflowId: 'triage',
  workflowVersion: 1,
  params: {},
  extensionIdentity: [],
};

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) {
    try {
      close();
    } catch {
      // closed by its cell
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-c6-'));
  dirs.push(dir);
  return dir;
}

/** Opens a home through `openRealmHome`; the cleanup closes it. */
async function home(path: string): Promise<RealmHome> {
  const handle = await openRealmHome({ home: path });
  closers.push(() => handle.close());
  return handle;
}

/** Opens a home for maintenance (through the seams when given); the cleanup closes it. */
async function maintain(
  path: string,
  seams?: Parameters<typeof openMaintenance>[1],
): Promise<MaintenanceHome> {
  const handle = await (seams === undefined
    ? openRealmHomeForMaintenance({ home: path })
    : openMaintenance({ home: path }, seams));
  closers.push(() => handle.close());
  return handle;
}

/** A home with a store holding `runs` runs, made by the open and closed again; its ids. */
async function storeWithRuns(path: string, runs = 2): Promise<string[]> {
  const h = await openRealmHome({ home: path });
  const ids: string[] = [];
  for (let i = 0; i < runs; i++) ids.push((await h.runStore.create(RUN)).record.id);
  h.close();
  return ids;
}

/** A rejection as a reader sees it: a typed refusal's code and message, or a plain error's message. */
async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err instanceof WorkflowError
      ? `${err.code}: ${err.message}`
      : `${(err as Error).name}: ${(err as Error).message}`;
  }
}

/** A rejection's typed details, or what it was instead. */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err instanceof WorkflowError
      ? { code: err.code, message: err.message, details: err.details }
      : `${(err as Error).name}: ${(err as Error).message}`;
  }
}

/** The copy's `user_version` and journal mode, read on a connection of its own. */
function copyHeader(path: string): { version: number; mode: string } {
  const db = openDatabase(path);
  try {
    return {
      version: Number(db.prepare('PRAGMA user_version').get()?.['user_version']),
      mode: String(db.prepare('PRAGMA journal_mode').get()?.['journal_mode']),
    };
  } finally {
    db.close();
  }
}

/** What a failed or killed run left beside the target: the names that begin `<its name>.part-`. */
function leftovers(target: string): string[] {
  const name = `${basename(target)}.part-`;
  return readdirSync(dirname(target)).filter((entry) => entry.startsWith(name));
}

/**
 * A system error in the shape Node's `fs` throws (`code`, a negative `errno`, `syscall`, `path`; the
 * SystemError of Node's errors page), for a filesystem this machine does not have (no hard links)
 * or a disk that fails (EIO).
 */
function systemError(code: 'ENOTSUP' | 'EIO' | 'EPERM', syscall: string, path: string): Error {
  const errno = -constants.errno[code];
  return Object.assign(new Error(`${code}: ${systemErrorText(errno)}, ${syscall} '${path}'`), {
    code,
    errno,
    syscall,
    path,
  });
}

/**
 * Damages page 13 of a store file as a bad sector would: the b-tree page's type byte 0x00 and its
 * cell count 0xffff (the fresh reader's case on the built command, FR-C6-14). The store's open still
 * passes (it reads the schema and the meta row); the copy, which reads every page, fails there.
 */
function damagePage13(file: string): void {
  const fd = openSync(file, 'r+');
  try {
    const page = 12 * 16384;
    writeSync(fd, Buffer.from([0x00]), 0, 1, page);
    writeSync(fd, Buffer.from([0xff, 0xff]), 0, 2, page + 3);
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether the file someone else made at `path` is still as they made it: `as made`, or its size
 * (never its bytes: replaced, it would be a whole store file in the failure's output).
 */
function asMade(path: string, theirs: string): string {
  const now = readFileSync(path);
  return now.equals(Buffer.from(theirs)) ? 'as made' : `replaced (${now.length} bytes)`;
}

/** A fault at the copy's one statement on the store's connection. */
function atVacuum(error: () => Error, also?: () => void): Fault {
  return {
    at: (sql) => sql.startsWith('VACUUM INTO'),
    times: 1,
    first: 'nothing',
    error,
    ...(also === undefined ? {} : { also }),
  };
}

describe('#616 PR-2c c6 — the maintenance entry and realm db backup', () => {
  it('(1) L-BACKUP: a backup restored by the documented procedure opens through openRealmHome and holds both runs', async () => {
    const root = tmp();
    const live = join(root, '.realm');
    const ids = await storeWithRuns(live);
    const m = await maintain(live);
    const copy = join(root, 'realm-backup.db');
    const report = await m.backup(copy);
    m.close();
    // The documented restore: Realm stopped, the copy put in place of realm.db, the two sidecars
    // removed (a stale write-ahead log beside a restored file corrupts it).
    rmSync(join(live, 'realm.db'));
    rmSync(join(live, 'realm.db-wal'), { force: true });
    rmSync(join(live, 'realm.db-shm'), { force: true });
    copyFileSync(copy, join(live, 'realm.db'));
    let opened = 'opened';
    const found: string[] = [];
    try {
      const restored = await home(live);
      for (const id of ids) found.push((await restored.runStore.get(id)).record.id);
    } catch (err) {
      opened = err instanceof WorkflowError ? `${err.code}: ${err.message}` : String(err);
    }
    // (1) red when the WAL conversion is skipped (the restored file is refused
    //     STATE_STORE_SETTINGS_REFUSED, "its journal mode is delete, not wal"), when the copy is not
    //     the whole store (a run missing), or when the report says something other than the copy;
    //     (2) prints the open's outcome, the two ids found and the report.
    expect({ opened, found, report }).toEqual({
      opened: 'opened',
      found: ids,
      report: { path: copy, bytes: statSync(copy).size, schemaVersion: 1, quickCheck: 'ok' },
    });
  });

  it('(2) a path inside the home is refused with the home named, and nothing is written there', async () => {
    const root = tmp();
    const live = join(root, '.realm');
    await storeWithRuns(live, 1);
    mkdirSync(join(live, 'backups'));
    const m = await maintain(live);
    const atTop = join(live, 'backup.db');
    const below = join(live, 'backups', 'x.db');
    const reason = `it is inside the Realm home ${live}`;
    // (1) red when the inside-the-home check is removed or judges another folder (the copy is then
    //     made beside realm.db: a resolved report, a file at the path); (2) prints both refusals
    //     and what is at the two paths.
    expect({
      atTop: await refusal(m.backup(atTop)),
      below: await refusal(m.backup(below)),
      made: [existsSync(atTop), existsSync(below)],
    }).toEqual({
      atTop: {
        code: 'STATE_STORE_BACKUP_REFUSED',
        message: `Cannot back up the store to ${atTop}: ${reason}. Write the copy outside the home.`,
        details: { path: atTop, reason },
      },
      below: {
        code: 'STATE_STORE_BACKUP_REFUSED',
        message: `Cannot back up the store to ${below}: ${reason}. Write the copy outside the home.`,
        details: { path: below, reason },
      },
      made: [false, false],
    });
  });

  it('(3) a path where a file or a dangling link already is, is refused and left exactly as it was', async () => {
    const root = tmp();
    const live = join(root, '.realm');
    await storeWithRuns(live, 1);
    // The publish's own refusal (a hard link fails on an existing name) is switched off: the link is
    // a rename, which replaces. So only the look before the copy can refuse (TESTING-RULES rule 9).
    const m = await maintain(live, { link: renameSync });
    const file = join(root, 'taken.db');
    writeFileSync(file, 'the user keeps this');
    const link = join(root, 'link.db');
    const nowhere = join(root, 'nowhere.db');
    symlinkSync(nowhere, link);
    const reason = 'a file already exists there';
    const remedy = 'Realm never replaces a file; name a path where nothing exists.';
    // (1) red when the look before the copy is removed, or follows links (`stat` instead of
    //     `lstat`: the dangling link reads as nothing there): the copy is then made and renamed over
    //     the file and the link (a resolved report, the file's text gone, the link a file);
    //     (2) prints both refusals, the file's text, the link's state and whether its target exists.
    expect({
      file: await refusal(m.backup(file)),
      link: await refusal(m.backup(link)),
      text: readFileSync(file, 'utf8'),
      linkStill: lstatSync(link).isSymbolicLink(),
      targetMade: existsSync(nowhere),
    }).toEqual({
      file: {
        code: 'STATE_STORE_BACKUP_REFUSED',
        message: `Cannot back up the store to ${file}: ${reason}. ${remedy}`,
        details: { path: file, reason },
      },
      link: {
        code: 'STATE_STORE_BACKUP_REFUSED',
        message: `Cannot back up the store to ${link}: ${reason}. ${remedy}`,
        details: { path: link, reason },
      },
      text: 'the user keeps this',
      linkStill: true,
      targetMade: false,
    });
  });

  it("(3b) a path under a folder that does not exist is refused in the system's words, and nothing is created", async () => {
    const root = tmp();
    const live = join(root, '.realm');
    await storeWithRuns(live, 1);
    const m = await maintain(live);
    const target = join(root, 'backups', 'x.db');
    const reason = 'no such file or directory';
    // (1) red when the create's system error is not mapped (a raw ENOENT with a stack), or when
    //     the folder is made for the user; (2) prints the refusal and whether the folder exists.
    expect({
      refused: await refusal(m.backup(target)),
      folder: existsSync(join(root, 'backups')),
    }).toEqual({
      refused: {
        code: 'STATE_STORE_BACKUP_REFUSED',
        message: `Cannot back up the store to ${target}: ${reason}. Check the path.`,
        details: { path: target, reason },
      },
      folder: false,
    });
  });

  it('(4) a home with no store file, or an empty one, is refused before anything is created or set up', async () => {
    const none = join(tmp(), '.realm');
    const noneFile = join(none, 'realm.db');
    const empty = join(tmp(), '.realm');
    mkdirSync(empty);
    const emptyFile = join(empty, 'realm.db');
    closeSync(openSync(emptyFile, 'wx'));
    // (1) red when the entry opens before it looks (the open creates the folder, the file and the
    //     fences, and sets an empty file up), or when an empty file passes the look; (2) prints
    //     both refusals and what each home holds after the call.
    expect({
      none: await refusal(openRealmHomeForMaintenance({ home: none })),
      noneMade: existsSync(none),
      empty: await refusal(openRealmHomeForMaintenance({ home: empty })),
      emptyHolds: readdirSync(empty),
      emptySize: statSync(emptyFile).size,
    }).toEqual({
      none: {
        code: 'STATE_STORE_BACKUP_REFUSED',
        message: `There is no store file at ${noneFile} to back up.`,
        details: { path: noneFile, reason: `there is no store file at ${noneFile} to back up` },
      },
      noneMade: false,
      empty: {
        code: 'STATE_STORE_BACKUP_REFUSED',
        message: `${emptyFile} holds no store yet: there is nothing to back up.`,
        details: { path: emptyFile, reason: `${emptyFile} holds no store yet` },
      },
      emptyHolds: ['realm.db'],
      emptySize: 0,
    });
  });

  it.skipIf(process.platform === 'win32')(
    '(5) the copy is owner-only from its first byte: its mode is 0600 (skipped on Windows: the platform has no owner-only mode bits)',
    async () => {
      const root = tmp();
      const live = join(root, '.realm');
      await storeWithRuns(live, 1);
      const m = await maintain(live);
      const copy = join(root, 'copy.db');
      await m.backup(copy);
      // (1) red when the target is left to SQLite's own create (0644 under the usual umask 022),
      //     or created with a wider mode; (2) prints the mode in octal.
      expect((statSync(copy).mode & 0o777).toString(8)).toBe('600');
    },
  );

  it('(6) a copy that fails the quick check is refused, the source named as possibly damaged, and the copy kept', async () => {
    const root = tmp();
    const live = join(root, '.realm');
    await storeWithRuns(live, 1);
    const m = await maintain(live, {
      quickCheck: () => [
        '*** in database main ***',
        'Page 7: btreeInitPage() returns error code 11',
      ],
    });
    const copy = join(root, 'copy.db');
    const source = join(live, 'realm.db');
    const first = '*** in database main ***';
    // (1) red when the quick check is skipped or its rows are not read (a resolved report), when
    //     the copy is removed on the failure, or when the message names the copy and not the
    //     source; (2) prints the refusal and whether the copy is still there.
    expect({ refused: await refusal(m.backup(copy)), kept: existsSync(copy) }).toEqual({
      refused: {
        code: 'STATE_STORE_BACKUP_UNVERIFIED',
        message:
          `SQLite's quick check of the copy at ${copy} failed: ${first}. The store file ${source} ` +
          `it was copied from may be damaged. The copy was kept at ${copy}.`,
        details: { path: copy, source, firstLine: first },
      },
      kept: true,
    });
  });

  it("(7) DELTAS 41 (3): the entry opens its own connection, outside openRealmHome's cache, and a home open in the process is untouched by it", async () => {
    const root = tmp();
    const live = join(root, '.realm');
    const first = await home(live);
    const before = (await first.runStore.create(RUN)).record.id;
    const m = await maintain(live);
    const copy = join(root, 'copy.db');
    const backedUp = await outcome(m.backup(copy));
    m.close();
    // The copy opens as a store of its own, in another home.
    const other = join(root, 'other');
    mkdirSync(other);
    copyFileSync(copy, join(other, 'realm.db'));
    const fromCopy = (await (await home(other)).runStore.get(before)).record.id;
    const again = await openRealmHome({ home: live });
    closers.push(() => again.close());
    const after = await outcome(first.runStore.create(RUN));
    const clock: Clock = { now: () => new Date(), at: () => () => undefined };
    // (1) red when the entry registers in the cache and removes its entry on close (a new handle
    //     on the next openRealmHome: `same` false), or shares the cached connection and closes it
    //     (the cached handle's create rejects "database is not open"), or when the cache no longer
    //     holds the first open's clock rule; (2) prints each outcome.
    expect({
      backedUp,
      fromCopy,
      same: again === first,
      after,
      otherClock: await outcome(openRealmHome({ home: live, clock })),
    }).toEqual({
      backedUp: 'resolved',
      fromCopy: before,
      same: true,
      after: 'resolved',
      otherClock: `Error: The Realm home ${live} is already open in this process with another clock; close it first.`,
    });
  });

  it('(8) close() is idempotent, and a backup after close() rejects', async () => {
    const root = tmp();
    const live = join(root, '.realm');
    await storeWithRuns(live, 1);
    const m = await openRealmHomeForMaintenance({ home: live });
    m.close();
    let second = 'no error';
    try {
      m.close();
    } catch (err) {
      second = `${(err as Error).name}: ${(err as Error).message}`;
    }
    const copy = join(root, 'copy.db');
    // (1) red when the closed flag is removed (the second close throws "database is not open", and
    //     the backup reaches the closed connection after creating its file); (2) prints the
    //     second close's outcome, the backup's and whether a file was made.
    expect({
      second,
      backup: await outcome(m.backup(copy)),
      made: existsSync(copy),
    }).toEqual({
      second: 'no error',
      backup: `Error: The maintenance handle on ${join(live, 'realm.db')} is closed.`,
      made: false,
    });
  });

  describe('(9) DELTAS 41 (2)/(4): the versions, through the open’s seams', () => {
    it('(a) a Realm at version 2 opens a version-1 file for maintenance and copies it as it is; its ordinary open refuses the file as older', async () => {
      const root = tmp();
      const live = join(root, '.realm');
      await storeWithRuns(live);
      const seams = { schemaVersion: 2, versions: ladder() };
      const m = await maintain(live, seams);
      const copy = join(root, 'copy.db');
      const report = await m.backup(copy);
      // (1) red when the maintenance option is not passed or not read (the entry refuses the file
      //     STATE_STORE_VERSION_OLDER), when the older file is held to version 2's schema (refused
      //     as tampered), or when the option leaks into the ordinary open (it opens); (2) prints
      //     the handle's version, the report's, the copy's header and the ordinary open's outcome.
      expect({
        handle: m.schemaVersion,
        report: report.schemaVersion,
        copy: copyHeader(copy),
        ordinary: (await outcome(openHome({ home: live }, seams))).split(':')[0],
      }).toEqual({
        handle: 1,
        report: 1,
        copy: { version: 1, mode: 'wal' },
        ordinary: 'STATE_STORE_VERSION_OLDER',
      });
    });

    it('(b) a Realm whose oldest held version is 2 refuses a version-1 file, also for maintenance', async () => {
      const live = join(tmp(), '.realm');
      await storeWithRuns(live, 1);
      const versions = new Map([...ladder()].filter(([v]) => v > 1));
      // (1) red when "older" admits a version this Realm holds no schema for (the file opens);
      //     (2) prints the refusal.
      expect(await outcome(openMaintenance({ home: live }, { schemaVersion: 3, versions }))).toBe(
        "STATE_STORE_VERSION_OLDER: This store's file is at schema version 1; this Realm writes version 3. Run `realm db migrate` with Realm stopped to upgrade it.",
      );
    });

    it('(c) a newer file is refused by both entries', async () => {
      const live = join(tmp(), '.realm');
      await storeWithRuns(live, 1);
      const foreign = await openForeignConnection(live);
      foreign.exec('PRAGMA user_version = 2');
      foreign.close();
      // (1) red when the maintenance option admits a newer file too (the entry opens it);
      //     (2) prints both outcomes' codes.
      expect({
        maintenance: (await outcome(openRealmHomeForMaintenance({ home: live }))).split(':')[0],
        ordinary: (await outcome(openRealmHome({ home: live }))).split(':')[0],
      }).toEqual({
        maintenance: 'STATE_STORE_VERSION_NEWER',
        ordinary: 'STATE_STORE_VERSION_NEWER',
      });
    });
  });
});

describe('#616 PR-2c c6 correction — a failed copy is one refusal, and nothing but a finished copy is ever at the path', () => {
  it('(10a) a store with a damaged page: the refusal says SQLite could not read the store file, and nothing is left at the path or beside it', async () => {
    const root = tmp();
    const live = join(root, '.realm');
    await storeWithRuns(live, 1);
    const source = join(live, 'realm.db');
    damagePage13(source);
    const m = await maintain(live);
    const target = join(root, 'copy.db');
    const reason = 'database disk image is malformed (SQLite error 11)';
    // (1) red when the copy's failure is not converted (the plain error "database disk image is
    //     malformed (SQLite error 11)" escapes, and the CLI prints it with its stack), when it gets
    //     the write sentence (it blames the copy), or when the temporary file is left beside the
    //     path; (2) prints the refusal, whether the path exists and what was left beside it.
    expect({
      refused: await refusal(m.backup(target)),
      atPath: existsSync(target),
      left: leftovers(target),
    }).toEqual({
      refused: {
        code: 'STATE_STORE_BACKUP_REFUSED',
        message:
          `Cannot back up the store to ${target}: SQLite could not read ${source}: ${reason}. ` +
          `The store file may be damaged. Nothing was written at ${target}.`,
        details: { path: target, reason },
      },
      atPath: false,
      left: [],
    });
  });

  it.each([
    {
      cause: 'an I/O error at the target (SQLite 10)',
      error: SQLITE.ioError,
      reason: 'disk I/O error (SQLite error 10)',
      sentence: 'the copy could not be written: disk I/O error (SQLite error 10).',
    },
    {
      cause: 'a full disk (SQLite 13, which the primitive makes STATE_STORE_FULL)',
      error: SQLITE.full,
      reason: 'the disk is full',
      sentence: 'the copy could not be written: the disk is full.',
    },
    {
      cause: 'an error that is not SQLite’s (no code)',
      error: () => new Error('the copy stopped for a reason Realm does not know'),
      reason: 'the copy stopped for a reason Realm does not know',
      sentence: 'the copy stopped for a reason Realm does not know.',
    },
  ])(
    '(10b) $cause: one refusal that says so and blames no store file, and nothing is left',
    async ({ error, reason, sentence }) => {
      const root = tmp();
      const live = join(root, '.realm');
      await storeWithRuns(live, 1);
      const files = faultyFiles(openDatabase);
      const m = await maintain(live, { openFile: files.openFile });
      files.opened[0]?.arm(atVacuum(error));
      const target = join(root, 'copy.db');
      // (1) red when the failure is not converted (the plain error, or STATE_STORE_FULL's sentence
      //     about the store file, escapes), when a write failure gets the damaged-store sentence,
      //     or when the temporary file is left; (2) prints the refusal, the path's state, what was
      //     left beside it and how many times the fault fired (1: it hit the copy).
      expect({
        refused: await refusal(m.backup(target)),
        atPath: existsSync(target),
        left: leftovers(target),
        fired: files.opened[0]?.hits(),
      }).toEqual({
        refused: {
          code: 'STATE_STORE_BACKUP_REFUSED',
          message: `Cannot back up the store to ${target}: ${sentence} Nothing was written at ${target}.`,
          details: { path: target, reason },
        },
        atPath: false,
        left: [],
        fired: 1,
      });
    },
  );

  it('(10c) a store migrated by a newer Realm while the copy starts: its own refusal passes as it is, and nothing is left', async () => {
    const root = tmp();
    const live = join(root, '.realm');
    await storeWithRuns(live, 1);
    const files = faultyFiles(openDatabase);
    const m = await maintain(live, { openFile: files.openFile });
    files.opened[0]?.arm(atVacuum(() => versionNewerError(2)));
    const target = join(root, 'copy.db');
    const expected = versionNewerError(2);
    // (1) red when the conversion swallows the typed refusal (the backup refusal's "Cannot back up
    //     …" instead), or when the temporary file is left; (2) prints the outcome and the path's
    //     state.
    expect({
      outcome: await outcome(m.backup(target)),
      atPath: existsSync(target),
      left: leftovers(target),
    }).toEqual({
      outcome: `STATE_STORE_VERSION_NEWER: ${expected.message}`,
      atPath: false,
      left: [],
    });
  });

  describe('(11) a run killed in the middle', { timeout: 120_000 }, () => {
    /**
     * Runs `backup(target)` in a child (the built package) whose copy is killed by SIGKILL right
     * after it ran: the temporary file exists and holds the copy, nothing has been published.
     */
    function killedBackup(home: string, target: string): { signal: string | null; stderr: string } {
      const url = (file: string): string =>
        JSON.stringify(pathToFileURL(join(PACKAGE_ROOT, 'dist', file)).href);
      const child =
        `import { openMaintenance } from ${url('maintenance.js')};` +
        `import { faultyFiles } from ${url('test-support/commit-faults.js')};` +
        `import { openDatabase } from ${url('driver.js')};` +
        'const p = JSON.parse(process.env.C6C_PLAN);' +
        'const files = faultyFiles(openDatabase);' +
        'const m = await openMaintenance({ home: p.home }, { openFile: files.openFile });' +
        'files.opened[0].arm({ at: (sql) => sql.startsWith("VACUUM INTO"), times: 1, first: "run",' +
        ' also: () => process.kill(process.pid, "SIGKILL"), error: () => new Error("not reached") });' +
        'await m.backup(p.target);';
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
        env: { ...process.env, C6C_PLAN: JSON.stringify({ home, target }) },
        encoding: 'utf8',
        timeout: 60_000,
      });
      return { signal: r.signal, stderr: r.stderr.slice(0, 300) };
    }

    it('(11a) nothing is at the path, and a second backup to the same path then works', async () => {
      const root = tmp();
      const live = join(root, '.realm');
      await storeWithRuns(live, 1);
      const target = join(root, 'copy.db');
      const killed = killedBackup(live, target);
      const atPath = existsSync(target);
      const again = await outcome((await maintain(live)).backup(target));
      // (1) red when the copy is written at the path itself (as before the correction: a file there
      //     that looks like a backup, and the second run refused "a file already exists there"), or
      //     when the child was not killed (its signal and stderr show why); (2) prints the child's
      //     end, whether the path existed after the kill and the second run's outcome.
      expect({ killed, atPath, again }).toEqual({
        killed: { signal: 'SIGKILL', stderr: '' },
        atPath: false,
        again: 'resolved',
      });
    });

    it('(11b) what a kill leaves beside the path: only files whose names begin <path>.part-', async () => {
      const root = tmp();
      const live = join(root, '.realm');
      const out = join(root, 'backups');
      mkdirSync(out);
      await storeWithRuns(live, 1);
      {
        const target = join(out, 'copy.db');
        const killed = killedBackup(live, target);
        const entries = readdirSync(out);
        // (1) red when a kill leaves a file under another name, or the path itself (the folder
        //     held nothing before the run); the count is checked too, so an empty folder (a child
        //     that never got to the copy) cannot pass as "only .part- names"; (2) prints the
        //     child's end and the folder's entries.
        expect({
          killed: killed.signal,
          some: entries.length > 0,
          other: entries.filter((e) => !e.startsWith('copy.db.part-')),
        }).toEqual({ killed: 'SIGKILL', some: true, other: [] });
      }
    });
  });

  it('(12) a file that appears at the path while the copy is made is never replaced: refused, left byte for byte, the temporary file gone', async () => {
    const root = tmp();
    const live = join(root, '.realm');
    await storeWithRuns(live, 1);
    const target = join(root, 'copy.db');
    const theirs = 'another program wrote this here meanwhile';
    const m = await maintain(live, {
      quickCheck: () => {
        writeFileSync(target, theirs);
        return ['ok'];
      },
    });
    const reason = 'a file already exists there';
    // (1) red when the copy is published by a rename (it replaces the file that appeared) or the
    //     publish does not refuse an existing name, or when the temporary file is left; (2) prints
    //     the refusal, whether the file is as made (or its size) and what was left beside it.
    expect({
      refused: await refusal(m.backup(target)),
      file: asMade(target, theirs),
      left: leftovers(target),
    }).toEqual({
      refused: {
        code: 'STATE_STORE_BACKUP_REFUSED',
        message: `Cannot back up the store to ${target}: ${reason}. Realm never replaces a file; name a path where nothing exists.`,
        details: { path: target, reason },
      },
      file: 'as made',
      left: [],
    });
  });

  it.skipIf(process.platform === 'win32')(
    '(13a) a filesystem without hard links (FAT, exFAT): the copy is renamed into place instead, owner-only and checked, nothing left beside it (skipped on Windows: no owner-only mode bits)',
    async () => {
      const root = tmp();
      const live = join(root, '.realm');
      await storeWithRuns(live, 1);
      const m = await maintain(live, {
        link: (from) => {
          throw systemError('ENOTSUP', 'link', from);
        },
      });
      const target = join(root, 'copy.db');
      const report = await outcome(m.backup(target));
      // (1) red when a link failure other than EEXIST is not followed by the rename (the backup is
      //     refused on such a filesystem), or when the temporary file is left; (2) prints the
      //     outcome, the copy's header, mode and what was left beside it.
      expect({
        report,
        copy: copyHeader(target),
        mode: (statSync(target).mode & 0o777).toString(8),
        left: leftovers(target),
      }).toEqual({
        report: 'resolved',
        copy: { version: 1, mode: 'wal' },
        mode: '600',
        left: [],
      });
    },
  );

  it('(13b) without hard links, a file that appeared at the path is still never replaced: the second look refuses it', async () => {
    const root = tmp();
    const live = join(root, '.realm');
    await storeWithRuns(live, 1);
    const target = join(root, 'copy.db');
    const theirs = 'it appeared as the link failed';
    const m = await maintain(live, {
      link: (from) => {
        writeFileSync(target, theirs);
        throw systemError('ENOTSUP', 'link', from);
      },
    });
    const reason = 'a file already exists there';
    // (1) red when the look before the rename is removed (the rename replaces the file); (2)
    //     prints the refusal, whether the file is as made (or its size) and what was left beside it.
    expect({
      refused: await refusal(m.backup(target)),
      file: asMade(target, theirs),
      left: leftovers(target),
    }).toEqual({
      refused: {
        code: 'STATE_STORE_BACKUP_REFUSED',
        message: `Cannot back up the store to ${target}: ${reason}. Realm never replaces a file; name a path where nothing exists.`,
        details: { path: target, reason },
      },
      file: 'as made',
      left: [],
    });
  });

  describe('(14) the flushes that make the copy and its name survive a crash', () => {
    /** The real calls, each recorded (the temporary file's pid and random part as placeholders). */
    function recording(root: string, calls: string[]) {
      const name = (path: string): string =>
        path === root
          ? '<folder>'
          : basename(path).replace(/\.part-\d+-[0-9a-f]{12}$/, '.part-<pid>-<hex>');
      const flush = (path: string, flags: string): void => {
        const fd = openSync(path, flags);
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      };
      return {
        syncFile: (path: string) => {
          calls.push(`syncFile ${name(path)}`);
          flush(path, 'r+');
        },
        link: (from: string, to: string) => {
          calls.push(`link ${name(from)} ${name(to)}`);
          linkSync(from, to);
        },
        syncFolder: (path: string) => {
          calls.push(`syncFolder ${name(path)}`);
          flush(path, 'r');
        },
      };
    }

    it('(14a) the copy is flushed, then linked, then its folder flushed, and the backup returns after the last', async () => {
      const root = tmp();
      const live = join(root, '.realm');
      await storeWithRuns(live, 1);
      const calls: string[] = [];
      const m = await maintain(live, recording(root, calls));
      await m.backup(join(root, 'copy.db'));
      calls.push('returned');
      // (1) red when the folder flush is removed or moved before the link, or the file flush moved
      //     after it (the order differs); (2) prints the calls in order.
      expect(calls).toEqual([
        'syncFile copy.db.part-<pid>-<hex>',
        'link copy.db.part-<pid>-<hex> copy.db',
        'syncFolder <folder>',
        'returned',
      ]);
    });

    it('(14b) a folder flush the platform refuses (EPERM) is skipped, and the backup succeeds', async () => {
      const root = tmp();
      const live = join(root, '.realm');
      await storeWithRuns(live, 1);
      const m = await maintain(live, {
        syncFolder: (path) => {
          throw systemError('EPERM', 'open', path);
        },
      });
      const target = join(root, 'copy.db');
      // (1) red when EPERM is not in the skipped set (the backup is refused on Windows-like
      //     platforms); (2) prints the outcome and whether the copy is at the path.
      expect({ outcome: await outcome(m.backup(target)), atPath: existsSync(target) }).toEqual({
        outcome: 'resolved',
        atPath: true,
      });
    });

    it('(14c) a folder flush that fails (EIO) is refused after the publish, and the copy stays at the path', async () => {
      const root = tmp();
      const live = join(root, '.realm');
      await storeWithRuns(live, 1);
      const m = await maintain(live, {
        syncFolder: (path) => {
          throw systemError('EIO', 'fsync', path);
        },
      });
      const target = join(root, 'copy.db');
      const reason = systemErrorText(-constants.errno.EIO);
      // (1) red when a folder flush failure is skipped (a resolved report though the name may not
      //     survive a crash), or when it gets the "Nothing was written" sentence though the copy
      //     is there; (2) prints the refusal, whether the copy is at the path and what was left.
      expect({
        refused: await refusal(m.backup(target)),
        atPath: existsSync(target),
        left: leftovers(target),
      }).toEqual({
        refused: {
          code: 'STATE_STORE_BACKUP_REFUSED',
          message:
            `Cannot back up the store to ${target}: the copy was made and published, but its ` +
            `folder could not be flushed: ${reason}. Check the copy before you rely on it.`,
          details: { path: target, reason },
        },
        atPath: true,
        left: [],
      });
    });

    it('(14d) a file flush that fails (EIO) removes the temporary file and leaves nothing at the path', async () => {
      const root = tmp();
      const live = join(root, '.realm');
      await storeWithRuns(live, 1);
      const m = await maintain(live, {
        syncFile: (path) => {
          throw systemError('EIO', 'fsync', path);
        },
      });
      const target = join(root, 'copy.db');
      const reason = systemErrorText(-constants.errno.EIO);
      // (1) red when the file flush's failure is not converted (a raw EIO with a stack), when the
      //     temporary file is left, or when the copy is published anyway; (2) prints the refusal,
      //     the path's state and what was left beside it.
      expect({
        refused: await refusal(m.backup(target)),
        atPath: existsSync(target),
        left: leftovers(target),
      }).toEqual({
        refused: {
          code: 'STATE_STORE_BACKUP_REFUSED',
          message: `Cannot back up the store to ${target}: the copy could not be written: ${reason}. Nothing was written at ${target}.`,
          details: { path: target, reason },
        },
        atPath: false,
        left: [],
      });
    });
  });
});
