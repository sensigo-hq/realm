// evidence-write-order-872.test.ts — #872 (b1) A6: the store TCK's EVIDENCE_WRITE_ORDER law requires a
// store to read a run's evidence back in the order it was written — `get_run_state` pages a run's
// steps in first-attempt order, its cursor a step's place in it. Green against the two stores Realm
// ships (InMemoryStore, JsonFileStore); red against a store written here that reads evidence back
// reversed.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '@sensigo/realm';
import type { RunRecord, RunStore, WorkflowDefinition } from '@sensigo/realm';
import { InMemoryStore } from './in-memory-store.js';
import { runStoreFidelityContract } from './run-store-fidelity-contract.js';

const agentWf: WorkflowDefinition = {
  id: 'tck-write-order',
  name: 'tck-write-order',
  version: 1,
  steps: { s: { description: 'S.', execution: 'agent', depends_on: [] } },
};

/** The EVIDENCE_WRITE_ORDER case of the TCK, against `store`. */
function lawOf(store: RunStore) {
  const cases = runStoreFidelityContract({ store, definition: agentWf, stepName: 's' }).filter(
    (c) => c.law === 'EVIDENCE_WRITE_ORDER',
  );
  expect(cases, 'fixture: the law is one case').toHaveLength(1);
  return cases[0]!;
}

describe('#872 (b1) B9 — EVIDENCE_WRITE_ORDER', () => {
  it('passes for InMemoryStore and JsonFileStore, which read evidence back in write order', async () => {
    // (a) red when a shipped store reorders evidence; (b) prints the law's message (step ids only).
    await lawOf(new InMemoryStore()).run();
    await lawOf(new JsonFileStore(await mkdtemp(join(tmpdir(), 'tck-order-872-')))).run();
  });

  it('REJECTS a store that reads evidence back reversed', async () => {
    class Reverses extends InMemoryStore {
      override async get(runId: string): Promise<RunRecord> {
        const run = await super.get(runId);
        return { ...run, evidence: [...run.evidence].reverse() };
      }
    }
    // (a) red when the law stops comparing the order; (b) prints the law's message.
    await expect(lawOf(new Reverses()).run()).rejects.toThrow(/in the order it was written/);
  });
});
