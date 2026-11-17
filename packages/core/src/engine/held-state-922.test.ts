// held-state-922.test.ts — #922 P1a (prompt fix-922-p1-reclaim-way.md items 1, 2, 4, 5; checks 5, 6,
// 12): a held step's state at `as_of`, the facts it is read from, the reclaim way each held step
// carries with the conditions that hold, a store that keeps no claims, the composition with no
// definition, a leased claim, and OFFER_EQUALS_ADMISSION (R26) for `reclaim` through `admitWay`.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: step
// names, states, codes and condition codes — never a token.
import { describe, it, expect } from 'vitest';
import {
  admitWay,
  composeWaysOn,
  heldFacts,
  heldStateAt,
  heldStateOf,
  type Cond,
  type Unavailable,
  type WayOn,
  type WaysContext,
} from './ways.js';
import { writtenSnapshot } from './snapshot.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';

const AT = new Date('2030-01-01T12:00:00.000Z');
const plus = (ms: number): string => new Date(AT.getTime() + ms).toISOString();
const SINCE = plus(-3_600_000);

/** `a` declared idempotent, `b` not; both agent steps with no dependencies. */
const DEF: WorkflowDefinition = {
  id: 'held-922',
  name: 'held-922',
  version: 1,
  steps: {
    a: { description: 'a', execution: 'agent', depends_on: [], idempotent: true },
    b: { description: 'b', execution: 'agent', depends_on: [] },
  },
} as WorkflowDefinition;

/** A run with `held` in progress and `claims` its claim records. */
function runWith(held: readonly string[], claims: Record<string, unknown> = {}): RunRecord {
  return {
    id: 'r',
    workflow_id: DEF.id,
    params: {},
    completed_steps: [],
    in_progress_steps: [...held],
    failed_steps: [],
    skipped_steps: [],
    evidence: [],
    terminal_state: false,
    claims,
  } as unknown as RunRecord;
}

function ctx(over: Partial<WaysContext> = {}): WaysContext {
  return {
    definition: { ok: DEF },
    enactor: { kind: 'observer' },
    store: { persistsClaims: true },
    ...over,
  };
}

/** Every claim shape a held step can have, by name. */
const CLAIMS: Record<string, unknown> = {
  ahead: { deadline: plus(90_000), token: 't', since: SINCE },
  past: { deadline: plus(-90_000), token: 't', since: SINCE },
  at_deadline: { deadline: AT.toISOString(), token: 't', since: SINCE },
  no_deadline: { deadline: null, token: 't', since: SINCE },
  unreadable: { deadline: 'not a time', token: 't', since: SINCE },
  not_stamped: { deadline: plus(90_000), token: 't' },
  no_claim_record: undefined,
};

const condKeys = (conditions: readonly Cond[]): string[] =>
  conditions.map((c) =>
    c.code === 'override_claim_unknown_age'
      ? `${c.code}:${c.state}`
      : c.code === 'rerun_not_idempotent'
        ? `${c.code}:${c.basis}`
        : c.code === 'claim_deadline_ahead'
          ? `${c.code}:${c.deadline === plus(90_000) ? 'the deadline' : c.deadline}`
          : c.code,
  );

describe('#922 P1a — a held step’s state, its facts and clears_at (items 1, 2)', () => {
  it('one state per claim shape at as_of; clears_at set exactly when the deadline is ahead; the entry face agrees', () => {
    const seen = Object.entries(CLAIMS).map(([name, claim]) => {
      const record = runWith(['a'], claim === undefined ? {} : { a: claim });
      const snap = writtenSnapshot(record, AT);
      const facts = heldFacts(snap, 'a');
      const entry = composeWaysOn(snap, ctx()).unavailable.find(
        (u): u is Extract<Unavailable, { code: 'held_elsewhere' }> =>
          u.code === 'held_elsewhere' && u.verb === 'run_step',
      )!;
      return {
        name,
        state: heldStateAt(facts, AT).state,
        face: heldStateOf(entry).state,
        claimed_at: typeof facts.claimed_at === 'string' ? 'stamp' : facts.claimed_at.absent,
        deadline: typeof facts.deadline === 'string' ? 'stamp' : facts.deadline.absent,
        clears_at: entry.clears_at ?? null,
      };
    });
    // (a) red when clears_at is set for a past deadline (or one at as_of: past means ≥), the
    //     unreadable stamp reads as no deadline, the claim's stamp is dropped, or the entry face
    //     disagrees with the state at as_of; (b) prints each shape's state, face, stamps and clears_at.
    expect(seen).toEqual([
      {
        name: 'ahead',
        state: 'ahead',
        face: 'ahead',
        claimed_at: 'stamp',
        deadline: 'stamp',
        clears_at: plus(90_000),
      },
      {
        name: 'past',
        state: 'past',
        face: 'past',
        claimed_at: 'stamp',
        deadline: 'stamp',
        clears_at: null,
      },
      {
        name: 'at_deadline',
        state: 'past',
        face: 'past',
        claimed_at: 'stamp',
        deadline: 'stamp',
        clears_at: null,
      },
      {
        name: 'no_deadline',
        state: 'unknown_age',
        face: 'unknown_age',
        claimed_at: 'stamp',
        deadline: 'unknown_age',
        clears_at: null,
      },
      {
        name: 'unreadable',
        state: 'unreadable',
        face: 'unreadable',
        claimed_at: 'stamp',
        deadline: 'unparseable_stamp',
        clears_at: null,
      },
      {
        name: 'not_stamped',
        state: 'ahead',
        face: 'ahead',
        claimed_at: 'not_stamped',
        deadline: 'stamp',
        clears_at: plus(90_000),
      },
      {
        name: 'no_claim_record',
        state: 'no_claim_record',
        face: 'no_claim_record',
        claimed_at: 'no_claim_record',
        deadline: 'unknown_age',
        clears_at: null,
      },
    ]);
  });

  it('check 5 — a leased claim (CW-2a: no deadline, a lease) is classed by its deadline, never by its lease', () => {
    const leased = runWith(['a'], {
      a: { deadline: null, token: 't', since: SINCE, lease: { id: 'l-1' } },
    });
    const leasedAhead = runWith(['a'], {
      a: { deadline: plus(90_000), token: 't', since: SINCE, lease: { id: 'l-1' } },
    });
    // (a) red when the lease is read here (CW-3 adds the lease states in this one place); (b) prints
    //     both states. Residual (D4 decision 1, trigger CW-3): on a leased claim the reply rule and
    //     `stuck_claims` can disagree until CW-3.
    expect([
      heldStateAt(heldFacts(writtenSnapshot(leased, AT), 'a'), AT).state,
      heldStateAt(heldFacts(writtenSnapshot(leasedAhead, AT), 'a'), AT).state,
    ]).toEqual(['unknown_age', 'ahead']);
  });
});

describe('#922 P1a — the reclaim way (item 4): one per held step, its conditions by state', () => {
  it('every held state × idempotent or not: the conditions that hold, the stamp when the claim has one', () => {
    const seen: Record<string, unknown> = {};
    for (const [name, claim] of Object.entries(CLAIMS)) {
      for (const step of ['a', 'b']) {
        const record = runWith([step], claim === undefined ? {} : { [step]: claim });
        const composed = composeWaysOn(writtenSnapshot(record, AT), ctx());
        const ways = composed.ways.filter((w) => w.verb === 'reclaim');
        const way = ways[0] as Extract<WayOn, { verb: 'reclaim' }> | undefined;
        const held = composed.unavailable.find(
          (u) => u.code === 'held_elsewhere' && u.verb === 'run_step',
        );
        seen[`${name}/${step}`] = {
          ways: ways.length,
          conditions: way !== undefined ? condKeys(way.conditions) : null,
          stamped: way?.claimed_at !== undefined,
          remedy: held?.remedy.map((w) => w.verb),
          no_remedy: held?.no_remedy?.cause ?? null,
        };
      }
    }
    const nd = 'rerun_not_idempotent:not_declared';
    const row = (conditions: string[], stamped: boolean) => ({
      ways: 1,
      conditions,
      stamped,
      remedy: ['reclaim'],
      no_remedy: null,
    });
    // (a) red when a condition is missing from the offer (or one is added where it does not hold),
    //     the way is not each held entry's remedy, or the stamp is dropped from a stamped claim;
    //     (b) prints each state × step's conditions, stamp and the entry's remedy.
    expect(seen).toEqual({
      'ahead/a': row(['claim_deadline_ahead:the deadline'], true),
      'ahead/b': row(['claim_deadline_ahead:the deadline', nd], true),
      'past/a': row([], true),
      'past/b': row([nd], true),
      'at_deadline/a': row([], true),
      'at_deadline/b': row([nd], true),
      'no_deadline/a': row(['override_claim_unknown_age:unknown_age'], true),
      'no_deadline/b': row(['override_claim_unknown_age:unknown_age', nd], true),
      'unreadable/a': row(['override_claim_unknown_age:unreadable'], true),
      'unreadable/b': row(['override_claim_unknown_age:unreadable', nd], true),
      'not_stamped/a': row(['claim_deadline_ahead:the deadline'], false),
      'not_stamped/b': row(['claim_deadline_ahead:the deadline', nd], false),
      'no_claim_record/a': row(['override_claim_unknown_age:no_claim_record'], false),
      'no_claim_record/b': row(['override_claim_unknown_age:no_claim_record', nd], false),
    });
  });

  it('several held steps: one way each, keyed by step, past → unknown → ahead', () => {
    const record = runWith(['a', 'b', 'c'], {
      a: CLAIMS['ahead'],
      b: CLAIMS['no_deadline'],
      c: CLAIMS['past'],
    });
    const def = {
      ...DEF,
      steps: { ...DEF.steps, c: { description: 'c', execution: 'agent', depends_on: [] } },
    } as WorkflowDefinition;
    const composed = composeWaysOn(writtenSnapshot(record, AT), ctx({ definition: { ok: def } }));
    // (a) red when the order is dropped or a step gets two ways; (b) prints the steps in order.
    expect(composed.ways.flatMap((w) => (w.verb === 'reclaim' ? [w.step] : []))).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('check 12 — a store that keeps no claims: no reclaim way, store_keeps_no_claims listed, the held entry keeps another_program_holds_it', () => {
    const record = runWith(['a'], { a: CLAIMS['ahead'] });
    const composed = composeWaysOn(
      writtenSnapshot(record, AT),
      ctx({ store: { persistsClaims: false } }),
    );
    const held = composed.unavailable.find(
      (u) => u.code === 'held_elsewhere' && u.verb === 'run_step',
    );
    // (a) red when the way is offered on a store that cannot free it, or nothing says why;
    //     (b) prints the reclaim ways, the listed entry and the held entry's act.
    expect({
      ways: composed.ways.filter((w) => w.verb === 'reclaim').length,
      listed: composed.unavailable
        .filter((u) => u.verb === 'reclaim')
        .map((u) => `${u.code}:${u.step}:${u.remedy.length}`),
      held: [held?.remedy.length, held?.no_remedy?.cause],
    }).toEqual({
      ways: 0,
      listed: ['store_keeps_no_claims:a:0'],
      held: [0, 'another_program_holds_it'],
    });
  });

  it('check 12 (m-I) — the composition with no definition: each held step’s reclaim way, its rerun not known (definition_absent) beside its state’s own condition; the open gate’s step is not offered', () => {
    const record = {
      ...runWith(['a', 'q'], { a: CLAIMS['no_deadline'], q: CLAIMS['ahead'] }),
      pending_gate: {
        gate_id: 'g1',
        step_name: 'q',
        choices: ['approve', 'reject'],
        opened_at: SINCE,
      },
    } as unknown as RunRecord;
    const composed = composeWaysOn(writtenSnapshot(record, AT), {
      definition: { absent: 'not_registered', workflow_id: DEF.id },
      enactor: { kind: 'observer' },
      store: { persistsClaims: true },
    });
    // (a) red when the definition-absent path offers no reclaim (reclaim would then need the
    //     definition), drops definition_absent, or offers the open gate's own step; (b) prints the
    //     ways' steps and conditions.
    expect(
      composed.ways.flatMap((w) =>
        w.verb === 'reclaim' ? [[w.step, ...condKeys(w.conditions)]] : [],
      ),
    ).toEqual([
      ['a', 'override_claim_unknown_age:unknown_age', 'rerun_not_idempotent:definition_absent'],
    ]);
  });
});

describe('#922 P1a — check 6: OFFER_EQUALS_ADMISSION (R26) for reclaim, through admitWay', () => {
  /** Every held state × idempotent or not × the definition present, absent, or lacking the name ×
   *  a store that keeps claims or not. */
  function cases(): { name: string; record: RunRecord; ctx: WaysContext; steps: string[] }[] {
    const out: { name: string; record: RunRecord; ctx: WaysContext; steps: string[] }[] = [];
    const renamed = { ...DEF, steps: { b: DEF.steps['b']! } } as WorkflowDefinition;
    const definitions: [string, WaysContext['definition']][] = [
      ['present', { ok: DEF }],
      ['absent', { absent: 'not_registered', workflow_id: DEF.id }],
      ['lacks a', { ok: renamed }],
    ];
    for (const [claimName, claim] of Object.entries(CLAIMS)) {
      for (const step of ['a', 'b']) {
        for (const [defName, definition] of definitions) {
          for (const persistsClaims of [true, false]) {
            out.push({
              name: `${claimName}/${step}/${defName}/${persistsClaims ? 'claims' : 'no claims'}`,
              record: runWith([step], claim === undefined ? {} : { [step]: claim }),
              ctx: ctx({ definition, store: { persistsClaims } }),
              steps: [step, step === 'a' ? 'b' : 'a', 'zz'],
            });
          }
        }
      }
    }
    return out;
  }

  it('each offered reclaim is admitted as offered (its stamp, force: true); every input not offered is refused', () => {
    const found: string[] = [];
    let offeredCount = 0;
    for (const c of cases()) {
      const snap = writtenSnapshot(c.record, AT);
      const composed = composeWaysOn(snap, c.ctx);
      const offered = composed.ways.filter(
        (w): w is Extract<WayOn, { verb: 'reclaim' }> => w.verb === 'reclaim',
      );
      offeredCount += offered.length;
      for (const way of offered) {
        const input = {
          run_id: way.run_id,
          step: way.step,
          force: true,
          ...(way.claimed_at !== undefined ? { claimed_at: way.claimed_at } : {}),
        };
        if (!('ok' in admitWay('reclaim', snap, c.ctx, input))) {
          found.push(`${c.name}: offered ${way.step} refused`);
        }
      }
      const since = (step: string): string | undefined =>
        (c.record.claims?.[step] as { since?: string } | undefined)?.since;
      for (const step of c.steps) {
        const stamps = [undefined, since(step), '1999-01-01T00:00:00.000Z'];
        for (const stamp of stamps) {
          const input = {
            run_id: c.record.id,
            step,
            force: true,
            ...(stamp !== undefined ? { claimed_at: stamp } : {}),
          };
          const admitted = 'ok' in admitWay('reclaim', snap, c.ctx, input);
          const isOffered = offered.some((w) => w.step === step && w.claimed_at === stamp);
          // a stamped way is offered with its stamp; with no stamp it is admitted only where no
          // fence applies (the deadline passed) — that input is then the old form, admitted too
          const fenceFree = offered.some(
            (w) =>
              w.step === step &&
              stamp === undefined &&
              !w.conditions.some(
                (k) => k.code === 'claim_deadline_ahead' || k.code === 'override_claim_unknown_age',
              ),
          );
          if (admitted && !isOffered && !fenceFree) {
            found.push(`${c.name}: ${step} stamp ${stamp ?? 'none'} admitted, not offered`);
          }
          // correction 1: `force` other than `true` discharges nothing — out of contract, on `force`
          const unforced = admitWay('reclaim', snap, c.ctx, { ...input, force: false });
          if ('ok' in unforced || unforced.code !== 'argument_out_of_contract') {
            found.push(`${c.name}: ${step} stamp ${stamp ?? 'none'} force false not refused`);
          } else if (
            unforced.code === 'argument_out_of_contract' &&
            unforced.facts.arg !== 'force'
          ) {
            found.push(`${c.name}: ${step} force false refused on ${unforced.facts.arg}`);
          }
        }
      }
    }
    // (a) red when the judge admits an input the composer does not offer (or refuses one it does),
    //     on any state, definition or store, or admits `force: false`; (b) prints the case, the
    //     step and the stamp.
    expect(found).toEqual([]);
    // the witness is not vacuous: the stores that keep claims offer one way per held step
    expect(offeredCount).toBe(Object.keys(CLAIMS).length * 2 * 3);
  });
});
