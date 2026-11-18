// callback-keys-b1a.test.ts — callback B1a (R1.3): the sealer of a SQLite home's signing keys, on a
// real file. What the sealer is told on every seal and unseal; a slot under another master key; a
// home opened without a sealer; a second open with another sealer; and that the key never reaches
// the file plain, neither as its text nor as its raw bytes.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it:
// (1) what turns it red, (2) what it prints then.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { openRealmHome, type RealmHome } from './open-realm-home.js';
import { testSealer } from './test-support/callbacks.js';

const AT = '2026-03-01T10:00:00.000Z';
const clock: Clock = { now: () => new Date(AT), at: () => () => undefined };
const WF = 'wf-keys';
const HOST = 'hooks.example:443';
const KEY = 'ab'.repeat(32);
const KEY2 = 'cd'.repeat(32);

const dirs: string[] = [];
const open: RealmHome[] = [];
afterEach(() => {
  for (const handle of open.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-b1a-sealer-'));
  dirs.push(dir);
  return join(dir, '.realm');
}

async function track(opening: Promise<RealmHome>): Promise<RealmHome> {
  const handle = await opening;
  open.push(handle);
  return handle;
}

async function settle(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
    return 'resolved';
  } catch (err) {
    return { rejected: String(err) };
  }
}

describe('callback B1a — the sealer of the signing keys', () => {
  it('the sealer is given (workflow, host, slot) on every seal and unseal', async () => {
    const sealer = testSealer();
    const handle = await track(openRealmHome({ home: newHome(), clock, sealer }));
    const keys = handle.runStore.keys;
    await keys.make(WF, HOST, KEY);
    await keys.read(WF, HOST);
    await keys.rotate(WF, HOST, { candidate: KEY2, keepSeconds: 60 });
    const ctx = (slot: string) => ({ workflow_id: WF, host: HOST, slot });
    // (1) red when a seal or an unseal is given another pair or slot, or none, or the store unseals
    //     what it did not read; (2) prints every call in order.
    expect(sealer.calls).toEqual([
      { call: 'seal', ctx: ctx('current') },
      { call: 'unseal', ctx: ctx('current') },
      { call: 'unseal', ctx: ctx('current') },
      { call: 'seal', ctx: ctx('previous') },
      { call: 'seal', ctx: ctx('current') },
    ]);
  });

  it('a slot sealed under one master key reads unreadable under another, with the row’s master key fingerprint', async () => {
    const home = newHome();
    const first = await openRealmHome({ home, clock, sealer: testSealer('c0ffee01') });
    await first.runStore.keys.make(WF, HOST, KEY);
    first.close();
    const second = await track(openRealmHome({ home, clock, sealer: testSealer('feedface') }));
    // (1) red when an unseal that answers `undefined` is read as a key, or the slot carries the
    //     reading sealer's fingerprint instead of the row's; (2) prints the pair.
    expect(await second.runStore.keys.read(WF, HOST)).toEqual({
      current: { slot: 'current', state: 'unreadable', master_fp: 'c0ffee01', created_at: AT },
    });
  });

  it('without a sealer: every slot reads unreadable; make of a new key and replace throw, naming no key; rotate refuses; endPrevious and delete work', async () => {
    const home = newHome();
    const sealed = await openRealmHome({ home, clock, sealer: testSealer() });
    await sealed.runStore.keys.make(WF, HOST, KEY);
    await sealed.runStore.keys.rotate(WF, HOST, { candidate: KEY2, keepSeconds: 600 });
    await sealed.runStore.keys.make(WF, 'other.example:443', KEY);
    sealed.close();
    const handle = await track(openRealmHome({ home, clock }));
    const keys = handle.runStore.keys;
    const refused =
      'Error: This Realm home was opened without a callback key sealer, so it cannot write a signing key.';
    const unreadable = (slot: string, extra: object = {}) => ({
      slot,
      state: 'unreadable',
      master_fp: 'c0ffee01',
      created_at: AT,
      ...extra,
    });
    // (1) red when a slot is read without a sealer as anything but unreadable, a write that must
    //     seal does not throw (or names the key), a rotate reaches a seal, or endPrevious or delete
    //     need a sealer; (2) prints each answer.
    expect({
      read: await keys.read(WF, HOST),
      makeNew: await settle(() => keys.make(WF, 'new.example:443', KEY)),
      newPair: await keys.read(WF, 'new.example:443'),
      makeKept: await keys.make(WF, HOST, KEY),
      replace: await settle(() => keys.replace(WF, 'other.example:443', KEY2)),
      rotateNone: await keys.rotate(WF, 'new.example:443', { candidate: KEY2, keepSeconds: 60 }),
      rotateUnreadable: await keys.rotate(WF, HOST, { candidate: KEY2, keepSeconds: 60 }),
      end: await keys.endPrevious(WF, HOST),
      afterEnd: await keys.read(WF, HOST),
      delete: await keys.delete(WF, 'other.example:443'),
      afterDelete: await keys.read(WF, 'other.example:443'),
    }).toEqual({
      read: {
        current: unreadable('current'),
        previous: unreadable('previous', { expires_at: '2026-03-01T10:10:00.000Z' }),
      },
      makeNew: { rejected: refused },
      newPair: {},
      makeKept: { created: false, key: unreadable('current') },
      replace: { rejected: refused },
      rotateNone: { applied: false, reason: 'no_current' },
      rotateUnreadable: { applied: false, reason: 'current_unreadable' },
      end: { ended: true },
      afterEnd: { current: unreadable('current') },
      delete: { had_current: true },
      afterDelete: {},
    });
  });

  it('a second open of the same home with another sealer is refused, naming the home; one with no sealer shares the first', async () => {
    const home = newHome();
    const sealer = testSealer();
    const first = await track(openRealmHome({ home, clock, sealer }));
    // (1) red when the cache gives the second caller the first open (every key it writes then
    //     sealed by the first caller's sealer), or refuses a caller that brings no sealer or the
    //     same one; (2) prints each outcome.
    expect({
      other: await settle(() => openRealmHome({ home, clock, sealer: testSealer('feedface') })),
      same: (await openRealmHome({ home, clock, sealer })) === first,
      none: (await openRealmHome({ home, clock })) === first,
    }).toEqual({
      other: {
        rejected: `Error: The Realm home ${home} is already open in this process with another callback key sealer; close it first.`,
      },
      same: true,
      none: true,
    });
  });

  it('after make, the store file and its log hold neither the key’s text nor its 32 raw bytes', async () => {
    const home = newHome();
    const handle = await openRealmHome({ home, clock, sealer: testSealer() });
    await handle.runStore.keys.make(WF, HOST, KEY);
    const files = (): Buffer[] =>
      ['realm.db', 'realm.db-wal']
        .map((name) => join(home, name))
        .filter((path) => existsSync(path))
        .map((path) => readFileSync(path));
    const found = (bytes: Buffer[]) => ({
      text: bytes.some((b) => b.includes(Buffer.from(KEY, 'utf8'))),
      raw: bytes.some((b) => b.includes(Buffer.from(KEY, 'hex'))),
    });
    const whileOpen = found(files());
    handle.close();
    // (1) red when the store writes the key's text, or its raw bytes, into the file or the log;
    //     (2) prints which was found, while open and after the close.
    expect({ whileOpen, afterClose: found(files()) }).toEqual({
      whileOpen: { text: false, raw: false },
      afterClose: { text: false, raw: false },
    });
  });
});
