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
  'L5_REPORT_SHAPE',
  'L6_PREVIEW_EQUALS_RECEIPT',
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
  /**
   * FIXTURE TEETH (issue #189): this store owns TWO artifact classes — live WAL files and SEALED
   * artifacts — and both deletion paths remove both. A fixture with only a WAL file would let a
   * stat that counts WAL alone satisfy L6, which is the same under-count the retired filename
   * scan produced (worse: that scan DID catch sealed files, so a WAL-only stat would be a
   * regression shipped through the law meant to prevent it).
   */
  const seed = async (): Promise<void> => {
    await store.append(runId, 'tck-sealed-step', [{ event: 'tck-to-be-sealed' }]);
    const sealed = await store.sealFenced(runId, 'tck-sealed-step', async () => {});
    if (!sealed.sealed) {
      throw new Error(
        `TCK fixture is toothless: sealFenced did not produce a sealed artifact (${JSON.stringify(sealed)}) — L6 needs both artifact classes present (issue #189).`,
      );
    }
    await store.append(runId, 'tck-step', [{ event: 'tck-seed' }]);
  };
  await seed();

  const adapter: PerRunArtifactStoreContractAdapter = {
    store,
    runIdWithArtifact: runId,
    runIdAbsent: randomUUID(),
    reseed: seed,
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
