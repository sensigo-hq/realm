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
import { fencedTraceBufferContract, type FencedTraceBufferLaw } from '@sensigo/realm-testing';

const LAWS: FencedTraceBufferLaw[] = [
  'STRUCTURAL',
  'FENCE_REFUSES',
  'CS_OCCUPANCY',
  'PER_KEY_INDEPENDENCE',
  'NO_SILENT_LOSS',
];

function makeKey(): { runId: string; stepId: string } {
  return { runId: randomUUID(), stepId: 'fenced-tck-step' };
}

describe('InMemoryTraceBufferStore — fenced-trio TCK conformance (issue #207)', () => {
  for (const law of LAWS) {
    it(law, async () => {
      // A fresh store per law — the in-memory store's per-key chain map has no cross-test state
      // to worry about, but a fresh instance keeps each law's cases fully isolated regardless.
      const store = new InMemoryTraceBufferStore();
      const cases = fencedTraceBufferContract({
        store,
        makeKey,
        fenceForm: 'guard-in-cs',
      });
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
    const store = new InMemoryTraceBufferStore();
    const cases = fencedTraceBufferContract({ store, makeKey, fenceForm: 'guard-in-cs' });
    const target = cases.find(
      (c) => c.law === 'PER_KEY_INDEPENDENCE' && c.name.includes('disjoint-run'),
    );
    expect(target).toBeDefined();
    await target!.run();
  }, 2000);
});
