// judged-snapshot-715b.test.ts — issue #715 (b) 02 §B.1 (D6-17) with Amendment 4 and its addendum:
// the engine hands back, privately, the snapshot it judged its reply on (`judgedSnapshotOf`), so a
// host judges THAT snapshot and never reads the run again. Cells (i) (a settle interposed between the
// engine's load and the reply, and a replayed request), (iii) (a copy carries nothing) and the core
// half of (iv) (one load by the engine). Every store is a JSON store on a test location whose clock
// file says the instant (core cannot import the testing package).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { JsonFileStore } from '../store/json-file-store.js';
import { writeTestClockFile } from '../store/test-clock-file.js';
import { advanceRun, executeStep } from './execution-loop.js';
import { attachJudged, judgedSnapshotOf, type Snapshot } from './snapshot.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A unique value put in the run's `params` — a record field no engine reply carries. */
const SENTINEL = 'SENTINEL-715B-JUDGED-0b9f';

/** One agent step: the engine owes nothing, so `advanceRun` runs nothing. */
const ONE: WorkflowDefinition = {
  id: 'judged-715b',
  name: 'judged 715b',
  version: 1,
  steps: {
    a: { description: 'A.', execution: 'agent', depends_on: [] },
    b: { description: 'B.', execution: 'agent', depends_on: ['a'] },
  },
} as WorkflowDefinition;

const T0 = new Date('2026-10-30T10:00:00.000Z');

/**
 * A JSON store whose NEXT `get`, once armed, is followed by another process's write — a `seal_run`
 * that ends the run — before the read returns: a settle interposed between the engine's load and
 * its reply. Counts every `get`.
 */
class InterposingStore extends JsonFileStore {
  gets = 0;
  private interpose: ((snap: Snapshot) => Promise<void>) | undefined;
  arm(write: (snap: Snapshot) => Promise<void>): void {
    this.interpose = write;
  }
  override async get(runId: string): Promise<Snapshot> {
    this.gets += 1;
    const snap = await super.get(runId);
    const write = this.interpose;
    this.interpose = undefined;
    if (write !== undefined) await write(snap);
    return snap;
  }
}

async function location(t: Date): Promise<{ root: string; store: InterposingStore }> {
  const root = await mkdtemp(join(tmpdir(), 'realm-715b-judged-'));
  roots.push(root);
  await writeTestClockFile(root, t);
  return { root, store: new InterposingStore(join(root, 'runs')) };
}

async function created(store: InterposingStore): Promise<string> {
  const { record } = await store.create({
    workflowId: ONE.id,
    workflowVersion: 1,
    params: { note: SENTINEL },
  });
  return record.id;
}

/** Another process ends the run at the version the engine just read (its own write). */
const sealedBy = (store: JsonFileStore) => async (snap: Snapshot) => {
  await store.settleStep(snap.record.id, {
    kind: 'seal_run',
    arm: 'abandon_requested',
    reason: 'interposed by another process',
    expected_version: snap.record.version,
    release_claims: true,
  });
};

describe('#715 (b) Amendment 4 (i) — the reply is judged on ONE snapshot, the one it hands back', () => {
  it('a settle interposed between the engine’s load and its reply: the handed-back snapshot is the basis’s, and the reply’s sentence is judged on it', async () => {
    // (a) red when advanceRun's end hint reads the run again (the hint names the interposed ending
    //     while the basis names the earlier version), or when the snapshot handed back is not the
    //     one the basis was built from (basisOf noting another snapshot); (b) prints the instants,
    //     the versions, the stored record's state and the hint.
    const { store } = await location(T0);
    const runId = await created(store);
    store.arm(sealedBy(store));
    const reply = await advanceRun(store, ONE, { runId });
    const judged = judgedSnapshotOf(reply);
    const { record: stored } = await store.get(runId);
    expect({
      at: judged?.at.toISOString(),
      version: judged?.record.version,
      judgedTerminal: judged?.record.terminal_state,
      storedTerminal: stored.terminal_state,
      hint: reply.context_hint,
    }).toEqual({
      at: reply.basis?.as_of,
      version: reply.basis?.run_version,
      judgedTerminal: false,
      // non-vacuity: the interposed write landed — the store holds the ended run.
      storedTerminal: true,
      hint: `Run '${runId}': nothing ran.`,
    });
  });

  it('a replayed request gets a NEW reply judged on its own fresh load — never the first reply’s snapshot', async () => {
    // (a) red when the snapshot handed back is not the one the basis was built from (basisOf noting
    //     another snapshot), or when a reply carries the snapshot of an earlier call; (b) prints the
    //     instants and versions of both replies.
    const { root, store } = await location(T0);
    const runId = await created(store);
    const call = () =>
      executeStep(store, ONE, {
        runId,
        command: 'a',
        input: {},
        dispatcher: async () => ({}),
      });
    const first = await call();
    // The same request again, a minute later on the store's clock: the step is settled.
    await writeTestClockFile(root, new Date(T0.getTime() + 60_000));
    const replay = await call();
    const one = judgedSnapshotOf(first);
    const two = judgedSnapshotOf(replay);
    expect({
      firstStatus: first.status,
      replayAt: two?.at.toISOString(),
      replayVersion: two?.record.version,
      firstAt: one?.at.toISOString(),
    }).toEqual({
      firstStatus: 'ok',
      replayAt: replay.basis?.as_of,
      replayVersion: replay.basis?.run_version,
      firstAt: first.basis?.as_of,
    });
    // The replay's snapshot is its own load's (the later reading), not the first reply's.
    expect([two?.at.toISOString(), two === one]).toEqual([
      new Date(T0.getTime() + 60_000).toISOString(),
      false,
    ]);
  });
});

/** Three `auto` steps, then an agent step: one advance runs the three and stops at `d`. */
const THREE: WorkflowDefinition = {
  id: 'judged-715b-three',
  name: 'judged 715b three',
  version: 1,
  steps: {
    a: { description: 'A.', execution: 'auto', depends_on: [] },
    b: { description: 'B.', execution: 'auto', depends_on: ['a'] },
    c: { description: 'C.', execution: 'auto', depends_on: ['b'] },
    d: { description: 'D.', execution: 'agent', depends_on: ['c'] },
  },
} as WorkflowDefinition;

/** A store whose clock file moves one second forward before every read; it keeps each read's `at`. */
class SteppingReadStore extends JsonFileStore {
  readonly readAts: Date[] = [];
  constructor(
    private readonly root: string,
    private t: number,
  ) {
    super(join(root, 'runs'));
  }
  override async get(runId: string): Promise<Snapshot> {
    this.t += 1_000;
    await writeTestClockFile(this.root, new Date(this.t));
    const snap = await super.get(runId);
    this.readAts.push(snap.at);
    return snap;
  }
}

describe('#715 (b) 02 §A.2, D6-17 — the advance loop judges each record at its own reading', () => {
  it('one advance over three steps: the reply is judged at the reading of the loop’s last read, not at its entry’s', async () => {
    // (a) red when the loop keeps judging the records it re-reads at its entry's reading (the reply's
    //     as_of is then the first read's, a record judged before its own last write); (b) prints the
    //     reply's as_of and run_version, the readings of the first and the last read, and the steps run.
    const root = await mkdtemp(join(tmpdir(), 'realm-715b-loop-'));
    roots.push(root);
    await writeTestClockFile(root, T0);
    const store = new SteppingReadStore(root, T0.getTime());
    const { record } = await store.create({ workflowId: THREE.id, workflowVersion: 1, params: {} });
    store.readAts.length = 0;
    const reply = await advanceRun(store, THREE, { runId: record.id });
    const last = store.readAts.at(-1)!;
    const { record: stored } = await store.get(record.id);
    expect({
      ran: (reply.chained_auto_steps ?? []).map((c) => c.step),
      as_of: reply.basis?.as_of,
      run_version: reply.basis?.run_version,
      firstRead: store.readAts[0]!.toISOString() !== last.toISOString(),
    }).toEqual({
      ran: ['a', 'b', 'c'],
      as_of: last.toISOString(),
      run_version: stored.version,
      // non-vacuity: the loop's reads took different readings.
      firstRead: true,
    });
  });
});

describe('#715 (b) 01 §C.4, D6-17 — a reply about a record the call just wrote is judged at that write’s reading', () => {
  it('a step whose work takes a minute on the store’s clock: the reply’s as_of is the settle’s reading, never the load’s', async () => {
    // (a) red when the step's reply judges the record its settle wrote at the reading of the call's
    //     earlier load (as_of a minute before the record's own updated_at); (b) prints the reply's
    //     as_of, the record's updated_at and the two instants.
    const { root, store } = await location(T0);
    const runId = await created(store);
    const later = new Date(T0.getTime() + 60_000);
    const reply = await executeStep(store, ONE, {
      runId,
      command: 'a',
      input: {},
      // The work: a minute passes on the store's clock between the load and the settle.
      dispatcher: async (_c, input) => {
        await writeTestClockFile(root, later);
        return input;
      },
    });
    const { record } = await store.get(runId);
    expect({
      status: reply.status,
      as_of: reply.basis?.as_of,
      updated_at: record.updated_at,
      judgedAt: judgedSnapshotOf(reply)?.at.toISOString(),
    }).toEqual({
      status: 'ok',
      as_of: later.toISOString(),
      updated_at: later.toISOString(),
      judgedAt: later.toISOString(),
    });
  });
});

describe('#715 (b) Amendment 4 (iii) — the carrier is private: a copy carries nothing', () => {
  it('{ ...reply }, structuredClone and a JSON round trip carry no snapshot; nothing of the record shows; toEqual sees no difference; a frozen reply can be handed one', async () => {
    // (a) red when the snapshot rides the reply as a key (an enumerable `judged` field: the copies
    //     keep it, JSON and inspect show the record's sentinel, toEqual against the copy without it
    //     fails); (b) prints booleans and the copies' accessor results.
    const { store } = await location(T0);
    const runId = await created(store);
    const reply = await advanceRun(store, ONE, { runId });
    const spread = { ...reply };
    const cloned = structuredClone(reply);
    const json = JSON.parse(JSON.stringify(reply)) as typeof reply;
    const frozen = Object.freeze({ ...reply });
    attachJudged(frozen);
    expect({
      original: judgedSnapshotOf(reply) !== undefined,
      spread: judgedSnapshotOf(spread),
      cloned: judgedSnapshotOf(cloned),
      json: judgedSnapshotOf(json),
      frozen: judgedSnapshotOf(frozen) === judgedSnapshotOf(reply),
      jsonShowsRecord: JSON.stringify(reply).includes(SENTINEL),
      inspectShowsRecord: inspect(reply, { showHidden: true, depth: Infinity }).includes(SENTINEL),
    }).toEqual({
      original: true,
      spread: undefined,
      cloned: undefined,
      json: undefined,
      frozen: true,
      jsonShowsRecord: false,
      inspectShowsRecord: false,
    });
    expect(reply).toEqual(json);
  });
});

describe('#715 (b) Amendment 4 (iv), core half — one load by the engine', () => {
  it('advanceRun on a run that owes the engine nothing reads the run once', async () => {
    // (a) red when advanceRun reads the run again for its end hint; (b) prints the count.
    const { store } = await location(T0);
    const runId = await created(store);
    const before = store.gets;
    await advanceRun(store, ONE, { runId });
    expect(store.gets - before).toBe(1);
  });
});
