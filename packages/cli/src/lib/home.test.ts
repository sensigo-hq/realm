// home.test.ts — issue #616 PR-2a, unit (iii); PR-2c c10a-3a: the CLI's one door, on the SQLite home.
// Every store it opens keeps its records in the one home it was given, and the home is read when a
// command opens it, never when the module loads. The real case is #188's mixed wiring: a command
// that built one of its stores on another folder (the default home, say) wrote records its other
// stores never read. Each cell points HOME at a decoy folder, so a store opened on the default home
// writes there and the cell sees it. The door's laws on the SQLite home: the open creates the store,
// one handle per home per process, a home holding the old JSON store's folders and a copied test home
// are refused before anything is created.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFailedAttemptRecord,
  loadWorkflowFromString,
  serializeFailedAttemptLine,
  type Clock,
} from '@sensigo/realm';
import { createTestHome, type TestHome } from '@sensigo/realm-testing';
import { openCliHome, type CliHome } from './home.js';

const YAML = [
  'id: door616',
  'name: door616',
  'version: 1',
  'steps:',
  '  a:',
  '    description: A step.',
  '    execution: auto',
].join('\n');

/** The store's names in a home after the open, the write-ahead log's two files left out. */
const STORE_NAMES = ['dedup', 'realm.db', 'replays', 'runs', 'workflows'];
const entriesOf = (folder: string): string[] =>
  readdirSync(folder)
    .filter((e) => e !== 'realm.db-wal' && e !== 'realm.db-shm')
    .sort();

let scratch: string;
let decoy: string;
let savedHome: string | undefined;
/** Every handle a cell opened, closed after it (a closed handle's second `close()` does nothing). */
const opened: CliHome[] = [];
const testHomes: TestHome[] = [];
const open = async (options: Parameters<typeof openCliHome>[0]): Promise<CliHome> => {
  const home = await openCliHome(options);
  opened.push(home);
  return home;
};
/** The rejection's code and message, or that the open resolved. */
const refusalOf = (p: Promise<unknown>): Promise<{ code: unknown; message: string } | 'opened'> =>
  p.then(
    () => 'opened' as const,
    (err: unknown) => ({
      code: (err as { code?: unknown }).code,
      message: err instanceof Error ? err.message : String(err),
    }),
  );
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'realm-door-616-'));
  decoy = mkdtempSync(join(tmpdir(), 'realm-door-616-decoy-'));
  savedHome = process.env['HOME'];
  process.env['HOME'] = decoy;
});
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
  for (const t of testHomes.splice(0)) await t.remove();
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  rmSync(scratch, { recursive: true, force: true });
  rmSync(decoy, { recursive: true, force: true });
});

describe('#616 PR-2a (iii), PR-2c c10a-3a — openCliHome: one SQLite home for every store', () => {
  it('(a) every store keeps its records in the home it was given: a new handle on that home reads each back; the home holds the store’s five names; the decoy has no .realm', async () => {
    const path = join(scratch, '.realm');
    const home = await open({ home: path });
    const { record: run } = await home.runStore.create({
      workflowId: 'door616',
      workflowVersion: 1,
      params: {},
    });
    await home.workflowStore.register(loadWorkflowFromString(YAML));
    const attempt = buildFailedAttemptRecord({
      run_id: run.id,
      workflow_id: 'door616',
      step_id: 'a',
      ts: '2026-07-01T00:00:00.000Z',
      error_code: 'VALIDATION_OUTPUT_SCHEMA',
      ajv_errors: [],
      params: {},
      trace_entry_count: 0,
    });
    await home.failedAttemptStore.append(run.id, serializeFailedAttemptLine({ ...attempt }).line);
    await home.traceBufferStore.append(run.id, 'a', [{ event: 'e' }]);
    const replay = await home.replayStore.save({
      origin_run_id: run.id,
      workflow_id: 'door616',
      overrides: [],
      results: [],
    });
    await home.dedupStoreFor('door616').record('delivery-1', 3_600_000);
    const entries = entriesOf(path);
    await home.close();
    // A new handle on the same folder: what it reads is in that folder's store, nowhere else.
    const again = await open({ home: path });
    const readBack = {
      run: (await again.runStore.get(run.id)).record.id,
      workflow: (await again.workflowStore.get('door616')).id,
      attempts: (await again.failedAttemptStore.read(run.id)).records.length,
      trace: Object.values(await again.traceBufferStore.readAllForRun(run.id)).flat().length,
      replay: (await again.replayStore.get(replay.id))?.origin_run_id,
      dedup: await again.dedupStoreFor('door616').check('delivery-1', 3_600_000),
    };
    // (1) red when the door opens one of its stores on another folder — the default home (the decoy
    //     then holds a `.realm`, and the new handle reads nothing back) — or opens the home somewhere
    //     else than `path` (the five names are not there);
    // (2) prints what the new handle read back, the home's entries and whether the decoy holds one.
    expect({
      path: home.path,
      entries,
      readBack,
      decoyHasRealm: existsSync(join(decoy, '.realm')),
    }).toEqual({
      path,
      entries: STORE_NAMES,
      readBack: {
        run: run.id,
        workflow: 'door616',
        attempts: 1,
        trace: 1,
        replay: run.id,
        dedup: true,
      },
      decoyHasRealm: false,
    });
  });

  it('(b) the default home is read at the open, not when the module loads', async () => {
    // This module was imported before HOME was set (in beforeEach, above); a home captured at load
    // would be the one in place then.
    process.env['HOME'] = scratch;
    const home = await open({});
    // (1) red when the door reads the home once, at module load (`homedir()` captured in a module
    //     constant): the store then lands under the home in place at import, not under this HOME;
    // (2) prints the home's path and whether `realm.db` is under this HOME.
    expect({
      path: home.path,
      db: existsSync(join(scratch, '.realm', 'realm.db')),
    }).toEqual({ path: join(scratch, '.realm'), db: true });
  });

  it('(c) one handle per home per process: a second open shares the stores, another clock is refused, and close() ends it for both', async () => {
    const path = join(scratch, '.realm');
    const first = await open({ home: path });
    const second = await open({ home: path });
    const otherClock: Clock = { now: () => new Date(0), at: () => () => {} };
    const withClock = await refusalOf(openCliHome({ home: path, clock: otherClock }));
    const shared = {
      workflowStore: first.workflowStore === second.workflowStore,
      // On a plain home the test-clock wrap returns the store itself.
      runStore: first.runStore === second.runStore,
      replayStore: first.replayStore === second.replayStore,
    };
    await second.close();
    const afterClose = await refusalOf(first.workflowStore.list());
    const reopened = await open({ home: path });
    // (1) red when a second open builds a new handle (the stores are other objects), a second open
    //     with another clock is accepted, or `close()` leaves the first caller's handle open;
    //     (2) prints which stores are shared, both refusals, and whether the reopen is a new handle.
    expect({
      shared,
      withClock,
      afterCloseRejected: afterClose !== 'opened',
      reopenedIsNew: reopened.workflowStore !== first.workflowStore,
    }).toEqual({
      shared: { workflowStore: true, runStore: true, replayStore: true },
      withClock: {
        code: undefined,
        message: `The Realm home ${path} is already open in this process with another clock; close it first.`,
      },
      afterCloseRejected: true,
      reopenedIsNew: true,
    });
  });

  it('(c) on a test home: the registry is the same object on both opens, the run store a fresh notice wrap over the same store', async () => {
    const T = '2031-04-05T06:07:08.000Z';
    const testHome = await createTestHome({ start: T, root: join(scratch, 'th') });
    testHomes.push(testHome);
    const first = await open({ home: testHome.root });
    const second = await open({ home: testHome.root });
    const { record } = await first.runStore.create({
      workflowId: 'door616',
      workflowVersion: 1,
      params: {},
    });
    const { at } = await second.runStore.get(record.id);
    // (1) red when a second open builds a new handle (the registries differ), or the notice wrap is
    //     dropped on a test home (the run stores are then one object); (2) prints the identities, the
    //     run read through the second open and its clock's instant.
    expect({
      workflowStore: first.workflowStore === second.workflowStore,
      runStore: first.runStore === second.runStore,
      readThroughSecond: at.toISOString(),
    }).toEqual({ workflowStore: true, runStore: false, readThroughSecond: T });
  });

  it('(d) a home holding a DIRECTORY named runs (the old JSON store) is refused, and nothing is created', async () => {
    const path = join(scratch, '.realm');
    mkdirSync(join(path, 'runs'), { recursive: true });
    const refusal = await refusalOf(open({ home: path }));
    // (1) red when the legacy guard is bypassed (the open succeeds and the store's files appear);
    //     (2) prints the code, the home's entries and the runs folder's.
    expect({
      code: refusal === 'opened' ? 'opened' : refusal.code,
      entries: readdirSync(path).sort(),
      runs: readdirSync(join(path, 'runs')),
    }).toEqual({ code: 'STATE_HOME_HOLDS_LEGACY_STORE', entries: ['runs'], runs: [] });
  });

  it('(e) a copied test home is refused by its clock FIRST, before the legacy guard, and nothing is created', async () => {
    const T = '2031-04-05T06:07:08.000Z';
    const testHome = await createTestHome({ start: T, root: join(scratch, 'th') });
    testHomes.push(testHome);
    const copy = join(scratch, 'copy');
    cpSync(testHome.root, copy, { recursive: true });
    // A `runs` folder too: the clock's refusal must come before the guard's.
    mkdirSync(join(copy, 'runs'));
    const before = readdirSync(copy).sort();
    const refusal = await refusalOf(open({ home: copy }));
    // (1) red when the clock is read after the open (the guard's code comes first, or the store's
    //     files appear); (2) prints the code and the folder's entries before and after.
    expect({
      code: refusal === 'opened' ? 'opened' : refusal.code,
      after: readdirSync(copy).sort(),
    }).toEqual({ code: 'STATE_TEST_CLOCK_FOREIGN', after: before });
    expect(before).toEqual(['.realm-test-clock', 'runs']);
  });
});
