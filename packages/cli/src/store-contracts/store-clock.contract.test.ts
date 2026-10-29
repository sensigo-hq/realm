// The store-clock contract family (issue #715 (a), D6-36) on JsonFileStore, through the LOCATION route:
// each case opens a fresh store on a test location (`createTestLocation`), whose clock is the
// location's file. Lives here for the reason `json-file-store.contract.test.ts` gives: the CLI is
// the package that depends on both @sensigo/realm and @sensigo/realm-testing.
import { describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonFileStore, type RunRecord } from '@sensigo/realm';
import { STORE_CLOCK_LAWS, storeClockContract, type StoreClockLaw } from '@sensigo/realm-testing';

/**
 * The laws of this family that THIS file deliberately does not run, each with its reason.
 */
const NOT_RUN: Partial<Record<StoreClockLaw, string>> = {
  READS_SPEND_NO_READING:
    'a location store’s clock is internal (resolved from the clock file at construction), so its readings cannot be counted from outside; core’s json-file-store-clock-715.test.ts counts them (cell B1, J11–J15)',
};

/** Every exported law, minus the ones named in NOT_RUN above. */
const LAWS: readonly StoreClockLaw[] = STORE_CLOCK_LAWS.filter((law) => !(law in NOT_RUN));

describe('#715 (a) C16 — the store-clock contract on JsonFileStore (location route)', () => {
  // Correction 1 (C-4): the store's sanctioned channel past its boundary — a direct file write, as
  // `settlement-json-file-store.test.ts` does. The location route does not run
  // READS_SPEND_NO_READING (NOT_RUN above), so the family never calls it here today; it is the
  // adapter's whole description of the store, for a route that will.
  let built: { store: JsonFileStore; runsDir: string } | undefined;
  const cases = storeClockContract({
    storeName: 'JsonFileStore',
    route: {
      kind: 'location',
      makeStore: ({ location }) => {
        built = { store: new JsonFileStore(location.runsDir), runsDir: location.runsDir };
        return built.store;
      },
    },
    seedLegacyTerminal: async (id) => {
      const { run } = await built!.store.create({
        workflowId: `seed-${id}`,
        workflowVersion: 1,
        params: {},
      });
      const legacy: RunRecord = {
        ...run,
        id,
        completed_steps: ['a'],
        terminal_state: true,
        terminal_reason: 'Workflow completed.',
        run_phase: 'completed',
      };
      await writeFile(join(built!.runsDir, `${id}.json`), JSON.stringify(legacy, null, 2));
      return legacy;
    },
  });
  for (const law of LAWS) {
    it(law, async () => {
      const target = cases.find((c) => c.law === law);
      expect(target, `no case registered for law ${law}`).toBeDefined();
      await target!.run();
    });
  }
});
