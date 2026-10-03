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
import {
  InMemoryTraceBufferStore,
  assertFencePredicate,
  type AgentTraceEntry,
  type AppendOptions,
  type AppendResult,
  type FencePredicate,
} from '@sensigo/realm';
import {
  fencedTraceBufferContract,
  createFenceRunSource,
  FENCED_TRACE_BUFFER_LAWS,
  type FencedTraceBufferLaw,
} from '@sensigo/realm-testing';

/**
 * The laws of this contract that THIS file deliberately does not run, each with its reason
 * (issue #625). Empty: InMemoryTraceBufferStore declares the fenced trio and both capability-ladder rungs, so every law applies.
 */
const NOT_RUN: Partial<Record<FencedTraceBufferLaw, string>> = {};

/** The laws this file runs: every exported law, minus the ones named in NOT_RUN above. A law added
 *  to the contract therefore runs here without this file being touched. */
const LAWS: readonly FencedTraceBufferLaw[] = FENCED_TRACE_BUFFER_LAWS.filter(
  (law) => !(law in NOT_RUN),
);

/** A store whose `appendFenced` checks the fence's shape but never reads the run — so it can never
 *  hold a key, and every case that holds one through it must fail by name (issue #616 PR-0). */
class NeverReadsStore extends InMemoryTraceBufferStore {
  override async appendFenced(
    runId: string,
    stepId: string,
    entries: AgentTraceEntry[],
    fence: FencePredicate,
    options?: AppendOptions,
  ): Promise<AppendResult> {
    assertFencePredicate(fence, stepId);
    return this.append(runId, stepId, entries, options);
  }
}

function makeKey(): { runId: string; stepId: string } {
  return { runId: randomUUID(), stepId: 'fenced-tck-step' };
}

/** Builds this store's adapter — a fresh run source and a fresh store per call, so callers that
 *  want isolation (every `it` below) get it by simply calling this again. */
function makeAdapter(): { adapter: Parameters<typeof fencedTraceBufferContract>[0] } {
  // issue #616 PR-0, D3: the store evaluates every fence against the TCK's run source; `control`
  // is what every adapter supplies, `park` is what only an injected-reader adapter supplies.
  const runSource = createFenceRunSource();
  const store = new InMemoryTraceBufferStore(runSource.reader);
  return {
    adapter: {
      store,
      fenceRuns: runSource.control,
      makeKey,
      fenceForm: 'injected-reader',
      fenceRunPark: runSource.park,
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
    // A skip case's name carries the real case's text, so `find` alone would accept
    // it — and a skip's no-op `run` passes. The variant exists to run the REAL case
    // under a short timeout.
    expect(target!.name.startsWith('SKIPPED — '), 'must run the real case, never a skip').toBe(
      false,
    );
    await target!.run();
  }, 2000);

  // issue #616 PR-0 — a holder's parked run read is what holds the key. A store whose fenced method
  // never reads the run can never be held, so the cases that hold the key through `appendFenced`
  // must fail at once with a message naming why — a third party wiring each case as its own test
  // would otherwise see only its framework's timeout.
  it('a store that never reads the run fails the key-holding cases at once, by name', async () => {
    const runSource = createFenceRunSource();
    const cases = fencedTraceBufferContract({
      store: new NeverReadsStore(runSource.reader),
      fenceRuns: runSource.control,
      makeKey,
      fenceForm: 'injected-reader',
      fenceRunPark: runSource.park,
    });
    const held = cases.filter((c) => c.name.startsWith('MALFORMED while the key is held'));
    const setup = cases.filter(
      (c) =>
        c.name.startsWith('appendFenced holding the CS') ||
        c.name.startsWith('single-waiter subcase') ||
        c.name.startsWith('a disjoint-run key'),
    );
    expect(held.length, 'the held-key cases').toBeGreaterThan(0);
    expect(setup.length, 'the cases built on the key-holding setup').toBeGreaterThan(0);
    const outcomes = await Promise.all(
      [...held, ...setup].map(async (c) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const pending = new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('still pending after 2000 ms'), 2000);
        });
        const outcome = await Promise.race([
          c.run().then(
            () => 'passed',
            (err: unknown) => (err instanceof Error ? err.message : String(err)),
          ),
          pending,
        ]);
        clearTimeout(timer);
        return { name: c.name, outcome };
      }),
    );
    // The whole message, prefix included: every case's holder is `appendFenced`, and the prefix is
    // the held case's own name or the shared setup's.
    const reason =
      'appendFenced settled without reading the run for its fence, so the key was never held — ' +
      'a fenced method must read the run inside the critical section it fences';
    const contextOf = (name: string): string => {
      const heldCase =
        /^(MALFORMED while the key is held \(.*\)): \w+ refused at once with ENGINE_INTERNAL$/.exec(
          name,
        );
      return heldCase ? `FENCE_DATA ${heldCase[1]}` : 'the key-holding setup';
    };
    for (const { name, outcome } of outcomes) {
      expect(outcome, name).toBe(`${contextOf(name)}: ${reason}`);
    }
  }, 10000);

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

describe('InMemoryTraceBufferStore fenced wiring — the run list is derived from the contract', () => {
  // (a) red when a law is dropped from the run list WITHOUT being named in NOT_RUN, or NOT_RUN
  //     names a law the contract no longer exports; (b) prints the unaccounted / unknown laws.
  it('every exported law is either run or named in NOT_RUN, and NOT_RUN names only exported laws (issue #625)', () => {
    const exported: readonly string[] = FENCED_TRACE_BUFFER_LAWS;
    const named = Object.keys(NOT_RUN);
    expect(named.filter((law) => !exported.includes(law))).toEqual([]);
    expect([...LAWS, ...named].sort()).toEqual([...exported].sort());
    for (const reason of Object.values(NOT_RUN)) expect(reason).not.toBe('');
  });
});
