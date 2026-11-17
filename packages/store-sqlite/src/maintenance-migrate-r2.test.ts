// maintenance-migrate-r2.test.ts — #616 R2 (prompts/feat-616-r2-step-back.md): `migrate` given `to`, the
// step back. It judges the whole plan before any change (a version it does not know, a file below the
// version asked for, a step that cannot be undone are refused and nothing changes), takes R1's hold,
// reads the version again and judges the plan again, makes the copy, then undoes each step in its own
// transaction (the version's own statements, the ladder's compare with the version below), records the
// step back and says how to install the older Realm. The synthetic versions sit ABOVE the real version 2
// (`backLadder`), so the real `DROP TABLE outbound` runs in the three-step cell. Every home nests
// (`<tmp>/<name>/.realm`), so its backups folder is its own scratch folder's.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
import { openDatabase } from './driver.js';
import {
  openMaintenance,
  stepBackTarget,
  type MaintenanceHome,
  type MigrateProgress,
} from './maintenance.js';
import { openHome } from './open-realm-home.js';
import { migrateSchema, stepBackSchema, storedSchemaDifference } from './schema-ladder.js';
import { openForeignConnection } from './test-support/foreign-connection.js';
import {
  STEP_2,
  STEP_3,
  V2_TABLE,
  V2_TAGS,
  V3_INDEX,
  V3_TABLE,
} from './test-support/schema-versions.js';

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
  const root = mkdtempSync(join(tmpdir(), 'realm-616-r2-'));
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

/**
 * Core's versions 1 and 2, then two synthetic versions above them (3 adds two tables, 4 rebuilds one),
 * each with a step back; `three` replaces version 3's fields that say how it is undone.
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

/** A home whose store file is made at `version` under `versions`, holding `runs` runs; their ids. */
async function storeAt(
  home: string,
  version: number,
  versions: StoreSchemaVersions = REALM_STORE_VERSIONS,
  runs = 1,
): Promise<string[]> {
  const h = await openHome({ home }, { schemaVersion: version, versions });
  const ids: string[] = [];
  for (let i = 0; i < runs; i++) ids.push((await h.runStore.create(RUN)).record.id);
  h.close();
  return ids;
}

/** Writes one `outbound` row per status (`pending`, `sent`, `failed`) into the home's store file. */
async function outboundRows(home: string): Promise<void> {
  const db = await openForeignConnection(home);
  try {
    const insert = db.prepare(
      'INSERT INTO outbound (run_id, entry_key, type, status, lease_token, lease_deadline, attempts, ' +
        "created_at) VALUES ('r', ?, 'reminder', ?, 't', '2026-01-01T00:00:00.000Z', 1, " +
        "'2026-01-01T00:00:00.000Z')",
    );
    for (const [key, status] of [
      ['a', 'pending'],
      ['b', 'sent'],
      ['c', 'failed'],
    ]) {
      insert.run(key, status);
    }
  } finally {
    db.close();
  }
}

/** Moves the home's store file, from another connection: up the ladder, or back one version. */
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

/** What the record file holds, parsed; none when it does not exist. */
function recordLines(folder: string): Array<Record<string, unknown>> {
  const path = join(folder, 'migrations.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** A record line's fields a cell compares (the time and the Realm version vary). */
function recorded(line: Record<string, unknown> | undefined): unknown {
  return line === undefined
    ? 'no line'
    : { from: line['from_format'], to: line['to_format'], backup: line['backup'] };
}

/** The events of a step back, as short words. */
function recorder(): { seen: string[]; progress: (event: MigrateProgress) => void } {
  const seen: string[] = [];
  const progress = (event: MigrateProgress): void => {
    switch (event.kind) {
      case 'backup':
        seen.push(`backup at version ${event.report.schemaVersion}`);
        break;
      case 'stepBack':
        seen.push(
          `back ${event.report.from} to ${event.report.to}, ${event.report.statements} statement(s)` +
            (event.loses === undefined ? '' : `: ${event.loses}`),
        );
        break;
      case 'nothingToUndo':
        seen.push(`nothing to undo at ${event.schemaVersion}`);
        break;
      case 'install':
        seen.push(`install ${event.range} for ${event.schemaVersion}, realm ${event.realm}`);
        break;
      case 'recorded':
        seen.push('recorded');
        break;
      default:
        seen.push(event.kind);
    }
  };
  return { seen, progress };
}

/** Opens a home for maintenance, for `migrate`, through the seams; the cleanup closes it. */
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

const SENT_1 =
  'The outbound table was dropped: the record of 1 reminder(s) and escalation(s) sent is gone.';
const SENT_NONE =
  'The outbound table was dropped; it held no record of a reminder or escalation sent.';

describe('#616 R2 — migrate --to, the step back', () => {
  it('three steps back from version 4 to 1, the real version 2 last: every run kept, the file exactly version 1’s, one record line from 4 to 1, the default copy named by both versions, the install line for 0.49', async () => {
    const { home, file, folder } = nestedHome();
    const seams = { schemaVersion: 4, versions: backLadder() };
    const ids = await storeAt(home, 4, seams.versions, 2);
    await outboundRows(home);
    const m = await maintain(home, seams);
    const r = recorder();
    const report = await m.migrate({ to: 1, progress: r.progress });
    m.close();
    const db = openDatabase(file);
    const runs = db
      .prepare('SELECT id FROM runs ORDER BY id')
      .all()
      .map((row) => row['id']);
    const difference = storedSchemaDifference(db, REALM_STORE_VERSIONS.get(1)!.schema);
    db.close();
    const names = readdirSync(folder).sort();
    // (1) red when a step is skipped or run out of order, a run is lost, the schema is not version 1's,
    //     the copy or the record is missing or misnamed, or the install line names another range;
    //     (2) prints the events, the steps' reports, the runs, the schema difference, the version, the
    //     folder and the record.
    expect({
      seen: r.seen,
      stepsBack: report.stepsBack,
      runs,
      difference,
      version: versionOf(file),
      names,
      record: recordLines(folder).map(recorded),
    }).toEqual({
      seen: [
        'backup at version 4',
        'back 4 to 3, 5 statement(s)',
        'back 3 to 2, 2 statement(s)',
        `back 2 to 1, 1 statement(s): ${SENT_1}`,
        'recorded',
        'install 0.49 for 1, realm 4',
      ],
      stepsBack: [
        { from: 4, to: 3, statements: 5 },
        { from: 3, to: 2, statements: 2 },
        { from: 2, to: 1, statements: 1, lost: 1 },
      ],
      runs: [...ids].sort(),
      difference: { missing: [], extra: [], changed: [] },
      version: 1,
      names: ['migrations.jsonl', expect.stringMatching(/^realm-v4-to-v1-\d{8}T\d{6}Z\.db$/)],
      record: [{ from: 4, to: 1, backup: join(folder, names[1] ?? 'no copy') }],
    });
  });

  it('the loss count reads the rows recorded as sent before the drop: 1 of one row per status; a fresh file says it held none', async () => {
    const withRows = nestedHome();
    await storeAt(withRows.home, 2);
    await outboundRows(withRows.home);
    const fresh = nestedHome();
    await storeAt(fresh.home, 2);
    const seen: string[] = [];
    for (const { home } of [withRows, fresh]) {
      const m = await maintain(home);
      const r = recorder();
      await m.migrate({ to: 1, backup: false, progress: r.progress });
      m.close();
      seen.push(...r.seen.filter((s) => s.startsWith('back')));
    }
    // (1) red when the count is `COUNT(*)` (3 for the three rows), or the zero sentence is not used;
    //     (2) prints the two step lines.
    expect(seen).toEqual([
      `back 2 to 1, 1 statement(s): ${SENT_1}`,
      `back 2 to 1, 1 statement(s): ${SENT_NONE}`,
    ]);
  });

  it('--to equal to the file’s version: the nothing-to-undo event, no hold, no copy (a given target ignored), no record, no folder', async () => {
    const { root, home, file } = nestedHome();
    await storeAt(home, 2);
    const before = hashOf(file);
    const target = join(root, 'asked-for.db');
    const outcomes: unknown[] = [];
    for (const backup of [undefined, target]) {
      const m = await maintain(home);
      const r = recorder();
      const report = await m.migrate({
        to: 2,
        progress: r.progress,
        ...(backup ? { backup } : {}),
      });
      m.close();
      outcomes.push({ seen: r.seen, schemaVersion: report.schemaVersion, backup: report.backup });
    }
    // (1) red when a copy, a record or the folder is made for a file already there, or the target
    //     is copied to; (2) prints each run's events and report, and the scratch folder.
    expect({ outcomes, root: readdirSync(root), unchanged: hashOf(file) === before }).toEqual({
      outcomes: [
        { seen: ['nothing to undo at 2'], schemaVersion: 2, backup: undefined },
        { seen: ['nothing to undo at 2'], schemaVersion: 2, backup: undefined },
      ],
      root: ['.realm'],
      unchanged: true,
    });
  });

  it('a version it cannot step to: above the file’s, 0, 99, and a word that is not a number; each its own words, nothing changed', async () => {
    const { root, home, file } = nestedHome();
    await storeAt(home, 1);
    const before = hashOf(file);
    const m = await maintain(home);
    const above = await refusal(m.migrate({ to: 2 }));
    const zero = await refusal(m.migrate({ to: 0 }));
    const big = await refusal(m.migrate({ to: 99 }));
    m.close();
    let word: unknown = 'resolved';
    try {
      stepBackTarget('abc', home);
    } catch (err) {
      word = (err as WorkflowError).message;
    }
    const unknown = (value: string): string =>
      `Cannot step back to ${value}: give a whole number that is a schema version this Realm ` +
      'knows (1 to 2).';
    // (1) red when a step is run on a file below the version asked for, or a stack trace replaces the
    //     words; (2) prints each refusal, the word's message and the scratch folder.
    expect({
      above,
      zero,
      big,
      word,
      root: readdirSync(root),
      unchanged: hashOf(file) === before,
    }).toEqual({
      above: {
        code: 'STATE_STORE_MIGRATE_REFUSED',
        message:
          'The store file is at schema version 1; --to steps back only. Run realm db migrate, ' +
          'without --to, to go forward.',
        details: { path: file, reason: 'the store file is at schema version 1' },
      },
      zero: {
        code: 'STATE_STORE_MIGRATE_REFUSED',
        message: unknown('0'),
        details: { path: file, reason: '0 is not a schema version this Realm knows' },
      },
      big: {
        code: 'STATE_STORE_MIGRATE_REFUSED',
        message: unknown('99'),
        details: { path: file, reason: '99 is not a schema version this Realm knows' },
      },
      word: unknown('abc'),
      root: ['.realm'],
      unchanged: true,
    });
  });

  it('a step that cannot be undone in the middle of the plan: refused before any change with its own words and the backups folder; no copy, no record, every byte of the file unchanged', async () => {
    const { root, home, file, folder } = nestedHome();
    const versions = backLadder({ cannotUndo: 'its ladder_tags rows have nowhere to go' });
    await storeAt(home, 4, versions);
    const before = hashOf(file);
    const m = await maintain(home, { schemaVersion: 4, versions });
    const refused = await refusal(m.migrate({ to: 1 }));
    m.close();
    // (1) red when the plan is checked only as the steps run (step 4 to 3 lands first: the file
    //     changes and a copy is made); (2) prints the refusal, the scratch folder and the file's state.
    expect({ refused, root: readdirSync(root), unchanged: hashOf(file) === before }).toEqual({
      refused: {
        code: 'STATE_STORE_MIGRATE_REFUSED',
        message:
          'The step from schema version 3 to 2 cannot be undone: its ladder_tags rows have nowhere ' +
          'to go. Nothing was changed. To go back anyway, restore a backup made before the upgrade: ' +
          `realm db restore <backup> (the backups realm db migrate makes are in ${folder}/).`,
        details: { path: file, reason: 'the step from schema version 3 to 2 cannot be undone' },
      },
      root: ['.realm'],
      unchanged: true,
    });
  });

  it('a later step back fails: STATE_STORE_MIGRATE_FAILED naming it, the file at the version after the first step, one record line for the committed step', async () => {
    const { root, home, file, folder } = nestedHome();
    // Version 3's step back leaves `ladder_tags` behind: the file is not then version 2's.
    const versions = backLadder({ downgrade: ['DROP TABLE ladder_notes'] });
    await storeAt(home, 4, versions);
    const m = await maintain(home, { schemaVersion: 4, versions });
    const copy = join(root, 'before.db');
    const r = recorder();
    const failed = await refusal(m.migrate({ to: 1, backup: copy, progress: r.progress }));
    m.close();
    const reason =
      "After the step back to schema version 2, the file's schema is not version 2's: table " +
      'ladder_tags is extra';
    // (1) red when the failure records nothing, names the wrong version, or the first step is rolled
    //     back too; (2) prints the events, the refusal, the file's version and the record.
    expect({
      seen: r.seen,
      failed,
      version: versionOf(file),
      record: recordLines(folder).map(recorded),
    }).toEqual({
      seen: ['backup at version 4', 'back 4 to 3, 5 statement(s)', 'recorded'],
      failed: {
        code: 'STATE_STORE_MIGRATE_FAILED',
        message:
          `The step back from schema version 3 to 2 failed: ${reason}. ${file} is at schema ` +
          `version 3; nothing of the step is in it. The backup made before the step is at ${copy}. ` +
          'Run the command again once the cause is fixed.',
        details: { path: file, from: 3, to: 2, at: 3, reason, backup: copy },
      },
      version: 3,
      record: [{ from: 4, to: 3, backup: copy }],
    });
  });

  it('--no-backup and --backup <path>: no copy, and the copy at the path; the record names null and the path', async () => {
    const none = nestedHome();
    const named = nestedHome();
    await storeAt(none.home, 2);
    await storeAt(named.home, 2);
    const target = join(named.root, 'mine.db');
    const n = await maintain(none.home);
    await n.migrate({ to: 1, backup: false });
    n.close();
    const p = await maintain(named.home);
    await p.migrate({ to: 1, backup: target });
    p.close();
    // (1) red when the default copy overrides a flag; (2) prints both scratch folders' copies and
    //     both records.
    expect({
      noneFolder: readdirSync(none.folder),
      noneRecord: recordLines(none.folder).map(recorded),
      namedCopy: existsSync(target) ? versionOf(target) : 'no copy',
      namedFolder: readdirSync(named.folder),
      namedRecord: recordLines(named.folder).map(recorded),
    }).toEqual({
      noneFolder: ['migrations.jsonl'],
      noneRecord: [{ from: 2, to: 1, backup: null }],
      namedCopy: 2,
      namedFolder: ['migrations.jsonl'],
      namedRecord: [{ from: 2, to: 1, backup: target }],
    });
  });

  it('a file newer than this Realm reads is the open’s own refusal: no step is attempted, nothing changed', async () => {
    const { root, home, file } = nestedHome();
    await storeAt(home, 2);
    await moveForeign(home, backLadder(), 3);
    const before = hashOf(file);
    const refused = await refusal(openMaintenance({ home, verb: 'migrate' }, {}));
    // (1) red when the open lets a newer file through to a step back; (2) prints the refusal and the
    //     scratch folder.
    expect({ refused, root: readdirSync(root), unchanged: hashOf(file) === before }).toEqual({
      refused: {
        code: 'STATE_STORE_VERSION_NEWER',
        message:
          'This store was migrated by a newer Realm: its schema is version 3 and this Realm ' +
          'writes version 2. Upgrade Realm to read or write it.',
        details: { file: 3, realm: 2 },
      },
      root: ['.realm'],
      unchanged: true,
    });
  });
});

describe('#616 R2 — the plan judged again under the hold (another writer moves the file before it)', () => {
  it('moved to the version asked for: the nothing-to-undo event, no copy, no record, no folder, and the hold let go', async () => {
    const { root, home } = nestedHome();
    await storeAt(home, 2);
    const m = await maintain(home, {
      beforeHold: () => moveForeign(home, REALM_STORE_VERSIONS, 1),
    });
    const r = recorder();
    const outcome = await refusal(m.migrate({ to: 1, progress: r.progress }));
    const free = await writable(home);
    m.close();
    // (1) red when the plan read before the hold is run (a step back from 2 on a file at 1 fails, or
    //     a copy is made); (2) prints the outcome, the events, the scratch folder and the hold.
    expect({ outcome, seen: r.seen, root: readdirSync(root), free }).toEqual({
      outcome: 'resolved',
      seen: ['nothing to undo at 1'],
      root: ['.realm'],
      free: true,
    });
  });

  it('moved below the version asked for: the steps-back-only refusal, nothing changed, the hold let go', async () => {
    const { root, home, file } = nestedHome();
    const versions = backLadder();
    await storeAt(home, 3, versions);
    const m = await maintain(home, {
      schemaVersion: 4,
      versions,
      beforeHold: () => moveForeign(home, versions, 1),
    });
    const refused = await refusal(m.migrate({ to: 2 }));
    const free = await writable(home);
    m.close();
    // (1) red when the stale plan runs (a step back from 3); (2) prints the refusal, the scratch
    //     folder, the file's version and the hold.
    expect({ refused, root: readdirSync(root), version: versionOf(file), free }).toEqual({
      refused: {
        code: 'STATE_STORE_MIGRATE_REFUSED',
        message:
          'The store file is at schema version 1; --to steps back only. Run realm db migrate, ' +
          'without --to, to go forward.',
        details: { path: file, reason: 'the store file is at schema version 1' },
      },
      root: ['.realm'],
      version: 1,
      free: true,
    });
  });

  it('moved up to a version whose step cannot be undone: that refusal, nothing changed, the hold let go', async () => {
    const { root, home, file, folder } = nestedHome();
    const versions = backLadder({ cannotUndo: 'its tables have nowhere to go' });
    await storeAt(home, 2, versions);
    const m = await maintain(home, {
      schemaVersion: 4,
      versions,
      beforeHold: () => moveForeign(home, versions, 3),
    });
    const refused = await refusal(m.migrate({ to: 1 }));
    const free = await writable(home);
    m.close();
    // (1) red when the plan judged before the hold runs (the step 2 to 1 lands on a file at 3: it
    //     fails, or a copy is made); (2) prints the refusal, the scratch folder, the version, the hold.
    expect({ refused, root: readdirSync(root), version: versionOf(file), free }).toEqual({
      refused: {
        code: 'STATE_STORE_MIGRATE_REFUSED',
        message:
          'The step from schema version 3 to 2 cannot be undone: its tables have nowhere to go. ' +
          'Nothing was changed. To go back anyway, restore a backup made before the upgrade: ' +
          `realm db restore <backup> (the backups realm db migrate makes are in ${folder}/).`,
        details: { path: file, reason: 'the step from schema version 3 to 2 cannot be undone' },
      },
      root: ['.realm'],
      version: 3,
      free: true,
    });
  });

  it('moved up to a version newer than this Realm reads: the open’s own STATE_STORE_VERSION_NEWER words, nothing changed, the hold let go', async () => {
    const { root, home, file } = nestedHome();
    await storeAt(home, 2);
    const m = await maintain(home, {
      beforeHold: () => moveForeign(home, backLadder(), 3),
    });
    const refused = await refusal(m.migrate({ to: 1 }));
    const free = await writable(home);
    m.close();
    // (1) red when a file newer than this Realm is judged by the plan (version 3's step back, which
    //     this Realm does not know, is attempted or refused in other words); (2) prints the refusal,
    //     the scratch folder, the version and the hold.
    expect({ refused, root: readdirSync(root), version: versionOf(file), free }).toEqual({
      refused: {
        code: 'STATE_STORE_VERSION_NEWER',
        message:
          'This store was migrated by a newer Realm: its schema is version 3 and this Realm ' +
          'writes version 2. Upgrade Realm to read or write it.',
        details: { file: 3, realm: 2 },
      },
      root: ['.realm'],
      version: 3,
      free: true,
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

describe('#616 R2 — another process holding the store', () => {
  it(
    'refused STATE_STORE_IN_USE in about a second; no copy, no record, no folder, every byte unchanged',
    { timeout: 20_000 },
    async () => {
      const { root, home, file } = nestedHome();
      await storeAt(home, 2);
      const holder = await holdOpen(home);
      const before = hashOf(file);
      const m = await maintain(home);
      const started = Date.now();
      const refused = await refusal(m.migrate({ to: 1 }));
      const elapsed = Date.now() - started;
      m.close();
      await stop(holder);
      // (1) red when the step back takes no hold (it goes ahead: the folder is made), or the busy
      //     answer is left to the store's wait (STATE_RUN_BUSY after 5 s); (2) prints the refusal,
      //     the time, the scratch folder and whether the file changed.
      expect({
        refused,
        withinAboutASecond: elapsed < 4_500,
        root: readdirSync(root),
        unchanged: hashOf(file) === before,
      }).toEqual({
        refused: {
          code: 'STATE_STORE_IN_USE',
          message:
            `Another process has ${file} open (a Realm agent, server, MCP server or command, or ` +
            'another program such as a SQLite browser). Stop it and run this again. Nothing was ' +
            'changed.',
          details: { path: file },
        },
        withinAboutASecond: true,
        root: ['.realm'],
        unchanged: true,
      });
    },
  );
});
