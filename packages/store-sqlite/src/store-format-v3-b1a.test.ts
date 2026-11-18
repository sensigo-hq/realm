// store-format-v3-b1a.test.ts — callback B1a (R1.3): the store file's format version 3, the
// `callbacks` and `callback_keys` tables, on real files. The real cases: a fresh home and a 0.50.0
// home (version 2) migrated to 3 end with the same schema; a 0.49.0 home (version 1) takes two steps
// in one migrate and one record line; a step back to 2 drops both tables, says how many undelivered
// callbacks and keys it dropped, and keeps them in the copy it made first; `realm rollback` undoes a
// forward migrate; a Realm that writes 2 refuses a version-3 file, and this Realm refuses a version-2
// file until it is migrated; and a purge takes a run's callback row in the run's own transaction and
// never touches the keys.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  abandonRun,
  REALM_STORE_SCHEMA_VERSION,
  REALM_STORE_VERSIONS,
  WorkflowError,
  type Clock,
  type CreateRunOptions,
} from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseLike } from './driver.js';
import { openRealmHome } from './index.js';
import { openMaintenance, type MigrateProgress } from './maintenance.js';
import { openHome, type RealmHome } from './open-realm-home.js';
import { storedSchemaDifference } from './schema-ladder.js';
import { plantCallbackRow, testSealer } from './test-support/callbacks.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

const RUN: CreateRunOptions = { workflowId: 'wf-v3', workflowVersion: 1, params: {} };
const AT = '2026-03-01T10:00:00.000Z';
const clock: Clock = { now: () => new Date(AT), at: () => () => undefined };

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

/** A scratch folder and the home nested in it: `<tmp>/<name>/.realm` (its backups folder beside). */
function nestedHome(): { home: string; file: string; folder: string } {
  const root = mkdtempSync(join(tmpdir(), 'realm-b1a-v3-'));
  dirs.push(root);
  const home = join(root, '.realm');
  return { home, file: join(home, 'realm.db'), folder: join(root, '.realm-backups') };
}

/** A home whose store file is made at `version` (through the open's seam), holding one run. */
async function storeAt(home: string, version: number): Promise<string> {
  const h = await openHome({ home }, { schemaVersion: version });
  const id = (await h.runStore.create(RUN)).record.id;
  h.close();
  return id;
}

/** Runs `read` on a raw connection to the file at `path`, then closes it. */
function onFile<T>(path: string, read: (c: DatabaseLike) => T): T {
  const c = openDatabase(path);
  try {
    return read(c);
  } finally {
    c.close();
  }
}

/** The file's schema as `sqlite_master` holds it, by name, every SQLite-made entry left out. */
const storedSchema = (c: DatabaseLike): unknown[] =>
  c
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => ({ ...r }));

const userVersion = (c: DatabaseLike): number =>
  Number(c.prepare('PRAGMA user_version').get()?.['user_version']);

const count = (c: DatabaseLike, table: string): number =>
  Number(c.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']);

/** The events of a migrate, as short words. */
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
      case 'stepBack':
        seen.push(`back ${event.report.from} to ${event.report.to}: ${String(event.loses)}`);
        break;
      case 'rollingBack':
        seen.push(`rolling back ${event.from} to ${event.to}`);
        break;
      case 'install':
        seen.push(`install ${event.range} for ${event.schemaVersion}`);
        break;
      default:
        seen.push(event.kind);
    }
  };
  return { seen, progress };
}

/** What the record file holds, as each line's versions; none when it does not exist. */
function recordLines(folder: string): unknown[] {
  const path = join(folder, 'migrations.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const line = JSON.parse(l) as Record<string, unknown>;
      return [line['from_format'], line['to_format']];
    });
}

/** A rejection as a reader sees it: a typed refusal's code and details, or `resolved`. */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err instanceof WorkflowError
      ? { code: err.code, details: err.details }
      : `${(err as Error).name}: ${(err as Error).message}`;
  }
}

const LOST_4 =
  'The callbacks and callback_keys tables were dropped: 4 undelivered callback(s) and signing key(s), counted together, are no longer in the file.';
const LOST_NONE =
  'The callbacks and callback_keys tables were dropped; they held no undelivered callback and no signing key.';

describe('callback B1a — store format 3: a fresh file, a migrated one and the two steps from 1', () => {
  it('a fresh version-3 file and a version-2 file migrated to 3 hold the same schema, and both open', async () => {
    const fresh = nestedHome();
    (await openRealmHome({ home: fresh.home })).close();
    const old = nestedHome();
    await storeAt(old.home, 2);
    const m = await openMaintenance({ home: old.home, verb: 'migrate' }, {});
    closers.push(() => m.close());
    const report = await m.migrate({ backup: false });
    m.close();
    const opened = await refusal(
      openRealmHome({ home: old.home }).then((h) => {
        h.close();
      }),
    );
    // (1) red when the step's statements and version 3's schema differ (an index or a column in
    //     one and not the other), or the migrated file fails the open's own compare; (2) prints both
    //     versions, the one step and the schemas when they differ.
    expect({
      versions: [
        onFile(fresh.file, userVersion),
        onFile(old.file, userVersion),
        REALM_STORE_SCHEMA_VERSION,
      ],
      steps: report.steps.map((s) => [s.from, s.to, s.statements]),
      same:
        JSON.stringify(onFile(old.file, storedSchema)) ===
        JSON.stringify(onFile(fresh.file, storedSchema)),
      opened,
    }).toEqual({ versions: [3, 3, 3], steps: [[2, 3, 3]], same: true, opened: 'resolved' });
  });

  it('a version-1 file (0.49.0) takes two steps in one migrate: one copy named 1 to 3, and one record line from 1 to 3', async () => {
    const { home, file, folder } = nestedHome();
    const id = await storeAt(home, 1);
    const m = await openMaintenance({ home, verb: 'migrate' }, {});
    closers.push(() => m.close());
    const r = recorder();
    const report = await m.migrate({ progress: r.progress });
    m.close();
    const copy = report.backup?.path ?? '';
    const h = await openRealmHome({ home });
    closers.push(() => h.close());
    // (1) red when a version-1 file stops at 2, when each step writes its own record line, or when
    //     the copy is named or made after a step; (2) prints the events, the copy's name and version,
    //     the record's lines, the file's version and whether the run reads.
    expect({
      seen: r.seen.filter((e) => !e.startsWith('recorded')),
      copy: copy.slice(folder.length + 1).replace(/\d{8}T\d{6}Z/, '<UTC>'),
      copyVersion: onFile(copy, userVersion),
      record: recordLines(folder),
      version: onFile(file, userVersion),
      run: (await h.runStore.get(id)).record.id,
    }).toEqual({
      seen: ['backup at version 1', 'step 1 to 2', 'step 2 to 3', 'restamped'],
      copy: 'realm-v1-to-v3-<UTC>.db',
      copyVersion: 1,
      record: [[1, 3]],
      version: 3,
      run: id,
    });
  });
});

/** A version-3 home holding a pending, a failed and a delivered callback row and two keys. */
async function holdingRows(home: string): Promise<void> {
  const h = await openRealmHome({ home, clock, sealer: testSealer() });
  await h.runStore.keys.make('wf-v3', 'hooks.example:443', 'ab'.repeat(32));
  await h.runStore.keys.rotate('wf-v3', 'hooks.example:443', {
    candidate: 'cd'.repeat(32),
    keepSeconds: 600,
  });
  h.close();
  await plantCallbackRow(home, {
    run_id: 'run-pending',
    status: 'pending',
    url: 'https://a.example/1',
  });
  await plantCallbackRow(home, { run_id: 'run-failed', status: 'failed' });
  await plantCallbackRow(home, { run_id: 'run-delivered', status: 'delivered' });
}

describe('callback B1a — the step back from 3 to 2', () => {
  it('with rows: the copy first, both tables dropped, the loss counted (the pending and failed rows and the two keys, not the delivered row), the step recorded, the file exactly version 2’s, and the copy holding the rows', async () => {
    const { home, file, folder } = nestedHome();
    await holdingRows(home);
    const m = await openMaintenance({ home, verb: 'migrate' }, {});
    closers.push(() => m.close());
    const r = recorder();
    const report = await m.migrate({ to: 2, progress: r.progress });
    m.close();
    const copy = report.backup?.path ?? '';
    // (1) red when the step back runs before the copy, when the count leaves out a failed row or the
    //     keys (or counts the delivered row), when a table is left behind (the file is then not
    //     version 2's), when the step is not recorded, or when the copy lacks the rows; (2) prints
    //     the events, the schema difference, the version, the record and the copy's rows.
    expect({
      seen: r.seen.filter((e) => !e.startsWith('recorded')),
      difference: onFile(file, (c) =>
        storedSchemaDifference(c, REALM_STORE_VERSIONS.get(2)!.schema),
      ),
      version: onFile(file, userVersion),
      record: recordLines(folder),
      copy: onFile(copy, (c) => ({
        version: userVersion(c),
        callbacks: count(c, 'callbacks'),
        keys: count(c, 'callback_keys'),
      })),
    }).toEqual({
      seen: ['backup at version 3', `back 3 to 2: ${LOST_4}`, 'install >=0.50.0 <0.51.0 for 2'],
      difference: { missing: [], extra: [], changed: [] },
      version: 2,
      record: [[3, 2]],
      copy: { version: 3, callbacks: 3, keys: 2 },
    });
  });

  it('with no rows: the none sentence', async () => {
    const { home } = nestedHome();
    (await openRealmHome({ home })).close();
    const m = await openMaintenance({ home, verb: 'migrate' }, {});
    closers.push(() => m.close());
    const r = recorder();
    await m.migrate({ to: 2, backup: false, progress: r.progress });
    m.close();
    // (1) red when an empty step back prints a count of 0 instead of the none sentence, or nothing;
    //     (2) prints the events.
    expect(r.seen.filter((e) => !e.startsWith('recorded'))).toEqual([
      `back 3 to 2: ${LOST_NONE}`,
      'install >=0.50.0 <0.51.0 for 2',
    ]);
  });

  it('realm rollback after a forward migrate from 2 to 3 steps the file back to 2, saying what it dropped', async () => {
    const { home, file, folder } = nestedHome();
    await storeAt(home, 2);
    const forward = await openMaintenance({ home, verb: 'migrate' }, {});
    closers.push(() => forward.close());
    await forward.migrate({});
    forward.close();
    const back = await openMaintenance({ home, verb: 'rollback' }, {});
    closers.push(() => back.close());
    const r = recorder();
    const report = await back.rollback({ progress: r.progress });
    back.close();
    // (1) red when the rollback steps back further than the line's from_format, or leaves the file
    //     at 3; (2) prints the events, the versions and the record.
    expect({
      seen: r.seen.filter((e) => !e.startsWith('recorded')),
      version: onFile(file, userVersion),
      to: report.schemaVersion,
      record: recordLines(folder),
    }).toEqual({
      seen: [
        'rolling back 2 to 3',
        'backup at version 3',
        `back 3 to 2: ${LOST_NONE}`,
        'install >=0.50.0 <0.51.0 for 2',
      ],
      version: 2,
      to: 2,
      record: [
        [2, 3],
        [3, 2],
      ],
    });
  });
});

describe('callback B1a — the refusals between versions 2 and 3, unchanged', () => {
  it('a Realm that writes 2 refuses a version-3 file as newer; this Realm refuses a version-2 file as older, naming realm db migrate', async () => {
    const three = nestedHome();
    (await openRealmHome({ home: three.home })).close();
    const two = nestedHome();
    await storeAt(two.home, 2);
    const older = await openRealmHome({ home: two.home }).then(
      (h) => {
        h.close();
        return 'resolved';
      },
      (err: WorkflowError) => ({ code: err.code, message: err.message }),
    );
    // (1) red when either file is opened (a version-2 Realm reading the callback tables, or this
    //     Realm reading a file without them); (2) prints both refusals.
    expect({
      newer: await refusal(openHome({ home: three.home }, { schemaVersion: 2 })),
      older,
    }).toEqual({
      newer: { code: 'STATE_STORE_VERSION_NEWER', details: { file: 3, realm: 2 } },
      older: {
        code: 'STATE_STORE_VERSION_OLDER',
        message:
          "This store's file is at schema version 2; this Realm writes version 3. Run `realm db migrate` with Realm stopped to upgrade it.",
      },
    });
  });
});

/** A finished run: created, then abandoned (core's own way to end a run). */
async function finished(h: RealmHome): Promise<{ runId: string; version: number }> {
  const { record } = await h.runStore.create(RUN);
  const ended = await abandonRun(h.runStore, record.id);
  return { runId: ended.id, version: ended.version };
}

describe('callback B1a — the purge takes a run’s callback row with the run, and never the keys', () => {
  it('a fault on the callback row’s delete fails the batch: the run stays, and the failure names the callbacks table', async () => {
    const { home } = nestedHome();
    const h = await openRealmHome({ home, clock });
    closers.push(() => h.close());
    const run = await finished(h);
    await plantCallbackRow(home, { run_id: run.runId, status: 'delivered' });
    const c = await openForeignConnection(home);
    c.exec(
      "CREATE TRIGGER callbacks_fault BEFORE DELETE ON callbacks BEGIN SELECT RAISE(ABORT, 'planted fault'); END",
    );
    c.close();
    const report = await h.purge([run]);
    const outcome = report.runs[0];
    // (1) red when the callback row's delete runs outside the run's transaction (the run is then
    //     gone while its row stays), or the failure names another table; (2) prints the outcome and
    //     whether the run still reads.
    expect({
      outcome: outcome?.outcome,
      code: outcome?.outcome === 'failed' ? (outcome.error as WorkflowError).code : undefined,
      artifacts:
        outcome?.outcome === 'failed'
          ? (
              (outcome.error as WorkflowError).details as {
                failures?: Array<{ artifact: string }>;
              }
            ).failures?.map((f) => f.artifact)
          : undefined,
      runStays: await refusal(h.runStore.get(run.runId)),
    }).toEqual({
      outcome: 'failed',
      code: 'ENGINE_ARTIFACT_DELETE_FAILED',
      artifacts: ['callbacks'],
      runStays: 'resolved',
    });
  });

  it('a purged run’s callback row goes with it and its address and body count in the receipt; every key stays when every run is purged', async () => {
    const { home } = nestedHome();
    const h = await openRealmHome({ home, clock, sealer: testSealer() });
    closers.push(() => h.close());
    const withRow = await finished(h);
    const without = await finished(h);
    const url = 'https://hooks.example/callback/ünïcode';
    const body = '{"status":"completed"}';
    await plantCallbackRow(home, { run_id: withRow.runId, status: 'pending', url, body });
    await h.runStore.keys.make('wf-v3', 'hooks.example:443', 'ab'.repeat(32));
    const stat = async (id: string): Promise<number> => (await h.runStore.statAllForRun(id)).bytes;
    const stats = { withRow: await stat(withRow.runId), without: await stat(without.runId) };
    const report = await h.purge([withRow, without]);
    const bytes = Object.fromEntries(
      report.runs.map((o) => [o.runId, o.outcome === 'purged' ? o.bytes_deleted : o.outcome]),
    );
    const left = await openForeignConnection(home);
    const rows = count(left, 'callbacks');
    left.close();
    // (1) red when the purge leaves the run's callback row, leaves its bytes out of the receipt (or
    //     counts characters, not UTF-8 bytes), or deletes a key; (2) prints each run's receipt beside
    //     its run store stat, the rows left and the key pair.
    expect({
      bytes,
      rows,
      keys: Object.keys(await h.runStore.keys.read('wf-v3', 'hooks.example:443')),
    }).toEqual({
      bytes: {
        [withRow.runId]:
          stats.withRow + Buffer.byteLength(url, 'utf8') + Buffer.byteLength(body, 'utf8'),
        [without.runId]: stats.without,
      },
      rows: 0,
      keys: ['current'],
    });
  });
});
