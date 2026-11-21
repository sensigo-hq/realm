// failure-kind-law-g2iia.test.ts — gap 2, unit (ii-a): the store TCK's EVIDENCE_KEEPS_FAILURE_KIND law
// requires a store to keep an evidence entry's `diagnostics.failure_kind` (why a step's failed model
// request failed it), from `get` and from a listing, to accept an update that keeps it unchanged, and
// to add none to an entry written without it. Green against InMemoryStore (the SQLite store runs the
// law in store-sqlite's contract-fidelity-616.test.ts); red against a store written here that drops the
// field, and against one that makes one up.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import type { RunRecord, WorkflowDefinition, Snapshot } from '@sensigo/realm';
import { InMemoryStore } from './in-memory-store.js';
import { runStoreFidelityContract } from './run-store-fidelity-contract.js';

const wf: WorkflowDefinition = {
  id: 'tck-failure-kind',
  name: 'tck-failure-kind',
  version: 1,
  steps: { s: { description: 'S.', execution: 'agent', depends_on: [] } },
};

/** The EVIDENCE_KEEPS_FAILURE_KIND cases of the TCK, against `store`. */
function lawOf(store: InMemoryStore) {
  const cases = runStoreFidelityContract({ store, definition: wf, stepName: 's' }).filter(
    (c) => c.law === 'EVIDENCE_KEEPS_FAILURE_KIND',
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

/** `record` with `edit` applied to each evidence entry's diagnostics. */
function eachDiagnostics(
  record: RunRecord,
  edit: (diag: NonNullable<RunRecord['evidence'][number]['diagnostics']>) => typeof diag,
): RunRecord {
  return {
    ...record,
    evidence: record.evidence.map((e) =>
      e.diagnostics === undefined ? e : { ...e, diagnostics: edit(e.diagnostics) },
    ),
  };
}

describe('gap 2, unit (ii-a) — EVIDENCE_KEEPS_FAILURE_KIND', () => {
  it('passes for InMemoryStore, which keeps the field', async () => {
    // (a) red when the shipped store or its listing drops the field; (b) prints each case's message.
    expect(await failuresOf(lawOf(new InMemoryStore()))).toEqual([]);
  });

  it('REJECTS a store that drops diagnostics.failure_kind on update', async () => {
    class DropsIt extends InMemoryStore {
      override update(record: RunRecord): Promise<Snapshot> {
        return super.update(eachDiagnostics(record, ({ failure_kind: _gone, ...rest }) => rest));
      }
    }
    // (a) red when the law reads the field back nowhere; (b) prints which cases failed.
    const failed = await failuresOf(lawOf(new DropsIt()));
    expect(failed.map((f) => f.split(':')[0])).toEqual([
      'an evidence entry written with diagnostics.failure_kind reads back from get with it unchanged',
      'an update that keeps the entry diagnostics.failure_kind unchanged is accepted, and it still reads back with it',
      'a listing keeps diagnostics.failure_kind on the evidence entry, as get reads it',
    ]);
    for (const f of failed) expect(f).toMatch(/EVIDENCE_KEEPS_FAILURE_KIND/);
  });

  it('REJECTS a store that makes a kind up on an entry written without it', async () => {
    class MakesOneUp extends InMemoryStore {
      override update(record: RunRecord): Promise<Snapshot> {
        return super.update(
          eachDiagnostics(record, (diag) =>
            diag.failure_kind === undefined ? { ...diag, failure_kind: 'transient' } : diag,
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
