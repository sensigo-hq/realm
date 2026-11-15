// outbound-ledger-in-memory-d1a.test.ts — issue #597, D1a: the published outbound-ledger contract
// (`outboundLedgerContract`) run against `InMemoryStore`'s ledger, every law; the per-run artifact
// contract run against the same ledger's purge pair; and the store's own cells (built with
// `outbound: null` it keeps no ledger; its ledger reads the store's own runs).
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it:
// (a) what turns it red, (b) what it prints then.
import { describe, expect, it } from 'vitest';
import type { PendingGate, RunRecord } from '@sensigo/realm';
import { InMemoryOutboundLedger, InMemoryStore } from './in-memory-store.js';
import {
  OUTBOUND_LEDGER_LAWS,
  outboundLedgerContract,
  type OutboundLedgerContractAdapter,
  type OutboundLedgerLaw,
} from './outbound-ledger-contract.js';
import {
  ARTIFACT_STORE_LAWS,
  perRunArtifactStoreContract,
  type ArtifactStoreLaw,
  type PerRunArtifactStoreContractAdapter,
} from './per-run-artifact-store-contract.js';

/** The outbound laws this file does not run, each with its reason. None: the in-memory store runs every one. */
const NOT_RUN: Partial<Record<OutboundLedgerLaw, string>> = {};

/** Every exported law but those named above: a law added to the contract runs here untouched. */
const LAWS: readonly OutboundLedgerLaw[] = OUTBOUND_LEDGER_LAWS.filter((law) => !(law in NOT_RUN));

const ADAPTER: OutboundLedgerContractAdapter = {
  storeName: 'InMemoryStore',
  makeStore: async ({ clock }) => {
    const store = new InMemoryStore({ clock });
    return { store, seedRun: async (record) => store.seed(record) };
  },
};

describe('#597 D1a — InMemoryStore runs the outbound-ledger contract', () => {
  it('runs every law: NOT_RUN is empty', () => {
    // (a) red when a law is put in NOT_RUN (it then never runs here); (b) prints the laws named there.
    expect(NOT_RUN).toEqual({});
  });

  const cases = outboundLedgerContract(ADAPTER);
  it('the contract has one case per exported law, in order', () => {
    // (a) red when a law is exported without a case, or a case is registered under another law;
    //     (b) prints both lists.
    expect(cases.map((c) => c.law)).toEqual([...OUTBOUND_LEDGER_LAWS]);
  });
  for (const law of LAWS) {
    it(`conforms to ${law}`, async () => {
      const target = cases.find((c) => c.law === law);
      // (a) red when the contract stops registering a case for a law this file runs; (b) prints the
      //     law. The case itself throws, naming the law, the step and what the store returned.
      expect(target, `no case for ${law}`).toBeDefined();
      await target!.run();
    });
  }
});

/**
 * The per-run artifact laws this file does not run on the ledger, each with its reason (the convention
 * `ARTIFACT_STORE_LAWS` states): an in-memory ledger has no I/O that can fail and declares no release
 * line.
 */
const ARTIFACT_NOT_RUN: Partial<Record<ArtifactStoreLaw, string>> = {
  L3_FAILURE_REJECTS: 'no failure to inject, no release line',
  L4_TYPED_REJECTION: 'no failure to inject, no release line',
  STORE_RELEASE_LINE_TRUE: 'no failure to inject, no release line',
};
const ARTIFACT_LAWS: readonly ArtifactStoreLaw[] = ARTIFACT_STORE_LAWS.filter(
  (law) => !(law in ARTIFACT_NOT_RUN),
);

const RUN = 'run-outbound-artifact';
const GATE: PendingGate = {
  gate_id: 'gate-outbound-artifact',
  step_name: 'review',
  preview: {},
  choices: ['approve'],
  opened_at: '2026-01-01T00:00:00.000Z',
  reminder_seconds: 600,
  reminder_max: 3,
};

function runWithGate(id: string, gate?: PendingGate): RunRecord {
  return {
    id,
    workflow_id: 'wf-outbound-artifact',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: gate !== undefined ? 'gate_waiting' : 'running',
    version: 1,
    params: {},
    evidence: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: false,
    ...(gate !== undefined ? { pending_gate: gate } : {}),
  };
}

/** A fresh store, its run's open question and a ledger seeded with every kind of row (fresh per law). */
async function makeArtifactAdapter(): Promise<PerRunArtifactStoreContractAdapter> {
  const store = new InMemoryStore();
  store.seed(runWithGate(RUN, GATE));
  const ledger = store.outbound!;
  const what = (k: number) => ({ type: 'reminder', gateId: GATE.gate_id, occurrence: k }) as const;
  const reseed = async (): Promise<void> => {
    // A sent row with its outcome, a failed row, a pending row and an escalation row: every text field.
    await ledger.lease(RUN, { what: what(1), leaseToken: 'A', leaseSeconds: 120 });
    await ledger.mark(RUN, { what: what(1), leaseToken: 'A', result: 'sent', outcome: 'ok' });
    await ledger.lease(RUN, { what: what(2), leaseToken: 'A', leaseSeconds: 120 });
    await ledger.mark(RUN, {
      what: what(2),
      leaseToken: 'A',
      result: 'failed',
      outcome: 'refused:channel_not_found',
    });
    await ledger.lease(RUN, { what: what(3), leaseToken: 'A', leaseSeconds: 120 });
    await ledger.lease(RUN, {
      what: { type: 'escalation', gateId: GATE.gate_id },
      leaseToken: 'A',
      leaseSeconds: 120,
    });
  };
  await reseed();
  return {
    store: ledger,
    runIdWithArtifact: RUN,
    runIdAbsent: 'run-outbound-artifact-absent',
    injectFailure: () => {
      throw new Error('not run here: an in-memory ledger has no failure to inject');
    },
    reseed,
  };
}

describe('#597 D1a — the in-memory outbound ledger runs the per-run artifact contract', () => {
  it('every exported law is either run or named in ARTIFACT_NOT_RUN, each with a reason', () => {
    // (a) red when a law is dropped without being named, or a named law is no longer exported;
    //     (b) prints the lists.
    const exported: readonly string[] = ARTIFACT_STORE_LAWS;
    const named = Object.keys(ARTIFACT_NOT_RUN);
    expect(named.filter((law) => !exported.includes(law))).toEqual([]);
    expect([...ARTIFACT_LAWS, ...named].sort()).toEqual([...exported].sort());
    expect(ARTIFACT_LAWS).toEqual([
      'L1_ABSENCE_RESOLVES',
      'L2_IDEMPOTENT',
      'L5_REPORT_SHAPE',
      'L6_PREVIEW_EQUALS_RECEIPT',
    ]);
  });

  for (const law of ARTIFACT_LAWS) {
    it(`conforms to ${law}`, async () => {
      const target = perRunArtifactStoreContract(await makeArtifactAdapter()).find(
        (c) => c.law === law,
      );
      // (a) red when the case is gone or its law fails (an under-counting stat, a delete that
      //     reports a figure the stat did not); (b) the case's own error names the figures.
      expect(target, `no case for ${law}`).toBeDefined();
      await target!.run();
    });
  }
});

describe('#597 D1a — InMemoryStore’s own outbound ledger', () => {
  it('keeps one by default, and none when built with outbound: null', () => {
    // (a) red when the default store has no ledger, or `outbound: null` still builds one; (b) prints
    //     what each store holds.
    expect({
      byDefault: new InMemoryStore().outbound instanceof InMemoryOutboundLedger,
      withNull: new InMemoryStore({ outbound: null }).outbound,
    }).toEqual({ byDefault: true, withNull: null });
  });

  it('reads the open question of the store’s own run: none, then one', async () => {
    const store = new InMemoryStore();
    const lease = {
      what: { type: 'escalation', gateId: GATE.gate_id },
      leaseToken: 'A',
      leaseSeconds: 60,
    } as const;
    store.seed(runWithGate(RUN));
    const before = await store.outbound!.lease(RUN, lease);
    store.seed(runWithGate(RUN, GATE));
    const after = await store.outbound!.lease(RUN, lease);
    // (a) red when the ledger reads another run, or a copy of the store taken at construction (it
    //     would miss the question seeded after); (b) prints both answers.
    expect({ before: before.applied ? 'applied' : before.reason, after: after.applied }).toEqual({
      before: 'gate_not_open',
      after: true,
    });
  });
});
