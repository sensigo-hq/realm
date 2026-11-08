// contract-fidelity-616.test.ts — issue #616 PR-1a unit 16b: the published run-store fidelity contract
// (`runStoreFidelityContract`, @sensigo/realm-testing) run against `SqliteRunStore`, every law. The
// real case: a third party who runs the contract first and finds out whether its store keeps what the
// engine writes; Realm's own store is held to the same laws, on a real home.
//
// One fresh home per law. The home runs on the SYSTEM clock: `CLAIM_NAMES_HOLDER` brackets a claim's
// `since` with `Date.now()`, so an injected clock would fail it for the wrong reason.
import type { WorkflowDefinition } from '@sensigo/realm';
import {
  RUN_STORE_FIDELITY_LAWS,
  runStoreFidelityContract,
  type RunStoreFidelityLaw,
} from '@sensigo/realm-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ContractHomes } from './test-support/contract-homes.js';

/** The laws this file does not run, each with its reason. None: the store keeps every field it lists. */
const NOT_RUN: Partial<Record<RunStoreFidelityLaw, string>> = {};

/** Every exported law but those named above: a law added to the contract runs here untouched. */
const LAWS: readonly RunStoreFidelityLaw[] = RUN_STORE_FIDELITY_LAWS.filter(
  (law) => !(law in NOT_RUN),
);

/** One agent step, the shape the contract's claim and evidence laws drive. */
const AGENT_WORKFLOW: WorkflowDefinition = {
  id: 'a',
  name: 'Agent',
  version: 1,
  steps: { work: { description: 'w', execution: 'agent', depends_on: [] } },
};

const homes = new ContractHomes();
afterEach(() => homes.dispose());

describe('#616 unit 16b — SqliteRunStore runs the run-store fidelity contract', () => {
  for (const law of LAWS) {
    it(`conforms to ${law}`, async () => {
      const { store } = await homes.open();
      const cases = runStoreFidelityContract({
        store,
        definition: AGENT_WORKFLOW,
        stepName: 'work',
      }).filter((c) => c.law === law);
      // (1) red when the contract stops registering a case for a law this file runs, or when the
      //     store declares no field a law reads (it would then run zero cases and pass); (2) prints
      //     the law.
      expect(cases.length, `no case registered for law ${law}`).toBeGreaterThan(0);
      // (1) red when the store breaks the law (each law's own break: see the contract; the
      //     shipped red-first records name one per law); (2) prints the contract's own sentence for
      //     the law that failed.
      for (const c of cases) await c.run();
    });
  }
});
