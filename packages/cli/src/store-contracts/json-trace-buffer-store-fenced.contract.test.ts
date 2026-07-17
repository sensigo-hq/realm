// Fenced-trio TCK conformance for JsonTraceBufferStore (issue #207).
//
// See json-trace-buffer-store.contract.test.ts (this directory, the #183 PerRunArtifactStore TCK
// for the same store) for why this lives in @sensigo/realm-cli rather than alongside
// JsonTraceBufferStore's own test suite in @sensigo/realm-mcp: keeping all fs-store TCK
// conformance tests co-located (this directory already depends on both @sensigo/realm and
// @sensigo/realm-mcp) is simpler than splitting across packages for no benefit.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonTraceBufferStore } from '@sensigo/realm-mcp';
import { fencedTraceBufferContract, type FencedTraceBufferLaw } from '@sensigo/realm-testing';

const LAWS: FencedTraceBufferLaw[] = [
  'STRUCTURAL',
  'FENCE_REFUSES',
  'CS_OCCUPANCY',
  'PER_KEY_INDEPENDENCE',
  'NO_SILENT_LOSS',
];

/**
 * A deliberately generous lock profile for this TCK's own store instance (issue #207) — the
 * default profile (~4s worst-case budget) is already ample for this suite's sub-second latch
 * durations, but the TCK's own latch-based laws briefly hold the CS open across several `await`s
 * (drain round-trips, `setImmediate`), so an inflated retry budget removes any risk of a
 * concurrent caller's lock acquisition giving up (ELOCKED) before the law's own observation
 * window completes on a loaded CI runner. Passed via the constructor-injectable lock-profile
 * parameter (issue #207); this is the "injectable generous lock profile" the adapter's own doc
 * requires for `guard-in-cs` stores.
 */
const GENEROUS_LOCK_PROFILE = {
  retries: { retries: 20, minTimeout: 20, maxTimeout: 200 },
  stale: 5000,
  realpath: false,
};

async function makeAdapter(): Promise<{
  adapter: Parameters<typeof fencedTraceBufferContract>[0];
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'json-trace-buffer-store-fenced-tck-'));
  const store = new JsonTraceBufferStore(dir, GENEROUS_LOCK_PROFILE);
  return {
    adapter: {
      store,
      makeKey: () => ({ runId: randomUUID(), stepId: 'fenced-tck-step' }),
      fenceForm: 'guard-in-cs',
      lockProfile: GENEROUS_LOCK_PROFILE,
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe('JsonTraceBufferStore — fenced-trio TCK conformance (issue #207)', () => {
  for (const law of LAWS) {
    it(law, async () => {
      // Fresh adapter (fresh tmpdir) per law — CS_OCCUPANCY/NO_SILENT_LOSS mutate on-disk state
      // and a stale WAL file from an earlier law must never leak into a later one.
      const { adapter, cleanup } = await makeAdapter();
      try {
        const cases = fencedTraceBufferContract(adapter);
        const matching = cases.filter((c) => c.law === law);
        expect(matching.length, `no cases registered for law ${law}`).toBeGreaterThan(0);
        for (const c of matching) {
          await c.run();
        }
      } finally {
        await cleanup();
      }
    });
  }

  it('PER_KEY_INDEPENDENCE (short-timeout variant, for the mutation-probe)', async () => {
    const { adapter, cleanup } = await makeAdapter();
    try {
      const cases = fencedTraceBufferContract(adapter);
      const target = cases.find(
        (c) => c.law === 'PER_KEY_INDEPENDENCE' && c.name.includes('disjoint-run'),
      );
      expect(target).toBeDefined();
      await target!.run();
    } finally {
      await cleanup();
    }
  }, 3000);
});
