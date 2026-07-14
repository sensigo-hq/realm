// PerRunArtifactStore TCK conformance for JsonTraceBufferStore (issue #183).
//
// See json-file-store.contract.test.ts (this directory) for why this lives in @sensigo/realm-cli
// rather than alongside JsonTraceBufferStore's own test suite in @sensigo/realm-mcp: keeping all
// three fs stores' TCK conformance tests co-located (this directory already depends on both
// @sensigo/realm and @sensigo/realm-mcp, exactly as purge.ts — the operator-facing orchestrator
// this contract protects — does) is simpler than splitting them across packages for no benefit
// (@sensigo/realm-mcp itself has no circular-dependency blocker the way @sensigo/realm does, but
// there's no reason to split the TCK wiring across two packages when one already has everything).
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonTraceBufferStore } from '@sensigo/realm-mcp';
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
 * Fresh adapter per law — see json-file-store.contract.test.ts for why. injectFailure replaces
 * the seeded WAL file with a DIRECTORY. The exact filename is looked up via `readdir` + the
 * known `trace-buffer-<runId>-*.jsonl` glob (mirroring deleteAllForRun's own matcher) rather than
 * recomputing JsonTraceBufferStore's private base64url stepId encoding — this stays robust to an
 * internal encoding change.
 */
async function makeAdapter(): Promise<{
  adapter: PerRunArtifactStoreContractAdapter;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'json-trace-buffer-store-tck-'));
  const store = new JsonTraceBufferStore(dir);
  const runId = randomUUID();
  await store.append(runId, 'tck-step', [{ event: 'tck-seed' }]);

  const adapter: PerRunArtifactStoreContractAdapter = {
    store,
    runIdWithArtifact: runId,
    runIdAbsent: randomUUID(),
    injectFailure: async (id: string) => {
      const prefix = `trace-buffer-${id}-`;
      const entries = await readdir(dir);
      const match = entries.find((f) => f.startsWith(prefix) && f.endsWith('.jsonl'));
      if (match === undefined) {
        throw new Error(`no seeded WAL file found for run '${id}' — adapter setup bug`);
      }
      const path = join(dir, match);
      await rm(path, { recursive: true, force: true });
      await mkdir(path);
    },
  };

  return { adapter, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe('JsonTraceBufferStore — PerRunArtifactStore TCK conformance (issue #183)', () => {
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
