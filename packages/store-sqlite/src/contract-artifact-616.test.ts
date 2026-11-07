// contract-artifact-616.test.ts — issue #616 PR-1a unit 16c: the published per-run artifact contract
// (`perRunArtifactStoreContract`, @sensigo/realm-testing) run against `SqliteRunStore`, every law,
// the release-line law included. The real case: purge (PR-2c) deletes a finished run through the run
// store's `deleteAllForRun`, as the last store, and must be told, in the contract's typed shape,
// when it could not; its dry run shows `statAllForRun`'s figure and the delete must report the same.
//
// A fresh home and store per law (the laws delete). The seed is a finished run with BOTH classes of
// row a run keeps: two evidence entries and a write-once value (the context files), so a stat that
// counted only one class could not pass `L6_PREVIEW_EQUALS_RECEIPT`. The failure is the store's own
// COMMIT failing with SQLite's I/O error and rolling back, through unit 9's fault wrapper (a
// driver-seam fault, not a real disk failure); the delete is one transaction, so the run stays.
import { randomUUID } from 'node:crypto';
import type { EvidenceSnapshot, RunRecord, WorkflowContextSnapshot } from '@sensigo/realm';
import {
  ARTIFACT_STORE_LAWS,
  perRunArtifactStoreContract,
  type ArtifactStoreLaw,
  type PerRunArtifactStoreContractAdapter,
} from '@sensigo/realm-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ContractHomes, type ContractHome } from './test-support/contract-homes.js';
import { SQLITE } from './test-support/commit-faults.js';

/** The laws this file does not run, each with its reason. None: the store owns per-run artifacts. */
const NOT_RUN: Partial<Record<ArtifactStoreLaw, string>> = {};

/** Every exported law but those named above: a law added to the contract runs here untouched. */
const LAWS: readonly ArtifactStoreLaw[] = ARTIFACT_STORE_LAWS.filter((law) => !(law in NOT_RUN));

const homes = new ContractHomes();
afterEach(() => homes.dispose());

/** One evidence entry of step `a`, as the engine writes it. */
function entry(i: number, answer: string): EvidenceSnapshot {
  return {
    step_id: 'a',
    started_at: '2030-05-06T07:00:00.000Z',
    completed_at: '2030-05-06T07:00:01.000Z',
    duration_ms: 1000,
    input_summary: { i },
    output_summary: { answer },
    status: 'success',
    evidence_hash: `${i}`.padStart(64, '0'),
  };
}

/** The workflow's context files as the engine snapshots them (a write-once field). */
function contextFiles(content: string): Record<string, WorkflowContextSnapshot> {
  return {
    'guide.md': {
      source_path: '/work/guide.md',
      content,
      content_hash: 'cd'.repeat(32),
      loaded_at: '2030-05-06T07:00:00.000Z',
    },
  };
}

/**
 * A finished run as the engine leaves one, made through the store's own verbs: two evidence entries
 * (rows of the evidence table) and its context files (a write-once field: a row of the blob table),
 * sealed by the `complete` arm. The wiring seeds it, so a stat that counted only one of the classes
 * of row a run keeps could not pass `L6_PREVIEW_EQUALS_RECEIPT`. (It lives in this file, not in the
 * shared support: a terminal write in a non-test file is a writer the terminal-writer census
 * counts.)
 */
async function makeFinishedRun(into: ContractHome): Promise<RunRecord> {
  const { record } = await into.store.create({
    workflowId: 'wf-contract-616',
    workflowVersion: 1,
    params: {},
  });
  const sealed = await into.store.update({
    ...record,
    evidence: [entry(0, 'the first answer'), entry(1, 'the second answer')],
    workflow_context_snapshots: contextFiles('The guide.'),
    terminal_state: true,
    sealed_by: { arm: 'complete' },
    terminal_reason: 'Workflow completed.',
  });
  return sealed.record;
}

/** The adapter of one law: a fresh home holding one finished run, and the hooks the contract calls. */
async function makeAdapter(): Promise<PerRunArtifactStoreContractAdapter> {
  const home = await homes.open({ faulty: true });
  const run = await makeFinishedRun(home);
  return {
    store: home.store,
    runIdWithArtifact: run.id,
    runIdAbsent: randomUUID(),
    // Each law gets a fresh home with the run present, so there is nothing to seed again; a law
    // that calls this after the run is gone would measure an empty store, so it says so.
    reseed: async () => {
      if ((await home.store.statAllForRun(run.id)).bytes === 0) {
        throw new Error(
          `reseed: run ${run.id} is gone from this home; this wiring opens a fresh home for each law`,
        );
      }
    },
    injectFailure: () => {
      // The delete's COMMIT fails with SQLite's I/O error and SQLite rolls the transaction back.
      home.files!.opened.at(-1)!.arm({
        at: (sql) => sql === 'COMMIT',
        times: 1,
        first: 'rollback',
        error: SQLITE.ioError,
      });
    },
  };
}

describe('#616 unit 16c — SqliteRunStore runs the per-run artifact contract', () => {
  for (const law of LAWS) {
    it(`conforms to ${law}`, async () => {
      const cases = perRunArtifactStoreContract(await makeAdapter()).filter((c) => c.law === law);
      // (1) red when the contract stops registering a law this file runs; (2) prints the law.
      expect(cases.length, `no case registered for law ${law}`).toBe(1);
      // (1) red when the store breaks the law (a delete that reports success for a run it could
      //     not delete; a stat that counts one class of row; a failure that is not typed); (2)
      //     prints the contract's own sentence for the law that failed.
      await cases[0]!.run();
    });
  }
});
