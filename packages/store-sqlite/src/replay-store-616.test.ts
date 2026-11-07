// replay-store-616.test.ts — issue #616 PR-1b B7: the SQLite replay store, through the home's handle
// (`openHome`, the package-internal open with its seams) as a host will reach it, and check 11 for both
// of the unit's stores. Store failures come from the driver seam (`test-support/commit-faults.ts`).
//
// The JSON store's cells (the CLI's `store/replay-store.test.ts`), each ported, covered or not
// applicable:
//   - save's id starts with "rpl_" and its `created_at` is an ISO stamp: ported (the id, below); the
//     stamp is covered by check 10 (the write's one reading, as ISO text);
//   - save and get round-trip: ported as check 7;
//   - get of an absent id throws "Replay not found: <id>": ported as check 9;
//   - two saves give two ids: ported (below).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clock, ReplayRecord, ReplayStepResult } from '@sensigo/realm';
import { steppingClock } from '@sensigo/realm-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './driver.js';
import { openHome, type RealmHome } from './open-realm-home.js';
import { faultyFiles, SQLITE, type FaultyFiles } from './test-support/commit-faults.js';

const fixed: Clock = { now: () => new Date('2026-11-07T09:00:00.000Z'), at: () => () => undefined };

const dirs: string[] = [];
const homes: RealmHome[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh Realm home on `clock`, opened through the open's `openFile` seam so failures can be armed. */
async function freshHome(clock: Clock = fixed): Promise<{ home: RealmHome; files: FaultyFiles }> {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-b7-'));
  dirs.push(dir);
  const files = faultyFiles((path) => openDatabase(path));
  const home = await openHome({ home: join(dir, '.realm'), clock }, { openFile: files.openFile });
  homes.push(home);
  return { home, files };
}

/** What `realm run replay --save` saves: a replay of a run with one changed step. */
const results: ReplayStepResult[] = [
  {
    step_id: 'fetch_doc',
    preconditions_original: true,
    preconditions_replay: true,
    changed: false,
    has_preconditions: false,
  },
  {
    step_id: 'write',
    preconditions_original: true,
    preconditions_replay: false,
    changed: true,
    has_preconditions: true,
  },
];
const replay: Omit<ReplayRecord, 'id' | 'created_at'> = {
  origin_run_id: '11111111-2222-4333-8444-555555555555',
  workflow_id: 'triage',
  overrides: ['validate.accepted_count=0'],
  results,
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

describe('#616 B7 — the SQLite replay store', () => {
  it('check 6 (save): a save whose COMMIT reached the file and then reported an error is answered landed (review R4)', async () => {
    const { home, files } = await freshHome();
    files.opened[0]!.arm({
      at: (sql) => sql === 'COMMIT',
      times: 1,
      first: 'run',
      error: SQLITE.ioError,
    });
    const settled = await home.replayStore.save(replay).then(
      (saved) => ({ saved }),
      (err: unknown) => ({ rejected: message(err) }),
    );
    const read =
      'saved' in settled ? await home.replayStore.get(settled.saved.id) : 'nothing saved';
    // (1) red when save's verify answers false for a landed save (the named break: the protocol then
    //     calls it not landed and save rejects), or when the COMMIT did not fire; (2) prints how save
    //     settled, the fault's firings and what get reads back.
    expect({ fired: files.opened[0]!.hits(), settled, read }).toEqual({
      fired: 1,
      settled: { saved: read },
      read: {
        ...replay,
        id: expect.stringMatching(/^rpl_/),
        created_at: '2026-11-07T09:00:00.000Z',
      },
    });
  });

  it('check 7: realm run diff reads what realm run replay --save saved: get(save(x).id) deep-equals what save returned, in its key order', async () => {
    const { home } = await freshHome();
    const saved = await home.replayStore.save(replay);
    const read = await home.replayStore.get(saved.id);
    // (1) red when the stored record leaves out `created_at` (the named break) or anything else save
    //     returned, or keeps another key order; (2) prints both records.
    expect({ read, keys: Object.keys(read) }).toEqual({
      read: saved,
      keys: ['origin_run_id', 'workflow_id', 'overrides', 'results', 'id', 'created_at'],
    });
  });

  it('check 8: the operator misled by "not found": get rejects with the store\'s error when the read fails', async () => {
    const { home, files } = await freshHome();
    const saved = await home.replayStore.save(replay);
    files.opened[0]!.arm({
      at: (sql) => sql.startsWith('SELECT record FROM replays'),
      times: 1,
      first: 'nothing',
      error: SQLITE.ioError,
    });
    const settled = await home.replayStore.get(saved.id).then(
      () => 'resolved',
      (err: unknown) => message(err),
    );
    // (1) red when every read failure is mapped to "Replay not found" (the named break); (2) prints
    //     what get settled with.
    expect(settled).toBe('disk I/O error (SQLite error 10)');
  });

  it('check 9: a mistyped replay id: get of an absent id rejects with "Replay not found: <id>", exactly', async () => {
    const { home } = await freshHome();
    await home.replayStore.save(replay);
    const settled = await home.replayStore.get('rpl_mistyped').then(
      (found) => ({ resolved: found as unknown }),
      (err: unknown) => ({ rejected: message(err) }),
    );
    // (1) red when an absent id resolves (the named break: `undefined` returned) or its message
    //     changes; (2) prints what get settled with.
    expect(settled).toEqual({ rejected: 'Replay not found: rpl_mistyped' });
  });

  it("check 10: one clock per write (framework rule 10): with a stepping clock, created_at is that write's one reading", async () => {
    const start = Date.parse('2026-11-07T09:00:00.000Z');
    const clock = steppingClock(new Date(start), 1_000);
    const { home } = await freshHome(clock);
    const readsBefore = clock.reads;
    const saved = await home.replayStore.save(replay);
    // (1) red when save reads the clock a second time (the named break: `created_at` is the next
    //     step, and the save spends two readings); (2) prints `created_at` against the reading the
    //     write took, and the readings the save spent.
    expect({ created_at: saved.created_at, readings: clock.reads - readsBefore }).toEqual({
      created_at: new Date(start + readsBefore * 1_000).toISOString(),
      readings: 1,
    });
  });

  it('check 11: one connection per home: after home.close(), failedAttemptStore.read and replayStore.get reject', async () => {
    const { home } = await freshHome();
    const saved = await home.replayStore.save(replay);
    await home.failedAttemptStore.append(replay.origin_run_id, JSON.stringify({ step_id: 'x' }));
    home.close();
    const read = await home.failedAttemptStore.read(replay.origin_run_id).then(
      () => 'resolved',
      () => 'rejected',
    );
    const got = await home.replayStore.get(saved.id).then(
      () => 'resolved',
      () => 'rejected',
    );
    const append = await home.failedAttemptStore.append(replay.origin_run_id, '{}').then(
      () => 'resolved',
      () => 'rejected',
    );
    // (1) red when a store is built on a connection of its own (the named break: closing the home
    //     leaves it open, so its reads resolve); (2) prints how each call settled. `append` resolves:
    //     it swallows every error.
    expect({ read, got, append }).toEqual({
      read: 'rejected',
      got: 'rejected',
      append: 'resolved',
    });
  });

  it('save gives each replay its own "rpl_" id, and two saves of one replay two readable records (the file store cells, ported)', async () => {
    const { home } = await freshHome();
    const a = await home.replayStore.save(replay);
    const b = await home.replayStore.save(replay);
    const [readA, readB] = [await home.replayStore.get(a.id), await home.replayStore.get(b.id)];
    // (1) red when the id loses its prefix (break: the bare UUID) or two saves take one id (break: a
    //     fixed id; the second save is refused by the key); (2) prints both ids and what each reads.
    expect({ a: a.id, b: b.id, distinct: a.id !== b.id, readA, readB }).toEqual({
      a: expect.stringMatching(/^rpl_[0-9a-f-]{36}$/),
      b: expect.stringMatching(/^rpl_[0-9a-f-]{36}$/),
      distinct: true,
      readA: a,
      readB: b,
    });
  });

  it("README: replays' sentence is there, and its claims are the cells above (saved and read by id: 7, 9; a failure as itself: 8)", () => {
    const readme = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'),
      'utf8',
    ).replace(/\s+/g, ' ');
    const sentence =
      'Replays are saved and read by id; a store failure is reported as itself, never as "not found".';
    // (1) red when the sentence is removed or reworded without this cell; (2) prints the sentence
    //     looked for.
    expect(readme.includes(sentence), sentence).toBe(true);
  });
});
