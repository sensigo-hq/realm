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
  type PerRunArtifactStoreContractAdapter,
} from '@sensigo/realm-testing';

const LAWS = [
  'L1_ABSENCE_RESOLVES',
  'L2_IDEMPOTENT',
  'L3_FAILURE_REJECTS',
  'L4_TYPED_REJECTION',
] as const;

/** Fresh adapter per law — see json-file-store.contract.test.ts for why. injectFailure replaces
 *  the `.attempts.jsonl` sidecar with a DIRECTORY (works on every platform and any uid). */
async function makeAdapter(): Promise<{
  adapter: PerRunArtifactStoreContractAdapter;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'failed-attempt-store-tck-'));
  const store = new FailedAttemptStore(dir);
  const runId = randomUUID();
  await store.append(runId, JSON.stringify({ ts: Date.now(), seed: 'tck' }));

  const adapter: PerRunArtifactStoreContractAdapter = {
    store,
    runIdWithArtifact: runId,
    runIdAbsent: randomUUID(),
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
