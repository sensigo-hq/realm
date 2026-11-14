// listen-sweep-one-pass-963.test.ts — U3b (#963): the expired-gate sweeper of `realm listen
// --sweep-expired-gates` runs one pass at a time, reads only the runs waiting at a gate, and holds at
// most one waiter on the store's clock, at the earliest deadline it has read. Every cell runs on a real
// SQLite home (`makeTempHome`) with a settable clock wrapped to count its waiters; the store is seen
// through a proxy that records each scan (its filter, its items, how many run at once) and each
// `settleStep`. A failing cell prints those counts, the waiters' deadlines and the runs' phases.
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { settableClock, type SettableClock } from '@sensigo/realm-testing';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  markTestClock,
  type PendingGate,
  type RunStore,
  type ScanFilter,
  type ScanOptions,
  type WorkflowDefinition,
} from '@sensigo/realm';
import {
  makeSweepRunner,
  startListen,
  sweepExpiredGates,
  type ListenDeps,
  type Logger,
  type WorkflowEntry,
} from './listen.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const T0 = new Date('2030-01-01T00:00:00.000Z');
const at = (ms: number): string => new Date(T0.getTime() + ms).toISOString();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const def: WorkflowDefinition = {
  id: 'sweep-963',
  name: 'Sweep 963',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    approve: { description: 'a', execution: 'auto', depends_on: [], trust: 'human_confirmed' },
  },
};

/** A settable clock over `inner` that counts its live waiters and records each one's deadline. */
function watched(inner: SettableClock) {
  let live = 0;
  const armed: string[] = [];
  const clock = markTestClock({
    now: () => inner.now(),
    at(when: Date, fn: () => void | Promise<void>): () => void {
      live += 1;
      armed.push(when.toISOString());
      let gone = false;
      const cancel = inner.at(when, () => {
        if (!gone) {
          gone = true;
          live -= 1;
        }
        return fn();
      });
      return () => {
        if (!gone) {
          gone = true;
          live -= 1;
        }
        cancel();
      };
    },
  });
  return { clock, live: () => live, armed };
}

/** What the proxy over the store records, and how a cell steers its scans. */
interface Seen {
  scans: Array<{ filter: ScanFilter; items: number }>;
  active: number;
  maxActive: number;
  expireCalls: number;
  /** While set, the next scan waits for it before it reads. */
  hold: Promise<void> | undefined;
  /** While set, the next scan yields one page holding only this run, then throws. */
  firstPageOnly: string | undefined;
}

function proxied(store: RunStore): { runStore: RunStore; seen: Seen } {
  const seen: Seen = {
    scans: [],
    active: 0,
    maxActive: 0,
    expireCalls: 0,
    hold: undefined,
    firstPageOnly: undefined,
  };
  async function* scan(filter: ScanFilter, options: ScanOptions) {
    const entry = { filter, items: 0 };
    seen.scans.push(entry);
    seen.active += 1;
    seen.maxActive = Math.max(seen.maxActive, seen.active);
    const hold = seen.hold;
    seen.hold = undefined;
    const only = seen.firstPageOnly;
    seen.firstPageOnly = undefined;
    try {
      if (hold !== undefined) await hold;
      for await (const page of store.scan(
        filter,
        options as ScanOptions & { projection: 'record' },
      )) {
        if (only !== undefined) {
          const items = page.items.filter((i) => i.kind === 'run' && i.run.record.id === only);
          entry.items += items.length;
          yield { ...page, items, next_after: 'more' };
          throw new Error('the second page could not be read');
        }
        entry.items += page.items.length;
        yield page;
      }
    } finally {
      seen.active -= 1;
    }
  }
  const runStore = new Proxy(store, {
    get(target, prop) {
      if (prop === 'scan') return scan;
      if (prop === 'settleStep') {
        return (...args: Parameters<RunStore['settleStep']>) => {
          if ((args[1] as { kind?: string }).kind === 'expire_gate') seen.expireCalls += 1;
          return target.settleStep(...args);
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { runStore, seen };
}

function capturing(): Logger & { lines: Array<[string, string]> } {
  const lines: Array<[string, string]> = [];
  const at = (level: string) => (msg: string) => {
    lines.push([level, msg]);
  };
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

interface Home {
  h: TempHome;
  inner: SettableClock;
  w: ReturnType<typeof watched>;
  runStore: RunStore;
  seen: Seen;
  logger: ReturnType<typeof capturing>;
  /** A run of `def` waiting at a gate that expires `inMs` after the clock's now, `on_expiry: abort`. */
  gate(inMs: number, extra?: Partial<PendingGate>): Promise<string>;
  /** Answers the run's gate as a person would leave it: the gate gone, the step no longer running. */
  answer(runId: string): Promise<void>;
  phase(runId: string): Promise<string>;
}

async function home(): Promise<Home> {
  const inner = settableClock(T0);
  const w = watched(inner);
  const h = await makeTempHome({ clock: w.clock });
  onTestFinished(() => h.cleanup());
  await h.home.workflowStore.register(def);
  const { runStore, seen } = proxied(h.home.runStore);
  let n = 0;
  return {
    h,
    inner,
    w,
    runStore,
    seen,
    logger: capturing(),
    gate: async (inMs, extra = {}) => {
      n += 1;
      const { record } = await h.home.runStore.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      const now = inner.now().getTime();
      await h.home.runStore.update({
        ...record,
        in_progress_steps: ['approve'],
        claims: { approve: { deadline: null } },
        pending_gate: {
          gate_id: `gate-${n}`,
          step_name: 'approve',
          preview: {},
          choices: ['approve', 'reject'],
          opened_at: new Date(now).toISOString(),
          expires_at: new Date(now + inMs).toISOString(),
          on_expiry: 'abort',
          ...extra,
        },
      });
      return record.id;
    },
    answer: async (runId) => {
      const { record } = await h.home.runStore.get(runId);
      const { pending_gate: _gate, ...rest } = record;
      await h.home.runStore.update({ ...rest, in_progress_steps: [] });
    },
    phase: async (runId) => String((await h.home.runStore.get(runId)).record.run_phase),
  };
}

/** `realm listen`'s server with the sweeper on (a period of 60 s, never reached in a cell). */
async function listening(x: Home) {
  const before = { term: process.listeners('SIGTERM'), int: process.listeners('SIGINT') };
  const deps: ListenDeps = {
    workflowStore: x.h.home.workflowStore,
    runStore: x.runStore,
    dedupStoreFor: () => ({
      check: async () => false,
      record: async () => {},
      cleanup: async () => {},
    }),
    spawnAgent: async () => ({ pid: 1 }),
    logger: x.logger,
  };
  const handle = await startListen(
    new Map<string, WorkflowEntry>(),
    {
      port: 0,
      host: '127.0.0.1',
      bodyTimeoutMs: 5000,
      maxBodyBytes: 1_048_576,
      maxConcurrent: 20,
      sweepExpiredGatesIntervalMs: 60_000,
    },
    deps,
  );
  for (const l of process.listeners('SIGTERM'))
    if (!before.term.includes(l)) process.removeListener('SIGTERM', l);
  for (const l of process.listeners('SIGINT'))
    if (!before.int.includes(l)) process.removeListener('SIGINT', l);
  onTestFinished(() => handle.shutdown('test'));
  return handle;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('U3b (#963) — what a pass reads', () => {
  it('C1: a pass reads only the runs waiting at a gate: 3 of 503 runs, through the phase filter', async () => {
    const x = await home();
    for (let i = 0; i < 500; i += 1) {
      await x.h.home.runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    }
    await x.gate(60_000);
    await x.gate(120_000);
    await x.gate(180_000);
    await sweepExpiredGates({
      runStore: x.runStore,
      workflowStore: x.h.home.workflowStore,
      logger: x.logger,
    });
    // (a) red when the pass reads every run (the `{}` filter: 503 items) or filters by `terminal`
    //     (a fresh run matches `terminal: false`: 503 items); (b) prints each scan's filter and items.
    expect(x.seen.scans).toEqual([{ filter: { phase: 'gate_waiting' }, items: 3 }]);
  }, 60_000);
});

describe('U3b (#963) — one pass at a time', () => {
  it('C2: a pass held open while the interval ticks 8 times: never two at once, exactly one more pass after it', async () => {
    const x = await home();
    const tick = vi.spyOn(global, 'setInterval');
    await listening(x);
    const fire = tick.mock.calls.find(([, ms]) => ms === 60_000)?.[0] as () => void;
    let release!: () => void;
    x.seen.hold = new Promise<void>((r) => (release = r));
    fire();
    await vi.waitFor(() => expect(x.seen.active).toBe(1));
    for (let i = 0; i < 8; i += 1) fire();
    release();
    await vi.waitFor(() => expect(x.seen.scans.length).toBe(2));
    await vi.waitFor(() => expect(x.seen.active).toBe(0));
    await sleep(200);
    // (a) red without the running flag (nine passes, several at once) or with a follow-up that
    //     counts the wakes (nine passes one after another); (b) prints the passes and the most at once.
    expect({ passes: x.seen.scans.length, mostAtOnce: x.seen.maxActive }).toEqual({
      passes: 2,
      mostAtOnce: 1,
    });
  });
});

describe('U3b (#963) — one waiter on the store’s clock', () => {
  it('C4a: three gates not due arm one waiter, at the earliest; it carries that gate out and re-arms for the next; no gate waiting, no waiter', async () => {
    const x = await home();
    const a = await x.gate(60_000);
    const b = await x.gate(120_000);
    const c = await x.gate(180_000);
    const runner = makeSweepRunner({
      runStore: x.runStore,
      workflowStore: x.h.home.workflowStore,
      logger: x.logger,
    });
    await runner.wake();
    const first = { live: x.w.live(), at: x.w.armed.at(-1) };
    await x.inner.advance(60_000);
    const second = { live: x.w.live(), at: x.w.armed.at(-1), a: await x.phase(a) };
    await x.answer(b);
    await x.answer(c);
    await runner.wake();
    // (a) red with a waiter per gate (three live), a waiter not at the earliest deadline, one that
    //     does not re-arm after it fires, or one left when no gate waits; (b) prints the live count,
    //     the last deadline armed and the first run's phase.
    expect({ first, second, none: x.w.live() }).toEqual({
      first: { live: 1, at: at(60_000) },
      second: { live: 1, at: at(120_000), a: 'aborted' },
      none: 0,
    });
  });

  it('C4b: a pass whose read fails on its second page leaves the waiter where it was', async () => {
    const x = await home();
    await x.gate(60_000);
    await x.gate(120_000);
    const c = await x.gate(180_000);
    const runner = makeSweepRunner({
      runStore: x.runStore,
      workflowStore: x.h.home.workflowStore,
      logger: x.logger,
    });
    await runner.wake();
    // The next read yields a first page holding only the latest gate, then fails.
    x.seen.firstPageOnly = c;
    await runner.wake();
    // (a) red when the waiter is moved or dropped from a read that did not finish (it would move to
    //     the latest gate, and the earliest would wait a whole interval); (b) prints the deadlines
    //     armed, the live count and the error lines.
    expect({
      armed: x.w.armed,
      live: x.w.live(),
      errors: x.logger.lines.filter(([level]) => level === 'error').map(([, msg]) => msg),
    }).toEqual({ armed: [at(60_000)], live: 1, errors: ['listen: sweeper pass failed'] });
  });

  it('C4c: a gate answered before its deadline: when the clock passes it, one more read and no expiry attempted', async () => {
    const x = await home();
    const g = await x.gate(60_000);
    const runner = makeSweepRunner({
      runStore: x.runStore,
      workflowStore: x.h.home.workflowStore,
      logger: x.logger,
    });
    await runner.wake();
    await x.answer(g);
    const scansBefore = x.seen.scans.length;
    await x.inner.advance(120_000);
    // (a) red when the waiter carries the gate out from what an earlier read held (then one
    //     `expire_gate` settlement is attempted, and the store refuses it), alone or besides waking a
    //     pass; (b) prints the reads since, the expiry attempts and the live waiters.
    expect({
      readsSince: x.seen.scans.length - scansBefore,
      expiryAttempts: x.seen.expireCalls,
      live: x.w.live(),
    }).toEqual({ readsSince: 1, expiryAttempts: 0, live: 0 });
  });
});

describe('U3b (#963) — the stop', () => {
  it('C5a: after the stop the interval is cleared, no waiter is live, and a late tick starts no pass', async () => {
    const x = await home();
    await x.gate(60_000);
    const tick = vi.spyOn(global, 'setInterval');
    const untick = vi.spyOn(global, 'clearInterval');
    const handle = await listening(x);
    const i = tick.mock.calls.findIndex(([, ms]) => ms === 60_000);
    const fire = tick.mock.calls[i]?.[0] as () => void;
    fire();
    await vi.waitFor(() => expect(x.w.live()).toBe(1));
    await handle.shutdown('test');
    const scans = x.seen.scans.length;
    fire();
    await sleep(100);
    // (a) red when the stop leaves the waiter armed, does not clear the interval, or lets a late tick
    //     start a pass; (b) prints whether the interval was cleared, the live waiters and the reads.
    expect({
      cleared: untick.mock.calls.some(([t]) => t === tick.mock.results[i]?.value),
      live: x.w.live(),
      readsAfter: x.seen.scans.length - scans,
    }).toEqual({ cleared: true, live: 0, readsAfter: 0 });
  });

  it('C5b: a pass held open, the stop, the pass released: it arms nothing and no pass follows', async () => {
    const x = await home();
    await x.gate(60_000);
    const tick = vi.spyOn(global, 'setInterval');
    const handle = await listening(x);
    const fire = tick.mock.calls.find(([, ms]) => ms === 60_000)?.[0] as () => void;
    let release!: () => void;
    x.seen.hold = new Promise<void>((r) => (release = r));
    fire();
    await vi.waitFor(() => expect(x.seen.active).toBe(1));
    fire();
    const stopped = handle.shutdown('test');
    release();
    await vi.waitFor(() => expect(x.seen.active).toBe(0));
    await stopped;
    await sleep(100);
    // (a) red when a pass that ends after the stop arms a waiter, or starts the follow-up the tick
    //     asked for; (b) prints the live waiters and the reads.
    expect({ live: x.w.live(), armed: x.w.armed.length, reads: x.seen.scans.length }).toEqual({
      live: 0,
      armed: 0,
      reads: 1,
    });
  });
});

describe('U3b (#963) — a gate opened since the last read', () => {
  it('C6: a gate opened after a pass, with no waiter for it, is carried out at the next pass and not before', async () => {
    const x = await home();
    const runner = makeSweepRunner({
      runStore: x.runStore,
      workflowStore: x.h.home.workflowStore,
      logger: x.logger,
    });
    await runner.wake();
    const liveAfterFirst = x.w.live();
    const g = await x.gate(-5_000);
    await x.inner.advance(30_000);
    const beforeNext = await x.phase(g);
    await runner.wake();
    // (a) red when the next pass does not carry out a due gate it reads; (b) prints the live
    //     waiters, and the run's phase before and after the next pass.
    expect({ liveAfterFirst, beforeNext, afterNext: await x.phase(g) }).toEqual({
      liveAfterFirst: 0,
      beforeNext: 'gate_waiting',
      afterNext: 'aborted',
    });
  });
});
