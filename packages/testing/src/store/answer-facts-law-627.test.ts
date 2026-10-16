// answer-facts-law-627.test.ts — issue #627 W (§5.8): the store TCK's EVIDENCE_KEEPS_ANSWER_FACTS law
// requires a store to round-trip how an answer arrived — `answer` (route and what showed it, or the
// typed absence), `driven_by`, `client_prompt_requested` and `principal` (a kind, or the typed
// absence). Green against the two stores Realm ships (InMemoryStore, JsonFileStore); red against a
// store written here that drops one field, once per field.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '@sensigo/realm';
import type { EvidenceSnapshot, RunRecord, RunStore, WorkflowDefinition } from '@sensigo/realm';
import { InMemoryStore } from './in-memory-store.js';
import { runStoreFidelityContract } from './run-store-fidelity-contract.js';

const agentWf: WorkflowDefinition = {
  id: 'tck-answer-facts',
  name: 'tck-answer-facts',
  version: 1,
  steps: { s: { description: 'S.', execution: 'agent', depends_on: [] } },
};

/** The EVIDENCE_KEEPS_ANSWER_FACTS case of the TCK, against `store`. */
function lawOf(store: RunStore) {
  const cases = runStoreFidelityContract({ store, definition: agentWf, stepName: 's' }).filter(
    (c) => c.law === 'EVIDENCE_KEEPS_ANSWER_FACTS',
  );
  expect(cases, 'fixture: the law is one case').toHaveLength(1);
  return cases[0]!;
}

/** A store that drops one evidence field on every write — the lossy store the law must refuse. */
function dropping(field: keyof EvidenceSnapshot): RunStore {
  class Drops extends InMemoryStore {
    override update(record: RunRecord): Promise<RunRecord> {
      return super.update({
        ...record,
        evidence: record.evidence.map((entry) => {
          const kept = { ...entry };
          delete kept[field];
          return kept;
        }),
      });
    }
  }
  return new Drops();
}

describe('#627 W — EVIDENCE_KEEPS_ANSWER_FACTS', () => {
  it('passes for InMemoryStore and JsonFileStore, which round-trip every answer fact', async () => {
    // (a) red when a shipped store drops an answer fact; (b) prints the law's message, naming the
    // field and what was written and read (synthetic values only — no token, no real principal).
    await lawOf(new InMemoryStore()).run();
    await lawOf(new JsonFileStore(await mkdtemp(join(tmpdir(), 'tck-answer-627-')))).run();
  });

  it.each(['answer', 'driven_by', 'client_prompt_requested', 'principal'] as const)(
    'REJECTS a store that drops %s',
    async (field) => {
      // (a) red when the law stops comparing that field; (b) prints the law's message.
      await expect(lawOf(dropping(field)).run()).rejects.toThrow(field);
    },
  );

  it('REJECTS a store that fills in an answer fact the entry was written without', async () => {
    class FillsIn extends InMemoryStore {
      override update(record: RunRecord): Promise<RunRecord> {
        return super.update({
          ...record,
          evidence: record.evidence.map((entry) => ({ ...entry, client_prompt_requested: true })),
        });
      }
    }
    // (a) red when the law stops checking the second entry for invented facts; (b) prints the
    // law's message.
    await expect(lawOf(new FillsIn()).run()).rejects.toThrow(/never fills in an answer fact/);
  });
});
