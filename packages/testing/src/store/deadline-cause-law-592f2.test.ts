// deadline-cause-law-592f2.test.ts — Q1 (#592) unit f2: the store TCK's CLAIM_KEEPS_DEADLINE_CAUSE law
// requires a store that keeps claims to write why a claim has no time limit (`deadline_absent`) in the
// claim's own write, and no cause beside a string deadline. Green against InMemoryStore (the SQLite
// store runs the law in store-sqlite's contract-fidelity-616.test.ts); red against a store written here
// that strips the field, and against one that writes a cause beside a deadline; skipped, by name, for a
// store that keeps no claims.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import type {
  Attributed,
  LeaseHold,
  RunRecord,
  Snapshot,
  WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore } from './in-memory-store.js';
import { runStoreFidelityContract } from './run-store-fidelity-contract.js';

const wf: WorkflowDefinition = {
  id: 'tck-deadline-cause',
  name: 'tck-deadline-cause',
  version: 1,
  steps: { s: { description: 'S.', execution: 'agent', depends_on: [] } },
};

/** The CLAIM_KEEPS_DEADLINE_CAUSE cases of the TCK, against `store`. */
function lawOf(store: InMemoryStore) {
  return runStoreFidelityContract({ store, definition: wf, stepName: 's' }).filter(
    (c) => c.law === 'CLAIM_KEEPS_DEADLINE_CAUSE',
  );
}

/** Runs every case of `cases`; returns the message of each that failed. */
async function failuresOf(cases: ReturnType<typeof lawOf>): Promise<string[]> {
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

/** `record` with `edit` applied to each of its claims. */
function eachClaim(
  record: RunRecord,
  edit: (
    claim: NonNullable<RunRecord['claims']>[string],
  ) => NonNullable<RunRecord['claims']>[string],
): RunRecord {
  if (record.claims === undefined) return record;
  return {
    ...record,
    claims: Object.fromEntries(Object.entries(record.claims).map(([k, v]) => [k, edit(v)])),
  };
}

describe('Q1 (#592) unit f2 — CLAIM_KEEPS_DEADLINE_CAUSE', () => {
  it('passes for InMemoryStore, which writes the cause: three cases, none skipped', async () => {
    const cases = lawOf(new InMemoryStore());
    // (a) red when the shipped store drops the field or writes it beside a deadline, or the law
    //     loses a case; (b) prints the case names and each failure.
    expect({
      names: cases.map((c) => c.name),
      skipped: cases.filter((c) => c.skipped === true).length,
      failed: await failuresOf(cases),
    }).toEqual({
      names: [
        'a claim on an auto step of a workflow without finalizers carries a string deadline and no deadline_absent — returned and re-read',
        "a claim on an agent step carries deadline null and deadline_absent 'step_not_auto' — returned and re-read",
        "a claim on an auto step of a workflow with a finalizer carries deadline null and deadline_absent 'finalizer_bearing' — returned and re-read",
      ],
      skipped: 0,
      failed: [],
    });
  });

  it('REJECTS a store that strips deadline_absent: each line names the step and the missing cause', async () => {
    class StripsIt extends InMemoryStore {
      override async claimStep(
        runId: string,
        stepName: string,
        definition: WorkflowDefinition,
        claimant?: Attributed,
        hold?: LeaseHold,
      ): Promise<Snapshot> {
        const snap = await super.claimStep(runId, stepName, definition, claimant, hold);
        return {
          ...snap,
          record: eachClaim(snap.record, ({ deadline_absent: _gone, ...rest }) => rest),
        };
      }
    }
    // (a) red when the law's assertion is removed (the stripping store then passes); (b) prints the
    //     failures.
    expect(await failuresOf(lawOf(new StripsIt()))).toEqual([
      "CLAIM_KEEPS_DEADLINE_CAUSE (the returned record): the claim on step 'work' (an agent step) has no time limit and must say why: expected deadline_absent 'step_not_auto', got none",
      "CLAIM_KEEPS_DEADLINE_CAUSE (the returned record): the claim on step 'work' (an auto step of a workflow with a finalizer) has no time limit and must say why: expected deadline_absent 'finalizer_bearing', got none",
    ]);
  });

  it('REJECTS a store that writes a cause beside a deadline', async () => {
    class WritesBoth extends InMemoryStore {
      override async claimStep(
        runId: string,
        stepName: string,
        definition: WorkflowDefinition,
        claimant?: Attributed,
        hold?: LeaseHold,
      ): Promise<Snapshot> {
        const snap = await super.claimStep(runId, stepName, definition, claimant, hold);
        return {
          ...snap,
          record: eachClaim(snap.record, (c) =>
            c.deadline !== null ? { ...c, deadline_absent: 'step_not_auto' } : c,
          ),
        };
      }
    }
    // (a) red when the law stops checking that a deadline comes alone; (b) prints the failures.
    expect(await failuresOf(lawOf(new WritesBoth()))).toEqual([
      'CLAIM_KEEPS_DEADLINE_CAUSE (the returned record): the claim on step \'work\' (an auto step of a workflow without finalizers) has a deadline, so it must carry no deadline_absent (got "step_not_auto")',
    ]);
  });

  it('is skipped, by name, for a store that keeps no claims', () => {
    class KeepsNone extends InMemoryStore {
      override readonly persistsClaims = false;
    }
    const cases = lawOf(new KeepsNone());
    // (a) red when the law runs on a store that keeps no claims, or skips silently; (b) prints the
    //     cases.
    expect(cases.map((c) => ({ name: c.name, skipped: c.skipped }))).toEqual([
      {
        name: "SKIPPED — store does not declare 'persistsClaims': a claim's deadline cause",
        skipped: true,
      },
    ]);
  });
});
