// model-attempts-law-g2ia.test.ts — gap 2, unit (i-a): the store TCK's RECORD_KEEPS_MODEL_ATTEMPTS law
// requires a store to keep `model_attempts` (a step's failed model tries) on an evidence entry and on
// a drive-failure entry, from `get` and from a listing, to accept an update that keeps it unchanged,
// and to add none to an entry written without it. Green against InMemoryStore (the SQLite store runs
// the law in store-sqlite's contract-fidelity-616.test.ts); red against a store written here that
// drops the field, and against one that makes a list up.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import type { RunRecord, WorkflowDefinition, Snapshot, ModelAttempt } from '@sensigo/realm';
import { InMemoryStore } from './in-memory-store.js';
import { runStoreFidelityContract } from './run-store-fidelity-contract.js';

const wf: WorkflowDefinition = {
  id: 'tck-model-attempts',
  name: 'tck-model-attempts',
  version: 1,
  steps: { s: { description: 'S.', execution: 'agent', depends_on: [] } },
};

/** The RECORD_KEEPS_MODEL_ATTEMPTS cases of the TCK, against `store`. */
function lawOf(store: InMemoryStore) {
  const cases = runStoreFidelityContract({ store, definition: wf, stepName: 's' }).filter(
    (c) => c.law === 'RECORD_KEEPS_MODEL_ATTEMPTS',
  );
  expect(cases, 'fixture: the law has four cases, none skipped on this store').toHaveLength(4);
  expect(cases.filter((c) => c.skipped === true)).toHaveLength(0);
  return cases;
}

/** Runs every case of `cases`; returns the message of each that failed. */
async function failuresOf(cases: ReturnType<typeof lawOf>): Promise<string[]> {
  const failed: string[] = [];
  for (const c of cases) {
    try {
      await c.run();
    } catch (err) {
      failed.push(`${c.name}: ${(err as Error).message}`);
    }
  }
  return failed;
}

type Entry = { model_attempts?: ModelAttempt[] };

/** `record` with `edit` applied to each evidence entry and each drive-failure entry. */
function eachEntry(record: RunRecord, edit: <E extends Entry>(entry: E) => E): RunRecord {
  const ring = record.drive_failures;
  return {
    ...record,
    evidence: record.evidence.map(edit),
    ...(ring !== undefined ? { drive_failures: { ...ring, entries: ring.entries.map(edit) } } : {}),
  };
}

describe('gap 2, unit (i-a) — RECORD_KEEPS_MODEL_ATTEMPTS', () => {
  it('passes for InMemoryStore, which keeps the field on both entries', async () => {
    // (a) red when the shipped store or its listing drops the field; (b) prints each case's message.
    expect(await failuresOf(lawOf(new InMemoryStore()))).toEqual([]);
  });

  it('REJECTS a store that drops model_attempts on update', async () => {
    class DropsIt extends InMemoryStore {
      override update(record: RunRecord): Promise<Snapshot> {
        return super.update(
          eachEntry(record, (entry) => {
            const { model_attempts: _gone, ...rest } = entry;
            return rest as typeof entry;
          }),
        );
      }
    }
    // (a) red when the law reads back neither entry's field; (b) prints which cases passed.
    const failed = await failuresOf(lawOf(new DropsIt()));
    expect(failed.map((f) => f.split(':')[0])).toEqual([
      'an evidence entry and a drive-failure entry written with model_attempts read back from get with it unchanged',
      'an update that keeps both entries model_attempts unchanged is accepted, and both still read back with it',
      'a listing keeps model_attempts on the evidence entry and the drive-failure entry, as get reads it',
    ]);
    for (const f of failed) expect(f).toMatch(/RECORD_KEEPS_MODEL_ATTEMPTS/);
  });

  it('REJECTS a store that drops model_attempts from the drive-failure entry only', async () => {
    class DropsTheFailures extends InMemoryStore {
      override update(record: RunRecord): Promise<Snapshot> {
        const ring = record.drive_failures;
        return super.update(
          ring === undefined
            ? record
            : {
                ...record,
                drive_failures: {
                  ...ring,
                  entries: ring.entries.map(({ model_attempts: _gone, ...rest }) => rest),
                },
              },
        );
      }
    }
    // (a) red when the law compares only the evidence entry; (b) prints the case's message.
    const failed = await failuresOf(lawOf(new DropsTheFailures()));
    expect(failed[0]).toMatch(/absent \(drive failure\)/);
  });

  it('REJECTS a store that makes a list up on entries written without it', async () => {
    class MakesOneUp extends InMemoryStore {
      override update(record: RunRecord): Promise<Snapshot> {
        return super.update(
          eachEntry(record, (entry) =>
            entry.model_attempts === undefined ? { ...entry, model_attempts: [] } : entry,
          ),
        );
      }
    }
    // (a) red when the law reads only the entries written with the field; (b) prints the message.
    const failed = await failuresOf(lawOf(new MakesOneUp()));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatch(/without it/);
  });
});
