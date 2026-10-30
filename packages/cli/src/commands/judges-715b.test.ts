// judges-715b.test.ts — issue #715 (b) 02 §A.1 (D6-17, D6-19's rule), the CLI's judges: each gives a
// verdict that DIFFERS between two readings of ONE record around its claim's deadline, so it reads
// the reading it is handed and nothing else. The instants are in 2031, far from the host's clock.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import { writtenSnapshot, type RunRecord } from '@sensigo/realm';
import { isPurgeEligible } from './purge.js';
import { isAutoReclaimable } from './reclaim.js';

const DEADLINE = Date.parse('2031-05-06T07:08:09.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const ENDED = {
  id: 'r1',
  workflow_id: 'w',
  workflow_version: 1,
  completed_steps: [],
  in_progress_steps: ['work'],
  failed_steps: ['other'],
  skipped_steps: [],
  run_phase: 'failed',
  terminal_state: true,
  version: 4,
  params: {},
  evidence: [],
  created_at: iso(DEADLINE - 120_000),
  updated_at: iso(DEADLINE - 60_000),
  claims: { work: { deadline: iso(DEADLINE), token: 't' } },
} as unknown as RunRecord;

describe('#715 (b) §A.1 — the CLI’s judges read the reading they are handed', () => {
  it('isPurgeEligible: an ended run whose claim is still within its deadline is kept; after it, purged', () => {
    // (a) red when the judge reads any instant but the snapshot's (the wall clock gives one verdict
    //     twice); (b) prints both verdicts.
    expect([
      isPurgeEligible(writtenSnapshot(ENDED, new Date(DEADLINE - 1_000)), { explicit: false })
        .eligible,
      isPurgeEligible(writtenSnapshot(ENDED, new Date(DEADLINE + 1_000)), { explicit: false })
        .eligible,
    ]).toEqual([false, true]);
  });

  it('isAutoReclaimable: a stale claim is old enough for --older-than 1m only once its deadline is a minute behind the reading', () => {
    // (a) red when the judge measures the claim's age at another instant; (b) prints both verdicts.
    const live = { ...ENDED, terminal_state: false, run_phase: 'running' } as unknown as RunRecord;
    const claim = { step: 'work', state: 'claim_stale' as const, deadline: iso(DEADLINE) };
    const verdict = (atMs: number) =>
      isAutoReclaimable(
        live,
        claim,
        { description: 'w', execution: 'auto', idempotent: true },
        {
          olderThanMs: 60_000,
          at: new Date(atMs),
        },
      );
    expect([verdict(DEADLINE + 30_000), verdict(DEADLINE + 90_000)]).toEqual([false, true]);
  });
});
