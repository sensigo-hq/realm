// callback-store-c3d.test.ts — callback C3d-A (R1.3): the SQLite callback store's `endOverdue`, on a
// real file, read back through a second connection. An ended row is stored as a `failed` mark
// stores it: `failed`, `expired`, `url` and `body` NULL, and every other column as it was, the claim
// token included (the port's view hides it, so the contract cannot see it), a never-claimed row's
// `finished_at` still NULL. And the store's write is what core's pure `endOverdueCallbacks` gives
// on the same rows.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  abandonRun,
  CALLBACK_DELIVERY_WINDOW_SECONDS,
  endOverdueCallbacks,
  type CallbackRow,
  type Clock,
  type CreateRunOptions,
} from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { openHome, type RealmHome } from './open-realm-home.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

const T0 = Date.parse('2026-04-01T00:00:00.000Z');
let now = T0;
const clock: Clock = { now: () => new Date(now), at: () => () => undefined };
const RUN: CreateRunOptions = { workflowId: 'wf-c3d', workflowVersion: 1, params: {} };
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
  now = T0;
});

/** Every callback row and its run's facts, read on a second connection, in run_id order. */
async function stored(home: string): Promise<{
  raw: Record<string, unknown>[];
  rows: CallbackRow[];
  runs: Map<string, { finished: boolean; updatedAt: string }>;
}> {
  const c = await openForeignConnection(home);
  try {
    const raw = c.prepare('SELECT * FROM callbacks ORDER BY run_id').all();
    const rows = raw.map(
      (r) =>
        Object.fromEntries(
          Object.entries(r).filter(([, v]) => v !== null),
        ) as unknown as CallbackRow,
    );
    const runs = new Map(
      c
        .prepare('SELECT id, terminal_state, updated_at FROM runs')
        .all()
        .map((r) => [
          String(r['id']),
          { finished: r['terminal_state'] === 1, updatedAt: String(r['updated_at']) },
        ]),
    );
    return { raw, rows, runs };
  } finally {
    c.close();
  }
}

describe('callback C3d-A — the SQLite endOverdue', () => {
  it('stores an ended row as a failed mark stores it, the token and every other column kept, as core’s pure function writes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'realm-c3d-'));
    dirs.push(dir);
    const home = join(dir, '.realm');
    const handle = await openHome({ home, clock }, {});
    open.push(handle);
    const callbacks = handle.runStore.callbacks!;
    const claimed = (await handle.runStore.create({ ...RUN, callback: callback(1) })).record.id;
    await abandonRun(handle.runStore, claimed);
    const never = (await handle.runStore.create({ ...RUN, callback: callback(2) })).record.id;
    await abandonRun(handle.runStore, never);
    now = T0 + 1000;
    const view = await callbacks.read(claimed);
    const claim = await callbacks.claim(claimed, {
      expectedNextAttemptAt: view!.next_attempt_at,
      token: 'token-of-the-claim',
    });
    await callbacks.freezeBody(claimed, 'token-of-the-claim', '{"type":"run.finished"}');
    const before = await stored(home);
    now = T0 + CALLBACK_DELIVERY_WINDOW_SECONDS * 1000 + 120_000;
    const pure = endOverdueCallbacks(before.rows, (id) => before.runs.get(id), new Date(now), 10);
    const ended = await callbacks.endOverdue(10);
    const after = await stored(home);
    // (1) red when the setup no longer makes a claimed row with a token and a body beside a
    //     never-claimed one; (2) prints the claim's answer and the rows before.
    expect({
      claim: claim.applied,
      token: before.raw.map((r) => r['claim_token']),
      body: before.raw.map((r) => r['body'] !== null),
    }).toEqual({
      claim: true,
      token: [claimed, never].sort().map((id) => (id === claimed ? 'token-of-the-claim' : null)),
      body: [claimed, never].sort().map((id) => id === claimed),
    });
    // (1) red when the end drops the token, sets a never-claimed row's finished_at, keeps the url
    //     or the body, or changes any other column; (2) prints every column of both rows.
    expect(after.raw).toEqual(
      before.raw.map((r) => ({
        ...r,
        status: 'failed',
        last_status: 'expired',
        url: null,
        body: null,
      })),
    );
    // (1) red when the store writes or returns otherwise than core's pure function on the same rows;
    //     (2) prints both.
    expect({ ended, rows: after.rows }).toEqual({
      ended: pure.ended,
      rows: pure.writes.sort((a, b) => (a.run_id < b.run_id ? -1 : 1)),
    });
  });

  // An analysed file (`ANALYZE`, `PRAGMA optimize`: the schema check allows their tables) plans the
  // candidates through the due-time index, so rows tied on their anchor come in the order of their
  // `next_attempt_at`, not by run_id; the statement's own tie-break then decides which row the limit
  // takes. No randomness: the twelve rows' `next_attempt_at` are set through a second connection in
  // reverse run_id order, so the scan meets them largest id first, whatever the ids are.
  it('in an analysed file, rows tied on their anchor still end by run_id, at limit 1 and after', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'realm-c3d-'));
    dirs.push(dir);
    const home = join(dir, '.realm');
    const handle = await openHome({ home, clock }, {});
    open.push(handle);
    const callbacks = handle.runStore.callbacks!;
    const made: string[] = [];
    for (let i = 0; i < 12; i++)
      made.push((await handle.runStore.create({ ...RUN, callback: callback(10 + i) })).record.id);
    now = T0 + 1000;
    for (const id of made) await abandonRun(handle.runStore, id);
    const sorted = [...made].sort();
    const c = await openForeignConnection(home);
    let plan: string[];
    let scanned: string[];
    try {
      const set = c.prepare('UPDATE callbacks SET next_attempt_at = ? WHERE run_id = ?');
      [...sorted].reverse().forEach((id, k) => set.run(new Date(T0 + k).toISOString(), id));
      c.exec('ANALYZE');
      plan = c
        .prepare(
          `EXPLAIN QUERY PLAN SELECT c.run_id FROM callbacks c JOIN runs r ON r.id = c.run_id
  WHERE c.status = 'pending' AND c.next_attempt_at <= ? AND r.terminal_state IS 1
    AND COALESCE(c.finished_at, r.updated_at) <= ?
  ORDER BY COALESCE(c.finished_at, r.updated_at), c.run_id LIMIT ?`,
        )
        .all('9', '9', 1)
        .map((r) => String(r['detail']));
      scanned = c
        .prepare(
          "SELECT run_id FROM callbacks WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at",
        )
        .all('9')
        .map((r) => String(r['run_id']));
    } finally {
      c.close();
    }
    // (1) red when the setup no longer puts the rows in reverse run_id order of their due time, or
    //     the analysed file no longer plans through the due-time index (the case this cell is for is
    //     then not reached); (2) prints the order of the due times and the plan.
    expect({
      dueOrderIsReversed: scanned.join() === [...sorted].reverse().join(),
      dueIndex: plan.some((step) => step.includes('callbacks_due')),
    }).toEqual({ dueOrderIsReversed: true, dueIndex: true });
    now = T0 + 1000 + CALLBACK_DELIVERY_WINDOW_SECONDS * 1000;
    const first = (await callbacks.endOverdue(1)).map((e) => e.run_id);
    const rest = (await callbacks.endOverdue(1000)).map((e) => e.run_id);
    // (1) red when the statement's ORDER BY loses its run_id tie-break: the limit then takes the
    //     row with the largest id, which the scan meets first; (2) prints both lists against the
    //     run_id order.
    expect({ first, rest }).toEqual({ first: [sorted[0]], rest: sorted.slice(1) });
  });
});
