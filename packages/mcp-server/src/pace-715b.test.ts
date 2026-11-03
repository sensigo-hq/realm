// pace-715b.test.ts — issue #715 (b) 03 §C (D6-71, the owner 2026-10-21: "excellent! this is how
// we'lldo it."): "check back" follows the run's next real deadline. One cell per producing branch of
// `paceOf`: an `on_expiry` question (unclamped, clamped to the floor, over the cap), a held claim's
// deadline, a report-only question, an agent-held step, a deadline already past, an unparseable
// instant, no reading. The door cells (that the reply carries what `paceOf` says, at its `as_of`) are
// in `door-627.test.ts` and `docs-pages-625-run-state.test.ts`, re-pinned add-only.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import type { ForWay, Narrowed, Unavailable } from '@sensigo/realm';
import { MCP_POLL_AFTER_MS, POLL_CAP_MS, POLL_FLOOR_MS, paceOf } from './render-reply.js';

const AT = new Date('2030-01-01T00:00:00.000Z');
const plus = (ms: number) => new Date(AT.getTime() + ms).toISOString();

/** A question handed to the person, with its deadline and (when it changes the run) its on_expiry. */
const question = (expires_at?: string, on_expiry?: 'abort' | 'settle_default'): ForWay =>
  ({
    verb: 'respond',
    for: ['asked_person'],
    conditions: [],
    run_id: 'run_1',
    gate_id: 'g1',
    step: 'q',
    choice: { one_of: ['approve', 'reject'] },
    holds: [],
    presented: 'alone',
    ...(expires_at !== undefined ? { expires_at } : {}),
    ...(on_expiry !== undefined ? { on_expiry } : {}),
  }) as unknown as ForWay;

/** A step another program holds, with the claim's deadline. */
const held = (clears_at?: string): Unavailable =>
  ({
    verb: 'run_step',
    code: 'held_elsewhere',
    step: 's',
    ...(clears_at !== undefined ? { clears_at } : {}),
  }) as unknown as Unavailable;

const narrowed = (ways: ForWay[], unavailable: Unavailable[] = []): Narrowed =>
  ({ ways, unavailable, basis: { as_of: AT.toISOString() }, door: {} }) as unknown as Narrowed;

describe('#715 (b) 03 §C — paceOf: the pace from the deadlines after which the run changes', () => {
  it('an on_expiry question 45 s away: poll_after_ms = until − at, unclamped', () => {
    // (a) red when the pace stays the fixed 30 s, or until − at ≠ poll_after_ms; (b) prints the pace.
    expect(paceOf(narrowed([question(plus(45_000), 'abort')]), AT)).toEqual({
      poll_after_ms: 45_000,
      poll_reason: 'gate_expiry',
      until: plus(45_000),
    });
  });

  it('an on_expiry question 200 ms away: the floor', () => {
    // (a) red when the pace goes under the floor; (b) prints the pace.
    expect(paceOf(narrowed([question(plus(200), 'settle_default')]), AT)).toEqual({
      poll_after_ms: POLL_FLOOR_MS,
      poll_reason: 'gate_expiry',
      until: plus(200),
    });
  });

  it('an on_expiry question two days away: the cap — the instant is handed over as until, never a long interval', () => {
    // (a) red when the pace goes over the cap; (b) prints the pace.
    expect(paceOf(narrowed([question(plus(2 * 86_400_000), 'abort')]), AT)).toEqual({
      poll_after_ms: POLL_CAP_MS,
      poll_reason: 'gate_expiry',
      until: plus(2 * 86_400_000),
    });
  });

  it('a held claim’s deadline 90 s away paces; the earlier of a claim and a question wins', () => {
    // (a) red when a claim's deadline does not pace, or the later deadline wins; (b) prints both.
    expect({
      claim: paceOf(narrowed([], [held(plus(90_000))]), AT),
      both: paceOf(narrowed([question(plus(120_000), 'abort')], [held(plus(90_000))]), AT),
    }).toEqual({
      claim: { poll_after_ms: 90_000, poll_reason: 'claim_deadline', until: plus(90_000) },
      both: { poll_after_ms: 90_000, poll_reason: 'claim_deadline', until: plus(90_000) },
    });
  });

  it('a report-only question (no on_expiry) does not pull the pace in: the fixed 30 s, its deadline kept as until', () => {
    // (a) red when a report-only deadline sets the pace, or its until is dropped (the await entry's
    //     "when until passes, tell the user" would point at nothing); (b) prints the pace.
    expect(paceOf(narrowed([question(plus(5_000))]), AT)).toEqual({
      poll_after_ms: MCP_POLL_AFTER_MS,
      poll_reason: 'fixed',
      until: plus(5_000),
    });
  });

  it('an agent-held step (no deadline anywhere): the fixed 30 s, no until', () => {
    // (a) red when a pace or an until is made up; (b) prints the pace.
    expect(paceOf(narrowed([], [held()]), AT)).toEqual({
      poll_after_ms: MCP_POLL_AFTER_MS,
      poll_reason: 'fixed',
    });
  });

  it('a deadline already past is due: the floor (the next call carries it out)', () => {
    // (a) red when a past deadline gives a negative or zero pace, or the fixed 30 s; (b) prints it.
    expect(paceOf(narrowed([question(plus(-10_000), 'abort')]), AT)).toEqual({
      poll_after_ms: POLL_FLOOR_MS,
      poll_reason: 'gate_expiry',
      until: plus(-10_000),
    });
  });

  it('an unparseable deadline paces nothing and is no until: the fixed 30 s', () => {
    // (a) red when a NaN reaches the pace or the text reaches until; (b) prints the pace.
    expect(paceOf(narrowed([question('not a time', 'abort')], [held('also not')]), AT)).toEqual({
      poll_after_ms: MCP_POLL_AFTER_MS,
      poll_reason: 'fixed',
    });
  });

  it('no reading (a reply with no basis): the fixed 30 s, the deadline still named', () => {
    // (a) red when a pace is computed against no reading; (b) prints the pace.
    expect(paceOf(narrowed([question(plus(45_000), 'abort')]), undefined)).toEqual({
      poll_after_ms: MCP_POLL_AFTER_MS,
      poll_reason: 'fixed',
      until: plus(45_000),
    });
  });
});
