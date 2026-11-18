// held-lease-cw3a.test.ts — #729 CW-3a (prompt feat-729-cw3a-held-state-lease.md items 1, 2, 5, 6;
// checks 3, 5 and the lease rows of the held state): a held step's state reads its claim's lease
// before its deadline, as CW-1b's claim classifier does. `InMemoryStore` with the lease double makes
// every lease fact a real store's port can answer (held, not held) and the two it cannot be made to
// answer on demand (absent: no lease file; unknown: a probe that could not tell), each claim written
// as a store writes it and judged at the store's own reading. The SQLite cells (checks 1, 2, 4, 6, 7)
// are cli's and mcp-server's.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { InMemoryStore, createLeaseDouble, settableClock } from '@sensigo/realm-testing';
import type { LeaseDoubleState } from '@sensigo/realm-testing';
import {
  HELD_WORDS,
  composeWaysAt,
  heldStateOf,
  reclaimConditionWords,
  type Unavailable,
} from './ways.js';
import { reclaimStep } from './reclaim-step.js';
import { isIdleForCleanup } from './claim-liveness.js';
import { classifyRunHealth } from './run-health.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { ClaimRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '../workflow/yaml-loader.js';

const AT = Date.parse('2031-04-05T06:07:08.000Z');
const iso = (ms: number): string => new Date(AT + ms).toISOString();
const SINCE = iso(-1_200_000);
const PAST = iso(-60_000);
const AHEAD = iso(60_000);

/** `a` an engine step not declared idempotent. */
const DEF: WorkflowDefinition = {
  id: 'held-lease-cw3a',
  name: 'held-lease-cw3a',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { a: { description: 'a', execution: 'auto', depends_on: [] } },
} as WorkflowDefinition;

/** The lease double's state for each lease fact this unit reads. */
const LEASE: Record<string, LeaseDoubleState> = {
  held: 'live',
  not_held: 'closed_kept',
  absent: 'removed',
  unknown: { forced: { state: 'unknown', basis: 'kernel_lock', reason: 'cannot_open' } },
};

/** A run whose step `a` is held by another program's claim under the lease `L` (or none). */
async function leased(
  lease: LeaseDoubleState | undefined,
  deadline: string | null = null,
): Promise<{ store: InMemoryStore; runId: string; clock: ReturnType<typeof settableClock> }> {
  const double = createLeaseDouble();
  if (lease !== undefined) double.set('L', lease);
  const clock = settableClock(new Date(AT));
  const store = new InMemoryStore({ clock, leases: double });
  const { record } = await store.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
  const claim: ClaimRecord = {
    deadline,
    token: 'other',
    since: SINCE,
    ...(lease !== undefined ? { lease: { id: 'L' } } : {}),
  };
  await store.update({ ...record, in_progress_steps: ['a'], claims: { a: claim } });
  return { store, runId: record.id, clock };
}

/** The held entry and the reclaim way offered for `a`, composed at the store's reading. */
async function composed(store: InMemoryStore, runId: string) {
  const snap = await store.get(runId);
  const ways = composeWaysAt(snap.record, snap.at, {
    definition: DEF,
    persistsClaims: true,
    lease_facts: snap.lease_facts,
  });
  const entry = ways.unavailable.find(
    (u): u is Unavailable & { code: 'held_elsewhere' } =>
      u.verb === 'run_step' && u.code === 'held_elsewhere',
  )!;
  const way = ways.ways.find((w) => w.verb === 'reclaim');
  return { entry, way };
}

describe('#729 CW-3a — item 1: the held state reads the lease first', () => {
  it('held → lease_held, not held → lease_not_held, absent and unknown → unknown_age, whatever the deadline; an unleased claim as on main', async () => {
    const states: Record<string, string> = {};
    for (const [fact, lease] of Object.entries(LEASE)) {
      for (const [label, deadline] of [
        ['no deadline', null],
        ['past', PAST],
        ['ahead', AHEAD],
      ] as const) {
        const { store, runId } = await leased(lease, deadline);
        const { entry } = await composed(store, runId);
        states[`${fact}/${label}`] = heldStateOf(entry).state;
      }
    }
    for (const [label, deadline] of [
      ['no deadline', null],
      ['past', PAST],
      ['ahead', AHEAD],
    ] as const) {
      const { store, runId } = await leased(undefined, deadline);
      states[`unleased/${label}`] = heldStateOf((await composed(store, runId)).entry).state;
    }
    // (a) red when a leased claim is classed by its deadline, a lease that cannot be checked is read
    //     as held or not held, or an unleased claim is classed by a lease; (b) prints every state.
    expect(states).toEqual({
      'held/no deadline': 'lease_held',
      'held/past': 'lease_held',
      'held/ahead': 'lease_held',
      'not_held/no deadline': 'lease_not_held',
      'not_held/past': 'lease_not_held',
      'not_held/ahead': 'lease_not_held',
      'absent/no deadline': 'unknown_age',
      'absent/past': 'unknown_age',
      'absent/ahead': 'unknown_age',
      'unknown/no deadline': 'unknown_age',
      'unknown/past': 'unknown_age',
      'unknown/ahead': 'unknown_age',
      'unleased/no deadline': 'unknown_age',
      'unleased/past': 'past',
      'unleased/ahead': 'ahead',
    });
  });
});

describe('#729 CW-3a — item 2: the reclaim way’s conditions, and the fence', () => {
  it('lease_held: its condition first and the stamp; lease_not_held: no claim-age condition; absent/unknown: override_claim_unknown_age; a lease state sets no until', async () => {
    const out: Record<string, unknown> = {};
    for (const fact of ['held', 'not_held', 'absent'] as const) {
      const { store, runId } = await leased(LEASE[fact], PAST);
      const { entry, way } = await composed(store, runId);
      out[fact] = {
        conditions: way?.conditions.map((c) => c.code),
        stamp: way?.verb === 'reclaim' ? way.claimed_at : undefined,
        clears_at: entry.clears_at ?? null,
      };
    }
    // (a) red when a held lease is offered without its condition, a lease no program held keeps a
    //     claim-age condition, or a lease state sets `clears_at` (an `until`); (b) prints each way.
    expect(out).toEqual({
      held: { conditions: ['lease_held', 'rerun_not_idempotent'], stamp: SINCE, clears_at: null },
      not_held: { conditions: ['rerun_not_idempotent'], stamp: SINCE, clears_at: null },
      absent: {
        conditions: ['override_claim_unknown_age', 'rerun_not_idempotent'],
        stamp: SINCE,
        clears_at: null,
      },
    });
  });

  it('check 3: absent and unknown, with no deadline and with one stamped past — refused without the stamp (fence_required), freed with it', async () => {
    const out: Record<string, unknown> = {};
    for (const fact of ['absent', 'unknown'] as const) {
      for (const [label, deadline] of [
        ['no deadline', null],
        ['stamped past', PAST],
      ] as const) {
        const { store, runId } = await leased(LEASE[fact], deadline);
        const refused = await reclaimStep(store, runId, 'a', { force: true, definition: DEF }).then(
          () => 'freed',
          (err: unknown) => (err instanceof WorkflowError ? err.refusal?.code : String(err)),
        );
        const freed = await reclaimStep(store, runId, 'a', {
          force: true,
          definition: DEF,
          claimed_at: SINCE,
        });
        out[`${fact}/${label}`] = {
          refused,
          freed: freed.outcome,
          discharged: freed.conditionsDischarged?.map((c) => c.code),
        };
      }
    }
    // (a) red when a lease that cannot be checked is read as held (lease_held's condition), or by
    //     its deadline (the stamped-past one then freed by the old form, with no claim-age
    //     condition); (b) prints each claim's answers.
    const answer = {
      refused: 'fence_required',
      freed: 'reclaimed',
      discharged: ['override_claim_unknown_age', 'rerun_not_idempotent'],
    };
    expect(out).toEqual({
      'absent/no deadline': answer,
      'absent/stamped past': answer,
      'unknown/no deadline': answer,
      'unknown/stamped past': answer,
    });
  });

  it('lease_held needs the stamp and records lease_held as discharged; lease_not_held is freed with the old form', async () => {
    const held = await leased(LEASE['held']);
    const refused = await reclaimStep(held.store, held.runId, 'a', {
      force: true,
      definition: DEF,
    }).then(
      () => 'freed',
      (err: unknown) => (err instanceof WorkflowError ? err.refusal?.code : String(err)),
    );
    await reclaimStep(held.store, held.runId, 'a', {
      force: true,
      definition: DEF,
      claimed_at: SINCE,
    });
    const record = (await held.store.get(held.runId)).record.evidence.at(-1)?.output_summary;
    const notHeld = await leased(LEASE['not_held']);
    const old = await reclaimStep(notHeld.store, notHeld.runId, 'a', {
      force: true,
      definition: DEF,
    });
    // (a) red when a held lease is freed without its stamp, `lease_held` is missing from the record,
    //     or a lease no program held needs the stamp; (b) prints the answers and the record.
    expect({
      refused,
      discharged: (record?.['conditions_discharged'] as Array<{ code: string }>).map((c) => c.code),
      prior: record?.['prior_state'],
      notHeld: old.outcome,
    }).toEqual({
      refused: 'fence_required',
      discharged: ['lease_held', 'rerun_not_idempotent'],
      prior: 'healthy',
      notHeld: 'reclaimed',
    });
  });
});

describe('#729 CW-3a — item 6 (check 5, core): cleanup and run-health', () => {
  it('cleanup keeps a run whose leased claim is held, absent or unknown, and sweeps one not held', async () => {
    const out: Record<string, boolean> = {};
    for (const fact of Object.keys(LEASE)) {
      const { store, runId, clock } = await leased(LEASE[fact]);
      await clock.set(new Date(AT + 3_600_000));
      out[fact] = isIdleForCleanup(await store.get(runId), 60_000);
    }
    // (a) red when a lease that cannot be checked is swept (the old rule: only healthy kept), or
    //     every leased claim is kept; (b) prints each verdict.
    expect(out).toEqual({ held: false, not_held: true, absent: false, unknown: false });
  });

  it('run-health: a not-held, absent or unknown leased claim’s finding carries the lease fact', async () => {
    const out: Record<string, unknown> = {};
    for (const fact of ['not_held', 'absent', 'unknown'] as const) {
      const { store, runId } = await leased(LEASE[fact]);
      const finding = classifyRunHealth(await store.get(runId)).find((f) => f.step === 'a');
      out[fact] = (finding?.evidence as { lease?: { state: string } } | undefined)?.lease?.state;
    }
    // (a) red when the evidence drops the lease; (b) prints each finding's lease state.
    expect(out).toEqual({ not_held: 'not_held', absent: 'absent', unknown: 'unknown' });
  });
});

describe('#729 CW-3a — item 5: the words, each meaning what its deadline twin means', () => {
  it('the lease_held condition, the not-held lead line, and each table’s two lease rows', () => {
    // (a) red when a lease state's words change or lose their twin's meaning; (b) prints them all.
    expect({
      condition: reclaimConditionWords({ code: 'lease_held' }),
      notHeld: HELD_WORDS.notHeldLine,
      lead: [
        HELD_WORDS.leadLine({ state: 'lease_not_held' }),
        HELD_WORDS.leadLine({ state: 'lease_held' }),
      ],
      agent: [
        HELD_WORDS.agent('lease_held', "'a'", false, undefined),
        HELD_WORDS.agent('lease_held', "'a', 'b'", true, undefined),
        HELD_WORDS.agent('lease_not_held', "'a'", false, undefined),
        HELD_WORDS.agent('lease_not_held', "'a', 'b'", true, undefined),
      ],
      reason: [
        HELD_WORDS.reason({ state: 'lease_held' }),
        HELD_WORDS.reason({ state: 'lease_not_held' }),
      ],
      clause: [HELD_WORDS.clause('lease_held'), HELD_WORDS.clause('lease_not_held')],
      cli: [HELD_WORDS.cli('lease_held', 'a', SINCE), HELD_WORDS.cli('lease_not_held', 'a', SINCE)],
    }).toEqual({
      condition:
        "Its program held the claim's lease when it was checked; if that program is still running, the step runs twice.",
      notHeld:
        "No program held the claim's lease when it was checked; no result is recorded for it.",
      lead: [
        "No program held the claim's lease when it was checked; no result is recorded for it.",
        undefined,
      ],
      agent: [
        "'a' is held; its program held the claim's lease when it was checked. Wait for it. A person can free it, but if that program is still running, the step runs twice.",
        "'a', 'b' are held; their programs held the claims' leases when they were checked. Wait for them. A person can free them, but if a program is still running, its step runs twice.",
        "'a' was claimed, and no program held the claim's lease when it was checked; no result is recorded for it. Tell the user: a person can free it.",
        "'a', 'b' were claimed, and no program held their claims' leases when they were checked; no result is recorded for them. Tell the user: a person can free them.",
      ],
      reason: [
        "it is held; its program held the claim's lease when it was checked",
        "it was claimed, and no program held the claim's lease when it was checked; no result is recorded for it",
      ],
      clause: [
        ' — a person can free it, but if its program is still running, the step runs twice',
        ' — a person can free it',
      ],
      cli: [
        "'a' is held; wait for it.",
        "'a' was claimed, and no program held the claim's lease when it was checked; no result is recorded for it.",
      ],
    });
  });
});
