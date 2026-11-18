// reclaim-judge-922.test.ts — #922 P1b (prompt fix-922-p1-reclaim-way.md items 6, 7, 8; checks 6, 7, 8,
// 9): `reclaimStep`'s judged path — a call passing `force: true` is judged by JUDGE.reclaim at the
// write, in the prompt's order; every refusal but `not_held` is thrown with `refusal`; a stamp passed
// fences the reclaim to the claim it was shown, across a write race too; the reclaim record names the
// conditions discharged; and a call without the new members behaves exactly as before #922.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: codes,
// outcomes, steps and condition codes — never a token.
import { describe, it, expect } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import { reclaimStep, type ReclaimStepOptions } from './reclaim-step.js';
import { abandonRun } from './abandon-run.js';
import { composeWaysOn, type Cond, type WayOn, type WaysContext } from './ways.js';
import { WorkflowError } from '../types/workflow-error.js';
import { declared } from '../test-support/declared.js';
import { noSettle } from '../test-support/snapshot-double.js';
import type { RunStore } from '../store/store-interface.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const plus = (ms: number): string => new Date(Date.now() + ms).toISOString();
const SINCE = new Date(Date.now() - 3_600_000).toISOString();
const WRONG = '1999-01-01T00:00:00.000Z';

/** `a` declared idempotent, `b` not, `q` the step a question waits on; all agent steps. */
const DEF: WorkflowDefinition = {
  id: 'judge-922',
  name: 'judge-922',
  version: 1,
  steps: {
    a: { description: 'a', execution: 'agent', depends_on: [], idempotent: true },
    b: { description: 'b', execution: 'agent', depends_on: [] },
    q: { description: 'q', execution: 'agent', depends_on: [] },
  },
} as WorkflowDefinition;

/** Every claim shape a held step can have (as in held-state-922.test.ts). */
const CLAIMS: Record<string, unknown> = {
  ahead: { deadline: plus(90_000), token: 't', since: SINCE },
  past: { deadline: plus(-90_000), token: 't', since: SINCE },
  no_deadline: { deadline: null, token: 't', since: SINCE },
  unreadable: { deadline: 'not a time', token: 't', since: SINCE },
  not_stamped: { deadline: plus(90_000), token: 't' },
  no_claim_record: undefined,
};

/** A run in a fresh store with `held` in progress, each with its claim. */
async function runWith(
  held: Record<string, unknown>,
  extra: Partial<RunRecord> = {},
): Promise<{ store: InMemoryStore; id: string }> {
  const store = new InMemoryStore();
  const { record } = await store.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
  const claims: Record<string, unknown> = {};
  for (const [step, claim] of Object.entries(held)) if (claim !== undefined) claims[step] = claim;
  await store.update({
    ...record,
    in_progress_steps: Object.keys(held),
    claims: claims as NonNullable<RunRecord['claims']>,
    ...extra,
  });
  return { store, id: record.id };
}

/** A store that reads and writes `inner` but keeps no claims. */
function keepsNoClaims(inner: InMemoryStore): RunStore {
  return declared({
    clock: inner.clock,
    settleStep: noSettle,
    persistsClaims: false,
    get: (id: string) => inner.get(id),
    update: (r: RunRecord) => inner.update(r),
  } as unknown as RunStore);
}

/** The judged refusal a call throws: its error code, the refusal's code and facts; or its outcome. */
async function verdictOf(
  store: RunStore,
  id: string,
  step: string,
  options: ReclaimStepOptions,
): Promise<Record<string, unknown>> {
  try {
    const r = await reclaimStep(store, id, step, options);
    return {
      outcome: r.outcome,
      ...(r.conditionsDischarged ? { discharged: codes(r.conditionsDischarged) } : {}),
    };
  } catch (err) {
    if (!(err instanceof WorkflowError)) throw err;
    return {
      error: err.code,
      refusal: err.refusal?.code ?? null,
      facts: err.refusal?.facts ?? null,
      remedy: (err.remedy ?? []).map((w) => w.verb),
      message: err.message,
    };
  }
}

const codes = (conditions: readonly Cond[]): string[] =>
  conditions.map((c) =>
    c.code === 'rerun_not_idempotent'
      ? `${c.code}:${c.basis}`
      : c.code === 'override_claim_unknown_age'
        ? `${c.code}:${c.state}`
        : c.code,
  );

describe('#922 P1b — check 7: the judge’s order and codes, through reclaimStep (force: true)', () => {
  it('one cell per refusal: its code, facts, act and words; not_held returned, never thrown', async () => {
    const judged: ReclaimStepOptions = { force: true, definition: DEF };
    const seen: Record<string, unknown> = {};

    const notAStep = await runWith({ a: CLAIMS['ahead'] });
    seen['not_a_step'] = await verdictOf(notAStep.store, notAStep.id, 'zz', judged);

    const notHeld = await runWith({});
    seen['not_held'] = await verdictOf(notHeld.store, notHeld.id, 'a', judged);

    const gated = await runWith({ q: CLAIMS['ahead'] }, {
      pending_gate: {
        gate_id: 'g1',
        step_name: 'q',
        choices: ['approve', 'reject'],
        opened_at: SINCE,
      },
    } as Partial<RunRecord>);
    seen['gated_step'] = await verdictOf(gated.store, gated.id, 'q', {
      ...judged,
      claimed_at: SINCE,
    });

    const noClaims = await runWith({ a: CLAIMS['ahead'] });
    seen['store_keeps_no_claims'] = await verdictOf(
      keepsNoClaims(noClaims.store),
      noClaims.id,
      'a',
      judged,
    );

    const fenced = await runWith({ b: CLAIMS['ahead'] });
    seen['fence_required'] = await verdictOf(fenced.store, fenced.id, 'b', judged);

    const changed = await runWith({ b: CLAIMS['ahead'] });
    seen['claim_changed'] = await verdictOf(changed.store, changed.id, 'b', {
      ...judged,
      claimed_at: WRONG,
    });

    const unstampedChanged = await runWith({ b: CLAIMS['not_stamped'] });
    seen['claim_changed, a stamp for an unstamped claim'] = await verdictOf(
      unstampedChanged.store,
      unstampedChanged.id,
      'b',
      { ...judged, claimed_at: WRONG },
    );

    const ended = await runWith({ a: CLAIMS['ahead'] });
    await abandonRun(ended.store, ended.id, 'ended for the cell');
    seen['run_ended'] = await verdictOf(ended.store, ended.id, 'a', judged);

    // (a) red when a refusal is coded, worded or acted on otherwise, `not_held` is thrown, or the
    //     order moves (a stamped open-gate step reading fence_required); (b) prints each verdict.
    expect(seen).toEqual({
      not_a_step: {
        error: 'STATE_TRANSITION_DENIED',
        refusal: 'not_a_step',
        facts: { step: 'zz', workflow_id: DEF.id },
        // the run's progress ways (its agent steps b and q, offered); the inspect way only when none
        remedy: ['run_step', 'run_step'],
        message: "Step 'zz' is not a step of workflow 'judge-922'; nothing was reclaimed.",
      },
      not_held: { outcome: 'no_active_claim' },
      gated_step: {
        error: 'STATE_TRANSITION_DENIED',
        refusal: 'gated_step',
        facts: { step: 'q', gate_id: 'g1', choices: ['approve', 'reject'] },
        remedy: ['respond'],
        message: `Step 'q' is the open gate on run '${gated.id}'; its claim is held by the open question, which is answered, not reclaimed.`,
      },
      store_keeps_no_claims: {
        error: 'STATE_TRANSITION_DENIED',
        refusal: 'store_keeps_no_claims',
        facts: { step: 'a' },
        remedy: [],
        message: "This store keeps no claim records, so 'a' cannot be freed by reclaim.",
      },
      fence_required: {
        error: 'STATE_TRANSITION_DENIED',
        refusal: 'fence_required',
        facts: { step: 'b', current_claimed_at: SINCE },
        remedy: ['reclaim'],
        message: `Step 'b' is claimed since ${SINCE}.`,
      },
      claim_changed: {
        error: 'STATE_TRANSITION_DENIED',
        refusal: 'claim_changed',
        facts: { step: 'b', offered_claimed_at: WRONG, current_claimed_at: SINCE },
        remedy: ['inspect'],
        message: `Step 'b' is claimed since ${SINCE}, not since ${WRONG} as the command says; nothing was removed.`,
      },
      'claim_changed, a stamp for an unstamped claim': {
        error: 'STATE_TRANSITION_DENIED',
        refusal: 'claim_changed',
        facts: {
          step: 'b',
          offered_claimed_at: WRONG,
          current_claimed_at: { absent: 'not_stamped' },
        },
        remedy: ['inspect'],
        message: `Step 'b' is held by a claim with no stamp, not since ${WRONG} as the command says; nothing was removed.`,
      },
      run_ended: {
        error: 'STATE_RUN_TERMINAL',
        refusal: 'run_ended',
        facts: { phase: 'abandoned' },
        remedy: [],
        message: `Run '${ended.id}' is terminal (abandoned); a terminal run has no reclaimable claim.`,
      },
    });
  });

  it('a step in progress is judged as held even when the definition lacks its name (renamed since): reclaimed, its rerun not declared idempotent', async () => {
    const renamed = { ...DEF, steps: { b: DEF.steps['b']! } } as WorkflowDefinition;
    const { store, id } = await runWith({ a: CLAIMS['past'] });
    // (a) red when not_a_step is judged before the held check (the step then cannot be freed at
    //     all); (b) prints the verdict.
    expect(await verdictOf(store, id, 'a', { force: true, definition: renamed })).toEqual({
      outcome: 'reclaimed',
      discharged: ['rerun_not_idempotent:not_declared'],
    });
  });

  it('ARGS: a new member without force: true is refused before anything is read (VALIDATION_OPTION_INVALID)', async () => {
    const { store, id } = await runWith({ a: CLAIMS['past'] });
    const refused = async (options: Record<string, unknown>) => {
      try {
        await reclaimStep(store, id, 'a', options as ReclaimStepOptions);
        return 'admitted';
      } catch (err) {
        return err instanceof WorkflowError ? err.code : String(err);
      }
    };
    // (a) red when a member reaches the judge (or the old path) without `force: true`, or `force`
    //     other than true is taken as a judged call; (b) prints each code.
    expect({
      definition: await refused({ definition: DEF }),
      claimed_at: await refused({ claimed_at: SINCE }),
      force_false: await refused({ force: false }),
      force_false_with_stamp: await refused({ force: false, claimed_at: SINCE }),
      still_held: (await store.get(id)).record.in_progress_steps,
    }).toEqual({
      definition: 'VALIDATION_OPTION_INVALID',
      claimed_at: 'VALIDATION_OPTION_INVALID',
      force_false: 'VALIDATION_OPTION_INVALID',
      force_false_with_stamp: 'VALIDATION_OPTION_INVALID',
      still_held: ['a'],
    });
  });
});

/** `inner`, whose first update is preceded by another writer's `change` to the stored run. */
function raced(
  inner: InMemoryStore,
  change: (r: RunRecord) => RunRecord,
): {
  store: RunStore;
  updates: () => number;
} {
  let calls = 0;
  const store = declared({
    clock: inner.clock,
    settleStep: noSettle,
    persistsClaims: true,
    get: (id: string) => inner.get(id),
    update: async (r: RunRecord) => {
      calls += 1;
      if (calls === 1) {
        const { record } = await inner.get(r.id);
        await inner.update(change(record));
      }
      return inner.update(r);
    },
  } as unknown as RunStore);
  return { store, updates: () => calls };
}

describe('#922 P1b — check 8: the fence holds across a write race (the CAS re-judge)', () => {
  it('the claim re-taken between the read and the write: claim_changed, nothing removed', async () => {
    const { store: inner, id } = await runWith({ b: CLAIMS['ahead'] });
    const retaken = plus(-1_000);
    const { store, updates } = raced(inner, (r) => ({
      ...r,
      claims: { ...r.claims, b: { deadline: plus(120_000), token: 'another', since: retaken } },
    }));
    const verdict = await verdictOf(store, id, 'b', {
      force: true,
      definition: DEF,
      claimed_at: SINCE,
    });
    const { record } = await inner.get(id);
    // (a) red when the re-read is not judged (the new claim is then freed); (b) prints the verdict,
    //     whether the claim is still there, and the writes tried.
    expect({
      refusal: verdict['refusal'],
      held: record.in_progress_steps,
      since: record.claims?.['b']?.since,
      updates: updates(),
    }).toEqual({ refusal: 'claim_changed', held: ['b'], since: retaken, updates: 1 });
  });

  it('the same claim after another write to the run: its conditions judged again, then reclaimed once', async () => {
    const { store: inner, id } = await runWith({ b: CLAIMS['ahead'] });
    const { store, updates } = raced(inner, (r) => ({ ...r, params: { touched: true } }));
    const verdict = await verdictOf(store, id, 'b', {
      force: true,
      definition: DEF,
      claimed_at: SINCE,
    });
    // (a) red when a mismatch with the same stamp gives up, or re-applies more than once;
    //     (b) prints the verdict and the writes tried.
    expect({ verdict, updates: updates() }).toEqual({
      verdict: {
        outcome: 'reclaimed',
        discharged: ['claim_deadline_ahead', 'rerun_not_idempotent:not_declared'],
      },
      updates: 2,
    });
  });

  it('a call that passed no stamp, met by a stamped claim inside its window on the re-read: taken_over, nothing removed', async () => {
    const { store: inner, id } = await runWith({ b: CLAIMS['past'] });
    const { store } = raced(inner, (r) => ({
      ...r,
      claims: {
        ...r.claims,
        b: { deadline: plus(120_000), token: 'another', since: plus(-1_000) },
      },
    }));
    const verdict = await verdictOf(store, id, 'b', { force: true, definition: DEF });
    // (a) red when the call frees a claim it was never shown; (b) prints the verdict and the claim.
    expect({
      outcome: verdict['outcome'],
      held: (await inner.get(id)).record.in_progress_steps,
    }).toEqual({ outcome: 'taken_over', held: ['b'] });
  });
});

describe('#922 P1b — check 9 (the library): a call without the new members behaves as before #922', () => {
  it('every claim shape: reclaimed as before, and its audit entry carries exactly the old fields; a judged call’s carries the conditions it discharged', async () => {
    const seen: Record<string, unknown> = {};
    for (const [name, claim] of Object.entries(CLAIMS)) {
      const { store, id } = await runWith({ b: claim });
      const old = await reclaimStep(store, id, 'b');
      const entry = (await store.get(id)).record.evidence.at(-1)!;
      seen[name] = { outcome: old.outcome, keys: Object.keys(entry.output_summary) };
    }
    const judged = await runWith({ b: CLAIMS['ahead'] });
    await reclaimStep(judged.store, judged.id, 'b', {
      force: true,
      definition: DEF,
      claimed_at: SINCE,
    });
    const judgedEntry = (await judged.store.get(judged.id)).record.evidence.at(-1)!;
    const OLD = ['reclaimed', 'reason', 'prior_state', 'prior_deadline', 'reclaimed_at'];
    // (a) red when the new refusals reach an old call (a stamped claim inside its window then
    //     refused), the old entry gains a field, or the judged entry loses `conditions_discharged`;
    //     (b) prints each outcome and the entry's keys.
    expect({ seen, judged: judgedEntry.output_summary['conditions_discharged'] }).toEqual({
      seen: Object.fromEntries(
        Object.keys(CLAIMS).map((name) => [name, { outcome: 'reclaimed', keys: OLD }]),
      ),
      judged: [
        {
          code: 'claim_deadline_ahead',
          deadline: (CLAIMS['ahead'] as { deadline: string }).deadline,
        },
        { code: 'rerun_not_idempotent', basis: 'not_declared' },
      ],
    });
  });

  it('an old call keeps its order: a store that keeps no claims is refused before the run is read', async () => {
    let reads = 0;
    const fake = declared({
      clock: new InMemoryStore().clock,
      settleStep: noSettle,
      persistsClaims: false,
      get: async () => {
        reads += 1;
        throw new Error('read');
      },
    } as unknown as RunStore);
    const message = await reclaimStep(fake, 'r', 'a').catch((e: Error) => e.message);
    // (a) red when an old call reads first (the judge's order); (b) prints the message and reads.
    expect({ message, reads }).toEqual({
      message: 'Store does not persist claims; liveness recovery is unavailable on this store.',
      reads: 0,
    });
  });
});

describe('#922 P1b — check 6 through reclaimStep: each offered reclaim is admitted as offered', () => {
  it('every held state × idempotent or not × definition present, absent or lacking the name × claims kept or not', async () => {
    const renamed = { ...DEF, steps: { q: DEF.steps['q']! } } as WorkflowDefinition;
    const definitions: [string, WorkflowDefinition | undefined][] = [
      ['present', DEF],
      ['absent', undefined],
      ['lacks the step', renamed],
    ];
    const found: string[] = [];
    let admitted = 0;
    for (const [claimName, claim] of Object.entries(CLAIMS)) {
      for (const step of ['a', 'b']) {
        for (const [defName, definition] of definitions) {
          for (const keeps of [true, false]) {
            const name = `${claimName}/${step}/${defName}/${keeps ? 'claims' : 'no claims'}`;
            const ctx: WaysContext = {
              definition:
                definition !== undefined
                  ? { ok: definition }
                  : { absent: 'not_registered', workflow_id: DEF.id },
              enactor: { kind: 'observer' },
              store: { persistsClaims: keeps },
            };
            const probe = await runWith({ [step]: claim });
            const offered = composeWaysOn(await probe.store.get(probe.id), ctx).ways.filter(
              (w): w is Extract<WayOn, { verb: 'reclaim' }> => w.verb === 'reclaim',
            );
            const base: ReclaimStepOptions = {
              force: true,
              ...(definition !== undefined ? { definition } : {}),
            };
            for (const way of offered) {
              const run = await runWith({ [step]: claim });
              const store = keeps ? run.store : keepsNoClaims(run.store);
              const v = await verdictOf(store, run.id, way.step, {
                ...base,
                ...(way.claimed_at !== undefined ? { claimed_at: way.claimed_at } : {}),
              });
              if (v['outcome'] !== 'reclaimed')
                found.push(`${name}: offered, refused ${String(v['refusal'])}`);
              else if (JSON.stringify(v['discharged']) !== JSON.stringify(codes(way.conditions))) {
                found.push(
                  `${name}: discharged ${String(v['discharged'])}, offered ${codes(way.conditions).join(',')}`,
                );
              } else admitted += 1;
            }
            // the inputs not offered: a wrong stamp always; no stamp where the claim is stamped and
            // inside its window or of unknown age; anything on a store that keeps no claims
            const refusedInputs: ReclaimStepOptions[] = [{ ...base, claimed_at: WRONG }];
            if (
              offered.some(
                (w) =>
                  w.claimed_at !== undefined &&
                  w.conditions.some((c) => c.code !== 'rerun_not_idempotent'),
              )
            ) {
              refusedInputs.push(base);
            }
            if (!keeps) refusedInputs.push(base);
            for (const input of refusedInputs) {
              const run = await runWith({ [step]: claim });
              const store = keeps ? run.store : keepsNoClaims(run.store);
              const v = await verdictOf(store, run.id, step, input);
              if (v['outcome'] === 'reclaimed') {
                found.push(`${name}: ${input.claimed_at ?? 'no stamp'} not offered, reclaimed`);
              }
            }
          }
        }
      }
    }
    // (a) red when reclaimStep refuses what the composer offers, discharges other conditions, or
    //     frees what is not offered; (b) prints the case and what happened.
    expect(found).toEqual([]);
    // not vacuous: a store that keeps claims offers one reclaim per held step
    expect(admitted).toBe(Object.keys(CLAIMS).length * 2 * 3);
  });
});
