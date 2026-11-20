// callback-keys-list-k2a1.test.ts — callback K2a-1 (R1.3): the SQLite home's key listing
// (`runStore.keys.list()`) where only a real file can show it. The published laws (`CBK_LIST`, run by
// `callback-store.contract.test.ts`) hold every store to the listing; these cells add what the port
// cannot reach:
//   - a home opened with NO sealer, or with another master key's sealer, lists every slot
//     `unreadable` with the row's `master_fp`;
//   - a pair whose only row is a previous at or past its end (planted on a foreign connection: no
//     store method leaves one) is not listed; a pair whose only row is a live previous is;
//   - the listing writes nothing to the file: every row as stored, and the file's change counter
//     as another connection sees it (`PRAGMA data_version`), are the same after it.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it:
// (1) what turns it red, (2) what it prints then.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { openRealmHome, type RealmHome } from './open-realm-home.js';
import { testSealer } from './test-support/callbacks.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

const AT = '2026-03-01T10:00:00.000Z';
const HOUR_LATER = '2026-03-01T11:00:00.000Z';
const HOUR_EARLIER = '2026-03-01T09:00:00.000Z';
const clock: Clock = { now: () => new Date(AT), at: () => () => undefined };
const WF = 'wf-keys-list';
const A = 'a.example:443';
const B = 'b.example:443';
const MASTER_FP = 'c0ffee01';

const dirs: string[] = [];
const open: RealmHome[] = [];
afterEach(() => {
  for (const handle of open.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-k2a1-list-'));
  dirs.push(dir);
  return join(dir, '.realm');
}

async function track(opening: Promise<RealmHome>): Promise<RealmHome> {
  const handle = await opening;
  open.push(handle);
  return handle;
}

/** A home holding A (a current) and B (a current and a live previous), sealed under `c0ffee01`. */
async function homeWithKeys(): Promise<string> {
  const home = newHome();
  const handle = await openRealmHome({ home, clock, sealer: testSealer(MASTER_FP) });
  try {
    await handle.runStore.keys.make(WF, A, 'ab'.repeat(32));
    await handle.runStore.keys.make(WF, B, 'cd'.repeat(32));
    await handle.runStore.keys.rotate(WF, B, { candidate: 'ef'.repeat(32), keepSeconds: 3600 });
  } finally {
    handle.close();
  }
  return home;
}

/** One slot as a home that cannot unseal it lists it. */
const unreadable = (slot: 'current' | 'previous', expires?: string) => ({
  slot,
  state: 'unreadable',
  master_fp: MASTER_FP,
  created_at: AT,
  ...(expires !== undefined ? { expires_at: expires } : {}),
});

/** Plants one `previous` row ending at `expiresAt` on a foreign connection: no store method can. */
async function plantPrevious(home: string, host: string, expiresAt: string): Promise<void> {
  const c = await openForeignConnection(home);
  try {
    c.prepare(
      'INSERT INTO callback_keys (workflow_id, host, slot, sealed, key_fp, master_fp, created_at, expires_at) ' +
        "VALUES (?, ?, 'previous', X'00', 'aaaaaaaa', ?, ?, ?)",
    ).run(WF, host, MASTER_FP, HOUR_EARLIER, expiresAt);
  } finally {
    c.close();
  }
}

describe('callback K2a-1 — the SQLite home lists its keys', () => {
  it('a home opened with no sealer lists every slot unreadable, with the row’s master key fingerprint', async () => {
    const home = await homeWithKeys();
    const handle = await track(openRealmHome({ home, clock }));
    // (1) red when a sealer-less listing leaves a slot out, calls it readable or names another
    //     fingerprint; (2) prints the listing.
    expect(await handle.runStore.keys.list()).toEqual([
      { workflow_id: WF, host: A, current: unreadable('current') },
      {
        workflow_id: WF,
        host: B,
        current: unreadable('current'),
        previous: unreadable('previous', HOUR_LATER),
      },
    ]);
  });

  it('a home opened with another master key’s sealer lists the same', async () => {
    const home = await homeWithKeys();
    const handle = await track(openRealmHome({ home, clock, sealer: testSealer('0badf00d') }));
    // (1) red when a slot another master sealed is listed readable, or under the opener's
    //     fingerprint; (2) prints the listing.
    expect(await handle.runStore.keys.list()).toEqual([
      { workflow_id: WF, host: A, current: unreadable('current') },
      {
        workflow_id: WF,
        host: B,
        current: unreadable('current'),
        previous: unreadable('previous', HOUR_LATER),
      },
    ]);
  });

  it('a pair whose only row is a previous at its end is not listed; a live one is', async () => {
    const home = newHome();
    const handle = await track(openRealmHome({ home, clock, sealer: testSealer(MASTER_FP) }));
    await plantPrevious(home, 'ended.example:443', AT);
    await plantPrevious(home, 'kept.example:443', HOUR_LATER);
    // (1) red when a pair with no live slot is listed (the previous that ends at this instant), or
    //     when a pair holding only a live previous is left out; (2) prints the listing.
    expect(await handle.runStore.keys.list()).toEqual([
      {
        workflow_id: WF,
        host: 'kept.example:443',
        previous: { ...unreadable('previous', HOUR_LATER), created_at: HOUR_EARLIER },
      },
    ]);
  });

  it('the listing writes nothing: the rows as stored, and the file’s change counter', async () => {
    const home = await homeWithKeys();
    await plantPrevious(home, 'ended.example:443', AT);
    const handle = await track(openRealmHome({ home, clock, sealer: testSealer(MASTER_FP) }));
    const c = await openForeignConnection(home);
    try {
      const state = () => ({
        rows: c.prepare('SELECT * FROM callback_keys ORDER BY workflow_id, host, slot').all(),
        data_version: c.prepare('PRAGMA data_version').get(),
      });
      const before = state();
      await handle.runStore.keys.list();
      // (1) red when `list` writes: an ended row dropped, a row rewritten, or any commit another
      //     connection would see; (2) prints both states.
      expect(state()).toEqual(before);
      expect(before.rows).toHaveLength(4);
    } finally {
      c.close();
    }
  });
});
