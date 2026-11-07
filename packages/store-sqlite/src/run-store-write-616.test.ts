// run-store-write-616.test.ts — issue #616 PR-1a unit 12b: the run store's writes after a create
// (`SqliteRunStore.update` and `claimStep`, and the writer they share, `writeRunUpdate`), on real homes
// in a temp directory, through `openRealmHome`. The real cases: the engine writing a run's next state
// and claiming its next step; a second process claiming or updating the same run at the same moment;
// a caller holding a stale copy; a write that would drop or change stored evidence or a write-once
// field; a write that would cross the seal boundary; a clock that stepped back behind a stored stamp;
// a COMMIT that fails after or before its rows reached the file, or after another writer moved on; a
// record whose text is made under the write lock; and a caller that goes on after the writer failed.
//
// These cells stand in for the update and claim ground of core's shared store laws until unit 16
// wires the contract (`packages/testing/src/store/store-clock-contract.ts`,
// `run-store-fidelity-contract.ts` and `settlement-contract.ts`): `WRITE_ONE_READING` (its update
// and claim rows), `MONOTONE_CAPPED`, `SNAPSHOT_AT_SOUND`, `CLAIM_SINGLE_OWNER`, `CLAIM_NAMES_HOLDER`
// (on the system clock, as the law needs), the fidelity family's key order, the seal cells
// (`SEAL_FRESH_WRITE_REFUSED`, `SEAL_ORPHAN_REFUSED`, `SEAL_ERASE_REFUSED`, `SEAL_REWRITE_REFUSED`,
// `SEAL_UNKNOWN_ARM_REFUSED`) and `PHASE_IS_GENERATED`'s claim leg; the design's `L-MP-CAS` (its
// update and claim legs) and `L-SER`.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  runPhaseDerivationFingerprint,
  WorkflowError,
  type Attributed,
  type Clock,
  type CreateRunOptions,
  type EvidenceSnapshot,
  type RunRecord,
  type Snapshot,
  type WorkflowContextSnapshot,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import type { WithCommitOutcome } from './connection.js';
import { openDatabase, type DatabaseLike } from './driver.js';
import { openRealmHome } from './index.js';
import type { OpenSeams } from './open-file.js';
import { openHome, type RealmHome } from './open-realm-home.js';
import { splitRunRecord, writeRunUpdate } from './run-rows.js';
import { faultyFiles, SQLITE } from './test-support/commit-faults.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The instant the cells' clocks start at. */
const T = '2030-05-06T07:08:09.000Z';

const dirs: string[] = [];
const handles: RealmHome[] = [];
const connections: DatabaseLike[] = [];
afterEach(() => {
  for (const c of connections.splice(0)) c.close();
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-u12b-'));
  dirs.push(dir);
  return dir;
}

/** A test clock: it answers the instant it is set to and counts its readings. */
function testClock(start: string): { clock: Clock; set(iso: string): void; reads(): number } {
  let now = Date.parse(start);
  let reads = 0;
  return {
    clock: {
      now: () => {
        reads += 1;
        return new Date(now);
      },
      at: () => () => undefined,
    },
    set: (iso) => {
      now = Date.parse(iso);
    },
    reads: () => reads,
  };
}

/** An open home: its folder and its run store. */
interface Opened {
  readonly home: string;
  readonly runStore: RealmHome['runStore'];
}

/** Opens a home on `clock` (the system clock when left out; the open's seams when given). */
async function open(clock?: Clock, seams?: OpenSeams): Promise<Opened> {
  const home = join(tmp(), '.realm');
  const options = clock === undefined ? { home } : { home, clock };
  const handle = await (seams === undefined ? openRealmHome(options) : openHome(options, seams));
  handles.push(handle);
  return { home, runStore: handle.runStore };
}

/** Another connection on the home's file (the hostile writer, or a second reader). */
async function foreign(home: string): Promise<DatabaseLike> {
  const c = await openForeignConnection(home);
  connections.push(c);
  return c;
}

/** A refusal as a reader sees it: a typed refusal's code, or a plain error's name and message. */
function describeError(err: unknown): string {
  return err instanceof WorkflowError
    ? err.code
    : `${(err as Error).name}: ${(err as Error).message}`;
}

/** A typed refusal's code, sentence and details (what a host prints), or a plain error's text. */
function refusal(err: unknown): unknown {
  return err instanceof WorkflowError
    ? { code: err.code, message: err.message, details: err.details }
    : describeError(err);
}

/** What a call did: `'ok'`, or its refusal's code. */
const outcome = (call: Promise<unknown>): Promise<string> => call.then(() => 'ok', describeError);

/** What a synchronous call did: `'ok'`, or its error as a reader sees it. */
function settleSync(call: () => unknown): string {
  try {
    call();
    return 'ok';
  } catch (err) {
    return describeError(err);
  }
}

/** A record as `JSON.stringify` holds it: key order included. */
const text = (snapshot: Snapshot): string => JSON.stringify(snapshot.record);

/** One evidence entry of step `a`, as the engine writes it. */
function entry(i: number, extra: Record<string, unknown> = {}): EvidenceSnapshot {
  return {
    step_id: 'a',
    started_at: '2030-05-06T07:00:00.000Z',
    completed_at: '2030-05-06T07:00:01.000Z',
    duration_ms: 1000,
    input_summary: { i },
    output_summary: { answer: `answer ${i}`, ...extra },
    status: 'success',
    evidence_hash: `${i}`.padStart(64, '0'),
  };
}

/** The workflow's context files as the engine snapshots them at the run's first step. */
function contextFiles(content: string): Record<string, WorkflowContextSnapshot> {
  return {
    'guide.md': {
      source_path: '/work/guide.md',
      content,
      content_hash: 'cd'.repeat(32),
      loaded_at: '2030-05-06T07:00:00.000Z',
    },
  };
}

/** Three steps: `a` runs by itself, `b` after `a`, `c` is an agent's (no deadline). */
const DEF: WorkflowDefinition = {
  id: 'wf',
  name: 'Unit 12b',
  version: 1,
  steps: {
    a: { description: 'First', execution: 'auto', depends_on: [] },
    b: { description: 'After a', execution: 'auto', depends_on: ['a'] },
    c: { description: 'An agent step', execution: 'agent', depends_on: [] },
  },
};

const BARE: CreateRunOptions = { workflowId: 'wf', workflowVersion: 1, params: {} };

/** What a second connection sees of a run: its version, phase columns, evidence rows and fields. */
function stored(
  c: DatabaseLike,
  id: string,
): { version: number; phase: unknown[]; evidence: unknown[]; fields: unknown[] } {
  const row = c.prepare('SELECT version, run_phase, phase_version FROM runs WHERE id = ?').get(id);
  return {
    version: Number(row?.['version']),
    phase: [row?.['run_phase'], row?.['phase_version']],
    evidence: c
      .prepare('SELECT seq, entry FROM evidence WHERE run_id = ? ORDER BY seq')
      .all(id)
      .map((r) => [Number(r['seq']), String(r['entry'])]),
    fields: c
      .prepare('SELECT name, value FROM run_blobs WHERE run_id = ? ORDER BY name')
      .all(id)
      .map((r) => [String(r['name']), String(r['value'])]),
  };
}

describe('#616 unit 12b — update', () => {
  it('check 1: an update at a stale version is refused with core’s version conflict; a good one moves the version by one, stamps the reading, derives the phase and adds only the new evidence rows', async () => {
    const t = testClock(T);
    const { home, runStore } = await open(t.clock);
    const { record: run } = await runStore.create(BARE);
    const stale = await runStore.update({ ...run, version: 5 }).then(() => 'updated', refusal);
    t.set('2030-05-06T07:08:10.000Z');
    const one = await runStore.update({ ...run, evidence: [entry(0)] });
    t.set('2030-05-06T07:08:11.000Z');
    // The caller's copy still says `running`; the run was abandoned.
    const two = await runStore.update({
      ...one.record,
      evidence: [entry(0), entry(1)],
      abandoned_at: '2030-05-06T07:08:11.000Z',
    });
    const written = (s: Snapshot): unknown[] => [
      s.record.version,
      s.record.updated_at,
      s.at.toISOString(),
      s.record.run_phase,
    ];
    const c = await foreign(home);
    expect({
      stale,
      one: written(one),
      two: written(two),
      rows: stored(c, run.id).evidence,
    }).toEqual({
      // (1) red when the store does not check the version itself: the file's version guard then
      //     refuses with the same code and sentence but no details; (2) prints the refusal.
      stale: {
        code: 'STATE_SNAPSHOT_MISMATCH',
        message: 'Version conflict — run was modified by another process',
        details: { runId: run.id, expected: 5, actual: 0 },
      },
      // (1) red when the version does not move by one, `updated_at` or `at` is not the reading, or
      //     the phase is the caller's and not the derived one; (2) prints each write's version,
      //     `updated_at`, `at` and phase.
      one: [1, '2030-05-06T07:08:10.000Z', '2030-05-06T07:08:10.000Z', 'running'],
      two: [2, '2030-05-06T07:08:11.000Z', '2030-05-06T07:08:11.000Z', 'abandoned'],
      // (1) red when an update writes the stored entries again or leaves a new one out; (2) prints
      //     the evidence rows a second connection sees.
      rows: [
        [0, JSON.stringify(entry(0))],
        [1, JSON.stringify(entry(1))],
      ],
    });
  });

  it('check 4: an update that drops or changes stored evidence, or changes or removes a stored write-once field, is refused by the store with the guards’ own words and writes nothing; a new write-once field is stored', async () => {
    const { home, runStore } = await open(testClock(T).clock);
    const { record: run } = await runStore.create(BARE);
    const { record: current } = await runStore.update({
      ...run,
      evidence: [entry(0), entry(1)],
      workflow_context_snapshots: contextFiles('v1'),
    });
    const c = await foreign(home);
    const before = stored(c, run.id);
    const { workflow_context_snapshots: _removed, ...withoutFiles } = current;
    const attempt = (record: RunRecord): Promise<unknown> =>
      runStore.update(record).then(() => 'updated', refusal);
    const evidenceRefused = {
      code: 'STATE_EVIDENCE_REWRITTEN',
      message:
        "The store refused a write that would change or remove a run's stored evidence, which is append-only.",
      details: {},
    };
    const fieldRefused = {
      code: 'STATE_WRITE_ONCE_REWRITTEN',
      message:
        'The store refused a write that would change a run field that is written once and then never changes.',
      details: {},
    };
    expect({
      fewer: await attempt({ ...current, evidence: [entry(0)] }),
      changed: await attempt({ ...current, evidence: [entry(0), entry(1, { edited: true })] }),
      fieldChanged: await attempt({ ...current, workflow_context_snapshots: contextFiles('v2') }),
      fieldRemoved: await attempt(withoutFiles as RunRecord),
      rowsAfter: stored(c, run.id),
      newField: (await runStore.get(run.id)).record.workflow_context_snapshots,
    }).toEqual({
      // (1) red when the store compares only the count (a changed entry is then dropped silently:
      //     the stored row stays and the update succeeds), only the hashes (fewer entries), or
      //     neither; (2) prints each update's outcome.
      fewer: evidenceRefused,
      changed: evidenceRefused,
      // (1) red when the store inserts only new fields and never compares the stored ones (the
      //     changed or removed field is then dropped silently); (2) prints each outcome.
      fieldChanged: fieldRefused,
      fieldRemoved: fieldRefused,
      // (1) red when an update the store must refuse is written (its version moves, its rows or
      //     fields change); (2) prints what a second connection sees.
      rowsAfter: before,
      // (1) red when a write-once field an update brings for the first time is not stored;
      //     (2) prints the field read back.
      newField: contextFiles('v1'),
    });
  });

  it('check 5: an update that crosses the seal boundary is refused with its code: unstamped, orphaned, erased, rewritten, unknown arm', async () => {
    const { runStore } = await open(testClock(T).clock);
    const fresh = async (): Promise<RunRecord> => (await runStore.create(BARE)).record;
    const sealed = async (reason: string): Promise<RunRecord> =>
      (
        await runStore.update({
          ...(await fresh()),
          terminal_state: true,
          sealed_by: { arm: 'complete' },
          terminal_reason: reason,
        })
      ).record;
    const erasable = await sealed('tck');
    const { sealed_by: _erased, ...erased } = erasable;
    // (1) red when the store skips core's seal boundary (every one of these is then written);
    //     (2) prints each update's outcome.
    expect({
      unstamped: await outcome(
        runStore.update({ ...(await fresh()), terminal_state: true, terminal_reason: 'tck' }),
      ),
      orphaned: await outcome(runStore.update({ ...(await sealed('tck')), terminal_state: false })),
      erased: await outcome(runStore.update({ ...erased, terminal_reason: 'tck (erased)' })),
      rewritten: await outcome(
        runStore.update({
          ...(await sealed('Workflow completed.')),
          sealed_by: { arm: 'guard_pass_complete' },
        }),
      ),
      unknownArm: await outcome(
        runStore.update({
          ...(await fresh()),
          terminal_state: true,
          // The shape a record written by a later Realm would have: the cast is the point.
          sealed_by: { arm: 'from_the_future' } as unknown as NonNullable<RunRecord['sealed_by']>,
          terminal_reason: 'tck',
        }),
      ),
    }).toEqual({
      unstamped: 'STATE_SEAL_UNSTAMPED',
      orphaned: 'STATE_SEAL_ORPHANED',
      erased: 'STATE_SEAL_ERASED',
      rewritten: 'STATE_SEAL_REWRITTEN',
      unknownArm: 'STATE_SEAL_UNKNOWN_ARM',
    });
  });

  it('check 9: the texts of an update (and so their hashes) are made before its write lock: an evidence entry and a write-once value whose JSON takes the lock on another connection always find it free', async () => {
    const { home, runStore } = await open(testClock(T).clock);
    const { record: run } = await runStore.create(BARE);
    const other = await foreign(home);
    other.exec('PRAGMA busy_timeout = 0');
    const attempts: string[] = [];
    /** `value`, whose JSON first tries the write lock on the other connection, without waiting. */
    const takesTheLock = <V extends object>(value: V): V =>
      ({
        ...value,
        toJSON: () => {
          attempts.push(
            settleSync(() => {
              other.exec('BEGIN IMMEDIATE');
              other.exec('ROLLBACK');
            }),
          );
          return value;
        },
      }) as V;
    const updated = await runStore.update({
      ...run,
      evidence: [takesTheLock(entry(0))],
      workflow_context_snapshots: takesTheLock(contextFiles('v1')),
    });
    // (1) red when an entry's or the field's text is made inside the write (the other connection
    //     then finds the lock held: "database is locked"); (2) prints every attempt's outcome and
    //     what was stored.
    expect({
      attempts,
      stored: stored(other, run.id),
      version: updated.record.version,
    }).toEqual({
      // Each value's JSON is made twice before `BEGIN`: by the limits and by the split.
      attempts: ['ok', 'ok', 'ok', 'ok'],
      stored: {
        version: 1,
        phase: ['running', runPhaseDerivationFingerprint()],
        evidence: [[0, JSON.stringify(entry(0))]],
        fields: [['workflow_context_snapshots', JSON.stringify(contextFiles('v1'))]],
      },
      version: 1,
    });
  });

  it('check 9: an update whose evidence is not an array, and one past the store’s depth limit, are refused before any statement reaches the file', async () => {
    const sent: string[] = [];
    const recording = (real: DatabaseLike): DatabaseLike => ({
      exec: (sql) => {
        sent.push(sql);
        real.exec(sql);
      },
      prepare: (sql) => {
        sent.push(sql);
        return real.prepare(sql);
      },
      close: () => real.close(),
      get isTransaction() {
        return real.isTransaction;
      },
    });
    const { runStore } = await open(testClock(T).clock, {
      openFile: (path) => recording(openDatabase(path)),
    });
    const { record: run } = await runStore.create(BARE);
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) deep = { level: deep };
    const sentBy = async (record: RunRecord): Promise<[string, string[]]> => {
      sent.length = 0;
      const result = await outcome(runStore.update(record));
      return [result, [...sent]];
    };
    // (1) red when either check runs inside the write (a BEGIN IMMEDIATE and its ROLLBACK are then
    //     sent), or the record is let through; (2) prints each refusal and the statements sent.
    expect({
      notAnArray: await sentBy({ ...run, evidence: {} as unknown as EvidenceSnapshot[] }),
      tooDeep: await sentBy({ ...run, params: deep }),
    }).toEqual({
      notAnArray: [`Error: Run ${run.id} is not a run record: its evidence is not an array.`, []],
      tooDeep: ['STATE_STORE_LIMIT_EXCEEDED', []],
    });
  });

  it('check 10: an update made inside a read’s clock reading lands before that read begins, so the read sees it', async () => {
    let hook: (() => void) | undefined;
    const clock: Clock = {
      now: () => {
        const fire = hook;
        hook = undefined;
        fire?.();
        return new Date(T);
      },
      at: () => () => undefined,
    };
    const { runStore } = await open(clock);
    const { record: run } = await runStore.create(BARE);
    hook = () => {
      void runStore.update(run);
    };
    // (1) red when `update` awaits anything before its write (the read then begins first and sees
    //     version 0); (2) prints the version the read saw.
    expect((await runStore.get(run.id)).record.version).toBe(1);
  });
});

describe('#616 unit 12b — claimStep', () => {
  it('check 6: a claim stamps its deadline from the definition (null for an agent’s step, kept null), its since and updated_at from the reading; a step already claimed and a step not eligible are refused with the JSON store’s words', async () => {
    const { runStore } = await open(testClock(T).clock);
    const { record: run } = await runStore.create(BARE);
    const auto = await runStore.claimStep(run.id, 'a', DEF);
    const agent = await runStore.claimStep(run.id, 'c', DEF);
    const claimOf = (record: RunRecord, step: string): unknown => {
      const claim = record.claims?.[step];
      return { keys: Object.keys(claim ?? {}), deadline: claim?.deadline, since: claim?.since };
    };
    const attempt = (step: string): Promise<unknown> =>
      runStore.claimStep(run.id, step, DEF).then(() => 'claimed', refusal);
    expect({
      auto: [claimOf(auto.record, 'a'), auto.record.updated_at, auto.record.in_progress_steps],
      agentKept: claimOf((await runStore.get(run.id)).record, 'c'),
      agentVersion: agent.record.version,
      again: await attempt('a'),
      afterA: await attempt('b'),
      unknown: await attempt('no-such-step'),
    }).toEqual({
      // (1) red when the deadline is not the definition's (an auto step: an hour plus a minute),
      //     `since` or `updated_at` is not the reading, the step is not put in flight, or the
      //     token is missing; (2) prints the claim's keys and stamps.
      auto: [
        {
          keys: ['deadline', 'token', 'since'],
          deadline: '2030-05-06T08:09:09.000Z',
          since: T,
        },
        T,
        ['a'],
      ],
      // (1) red when an agent's step gets a deadline, or a null deadline is not stored as null;
      //     (2) prints the claim read back.
      agentKept: { keys: ['deadline', 'token', 'since'], deadline: null, since: T },
      agentVersion: 2,
      // (1) red when a claim of a step in flight is let through, or its refusal's words or details
      //     are not the JSON store's; (2) prints each refusal.
      again: {
        code: 'STATE_STEP_ALREADY_CLAIMED',
        message: `Step 'a' is already claimed or completed on run '${run.id}'.`,
        details: { runId: run.id, stepName: 'a' },
      },
      afterA: {
        code: 'STATE_STEP_NOT_ELIGIBLE',
        message: `Step 'b' is not eligible for execution on run '${run.id}'.`,
        details: { runId: run.id, stepName: 'b', eligible: [] },
      },
      unknown: {
        code: 'STATE_STEP_NOT_ELIGIBLE',
        message: `Step 'no-such-step' is not eligible for execution on run '${run.id}'.`,
        details: { runId: run.id, stepName: 'no-such-step', eligible: [] },
      },
    });
  });

  it('check 6: on the system clock, a claim names its holder only when a claimant is given (no key at all without one) and stamps since within the call, in the returned record and read back', async () => {
    const { runStore } = await open();
    const { record: run } = await runStore.create(BARE);
    const claimant: Attributed = { by: 'support-bot', by_source: 'stated', channel: 'agent' };
    const before = Date.now();
    const named = await runStore.claimStep(run.id, 'a', DEF, claimant);
    const unnamed = await runStore.claimStep(run.id, 'c', DEF);
    const after = Date.now();
    const back = (await runStore.get(run.id)).record;
    const holderOf = (record: RunRecord, step: string): unknown => {
      const claim = record.claims?.[step];
      const since = Date.parse(claim?.since ?? '');
      return {
        holder: claim !== undefined && 'holder' in claim ? claim.holder : 'no holder key',
        sinceInCall: since >= before && since <= after,
      };
    };
    // (1) red when the holder is not the claimant, or a claim with no claimant carries a `holder`
    //     key (even `undefined`), or `since` is not stamped at the claim; (2) prints each claim's
    //     holder and whether its `since` falls within the call.
    expect({
      named: [holderOf(named.record, 'a'), holderOf(back, 'a')],
      unnamed: [holderOf(unnamed.record, 'c'), holderOf(back, 'c')],
    }).toEqual({
      named: [
        { holder: claimant, sinceInCall: true },
        { holder: claimant, sinceInCall: true },
      ],
      unnamed: [
        { holder: 'no holder key', sinceInCall: true },
        { holder: 'no holder key', sinceInCall: true },
      ],
    });
  });
});

describe('#616 unit 12b — the reading, the floor, the key order, the phase columns', () => {
  it('check 2: update and claimStep each spend one reading, also when refused; on a missing run they spend none', async () => {
    const t = testClock(T);
    const { runStore } = await open(t.clock);
    const { record: run } = await runStore.create(BARE);
    const { record: claimable } = await runStore.create(BARE);
    const spent = async (call: () => Promise<unknown>): Promise<[number, string]> => {
      const before = t.reads();
      const result = await outcome(call());
      return [t.reads() - before, result];
    };
    let current = run;
    const update = await spent(async () => {
      current = (await runStore.update(current)).record;
    });
    // (1) red when a call reads the clock a second time, or takes its reading before it has found
    //     the run (a missing run then spends one), or after a check (a refused call then spends
    //     none); (2) prints each call's readings and outcome.
    expect({
      update,
      stale: await spent(() => runStore.update(run)),
      sealRefused: await spent(() =>
        runStore.update({ ...current, terminal_state: true, terminal_reason: 'tck' }),
      ),
      claim: await spent(() => runStore.claimStep(claimable.id, 'a', DEF)),
      claimedAgain: await spent(() => runStore.claimStep(claimable.id, 'a', DEF)),
      notEligible: await spent(() => runStore.claimStep(claimable.id, 'b', DEF)),
      missingUpdate: await spent(() => runStore.update({ ...run, id: 'no-such-run' })),
      missingClaim: await spent(() => runStore.claimStep('no-such-run', 'a', DEF)),
    }).toEqual({
      update: [1, 'ok'],
      stale: [1, 'STATE_SNAPSHOT_MISMATCH'],
      sealRefused: [1, 'STATE_SEAL_UNSTAMPED'],
      claim: [1, 'ok'],
      claimedAgain: [1, 'STATE_STEP_ALREADY_CLAIMED'],
      notEligible: [1, 'STATE_STEP_NOT_ELIGIBLE'],
      missingUpdate: [0, 'STATE_RUN_NOT_FOUND'],
      missingClaim: [0, 'STATE_RUN_NOT_FOUND'],
    });
  });

  it('check 3: after the clock steps back behind a stored stamp, an update’s updated_at and a claim’s since are the stamp capped at the reading plus five seconds, and never before the reading', async () => {
    const t = testClock(T);
    const { runStore } = await open(t.clock);
    const pair = async (instant: string): Promise<[RunRecord, RunRecord]> => {
      t.set(instant);
      return [(await runStore.create(BARE)).record, (await runStore.create(BARE)).record];
    };
    const runs = {
      hourAhead: await pair('2030-05-06T08:08:09.000Z'),
      threeSecondsAhead: await pair('2030-05-06T07:08:12.000Z'),
      hourBehind: await pair('2030-05-06T06:08:09.000Z'),
    };
    t.set(T);
    const stamps = async ([forUpdate, forClaim]: [RunRecord, RunRecord]): Promise<unknown[]> => {
      const updated = await runStore.update(forUpdate);
      const claimed = await runStore.claimStep(forClaim.id, 'a', DEF);
      return [updated.record.updated_at, claimed.record.claims?.['a']?.since];
    };
    // (1) red when a write folds its reading with no record (every row T) or without the cap (the
    //     hour-ahead row 08:08:09); (2) prints each write's stamp.
    expect({
      hourAhead: await stamps(runs.hourAhead),
      threeSecondsAhead: await stamps(runs.threeSecondsAhead),
      hourBehind: await stamps(runs.hourBehind),
    }).toEqual({
      hourAhead: ['2030-05-06T07:08:14.000Z', '2030-05-06T07:08:14.000Z'],
      threeSecondsAhead: ['2030-05-06T07:08:12.000Z', '2030-05-06T07:08:12.000Z'],
      hourBehind: [T, T],
    });
  });

  it('check 11: a record whose evidence, phase and write-once field sit in the middle of its keys reads back after an update and after a claim exactly as the write returned it, key order included', async () => {
    const { runStore } = await open(testClock(T).clock);
    const { record: run } = await runStore.create(BARE);
    const { id, workflow_id, ...rest } = run;
    const middle = {
      id,
      workflow_id,
      workflow_context_snapshots: contextFiles('v1'),
      ...rest,
      evidence: [entry(0)],
    } as RunRecord;
    const keys = Object.keys(middle);
    const updated = await runStore.update(middle);
    const afterUpdate = text(await runStore.get(run.id));
    const claimed = await runStore.claimStep(run.id, 'c', DEF);
    const afterClaim = text(await runStore.get(run.id));
    // (1) red when the stored document is built from a fresh object instead of the record's own
    //     key order (an update), or of the stored document's (a claim); (2) prints both texts.
    expect({
      split: ['evidence', 'run_phase', 'workflow_context_snapshots'].map((k) => keys.indexOf(k)),
      afterUpdate,
      afterClaim,
    }).toEqual({
      split: [11, 8, 2],
      afterUpdate: text(updated),
      afterClaim: text(claimed),
    });
  });

  it('check 12 (and 6, PHASE_IS_GENERATED’s claim leg): an update and a claim re-stamp the phase columns with the derived phase and the derivation’s fingerprint, the claim of an abandoned live run included', async () => {
    const { home, runStore } = await open(testClock(T).clock);
    const { record: run } = await runStore.create(BARE);
    const c = await foreign(home);
    const created = stored(c, run.id).phase;
    // Both columns stale, as an earlier derivation left them: only the update's own re-stamp mends them.
    c.prepare("UPDATE runs SET run_phase = 'completed', phase_version = 'old' WHERE id = ?").run(
      run.id,
    );
    const { record: abandoned } = await runStore.update({
      ...run,
      abandoned_at: '2030-05-06T07:08:09.000Z',
    });
    const afterUpdate = stored(c, run.id).phase;
    // A stale column, as an earlier derivation left it: only the claim's own re-stamp mends it.
    c.prepare("UPDATE runs SET run_phase = 'running', phase_version = 'old' WHERE id = ?").run(
      run.id,
    );
    const claimed = await runStore.claimStep(run.id, 'a', DEF);
    const fingerprint = runPhaseDerivationFingerprint();
    // (1) red when a write leaves the columns as they were (the scan trusts them; `get` derives the
    //     phase itself, so no read shows it) or stamps a fixed phase (`running`); (2) prints the
    //     columns a second connection sees after each write, and the phase each write returned.
    expect({
      created,
      afterUpdate,
      afterClaim: stored(c, run.id).phase,
      returned: [abandoned.run_phase, claimed.record.run_phase, claimed.record.terminal_state],
    }).toEqual({
      created: ['running', fingerprint],
      afterUpdate: ['abandoned', fingerprint],
      afterClaim: ['abandoned', fingerprint],
      returned: ['abandoned', 'abandoned', false],
    });
  });
});

describe('#616 unit 12b — the COMMIT outcome of an update and of a claim', () => {
  /** A home whose store connection can fail its next COMMIT, and the run to write. */
  async function armed(
    first: 'run' | 'rollback',
    alsoBump = false,
  ): Promise<{ runStore: Opened['runStore']; run: RunRecord; fired(): number }> {
    const files = faultyFiles(openDatabase);
    const { home, runStore } = await open(testClock(T).clock, { openFile: files.openFile });
    const { record: run } = await runStore.create(BARE);
    const other = await foreign(home);
    const connection = files.opened.at(-1)!;
    connection.arm({
      at: (sql) => sql === 'COMMIT',
      times: 1,
      first,
      // Another writer moves the run on before the store can read its write back.
      ...(alsoBump
        ? {
            also: () => {
              other
                .prepare(
                  "UPDATE runs SET record = json_set(record, '$.version', json_extract(record, '$.version') + 1) WHERE id = ?",
                )
                .run(run.id);
            },
          }
        : {}),
      error: SQLITE.ioError,
    });
    return { runStore, run, fired: () => connection.hits() };
  }

  type Write = (s: Opened['runStore'], run: RunRecord) => Promise<Snapshot>;
  const WRITES: Record<'update' | 'claimStep', Write> = {
    update: (s, run) => s.update(run),
    claimStep: (s, run) => s.claimStep(run.id, 'a', DEF),
  };

  it('check 8: a COMMIT that reports an error after the rows reached the file answers landed: the write resolves and reads back', async () => {
    const answers: Record<string, unknown> = {};
    for (const [name, write] of Object.entries(WRITES)) {
      const { runStore, run, fired } = await armed('run');
      const written = await write(runStore, run);
      answers[name] = [text(await runStore.get(run.id)) === text(written), fired()];
    }
    // (1) red when the write's check does not find the stored text it wrote (the protocol then
    //     answers not_landed and the write rejects); (2) prints, per write, whether it read back
    //     equal and the fault's firings.
    expect(answers).toEqual({ update: [true, 1], claimStep: [true, 1] });
  });

  it('check 8: a COMMIT that reports an error after SQLite rolled it back answers not_landed: the write rejects and the run is as it was', async () => {
    const answers: Record<string, unknown> = {};
    for (const [name, write] of Object.entries(WRITES)) {
      const { runStore, run, fired } = await armed('rollback');
      const result = await write(runStore, run).then(
        () => 'written',
        (err: WithCommitOutcome) => [err.message, err.commitOutcome],
      );
      answers[name] = [result, (await runStore.get(run.id)).record.version, fired()];
    }
    const notLanded = ['disk I/O error (SQLite error 10)', { outcome: 'not_landed', errcode: 10 }];
    // (1) red when the write's check answers that the write is there without finding it (the
    //     protocol then answers landed and the write resolves); (2) prints, per write, the
    //     outcome, the stored version and the fault's firings.
    expect(answers).toEqual({ update: [notLanded, 0, 1], claimStep: [notLanded, 0, 1] });
  });

  it('check 8: a COMMIT that reports an error after the rows reached the file, when another writer has moved the run on, answers unknown: the write rejects and writes are fenced', async () => {
    const answers: Record<string, unknown> = {};
    for (const [name, write] of Object.entries(WRITES)) {
      const { runStore, run, fired } = await armed('run', true);
      const result = await write(runStore, run).then(
        () => 'written',
        (err: WithCommitOutcome) => [describeError(err), err.commitOutcome],
      );
      answers[name] = [result, (await runStore.get(run.id)).record.version, fired()];
    }
    const unknown = ['STATE_STORE_WRITES_FENCED', { outcome: 'unknown', errcode: 10 }];
    // (1) red when the write's check answers by the version alone (a newer version is then read as
    //     "not there", not_landed) or says landed; (2) prints, per write, the outcome, the stored
    //     version (ours plus the other writer's) and the fault's firings.
    expect(answers).toEqual({ update: [unknown, 2, 1], claimStep: [unknown, 2, 1] });
  });
});

describe('#616 unit 12b — racers in separate processes', () => {
  const INDEX = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'index.js')).href;
  /**
   * One racer: opens the home, waits for the start instant, writes once, and prints `ok`, or its
   * refusal's code and the keys of its details (the store's own refusals carry details; the file's
   * guards' carry none, so the two cannot be mistaken for each other).
   */
  const RACER =
    `import { openRealmHome } from ${JSON.stringify(INDEX)};` +
    'const p = JSON.parse(process.env.U12B_RACE);' +
    'const home = await openRealmHome({ home: p.home });' +
    'while (Date.now() < p.start) {}' +
    'try {' +
    ' if (p.kind === "claim") await home.runStore.claimStep(p.runId, "a", p.definition);' +
    ' else await home.runStore.update(p.record);' +
    ' console.log("ok");' +
    '} catch (e) {' +
    ' console.log(String(e.code ?? e.message) + " " + JSON.stringify(Object.keys(e.details ?? {})));' +
    '} finally { home.close(); }';
  const RACERS = 7;

  /** Starts `RACERS` processes on `plan` at once; resolves with each one's exit status and output. */
  function race(
    plan: Record<string, unknown>,
  ): Promise<Array<{ status: number | null; out: string }>> {
    const env = JSON.stringify({ ...plan, start: Date.now() + 4_000 });
    const one = (): Promise<{ status: number | null; out: string }> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', RACER], {
          env: { ...process.env, U12B_RACE: env },
          timeout: 60_000,
        });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.on('close', (status) => resolve({ status, out: out.trim() }));
      });
    return Promise.all(Array.from({ length: RACERS }, one));
  }

  /** How many racers printed each outcome, and any that did not exit cleanly. */
  function tally(results: Array<{ status: number | null; out: string }>): unknown {
    const counts: Record<string, number> = {};
    for (const r of results) counts[r.out] = (counts[r.out] ?? 0) + 1;
    return { counts, failed: results.filter((r) => r.status !== 0) };
  }

  it('check 7: seven processes claim one step at once: exactly one wins, the other six are refused as already claimed', async () => {
    const { home, runStore } = await open();
    const { record: run } = await runStore.create(BARE);
    const results = await race({ home, kind: 'claim', runId: run.id, definition: DEF });
    const after = (await runStore.get(run.id)).record;
    // (1) red when a claim reads the run outside its write transaction (the racers then all pass
    //     the guard and the losers are refused by the file's version guard: STATE_SNAPSHOT_MISMATCH
    //     with no details), or two claims both win; (2) prints how many racers printed each outcome,
    //     any racer that did not exit cleanly, and the run's state after.
    expect({
      ...(tally(results) as object),
      after: [after.in_progress_steps, after.version],
    }).toEqual({
      counts: { ok: 1, 'STATE_STEP_ALREADY_CLAIMED ["runId","stepName"]': 6 },
      failed: [],
      after: [['a'], 1],
    });
  }, 120_000); // it starts 7 Node processes

  it('check 7: seven processes update one run at one version at once: exactly one commits, the other six are refused with a version conflict', async () => {
    const { home, runStore } = await open();
    const { record: run } = await runStore.create(BARE);
    const results = await race({ home, kind: 'update', record: run });
    // (1) red when an update does not check the stored version inside its write transaction (the
    //     losers are then refused by the file's version guard, whose refusal carries no details), or
    //     two commit; (2) prints how many racers printed each outcome, any racer that did not exit
    //     cleanly, and the stored version after.
    expect({
      ...(tally(results) as object),
      version: (await runStore.get(run.id)).record.version,
    }).toEqual({
      counts: { ok: 1, 'STATE_SNAPSHOT_MISMATCH ["runId","expected","actual"]': 6 },
      failed: [],
      version: 1,
    });
  }, 120_000); // it starts 7 Node processes
});

describe('#616 unit 12b — the writer', () => {
  it('the writer is all or nothing by its own savepoint: when its third new entry is refused inside a transaction its caller holds and goes on with, no earlier row remains and the run is not updated (authorized by MA 3)', async () => {
    const { home, runStore } = await open(testClock(T).clock);
    const { record: run } = await runStore.create(BARE);
    const { record: current } = await runStore.update({ ...run, evidence: [entry(0)] });
    const next = splitRunRecord({
      ...current,
      evidence: [entry(0), entry(1), entry(2), entry(3)],
      version: current.version + 1,
    });
    const c = await foreign(home);
    // The third new entry (seq 3) is refused by a trigger of this connection only.
    c.exec(
      'CREATE TEMP TRIGGER refuse_third_new BEFORE INSERT ON main.evidence WHEN new.seq = 3 ' +
        "BEGIN SELECT RAISE(ABORT, 'the test refuses the third new entry'); END",
    );
    c.exec('BEGIN IMMEDIATE');
    const failed = settleSync(() => writeRunUpdate(c, run.id, next.core, { prepared: next }));
    const inTransaction = {
      evidence: stored(c, run.id).evidence.length,
      version: stored(c, run.id).version,
      open: c.isTransaction,
    };
    c.exec('ROLLBACK');
    // (1) red when the writer has no savepoint of its own (the UPDATE and the first two new rows
    //     then stay in the caller's transaction); (2) prints the error and what the caller's
    //     transaction holds after it.
    expect({ failed, inTransaction }).toEqual({
      failed: 'Error: the test refuses the third new entry',
      inTransaction: { evidence: 1, version: 1, open: true },
    });
  });
});
