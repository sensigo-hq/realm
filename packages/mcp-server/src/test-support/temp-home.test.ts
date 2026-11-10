// temp-home.test.ts — issue #616 PR-2a, unit (ii-a); PR-2b, b3: the helper every test that builds the
// MCP server takes its stores from. The real case: a test that builds a store on the developer's real
// home writes runs into it (the library's defaults are the real `~/.realm`). The cell points HOME at a
// decoy folder, so a store built on the default home writes there and the cell sees it. b3's cells:
// a test seeds a run through the handle and drives a child with `HOME: root`, or opens the handle on a
// test location; the helper must open the folder the test names and remove only what it made.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  buildFailedAttemptRecord,
  loadWorkflowFromString,
  serializeFailedAttemptLine,
  type RunStore,
} from '@sensigo/realm';
import { createTestHome, InMemoryStore, type TestHome } from '@sensigo/realm-testing';
import { openMcpHome } from '../home.js';
import { makeTempHome, runCount, runIds, runsOf, type TempHome } from './temp-home.js';

const YAML = [
  'id: home616',
  'name: home616',
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

let decoy: string;
let savedHome: string | undefined;
beforeEach(() => {
  decoy = mkdtempSync(join(tmpdir(), 'realm-temp-home-decoy-'));
  savedHome = process.env['HOME'];
  process.env['HOME'] = decoy;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  rmSync(decoy, { recursive: true, force: true });
});

const handles: TempHome[] = [];
const scratches: string[] = [];
const locations: TestHome[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.cleanup();
  for (const l of locations.splice(0)) await l.remove();
  for (const s of scratches.splice(0)) rmSync(s, { recursive: true, force: true });
});
function scratch(): string {
  const s = mkdtempSync(join(tmpdir(), 'realm-temp-home-test-'));
  scratches.push(s);
  return s;
}

describe('#616 PR-2a (ii-a) — makeTempHome', () => {
  it('four stores in one fresh home: a new handle reads each back; the home holds the five names; cleanup() twice leaves nothing', async () => {
    const home = await makeTempHome();
    const { runStore, workflowStore, traceBufferStore, failedAttemptStore } = home.stores;
    const { record: run } = await runStore.create({
      workflowId: 'home616',
      workflowVersion: 1,
      params: {},
    });
    await workflowStore.register(loadWorkflowFromString(YAML));
    const attempt = buildFailedAttemptRecord({
      run_id: run.id,
      workflow_id: 'home616',
      step_id: 'a',
      ts: '2026-07-01T00:00:00.000Z',
      error_code: 'VALIDATION_OUTPUT_SCHEMA',
      ajv_errors: [],
      params: {},
      trace_entry_count: 0,
    });
    await failedAttemptStore.append(run.id, serializeFailedAttemptLine({ ...attempt }).line);
    await traceBufferStore.append(run.id, 'a', [{ event: 'e' }]);
    const entries = entriesOf(home.path);
    // Closed, then opened afresh: what the new handle reads is in that folder's store, nowhere else.
    await openMcpHome({ home: home.path }).then((h) => h.close());
    const again = await openMcpHome({ home: home.path });
    const readBack = {
      run: (await again.runStore.get(run.id)).record.id,
      workflow: (await again.workflowStore.get('home616')).id,
      attempts: (await again.failedAttemptStore.read(run.id)).records.length,
      trace: Object.values(await again.traceBufferStore.readAllForRun(run.id)).flat().length,
    };
    again.close();
    const decoyHasRealm = existsSync(join(decoy, '.realm'));
    const folder = dirname(home.path);
    await home.cleanup();
    await home.cleanup();
    // (1) red when the helper opens one of its stores on another folder — the default home (the decoy
    //     then holds a `.realm`, and the new handle reads nothing back) — or the home is opened
    //     somewhere else than `path`, or `cleanup()` leaves the folder or throws the second time;
    // (2) prints what the new handle read, the home's entries, whether the decoy holds a `.realm`, and
    //     whether the temp folder is still there.
    expect({ entries, readBack, decoyHasRealm, leftAfterCleanup: existsSync(folder) }).toEqual({
      entries: STORE_NAMES,
      readBack: { run: run.id, workflow: 'home616', attempts: 1, trace: 1 },
      decoyHasRealm: false,
      leftAfterCleanup: false,
    });
  });

  it('the default home is read at the open, not when the module loads', async () => {
    // This module was imported before HOME was set (in beforeEach, above).
    const elsewhere = scratch();
    process.env['HOME'] = elsewhere;
    const home = await openMcpHome();
    const path = home.path;
    const db = existsSync(join(elsewhere, '.realm', 'realm.db'));
    home.close();
    // (1) red when the door reads the home once, at module load (the store lands under the home in
    //     place at import); (2) prints the home's path and whether `realm.db` is under this HOME.
    expect({ path, db }).toEqual({ path: join(elsewhere, '.realm'), db: true });
  });

  it('one handle per home per process: a second open hands back the same four stores, and close() on either ends it for both', async () => {
    const path = join(scratch(), '.realm');
    const first = await openMcpHome({ home: path });
    const second = await openMcpHome({ home: path });
    const same = {
      runStore: first.runStore === second.runStore,
      workflowStore: first.workflowStore === second.workflowStore,
      traceBufferStore: first.traceBufferStore === second.traceBufferStore,
      failedAttemptStore: first.failedAttemptStore === second.failedAttemptStore,
    };
    second.close();
    const afterClose = await first.workflowStore.list().then(
      () => 'resolved',
      () => 'rejected',
    );
    const reopened = await openMcpHome({ home: path });
    const reopenedIsNew = reopened.workflowStore !== first.workflowStore;
    reopened.close();
    // (1) red when a second open builds a new handle (the stores are other objects), or `close()`
    //     leaves the first caller's handle open; (2) prints which stores are shared, how the first
    //     caller's read ended, and whether the reopen is a new handle.
    expect({ same, afterClose, reopenedIsNew }).toEqual({
      same: {
        runStore: true,
        workflowStore: true,
        traceBufferStore: true,
        failedAttemptStore: true,
      },
      afterClose: 'rejected',
      reopenedIsNew: true,
    });
  });
});

describe('#616 PR-2b b3 — makeTempHome(), the CLI helper’s shape', () => {
  it('a fresh handle: root under the temp folder, the opener on <root>/.realm, the runs a child with HOME: root opens', async () => {
    const h = await makeTempHome();
    handles.push(h);
    // (1) red when the opener is opened on `root` instead of `<root>/.realm` (every path below loses
    //     its `.realm`), or the root is made elsewhere or named otherwise;
    // (2) prints the root's place and name, whether it exists, and the two paths.
    expect({
      underTmp: dirname(h.root) === tmpdir(),
      named: basename(h.root).startsWith('realm-temp-home-'),
      exists: existsSync(h.root),
      path: h.path,
      db: existsSync(join(h.path, 'realm.db')),
    }).toEqual({
      underTmp: true,
      named: true,
      exists: true,
      path: join(h.root, '.realm'),
      db: true,
    });
  });

  it('a given .realm path: its parent is the root, the path as given, and the open creates the store there', async () => {
    const s = scratch();
    const given = join(s, '.realm');
    const h = await makeTempHome({ home: given });
    handles.push(h);
    // (1) red when `root` is undefined on every given path, or the helper opens another folder than
    //     the one given (the store is then not there); (2) prints `root`, `path` and what the scratch
    //     folder and the given folder hold.
    expect({
      root: h.root,
      path: h.path,
      scratch: readdirSync(s),
      given: entriesOf(given),
    }).toEqual({
      root: s,
      path: given,
      scratch: ['.realm'],
      given: STORE_NAMES,
    });
  });

  it('a test home by its own root: no root, the test home’s folder, and its clock read at the open', async () => {
    const T = '2031-04-05T06:07:08.000Z';
    const location = await createTestHome({ start: T, root: join(scratch(), 'loc') });
    locations.push(location);
    const h = await makeTempHome({ home: location.root });
    handles.push(h);
    const { record } = await h.stores.runStore.create({
      workflowId: 'wf',
      workflowVersion: 1,
      params: {},
    });
    const { at } = await h.stores.runStore.get(record.id);
    // (1) red when `root` is `dirname(home)` on every given path (a test home's parent is no child's
    //     HOME), or the door opens another folder than the test home's, or the run store runs on the
    //     real clock (the home's test-clock file not read at the open);
    // (2) prints `root`, the path, whether `realm.db` is in the test home, and the snapshot's `at`.
    expect({
      root: h.root,
      path: h.path,
      db: existsSync(join(location.root, 'realm.db')),
      at: at.toISOString(),
    }).toEqual({ root: undefined, path: location.root, db: true, at: T });
  });

  it('cleanup() removes the helper’s own root, and a second call resolves', async () => {
    const h = await makeTempHome();
    await h.cleanup();
    const second = await h.cleanup().then(
      () => 'resolved',
      (e: unknown) => `rejected: ${String(e)}`,
    );
    // (1) red when cleanup leaves the root (no removal), or a second call rejects;
    // (2) prints the root, whether it still exists, and how the second call ended.
    expect({ root: h.root, exists: existsSync(h.root), second }).toEqual({
      root: h.root,
      exists: false,
      second: 'resolved',
    });
  });

  it('cleanup() on a given home removes nothing', async () => {
    const given = join(scratch(), '.realm');
    mkdirSync(given);
    const h = await makeTempHome({ home: given });
    await h.cleanup();
    // (1) red when cleanup removes every root, the helper's own or not (a test home's handle, or a
    //     handle on another handle's folder, would remove that folder under the test);
    // (2) prints the folder and whether it, and the store file in it, still exist.
    expect({
      given,
      exists: existsSync(given),
      db: existsSync(join(given, 'realm.db')),
    }).toEqual({
      given,
      exists: true,
      db: true,
    });
  });
});

describe('#616 PR-2c c0 — runCount and runIds read the runs through the store', () => {
  it('on a fresh home: 0 and [] with no runs folder made first; after two creates: 2 and both ids, ascending', async () => {
    // Each reader takes its first look at a fresh home of its own. #616 PR-2c c10b-2: on the SQLite
    // home `runs` is the store's fence FILE, never a folder.
    const counted = await makeTempHome();
    const listed = await makeTempHome();
    const h = await makeTempHome();
    handles.push(counted, listed, h);
    const folderBefore = [counted, listed].map((t) => statSync(join(t.path, 'runs')).isDirectory());
    const fresh = {
      count: await runCount(counted.stores.runStore),
      ids: await runIds(listed.stores.runStore),
    };
    const store = h.stores.runStore;
    const a = (await store.create({ workflowId: 'w', workflowVersion: 1, params: {} })).record.id;
    const b = (await store.create({ workflowId: 'w', workflowVersion: 1, params: {} })).record.id;
    const count = await runCount(store);
    const ids = await runIds(store);
    // (1) red when a reader counts the files in the runs folder (`readdir`) instead of asking the
    //     store: the home holds no runs folder (`runs` is a file), so on the fresh home the read throws;
    //     `ascending` checks this store's listing only — the JSON store's `list()` already sorts, so
    //     the order is guarded by the next cell, whose store answers out of order; (2) prints whether
    //     the folder was there first, the count
    //     and the ids before and after the two creates, and both created ids.
    expect({
      folderBefore,
      fresh,
      count,
      ids,
      created: [a, b],
      ascending: ids[0]! < ids[1]!,
    }).toEqual({
      folderBefore: [false, false],
      fresh: { count: 0, ids: [] },
      count: 2,
      ids: expect.arrayContaining([a, b]),
      created: [a, b],
      ascending: true,
    });
    expect(ids).toHaveLength(2);
  });

  it('a store with no folder whose scan() answers b then a: runCount 2, runIds [a, b]', async () => {
    // A store with no runs folder at all (no `runsDirPath`) whose one page of a scan answers `b` then
    // `a`: the readers can answer only through `scan()` (#616 PR-2c c4), and only their sort puts the
    // ids in order.
    const store = {
      async *scan() {
        yield {
          items: [
            { kind: 'run', run: { record: { id: 'b' } } },
            { kind: 'run', run: { record: { id: 'a' } } },
          ],
          read_at: new Date('2026-11-08T00:00:00.000Z'),
          consistent_snapshot: true,
          derived_at_read: 0,
        };
      },
    } as unknown as Pick<RunStore, 'scan'>;
    // (1) red when a reader counts the files of a runs folder, even behind an `existsSync` guard (this
    //     store has none, so a guarded read answers 0 and []), or when runIds drops its sort (it then
    //     answers [b, a]); (2) prints the count and the ids, expected against got.
    expect({ count: await runCount(store), ids: await runIds(store) }).toEqual({
      count: 2,
      ids: ['a', 'b'],
    });
  });
});

describe('#616 PR-2c c4 — runsOf reads every page of a scan', () => {
  it('1,001 runs come back, not one page of 1,000', async () => {
    const store = new InMemoryStore();
    for (let i = 0; i < 1001; i++) {
      await store.create({ workflowId: 'wf', workflowVersion: 1, params: {} });
    }
    // (1) red when runsOf stops after the first page (it then answers 1,000) or reads a page twice;
    //     (2) prints the count and the distinct ids.
    const runs = await runsOf(store);
    expect({ runs: runs.length, distinct: new Set(runs.map((s) => s.record.id)).size }).toEqual({
      runs: 1001,
      distinct: 1001,
    });
  });
});
