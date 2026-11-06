// selectors-715b.test.ts — issue #715 (b) 02 §B.3 (D-26, D6-9, D6-41) with MA 3's Amendment 11: the
// decide-then-write selectors judge each row at its OWN snapshot's reading with the same exported
// core judge every surface uses — never a naive comparison of the record's `updated_at`. One cell per
// selector, built on the case where the two disagree, and a claim whose deadline is unknown is never
// judged stale (the code's word: `claim_unknown_age`). The unanswered-question classifier (V1) is not
// landed (`gate_unanswered` has no code): no selector of it exists, and none is built here.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it, afterEach } from 'vitest';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  advanceRun,
  classifyInProgressClaims,
  writtenSnapshot,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { cleanupRuns } from './cleanup.js';
import { classifyGateExpiry } from './drain.js';
import { sweepExpiredGates } from './listen.js';
import { isPurgeEligible } from './purge.js';
import { isAutoReclaimable } from './reclaim.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const T = Date.parse('2031-05-06T07:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

/** A question `q` (60 s, abort on expiry) beside an agent step `sib`. */
const FAN: WorkflowDefinition = {
  id: 'selectors-715b',
  name: 'selectors-715b',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    q: {
      description: 'Q.',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['approve', 'reject'], timeout_seconds: 60, on_expiry: 'abort' },
    },
    sib: { description: 'Sibling.', execution: 'agent', depends_on: [] },
  },
};

/**
 * The run at T + 70 s: the question opened at T (its deadline T + 60 s) and another program wrote the
 * run at T + 50 s — so the record's `updated_at` is 20 s old, younger than the question's 60 s, while
 * the question itself has expired. A naive "updated_at + timeout" comparison says not yet expired.
 */
async function fanOutPastItsDeadline() {
  const clock = settableClock(new Date(T));
  const store = new InMemoryStore({ clock });
  const { record } = await store.create({ workflowId: FAN.id, workflowVersion: 1, params: {} });
  await advanceRun(store, FAN, { runId: record.id });
  await clock.set(new Date(T + 50_000));
  // Another program writes the run while the question is open (here: an unchanged record re-saved).
  await store.update((await store.get(record.id)).record);
  await clock.set(new Date(T + 70_000));
  return { clock, store, runId: record.id };
}

/** Every handle a cell opened, cleaned after it. */
const homes: TempHome[] = [];
afterEach(async () => {
  for (const t of homes.splice(0)) await t.cleanup();
});

describe('#715 (b) §B.3 — each selector follows its core judge, at the row’s own reading', () => {
  it('drain --expired (classifyGateExpiry): the question is enactable — its deadline passed, though the run was written 20 s ago', async () => {
    // (a) red when the selector judges by the record's updated_at, or at another instant than the
    //     row's; (b) prints the class and the record's age.
    const { store, runId } = await fanOutPastItsDeadline();
    const snap = await store.get(runId);
    expect({
      kind: classifyGateExpiry(snap.record, snap.at).kind,
      updatedAgoMs: snap.at.getTime() - Date.parse(snap.record.updated_at),
    }).toEqual({ kind: 'enactable', updatedAgoMs: 20_000 });
  });

  it('the listen sweeper: it enacts the same question at the row’s reading', async () => {
    // (a) red when the sweep selects by the record's updated_at, or judges at another instant; (b)
    //     prints the sweep's counts and the run's phase.
    const { store, runId } = await fanOutPastItsDeadline();
    const h = await makeTempHome();
    homes.push(h);
    const workflowStore = h.home.workflowStore;
    await workflowStore.register(FAN);
    const swept = await sweepExpiredGates({
      runStore: store,
      workflowStore,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as never);
    const { record } = await store.get(runId);
    expect({ scanned: swept.scanned, enacted: swept.enacted, phase: record.run_phase }).toEqual({
      scanned: 1,
      enacted: 1,
      phase: 'aborted',
    });
  });

  it('cleanup (isIdleForCleanup): two days idle, a live claim is kept and an unclaimed run is swept', async () => {
    // (a) red when cleanup selects by the record's age alone (it abandons a run whose step a live
    //     program holds); (b) prints which runs were selected.
    const clock = settableClock(new Date(T));
    const store = new InMemoryStore({ clock });
    const make = async (claimed: boolean) => {
      const { record } = await store.create({ workflowId: 'w', workflowVersion: 1, params: {} });
      if (!claimed) return record.id;
      await store.update({
        ...record,
        in_progress_steps: ['s'],
        claims: { s: { deadline: iso(T + 3 * DAY), token: 't' } },
      } as RunRecord);
      return record.id;
    };
    const live = await make(true);
    const idle = await make(false);
    await clock.set(new Date(T + 2 * DAY));
    const { affected } = await cleanupRuns({ olderThan: '1d', dryRun: true }, store);
    expect(affected.map((r) => (r.id === live ? 'live' : r.id === idle ? 'idle' : r.id))).toEqual([
      'idle',
    ]);
  });

  it('purge (isPurgeEligible): an ended run whose claim deadline is still ahead is kept, however old its last write; one of unknown age is skipped in a batch, in its own words', () => {
    // (a) red when purge judges by the record's age, or treats an unknown-age claim as stale; (b)
    //     prints the two verdicts.
    const ended = (deadline: string | null) =>
      ({
        id: 'r1',
        workflow_id: 'w',
        workflow_version: 1,
        completed_steps: [],
        in_progress_steps: ['s'],
        failed_steps: ['x'],
        skipped_steps: [],
        run_phase: 'failed',
        terminal_state: true,
        version: 3,
        params: {},
        evidence: [],
        created_at: iso(T - 30 * DAY),
        updated_at: iso(T - 30 * DAY),
        claims: { s: { deadline, token: 't' } },
      }) as unknown as RunRecord;
    const verdict = (deadline: string | null) =>
      isPurgeEligible(writtenSnapshot(ended(deadline), new Date(T)), { explicit: false });
    expect({
      liveClaim: verdict(iso(T + DAY)).eligible,
      unknownAge: verdict(null),
    }).toEqual({
      liveClaim: false,
      unknownAge: {
        eligible: false,
        reason:
          "run carries an indeterminate-age claim on step 's' (no deadline recorded — a runner may or may not still be working it); skipped in batch; run 'realm run purge r1 --force' to purge it explicitly.",
      },
    });
  });

  it('reclaim --all (isAutoReclaimable): a claim past its deadline is old enough by its deadline, though a sibling wrote a second ago; one of unknown age is never reclaimed', () => {
    // (a) red when reclaim measures the claim's age from the record's updated_at, or judges an
    //     unknown-age claim stale; (b) prints both verdicts and the claim states.
    const run = (deadline: string | null) =>
      ({
        id: 'r1',
        terminal_state: false,
        in_progress_steps: ['s'],
        updated_at: iso(T - 1_000),
        claims: { s: { deadline, token: 't' } },
      }) as unknown as RunRecord;
    const judged = (deadline: string | null) => {
      const snap = writtenSnapshot(run(deadline), new Date(T));
      const claim = classifyInProgressClaims(snap)[0]!;
      return {
        state: claim.state,
        reclaim: isAutoReclaimable(
          snap.record,
          claim,
          { description: 's', execution: 'auto', depends_on: [], idempotent: true },
          { olderThanMs: 60_000, at: snap.at },
        ),
      };
    };
    expect({ past: judged(iso(T - 120_000)), unknown: judged(null) }).toEqual({
      past: { state: 'claim_stale', reclaim: true },
      unknown: { state: 'claim_unknown_age', reclaim: false },
    });
  });
});
