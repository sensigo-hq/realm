// output-source-law-625.test.ts — issue #625 PR-2a, the last prompt's F4 (framework §5 E1): the store TCK's
// EVIDENCE_KEEPS_DRIVER_AND_PROOF law requires a store to round-trip an evidence entry's
// `output_source`. Green against the two stores Realm ships (InMemoryStore, JsonFileStore); red against
// a store written here that drops the field.
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
  id: 'tck-output-source',
  name: 'tck-output-source',
  version: 1,
  steps: { s: { description: 'S.', execution: 'agent', depends_on: [] } },
};

/** The EVIDENCE_KEEPS_DRIVER_AND_PROOF case of the TCK, against `store`. */
function lawOf(store: RunStore) {
  const cases = runStoreFidelityContract({ store, definition: agentWf, stepName: 's' }).filter(
    (c) => c.law === 'EVIDENCE_KEEPS_DRIVER_AND_PROOF',
  );
  expect(cases, 'fixture: the law is one case').toHaveLength(1);
  return cases[0]!;
}

describe('#625 PR-2a, F4 — EVIDENCE_KEEPS_DRIVER_AND_PROOF covers output_source', () => {
  it('passes for InMemoryStore and JsonFileStore, which round-trip it', async () => {
    // (a) red when a shipped store drops `output_source`; (b) prints the law's message.
    await lawOf(new InMemoryStore()).run();
    await lawOf(new JsonFileStore(await mkdtemp(join(tmpdir(), 'tck-os-625-')))).run();
  });

  it('REJECTS a store that drops output_source (red against a lossy store)', async () => {
    class DropsOutputSource extends InMemoryStore {
      override update(record: RunRecord): Promise<RunRecord> {
        return super.update({
          ...record,
          evidence: record.evidence.map(({ output_source: _gone, ...rest }) => rest),
        });
      }
    }
    // (a) red when the law does not compare `output_source`; (b) prints the law's message.
    await expect(lawOf(new DropsOutputSource()).run()).rejects.toThrow(/output_source/);
  });
});
