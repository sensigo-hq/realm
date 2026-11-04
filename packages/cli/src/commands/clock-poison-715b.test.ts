// clock-poison-715b.test.ts — issue #715 (b) 04 §A.3 (D5 §5.1, D6-23): the poison cell. Each engine
// entry runs on an InMemoryStore with a STEPPING store clock while the no-argument `Date` (and
// `Date.now()`) is poisoned: a call from anywhere but `node_modules` (the test runner, libraries) or
// an allow-listed `outside` frame of the census throws, and is recorded with its frame. Every entry
// must finish with nothing recorded, and must have read the store's clock: the engine reads time
// only through its store.
//
// HOME: the cli package, which loads ONE built copy of core through the package names (a core test
// that imported `@sensigo/realm-testing` would load two).
//
// Each cell carries (a) the change that turns it red and (b) what it prints on failure.
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  abandonRun,
  advanceRun,
  drainFinalizers,
  executeChain,
  executeEngineStep,
  executeStep,
  reclaimStep,
  submitHumanResponse,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, steppingClock } from '@sensigo/realm-testing';

/**
 * The frames allowed to read the host's clock while an entry runs: the census's `outside` rows that
 * an engine entry can reach. None today — a stepping store clock reads no wall, and no `outside` row
 * sits on an entry's path (the census test keeps the list; a row added there that an entry reaches
 * belongs here, by its function name).
 */
const ALLOWED_FRAMES: readonly string[] = [];

const RealDate = globalThis.Date;
let hits: string[] = [];

/** The first stack frame outside this file and Node's internals: the caller of the clock read. */
function callerFrame(): string {
  const lines = (new Error().stack ?? '').split('\n').slice(1);
  return (
    lines.find(
      (l) =>
        !l.includes('clock-poison-715b') &&
        !l.includes('node:internal') &&
        !l.includes('(<anonymous>)') &&
        l.trim().startsWith('at '),
    ) ?? '(no frame)'
  ).trim();
}

function allowed(frame: string): boolean {
  return frame.includes('node_modules') || ALLOWED_FRAMES.some((f) => frame.includes(f));
}

function poison(): void {
  hits = [];
  class PoisonedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        const frame = callerFrame();
        if (!allowed(frame)) {
          hits.push(`new Date() ${frame}`);
          throw new Error(`the host's clock was read by ${frame}`);
        }
      }
      super(...(args as [number]));
    }
    static override now(): number {
      const frame = callerFrame();
      if (!allowed(frame)) {
        hits.push(`Date.now() ${frame}`);
        throw new Error(`the host's clock was read by ${frame}`);
      }
      return RealDate.now();
    }
  }
  globalThis.Date = PoisonedDate as unknown as DateConstructor;
}

afterEach(() => {
  globalThis.Date = RealDate;
});

const START = '2030-01-01T00:00:00.000Z';

function storeOnSteppingClock() {
  const clock = steppingClock(START, 1_000);
  return { clock, store: new InMemoryStore({ clock }) };
}

const def = (id: string, steps: WorkflowDefinition['steps']): WorkflowDefinition => ({
  id,
  name: id,
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps,
});

function registry(): ExtensionRegistry {
  const r = new ExtensionRegistry();
  r.register('handler', 'ok', { id: 'ok', execute: async () => ({ data: { done: true } }) });
  return r;
}

async function created(store: InMemoryStore, d: WorkflowDefinition): Promise<RunRecord> {
  return (await store.create({ workflowId: d.id, workflowVersion: 1, params: {} })).record;
}

/** Runs `entry` poisoned; returns the frames that read the host's clock and the store's readings. */
async function poisoned(
  clock: { readonly reads: number },
  entry: () => Promise<unknown>,
): Promise<{ hits: string[]; storeReads: number; threw?: string }> {
  const before = clock.reads;
  poison();
  try {
    await entry();
    return { hits, storeReads: clock.reads - before };
  } catch (err) {
    return { hits, storeReads: clock.reads - before, threw: (err as Error).message };
  } finally {
    globalThis.Date = RealDate;
  }
}

describe('#715 (b) 04 §A.3 — the engine reads time only through its store (the poison cell)', () => {
  it('executeStep on an agent step', async () => {
    // (a) red when an engine path reads `new Date()`/`Date.now()` (a judge given its old default
    //     back); (b) prints the frames that read it and the store's reading count.
    const { clock, store } = storeOnSteppingClock();
    const d = def('poison-step', { a: { description: 'A.', execution: 'agent', depends_on: [] } });
    const run = await created(store, d);
    const r = await poisoned(clock, () =>
      executeStep(store, d, {
        runId: run.id,
        command: 'a',
        input: {},
        dispatcher: async () => ({}),
      }),
    );
    expect({ hits: r.hits, threw: r.threw, read: r.storeReads > 0 }).toEqual({
      hits: [],
      threw: undefined,
      read: true,
    });
  });

  it('executeChain from an agent step through an auto step', async () => {
    // (a)/(b) as above.
    const { clock, store } = storeOnSteppingClock();
    const d = def('poison-chain', {
      a: { description: 'A.', execution: 'agent', depends_on: [] },
      b: { description: 'B.', execution: 'auto', handler: 'ok', depends_on: ['a'] },
    });
    const run = await created(store, d);
    const r = await poisoned(clock, () =>
      executeChain(store, d, {
        runId: run.id,
        command: 'a',
        input: {},
        dispatcher: async () => ({}),
        registry: registry(),
      }),
    );
    expect({ hits: r.hits, threw: r.threw, read: r.storeReads > 0 }).toEqual({
      hits: [],
      threw: undefined,
      read: true,
    });
  });

  it('advanceRun over an auto step', async () => {
    // (a)/(b) as above.
    const { clock, store } = storeOnSteppingClock();
    const d = def('poison-advance', {
      x: { description: 'X.', execution: 'auto', handler: 'ok', depends_on: [] },
    });
    const run = await created(store, d);
    const r = await poisoned(clock, () =>
      advanceRun(store, d, { runId: run.id, registry: registry() }),
    );
    expect({ hits: r.hits, threw: r.threw, read: r.storeReads > 0 }).toEqual({
      hits: [],
      threw: undefined,
      read: true,
    });
  });

  it('executeEngineStep on an auto step', async () => {
    // (a)/(b) as above.
    const { clock, store } = storeOnSteppingClock();
    const d = def('poison-engine', {
      x: { description: 'X.', execution: 'auto', handler: 'ok', depends_on: [] },
    });
    const run = await created(store, d);
    const r = await poisoned(clock, () =>
      executeEngineStep(store, d, { runId: run.id, step: 'x', run, registry: registry() }),
    );
    expect({ hits: r.hits, threw: r.threw, read: r.storeReads > 0 }).toEqual({
      hits: [],
      threw: undefined,
      read: true,
    });
  });

  it('submitHumanResponse on an open question with a deadline', async () => {
    // (a)/(b) as above.
    const { clock, store } = storeOnSteppingClock();
    const d = def('poison-answer', {
      q: {
        description: 'Q.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: { choices: ['approve', 'reject'], timeout_seconds: 3600, on_expiry: 'abort' },
      },
    });
    const run = await created(store, d);
    await advanceRun(store, d, { runId: run.id });
    const gateId = (await store.get(run.id)).record.pending_gate!.gate_id;
    const r = await poisoned(clock, () =>
      submitHumanResponse(store, d, { runId: run.id, gateId, choice: 'approve' }),
    );
    expect({ hits: r.hits, threw: r.threw, read: r.storeReads > 0 }).toEqual({
      hits: [],
      threw: undefined,
      read: true,
    });
  });

  it('reclaimStep on a claim past its deadline', async () => {
    // (a)/(b) as above.
    const { clock, store } = storeOnSteppingClock();
    const d = def('poison-reclaim', {
      a: { description: 'A.', execution: 'agent', idempotent: true, depends_on: [] },
    });
    const run = await created(store, d);
    await store.update({
      ...run,
      in_progress_steps: ['a'],
      claims: { a: { deadline: '2020-01-01T00:00:00.000Z', token: 't' } },
    } as RunRecord);
    void d;
    const r = await poisoned(clock, () => reclaimStep(store, run.id, 'a'));
    expect({ hits: r.hits, threw: r.threw, read: r.storeReads > 0 }).toEqual({
      hits: [],
      threw: undefined,
      read: true,
    });
  });

  it('drainFinalizers on an ended run with a cleanup step', async () => {
    // (a)/(b) as above.
    const { clock, store } = storeOnSteppingClock();
    const d = def('poison-drain', {
      a: { description: 'A.', execution: 'agent', depends_on: [] },
      tidy: {
        description: 'Tidy.',
        execution: 'auto',
        handler: 'ok',
        finalizer: true,
        depends_on: [],
      },
    } as WorkflowDefinition['steps']);
    const run = await created(store, d);
    await abandonRun(store, run.id, 'for the drain');
    const r = await poisoned(clock, () => drainFinalizers(store, d, registry(), run.id));
    expect({ hits: r.hits, threw: r.threw, read: r.storeReads > 0 }).toEqual({
      hits: [],
      threw: undefined,
      read: true,
    });
  });

  it('abandonRun on a running run', async () => {
    // (a)/(b) as above.
    const { clock, store } = storeOnSteppingClock();
    const d = def('poison-abandon', {
      a: { description: 'A.', execution: 'agent', depends_on: [] },
    });
    const run = await created(store, d);
    const r = await poisoned(clock, () => abandonRun(store, run.id, 'done'));
    expect({ hits: r.hits, threw: r.threw, read: r.storeReads > 0 }).toEqual({
      hits: [],
      threw: undefined,
      read: true,
    });
  });
});

describe('#715 (b) 04 §A.4 — the returned Date is fresh (D6-25, FC R47)', () => {
  it('mutating a Date the stepping store clock returned changes nothing the store reads next; a later reading changes nothing a caller holds', async () => {
    // (a) red when a clock hands out a shared Date — a caller's mutation then moves the store's time,
    //     or the clock's next reading moves the instant a caller holds; (b) prints the readings.
    const clock = steppingClock(START, 1_000);
    const first = clock.now();
    const second = clock.now();
    const held = first.toISOString();
    first.setTime(0);
    expect({ held, second: second.toISOString(), third: clock.now().toISOString() }).toEqual({
      held: START,
      second: '2030-01-01T00:00:01.000Z',
      third: '2030-01-01T00:00:02.000Z',
    });
  });
});
