// remembered-law-g3u1a.test.ts — gap 3, unit 1a, check 11: the store TCK's EVIDENCE_KEEPS_REMEMBERED
// law requires a store to keep an evidence entry's `remembered` (what a step remembered for later
// runs, or why it remembered nothing) exactly, and to add none to an entry written without it. Green
// against InMemoryStore and the JSON-file store (wrapped as a `RunStore`); the SQLite store runs the
// law in store-sqlite's contract-fidelity-616.test.ts. Red against a store written here that drops the
// field, and against one that makes one up.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { afterEach, describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '@sensigo/realm';
import type { RunRecord, RunStore, Snapshot, WorkflowDefinition } from '@sensigo/realm';
import { InMemoryStore } from './in-memory-store.js';
import { runStoreFidelityContract } from './run-store-fidelity-contract.js';
import { jsonAsRunStore } from '../test-support/json-as-run-store.js';

const wf: WorkflowDefinition = {
  id: 'tck-remembered',
  name: 'tck-remembered',
  version: 1,
  steps: { s: { description: 'S.', execution: 'agent', depends_on: [] } },
};

/** Runs the law's one case against `store`; returns its failure message, or none. */
async function failuresOf(store: RunStore): Promise<string[]> {
  const cases = runStoreFidelityContract({ store, definition: wf, stepName: 's' }).filter(
    (c) => c.law === 'EVIDENCE_KEEPS_REMEMBERED',
  );
  expect(cases, 'fixture: the law has one case, not skipped').toHaveLength(1);
  expect(cases.filter((c) => c.skipped === true)).toHaveLength(0);
  const failed: string[] = [];
  for (const c of cases) {
    try {
      await c.run();
    } catch (err) {
      failed.push((err as Error).message);
    }
  }
  return failed;
}

/** `record` with `edit` applied to each evidence entry. */
const eachEntry = (
  record: RunRecord,
  edit: (e: RunRecord['evidence'][number]) => RunRecord['evidence'][number],
): RunRecord => ({ ...record, evidence: record.evidence.map(edit) });

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('gap 3, unit 1a — EVIDENCE_KEEPS_REMEMBERED', () => {
  it('passes for InMemoryStore, which keeps the field', async () => {
    // (a) red when the shipped store drops or changes the field; (b) prints the case's message.
    expect(await failuresOf(new InMemoryStore())).toEqual([]);
  });

  it('passes for the JSON-file store, which keeps the entry whole', async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-g3u1a-json-'));
    // (a) red when the JSON store drops or changes the field; (b) prints the case's message.
    expect(await failuresOf(jsonAsRunStore(new JsonFileStore(dir)))).toEqual([]);
  });

  it('REJECTS a store that drops remembered on update', async () => {
    class DropsIt extends InMemoryStore {
      override update(record: RunRecord): Promise<Snapshot> {
        return super.update(eachEntry(record, ({ remembered: _gone, ...rest }) => rest));
      }
    }
    // (a) red when the law reads the field back nowhere; (b) prints the message.
    const failed = await failuresOf(new DropsIt());
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatch(
      /^EVIDENCE_KEEPS_REMEMBERED: an evidence entry's remembered reads back as undefined/,
    );
  });

  it('REJECTS a store that makes a stamp up on an entry written without it', async () => {
    class MakesOneUp extends InMemoryStore {
      override update(record: RunRecord): Promise<Snapshot> {
        return super.update(
          eachEntry(record, (e) =>
            e.remembered === undefined
              ? { ...e, remembered: { as: 'made_up', not_remembered: 'key_absent' } }
              : e,
          ),
        );
      }
    }
    // (a) red when the law reads only the entries written with the field; (b) prints the message.
    const failed = await failuresOf(new MakesOneUp());
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatch(/written without remembered/);
  });
});
