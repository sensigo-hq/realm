// trace-buffer-store-fenced.contract.test.ts — issue #616 PR-1b B5: the published fenced
// trace-buffer contract, run against the SQLite trace buffer: the first store that checks its fence
// inside its own transaction (`fenceForm: 'in-transaction'`). The real case: a trace buffer whose
// fence check broke (skipped, or evaluated after the step's lines are read) passes its own suite but
// must fail the contract a third-party store is held to.
//
// The adapter writes the runs the store fences against where the store reads them: on a second
// connection to the home's file (`openForeignConnection`), one `BEGIN IMMEDIATE` + `insertRunRecord`
// + `COMMIT` per run. The cases this form cannot run come as skips (`skipped: true`), registered
// with the runner's own skip; each is covered by the store's own suite or by B6 (the table in the
// prompt, `sqlite-616-b5-fenced-contract-in-transaction.md`). No byte hooks: a byte count computed
// from the store's own rows would restate the store's own formula.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowError, type RunRecord } from '@sensigo/realm';
import {
  fencedTraceBufferContract,
  fenceTestRun,
  FENCED_TRACE_BUFFER_LAWS,
  type FenceRunControl,
  type FencedTraceBufferContractAdapter,
  type FencedTraceBufferLaw,
} from '@sensigo/realm-testing';
import { describe, expect, it } from 'vitest';
import type { DatabaseLike } from './driver.js';
import { openRealmHome, type RealmHome } from './open-realm-home.js';
import { insertRunRecord } from './run-rows.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

/**
 * The laws of this contract that THIS file deliberately does not run, each with its reason
 * (issue #625). Empty: the SQLite trace buffer declares the fenced trio and both capability-ladder
 * rungs; the cases its form cannot run are skips the contract itself marks.
 */
const NOT_RUN: Partial<Record<FencedTraceBufferLaw, string>> = {};

/** The laws this file runs: every exported law, minus the ones named in NOT_RUN above. */
const LAWS: readonly FencedTraceBufferLaw[] = FENCED_TRACE_BUFFER_LAWS.filter(
  (law) => !(law in NOT_RUN),
);

/**
 * The contract's run control on a second connection: `put` writes a run in its stored form in one
 * transaction of its own; `remove` has nothing to remove for an id never put. The contract puts each
 * id at most once and removes only ids it never put (AUD-B5-14), so a second put of one id, and a
 * remove of an id that was put (a live run cannot be deleted), throw naming the id.
 */
function fenceRunsOn(conn: DatabaseLike): Omit<FenceRunControl, 'readCount'> {
  const put = new Set<string>();
  return {
    put: (run: RunRecord) => {
      if (put.has(run.id)) {
        throw new Error(`fenceRuns.put: the run ${run.id} was already put; it is put only once`);
      }
      conn.exec('BEGIN IMMEDIATE');
      try {
        insertRunRecord(conn, run);
        conn.exec('COMMIT');
      } catch (err) {
        // The connection must not keep the write lock (SEAMS, the unit 10 block).
        if (conn.isTransaction) conn.exec('ROLLBACK');
        throw err;
      }
      put.add(run.id);
    },
    remove: (runId: string) => {
      if (put.has(runId)) {
        throw new Error(
          `fenceRuns.remove: the run ${runId} was put, and a live run cannot be deleted`,
        );
      }
      // Never put: no row exists.
    },
  };
}

interface Opened {
  readonly adapter: FencedTraceBufferContractAdapter;
  readonly cleanup: () => void;
}

/** A fresh home, its trace buffer and the second connection the runs are written on. */
async function makeAdapter(): Promise<Opened> {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-b5-fenced-'));
  const home = join(dir, '.realm');
  let handle: RealmHome | undefined;
  let conn: DatabaseLike | undefined;
  const cleanup = (): void => {
    try {
      conn?.close();
    } finally {
      try {
        handle?.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  };
  try {
    handle = await openRealmHome({ home });
    conn = await openForeignConnection(home);
  } catch (err) {
    cleanup();
    throw err;
  }
  return {
    adapter: {
      store: handle.traceBufferStore,
      fenceRuns: fenceRunsOn(conn),
      makeKey: () => ({ runId: randomUUID(), stepId: 'fenced-tck-step' }),
      fenceForm: 'in-transaction',
    },
    cleanup,
  };
}

/** The cases as this adapter builds them, read when the tests are registered: which laws have a
 *  case to run, and which cases are skips. Never run (each law runs on its own fresh home). */
const REGISTERED = await (async () => {
  const { adapter, cleanup } = await makeAdapter();
  try {
    return fencedTraceBufferContract(adapter);
  } finally {
    cleanup();
  }
})();

describe('SqliteTraceBufferStore — the fenced trace-buffer contract, in its own transaction (#616 PR-1b B5)', () => {
  for (const law of LAWS) {
    // A skipped case is registered with the runner's own skip, so it is counted as a skip, never
    // inside a passing law. A law is left out only when it has a case and every one is skipped; a
    // law with no case at all keeps its test, which fails naming it.
    const ofLaw = REGISTERED.filter((c) => c.law === law);
    for (const c of ofLaw) if (c.skipped === true) it.skip(c.name, () => {});
    if (ofLaw.length > 0 && ofLaw.every((c) => c.skipped === true)) continue;
    it(law, async () => {
      // A fresh home per law, as the JSON wiring uses a fresh folder.
      const { adapter, cleanup } = await makeAdapter();
      try {
        const matching = fencedTraceBufferContract(adapter).filter((c) => c.law === law);
        // (1) red when the contract builds no case for this law (it would vanish from the run);
        //     (2) prints the law's name.
        expect(matching.length, `no cases registered for law ${law}`).toBeGreaterThan(0);
        // Each case throws naming what differed; (1) red when the store breaks the law the case
        // states (e.g. a fence skipped, or evaluated after the step's lines are read).
        for (const c of matching) {
          if (c.skipped !== true) await c.run();
        }
      } finally {
        cleanup();
      }
    });
  }

  it('registers exactly the 17 cases an in-transaction store without byte hooks cannot run, by the field', async () => {
    const { adapter, cleanup } = await makeAdapter();
    try {
      const skipped = fencedTraceBufferContract(adapter)
        .filter((c) => c.skipped === true)
        .map((c) => c.name);
      const park =
        "an in-transaction store has no injected run read to park — its own suite races its transaction's lock";
      const held =
        'an in-transaction store has no injected run read to park — its own suite holds its lock';
      const latch =
        'an in-transaction store has no injected run read to park — TCK-green does NOT verify ' +
        "race closure; the store's own in-transaction fencing suite must (issue #207; the same " +
        "posture CLAIM_SINGLE_OWNER's own cross-host caveat states, issue #188)";
      // (1) red when the skip cases lose their field (none found), or a case this form can run
      //     becomes a skip (an extra name), or one it cannot run stops being one (a missing name);
      //     (2) prints the skipped cases' names.
      expect(skipped.sort()).toEqual(
        [
          // FENCE_DATA's racers: covered by B6 (a second process changes the run mid-write).
          `SKIPPED — ${park}: step_open_for_trace RACER (appendFenced)`,
          `SKIPPED — ${park}: run_absent RACER (deleteAllForRunFenced)`,
          `SKIPPED — ${park}: run_absent_or_terminal RACER (deleteAllForRunFenced)`,
          `SKIPPED — ${park}: run_at_version RACER (deleteFenced)`,
          `SKIPPED — ${park}: run_at_version RACER (sealFenced)`,
          `SKIPPED — ${park}: step_not_in_progress RACER (sealFenced)`,
          `SKIPPED — ${park}: step_not_in_progress RACER (deleteFenced)`,
          // MALFORMED while the key is held: covered by B4's check 6a.
          `SKIPPED — ${held}: MALFORMED while the key is held (a function in place of the fence)`,
          `SKIPPED — ${held}: MALFORMED while the key is held (null in place of the fence)`,
          `SKIPPED — ${held}: MALFORMED while the key is held (an unknown kind)`,
          `SKIPPED — ${held}: MALFORMED while the key is held (a step member on the run-wide method)`,
          // A failing run read: covered by B4's check 7.
          "SKIPPED — an in-transaction store has no injected run read to fail — its own suite must exercise a failing in-transaction run read: deleteAllForRunFenced: a fence run read throwing FsIoError propagates it exactly — never mistaken for deleteIfExists's own failure and wrapped",
          // The latch laws: B4's checks 1 (NO_SILENT_LOSS) and 6b (CS_OCCUPANCY); B6's
          // concurrent-writers leg (PER_KEY_INDEPENDENCE).
          `SKIPPED — ${latch}: holding the CS: concurrent read/delete/deleteAllForRun neither succeed during occupancy nor corrupt state after release`,
          `SKIPPED — ${latch}: a disjoint-run key completes a full append+read round-trip while another key is latched open`,
          `SKIPPED — ${latch}: a settle (read-then-delete) starting while append is parked adopts the full committed batch`,
          // No byte hooks: B4's check 3; the shape-tolerant VERBATIM case runs.
          'SKIPPED — adapter did not supply bytesOracle (count-based assertions above still ran): byte-exactness against an adapter-supplied oracle',
          'SKIPPED — adapter did not supply rawWalAccess (the shape-tolerant sibling case above still ran): byte-for-byte raw comparison against an adapter-supplied rawWalAccess hook',
        ].sort(),
      );
    } finally {
      cleanup();
    }
  });

  it("a put whose insert is refused leaves the adapter's connection usable: the next put lands", async () => {
    const { adapter, cleanup } = await makeAdapter();
    try {
      const refused = randomUUID();
      const next = randomUUID();
      // insertRunRecord's own refusal, inside the put's BEGIN IMMEDIATE: evidence not an array.
      let first: unknown;
      try {
        adapter.fenceRuns.put(fenceTestRun(refused, { evidence: 'not an array' as never }));
      } catch (err) {
        first = err;
      }
      let second: unknown = 'landed';
      try {
        adapter.fenceRuns.put(fenceTestRun(next));
      } catch (err) {
        second = err instanceof Error ? err.message : String(err);
      }
      // The store sees the run the second put wrote: its `run_absent` fence refuses.
      let seen: unknown;
      try {
        await adapter.store.deleteAllForRunFenced!(next, { kind: 'run_absent' });
        seen = 'not refused';
      } catch (err) {
        seen = err instanceof WorkflowError ? err.code : String(err);
      }
      // (1) red when `put` does not roll back on a throw: its connection keeps the transaction
      //     open and the next put fails "cannot start a transaction within a transaction";
      //     (2) prints the first refusal, what the second put gave, and what the store saw.
      expect({
        first: first instanceof Error ? first.message : String(first),
        second,
        seen,
      }).toEqual({
        first: `Run ${refused} is not a run record: its evidence is not an array.`,
        second: 'landed',
        seen: 'STATE_RUN_RESURRECTED',
      });
    } finally {
      cleanup();
    }
  });
});
