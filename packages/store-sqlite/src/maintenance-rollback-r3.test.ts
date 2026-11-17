// maintenance-rollback-r3.test.ts — #616 R3 (prompts/feat-616-r3-rollback.md): `rollback`, the handle's
// undo of the last migrate recorded for its home. It reads the last valid line of `migrations.jsonl`
// for the home, checks the file is at that line's `to_format` and that the line is a forward migrate,
// then runs R2's step back given the line: under the hold the file must still be at the line's
// `to_format`, a step that cannot be undone names THAT migrate's backup, and a backups folder that
// cannot be written names `realm db migrate --to`. These are the cells that need a seam (the versions,
// `beforeHold`) or a second process; the CLI's cells (`rollback-r3.test.ts`) run the built command.
// Every home nests (`<tmp>/<name>/.realm`), so its backups folder is its own scratch folder's.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REALM_STORE_VERSIONS,
  WorkflowError,
  type CreateRunOptions,
  type StoreSchemaVersion,
  type StoreSchemaVersions,
} from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { openMaintenance, type MaintenanceHome, type MigrateProgress } from './maintenance.js';
import { openHome } from './open-realm-home.js';
import { migrateSchema, stepBackSchema } from './schema-ladder.js';
import { openForeignConnection } from './test-support/foreign-connection.js';
import {
  STEP_2,
  STEP_3,
  V2_TABLE,
  V2_TAGS,
  V3_INDEX,
  V3_TABLE,
} from './test-support/schema-versions.js';

const AS_ROOT = process.getuid?.() === 0;

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
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(join(d, '.realm-backups'), 0o700);
    } catch {
      // no backups folder
    }
    rmSync(d, { recursive: true, force: true });
  }
});

/** A scratch folder and the home nested in it: `<tmp>/<name>/.realm` (its backups folder is beside). */
function nestedHome(): { root: string; home: string; file: string; folder: string } {
  const root = mkdtempSync(join(tmpdir(), 'realm-616-r3-'));
  dirs.push(root);
  const home = join(root, '.realm');
  return { root, home, file: join(home, 'realm.db'), folder: join(root, '.realm-backups') };
}

const REAL_2 = REALM_STORE_VERSIONS.get(2)!.schema;
/** Version 3's step back: the two synthetic tables dropped, the file at the real version 2. */
const V3_DOWN = ['DROP TABLE ladder_notes', 'DROP TABLE ladder_tags'];
/** Version 4's step back: the index dropped and the table rebuilt without its second column. */
const V4_DOWN = [
  'DROP INDEX ladder_notes_by_k',
  'ALTER TABLE ladder_notes RENAME TO ladder_notes_new',
  V2_TABLE,
  'INSERT INTO ladder_notes (k) SELECT k FROM ladder_notes_new',
  'DROP TABLE ladder_notes_new',
];
/** Why version 3's step cannot be undone, in the ladder that says so. */
const KEPT = 'its two tables are kept on purpose';

/**
 * Core's versions 1 and 2, then two synthetic versions above them (3 adds two tables, 4 rebuilds one),
 * each with a step back (as R2's cells build it); `three` replaces version 3's fields that say how it
 * is undone.
 */
function backLadder(
  three: Partial<StoreSchemaVersion> = { downgrade: V3_DOWN },
): StoreSchemaVersions {
  return new Map([
    ...REALM_STORE_VERSIONS,
    [3, { schema: [...REAL_2, V2_TABLE, V2_TAGS], upgrade: STEP_2, ...three }],
    [4, { schema: [...REAL_2, V3_TABLE, V2_TAGS, V3_INDEX], upgrade: STEP_3, downgrade: V4_DOWN }],
  ]);
}

/** A home whose store file is made at `version` under `versions`, holding one run. */
async function storeAt(
  home: string,
  version: number,
  versions: StoreSchemaVersions = REALM_STORE_VERSIONS,
): Promise<void> {
  const h = await openHome({ home }, { schemaVersion: version, versions });
  await h.runStore.create(RUN);
  h.close();
}

/** Opens a home for maintenance, for `verb`, through the seams; the cleanup closes it. */
async function maintain(
  home: string,
  seams: Parameters<typeof openMaintenance>[1] = {},
  verb: 'migrate' | 'rollback' = 'rollback',
): Promise<MaintenanceHome> {
  const handle = await openMaintenance({ home, verb }, seams);
  closers.push(() => handle.close());
  return handle;
}

/** A forward migrate through the store API (it writes the record line), then the handle closed. */
async function migrateForward(
  home: string,
  seams: Parameters<typeof openMaintenance>[1] = {},
  backup?: false,
): Promise<void> {
  const m = await maintain(home, seams, 'migrate');
  await m.migrate(backup === false ? { backup: false } : {});
  m.close();
}

/** Moves the home's store file, from another connection: up the ladder, or back, unrecorded. */
async function moveForeign(home: string, versions: StoreSchemaVersions, to: number): Promise<void> {
  const db = await openForeignConnection(home);
  try {
    let at = Number(db.prepare('PRAGMA user_version').get()?.['user_version']);
    if (to > at) migrateSchema(db, to, versions);
    while (at > to) stepBackSchema(db, at--, versions);
  } finally {
    db.close();
  }
}

/** The store file's schema version, read from its header (`user_version`, bytes 60–63). */
function versionOf(file: string): number {
  return readFileSync(file).readUInt32BE(60);
}

/** The sha-256 of a file's bytes, so any change to it shows. */
function hashOf(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** The record file's lines, parsed; none when it does not exist. */
function recordLines(folder: string): Array<Record<string, unknown>> {
  const path = join(folder, 'migrations.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** What a cell sees of the scratch folder: the file's hash and version, the backups and the record. */
function stateOf(file: string, folder: string): unknown {
  return {
    hash: hashOf(file),
    version: versionOf(file),
    backups: existsSync(folder) ? readdirSync(folder).sort() : 'no folder',
    record: recordLines(folder).length,
  };
}

/** The events of a rollback, as short words. */
function recorder(): { seen: string[]; progress: (event: MigrateProgress) => void } {
  const seen: string[] = [];
  const progress = (event: MigrateProgress): void => {
    switch (event.kind) {
      case 'rollingBack':
        seen.push(`rolling back ${event.from} to ${event.to}`);
        break;
      case 'stepBack':
        seen.push(`back ${event.report.from} to ${event.report.to}`);
        break;
      default:
        seen.push(event.kind);
    }
  };
  return { seen, progress };
}

/** A rejection as a reader sees it: a typed refusal's code and message, or `resolved`. */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err instanceof WorkflowError
      ? { code: err.code, message: err.message }
      : `${(err as Error).name}: ${(err as Error).message}`;
  }
}

/** Whether another connection can write to the store file now (the hold let go). */
async function writable(home: string): Promise<boolean> {
  const db = await openForeignConnection(home);
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

describe('#616 R3 — rollback: a step that cannot be undone names that migrate’s backup', () => {
  it('the migrate made a backup: its path; `migrate --to` keeps the generic words; nothing changed', async () => {
    const { home, file, folder } = nestedHome();
    const versions = backLadder({ cannotUndo: KEPT });
    await storeAt(home, 2, versions);
    await migrateForward(home, { schemaVersion: 4, versions });
    const backup = String(recordLines(folder)[0]?.['backup']);
    const before = stateOf(file, folder);
    const r = recorder();
    const rolled = await refusal(
      (await maintain(home, { schemaVersion: 4, versions })).rollback({ progress: r.progress }),
    );
    const viaTo = await refusal(
      (await maintain(home, { schemaVersion: 4, versions }, 'migrate')).migrate({ to: 2 }),
    );
    // (1) red when the rollback's refusal keeps the generic words or names another path, or when
    //     `--to`'s own refusal takes the rollback's; (2) prints both refusals and the folder's state.
    expect({ rolled, viaTo, seen: r.seen, after: stateOf(file, folder) }).toEqual({
      rolled: {
        code: 'STATE_STORE_MIGRATE_REFUSED',
        message:
          `The step from schema version 3 to 2 cannot be undone: ${KEPT}. Nothing was changed. ` +
          `To go back anyway, restore the backup that migrate made: realm db restore ${backup}.`,
      },
      viaTo: {
        code: 'STATE_STORE_MIGRATE_REFUSED',
        message:
          `The step from schema version 3 to 2 cannot be undone: ${KEPT}. Nothing was changed. ` +
          'To go back anyway, restore a backup made before the upgrade: realm db restore <backup> ' +
          `(the backups realm db migrate makes are in ${folder}/).`,
      },
      // The progress line is printed before the flow judges its plan.
      seen: ['rolling back 2 to 4'],
      after: before,
    });
    expect(backup).toMatch(/realm-v2-to-v4-\d{8}T\d{6}Z\.db$/);
  });

  it('the migrate made no backup (`--no-backup`): the other sentence; nothing changed', async () => {
    const { home, file, folder } = nestedHome();
    const versions = backLadder({ cannotUndo: KEPT });
    await storeAt(home, 2, versions);
    await migrateForward(home, { schemaVersion: 4, versions }, false);
    const before = stateOf(file, folder);
    const rolled = await refusal((await maintain(home, { schemaVersion: 4, versions })).rollback());
    // (1) red when a `null` backup is printed as a path, or the generic words are used; (2) prints
    //     the refusal and the folder's state.
    expect({
      line: recordLines(folder)[0]?.['backup'],
      rolled,
      after: stateOf(file, folder),
    }).toEqual({
      line: null,
      rolled: {
        code: 'STATE_STORE_MIGRATE_REFUSED',
        message:
          `The step from schema version 3 to 2 cannot be undone: ${KEPT}. Nothing was changed. ` +
          'That migrate made no backup: restore one of your own with realm db restore <backup> ' +
          `(the backups realm db migrate makes are in ${folder}/).`,
      },
      after: before,
    });
  });
});

describe('#616 R3 — rollback: the backups folder cannot be written', () => {
  it.skipIf(AS_ROOT || process.platform === 'win32')(
    'the rollback names `realm db migrate --to <from>`; `migrate --to`’s own words stay; the hold released',
    async () => {
      const { home, file, folder } = nestedHome();
      await storeAt(home, 1);
      await migrateForward(home);
      // A file where the folder should be cannot be the case here: the record is IN that folder, so
      // its read fails first (state 2). A folder that cannot be written is the case that remains.
      chmodSync(folder, 0o500);
      const before = stateOf(file, folder);
      const r = await maintain(home);
      const rolled = await refusal(r.rollback());
      // Read while the rollback's handle is still open: its hold must be let go.
      const free = await writable(home);
      r.close();
      const viaTo = await refusal((await maintain(home, {}, 'migrate')).migrate({ to: 1 }));
      chmodSync(folder, 0o700);
      // (1) red when the rollback advises flags it cannot take, or `--to`'s refusal loses its own
      //     words; (2) prints both refusals, whether the file is free, and the folder's state.
      expect({ rolled, viaTo, free, after: stateOf(file, folder) }).toEqual({
        rolled: {
          code: 'STATE_STORE_MIGRATE_REFUSED',
          message:
            `Cannot make the backups folder ${folder}: permission denied. Nothing was changed. Use ` +
            'realm db migrate --to 1 with --backup <path> to name another place, or --no-backup.',
        },
        viaTo: {
          code: 'STATE_STORE_MIGRATE_REFUSED',
          message:
            `Cannot make the backups folder ${folder}: permission denied. Nothing was changed. Use ` +
            '--backup <path> to name another place, or --no-backup.',
        },
        free: true,
        after: before,
      });
    },
  );
});

describe('#616 R3 — rollback: the file moved before the hold, or since the record', () => {
  it('moved down between the record check and the hold: state 4, nothing torn, the hold released', async () => {
    const { home, file, folder } = nestedHome();
    const versions = backLadder();
    await storeAt(home, 2, versions);
    await migrateForward(home, { schemaVersion: 4, versions }, false);
    const at = recordLines(folder)[0]?.['at'];
    const m = await maintain(home, {
      schemaVersion: 4,
      versions,
      beforeHold: () => moveForeign(home, versions, 3),
    });
    const rolled = await refusal(m.rollback());
    m.close();
    // (1) red when the plan under the hold is judged against the target only (version 3 would be
    //     stepped back to 2), or the hold is not released; (2) prints the refusal and the file.
    expect({
      rolled,
      version: versionOf(file),
      free: await writable(home),
      record: recordLines(folder).length,
    }).toEqual({
      rolled: {
        code: 'STATE_STORE_MIGRATE_REFUSED',
        message:
          `The last record for ${home} (${String(at)}) took the store file from schema version 2 to ` +
          '4, but it is at schema version 3 now. Realm does not know what to roll back. Use realm ' +
          'db migrate --to <n> to choose the version yourself, or realm db restore <backup>. ' +
          'Nothing was changed.',
      },
      version: 3,
      free: true,
      record: 1,
    });
  });

  it('moved up between the record check and the hold: state 4, nothing torn, the hold released', async () => {
    const { home, file, folder } = nestedHome();
    const versions = backLadder();
    await storeAt(home, 2, versions);
    await migrateForward(home, { schemaVersion: 3, versions }, false);
    const at = recordLines(folder)[0]?.['at'];
    const m = await maintain(home, {
      schemaVersion: 4,
      versions,
      beforeHold: () => moveForeign(home, versions, 4),
    });
    const rolled = await refusal(m.rollback());
    m.close();
    // (1) red when a file moved ABOVE the line's `to_format` is stepped back further (to 2, through
    //     4 and 3); (2) prints the refusal and the file.
    expect({ rolled, version: versionOf(file), free: await writable(home) }).toEqual({
      rolled: {
        code: 'STATE_STORE_MIGRATE_REFUSED',
        message:
          `The last record for ${home} (${String(at)}) took the store file from schema version 2 to ` +
          '3, but it is at schema version 4 now. Realm does not know what to roll back. Use realm ' +
          'db migrate --to <n> to choose the version yourself, or realm db restore <backup>. ' +
          'Nothing was changed.',
      },
      version: 4,
      free: true,
    });
  });

  it('a later change nobody recorded (the version set from another connection): state 4, nothing changed', async () => {
    const { home, file, folder } = nestedHome();
    const versions = backLadder();
    await storeAt(home, 2, versions);
    await migrateForward(home, { schemaVersion: 4, versions }, false);
    await moveForeign(home, versions, 3);
    const at = recordLines(folder)[0]?.['at'];
    const before = stateOf(file, folder);
    const r = recorder();
    const rolled = await refusal(
      (await maintain(home, { schemaVersion: 4, versions })).rollback({ progress: r.progress }),
    );
    // (1) red when the rollback trusts the record without the file's version (the progress line is
    //     printed, or 3 is stepped back to 2); (2) prints the refusal, the events and the folder.
    expect({ rolled, seen: r.seen, after: stateOf(file, folder) }).toEqual({
      rolled: {
        code: 'STATE_STORE_MIGRATE_REFUSED',
        message:
          `The last record for ${home} (${String(at)}) took the store file from schema version 2 to ` +
          '4, but it is at schema version 3 now. Realm does not know what to roll back. Use realm ' +
          'db migrate --to <n> to choose the version yourself, or realm db restore <backup>. ' +
          'Nothing was changed.',
      },
      seen: [],
      after: before,
    });
  });
});

// Another PROCESS that has the store file open and does nothing: one read, then idle. It opens the
// file through the store's own test entry; its standard error is dropped.
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

describe('#616 R3 — rollback: another process holding the store', () => {
  it(
    'refused STATE_STORE_IN_USE; no copy, no new record line, every byte unchanged',
    { timeout: 20_000 },
    async () => {
      const { home, file, folder } = nestedHome();
      await storeAt(home, 1);
      await migrateForward(home);
      const holder = await holdOpen(home);
      const before = stateOf(file, folder);
      const rolled = await refusal((await maintain(home)).rollback());
      holder.kill('SIGKILL');
      // (1) red when the rollback takes no hold (the copy is made and the file stepped back); (2) prints
      //     the refusal and the folder's state.
      expect({ rolled, after: stateOf(file, folder) }).toEqual({
        rolled: {
          code: 'STATE_STORE_IN_USE',
          message:
            `Another process has ${file} open: a Realm agent, server or command, an MCP server that ` +
            'an assistant or editor keeps running, or another program such as a SQLite browser. ' +
            'Stop it and run this again. Nothing was changed.',
        },
        after: before,
      });
    },
  );
});
