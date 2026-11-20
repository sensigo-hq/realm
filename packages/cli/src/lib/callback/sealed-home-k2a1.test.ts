// sealed-home-k2a1.test.ts — callback K2a-1 (R1.3): `openCliHome` opens the home with a sealer when
// it is given one (`sealer`, passed on to the store's `openRealmHome`). A key made through such a home
// reads readable through `runStore.callbacks.keys`; the same home reopened with no sealer reads it
// `unreadable` under the master key's fingerprint; and a second open with another sealer, while the
// first is still open, is refused (the store's own refusal, callback B1a). Real homes in a scratch
// folder, the real AES-256-GCM sealer (`createCallbackKeySealer`).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCallbackKeySealer, masterKeyFingerprint } from '@sensigo/realm-store-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openCliHome, type CliHome } from '../home.js';

const MASTER = new Uint8Array(32).fill(0xa1);
const OTHER = new Uint8Array(32).fill(0xb2);
const WF = 'wf-sealed-home';
const HOST = 'hooks.example:443';
const KEY = '5e'.repeat(32);

const dirs: string[] = [];
const open: CliHome[] = [];
afterEach(async () => {
  for (const home of open.splice(0)) await home.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function newHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-k2a1-sealed-'));
  dirs.push(dir);
  return join(dir, '.realm');
}

async function track(opening: Promise<CliHome>): Promise<CliHome> {
  const home = await opening;
  open.push(home);
  return home;
}

/** The current slot's state, and its key or master fingerprint. */
async function current(home: CliHome): Promise<unknown> {
  const slot = (await home.runStore.callbacks!.keys.read(WF, HOST)).current;
  if (slot === undefined) return 'absent';
  return slot.state === 'readable'
    ? { state: slot.state, key: slot.key }
    : { state: slot.state, master_fp: slot.master_fp };
}

describe('callback K2a-1 — the home opened with a sealer', () => {
  it('a key made through openCliHome({ sealer }) reads readable; reopened with none, unreadable', async () => {
    const path = newHome();
    const sealed = await openCliHome({ home: path, sealer: createCallbackKeySealer(MASTER) });
    await sealed.runStore.callbacks!.keys.make(WF, HOST, KEY);
    const withSealer = await current(sealed);
    await sealed.close();
    const plain = await track(openCliHome({ home: path }));
    // (1) red when `openCliHome` does not pass the sealer on (the make then throws: no sealer), or
    //     a sealer-less reopen reads the key; (2) prints both reads.
    expect({ withSealer, withNone: await current(plain) }).toEqual({
      withSealer: { state: 'readable', key: KEY },
      withNone: { state: 'unreadable', master_fp: masterKeyFingerprint(MASTER) },
    });
  });

  it('a second open with another sealer, on a home still open, is refused', async () => {
    const path = newHome();
    await track(openCliHome({ home: path, sealer: createCallbackKeySealer(MASTER) }));
    let refused: unknown;
    try {
      await track(openCliHome({ home: path, sealer: createCallbackKeySealer(OTHER) }));
    } catch (err) {
      refused = err;
    }
    // (1) red when the second sealer is accepted (one handle per home: the second would silently
    //     share the first's sealer, or replace it); (2) prints what the second open did.
    expect(refused instanceof Error ? 'rejected' : 'opened').toBe('rejected');
  });
});
