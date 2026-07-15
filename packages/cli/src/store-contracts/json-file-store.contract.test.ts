// PerRunArtifactStore TCK conformance for JsonFileStore (issue #183).
//
// Lives in @sensigo/realm-cli, NOT in @sensigo/realm's own packages/core test suite, because
// @sensigo/realm-testing depends on @sensigo/realm — a devDependency the other way round would be
// a genuine circular PACKAGE dependency (verified empirically: adding
// `"@sensigo/realm-testing": "*"` to packages/core/package.json's devDependencies makes
// `turbo run build` fail with "Cyclic dependency detected: @sensigo/realm#build,
// @sensigo/realm-testing#build"). @sensigo/realm-cli already depends on BOTH @sensigo/realm and
// @sensigo/realm-testing (no new dependency needed) — and it's also where "does purge's safety
// story hold" is most at home, since purge.ts is the operator-facing caller whose correctness
// this whole contract exists for. store-fs-guard.test.ts's WIRED⇒TCK check looks for this file
// by content (imports JsonFileStore + calls perRunArtifactStoreContract), not by path.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonFileStore } from '@sensigo/realm';
import {
  perRunArtifactStoreContract,
  type PerRunArtifactStoreContractAdapter,
} from '@sensigo/realm-testing';

const LAWS = [
  'L1_ABSENCE_RESOLVES',
  'L2_IDEMPOTENT',
  'L3_FAILURE_REJECTS',
  'L4_TYPED_REJECTION',
] as const;

/**
 * Fresh adapter per law: deleteAllForRun is destructive (L2 deletes the seeded artifact) and
 * injectFailure mutates on-disk state — reusing one adapter/store instance across multiple laws
 * in sequence would leak state between them (see per-run-artifact-store-contract.ts's own usage
 * note). injectFailure replaces the run's JSON file with a DIRECTORY — works on every platform
 * and any uid (unlike chmod, which the TCK's own doc explicitly disqualifies).
 */
async function makeAdapter(): Promise<{
  adapter: PerRunArtifactStoreContractAdapter;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'json-file-store-tck-'));
  const store = new JsonFileStore(dir);
  const { run } = await store.create({ workflowId: 'wf-tck', workflowVersion: 1, params: {} });
  // issue #184: deleteAllForRun now re-verifies terminal state under its own lock and refuses a
  // non-terminal run (the resurrect-race fix) — a fresh store.create() run is 'running' by
  // default, so mark it terminal before the TCK exercises deleteAllForRun against it.
  await store.update({ ...run, run_phase: 'completed', terminal_state: true });

  const adapter: PerRunArtifactStoreContractAdapter = {
    store,
    runIdWithArtifact: run.id,
    runIdAbsent: randomUUID(),
    injectFailure: async (runId: string) => {
      const path = join(dir, `${runId}.json`);
      await rm(path, { recursive: true, force: true });
      await mkdir(path);
    },
  };

  return { adapter, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe('JsonFileStore — PerRunArtifactStore TCK conformance (issue #183)', () => {
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
