// contract-leased-claim-cw2a.test.ts — issue #729, the claim window, unit CW-2a: the published
// leased-claim contract (`leasedClaimContract`, @sensigo/realm-testing) run against the SQLite store with
// its real lease port, every law. The store under test is this process's, built as `openRealmHome`
// builds it, with the home's lease port behind a wrapper that keeps every hold a case makes, so the
// adapter closes each before it deletes the home.
//
// This file runs on CI's macOS job too (it runs every store-sqlite test file).
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemClock, type LeaseHold, type LeasePort } from '@sensigo/realm';
import {
  LEASED_CLAIM_LAWS,
  leasedClaimContract,
  type LeasedClaimContractAdapter,
  type LeasedClaimLaw,
} from '@sensigo/realm-testing';
import { describe, expect, it } from 'vitest';
import { createLeasePort } from './claim-lease.js';
import { RealmDb } from './connection.js';
import { SqliteRunStore } from './run-store.js';

/** The laws this file does not run, each with its reason. None: every law runs on the real port. */
const NOT_RUN: Partial<Record<LeasedClaimLaw, string>> = {};

/** Every exported law but those named above: a law added to the contract runs here untouched. */
const LAWS: readonly LeasedClaimLaw[] = LEASED_CLAIM_LAWS.filter((law) => !(law in NOT_RUN));

const ADAPTER: LeasedClaimContractAdapter = {
  storeName: 'SqliteRunStore with its claim leases',
  makeStore: async () => {
    const root = mkdtempSync(join(tmpdir(), 'realm-cw2a-claim-'));
    const home = join(root, 'home');
    const db = await RealmDb.open(home, { clock: systemClock });
    const real = createLeasePort(home);
    const holds: LeaseHold[] = [];
    const leases: LeasePort = {
      hold: async () => {
        const made = await real.hold();
        if ('held' in made) holds.push(made.held);
        return made;
      },
      probe: (id) => real.probe(id),
    };
    return {
      store: new SqliteRunStore(db, leases),
      dispose: async () => {
        for (const hold of holds) hold.close();
        db.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  },
};

describe('#729 CW-2a — the SQLite store runs the leased-claim contract (its real leases)', () => {
  it('runs every law: NOT_RUN is empty', () => {
    // (1) red when a law is put in NOT_RUN (it then never runs on the real port, here or on the
    //     macOS job); (2) prints the laws named there, with their reasons.
    expect(NOT_RUN).toEqual({});
  });

  const cases = leasedClaimContract(ADAPTER);
  for (const law of LAWS) {
    it(`conforms to ${law}`, { timeout: 60_000 }, async () => {
      const target = cases.find((c) => c.law === law);
      // (1) red when the contract stops registering a case for a law this file runs; (2) prints the
      //     law. The case itself throws, naming the law and what the store did, when it fails.
      expect(target, `no case for ${law}`).toBeDefined();
      await target!.run();
    });
  }
});
