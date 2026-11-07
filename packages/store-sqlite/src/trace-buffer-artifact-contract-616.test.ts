// trace-buffer-artifact-contract-616.test.ts — issue #616 PR-1b B4 (SEAMS S9): the published per-run
// artifact contract run against the SQLite trace buffer, every law, the release-line law included.
// The real case: purge (PR-2c) deletes a run's trace lines through `deleteAllForRun` and must be told,
// in the contract's typed shape, when it could not. The failure injection is the store's own delete
// statement failing with SQLite's I/O error, through unit 9's fault wrapper (a driver-seam fault, not
// a real disk failure).
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '@sensigo/realm';
import {
  ARTIFACT_STORE_LAWS,
  perRunArtifactStoreContract,
  type ArtifactStoreLaw,
  type PerRunArtifactStoreContractAdapter,
} from '@sensigo/realm-testing';
import { describe, expect, it } from 'vitest';
import { RealmDb } from './connection.js';
import { openDatabase } from './driver.js';
import { faultyFiles, SQLITE } from './test-support/commit-faults.js';
import { SqliteTraceBufferStore } from './trace-buffer-store.js';

const clock: Clock = { now: () => new Date('2026-11-07T09:00:00.000Z'), at: () => () => undefined };

/** The laws this file does not run, each with its reason. Empty: the store owns per-run artifacts. */
const NOT_RUN: Partial<Record<ArtifactStoreLaw, string>> = {};

/** Every exported law but those named above: a law added to the contract runs here untouched. */
const LAWS: readonly ArtifactStoreLaw[] = ARTIFACT_STORE_LAWS.filter((law) => !(law in NOT_RUN));

/**
 * A fresh home and store per law (the laws delete). The seed holds both artifact classes: a sealed
 * artifact and a live line, so a stat that counted only one could not pass L6.
 */
async function makeAdapter(): Promise<{
  adapter: PerRunArtifactStoreContractAdapter;
  cleanup: () => void;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-b4-tck-'));
  const files = faultyFiles(openDatabase);
  const db = await RealmDb.open(join(dir, '.realm'), { clock }, { openFile: files.openFile });
  const store = new SqliteTraceBufferStore(db);
  const runId = randomUUID();
  const seed = async (): Promise<void> => {
    await store.append(runId, 'tck-sealed-step', [{ event: 'tck-to-be-sealed' }]);
    const sealed = await store.sealFenced(runId, 'tck-sealed-step', { kind: 'run_absent' });
    if (!sealed.sealed) {
      throw new Error(`the fixture has no sealed artifact: ${JSON.stringify(sealed)}`);
    }
    await store.append(runId, 'tck-step', [{ event: 'tck-seed' }]);
  };
  await seed();
  const adapter: PerRunArtifactStoreContractAdapter = {
    store,
    runIdWithArtifact: runId,
    runIdAbsent: randomUUID(),
    reseed: seed,
    injectFailure: () => {
      // The run-wide delete of the live lines fails with SQLite's I/O error and does not run.
      files.opened.at(-1)?.arm({
        at: (sql) => sql.startsWith('DELETE FROM trace_buffer WHERE run_id = ?'),
        times: 1,
        first: 'nothing',
        error: SQLITE.ioError,
      });
    },
  };
  return {
    adapter,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('#616 B4 — SqliteTraceBufferStore runs the per-run artifact contract', () => {
  for (const law of LAWS) {
    it(law, async () => {
      const { adapter, cleanup } = await makeAdapter();
      try {
        const target = perRunArtifactStoreContract(adapter).find((c) => c.law === law);
        // (1) red when the contract stops registering a law this file runs; (2) prints the law.
        expect(target, `no case registered for law ${law}`).toBeDefined();
        // (1) red when the store breaks the law (each law's own break: see the contract); (2) prints
        //     the contract's own sentence for the law that failed.
        await target!.run();
      } finally {
        cleanup();
      }
    });
  }
});
