// code-source-law-828.test.ts — #828 unit 2c (check 7): the store TCK's EVIDENCE_KEEPS_CODE_SOURCE law
// requires a store to keep each evidence entry's `code_source` (which code an attempt chose, or why
// none), field for field, from `get` and from a listing, to accept an update that keeps it unchanged,
// and to add none to an entry written without it. Green against InMemoryStore (the SQLite store runs
// the law in store-sqlite's contract-fidelity-616.test.ts); red against a store written here that
// drops the field, and against one that makes one up.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import type { RunRecord, WorkflowDefinition, Snapshot } from '@sensigo/realm';
import { InMemoryStore } from './in-memory-store.js';
import { runStoreFidelityContract } from './run-store-fidelity-contract.js';

const wf: WorkflowDefinition = {
  id: 'tck-code-source',
  name: 'tck-code-source',
  version: 1,
  steps: { s: { description: 'S.', execution: 'auto', depends_on: [], handler: 'h' } },
};

/** The EVIDENCE_KEEPS_CODE_SOURCE cases of the TCK, against `store`. */
function lawOf(store: InMemoryStore) {
  const cases = runStoreFidelityContract({ store, definition: wf, stepName: 's' }).filter(
    (c) => c.law === 'EVIDENCE_KEEPS_CODE_SOURCE',
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

/** `record` with `edit` applied to each evidence entry. */
function eachEntry(
  record: RunRecord,
  edit: (entry: RunRecord['evidence'][number]) => RunRecord['evidence'][number],
): RunRecord {
  return { ...record, evidence: record.evidence.map(edit) };
}

describe('#828 unit 2c — EVIDENCE_KEEPS_CODE_SOURCE', () => {
  it('passes for InMemoryStore, which keeps the field', async () => {
    // (a) red when the shipped store or its listing drops or changes the field; (b) prints each
    //     case's message.
    expect(await failuresOf(lawOf(new InMemoryStore()))).toEqual([]);
  });

  it('REJECTS a store that drops code_source on update', async () => {
    class DropsIt extends InMemoryStore {
      override update(record: RunRecord): Promise<Snapshot> {
        return super.update(eachEntry(record, ({ code_source: _gone, ...rest }) => rest));
      }
    }
    // (a) red when the law reads the field back nowhere; (b) prints which cases failed.
    const failed = await failuresOf(lawOf(new DropsIt()));
    expect(failed.map((f) => f.split(':')[0])).toEqual([
      'evidence entries written with code_source, one of each form, read back from get with it field for field',
      'an update that keeps the entries code_source unchanged is accepted, and they still read back with it',
      'a listing keeps code_source on each evidence entry, as get reads it',
    ]);
    for (const f of failed) expect(f).toMatch(/EVIDENCE_KEEPS_CODE_SOURCE/);
  });

  it('REJECTS a store that makes a code source up on an entry written without it', async () => {
    class MakesOneUp extends InMemoryStore {
      override update(record: RunRecord): Promise<Snapshot> {
        return super.update(
          eachEntry(record, (entry) =>
            entry.code_source === undefined
              ? { ...entry, code_source: { absent: 'not_looked_up', kind: 'handler', name: 'h' } }
              : entry,
          ),
        );
      }
    }
    // (a) red when the law reads only the entries written with the field; (b) prints the message.
    const failed = await failuresOf(lawOf(new MakesOneUp()));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatch(/without it/);
  });

  it('REJECTS a store that keeps the field but changes one of its keys', async () => {
    class ChangesIt extends InMemoryStore {
      override update(record: RunRecord): Promise<Snapshot> {
        return super.update(
          eachEntry(record, (entry) => {
            const from = (entry.code_source as { from?: Record<string, unknown> } | undefined)
              ?.from;
            return from?.['source'] === 'project'
              ? {
                  ...entry,
                  code_source: {
                    ...entry.code_source!,
                    from: { ...from, via: 'manifest' },
                  } as NonNullable<typeof entry.code_source>,
                }
              : entry;
          }),
        );
      }
    }
    // (a) red when the law compares only that the field is there, not field for field; (b) prints
    //     which cases failed.
    const failed = await failuresOf(lawOf(new ChangesIt()));
    expect(failed.map((f) => f.split(':')[0])).toEqual([
      'evidence entries written with code_source, one of each form, read back from get with it field for field',
      'an update that keeps the entries code_source unchanged is accepted, and they still read back with it',
      'a listing keeps code_source on each evidence entry, as get reads it',
    ]);
  });
});
