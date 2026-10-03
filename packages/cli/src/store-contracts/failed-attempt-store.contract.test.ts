// PerRunArtifactStore TCK conformance for FailedAttemptStore (issue #183).
//
// See json-file-store.contract.test.ts (this directory) for why this lives in @sensigo/realm-cli
// rather than @sensigo/realm's own test suite: @sensigo/realm-testing depends on @sensigo/realm,
// so the reverse devDependency would be a genuine circular package dependency.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FailedAttemptStore } from '@sensigo/realm';
import {
  perRunArtifactStoreContract,
  ARTIFACT_STORE_LAWS,
  type ArtifactStoreLaw,
  type PerRunArtifactStoreContractAdapter,
} from '@sensigo/realm-testing';

/**
 * The laws of this contract that THIS file deliberately does not run, each with its reason
 * (issue #625). Empty: FailedAttemptStore owns per-run artifacts, so every law of this contract applies.
 */
const NOT_RUN: Partial<Record<ArtifactStoreLaw, string>> = {};

/** The laws this file runs: every exported law, minus the ones named in NOT_RUN above. A law added
 *  to the contract therefore runs here without this file being touched. */
const LAWS: readonly ArtifactStoreLaw[] = ARTIFACT_STORE_LAWS.filter((law) => !(law in NOT_RUN));

/** Fresh adapter per law — see json-file-store.contract.test.ts for why. injectFailure replaces
 *  the `.attempts.jsonl` sidecar with a DIRECTORY (works on every platform and any uid). */
async function makeAdapter(): Promise<{
  adapter: PerRunArtifactStoreContractAdapter;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'failed-attempt-store-tck-'));
  const store = new FailedAttemptStore(dir);
  const runId = randomUUID();
  // This store owns exactly ONE artifact class (the sidecar), so a single seeded line is a
  // representative fixture here — unlike the two-artifact stores, whose adapters need more.
  const seed = async (): Promise<void> => {
    await store.append(runId, JSON.stringify({ ts: 0, seed: 'tck' }));
  };
  await seed();

  const adapter: PerRunArtifactStoreContractAdapter = {
    store,
    runIdWithArtifact: runId,
    runIdAbsent: randomUUID(),
    reseed: seed,
    injectFailure: async (id: string) => {
      const path = join(dir, `${id}.attempts.jsonl`);
      await rm(path, { recursive: true, force: true });
      await mkdir(path);
    },
  };

  return { adapter, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe('FailedAttemptStore — PerRunArtifactStore TCK conformance (issue #183)', () => {
  for (const law of LAWS) {
    it(law, async () => {
      const { adapter, cleanup } = await makeAdapter();
      try {
        const cases = perRunArtifactStoreContract(adapter);
        const target = cases.find((c) => c.law === law);
        expect(target, `no case registered for law ${law}`).toBeDefined();
        await target!.run();
      } finally {
        await cleanup();
      }
    });
  }
});

describe('FailedAttemptStore artifact wiring — the run list is derived from the contract', () => {
  // (a) red when a law is dropped from the run list WITHOUT being named in NOT_RUN, or NOT_RUN
  //     names a law the contract no longer exports; (b) prints the unaccounted / unknown laws.
  it('every exported law is either run or named in NOT_RUN, and NOT_RUN names only exported laws (issue #625)', () => {
    const exported: readonly string[] = ARTIFACT_STORE_LAWS;
    const named = Object.keys(NOT_RUN);
    expect(named.filter((law) => !exported.includes(law))).toEqual([]);
    expect([...LAWS, ...named].sort()).toEqual([...exported].sort());
    for (const reason of Object.values(NOT_RUN)) expect(reason).not.toBe('');
  });
});
