// failed-attempt-store.contract.test.ts — issue #616 PR-1b B7, check 5a: the per-run artifact contract
// (`@sensigo/realm-testing`, issues #183, #189, #620) run against the SQLite failed-attempt store, every
// law the contract exports, the release-line law included. Purge (2c) reads the store's typed rejection.
//
// The store is reached through the home's handle. Its failure injection is the driver seam
// (`test-support/commit-faults.ts`) failing the store's DELETE with `SQLITE_IOERR`, in the exact shape
// the built-in SQLite throws: the artifact is there and the delete cannot remove it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Clock } from '@sensigo/realm';
import {
  ARTIFACT_STORE_LAWS,
  perRunArtifactStoreContract,
  type ArtifactStoreLaw,
  type PerRunArtifactStoreContractAdapter,
} from '@sensigo/realm-testing';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './driver.js';
import { openHome } from './open-realm-home.js';
import { faultyFiles, SQLITE } from './test-support/commit-faults.js';

const clock: Clock = { now: () => new Date('2026-11-07T09:00:00.000Z'), at: () => () => undefined };

/**
 * The laws of this contract that THIS file deliberately does not run, each with its reason (issue
 * #625). Empty: the store owns one per-run artifact (a run's rows), so every law applies.
 */
const NOT_RUN: Partial<Record<ArtifactStoreLaw, string>> = {};

/** The laws this file runs: every exported law, minus the ones named in NOT_RUN above. */
const LAWS: readonly ArtifactStoreLaw[] = ARTIFACT_STORE_LAWS.filter((law) => !(law in NOT_RUN));

/**
 * A fresh home and adapter per law: a delete removes the seeded rows, and an armed fault stays on the
 * connection. The seed is one line, representative: the store owns one artifact class.
 */
async function makeAdapter(): Promise<{
  adapter: PerRunArtifactStoreContractAdapter;
  cleanup: () => void;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-b7-tck-'));
  const files = faultyFiles((path) => openDatabase(path));
  const home = await openHome({ home: join(dir, '.realm'), clock }, { openFile: files.openFile });
  const store = home.failedAttemptStore;
  const runId = randomUUID();
  const seed = async (): Promise<void> => {
    await store.append(runId, JSON.stringify({ ts: 0, seed: 'tck' }));
  };
  await seed();
  const adapter: PerRunArtifactStoreContractAdapter = {
    store,
    runIdWithArtifact: runId,
    runIdAbsent: randomUUID(),
    reseed: seed,
    injectFailure: () => {
      files.opened[files.opened.length - 1]!.arm({
        at: (sql) => sql.startsWith('DELETE FROM failed_attempts'),
        times: Infinity,
        first: 'nothing',
        error: SQLITE.ioError,
      });
    },
  };
  return {
    adapter,
    cleanup: () => {
      home.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('SqliteFailedAttemptStore — PerRunArtifactStore TCK conformance (#616 B7, check 5a)', () => {
  for (const law of LAWS) {
    it(law, async () => {
      const { adapter, cleanup } = await makeAdapter();
      try {
        const target = perRunArtifactStoreContract(adapter).find((c) => c.law === law);
        // (1) red when the contract registers no case for an exported law; (2) prints the law.
        expect(target, `no case registered for law ${law}`).toBeDefined();
        // The case throws its own message naming the law's broken promise (the named break for L4
        // and STORE_RELEASE_LINE_TRUE: throw the mapped error unwrapped).
        await target!.run();
      } finally {
        cleanup();
      }
    });
  }
});

describe('SqliteFailedAttemptStore artifact wiring — the run list is derived from the contract', () => {
  it('every exported law is either run or named in NOT_RUN, and NOT_RUN names only exported laws (issue #625)', () => {
    const exported: readonly string[] = ARTIFACT_STORE_LAWS;
    const named = Object.keys(NOT_RUN);
    // (1) red when a law is dropped from the run list without being named in NOT_RUN, or NOT_RUN
    //     names a law the contract no longer exports; (2) prints the unaccounted or unknown laws.
    expect(named.filter((name) => !exported.includes(name))).toEqual([]);
    expect([...LAWS, ...named].sort()).toEqual([...exported].sort());
    for (const reason of Object.values(NOT_RUN)) expect(reason).not.toBe('');
  });
});
