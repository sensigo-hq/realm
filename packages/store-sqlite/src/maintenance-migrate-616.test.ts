// maintenance-migrate-616.test.ts — issue #616 PR-2c, unit c7: the maintenance handle's `migrate`
// (design §2 "Schema evolution", §3 "The re-stamp", §8 `realm db migrate`; DELTAS 41 and 42; SEAMS
// IA-2C6-11). The real cases: the first release that changes the schema, whose operator stops Realm,
// backs the store up and climbs the ladder one step at a time; a step that fails (its schema is not
// its version's, a write error after the step landed) and the second run that resumes; a store with
// nothing to climb; a Realm whose phase derivation changed, whose runs' stored phases must be
// stamped again from their records; a backup the verb must not get past; and the connection's gate,
// which must judge a file against the version the connection was opened under. Every cell works on
// real files through the loader, the versions above 1 through the open's seams.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveRunPhase,
  REALM_STORE_VERSIONS,
  runPhaseDerivationFingerprint,
  WorkflowError,
  type CreateRunOptions,
  type RunRecord,
  type StoreSchemaVersions,
} from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './driver.js';
import { openRealmHome, openRealmHomeForMaintenance } from './index.js';
import { openMaintenance, type MaintenanceHome, type MigrateProgress } from './maintenance.js';
import { openHome } from './open-realm-home.js';
import { migrateSchema } from './schema-ladder.js';
import { faultyFiles, SQLITE } from './test-support/commit-faults.js';
import { openForeignConnection } from './test-support/foreign-connection.js';
import {
  ladder,
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
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-c7-'));
  dirs.push(dir);
  return dir;
}

/**
 * A home with a store holding `runs` runs, made by the open and closed again; its ids. #597 D1c-1:
 * `seams` makes it at another schema version (`V1`: a version-1 file, the synthetic ladder's start).
 */
async function storeWithRuns(
  path: string,
  runs = 2,
  seams?: Parameters<typeof openHome>[1],
): Promise<string[]> {
  const h = await (seams === undefined
    ? openRealmHome({ home: path })
    : openHome({ home: path }, seams));
  const ids: string[] = [];
  for (let i = 0; i < runs; i++) ids.push((await h.runStore.create(RUN)).record.id);
  h.close();
  return ids;
}

/** #597 D1c-1: the open's seam that makes a version-1 file (the synthetic ladder's start). */
const V1 = { schemaVersion: 1 } as const;

/**
 * #597 D1c-1: the synthetic ladder moved ABOVE the real version 2, for the cell (G) whose point is a
 * file at a version this Realm does not know: core's 1 and 2, then the synthetic steps as 3 and 4,
 * each extending the real version 2's schema. `ladder()` keeps its own 2 and 3 for every other cell.
 */
function ladderAboveReal(): StoreSchemaVersions {
  const real = REALM_STORE_VERSIONS.get(2)!.schema;
  return new Map([
    ...REALM_STORE_VERSIONS,
    [3, { schema: [...real, V2_TABLE, V2_TAGS], upgrade: STEP_2 }],
    [4, { schema: [...real, V3_TABLE, V2_TAGS, V3_INDEX], upgrade: STEP_3 }],
  ]);
}

/** Moves the home's store file up the ladder above the real version 2, from another connection. */
async function climbForeignAbove(path: string, version: number): Promise<void> {
  const foreign = await openForeignConnection(path);
  try {
    migrateSchema(foreign, version, ladderAboveReal());
  } finally {
    foreign.close();
  }
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

/** Opens a home for maintenance, for `migrate`, through the seams; the cleanup closes it. */
async function maintain(
  path: string,
  seams: Parameters<typeof openMaintenance>[1] = {},
): Promise<MaintenanceHome> {
  const handle = await openMaintenance({ home: path, verb: 'migrate' }, seams);
  closers.push(() => handle.close());
  return handle;
}

/** A store file's `user_version`, read now on a connection of its own (synchronous). */
function versionOf(file: string): number {
  const db = openDatabase(file);
  try {
    return Number(db.prepare('PRAGMA user_version').get()?.['user_version']);
  } finally {
    db.close();
  }
}

/**
 * Each event `migrate` reports, as a line of what was true WHEN it fired: a step with the version the
 * store file is at by then, the backup with the version its copy is at.
 */
function recorder(): { seen: string[]; progress: (event: MigrateProgress) => void } {
  const seen: string[] = [];
  const progress = (event: MigrateProgress): void => {
    if (event.kind === 'backup') {
      seen.push(`backup at version ${versionOf(event.report.path)}`);
    } else if (event.kind === 'step') {
      const { from, to } = event.report;
      // #616 R1: no other connection can read the file while the migrate holds it, so a step's
      // event is its own report; the file's version is read after the migrate.
      seen.push(`step ${from} to ${to}`);
    } else if (event.kind === 'current') {
      seen.push(`already at ${event.schemaVersion}`);
    } else if (event.kind === 'restamped') {
      seen.push(`restamped ${event.runs}`);
    } else {
      // #616 R1: a migrate that ran a step records it (or warns that it could not). #616 R2: the step
      // back's own events (none here) are named by their kind.
      seen.push(
        event.kind === 'unrecorded'
          ? `unrecorded: ${event.reason}`
          : event.kind === 'recorded'
            ? 'recorded'
            : event.kind,
      );
    }
  };
  return { seen, progress };
}

/** What a home's store file holds for each run: its two phase columns, its version and its record. */
function phaseRows(file: string): Record<string, Record<string, unknown>> {
  const db = openDatabase(file);
  try {
    return Object.fromEntries(
      db
        .prepare('SELECT id, run_phase, phase_version, version, record FROM runs ORDER BY id')
        .all()
        .map((row) => [
          String(row['id']),
          {
            run_phase: row['run_phase'],
            phase_version: row['phase_version'],
            version: row['version'],
            record: row['record'],
          },
        ]),
    );
  } finally {
    db.close();
  }
}

/** `STATE_STORE_VERSION_NEWER` as the connection words it for a file at `file` under `realm`. */
function newer(file: number, realm: number): unknown {
  return {
    code: 'STATE_STORE_VERSION_NEWER',
    message:
      `This store was migrated by a newer Realm: its schema is version ${file} and this Realm ` +
      `writes version ${realm}. Upgrade Realm to read or write it.`,
    details: { file, realm },
  };
}

describe('#616 PR-2c c7 — the gate judges the file against the version the connection was opened under', () => {
  it('(G) SEAMS IA-2C6-11: a connection opened under version 3 writes a version-3 file, refuses it at version 4 naming both versions, and production still refuses the version-3 file at its open', async () => {
    // #597 D1c-1: the synthetic versions sit above the real version 2 (`ladderAboveReal`), so the
    // version-3 file is one this Realm (at 2) does not know, as version 2 was before.
    const live = join(tmp(), '.realm');
    await storeWithRuns(live, 1);
    await climbForeignAbove(live, 3);
    const production = await refusal(openRealmHome({ home: live }));
    const opening = openHome({ home: live }, { schemaVersion: 3, versions: ladderAboveReal() });
    const openAtThree = await refusal(opening);
    const atThree = await opening.catch(() => undefined);
    if (atThree !== undefined) closers.push(() => atThree.close());
    const writeAtThree =
      atThree === undefined ? 'not opened' : await refusal(atThree.runStore.create(RUN));
    await climbForeignAbove(live, 4);
    const writeAtFour =
      atThree === undefined ? 'not opened' : await refusal(atThree.runStore.create(RUN));
    // (1) red when the gate compares with core's constant (the open's own reads refuse the version-3
    //     file under realm 3, "writes version 2"), when the open does not pass its version to the
    //     connection (the same), or when the refusal names the constant (version 4's refusal says 2);
    //     (2) prints each outcome: its code, message and details, `resolved`, or `not opened`.
    expect({ production, openAtThree, writeAtThree, writeAtFour }).toEqual({
      production: newer(3, 2),
      openAtThree: 'resolved',
      writeAtThree: 'resolved',
      writeAtFour: newer(4, 3),
    });
  });
});

/** A promise's outcome by its code: a typed refusal's code, a plain error's message, or `resolved`. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err instanceof WorkflowError
      ? err.code
      : `${(err as Error).name}: ${(err as Error).message}`;
  }
}

describe('#616 PR-2c c7 — migrate: the backup first, the ladder one step at a time, the re-stamp', () => {
  it('(A) L-MIGRATE: the backup is made first, each step lands in its own transaction and is reported before the next, and the file ends at version 3, which the ordinary open accepts with every run', async () => {
    const root = tmp();
    const live = join(root, '.realm');
    const file = join(live, 'realm.db');
    const ids = await storeWithRuns(live, 2, V1);
    const seams = { schemaVersion: 3, versions: ladder() };
    const m = await maintain(live, seams);
    const copy = join(root, 'before-upgrade.db');
    const { seen, progress } = recorder();
    const report = await m.migrate({ backup: copy, progress });
    m.close();
    const ordinary = await openHome({ home: live }, seams);
    closers.push(() => ordinary.close());
    const runs: string[] = [];
    for (const id of ids) runs.push((await ordinary.runStore.get(id)).record.id);
    // (1) red when the backup is made after the ladder (its copy is at 3 and its event comes last),
    //     or when a step is not reported (one transaction per step is cell (B)'s: the hold of #616 R1
    //     keeps every other connection from reading the file while the migrate runs); (2) prints each
    //     event, the steps' reports, the copy's and the file's versions now, and the runs read back.
    expect({
      seen,
      steps: report.steps,
      copy: versionOf(copy),
      file: versionOf(file),
      runs,
    }).toEqual({
      seen: ['backup at version 1', 'step 1 to 2', 'step 2 to 3', 'recorded', 'restamped 0'],
      steps: [
        { from: 1, to: 2, statements: 3, evidenceChecked: 0 },
        { from: 2, to: 3, statements: 5, evidenceChecked: 0 },
      ],
      copy: 1,
      file: 3,
      runs: ids,
    });
  });

  it('(B) a step that fails ends the verb there: the step before it stays reported and committed, the file is at version 2 with nothing of step 3, the backup is kept, and a second run resumes at 2 to 3', async () => {
    const root = tmp();
    const live = join(root, '.realm');
    const file = join(live, 'realm.db');
    await storeWithRuns(live, 1, V1);
    // Version 3's step builds its index on the other column: its result is not version 3's schema.
    const drift = [...STEP_3.slice(0, -1), 'CREATE INDEX ladder_notes_by_k ON ladder_notes (w)'];
    const m = await maintain(live, { schemaVersion: 3, versions: ladder(drift) });
    const copy = join(root, 'before-upgrade.db');
    const first = recorder();
    const failed = await refusal(m.migrate({ backup: copy, progress: first.progress }));
    m.close();
    const seams = { schemaVersion: 3, versions: ladder() };
    const ordinary = await codeOf(openHome({ home: live }, seams));
    const again = await maintain(live, seams);
    const second = recorder();
    await again.migrate({ backup: false, progress: second.progress });
    const reason =
      "After the step to schema version 3, the file's schema is not version 3's: index " +
      'ladder_notes_by_k has another text';
    // (1) red when the failure is swallowed or the version is taken from the step (the line says
    //     3), or when the backup is removed (the copy reads version 0, a new empty file); (2) prints
    //     the events, the refusal's code, message and details, the copy's version, the ordinary
    //     open's code, the reopened handle's version and the second run's events.
    expect({
      seen: first.seen,
      failed,
      copy: versionOf(copy),
      ordinary,
      reopenedAt: again.schemaVersion,
      resumed: second.seen,
    }).toEqual({
      seen: ['backup at version 1', 'step 1 to 2', 'recorded'],
      failed: {
        code: 'STATE_STORE_MIGRATE_FAILED',
        message:
          `The step from schema version 2 to 3 failed: ${reason}. ${file} is at schema version 2; ` +
          'nothing of the step is in it. Run the command again once the cause is fixed. The backup ' +
          `made before the step is at ${copy}.`,
        details: { path: file, from: 2, to: 3, at: 2, reason, backup: copy },
      },
      copy: 1,
      ordinary: 'STATE_STORE_VERSION_OLDER',
      reopenedAt: 2,
      resumed: ['step 2 to 3', 'recorded', 'restamped 0'],
    });
  });

  it('(B2) a step whose COMMIT reports an error after it landed: the line reads the file at version 3 and says the step is in it, and a second run has nothing pending', async () => {
    const live = join(tmp(), '.realm');
    const file = join(live, 'realm.db');
    await storeWithRuns(live, 1, V1);
    const files = faultyFiles(openDatabase);
    const seams = { schemaVersion: 3, versions: ladder() };
    const m = await maintain(live, { ...seams, openFile: files.openFile });
    const first = recorder();
    const failed = await refusal(
      m.migrate({
        backup: false,
        progress: (event) => {
          first.progress(event);
          // Step 1 to 2 has landed: the next COMMIT on the store's connection is step 2 to 3's.
          if (event.kind === 'step' && event.report.to === 2) {
            files.opened[0]?.arm({
              at: (sql) => sql === 'COMMIT',
              times: 1,
              first: 'run',
              error: SQLITE.ioError,
            });
          }
        },
      }),
    );
    const fired = files.opened[0]?.hits();
    m.close();
    const again = await maintain(live, seams);
    const second = recorder();
    await again.migrate({ backup: false, progress: second.progress });
    const reason = 'disk I/O error (SQLite error 10)';
    // (1) red when the version is assumed from the step's start (the line says version 2 and
    //     "nothing of the step is in it" while the file is at 3), or when the read is taken before
    //     the step; (2) prints the events, how many times the fault fired, the refusal's code,
    //     message and details, and the second run's events.
    expect({ seen: first.seen, fired, failed, second: second.seen }).toEqual({
      seen: ['step 1 to 2', 'recorded'],
      fired: 1,
      failed: {
        code: 'STATE_STORE_MIGRATE_FAILED',
        message:
          `The step from schema version 2 to 3 failed: ${reason}. ${file} is at schema version 3: ` +
          'the step is in it. Run the command again to continue from there.',
        details: { path: file, from: 2, to: 3, at: 3, reason },
      },
      second: ['already at 3', 'restamped 0'],
    });
  });

  // State 6's busy case (the operator did not stop Realm): since #616 R1 the hold refuses it before
  // any step (the error-codes row of STATE_STORE_IN_USE names it). The cell keeps its own budget.
  it(
    '(B3) #616 R1: another writer holding the store is refused before any step, STATE_STORE_IN_USE, in about a second: the file at version 1 with nothing of the step in it',
    { timeout: 30_000 },
    async () => {
      const live = join(tmp(), '.realm');
      const file = join(live, 'realm.db');
      await storeWithRuns(live, 1, V1);
      const m = await maintain(live, { schemaVersion: 3, versions: ladder() });
      const holder = await openForeignConnection(live);
      let failed: unknown;
      holder.exec('BEGIN IMMEDIATE');
      try {
        failed = await refusal(m.migrate({ backup: false }));
      } finally {
        holder.exec('ROLLBACK');
        holder.close();
      }
      // (1) red when a step runs while another connection holds the store (before R1 the step met
      //     the writer and failed STATE_STORE_MIGRATE_FAILED after the store's 5 s wait); (2) prints
      //     the refusal's code, message and details, and the file's version.
      expect({ failed, file: versionOf(file) }).toEqual({
        failed: {
          code: 'STATE_STORE_IN_USE',
          message:
            `Another process has ${file} open: a Realm agent, server or command, an MCP server that ` +
            'an assistant or editor keeps running, or another program such as a SQLite browser. ' +
            'Stop it and run this again. Nothing was changed.',
          details: { path: file },
        },
        file: 1,
      });
    },
  );

  it("(C) a store already at this Realm's version: no step, the line saying so, and a re-stamp of nothing", async () => {
    const live = join(tmp(), '.realm');
    const file = join(live, 'realm.db');
    await storeWithRuns(live);
    const m = await openRealmHomeForMaintenance({ home: live, verb: 'migrate' });
    closers.push(() => m.close());
    const { seen, progress } = recorder();
    // (1) red when a step is run for a version this Realm does not hold (the ladder's loop past its
    //     target: the verb fails), or when the "already at" event is not reported; (2) prints the
    //     verb's outcome, its events and the file's version.
    expect({
      outcome: await codeOf(m.migrate({ backup: false, progress })),
      seen,
      file: versionOf(file),
    }).toEqual({ outcome: 'resolved', seen: ['already at 2', 'restamped 0'], file: 2 });
  });

  it('(D) the re-stamp: each run another derivation stamped gets the phase its record derives and the running stamp, its record and version untouched; the others are left alone; a second run counts 0', async () => {
    const live = join(tmp(), '.realm');
    const file = join(live, 'realm.db');
    const ids = await storeWithRuns(live, 4);
    const foreign = await openForeignConnection(live);
    // Two older derivations stamped two of the runs, with phases their records do not derive (the
    // first run is live: "completed" is wrong for it).
    const plant = foreign.prepare('UPDATE runs SET run_phase = ?, phase_version = ? WHERE id = ?');
    plant.run('completed', 'derivation-a', ids[0]);
    plant.run('failed', 'derivation-b', ids[2]);
    foreign.close();
    const before = phaseRows(file);
    const m = await openRealmHomeForMaintenance({ home: live, verb: 'migrate' });
    closers.push(() => m.close());
    const first = recorder();
    await m.migrate({ backup: false, progress: first.progress });
    const second = recorder();
    await m.migrate({ backup: false, progress: second.progress });
    const after = phaseRows(file);
    const running = runPhaseDerivationFingerprint();
    const stale = new Set([ids[0], ids[2]]);
    /** A run's row as the cell compares it: its record only as "as before" or "changed". */
    const shape = (row: Record<string, unknown> | undefined, id: string): unknown => ({
      run_phase: row?.['run_phase'],
      phase_version: row?.['phase_version'],
      version: row?.['version'],
      record: row?.['record'] === before[id]?.['record'] ? 'as before' : 'changed',
    });
    const expected = Object.fromEntries(
      ids.map((id) => [
        id,
        stale.has(id)
          ? {
              ...(shape(before[id], id) as object),
              run_phase: deriveRunPhase(JSON.parse(String(before[id]?.['record'])) as RunRecord),
              phase_version: running,
            }
          : shape(before[id], id),
      ]),
    );
    // (1) red when the phase is not derived again (the wrong phase stays under the running stamp:
    //     "completed" on a live run), when the running stamp is not written (the second run counts 2
    //     again), or when the re-stamp writes the record or another run; (2) prints both runs'
    //     events and each run's two phase columns, its version and whether its record changed.
    expect({
      first: first.seen,
      second: second.seen,
      runs: Object.fromEntries(ids.map((id) => [id, shape(after[id], id)])),
    }).toEqual({
      first: ['already at 2', 'restamped 2'],
      second: ['already at 2', 'restamped 0'],
      runs: expected,
    });
  });

  it('(E) the backup gates the ladder: a target inside the home, or a copy that fails the quick check, ends the verb before any step, and the copy that failed the check is kept', async () => {
    const root = tmp();
    const live = join(root, '.realm');
    const file = join(live, 'realm.db');
    await storeWithRuns(live, 1, V1);
    const seams = { schemaVersion: 3, versions: ladder() };
    const inside = await maintain(live, seams);
    const a = recorder();
    const insideOutcome = await codeOf(
      inside.migrate({ backup: join(live, 'inside.db'), progress: a.progress }),
    );
    inside.close();
    const afterInside = versionOf(file);
    const damaged = await maintain(live, {
      ...seams,
      quickCheck: () => ['row 2 missing from index runs_by_phase'],
    });
    const copy = join(root, 'before-upgrade.db');
    const b = recorder();
    const uncheckedOutcome = await codeOf(damaged.migrate({ backup: copy, progress: b.progress }));
    // (1) red when the ladder runs before the backup's verdict (the file ends at 3, and the steps
    //     are reported); (2) prints each outcome's code, the events, the file's version after each
    //     and whether the unchecked copy is kept.
    expect({
      insideOutcome,
      insideSeen: a.seen,
      afterInside,
      uncheckedOutcome,
      uncheckedSeen: b.seen,
      afterUnchecked: versionOf(file),
      kept: existsSync(copy),
    }).toEqual({
      insideOutcome: 'STATE_STORE_BACKUP_REFUSED',
      insideSeen: [],
      afterInside: 1,
      uncheckedOutcome: 'STATE_STORE_BACKUP_UNVERIFIED',
      uncheckedSeen: [],
      afterUnchecked: 1,
      kept: true,
    });
  });

  // MA 3's rider R2: the two pre-checks of each verb but `backup`. `backup`'s code and sentences, and
  // `backup` as the default, are c6's cell (4) (`maintenance-616.test.ts`: the entry opened with no
  // verb), not repeated. #616 PR-2c c8a1: `check` joins, with its own code and "to check" words.
  it.each([
    ['migrate', 'no store file', 'missing', 'STATE_STORE_MIGRATE_REFUSED'],
    ['migrate', 'an empty store file', 'empty', 'STATE_STORE_MIGRATE_REFUSED'],
    ['check', 'no store file', 'missing', 'STATE_STORE_CHECK_REFUSED'],
    ['check', 'an empty store file', 'empty', 'STATE_STORE_CHECK_REFUSED'],
  ] as const)(
    '(F) opened for %s, a home with %s is refused in its own words, before anything is created or set up',
    async (verb, _, kind, code) => {
      const path = join(tmp(), '.realm');
      const file = join(path, 'realm.db');
      if (kind === 'empty') {
        mkdirSync(path);
        closeSync(openSync(file, 'wx'));
      }
      const refused = await refusal(openRealmHomeForMaintenance({ home: path, verb }));
      const holds = existsSync(path)
        ? readdirSync(path).map((name) => `${name} ${statSync(join(path, name)).size}`)
        : 'no home';
      // (1) red when the verb is ignored (backup's code and "to back up" words), or when the entry
      //     opens before it looks (the open creates the home, or sets the empty file up); (2) prints
      //     the refusal's code, message and details, and what the home holds after the call.
      expect({ refused, holds }).toEqual(
        kind === 'missing'
          ? {
              refused: {
                code,
                message: `There is no store file at ${file} to ${verb}.`,
                details: { path: file, reason: `there is no store file at ${file} to ${verb}` },
              },
              holds: 'no home',
            }
          : {
              refused: {
                code,
                message: `${file} holds no store yet: there is nothing to ${verb}.`,
                details: { path: file, reason: `${file} holds no store yet` },
              },
              holds: ['realm.db 0'],
            },
      );
    },
  );

  it('(H) migrate after close() rejects', async () => {
    const live = join(tmp(), '.realm');
    await storeWithRuns(live, 1);
    const m = await openRealmHomeForMaintenance({ home: live, verb: 'migrate' });
    m.close();
    // No backup: `backup`'s own closed check would answer first. (1) red when migrate's closed check
    //     is removed (the verb reaches the closed connection: another message); (2) prints the
    //     outcome.
    expect(await codeOf(m.migrate({ backup: false }))).toBe(
      `Error: The maintenance handle on ${join(live, 'realm.db')} is closed.`,
    );
  });
});
