// contract-take-back-cw3b.test.ts — issue #729, the claim window, unit CW-3b: the published take-back
// contract (`takeBackContract`, @sensigo/realm-testing) run against the SQLite store, every law. The
// store is built as `openRealmHome` builds it, but with the lease double as its lease port, so each law
// sets its claims' lease states; the kernel lease itself is `take-back-e2e-cw3.test.ts`'s.
//
// This file runs on CI's macOS job too (it runs every store-sqlite test file).
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemClock } from '@sensigo/realm';
import {
  TAKE_BACK_LAWS,
  createLeaseDouble,
  takeBackContract,
  type TakeBackContractAdapter,
  type TakeBackLaw,
} from '@sensigo/realm-testing';
import { describe, expect, it } from 'vitest';
import { RealmDb } from './connection.js';
import { SqliteRunStore } from './run-store.js';

/** The laws this file does not run, each with its reason. None: every law runs. */
const NOT_RUN: Partial<Record<TakeBackLaw, string>> = {};

/** Every exported law but those named above: a law added to the contract runs here untouched. */
const LAWS: readonly TakeBackLaw[] = TAKE_BACK_LAWS.filter((law) => !(law in NOT_RUN));

const ADAPTER: TakeBackContractAdapter = {
  storeName: 'SqliteRunStore with the lease double',
  makeStore: async () => {
    const root = mkdtempSync(join(tmpdir(), 'realm-cw3b-take-back-'));
    const db = await RealmDb.open(join(root, 'home'), { clock: systemClock });
    const leases = createLeaseDouble();
    return {
      store: new SqliteRunStore(db, leases),
      leases,
      dispose: async () => {
        db.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  },
};

describe('#729 CW-3b — the SQLite store runs the take-back contract (the lease double)', () => {
  it('runs every law: NOT_RUN is empty', () => {
    // (1) red when a law is put in NOT_RUN (it then never runs on this store, here or on the macOS
    //     job); (2) prints the laws named there, with their reasons.
    expect(NOT_RUN).toEqual({});
  });

  const cases = takeBackContract(ADAPTER);
  for (const law of LAWS) {
    it(`conforms to ${law}`, { timeout: 60_000 }, async () => {
      const target = cases.find((c) => c.law === law);
      // (1) red when the contract stops registering a case for a law this file runs; (2) prints the
      //     law. The case itself throws, naming the law and what the take-back did, when it fails.
      expect(target, `no case for ${law}`).toBeDefined();
      await target!.run();
    });
  }
});
