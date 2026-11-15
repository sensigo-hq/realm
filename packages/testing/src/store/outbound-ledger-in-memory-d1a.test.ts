// outbound-ledger-in-memory-d1a.test.ts — issue #597, D1a: the published outbound-ledger contract
// (`outboundLedgerContract`) run against `InMemoryStore`'s ledger, every law, and the store's own
// cells (built with `outbound: null` it keeps no ledger; its ledger reads the store's own runs). The
// ledger's purge pair is pinned by the family's `OL_PURGE`: an in-memory ledger can neither fail nor
// declare a release line, so the per-run artifact contract runs on SQLite's ledger (D1c), not here.
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

const RUN = 'run-outbound-own';
const GATE: PendingGate = {
  gate_id: 'gate-outbound-own',
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
    workflow_id: 'wf-outbound-own',
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
