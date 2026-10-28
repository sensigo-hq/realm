// json-file-store-clock-715.test.ts — issue #715 (a) Part B (D5 §2.1; D6-3, D6-4, D6-13, D6-14, D6-35,
// D6-51, D6-57, D6-58, D6-60, D6-68): the JSON store reads its clock ONCE per write, after the lock,
// and stamps everything that write records from that one reading; a keyed create is floored by the
// run it supersedes on every create path that has one; `compareCanonical` compares by value.
//
// The controllable clock is a TEST LOCATION's clock file, written by core's own helper beside a temp
// `runs/` folder (core cannot import the testing package); readings are COUNTED with
// `vi.spyOn(store.clock, 'now')`. Every location lives in its own `mkdtemp` root: a clock file is
// never written directly under the system temp folder, where it would sit beside every other test's
// bare temp runs folder.
//
// Each cell names (a) the change that turns it red and (b) what it prints when it fails: member ids,
// field names, instants and counts — never an environment, a path under a real home or a record's
// params.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from './json-file-store.js';
import { writeTestClockFile } from './test-clock-file.js';
import { systemClock } from '../utils/clock.js';
import { computeClaimDeadline } from '../engine/claim-liveness.js';
import { CLOCK_SKEW_EPSILON_MS as EPS } from '../engine/instants.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const T = Date.parse('2031-03-04T05:06:07.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const WF = 'wf-715a';
const KEY = 'k-715a';

/** A single `auto` step, no finalizer: `computeClaimDeadline` is non-null for it. */
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

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Loc {
  root: string;
  runsDir: string;
  store: JsonFileStore;
  set(ms: number): Promise<void>;
}

async function location(startMs: number): Promise<Loc> {
  const root = await mkdtemp(join(tmpdir(), 'realm-715a-'));
  roots.push(root);
  const runsDir = join(root, 'runs');
  await mkdir(runsDir);
  await writeTestClockFile(root, new Date(startMs));
  const store = new JsonFileStore(runsDir);
  return { root, runsDir, store, set: (ms) => writeTestClockFile(root, new Date(ms)) };
}

function pointerPath(runsDir: string, key = KEY): string {
  const hash = createHash('sha256').update(`${WF}\0${key}`).digest('hex');
  return join(runsDir, 'keys', `${hash}.json`);
}

async function readPointer(
  runsDir: string,
  key = KEY,
): Promise<{ run_id: string; updated_at: string }> {
  return JSON.parse(await readFile(pointerPath(runsDir, key), 'utf8')) as {
    run_id: string;
    updated_at: string;
  };
}

const keyed = (extra: Record<string, unknown> = {}) => ({
  workflowId: WF,
  workflowVersion: 1,
  params: {},
  idempotencyKey: KEY,
  ...extra,
});

/** Ends a run the way the supersede journey of #558 PR-C (C-6) does. */
async function terminalize(store: JsonFileStore, run: RunRecord): Promise<RunRecord> {
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

function reads(store: JsonFileStore): { count(): number; reset(): void } {
  const spy = vi.spyOn(store.clock, 'now');
  return { count: () => spy.mock.calls.length, reset: () => spy.mockClear() };
}

async function rejected(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code ?? 'thrown';
  }
  return 'resolved';
}

describe('#715 (a) B1 — readings per member (JSON store)', () => {
  // (a) red when a member spends two readings (today's column), none where it must, or a read gains
  // one; (b) prints the member id and the call count.
  it('J1 an unkeyed create spends exactly one', async () => {
    const { store } = await location(T);
    const n = reads(store);
    await store.create({ workflowId: WF, workflowVersion: 1, params: {} });
    expect(n.count(), 'J1').toBe(1);
  });

  it('J2 a keyed create that REUSES an existing run spends one', async () => {
    const { store } = await location(T);
    await store.create(keyed());
    const n = reads(store);
    const again = await store.create(keyed());
    expect(again.created, 'J2 reused').toBe(false);
    expect(n.count(), 'J2').toBe(1);
  });

  it('J3 a superseding keyed create (pointer present) spends one', async () => {
    const { store } = await location(T);
    const { run } = await store.create(keyed());
    await terminalize(store, run);
    const n = reads(store);
    const next = await store.create(keyed({ onTerminalMatch: 'rerun' }));
    expect(next.run.rerun_of, 'J3 supersedes').toBe(run.id);
    expect(n.count(), 'J3').toBe(1);
  });

  it('J4 a keyed create over a crash-orphan pointer spends one', async () => {
    const { store, runsDir } = await location(T);
    await store.create(keyed());
    const p = await readPointer(runsDir);
    await writeFile(pointerPath(runsDir), JSON.stringify({ ...p, run_id: crypto.randomUUID() }));
    const n = reads(store);
    const next = await store.create(keyed());
    expect(next.created, 'J4 created').toBe(true);
    expect(n.count(), 'J4').toBe(1);
  });

  it('J5 a keyed create that ADOPTS a legacy run (no pointer) spends one', async () => {
    const { store, runsDir } = await location(T);
    const { run } = await store.create(keyed());
    await unlink(pointerPath(runsDir));
    const n = reads(store);
    const again = await store.create(keyed());
    expect(again.run.id, 'J5 adopted').toBe(run.id);
    expect(n.count(), 'J5').toBe(1);
  });

  it('J6 a superseding keyed create over a legacy run (no pointer) spends one', async () => {
    const { store, runsDir } = await location(T);
    const { run } = await store.create(keyed());
    await terminalize(store, run);
    await unlink(pointerPath(runsDir));
    const n = reads(store);
    const next = await store.create(keyed({ onTerminalMatch: 'rerun' }));
    expect(next.run.rerun_of, 'J6 supersedes').toBe(run.id);
    expect(n.count(), 'J6').toBe(1);
  });

  it('J7 a keyed create on a fresh key spends one', async () => {
    const { store } = await location(T);
    const n = reads(store);
    await store.create(keyed());
    expect(n.count(), 'J7').toBe(1);
  });

  it('J8 update spends one — applied or refused; a missing run spends none', async () => {
    const { store } = await location(T);
    const { run } = await store.create({ workflowId: WF, workflowVersion: 1, params: {} });
    const n = reads(store);
    await store.update(run);
    expect(n.count(), 'J8 applied').toBe(1);
    n.reset();
    expect(await rejected(store.update(run)), 'J8 stale').toBe('STATE_SNAPSHOT_MISMATCH');
    expect(n.count(), 'J8 refused (version-stale)').toBe(1);
    n.reset();
    expect(await rejected(store.update({ ...run, id: crypto.randomUUID() })), 'J8 missing').toBe(
      'STATE_RUN_NOT_FOUND',
    );
    expect(n.count(), 'J8 missing run').toBe(0);
  });

  it('J9 claimStep spends one — applied or refused; a missing run spends none', async () => {
    const { store } = await location(T);
    const { run } = await store.create({ workflowId: WF, workflowVersion: 1, params: {} });
    const n = reads(store);
    await store.claimStep(run.id, 'work', AUTO);
    expect(n.count(), 'J9 applied').toBe(1);
    n.reset();
    expect(await rejected(store.claimStep(run.id, 'work', AUTO)), 'J9 claimed').toBe(
      'STATE_STEP_ALREADY_CLAIMED',
    );
    expect(n.count(), 'J9 refused (already claimed)').toBe(1);
    n.reset();
    expect(await rejected(store.claimStep(crypto.randomUUID(), 'work', AUTO)), 'J9 missing').toBe(
      'STATE_RUN_NOT_FOUND',
    );
    expect(n.count(), 'J9 missing run').toBe(0);
  });

  it('J11–J15 stampSeal, save, reconcileKeys, deleteAllForRun and every read spend none', async () => {
    const { store } = await location(T);
    const { run } = await store.create(keyed());
    const ended = await terminalize(store, run);
    const other = await location(T);
    const n = reads(store);
    await store.stampSeal(ended.id, { arm: 'abandon_requested' }, ended.version).catch(() => {});
    expect(n.count(), 'J11 stampSeal').toBe(0);
    const m = reads(other.store);
    await other.store.save(ended);
    expect(m.count(), 'J12 save (keyed)').toBe(0);
    await other.store.reconcileKeys();
    expect(m.count(), 'J13 reconcileKeys').toBe(0);
    await store.get(ended.id);
    await store.list();
    await store.listWithDiagnostics();
    await store.listRunIds();
    await store.statAllForRun(ended.id);
    expect(n.count(), 'J15 get, list, listWithDiagnostics, listRunIds, statAllForRun').toBe(0);
    await store.deleteAllForRun(ended.id);
    expect(n.count(), 'J14 deleteAllForRun').toBe(0);
  });
});

describe('#715 (a) B1 — J10, settleStep (unchanged until #715 (b))', () => {
  it('J10 settleStep on an ordinary directory reads no store clock', async () => {
    // (a) red when settleStep starts reading the shared system clock through `takeReading` before
    // #715 (b) moves it; (b) prints the count. An ordinary directory, never a test location: no
    // cell of #715 (a) mixes a test location with a settling run.
    const root = await mkdtemp(join(tmpdir(), 'realm-715a-plain-'));
    roots.push(root);
    const store = new JsonFileStore(join(root, 'runs'));
    const { run } = await store.create({ workflowId: WF, workflowVersion: 1, params: {} });
    const spy = vi.spyOn(systemClock, 'now');
    await store.settleStep(run.id, { kind: 'expire_gate', gateId: 'none' }, AUTO);
    expect(spy.mock.calls.length, 'J10 settleStep').toBe(0);
  });
});

describe('#715 (a) B2 — every instant a write records equals its reading', () => {
  // (a) red when a stamp comes from a second `new Date()`; (b) prints field names and values.
  it('J1, J7, J3, J8, J9: created_at = updated_at (= the pointer’s); updated_at; since and deadline', async () => {
    const loc = await location(T);
    const { store, runsDir } = loc;
    const { run: j1 } = await store.create({ workflowId: WF, workflowVersion: 1, params: {} });
    expect([j1.created_at, j1.updated_at], 'J1 created_at, updated_at').toEqual([iso(T), iso(T)]);

    await loc.set(T + 1_000);
    const { run: j7 } = await store.create(keyed());
    const p7 = await readPointer(runsDir);
    expect(
      [j7.created_at, j7.updated_at, p7.updated_at],
      'J7 created_at, updated_at, pointer',
    ).toEqual([iso(T + 1_000), iso(T + 1_000), iso(T + 1_000)]);

    await loc.set(T + 2_000);
    await terminalize(store, j7);
    await loc.set(T + 3_000);
    const { run: j3 } = await store.create(keyed({ onTerminalMatch: 'rerun' }));
    const p3 = await readPointer(runsDir);
    expect(
      [j3.created_at, j3.updated_at, p3.updated_at],
      'J3 created_at, updated_at, pointer',
    ).toEqual([iso(T + 3_000), iso(T + 3_000), iso(T + 3_000)]);

    await loc.set(T + 4_000);
    const j8 = await store.update(await store.get(j1.id));
    expect(j8.updated_at, 'J8 updated_at').toBe(iso(T + 4_000));

    await loc.set(T + 5_000);
    const j9 = await store.claimStep(j1.id, 'work', AUTO);
    const expected = computeClaimDeadline(AUTO, 'work', new Date(T + 5_000));
    expect(typeof expected, 'the auto step has a deadline (not vacuous)').toBe('string');
    expect(
      {
        since: j9.claims?.['work']?.since,
        deadline: j9.claims?.['work']?.deadline,
        updated_at: j9.updated_at,
      },
      'J9 since, deadline, updated_at',
    ).toEqual({ since: iso(T + 5_000), deadline: expected, updated_at: iso(T + 5_000) });
  });

  it('J4 and J6: created_at = updated_at = the pointer’s', async () => {
    const loc = await location(T);
    const { store, runsDir } = loc;
    // Ended, so J6's legacy scan below finds no live run to reuse.
    await terminalize(store, (await store.create(keyed())).run);
    const p = await readPointer(runsDir);
    await writeFile(pointerPath(runsDir), JSON.stringify({ ...p, run_id: crypto.randomUUID() }));
    await loc.set(T + 10_000);
    const { run: j4 } = await store.create(keyed());
    const p4 = await readPointer(runsDir);
    expect(
      [j4.created_at, j4.updated_at, p4.updated_at],
      'J4 created_at, updated_at, pointer',
    ).toEqual([iso(T + 10_000), iso(T + 10_000), iso(T + 10_000)]);
    await terminalize(store, j4);
    await unlink(pointerPath(runsDir));
    await loc.set(T + 20_000);
    const { run: j6 } = await store.create(keyed({ onTerminalMatch: 'rerun' }));
    const p6 = await readPointer(runsDir);
    expect(
      [j6.created_at, j6.updated_at, p6.updated_at],
      'J6 created_at, updated_at, pointer',
    ).toEqual([iso(T + 20_000), iso(T + 20_000), iso(T + 20_000)]);
  });
});

/** Imports `run` into `loc`'s store as a NEW run (fresh id) stamped `updated_at`/`created_at`. */
async function importRun(loc: Loc, fields: Partial<RunRecord>): Promise<RunRecord> {
  const source = await location(T);
  const { run } = await source.store.create({ workflowId: WF, workflowVersion: 1, params: {} });
  const record: RunRecord = { ...run, ...fields };
  await loc.store.save(record);
  return loc.store.get(record.id);
}

describe('#715 (a) B3 — MONOTONE capped through the store', () => {
  it('an update after an import stamped +1 h, +3 s and −1 h stamps r+ε, r+3 s and r', async () => {
    // (a) red when the cap or the lift is missing; (b) prints the three results.
    const loc = await location(T);
    const results: string[] = [];
    for (const lead of [3_600_000, 3_000, -3_600_000]) {
      const imported = await importRun(loc, { updated_at: iso(T + lead) });
      results.push((await loc.store.update(imported)).updated_at);
    }
    expect(results, 'updated_at after +1 h, +3 s, −1 h').toEqual([
      iso(T + EPS),
      iso(T + 3_000),
      iso(T),
    ]);
  });
});

type Path = 'J3' | 'J4' | 'J6';

/**
 * Builds a holder under KEY stamped at `holderMs`, then moves the clock to `clockMs` and makes the
 * successor through `path`. Returns both runs.
 */
async function successorVia(
  path: Path,
  loc: Loc,
  holderMs: number,
  clockMs: number,
): Promise<{ holder: RunRecord; successor: RunRecord }> {
  const { store, runsDir } = loc;
  await loc.set(holderMs);
  const { run: holder } = await store.create(keyed());
  const ended = await terminalize(store, holder);
  if (path === 'J4') {
    const p = await readPointer(runsDir);
    await writeFile(pointerPath(runsDir), JSON.stringify({ ...p, run_id: crypto.randomUUID() }));
  }
  if (path === 'J6') await unlink(pointerPath(runsDir));
  await loc.set(clockMs);
  const { run: successor } = await store.create(keyed({ onTerminalMatch: 'rerun' }));
  return { holder: ended, successor };
}

describe('#715 (a) B4 — the per-key floor reaches every create path that has a holder', () => {
  // (a) red when a path stamps without the floor (red-first: the floor removed from ONE path at a
  // time — J3, then J4, then J6); (b) prints the path id, the holder's and the successor's stamps.
  for (const path of ['J3', 'J4', 'J6'] as const) {
    for (const [label, step] of [
      ['a 4 s backward step', -4_000],
      ['a frozen clock', 0],
    ] as const) {
      it(`${path}: after ${label} the successor is stamped after its holder and is the key’s canonical run`, async () => {
        const loc = await location(T);
        const { holder, successor } = await successorVia(path, loc, T, T + step);
        const msg = `${path} ${label}: holder ${holder.created_at}, successor ${successor.created_at}`;
        expect(Date.parse(successor.created_at), msg).toBeGreaterThanOrEqual(
          Date.parse(holder.created_at) + 1,
        );
        // The successor is the key's canonical run: with both ended and the pointer gone, a keyed
        // create with `reuse` takes the legacy scan (J5) and `pickCanonical` decides by created_at.
        await terminalize(loc.store, successor);
        await unlink(pointerPath(loc.runsDir));
        const canonical = await loc.store.create(keyed());
        expect(canonical.run.id, `${msg}: canonical ${canonical.run.id}`).toBe(successor.id);
      });
    }
  }

  it('J7 (no holder): the control — the successor is stamped exactly the reading', async () => {
    const loc = await location(T + 7_000);
    const { run } = await loc.store.create(keyed({ idempotencyKey: 'fresh' }));
    expect(run.created_at, 'J7 created_at').toBe(iso(T + 7_000));
  });

  it('the boundary: a backward step of exactly ε stamps the successor EQUAL to its holder (the id decides)', async () => {
    const loc = await location(T);
    const { holder, successor } = await successorVia('J3', loc, T, T - EPS);
    expect(successor.created_at, `holder ${holder.created_at}`).toBe(holder.created_at);
  });
});

describe('#715 (a) B5 — the floor is capped', () => {
  it('a holder imported at r+1 h: the successor is stamped at most r+ε', async () => {
    // (a) red when the cap is missing; (b) prints the stamps.
    const loc = await location(T);
    const holder = await importRun(loc, {
      idempotency_key: KEY,
      created_at: iso(T + 3_600_000),
      updated_at: iso(T + 3_600_000),
      run_phase: 'abandoned',
      terminal_state: true,
      abandoned_at: iso(T + 3_600_000),
      sealed_by: { arm: 'abandon_requested' },
      terminal_reason: 'Abandoned via realm run abandon',
    });
    const { run: successor } = await loc.store.create(keyed({ onTerminalMatch: 'rerun' }));
    expect(successor.rerun_of, 'supersedes the import').toBe(holder.id);
    expect(successor.created_at, `holder ${holder.created_at}`).toBe(iso(T + EPS));
  });
});

describe('#715 (a) B6 — an unparseable holder stamp floors nothing', () => {
  it('a hand-edited `created_at: "garbage"` does not throw and the successor is stamped r', async () => {
    // (a) red when the guard is missing (NaN reaches toISOString); (b) prints the thrown message.
    const loc = await location(T);
    const { run } = await loc.store.create(keyed());
    const ended = await terminalize(loc.store, run);
    const file = join(loc.runsDir, `${ended.id}.json`);
    await writeFile(file, JSON.stringify({ ...ended, created_at: 'garbage' }, null, 2));
    await loc.set(T + 2_000);
    let message = '';
    let successor: RunRecord | undefined;
    try {
      successor = (await loc.store.create(keyed({ onTerminalMatch: 'rerun' }))).run;
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message, 'no throw').toBe('');
    expect(successor?.created_at, 'stamped r').toBe(iso(T + 2_000));
  });
});

describe('#715 (a) B7 — compareCanonical compares by value', () => {
  // (a) red when the comparator compares strings; (b) prints the two orderings.
  const ID_LOW = '00000000-0000-4000-8000-000000000001';
  const ID_HIGH = 'ffffffff-ffff-4fff-bfff-fffffffffff1';
  const ended = {
    idempotency_key: KEY,
    run_phase: 'abandoned' as const,
    terminal_state: true,
    sealed_by: { arm: 'abandon_requested' as const },
    terminal_reason: 'Abandoned via realm run abandon',
  };

  type Stamped = { id: string; created_at: string };
  async function canonicalOf(a: Stamped, b: Stamped): Promise<string> {
    const loc = await location(T);
    await importRun(loc, { ...ended, ...a, abandoned_at: a.created_at, updated_at: a.created_at });
    await importRun(loc, { ...ended, ...b, abandoned_at: b.created_at, updated_at: b.created_at });
    await unlink(pointerPath(loc.runsDir));
    return (await loc.store.create(keyed())).run.id;
  }

  it('`…:00Z` vs `…:00.001Z`: the later wins, in either input order', async () => {
    const plain = '2031-03-04T05:06:07Z';
    const milli = '2031-03-04T05:06:07.001Z';
    const order1 = await canonicalOf(
      { id: ID_LOW, created_at: plain },
      { id: ID_HIGH, created_at: milli },
    );
    const order2 = await canonicalOf(
      { id: ID_LOW, created_at: milli },
      { id: ID_HIGH, created_at: plain },
    );
    expect([order1, order2], 'the .001Z run each time').toEqual([ID_HIGH, ID_LOW]);
  });

  it('an unparseable created_at loses to every parseable one, in either input order', async () => {
    const order1 = await canonicalOf(
      { id: ID_LOW, created_at: 'garbage' },
      { id: ID_HIGH, created_at: iso(T) },
    );
    const order2 = await canonicalOf(
      { id: ID_LOW, created_at: iso(T) },
      { id: ID_HIGH, created_at: 'garbage' },
    );
    expect([order1, order2], 'the parseable run each time').toEqual([ID_HIGH, ID_LOW]);
  });
});

describe('#715 (a) B8 — the no-holder scan never turns into a refusal', () => {
  it('a damaged run file that concerns the key neither throws nor raises the floor', async () => {
    // (a) red when the helper throws or counts the damaged file.
    const loc = await location(T);
    await loc.store.create(keyed());
    const p = await readPointer(loc.runsDir);
    // The pointer's target is gone (a crash orphan) and the only other file under the key is damaged.
    await unlink(join(loc.runsDir, `${p.run_id}.json`));
    await writeFile(
      join(loc.runsDir, `${crypto.randomUUID()}.json`),
      JSON.stringify({ workflow_id: WF, idempotency_key: KEY, created_at: iso(T + 3_000) }),
    );
    await loc.set(T + 1_000);
    const { run } = await loc.store.create(keyed());
    expect(run.created_at, 'stamped r').toBe(iso(T + 1_000));
  });

  it('an unreadable runs folder (the scan throws) leaves J4 stamping r', async () => {
    // (a) red when the helper lets the scan's throw refuse the create, or reads around it.
    // A run under the key created AHEAD of the next reading (T+3 s vs T+1 s): had the scan been
    // read, J4 would be floored to T+3 s+1 ms.
    const loc = await location(T + 3_000);
    await loc.store.create(keyed());
    const p = await readPointer(loc.runsDir);
    await writeFile(
      pointerPath(loc.runsDir),
      JSON.stringify({ ...p, run_id: crypto.randomUUID() }),
    );
    const scan = vi
      .spyOn(loc.store as unknown as { scanRunFiles(): Promise<unknown> }, 'scanRunFiles')
      .mockRejectedValue(new Error('the runs folder cannot be read'));
    await loc.set(T + 1_000);
    const { run } = await loc.store.create(keyed());
    expect(scan, 'the scan was attempted').toHaveBeenCalled();
    expect(run.created_at, 'stamped r').toBe(iso(T + 1_000));
  });
});

describe('#715 (a) B9 — an unkeyed create stamps the location’s instant and is never floored', () => {
  it('two unkeyed creates at a frozen instant both carry it', async () => {
    // (a) red when an unkeyed create is floored; (b) prints the stamps.
    const { store } = await location(T);
    const a = (await store.create({ workflowId: WF, workflowVersion: 1, params: {} })).run;
    const b = (await store.create({ workflowId: WF, workflowVersion: 1, params: {} })).run;
    expect([a.created_at, b.created_at], 'both stamps').toEqual([iso(T), iso(T)]);
  });
});

describe('#715 (a) B11 — an ordinary directory stamps with the wall clock, as before (S4)', () => {
  it('create, update and claimStep carry the faked wall instant', async () => {
    // (a) red when the ordinary directory stops using `new Date()` (S4); (b) prints the stamp and X.
    // The ONE cell in this file that fakes the global Date: scoped to this `it` (try/finally), and
    // X is the REAL instant captured first, so the lock library's staleness arithmetic stays sane.
    // #715 (b)'s test-file lint will forbid faking Date in a file that builds a store unless the
    // fake is scoped like this (D6-24's reliability.test.ts C1/C2 shape).
    const root = await mkdtemp(join(tmpdir(), 'realm-715a-plain-'));
    roots.push(root);
    const runsDir = join(root, 'runs');
    await mkdir(runsDir);
    const X = Date.now() - 60_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(X);
      const store = new JsonFileStore(runsDir);
      const { run } = await store.create({ workflowId: WF, workflowVersion: 1, params: {} });
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

describe('#715 (a) D1 — deleteAllForRun’s expectVersion (the anchor’s version guard)', () => {
  it('the stored version deletes as before; an older one refuses STATE_SNAPSHOT_MISMATCH and deletes nothing', async () => {
    // (a) red when the version check is missing, or runs after deletion; (b) prints the code and
    // details.
    const loc = await location(T);
    const { run } = await loc.store.create(keyed());
    const ended = await terminalize(loc.store, run);
    let caught: { code?: string; details?: Record<string, unknown> } = {};
    try {
      await loc.store.deleteAllForRun(ended.id, undefined, { expectVersion: ended.version - 1 });
    } catch (err) {
      caught = err as typeof caught;
    }
    expect({ code: caught.code, details: caught.details }, 'the refusal').toEqual({
      code: 'STATE_SNAPSHOT_MISMATCH',
      details: { runId: ended.id, expected: ended.version - 1, actual: ended.version },
    });
    expect(existsSync(join(loc.runsDir, `${ended.id}.json`)), 'the run file is intact').toBe(true);
    expect(existsSync(pointerPath(loc.runsDir)), 'the key pointer is intact').toBe(true);
    const report = await loc.store.deleteAllForRun(ended.id, undefined, {
      expectVersion: ended.version,
    });
    expect(report.bytes_deleted > 0, `deleted at the stored version: ${report.bytes_deleted}`).toBe(
      true,
    );
    expect(existsSync(join(loc.runsDir, `${ended.id}.json`)), 'the run file is gone').toBe(false);
  });
});
