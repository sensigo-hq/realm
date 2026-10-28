// in-memory-store-clock-715.test.ts — issue #715 (a) Part B.2, cell B10 (and B11's in-memory half):
// the in-memory store reads its clock ONCE per `create`, `update` and `claimStep` (applied or
// refused), stamps everything that write records from that reading, floors a keyed create by the run
// it supersedes, and — built without a clock — stamps with the wall clock as before. A NEW file: the
// existing `in-memory-store.test.ts` is one of the fidelity-contract files and is not edited.
// Each cell names (a) the change that turns it red and (b) what it prints when it fails: member ids,
// field names, instants and counts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLOCK_SKEW_EPSILON_MS as EPS,
  computeClaimDeadline,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore } from './in-memory-store.js';
import { settableClock, steppingClock } from '../clock/settable-clock.js';

const T = Date.parse('2035-09-10T11:12:13.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const WF = 'wf-715a-mem';
const KEY = 'k-715a-mem';
const AUTO: WorkflowDefinition = {
  id: WF,
  name: 'clock 715a',
  version: 1,
  steps: {
    work: {
      description: 'w',
      execution: 'auto',
      depends_on: [],
      handler: 'h',
      timeout_seconds: 90,
    },
  },
};
const plain = { workflowId: WF, workflowVersion: 1, params: {} };
const keyed = (extra: Record<string, unknown> = {}) => ({
  ...plain,
  idempotencyKey: KEY,
  ...extra,
});

afterEach(() => {
  vi.useRealTimers();
});

async function terminalize(store: InMemoryStore, run: RunRecord): Promise<RunRecord> {
  const fresh = await store.get(run.id);
  return store.update({
    ...fresh,
    run_phase: 'abandoned',
    terminal_state: true,
    abandoned_at: fresh.updated_at,
    sealed_by: { arm: 'abandon_requested' },
    terminal_reason: 'Abandoned via realm run abandon',
  });
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code ?? 'thrown';
  }
  return 'resolved';
}

describe('#715 (a) B10 — readings per member (in-memory store)', () => {
  // (a) red when a member spends two readings, none where it must, or a read gains one;
  // (b) prints the member id and the count.
  it('M1–M6 spend exactly one each (M2 reuse and the refused update and claim included); a missing run, settleStep, stampSeal and reads spend none', async () => {
    const clock = steppingClock(new Date(T), 1_000);
    const store = new InMemoryStore({ clock });
    const delta = (): (() => number) => {
      const before = clock.reads;
      return () => clock.reads - before;
    };
    let d = delta();
    const { run } = await store.create(plain);
    expect(d(), 'M1').toBe(1);
    d = delta();
    const { run: k } = await store.create(keyed());
    expect(d(), 'M4 (unmapped key)').toBe(1);
    d = delta();
    expect((await store.create(keyed())).created, 'M2 reused').toBe(false);
    expect(d(), 'M2').toBe(1);
    await terminalize(store, k);
    d = delta();
    expect((await store.create(keyed({ onTerminalMatch: 'rerun' }))).run.rerun_of, 'M3').toBe(k.id);
    expect(d(), 'M3').toBe(1);
    d = delta();
    await store.update(run);
    expect(d(), 'M5 applied').toBe(1);
    d = delta();
    expect(await code(store.update(run)), 'M5 stale').toBe('STATE_SNAPSHOT_MISMATCH');
    expect(d(), 'M5 refused').toBe(1);
    d = delta();
    expect(await code(store.update({ ...run, id: 'gone' })), 'M5 missing').toBe(
      'STATE_RUN_NOT_FOUND',
    );
    expect(d(), 'M5 missing run').toBe(0);
    d = delta();
    await store.claimStep(run.id, 'work', AUTO);
    expect(d(), 'M6 applied').toBe(1);
    d = delta();
    expect(await code(store.claimStep(run.id, 'work', AUTO)), 'M6 claimed').toBe(
      'STATE_STEP_ALREADY_CLAIMED',
    );
    expect(d(), 'M6 refused').toBe(1);
    d = delta();
    expect(await code(store.claimStep('gone', 'work', AUTO)), 'M6 missing').toBe(
      'STATE_RUN_NOT_FOUND',
    );
    expect(d(), 'M6 missing run').toBe(0);
    d = delta();
    await store.get(run.id);
    await store.list();
    expect(d(), 'M7 get, list').toBe(0);
    // M7: settleStep and stampSeal are unchanged in #715 (a) — #715 (b) moves settleStep onto the
    // store's reading. Correction 1 (C-4): stampSeal stamps a terminal UNSEALED run at its real
    // version, seeded by a direct map insert (the store refuses to write a terminal run without a
    // seal); a stale version or a sealed run would be refused before any stamping code runs.
    const { run: seed } = await store.create({ ...plain, workflowId: 'seed-m7' });
    const unsealed: RunRecord = {
      ...seed,
      completed_steps: ['a'],
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
      run_phase: 'completed',
    };
    store['runs'].set(unsealed.id, unsealed);
    d = delta();
    await store.settleStep(run.id, { kind: 'expire_gate', gateId: 'none' }, AUTO);
    const stamped = await store.stampSeal(
      unsealed.id,
      { arm: 'complete', classified: true },
      unsealed.version,
    );
    expect(stamped.stamped, 'M7 stampSeal stamped the seeded run').toBe(true);
    expect(d(), 'M7 settleStep, stampSeal').toBe(0);
  });
});

describe('#715 (a) B10 — stamps equal the reading; MONOTONE capped; the floor', () => {
  it('every instant a write records equals its reading (M1, M4, M3, M5, M6)', async () => {
    // (a) red when a stamp comes from a second `new Date()`; (b) prints field names and values.
    const clock = settableClock(new Date(T));
    const store = new InMemoryStore({ clock });
    const { run } = await store.create(plain);
    expect([run.created_at, run.updated_at], 'M1').toEqual([iso(T), iso(T)]);
    await clock.set(new Date(T + 1_000));
    const { run: k } = await store.create(keyed());
    expect([k.created_at, k.updated_at], 'M4').toEqual([iso(T + 1_000), iso(T + 1_000)]);
    await terminalize(store, k);
    await clock.set(new Date(T + 2_000));
    const { run: s } = await store.create(keyed({ onTerminalMatch: 'rerun' }));
    expect([s.created_at, s.updated_at], 'M3').toEqual([iso(T + 2_000), iso(T + 2_000)]);
    await clock.set(new Date(T + 3_000));
    expect((await store.update(await store.get(run.id))).updated_at, 'M5').toBe(iso(T + 3_000));
    await clock.set(new Date(T + 4_000));
    const c = await store.claimStep(run.id, 'work', AUTO);
    const expected = computeClaimDeadline(AUTO, 'work', new Date(T + 4_000));
    expect(typeof expected, 'not vacuous').toBe('string');
    expect(
      {
        since: c.claims?.['work']?.since,
        deadline: c.claims?.['work']?.deadline,
        updated_at: c.updated_at,
      },
      'M6',
    ).toEqual({ since: iso(T + 4_000), deadline: expected, updated_at: iso(T + 4_000) });
  });

  it('an update after the clock stepped back behind a stamp: r+ε, r+3 s, or r', async () => {
    // (a) red when the cap or the lift is missing; (b) prints the three results.
    const results: string[] = [];
    for (const lead of [3_600_000, 3_000, -3_600_000]) {
      const clock = settableClock(new Date(T + Math.max(lead, 0)));
      const store = new InMemoryStore({ clock });
      const { run } = await store.create(plain);
      await clock.set(new Date(T));
      results.push((await store.update(run)).updated_at);
    }
    expect(results, 'after +1 h, +3 s, −1 h').toEqual([iso(T + EPS), iso(T + 3_000), iso(T)]);
  });

  it('M3 and M4 order a successor after its holder (a 4 s backward step, a frozen clock), capped at ε', async () => {
    // (a) red when a path stamps without the floor, or without the cap; (b) prints the stamps.
    for (const [label, step] of [
      ['4 s back', -4_000],
      ['frozen', 0],
    ] as const) {
      const clock = settableClock(new Date(T));
      const store = new InMemoryStore({ clock });
      const { run: holder } = await store.create(keyed());
      await terminalize(store, holder);
      await clock.set(new Date(T + step));
      const { run: m3 } = await store.create(keyed({ onTerminalMatch: 'rerun' }));
      expect(m3.created_at, `M3 ${label}: holder ${holder.created_at}`).toBe(iso(T + 1));
      // M4: the mapped run vanished; the key's newest remaining run floors the fresh create.
      store['runs'].delete(m3.id);
      const { run: m4 } = await store.create(keyed({ onTerminalMatch: 'rerun' }));
      expect(m4.created_at, `M4 ${label}: newest ${holder.created_at}`).toBe(iso(T + 1));
    }
    const clock = settableClock(new Date(T + 3_600_000));
    const store = new InMemoryStore({ clock });
    const { run: ahead } = await store.create(keyed());
    await terminalize(store, ahead);
    await clock.set(new Date(T));
    const { run: capped } = await store.create(keyed({ onTerminalMatch: 'rerun' }));
    expect(capped.created_at, `capped: holder ${ahead.created_at}`).toBe(iso(T + EPS));
  });

  it('unkeyed creates at a frozen instant both carry it (never floored)', async () => {
    // (a) red when an unkeyed create is floored; (b) prints the stamps.
    const store = new InMemoryStore({ clock: settableClock(new Date(T)) });
    const a = (await store.create(plain)).run;
    const b = (await store.create(plain)).run;
    expect([a.created_at, b.created_at], 'both').toEqual([iso(T), iso(T)]);
  });
});

describe('#715 (a) B11 — built without a clock, the in-memory store stamps with the wall clock', () => {
  it('create, update and claimStep carry the faked wall instant', async () => {
    // (a) red when the default stops being the system clock; (b) prints the stamp and X.
    const X = Date.now() - 60_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(X);
      const store = new InMemoryStore();
      const { run } = await store.create(plain);
      const updated = await store.update(run);
      const claimed = await store.claimStep(run.id, 'work', AUTO);
      expect(
        [run.created_at, updated.updated_at, claimed.claims?.['work']?.since, claimed.updated_at],
        `X = ${iso(X)}`,
      ).toEqual([iso(X), iso(X), iso(X), iso(X)]);
    } finally {
      vi.useRealTimers();
    }
  });
});
