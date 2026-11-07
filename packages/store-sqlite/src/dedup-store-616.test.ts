// dedup-store-616.test.ts — issue #616 PR-1b B8: the duplicate-webhook memory on a Realm home's
// database, through the home's `dedupStoreFor` (what `realm listen` will call once the switch-over
// wires it). The real cases: a sender delivering one webhook twice, at once or after a restart; an
// operator lowering `ttl_minutes`; two workflows receiving the same event id; a scope after a long quiet
// period; a run purged at the customer's request; a write whose COMMIT reported an error after it
// landed; and the README's line, each clause tied to the cell that pins it.
//
// Time moves only when a cell moves it: a settable clock (or, for the one-reading cell, a stepping
// clock) from `@sensigo/realm-testing`, handed to the home. What is stored is read on a connection of
// the cell's own. The COMMIT fault comes from the driver seam (`test-support/commit-faults.ts`).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { Clock } from '@sensigo/realm';
import { settableClock, steppingClock } from '@sensigo/realm-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseLike } from './driver.js';
import { DATABASE_FILE } from './home.js';
import { openHome, openRealmHome, type RealmHome } from './open-realm-home.js';
import { faultyFiles, SQLITE } from './test-support/commit-faults.js';

const T0 = '2026-11-07T08:00:00.000Z';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The package README, its whitespace folded. */
const README = readFileSync(join(PACKAGE_ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
/** The README's line on duplicate webhooks; each cell that pins one of its clauses checks it is there. */
const LINE =
  "Duplicate webhooks: each id is remembered, as a hash, for its window, measured on the store's clock and fixed when it is recorded; each record also clears up to 100 expired ids.";
const says = (): boolean => README.includes(LINE);

const dirs: string[] = [];
const homes: RealmHome[] = [];
const others: DatabaseLike[] = [];
afterEach(() => {
  for (const c of others.splice(0)) c.close();
  for (const h of homes.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh home folder's path (`<temp>/.realm`, not made yet). */
function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-b8-'));
  dirs.push(dir);
  return join(dir, '.realm');
}

/** Opens `home` on `clock` through the package's entry; closed after the cell. */
async function open(home: string, clock: Clock): Promise<RealmHome> {
  const h = await openRealmHome({ home, clock });
  homes.push(h);
  return h;
}

/** The webhook ids of `home`, as stored, read on a connection of the cell's own. */
function rows(home: string): Array<Record<string, unknown>> {
  const c = openDatabase(join(home, DATABASE_FILE));
  others.push(c);
  return c
    .prepare(
      'SELECT scope, key_hash, recorded_at, expires_at FROM webhook_dedup ORDER BY scope, expires_at, key_hash',
    )
    .all()
    .map((r) => ({ ...r }));
}

/** The stored hash of a webhook id: the first 32 hex characters of its sha256. */
const hashOf = (id: string): string => createHash('sha256').update(id).digest('hex').slice(0, 32);
/** An instant `ms` after T0, in the store's text shape. */
const at = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString();

describe('#616 B8 — the window', () => {
  it('check 1: an id is live until its expiry, and not at it: the clock at exactly expires_at answers false', async () => {
    const home = freshHome();
    const clock = settableClock(T0);
    const dedup = (await open(home, clock)).dedupStoreFor('wf');
    await dedup.record('evt-1', MINUTE);
    await clock.set(new Date(Date.parse(T0) + MINUTE - 1));
    const before = await dedup.check('evt-1', MINUTE);
    await clock.set(new Date(Date.parse(T0) + MINUTE));
    const atExpiry = await dedup.check('evt-1', MINUTE);
    // (1) red when `check` ignores `expires_at` (any stored row answers true at its expiry), or
    //     compares at-or-after (`expires_at >= now`: true at its expiry), or the README line goes;
    //     (2) prints both answers and whether the README carries the line.
    expect({ before, atExpiry, says: says() }).toEqual({
      before: true,
      atExpiry: false,
      says: true,
    });
  });

  it('check 2: an operator lowers ttl_minutes and restarts listen: an id recorded for 60 minutes is still live at 30 minutes when checked with a 10-minute TTL', async () => {
    const home = freshHome();
    const clock = settableClock(T0);
    const dedup = (await open(home, clock)).dedupStoreFor('wf');
    await dedup.record('evt-2', 60 * MINUTE);
    await clock.advance(30 * MINUTE);
    const live = await dedup.check('evt-2', 10 * MINUTE);
    // (1) red when `check` applies its own `ttlMs` (the file store's check-time rule: 30 minutes is
    //     past 10), or the README line goes; (2) prints the answer and the README check.
    expect({ live, says: says() }).toEqual({ live: true, says: true });
  });

  it('check 3: a sender delivers one webhook twice at once: the second record inside the window resolves and the row keeps the first expiry', async () => {
    const home = freshHome();
    const clock = settableClock(T0);
    const dedup = (await open(home, clock)).dedupStoreFor('wf');
    await dedup.record('evt-3', HOUR);
    await clock.advance(5 * MINUTE);
    const second = await dedup.record('evt-3', HOUR).then(
      () => 'resolved',
      (e: unknown) => `rejected: ${String(e)}`,
    );
    // (1) red when `record` inserts without looking for a live row (SQLite refuses the second row
    //     for the same key: the record rejects and listen logs a failure), or replaces the row (its
    //     window moves to 65 minutes); (2) prints how the second record ended and the stored rows.
    expect({ second, rows: rows(home) }).toEqual({
      second: 'resolved',
      rows: [{ scope: 'wf', key_hash: hashOf('evt-3'), recorded_at: at(0), expires_at: at(HOUR) }],
    });
  });

  it('check 5: two workflows receive the same event id: an id recorded in one scope is not seen in another', async () => {
    const home = freshHome();
    const h = await open(home, settableClock(T0));
    await h.dedupStoreFor('wf-a').record('evt-5', HOUR);
    const answers = {
      sameScope: await h.dedupStoreFor('wf-a').check('evt-5', HOUR),
      otherScope: await h.dedupStoreFor('wf-b').check('evt-5', HOUR),
    };
    // (1) red when the key leaves out the scope (wf-b sees wf-a's id and drops its own first
    //     delivery); (2) prints both answers.
    expect(answers).toEqual({ sameScope: true, otherScope: false });
  });

  it('check 6: `realm listen` restarted: an id recorded, the home closed and opened again, is still seen', async () => {
    const home = freshHome();
    const clock = settableClock(T0);
    const first = await open(home, clock);
    await first.dedupStoreFor('wf').record('evt-6', HOUR);
    first.close();
    const again = await open(home, clock);
    const seen = await again.dedupStoreFor('wf').check('evt-6', HOUR);
    // (1) red when the store keeps its ids in memory (a new process starts empty and runs the
    //     webhook again), or the README line goes; (2) prints the answer and the README check.
    expect({ seen, says: says() }).toEqual({ seen: true, says: true });
  });
});

describe('#616 B8 — what is stored', () => {
  it('check 7: a run purged at the customer request leaves no raw webhook id here: the table holds its hash', async () => {
    const home = freshHome();
    const id = 'evt-7-customer-order-4711';
    await (await open(home, settableClock(T0))).dedupStoreFor('wf').record(id, HOUR);
    const stored = rows(home);
    // (1) red when the raw id is stored (in `key_hash` or any column), or the README line goes;
    //     (2) prints the stored rows (the id is a test value, not a secret) and the README check.
    expect({
      rows: stored,
      rawAnywhere: JSON.stringify(stored).includes(id),
      says: says(),
    }).toEqual({
      rows: [{ scope: 'wf', key_hash: hashOf(id), recorded_at: at(0), expires_at: at(HOUR) }],
      rawAnywhere: false,
      says: true,
    });
  });

  it("check 9: one clock reading per write: recorded_at is the write's one reading and expires_at is it plus the TTL", async () => {
    const home = freshHome();
    const clock = steppingClock(T0, 1_000);
    const dedup = (await open(home, clock)).dedupStoreFor('wf');
    const readsBefore = clock.reads;
    await dedup.record('evt-9', HOUR);
    const reading = Date.parse(T0) + readsBefore * 1_000;
    // (1) red when the write reads the clock a second time (for its expiry: it then lies one step
    //     past reading + TTL, and two readings are taken), or the README line goes; (2) prints the
    //     stored row, how many readings the write took and the README check.
    expect({ rows: rows(home), readings: clock.reads - readsBefore, says: says() }).toEqual({
      rows: [
        {
          scope: 'wf',
          key_hash: hashOf('evt-9'),
          recorded_at: new Date(reading).toISOString(),
          expires_at: new Date(reading + HOUR).toISOString(),
        },
      ],
      readings: 1,
      says: true,
    });
  });
});

describe('#616 B8 — expired ids are cleared as new ones are recorded', () => {
  it('check 4: a scope after a long quiet period (nothing calls cleanup): with 150 expired ids, one record deletes 100 and leaves 50', async () => {
    const home = freshHome();
    const clock = settableClock(T0);
    const dedup = (await open(home, clock)).dedupStoreFor('wf');
    for (let i = 0; i < 150; i++) await dedup.record(`old-${i}`, MINUTE);
    await clock.advance(2 * MINUTE);
    await dedup.record('new', HOUR);
    const stored = rows(home);
    const now = at(2 * MINUTE);
    // (1) red when `record` skips the expired-row delete (150 left) or drops its bound (0 left), or
    //     the README line goes; (2) prints how many expired and live rows are left, and the check.
    expect({
      expired: stored.filter((r) => String(r['expires_at']) <= now).length,
      live: stored.filter((r) => String(r['expires_at']) > now).map((r) => r['key_hash']),
      says: says(),
    }).toEqual({ expired: 50, live: [hashOf('new')], says: true });
  });
});

describe('#616 B8 — a write answered after an error at its COMMIT', () => {
  it('check 8: a record that landed and then met an error at COMMIT answers landed: it resolves and the id is seen', async () => {
    const home = freshHome();
    const files = faultyFiles((path) => openDatabase(path));
    const h = await openHome({ home, clock: settableClock(T0) }, { openFile: files.openFile });
    homes.push(h);
    // Driver seam: the record's COMMIT runs, then SQLite's I/O error (the data reached the file).
    // Real: the protocol's read-back, which is this write's own verify.
    files.opened[files.opened.length - 1]!.arm({
      at: (sql) => sql === 'COMMIT',
      times: 1,
      first: 'run',
      error: SQLITE.ioError,
    });
    const out = await h
      .dedupStoreFor('wf')
      .record('evt-8', HOUR)
      .then(
        () => 'resolved',
        (e: unknown) => `rejected: ${String(e)}`,
      );
    const seen = await h.dedupStoreFor('wf').check('evt-8', HOUR);
    // (1) red when the write's verify answers false for a row that is there (the protocol then
    //     runs a resolving commit and answers not_landed: the record rejects though the id is
    //     stored); (2) prints how the record ended, whether the id is seen, and the fault's hits.
    expect({ out, seen, hits: files.opened[0]!.hits() }).toEqual({
      out: 'resolved',
      seen: true,
      hits: 1,
    });
  });
});

describe('#616 B8 — one connection per home', () => {
  it('check 10: after the home is closed, its dedup store rejects', async () => {
    const home = freshHome();
    const h = await openRealmHome({ home, clock: settableClock(T0) });
    await h.dedupStoreFor('wf').record('evt-10', HOUR);
    h.close();
    const after = await h
      .dedupStoreFor('wf')
      .check('evt-10', HOUR)
      .then(
        (v) => `resolved ${String(v)}`,
        () => 'rejected',
      );
    // (1) red when the store has a connection of its own (it still answers after the home's one is
    //     closed: a second connection per home); (2) prints how the check ended.
    expect(after).toBe('rejected');
  });
});
