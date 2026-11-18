// maintenance-migrate-r1.test.ts — #616 R1 (prompts/feat-616-r1-migrate-record.md): the shorter
// `migrate` of the maintenance entry. With a schema step pending it takes the hold first (no other
// process may have the store file open: `STATE_STORE_IN_USE`, in about a second, nothing changed),
// reads the version again under it, makes the default copy in the backups folder beside the home when
// no target is named, and records the migrate in `migrations.jsonl` there (a failed record is a
// warning). With no step pending it does none of that. Every home nests (`<tmp>/<name>/.realm`), so
// its backups folder is its own scratch folder's, never `/tmp/.realm-backups`.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REALM_STORE_SCHEMA_VERSION,
  REALM_STORE_VERSIONS,
  systemClock,
  VERSION,
  WorkflowError,
  type CreateRunOptions,
} from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './driver.js';
import { openRealmHome, openRealmHomeForMaintenance } from './index.js';
import {
  holdStoreFile,
  openMaintenance,
  type MaintenanceHome,
  type MigrateProgress,
} from './maintenance.js';

/** Callback B1a: the steps a version-1 file takes to this Realm's version, as the recorder says them. */
const STEPS_FROM_1 = Array.from(
  { length: REALM_STORE_SCHEMA_VERSION - 1 },
  (_, i) => `step ${i + 1} to ${i + 2}`,
);
import { openRealmDb } from './open-file.js';
import { openHome } from './open-realm-home.js';
import { migrateSchema } from './schema-ladder.js';
import { openForeignConnection } from './test-support/foreign-connection.js';
import { ladder, STEP_3 } from './test-support/schema-versions.js';

const RUN: CreateRunOptions = {
  workflowId: 'triage',
  workflowVersion: 1,
  params: {},
  extensionIdentity: [],
};

const dirs: string[] = [];
const closers: Array<() => void> = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const close of closers.splice(0)) {
    try {
      close();
    } catch {
      // closed by its cell
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A scratch folder and the home nested in it: `<tmp>/<name>/.realm` (its backups folder is beside). */
function nestedHome(): { root: string; home: string; file: string; folder: string } {
  const root = mkdtempSync(join(tmpdir(), 'realm-616-r1-'));
  dirs.push(root);
  const home = join(root, '.realm');
  return {
    root,
    home,
    file: join(home, 'realm.db'),
    folder: join(root, '.realm-backups'),
  };
}

/** A home whose store file is at schema version 1 (the open's seam), holding `runs` runs. */
async function versionOneStore(home: string, runs = 1): Promise<void> {
  const h = await openHome({ home }, { schemaVersion: 1 });
  for (let i = 0; i < runs; i++) await h.runStore.create(RUN);
  h.close();
}

/** A home whose store file is at this Realm's version (2), holding one run. */
async function currentStore(home: string): Promise<void> {
  const h = await openHome({ home }, {});
  await h.runStore.create(RUN);
  h.close();
}

/** The store file's schema version, read from its header (`user_version`, bytes 60–63). */
function versionOf(file: string): number {
  return readFileSync(file).readUInt32BE(60);
}

/** The sha-256 of a file's bytes, so any change to it shows. */
function hashOf(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** What one record line holds, parsed; the file's lines when it exists. */
function recordLines(folder: string): unknown[] {
  const path = join(folder, 'migrations.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as unknown);
}

/** The events of a migrate, as short words: what the cell compares. */
function recorder(): { seen: string[]; progress: (event: MigrateProgress) => void } {
  const seen: string[] = [];
  const progress = (event: MigrateProgress): void => {
    switch (event.kind) {
      case 'backup':
        seen.push(`backup at version ${event.report.schemaVersion}`);
        break;
      case 'step':
        seen.push(`step ${event.report.from} to ${event.report.to}`);
        break;
      case 'current':
        seen.push(`already at ${event.schemaVersion}`);
        break;
      case 'restamped':
        seen.push(`restamped ${event.runs}`);
        break;
      case 'recorded':
        seen.push(`recorded in ${event.path}`);
        break;
      case 'unrecorded':
        seen.push(`unrecorded in ${event.path}: ${event.reason}`);
        break;
    }
  };
  return { seen, progress };
}

/** Opens a home for maintenance, for `migrate`; the cleanup closes it. */
async function maintain(
  home: string,
  seams: Parameters<typeof openMaintenance>[1] = {},
): Promise<MaintenanceHome> {
  const handle = await openMaintenance({ home, verb: 'migrate' }, seams);
  closers.push(() => handle.close());
  return handle;
}

/** A rejection as a reader sees it: a typed refusal's code, message and details, or `resolved`. */
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

// Another PROCESS that has the store file open and does nothing: one read, then idle (CB-K-32's
// "idle after one read"). It opens the file through the store's own test entry (the one loader of
// the built-in SQLite stays the only code that names it); its standard error is dropped.
const HOLDER =
  "import { openForeignConnection } from '@sensigo/realm-store-sqlite/test-support';" +
  'const db = await openForeignConnection(process.argv[1]);' +
  "db.prepare('SELECT count(*) FROM sqlite_master').get();" +
  "process.stdout.write('ready\\n');" +
  'setInterval(() => {}, 1000);';

/** The package's root: the holder resolves the package's own test entry from there. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Starts a process that holds the home's store file open, idle; resolves once it has read it. */
function holdOpen(home: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', HOLDER, home], {
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.stdout!.once('data', () => resolve(child));
    child.once('exit', (code) => reject(new Error(`the holder exited (${code}) before it read`)));
  });
}

/** Stops a holder and waits until it is gone. */
function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

const IN_USE = (file: string): string =>
  `Another process has ${file} open: a Realm agent, server or command, an MCP server that an ` +
  'assistant or editor keeps running, or another program such as a SQLite browser. Stop it and ' +
  'run this again. Nothing was changed.';

describe('#616 R1 — the shorter migrate: the hold, the default copy and the record', () => {
  it(
    'a step pending while another process has the file open, idle: refused STATE_STORE_IN_USE in about a second, and nothing changed (no copy, no record, no folder, no temporary file, every byte of the file)',
    { timeout: 20_000 },
    async () => {
      const { root, home, file } = nestedHome();
      await versionOneStore(home);
      const holder = await holdOpen(home);
      const before = hashOf(file);
      const m = await maintain(home);
      const started = Date.now();
      const refused = await refusal(m.migrate({}));
      const elapsed = Date.now() - started;
      m.close();
      await stop(holder);
      // (1) red when the hold is missing (the migrate goes ahead: resolved, the folder made), taken
      //     after the backup (the folder and the copy exist), or sent through the store's busy wait
      //     (STATE_RUN_BUSY after 5 s: the code and the time); (2) prints the refusal, the time, what
      //     the scratch folder holds and whether the file changed.
      expect({
        refused,
        withinAboutASecond: elapsed < 4_500,
        root: readdirSync(root),
        unchanged: hashOf(file) === before,
      }).toEqual({
        refused: {
          code: 'STATE_STORE_IN_USE',
          message: IN_USE(file),
          details: { path: file },
        },
        withinAboutASecond: true,
        root: ['.realm'],
        unchanged: true,
      });
    },
  );

  it(
    'a file at this Realm’s version with an idle process holding it: no hold is taken, the already-at and re-stamp events, nothing made',
    { timeout: 20_000 },
    async () => {
      const { root, home } = nestedHome();
      await currentStore(home);
      const holder = await holdOpen(home);
      const m = await maintain(home);
      const r = recorder();
      const outcome = await refusal(m.migrate({ progress: r.progress }));
      m.close();
      await stop(holder);
      // (1) red when the hold is taken at the open, or for every migrate (refused STATE_STORE_IN_USE),
      //     or when a current file gets a copy or a record; (2) prints the outcome, the events and the
      //     scratch folder.
      expect({ outcome, seen: r.seen, root: readdirSync(root) }).toEqual({
        outcome: 'resolved',
        seen: [`already at ${REALM_STORE_SCHEMA_VERSION}`, 'restamped 0'],
        root: ['.realm'],
      });
    },
  );

  it('no target named, a step pending: the copy in the backups folder (0700), named by the versions and the UTC second; one record line (0600) with its six fields', async () => {
    const { home, file, folder } = nestedHome();
    await versionOneStore(home, 2);
    const m = await maintain(home);
    const r = recorder();
    const report = await m.migrate({ progress: r.progress });
    m.close();
    const copy = report.backup?.path ?? '';
    const copyDb = openDatabase(copy);
    const quick = copyDb.prepare('PRAGMA quick_check').get();
    copyDb.close();
    const [record] = recordLines(folder) as Array<Record<string, unknown>>;
    // (1) red when no default copy is made, when it is named otherwise or put elsewhere, when the
    //     folder or the record is readable by others, when a field is missing, misnamed or out of
    //     order, or when the record is not written; (2) prints the events, the copy's name and check,
    //     the modes, the record's keys and values, and the file's version.
    expect({
      seen: r.seen,
      name: copy.startsWith(folder + '/') ? copy.slice(folder.length + 1) : copy,
      quick,
      copyVersion: versionOf(copy),
      folderMode: (statSync(folder).mode & 0o777).toString(8),
      recordMode: (statSync(join(folder, 'migrations.jsonl')).mode & 0o777).toString(8),
      keys: Object.keys(record ?? {}),
      record: { ...record, at: typeof record?.['at'] },
      atIsAnInstant: !Number.isNaN(Date.parse(String(record?.['at']))),
      version: versionOf(file),
    }).toEqual({
      seen: [
        'backup at version 1',
        ...STEPS_FROM_1,
        `recorded in ${join(folder, 'migrations.jsonl')}`,
        'restamped 0',
      ],
      name: expect.stringMatching(
        new RegExp(`^realm-v1-to-v${REALM_STORE_SCHEMA_VERSION}-\\d{8}T\\d{6}Z\\.db$`),
      ),
      quick: { quick_check: 'ok' },
      copyVersion: 1,
      folderMode: '700',
      recordMode: '600',
      keys: ['at', 'home', 'from_format', 'to_format', 'backup', 'migrated_by'],
      record: {
        at: 'string',
        home: realpathSync(home),
        from_format: 1,
        to_format: REALM_STORE_SCHEMA_VERSION,
        backup: copy,
        migrated_by: VERSION,
      },
      atIsAnInstant: true,
      version: REALM_STORE_SCHEMA_VERSION,
    });
  });

  it('--no-backup and --backup <path>: no copy, and the copy at the path; the record still goes to the backups folder, its backup null and the path', async () => {
    const a = nestedHome();
    const b = nestedHome();
    await versionOneStore(a.home);
    await versionOneStore(b.home);
    const target = join(b.root, 'before-upgrade.db');
    const ma = await maintain(a.home);
    await ma.migrate({ backup: false });
    ma.close();
    const mb = await maintain(b.home);
    await mb.migrate({ backup: target });
    mb.close();
    const backupOf = (folder: string): unknown =>
      (recordLines(folder) as Array<Record<string, unknown>>).map((r) => r['backup']);
    // (1) red when the default copy overrides a flag, or when the record is skipped or put beside
    //     the named copy; (2) prints each folder and each record's backup.
    expect({
      aFolder: readdirSync(a.folder).sort(),
      aBackup: backupOf(a.folder),
      bRoot: readdirSync(b.root).sort(),
      bFolder: readdirSync(b.folder).sort(),
      bBackup: backupOf(b.folder),
    }).toEqual({
      aFolder: ['migrations.jsonl'],
      aBackup: [null],
      bRoot: ['.realm', '.realm-backups', 'before-upgrade.db'],
      bFolder: ['migrations.jsonl'],
      bBackup: [target],
    });
  });

  it('the backups folder cannot be made (a file where it should be): with no target named, refused STATE_STORE_MIGRATE_REFUSED and nothing changed; with --no-backup the file is migrated and the record is a warning', async () => {
    const { home, file, folder } = nestedHome();
    await versionOneStore(home);
    writeFileSync(folder, 'not a folder');
    const before = hashOf(file);
    const first = await maintain(home);
    const refused = await refusal(first.migrate({}));
    first.close();
    const unchanged = hashOf(file) === before;
    const second = await maintain(home);
    const r = recorder();
    const outcome = await refusal(second.migrate({ backup: false, progress: r.progress }));
    second.close();
    const reason = 'not a directory';
    // (1) red when the default refuses with another code or words, changes the file, or when
    //     --no-backup is refused too (the refusal's own way out); (2) prints the refusal, the file,
    //     the second outcome and its events.
    expect({ refused, unchanged, outcome, seen: r.seen, version: versionOf(file) }).toEqual({
      refused: {
        code: 'STATE_STORE_MIGRATE_REFUSED',
        message:
          `Cannot make the backups folder ${folder}: ${reason}. Nothing was changed. Use ` +
          '--backup <path> to name another place, or --no-backup.',
        details: { path: folder, reason },
      },
      unchanged: true,
      outcome: 'resolved',
      seen: [
        ...STEPS_FROM_1,
        `unrecorded in ${join(folder, 'migrations.jsonl')}: ${reason}`,
        'restamped 0',
      ],
      version: REALM_STORE_SCHEMA_VERSION,
    });
  });

  it('the record cannot be written (a folder where migrations.jsonl should be): a warning, and the file migrated', async () => {
    const { home, file, folder } = nestedHome();
    await versionOneStore(home);
    mkdirSync(join(folder, 'migrations.jsonl'), { recursive: true });
    const m = await maintain(home);
    const r = recorder();
    const outcome = await refusal(m.migrate({ progress: r.progress }));
    m.close();
    // (1) red when a failed record fails the migrate, or is not reported; (2) prints the outcome,
    //     the events and the file's version.
    expect({ outcome, seen: r.seen, version: versionOf(file) }).toEqual({
      outcome: 'resolved',
      seen: [
        'backup at version 1',
        ...STEPS_FROM_1,
        `unrecorded in ${join(folder, 'migrations.jsonl')}: illegal operation on a directory`,
        'restamped 0',
      ],
      version: REALM_STORE_SCHEMA_VERSION,
    });
  });

  it('a later step fails after an earlier one committed: one record line, for the steps committed', async () => {
    const { home, folder } = nestedHome();
    await versionOneStore(home);
    // Version 3's step builds its index on the other column: its result is not version 3's schema
    // (the store's cell (B) of maintenance-migrate-616.test.ts).
    const drift = [...STEP_3.slice(0, -1), 'CREATE INDEX ladder_notes_by_k ON ladder_notes (w)'];
    const m = await maintain(home, { schemaVersion: 3, versions: ladder(drift) });
    const r = recorder();
    const failed = await refusal(m.migrate({ backup: false, progress: r.progress }));
    m.close();
    const records = recordLines(folder) as Array<Record<string, unknown>>;
    // (1) red when a migrate that moved the file before its failure leaves no record, or records
    //     the step that failed; (2) prints the code, the events and the record's versions.
    expect({
      code: (failed as { code?: unknown }).code,
      seen: r.seen,
      records: records.map((x) => [x['from_format'], x['to_format'], x['backup']]),
    }).toEqual({
      code: 'STATE_STORE_MIGRATE_FAILED',
      seen: ['step 1 to 2', `recorded in ${join(folder, 'migrations.jsonl')}`],
      records: [[1, 2, null]],
    });
  });

  it(`the version is read again under the hold: a file another writer moves to version ${REALM_STORE_SCHEMA_VERSION} after migrate read version 1, before its hold, gets no copy, no record and no step`, async () => {
    const { root, home } = nestedHome();
    await versionOneStore(home);
    // The window between migrate's first read and its hold (the seam): another writer moves the file
    // to this Realm's version, as a migrate that took the hold and finished there would, and lets go
    // of it.
    const late = await maintain(home, {
      beforeHold: async () => {
        const other = await openForeignConnection(home);
        try {
          migrateSchema(other, REALM_STORE_SCHEMA_VERSION, REALM_STORE_VERSIONS);
        } finally {
          other.close();
        }
      },
    });
    const r = recorder();
    const outcome = await refusal(late.migrate({ progress: r.progress }));
    late.close();
    // (1) red when the version is not read again under the hold (a copy and a record are made, and
    //     the step is run on a file already at this Realm's version); (2) prints the outcome, the
    //     events and the scratch folder.
    expect({ outcome, seen: r.seen, root: readdirSync(root) }).toEqual({
      outcome: 'resolved',
      seen: [`already at ${REALM_STORE_SCHEMA_VERSION}`, 'restamped 0'],
      root: ['.realm'],
    });
  });

  it('the hold is let go when the migrate is done: another connection can write while the handle is still open', async () => {
    const { home } = nestedHome();
    await versionOneStore(home);
    const m = await openRealmHomeForMaintenance({ home, verb: 'migrate' });
    closers.push(() => m.close());
    await m.migrate({ backup: false });
    const other = await openForeignConnection(home);
    let wrote: string;
    try {
      other.exec('PRAGMA busy_timeout = 0');
      other.exec('BEGIN IMMEDIATE');
      other.exec('COMMIT');
      wrote = 'wrote';
    } catch (err) {
      wrote = (err as Error).message;
    } finally {
      other.close();
    }
    m.close();
    // (1) red when the hold outlives the migrate (the other connection is refused "database is
    //     locked"); (2) prints what the other connection got.
    expect(wrote).toBe('wrote');
  });

  it(
    'while the hold is kept, a Realm open of the same home waits its 5 s budget, then fails STATE_RUN_BUSY (the docs\u2019 "waits about 5 seconds, then fails as busy")',
    { timeout: 30_000 },
    async () => {
      const { home, file } = nestedHome();
      await versionOneStore(home);
      const db = await openRealmDb(home, { clock: systemClock, acceptOlderSchema: true });
      closers.push(() => db.close());
      const hold = await holdStoreFile(db, file);
      const started = Date.now();
      const opened = await refusal(openRealmHome({ home }));
      const waited = Date.now() - started;
      await hold.release();
      db.close();
      // (1) red when another Realm process's open gets through the hold, or fails at once with
      //     another code; (2) prints the open's outcome and how long it waited.
      expect({
        code: (opened as { code?: unknown }).code,
        waitedAboutFiveSeconds: waited >= 4_500 && waited < 12_000,
      }).toEqual({ code: 'STATE_RUN_BUSY', waitedAboutFiveSeconds: true });
    },
  );
});
