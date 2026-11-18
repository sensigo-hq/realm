// callback-store.contract.test.ts — callback B1a and B1b (R1.3): the SQLite callback store
// (`SqliteCallbackStore`, a home's `runStore.callbacks`, with B1a's `SqliteCallbackKeys` as its
// `keys`) held to the published laws on a real file.
//   - The callback-store family (`callbackStoreContract`, `@sensigo/realm-testing`), every law it
//     exports through the real home's run store, each case on a fresh home opened with a test
//     sealer. B1a ran the key laws through a façade; callback B1b replaces it with the real home.
//     The family's `seedRun` writes a run AS GIVEN on a foreign connection (B1a's planter);
//     `removeRun` deletes a finished run on a foreign connection and leaves its callback row (no
//     foreign key holds it; `runs_delete_finished` lets a finished run go), for `CB_DUE_RUN_GONE`;
//     `makeUnreadable` is B1a's.
//   - The per-run artifact contract (`perRunArtifactStoreContract`) on `runStore.callbacks`, every
//     law: the failure is the driver seam failing the table's DELETE with SQLite's I/O error, as
//     `outbound-ledger.contract.test.ts` does.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it:
// (1) what turns it red, (2) what it prints then.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunStore } from '@sensigo/realm';
import {
  ARTIFACT_STORE_LAWS,
  CALLBACK_STORE_LAWS,
  callbackStoreContract,
  perRunArtifactStoreContract,
  type ArtifactStoreLaw,
  type CallbackStoreContractAdapter,
  type CallbackStoreLaw,
  type PerRunArtifactStoreContractAdapter,
} from '@sensigo/realm-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './driver.js';
import { openHome, type RealmHome } from './open-realm-home.js';
import { makeUnreadable, plantRun, testSealer } from './test-support/callbacks.js';
import { faultyFiles, SQLITE } from './test-support/commit-faults.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

/** The per-run artifact laws this file does not run. Empty: a run's callback row is its artifact. */
const NOT_RUN: Partial<Record<ArtifactStoreLaw, string>> = {};

/** The artifact laws this file runs: every exported law, minus the ones named above. */
const LAWS: readonly ArtifactStoreLaw[] = ARTIFACT_STORE_LAWS.filter((law) => !(law in NOT_RUN));

/** The callback laws this file does not run, each with its reason. */
const CALLBACK_NOT_RUN: Partial<Record<CallbackStoreLaw, string>> = {
  CB_NO_PORT_REFUSES:
    'the SQLite store always keeps the callback port: it has no store without one',
};

/** Every exported callback law but those named above: a law added to the family runs here untouched. */
const CALLBACK_LAWS: readonly CallbackStoreLaw[] = CALLBACK_STORE_LAWS.filter(
  (law) => !(law in CALLBACK_NOT_RUN),
);

/** The home of each store a case built, for `removeRun` and `makeUnreadable`. */
const homes = new WeakMap<RunStore, string>();

function homeOf(store: RunStore): string {
  const home = homes.get(store);
  if (home === undefined) throw new Error('a store this adapter did not build');
  return home;
}

/** Deletes a finished run on a foreign connection: its callback row stays (no foreign key). */
async function removeRun(home: string, runId: string): Promise<void> {
  const c = await openForeignConnection(home);
  try {
    const { changes } = c.prepare('DELETE FROM runs WHERE id = ?').run(runId);
    if (Number(changes) !== 1) throw new Error(`removeRun: no run ${runId} was deleted`);
  } finally {
    c.close();
  }
}

const CALLBACK_ADAPTER: CallbackStoreContractAdapter = {
  storeName: 'SqliteRunStore',
  makeStore: async ({ clock }) => {
    const dir = mkdtempSync(join(tmpdir(), 'realm-b1b-callbacks-'));
    const home = join(dir, '.realm');
    const handle = await openHome({ home, clock, sealer: testSealer() }, {});
    homes.set(handle.runStore, home);
    return {
      store: handle.runStore,
      seedRun: (record) => plantRun(home, record),
      dispose: async () => {
        handle.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
  removeRun: (store, runId) => removeRun(homeOf(store), runId),
  makeUnreadable: (store, workflowId, host, slot, masterFp) =>
    makeUnreadable(homeOf(store), workflowId, host, slot, masterFp),
};

describe('callback B1b — the SQLite store runs the callback-store contract', () => {
  const cases = callbackStoreContract(CALLBACK_ADAPTER);
  it('the contract has one case per exported law, in order', () => {
    // (1) red when a law is exported without a case, or a case is registered under another law;
    //     (2) prints both lists.
    expect(cases.map((c) => c.law)).toEqual([...CALLBACK_STORE_LAWS]);
  });
  for (const law of CALLBACK_LAWS) {
    it(`conforms to ${law}`, async () => {
      const target = cases.find((c) => c.law === law);
      // (1) red when the contract stops registering a case for a law this file runs; (2) prints the
      //     law. The case itself throws, naming the law, the step and what the store returned.
      expect(target, `no case for ${law}`).toBeDefined();
      await target!.run();
    });
  }
});

// ---- the per-run artifact contract on `runStore.callbacks` ----

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const AT = '2026-11-18T09:00:00.000Z';
const URL = 'https://hooks.example/callback/1';
const BODY = '{"run":"done"}';

/** Writes (or rewrites) run `runId`'s pending callback row on a foreign connection. */
async function plantRow(home: string, runId: string): Promise<void> {
  const c = await openForeignConnection(home);
  try {
    c.prepare(
      'INSERT OR REPLACE INTO callbacks (run_id, workflow_id, host, webhook_id, status, attempts, ' +
        "created_at, next_attempt_at, url, body) VALUES (?, 'wf', 'hooks.example:443', ?, 'pending', 0, ?, ?, ?, ?)",
    ).run(runId, randomUUID(), AT, AT, URL, BODY);
  } finally {
    c.close();
  }
}

/** A fresh home and adapter per law: a delete removes the seeded row, and an armed fault stays. */
async function artifactAdapter(): Promise<PerRunArtifactStoreContractAdapter> {
  const dir = mkdtempSync(join(tmpdir(), 'realm-b1b-artifact-'));
  dirs.push(dir);
  const home = join(dir, '.realm');
  const files = faultyFiles((path) => openDatabase(path));
  const handle: RealmHome = await openHome(
    { home, clock: { now: () => new Date(AT), at: () => () => undefined } },
    { openFile: files.openFile },
  );
  closers.push(() => handle.close());
  const runId = randomUUID();
  const reseed = (): Promise<void> => plantRow(home, runId);
  await reseed();
  return {
    store: handle.runStore.callbacks,
    runIdWithArtifact: runId,
    runIdAbsent: randomUUID(),
    reseed,
    injectFailure: () => {
      files.opened.at(-1)!.arm({
        at: (sql) => sql.startsWith('DELETE FROM callbacks'),
        times: Infinity,
        first: 'nothing',
        error: SQLITE.ioError,
      });
    },
  };
}

describe('SqliteCallbackStore — PerRunArtifactStore TCK conformance (callback B1b)', () => {
  for (const law of LAWS) {
    it(law, async () => {
      const adapter = await artifactAdapter();
      const target = perRunArtifactStoreContract(adapter).find((c) => c.law === law);
      // (1) red when the contract registers no case for an exported law; (2) prints the law. The case
      //     throws its own message naming the law's broken promise.
      expect(target, `no case registered for law ${law}`).toBeDefined();
      await target!.run();
    });
  }
});

describe('SqliteCallbackStore wiring — the run lists are derived from the contracts', () => {
  it('every exported law of both families is run or named in a NOT_RUN, and each NOT_RUN names only exported laws', () => {
    for (const [exported, notRun, run] of [
      [ARTIFACT_STORE_LAWS, NOT_RUN, LAWS],
      [CALLBACK_STORE_LAWS, CALLBACK_NOT_RUN, CALLBACK_LAWS],
    ] as const) {
      const all: readonly string[] = exported;
      const named = Object.keys(notRun);
      // (1) red when a law is dropped from a run list without being named in its NOT_RUN, or a
      //     NOT_RUN names a law the contract no longer exports; (2) prints the unaccounted or unknown
      //     laws.
      expect(named.filter((name) => !all.includes(name))).toEqual([]);
      expect([...run, ...named].sort()).toEqual([...all].sort());
      for (const reason of Object.values(notRun)) expect(reason).not.toBe('');
    }
    // (1) red when a callback law other than the no-port one slips into CALLBACK_NOT_RUN; (2) prints
    //     the list.
    expect(Object.keys(CALLBACK_NOT_RUN)).toEqual(['CB_NO_PORT_REFUSES']);
  });
});
