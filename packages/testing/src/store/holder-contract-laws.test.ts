// holder-contract-laws.test.ts — issue #625 (the holder slice, PR-H): the three new laws catch the
// stores they exist to catch, and the one law no in-repo store can reach is celled through the
// contract on a store that declares what it needs.
//
// A law that no store can fail is a law that proves nothing — so each law here is run against a
// store that breaks exactly the rule it names, and must reject. Each assertion carries (a) the
// change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { InMemoryStore } from './in-memory-store.js';
import { runStoreFidelityContract } from './run-store-fidelity-contract.js';
import { settlementContract, defaultSettlementFixture } from './settlement-contract.js';
import type {
  Attributed,
  RunRecord,
  SettlementDelta,
  SettlementResult,
  WorkflowDefinition,
} from '@sensigo/realm';

const agentWf: WorkflowDefinition = {
  id: 'holder-laws-wf',
  name: 'Holder laws',
  version: 1,
  steps: { work: { description: 'w', execution: 'agent', depends_on: [] } },
};

function fidelityCases(store: InMemoryStore) {
  return runStoreFidelityContract({ store, definition: agentWf, stepName: 'work' });
}

async function rejects(cases: Array<{ run: () => Promise<void> }>): Promise<boolean> {
  for (const c of cases) {
    try {
      await c.run();
    } catch {
      return true;
    }
  }
  return false;
}

describe('CLAIM_NAMES_HOLDER', () => {
  it('passes for a store that writes the holder and the since', async () => {
    const cases = fidelityCases(new InMemoryStore()).filter((c) => c.law === 'CLAIM_NAMES_HOLDER');
    expect(cases).toHaveLength(2);
    for (const c of cases) await c.run();
  });

  it("REJECTS a store that ignores claimStep's fourth argument (red-first)", async () => {
    class IgnoresClaimant extends InMemoryStore {
      override claimStep(runId: string, step: string, def: WorkflowDefinition): Promise<RunRecord> {
        return super.claimStep(runId, step, def);
      }
    }
    const cases = fidelityCases(new IgnoresClaimant()).filter(
      (c) => c.law === 'CLAIM_NAMES_HOLDER',
    );
    // (a) red when the law stops comparing the holder; (b) prints the case that did not reject.
    await expect(cases[0]!.run()).rejects.toThrow(/expected holder .* got undefined/);
  });

  it("REJECTS a store that stamps no since (mutant g's twin)", async () => {
    class NoSince extends InMemoryStore {
      override async claimStep(
        runId: string,
        step: string,
        def: WorkflowDefinition,
        claimant?: Attributed,
      ): Promise<RunRecord> {
        const claimed = await super.claimStep(runId, step, def, claimant);
        const { since: _s, ...claim } = claimed.claims![step]!;
        const stripped = { ...claimed, claims: { ...claimed.claims, [step]: claim } };
        (this as unknown as { runs: Map<string, RunRecord> }).runs.set(runId, stripped);
        return stripped;
      }
    }
    const cases = fidelityCases(new NoSince()).filter((c) => c.law === 'CLAIM_NAMES_HOLDER');
    await expect(cases[0]!.run()).rejects.toThrow(/carries no 'since'/);
  });

  it('REJECTS a store that stamps since from the wrong moment (outside the bracket)', async () => {
    class StaleSince extends InMemoryStore {
      override async claimStep(
        runId: string,
        step: string,
        def: WorkflowDefinition,
        claimant?: Attributed,
      ): Promise<RunRecord> {
        const claimed = await super.claimStep(runId, step, def, claimant);
        const claim = { ...claimed.claims![step]!, since: '2020-01-01T00:00:00.000Z' };
        const moved = { ...claimed, claims: { ...claimed.claims, [step]: claim } };
        (this as unknown as { runs: Map<string, RunRecord> }).runs.set(runId, moved);
        return moved;
      }
    }
    const cases = fidelityCases(new StaleSince()).filter((c) => c.law === 'CLAIM_NAMES_HOLDER');
    await expect(cases[0]!.run()).rejects.toThrow(/outside the bracket/);
  });

  it('REJECTS a store that writes a holder when none was passed', async () => {
    class InventsHolder extends InMemoryStore {
      override claimStep(runId: string, step: string, def: WorkflowDefinition): Promise<RunRecord> {
        return super.claimStep(runId, step, def, {
          by: 'invented',
          by_source: 'derived',
          channel: 'x',
        });
      }
    }
    const cases = fidelityCases(new InventsHolder()).filter((c) => c.law === 'CLAIM_NAMES_HOLDER');
    await expect(cases[1]!.run()).rejects.toThrow(/must carry no 'holder'/);
  });

  it('is SKIPPED BY NAME — one visible case, never silent — for a store that keeps no claims', async () => {
    const store = new InMemoryStore();
    Object.defineProperty(store, 'persistsClaims', { value: false });
    const cases = fidelityCases(store).filter((c) => c.law === 'CLAIM_NAMES_HOLDER');
    expect(cases.map((c) => c.name)).toEqual([
      "SKIPPED — store does not declare 'persistsClaims': claim holder round-trip",
    ]);
    await cases[0]!.run();
  });
});

describe('EVIDENCE_KEEPS_DRIVER_AND_PROOF', () => {
  it('passes for a store that round-trips both fields', async () => {
    const cases = fidelityCases(new InMemoryStore()).filter(
      (c) => c.law === 'EVIDENCE_KEEPS_DRIVER_AND_PROOF',
    );
    expect(cases).toHaveLength(1);
    await cases[0]!.run();
  });

  it('REJECTS a store that drops driven_by, and one that drops claim_proof (red-first)', async () => {
    for (const field of ['driven_by', 'claim_proof'] as const) {
      class Dropping extends InMemoryStore {
        override update(record: RunRecord): Promise<RunRecord> {
          return super.update({
            ...record,
            evidence: record.evidence.map((e) => {
              const { [field]: _gone, ...rest } = e;
              return rest;
            }),
          });
        }
      }
      const cases = fidelityCases(new Dropping()).filter(
        (c) => c.law === 'EVIDENCE_KEEPS_DRIVER_AND_PROOF',
      );
      // (a) red when the law compares only one of the two fields; (b) prints the dropped field.
      await expect(cases[0]!.run(), field).rejects.toThrow(new RegExp(field));
    }
  });
});

describe('GATE_PROOF_NEVER_GATES_THE_ANSWER', () => {
  const settle = (store: InMemoryStore) =>
    settlementContract({
      store,
      storeName: 'InMemoryStore',
      settlementFixture: defaultSettlementFixture,
    }).filter((c) => c.law === 'GATE_PROOF_NEVER_GATES_THE_ANSWER');

  it('REJECTS a store that REFUSES an answer on a wrong token (the "refuse on mismatch" build)', async () => {
    class RefusesOnMismatch extends InMemoryStore {
      override async settleStep(
        runId: string,
        delta: SettlementDelta,
        def: WorkflowDefinition,
        options?: { now?: Date },
      ): Promise<SettlementResult> {
        if (delta.kind === 'settle_gate' && delta.claimToken !== undefined) {
          const run = await this.get(runId);
          const step = run.pending_gate?.step_name;
          const real = step !== undefined ? run.claims?.[step]?.token : undefined;
          if (real !== delta.claimToken) return { applied: false, reason: 'gate_mismatch', run };
        }
        return super.settleStep(runId, delta, def, options);
      }
    }
    // (a) red when the law stops pairing the token-bearing answer with a token-less twin; (b)
    //     prints whether any case rejected.
    expect(await rejects(settle(new RefusesOnMismatch()))).toBe(true);
  });

  it('REJECTS a store whose settlement drops the verdict (no gateClaim on the result)', async () => {
    class DropsVerdict extends InMemoryStore {
      override async settleStep(
        runId: string,
        delta: SettlementDelta,
        def: WorkflowDefinition,
        options?: { now?: Date },
      ): Promise<SettlementResult> {
        const result = await super.settleStep(runId, delta, def, options);
        const { gateClaim: _gone, ...rest } = result;
        return rest as SettlementResult;
      }
    }
    expect(await rejects(settle(new DropsVerdict()))).toBe(true);
  });

  it('passes for the in-repo store, with one case per scenario', async () => {
    const cases = settle(new InMemoryStore());
    expect(cases.length).toBeGreaterThanOrEqual(9);
    for (const c of cases) await c.run();
  });

  it("store_keeps_no_claims is minted by the transform from the store's own declaration — celled through the contract on a store that keeps none", async () => {
    const store = new InMemoryStore();
    Object.defineProperty(store, 'persistsClaims', { value: false });
    const cases = settlementContract({
      store,
      storeName: 'InMemoryStore (persistsClaims: false)',
      settlementFixture: defaultSettlementFixture,
    }).filter((c) => c.law === 'GATE_PROOF_NEVER_GATES_THE_ANSWER');
    // (a) red when the verdict's cause for a missing claim is not derived from the store's own
    //     declaration (a build that always says `no_claim`); (b) prints the failing case's message.
    expect(cases.some((c) => /unverifiable \/ no_claim/.test(c.name))).toBe(true);
    for (const c of cases) await c.run();
  });

  it('REJECTS a store that keeps claims but does not pass storeKeepsClaims (mutant o): its no-claim verdict reads store_keeps_no_claims, not no_claim', async () => {
    // (The option defaults to false, so on a store that keeps NONE the omission is invisible — it
    // is on a store that keeps claims that it shows, which is where this cell runs.)
    class ForgetsTheOption extends InMemoryStore {
      override async settleStep(
        runId: string,
        delta: SettlementDelta,
        def: WorkflowDefinition,
        options?: { now?: Date },
      ): Promise<SettlementResult> {
        const { applySettlement } = await import('@sensigo/realm');
        const fresh = await this.get(runId);
        const outcome = applySettlement(fresh, delta, def, { ...options, cascadeGuards: true });
        if (!outcome.applied) return outcome;
        const stored = await this.update({ ...outcome.run, version: fresh.version });
        return { ...outcome, run: stored };
      }
    }
    // (a) red when the contract stops distinguishing no_claim from store_keeps_no_claims; (b)
    //     prints whether any case rejected.
    expect(await rejects(settle(new ForgetsTheOption()))).toBe(true);
  });
});
