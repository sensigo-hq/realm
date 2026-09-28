// Fenced-trio TCK conformance for InMemoryTraceBufferStore (issue #207).
//
// See json-trace-buffer-store-fenced.contract.test.ts (this directory) and
// json-file-store.contract.test.ts for why these TCK-wiring tests live in @sensigo/realm-cli
// rather than alongside each store's own package: @sensigo/realm-testing depends on
// @sensigo/realm, so a devDependency the other way round (packages/core → @sensigo/realm-testing)
// would be a genuine circular PACKAGE dependency (the #183 precedent). @sensigo/realm-cli already
// depends on both.
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryTraceBufferStore } from '@sensigo/realm';
import {
  fencedTraceBufferContract,
  createFenceRunSource,
  type FencedTraceBufferLaw,
} from '@sensigo/realm-testing';

const LAWS: FencedTraceBufferLaw[] = [
  'STRUCTURAL',
  'FENCE_REFUSES',
  // issue #616 PR-0: each of the five FencePredicate members — true, false, and a racer.
  'FENCE_DATA',
  'CS_OCCUPANCY',
  'PER_KEY_INDEPENDENCE',
  'NO_SILENT_LOSS',
  // issue #197 PR-1: InMemoryTraceBufferStore declares both capability-ladder rungs (`seal` and
  // `writer_nonce_carriage`), so every one of these five laws has real (non-skip) cases here —
  // the PER_WRITER_BUDGET byte-exactness and VERBATIM raw-byte sub-cases are the ONLY ones that
  // render as a visible skip (no `bytesOracle`/`rawWalAccess` supplied below — see their own doc:
  // "bytes" for an in-memory structure has no independent ground truth to check against the way a
  // physical file's on-disk size does, so a pseudo-oracle here would just re-derive the same
  // formula and verify nothing new).
  'CARRIAGE_ROUND_TRIP',
  'SEAL',
  'SEAL_BUDGET',
  'PER_WRITER_BUDGET',
  'VERBATIM',
];

function makeKey(): { runId: string; stepId: string } {
  return { runId: randomUUID(), stepId: 'fenced-tck-step' };
}

/** Builds this store's adapter — a fresh run source and a fresh store per call, so callers that
 *  want isolation (every `it` below) get it by simply calling this again. */
function makeAdapter(): { adapter: Parameters<typeof fencedTraceBufferContract>[0] } {
  // issue #616 PR-0, D3: the store evaluates every fence against the TCK's run source; `control`
  // is what every adapter supplies, `park` is what only an injected-reader adapter supplies.
  const fenceRuns = createFenceRunSource();
  const store = new InMemoryTraceBufferStore(fenceRuns.reader);
  return {
    adapter: {
      store,
      fenceRuns: fenceRuns.control,
      makeKey,
      fenceForm: 'injected-reader',
      fenceRunPark: fenceRuns.park,
    },
  };
}

describe('InMemoryTraceBufferStore — fenced-trio TCK conformance (issue #207)', () => {
  for (const law of LAWS) {
    it(law, async () => {
      // A fresh store per law — the in-memory store's per-key chain map has no cross-test state
      // to worry about, but a fresh instance keeps each law's cases fully isolated regardless.
      const { adapter } = makeAdapter();
      const cases = fencedTraceBufferContract(adapter);
      const matching = cases.filter((c) => c.law === law);
      expect(matching.length, `no cases registered for law ${law}`).toBeGreaterThan(0);
      for (const c of matching) {
        await c.run();
      }
    });
  }

  // PER_KEY_INDEPENDENCE's own doc states a global-lock store hangs into the framework timeout —
  // give it a short, explicit timeout so a regression here fails fast rather than waiting out the
  // suite's default timeout (mutation-probe g in this task's report relies on this).
  it('PER_KEY_INDEPENDENCE (short-timeout variant, for the mutation-probe)', async () => {
    const { adapter } = makeAdapter();
    const cases = fencedTraceBufferContract(adapter);
    const target = cases.find(
      (c) => c.law === 'PER_KEY_INDEPENDENCE' && c.name.includes('disjoint-run'),
    );
    expect(target).toBeDefined();
    await target!.run();
  }, 2000);

  // issue #616 PR-0, D3: a skipped case renders `✓` for its law in a runner (both realm adapters
  // have a park, so every park-dependent law above runs for real) — the ONLY visible-but-not-a-✓
  // skips this adapter registers are these two pre-existing ones, from not supplying the two
  // optional byte-comparison hooks (`bytesOracle`/`rawWalAccess`; a physical file's on-disk bytes
  // are an independent ground truth an in-memory structure's own accounting has no analogue of —
  // see `bytesOracle`'s and `rawWalAccess`'s own doc on `FencedTraceBufferContractAdapter`). This
  // assertion is what would fail loudly (naming what it lost) if this adapter ever lost its park.
  it('registers exactly its two known, pre-existing skips — no park-dependent case is silently skipped', () => {
    const { adapter } = makeAdapter();
    const cases = fencedTraceBufferContract(adapter);
    const skipped = cases.filter((c) => c.name.startsWith('SKIPPED — ')).map((c) => c.name);
    expect(skipped.sort()).toEqual(
      [
        'SKIPPED — adapter did not supply bytesOracle (count-based assertions above still ran): byte-exactness against an adapter-supplied oracle',
        'SKIPPED — adapter did not supply rawWalAccess (the shape-tolerant sibling case above still ran): byte-for-byte raw comparison against an adapter-supplied rawWalAccess hook',
      ].sort(),
    );
  });
});
