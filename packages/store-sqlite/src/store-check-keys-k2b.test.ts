// store-check-keys-k2b.test.ts — callback K2b (R1.3): the check counts the stored callback keys
// (`callback_keys`, every slot) inside its data pass and, given a master key fingerprint, how many
// were recorded under another (`callback_keys_other_master`). The check has no sealer: it compares the
// recorded fingerprint only, so a key damaged under the given fingerprint is not told apart (a limit,
// pinned below). Homes are filled through the library with real sealers.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createCallbackKeySealer, masterKeyFingerprint, openRealmHome } from './index.js';
import { openMaintenance } from './maintenance.js';
import { openHome } from './open-realm-home.js';
import type { CheckOptions, CheckReport } from './store-check.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MASTER_A = new Uint8Array(Buffer.from('a1'.repeat(32), 'hex'));
const MASTER_B = new Uint8Array(Buffer.from('b2'.repeat(32), 'hex'));
const FP_A = masterKeyFingerprint(MASTER_A);
const FP_B = masterKeyFingerprint(MASTER_B);
const keyText = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);

function homeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-k2b-check-'));
  dirs.push(dir);
  return join(dir, '.realm');
}

/** The check's report on `home`, the handle closed. */
async function check(home: string, options?: CheckOptions): Promise<CheckReport> {
  const m = await openMaintenance({ home, verb: 'check' }, {});
  try {
    return await m.check(options);
  } finally {
    m.close();
  }
}

/** The two facts of a report, and whether each is present. */
const counts = (r: CheckReport) => ({
  keys: 'callback_keys' in r.facts ? r.facts.callback_keys : 'absent',
  other: 'callback_keys_other_master' in r.facts ? r.facts.callback_keys_other_master : 'absent',
});

/**
 * A home with two pairs under master A (the first rotated: its current and its previous) and one pair
 * under master B: four rows, one of them under B.
 */
async function seeded(): Promise<string> {
  const home = homeDir();
  const a = await openRealmHome({ home, sealer: createCallbackKeySealer(MASTER_A) });
  await a.runStore.keys.make('wf-a', 'one.example:443', keyText(1));
  await a.runStore.keys.rotate('wf-a', 'one.example:443', {
    candidate: keyText(2),
    keepSeconds: 60,
  });
  await a.runStore.keys.make('wf-a', 'two.example:443', keyText(3));
  a.close();
  const b = await openRealmHome({ home, sealer: createCallbackKeySealer(MASTER_B) });
  await b.runStore.keys.make('wf-b', 'three.example:443', keyText(4));
  b.close();
  return home;
}

describe('callback K2b — the check counts the callback keys', () => {
  it('no keys: 0 is a fact; the other-master count only when a fingerprint is given', async () => {
    const home = homeDir();
    const h = await openRealmHome({ home });
    h.close();
    // (1) red when 0 is left out (a count only above 0), or the other-master count is present when
    //     not asked or when the caller has no master key (`null`); (2) prints the two facts each time.
    expect({
      notAsked: counts(await check(home)),
      noMaster: counts(await check(home, { masterFp: null })),
      asked: counts(await check(home, { masterFp: FP_A })),
    }).toEqual({
      notAsked: { keys: 0, other: 'absent' },
      noMaster: { keys: 0, other: 'absent' },
      asked: { keys: 0, other: 0 },
    });
  });

  it('every stored slot counts (a rotated pair is 2); the other-master count compares the recorded fingerprint', async () => {
    const home = await seeded();
    // (1) red when a pair is counted once (the previous slot dropped), a column other than the
    //     master's fingerprint is compared, or the comparison runs with no fingerprint; (2) prints the
    //     two facts each time.
    expect({
      notAsked: counts(await check(home)),
      underA: counts(await check(home, { masterFp: FP_A })),
      underB: counts(await check(home, { masterFp: FP_B })),
      neither: counts(await check(home, { masterFp: 'ffffffff' })),
      status: (await check(home, { masterFp: FP_A })).status,
    }).toEqual({
      notAsked: { keys: 4, other: 'absent' },
      underA: { keys: 4, other: 1 },
      underB: { keys: 4, other: 3 },
      neither: { keys: 4, other: 4 },
      status: 'ok',
    });
  });

  it('the limit: a key damaged under the given fingerprint is not told apart from a good one', async () => {
    const home = await seeded();
    const c = await openForeignConnection(home);
    try {
      c.prepare(
        "UPDATE callback_keys SET sealed = x'00' WHERE workflow_id = 'wf-a' AND host = 'two.example:443'",
      ).run();
    } finally {
      c.close();
    }
    const a = await openRealmHome({ home, sealer: createCallbackKeySealer(MASTER_A) });
    const damaged = (await a.runStore.keys.read('wf-a', 'two.example:443')).current?.state;
    a.close();
    // (1) red when the check is changed to unseal (it has no sealer) or the damaged row leaves the
    //     count; (2) prints the damaged slot's state and the two facts.
    expect({ damaged, facts: counts(await check(home, { masterFp: FP_A })) }).toEqual({
      damaged: 'unreadable',
      facts: { keys: 4, other: 1 },
    });
  });

  it('a store at an older version: the data pass does not run, and neither count is a fact', async () => {
    const home = homeDir();
    const h = await openHome({ home }, { schemaVersion: 2 });
    h.close();
    const r = await check(home, { masterFp: FP_A });
    // (1) red when the count is taken outside the data pass (a version-2 file has no callback_keys:
    //     "no such table"); (2) prints the finding codes and the two facts.
    expect({ codes: r.findings.map((f) => f.code), facts: counts(r) }).toEqual({
      codes: ['older_version'],
      facts: { keys: 'absent', other: 'absent' },
    });
  });
});
