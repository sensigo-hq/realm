// cleanup-judge-715b.test.ts — issue #715 (b) 02 §B.3 (D6-9, D6-41) with MA 3's Amendment 11:
// `realm run cleanup` selects by ONE core judge, `isIdleForCleanup`, of one snapshot — and a claim is
// stale AT its deadline (`classifyClaim` through `isPastDeadline`, `at ≥ deadline`).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import { classifyClaim, isIdleForCleanup } from './claim-liveness.js';
import { writtenSnapshot } from './snapshot.js';
import type { RunRecord } from '../types/run-record.js';

const AT = Date.parse('2031-05-06T07:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

const run = (over: Partial<RunRecord>): RunRecord =>
  ({
    id: 'r1',
    workflow_id: 'w',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    terminal_state: false,
    version: 2,
    params: {},
    evidence: [],
    created_at: iso(AT - 3 * DAY),
    updated_at: iso(AT - 2 * DAY),
    ...over,
  }) as RunRecord;

const held = (deadline: string | null): Partial<RunRecord> => ({
  in_progress_steps: ['s'],
  claims: { s: { deadline, token: 't' } } as NonNullable<RunRecord['claims']>,
});

const idle = (r: RunRecord) => isIdleForCleanup(writtenSnapshot(r, new Date(AT)), DAY);

describe('#715 (b) §B.3, Amendment 11 — cleanup’s one judge', () => {
  it('two days idle: a live claim is kept; a stale claim, a claim of unknown age and no claim are swept', () => {
    // (a) red when the judge drops its live-claim exclusion (a naive updated_at comparison abandons a
    //     run under a running program), or stops sweeping stale / unknown-age / unclaimed runs; (b)
    //     prints the four verdicts.
    expect({
      liveClaim: idle(run(held(iso(AT + 60_000)))),
      staleClaim: idle(run(held(iso(AT - 60_000)))),
      unknownAge: idle(run(held(null))),
      noClaim: idle(run({})),
    }).toEqual({ liveClaim: false, staleClaim: true, unknownAge: true, noClaim: true });
  });

  it('a record stamped an hour ahead of the reading has no age yet and is not idle; a younger one is not idle either', () => {
    // (a) red when an age is taken from a stamp ahead of the reading, or the threshold is ignored;
    //     (b) prints both verdicts.
    expect([
      idle(run({ updated_at: iso(AT + 3_600_000) })),
      idle(run({ updated_at: iso(AT - 60_000) })),
    ]).toEqual([false, false]);
  });

  it('classifyClaim: a claim is stale at exactly its deadline, healthy one millisecond before', () => {
    // (a) red when the claim's due test is strict (`>`), not the engine's one (`at ≥ deadline`); (b)
    //     prints both states.
    const claim = { deadline: iso(AT), token: 't' };
    expect([classifyClaim(claim, new Date(AT)), classifyClaim(claim, new Date(AT - 1))]).toEqual([
      'claim_stale',
      'healthy',
    ]);
  });
});
