// RunStore field-fidelity + claimStep single-owner TCK conformance for JsonFileStore (issue #188,
// PR-2).
//
// Lives in @sensigo/realm-cli, NOT in @sensigo/realm's own packages/core test suite, for the SAME
// reason json-file-store.contract.test.ts (issue #183) does: @sensigo/realm-testing depends on
// @sensigo/realm, so a devDependency the other way round (packages/core → @sensigo/realm-testing)
// would be a genuine circular PACKAGE dependency. @sensigo/realm-cli already depends on both (no
// new dependency needed).
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import {
  runStoreFidelityContract,
  RUN_STORE_FIDELITY_LAWS,
  type RunStoreFidelityLaw,
} from '@sensigo/realm-testing';

/**
 * The laws of this contract that THIS file deliberately does not run, each with its reason
 * (issue #625). Empty: JsonFileStore keeps claims, so every law of this contract applies to it.
 */
const NOT_RUN: Partial<Record<RunStoreFidelityLaw, string>> = {};

/** The laws this file runs: every exported law, minus the ones named in NOT_RUN above. A law added
 *  to the contract therefore runs here without this file being touched. */
const LAWS: readonly RunStoreFidelityLaw[] = RUN_STORE_FIDELITY_LAWS.filter(
  (law) => !(law in NOT_RUN),
);

const agentWf: WorkflowDefinition = {
  id: 'run-store-fidelity-tck-wf',
  name: 'RunStore Fidelity TCK WF',
  version: 1,
  steps: {
    work: { description: 'Agent step, immediately eligible', execution: 'agent', depends_on: [] },
  },
};

describe('JsonFileStore — RunStore fidelity TCK conformance (issue #188)', () => {
  it('declares the full LoadBearingRunRecordField set (byte-identical local behavior depends on this)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'json-file-store-fidelity-tck-'));
    try {
      const store = new JsonFileStore(dir);
      expect(store.persistedRunRecordFields?.has('capability_blocks')).toBe(true);
      expect(store.persistedRunRecordFields?.has('workflow_context_snapshots')).toBe(true);
      expect(store.persistedRunRecordFields?.has('extension_identity')).toBe(true);
      expect(store.persistedRunRecordFields?.has('validation_rejections')).toBe(true);
      expect(store.persistedRunRecordFields?.has('defaulted_steps')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  for (const law of LAWS) {
    it(`conforms to ${law}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'json-file-store-fidelity-tck-'));
      try {
        const store = new JsonFileStore(dir);
        const cases = runStoreFidelityContract({ store, definition: agentWf, stepName: 'work' });
        const matching = cases.filter((c) => c.law === law);
        expect(matching.length).toBeGreaterThan(0);
        for (const c of matching) {
          await c.run();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('RunStore fidelity wiring — the run list is derived from the contract', () => {
  // (a) red when a law is dropped from the run list WITHOUT being named in NOT_RUN, or NOT_RUN
  //     names a law the contract no longer exports; (b) prints the unaccounted / unknown laws.
  it('every exported law is either run or named in NOT_RUN, and NOT_RUN names only exported laws (issue #625)', () => {
    const exported: readonly string[] = RUN_STORE_FIDELITY_LAWS;
    const named = Object.keys(NOT_RUN);
    expect(named.filter((law) => !exported.includes(law))).toEqual([]);
    expect([...LAWS, ...named].sort()).toEqual([...exported].sort());
    for (const reason of Object.values(NOT_RUN)) expect(reason).not.toBe('');
  });
});
