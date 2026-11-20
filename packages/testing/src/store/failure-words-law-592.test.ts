// failure-words-law-592.test.ts — Q1 (#592) unit a: the store TCK's EVIDENCE_KEEPS_FAILURE_WORDS law
// requires a store to round-trip a failed entry's `error_code`, `error_category`, `agent_action` and
// `stop_reason`, and to add none to an entry written without them. Green against InMemoryStore (the
// SQLite store runs the law in store-sqlite's contract-fidelity-616.test.ts); red against a store
// written here that drops one of the four, and against one that makes a word up.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import type { RunRecord, WorkflowDefinition, Snapshot } from '@sensigo/realm';
import { InMemoryStore } from './in-memory-store.js';
import { runStoreFidelityContract } from './run-store-fidelity-contract.js';

const wf: WorkflowDefinition = {
  id: 'tck-failure-words',
  name: 'tck-failure-words',
  version: 1,
  steps: { s: { description: 'S.', execution: 'auto', depends_on: [] } },
};

/** The EVIDENCE_KEEPS_FAILURE_WORDS case of the TCK, against `store`. */
function lawOf(store: InMemoryStore) {
  const cases = runStoreFidelityContract({ store, definition: wf, stepName: 's' }).filter(
    (c) => c.law === 'EVIDENCE_KEEPS_FAILURE_WORDS',
  );
  expect(cases, 'fixture: the law is one case').toHaveLength(1);
  return cases[0]!;
}

const WORDS = ['error_code', 'error_category', 'agent_action', 'stop_reason'] as const;

describe('Q1 (#592) unit a — EVIDENCE_KEEPS_FAILURE_WORDS', () => {
  it('passes for InMemoryStore, which round-trips the four words', async () => {
    // (a) red when the shipped store drops a word; (b) prints the law's message.
    await lawOf(new InMemoryStore()).run();
  });

  for (const word of WORDS) {
    it(`REJECTS a store that drops ${word}`, async () => {
      class DropsOne extends InMemoryStore {
        override update(record: RunRecord): Promise<Snapshot> {
          return super.update({
            ...record,
            evidence: record.evidence.map((e) => {
              const { [word]: _gone, ...rest } = e;
              return rest;
            }),
          });
        }
      }
      // (a) red when the law does not compare this word; (b) prints the law's message.
      await expect(lawOf(new DropsOne()).run()).rejects.toThrow(/EVIDENCE_KEEPS_FAILURE_WORDS/);
    });
  }

  it('REJECTS a store that makes a word up on an entry written without them', async () => {
    class MakesOneUp extends InMemoryStore {
      override update(record: RunRecord): Promise<Snapshot> {
        return super.update({
          ...record,
          evidence: record.evidence.map((e) =>
            e.error_code === undefined ? { ...e, stop_reason: 'attempts' as const } : e,
          ),
        });
      }
    }
    // (a) red when the law reads only the entry written with the words; (b) prints the message.
    await expect(lawOf(new MakesOneUp()).run()).rejects.toThrow(/without them/);
  });
});
