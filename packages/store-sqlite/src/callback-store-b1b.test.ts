// callback-store-b1b.test.ts — callback B1b (R1.3): the SQLite callback rows store's own cells, on a
// real file. A create's row is written in the run's own transaction at each of the three insert
// sites (unkeyed, keyed fresh, supersede): a fault on the row's insert leaves no run. And the SQLite
// `due`, one statement, gives what core's pure `dueCallbacks` gives on the same rows, for a seeded
// set with ties, a host with 60 rows, unfinished runs and runs that are gone.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  abandonRun,
  dueCallbacks,
  type CallbackRow,
  type Clock,
  type CreateRunOptions,
} from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { openHome, type RealmHome } from './open-realm-home.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

const AT = '2026-03-01T10:00:00.000Z';
const clock: Clock = { now: () => new Date(AT), at: () => () => undefined };
const RUN: CreateRunOptions = { workflowId: 'wf-b1b', workflowVersion: 1, params: {} };
const callback = (n: number) => ({
  url: `https://hooks.example/callback/${n}`,
  host: 'hooks.example:443',
  webhook_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
});

const dirs: string[] = [];
const open: RealmHome[] = [];
afterEach(() => {
  for (const handle of open.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function freshHome(): Promise<{ home: string; handle: RealmHome }> {
  const dir = mkdtempSync(join(tmpdir(), 'realm-b1b-'));
  dirs.push(dir);
  const home = join(dir, '.realm');
  const handle = await openHome({ home, clock }, {});
  open.push(handle);
  return { home, handle };
}

/** Runs `statements` on a foreign connection. */
async function foreign(home: string, ...statements: string[]): Promise<void> {
  const c = await openForeignConnection(home);
  try {
    for (const statement of statements) c.exec(statement);
  } finally {
    c.close();
  }
}

/** How many runs of the workflow a scan lists. */
async function runCount(handle: RealmHome): Promise<number> {
  let n = 0;
  for await (const page of handle.runStore.scan({ workflow: RUN.workflowId }, { pageSize: 100 }))
    n += page.items.length;
  return n;
}

async function outcome(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return 'created';
  } catch (err) {
    return `rejected: ${(err as Error).message}`;
  }
}

describe('callback B1b — a create writes its callback row in the run’s own transaction', () => {
  it('with every insert into callbacks aborted, a create with a callback throws and leaves no run, at each of the three sites (unkeyed, keyed fresh, supersede)', async () => {
    const { home, handle } = await freshHome();
    const holder = await handle.runStore.create({ ...RUN, idempotencyKey: 'held' });
    await abandonRun(handle.runStore, holder.record.id);
    await foreign(
      home,
      "CREATE TRIGGER callbacks_torn BEFORE INSERT ON callbacks BEGIN SELECT RAISE(ABORT, 'planted insert fault'); END",
    );
    const before = await runCount(handle);
    const unkeyed = await outcome(() => handle.runStore.create({ ...RUN, callback: callback(1) }));
    const afterUnkeyed = await runCount(handle);
    const keyed = await outcome(() =>
      handle.runStore.create({ ...RUN, idempotencyKey: 'fresh', callback: callback(2) }),
    );
    const afterKeyed = await runCount(handle);
    const supersede = await outcome(() =>
      handle.runStore.create({
        ...RUN,
        idempotencyKey: 'held',
        onTerminalMatch: 'rerun',
        callback: callback(3),
      }),
    );
    const afterSupersede = await runCount(handle);
    // (1) red when a site writes the row in a transaction of its own (the run is then stored without
    //     its row), or a create with a callback no longer writes a row; (2) prints each create's
    //     outcome and the runs listed after it.
    expect({
      unkeyed,
      keyed,
      supersede,
      runs: [before, afterUnkeyed, afterKeyed, afterSupersede],
    }).toEqual({
      unkeyed: 'rejected: planted insert fault (SQLite error 1811)',
      keyed: 'rejected: planted insert fault (SQLite error 1811)',
      supersede: 'rejected: planted insert fault (SQLite error 1811)',
      runs: [1, 1, 1, 1],
    });
  });
});

describe('callback B1b — a webhook id another row holds', () => {
  it('is refused with VALIDATION_OPTION_INVALID, the in-memory store’s words, before the run or the row is written', async () => {
    const { handle } = await freshHome();
    await handle.runStore.create({ ...RUN, callback: callback(7) });
    const before = await runCount(handle);
    const refused = await handle.runStore
      .create({ ...RUN, callback: { ...callback(8), webhook_id: callback(7).webhook_id } })
      .then(
        () => 'created',
        (err: { code?: unknown; message?: unknown }) => ({ code: err.code, message: err.message }),
      );
    // (1) red when the store leaves the refusal to the UNIQUE index (a plain SQLite error, not the
    //     typed one), or writes the run first; (2) prints the refusal and the runs listed.
    expect({ refused, runs: [before, await runCount(handle)] }).toEqual({
      refused: {
        code: 'VALIDATION_OPTION_INVALID',
        message: 'This `callback.webhook_id` is already registered; no run was created.',
      },
      runs: [1, 1],
    });
  });
});

/** A seeded generator (a 32-bit linear congruential one), so the set is the same on every run. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe('callback B1b — the SQLite due gives what core’s pure dueCallbacks gives', () => {
  it('on a seeded set with ties, a host with 60 rows, unfinished runs and runs that are gone, for every limit tried', async () => {
    const { home, handle } = await freshHome();
    const random = seeded(1252);
    const hosts = ['a.example:443', 'b.example:443', 'c.example:8443', 'busy.example:443'];
    // Three instants, so rows tie on next_attempt_at across hosts and within one; the last is after
    // the reading, so such a row is not due.
    const stamps = [
      '2026-03-01T09:00:00.000Z',
      '2026-03-01T09:30:00.000Z',
      '2026-03-01T11:00:00.000Z',
    ];
    const inserts: string[] = [];
    const plant = (runId: string, host: string, status: string): void => {
      const next = stamps[Math.floor(random() * stamps.length)]!;
      inserts.push(
        `INSERT INTO callbacks (run_id, workflow_id, host, webhook_id, status, attempts, created_at, next_attempt_at, url) VALUES ('${runId}', 'wf', '${host}', '${randomUUID()}', '${status}', 0, '${AT}', '${next}', 'https://${host.split(':')[0]}/cb')`,
      );
    };
    for (let i = 0; i < 100; i++) {
      const run = (await handle.runStore.create(RUN)).record.id;
      // About one run in five stays unfinished.
      if (random() < 0.8) await abandonRun(handle.runStore, run);
      const host = i < 60 ? 'busy.example:443' : hosts[Math.floor(random() * 3)]!;
      plant(run, host, random() < 0.9 ? 'pending' : 'delivered');
    }
    // Rows whose run is gone.
    for (let i = 0; i < 5; i++) plant(randomUUID(), hosts[i % 4]!, 'pending');
    await foreign(home, 'BEGIN', ...inserts, 'COMMIT');
    const c = await openForeignConnection(home);
    let rows: CallbackRow[];
    let finished: Set<string>;
    try {
      rows = c
        .prepare('SELECT * FROM callbacks')
        .all()
        .map(
          (r) =>
            Object.fromEntries(
              Object.entries(r).filter(([, v]) => v !== null),
            ) as unknown as CallbackRow,
        );
      finished = new Set(
        c
          .prepare('SELECT id FROM runs WHERE terminal_state IS 1')
          .all()
          .map((r) => String(r['id'])),
      );
    } finally {
      c.close();
    }
    const limits = [1, 3, 4, 5, 7, 20, 61, 200];
    const ids = (items: readonly { run_id: string }[]): string[] => items.map((i) => i.run_id);
    const sqlite: Record<number, string[]> = {};
    const pure: Record<number, string[]> = {};
    for (const limit of limits) {
      sqlite[limit] = ids(await handle.runStore.callbacks.due(limit));
      pure[limit] = ids(dueCallbacks(rows, (id) => finished.has(id), new Date(AT), limit));
    }
    // (1) red when the SQLite statement orders a round otherwise (by host alone, or by run id), lets
    //     an unfinished or a gone run through, or takes two rows of one host in a round; (2) prints
    //     both id lists for every limit.
    expect(sqlite).toEqual(pure);
    // (1) red when the set lost what makes it a test (a due list as long as the limit, the busy
    //     host's rows, an unfinished run); (2) prints the counts.
    const busyDue = pure[200]!.filter(
      (id) => rows.find((r) => r.run_id === id)?.host === 'busy.example:443',
    ).length;
    expect({
      dueAtLeast20: pure[200]!.length >= 20,
      busyRows: rows.filter((r) => r.host === 'busy.example:443').length,
      busyDueOverManyRounds: busyDue >= 10,
      unfinishedOrGone: rows.filter((r) => !finished.has(r.run_id)).length > 5,
    }).toEqual({
      dueAtLeast20: true,
      busyRows: 61,
      busyDueOverManyRounds: true,
      unfinishedOrGone: true,
    });
  });
});
