// run-store-settle-616.test.ts — issue #616 PR-1a unit 13a: the run store settles one change of a run
// (`SqliteRunStore.settleStep`, all nine delta kinds, through the shared writer and its `appended`
// evidence), on real homes in a temp directory, through `openRealmHome`. The real cases: the engine
// settling each kind of change (a step, a gate opened, answered and expired, a guard, a released step,
// a finalizer leased and marked, a run sealed); a settle core's transform refuses; a stale seal; a
// guard a settle makes eligible, and one that guard makes eligible; a run with many earlier entries;
// a delta past the store's limits; a stored run whose seal markers disagree with its stamp; a COMMIT
// that fails after or before its rows reached the file, or after another writer moved on; five
// processes settling one step at once; the engine admitting the store.
//
// Since unit 16 the shared laws that cover the settle ground also run against this store
// (`contract-settlement-616.test.ts`: every law of the settlement contract, among them
// `GUARD_CASCADE_ONE_WRITE`, `GUARD_CASCADE_TOTAL`, `TRANSFORM_FIDELITY`, `PHASE_IS_GENERATED`,
// `REFUSAL_SWEEP`, the gate, guard, release and finalizer families and
// `SEAL_RUN_NEEDS_NO_DEFINITION`; `contract-clock-616.test.ts`: `SETTLE_ONE_READING`,
// `OPEN_GATE_MINTS_AT_AT`, `LATE_ANSWER_ONE_WRITE` and `SEAL_RUN_ONE_WRITE`). This file builds no
// copy of their cases. These cells stay for what no shared law sees: the rows and text a write
// leaves, the exact refusals and their words, and the COMMIT protocol.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  abandonRun,
  applySettlement,
  deriveRunPhase,
  runPhaseDerivationFingerprint,
  WorkflowError,
  type Clock,
  type EvidenceSnapshot,
  type OpeningGate,
  type RunRecord,
  type SealRunDelta,
  type SettlementDelta,
  type SettleStepDelta,
  type StepDefinition,
  type StoreSettlement,
  type WorkflowContextSnapshot,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import type { WithCommitOutcome } from './connection.js';
import { openDatabase, type DatabaseLike } from './driver.js';
import { evidenceEntrySha256 } from './evidence-hash.js';
import { openRealmHome } from './index.js';
import type { OpenSeams } from './open-file.js';
import { openHome, type RealmHome } from './open-realm-home.js';
import {
  assertRunRecordWithinLimits,
  insertRunRecord,
  prepareSettlementWrite,
  writeRunUpdate,
} from './run-rows.js';
import { faultyFiles, SQLITE } from './test-support/commit-faults.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The instant the cells' clocks start at. */
const T = '2030-05-06T07:08:09.000Z';
/** The instant every evidence entry's work happened at: before `T`, so it folds nothing in. */
const EARLIER = '2030-05-06T07:00:00.000Z';

const dirs: string[] = [];
const handles: RealmHome[] = [];
const connections: DatabaseLike[] = [];
afterEach(() => {
  for (const c of connections.splice(0)) c.close();
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-u13a-'));
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

/** Another connection on the home's file (a hostile writer, or a second reader). */
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

/** What a call did: `'ok'`, or its refusal as a reader sees it. */
const outcome = (call: Promise<unknown>): Promise<string> => call.then(() => 'ok', describeError);

/** A record as `JSON.stringify` holds it: key order included. */
const text = (record: RunRecord): string => JSON.stringify(record);

/** `'equal'`, or both values when they differ (what a failing table cell prints). */
function same(want: unknown, got: unknown): unknown {
  return JSON.stringify(want) === JSON.stringify(got) ? 'equal' : { want, got };
}

/** One evidence entry of `step`, its work done at `EARLIER`. */
function evidenceOf(step: string, extra: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot {
  return {
    step_id: step,
    started_at: EARLIER,
    completed_at: EARLIER,
    duration_ms: 0,
    input_summary: {},
    output_summary: { answer: `the answer of ${step}` },
    status: 'success',
    evidence_hash: 'e'.repeat(64),
    ...extra,
  };
}

/** A workflow of agent steps that each run by themselves, plus `extra` steps. */
function agents(
  id: string,
  steps: string[],
  extra: Record<string, StepDefinition> = {},
): WorkflowDefinition {
  const all: Record<string, StepDefinition> = {};
  for (const step of steps) all[step] = { description: step, execution: 'agent', depends_on: [] };
  return { id, name: 'Unit 13a', version: 1, steps: { ...all, ...extra } };
}

/** `a` and its finalizer `fin`, which runs when the run completes. */
const FIN = agents('wf-fin', ['a'], {
  fin: { description: 'fin', execution: 'finalizer', on_outcome: 'complete' },
});

/** The workflow's context files as the engine snapshots them at the run's first step. */
function contextFiles(content: string): Record<string, WorkflowContextSnapshot> {
  return {
    'guide.md': {
      source_path: '/work/guide.md',
      content,
      content_hash: 'cd'.repeat(32),
      loaded_at: EARLIER,
    },
  };
}

/** A gate on `step`, answered `approve` or `reject`. */
function gate(gateId: string, step: string, extra: Partial<OpeningGate> = {}): OpeningGate {
  return {
    gate_id: gateId,
    step_name: step,
    preview: {},
    choices: ['approve', 'reject'],
    ...extra,
  };
}

/** A fresh run of `def`. */
async function created(o: Opened, def: WorkflowDefinition): Promise<RunRecord> {
  return (await o.runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} })).record;
}

/** A fresh run of `def` with `step` claimed: the claimed run and the claim's token. */
async function claimed(
  o: Opened,
  def: WorkflowDefinition,
  step: string,
): Promise<{ run: RunRecord; token: string }> {
  const run = await created(o, def);
  const { record } = await o.runStore.claimStep(run.id, step, def);
  return { run: record, token: tokenOf(record, step) };
}

/** The token of `record`'s claim of `step`. */
function tokenOf(record: RunRecord, step: string): string {
  const token = record.claims?.[step]?.token;
  if (token === undefined) throw new Error(`The claim of ${step} carries no token.`);
  return token;
}

/** The settlement of claimed step `step`, completed with one entry. */
function settled(step: string, token: string, entry = evidenceOf(step)): SettleStepDelta {
  return { kind: 'settle_step', step, outcome: 'complete', claimToken: token, evidence: [entry] };
}

/** A seal of a live run at `version`, releasing its claims. */
function seal(version: number): SealRunDelta {
  return {
    kind: 'seal_run',
    arm: 'abandon_requested',
    reason: 'the operator abandoned it',
    expected_version: version,
    release_claims: true,
  };
}

/** Settles `delta` (a seal takes no definition). */
function settleOn(
  o: Opened,
  runId: string,
  delta: SettlementDelta,
  def?: WorkflowDefinition,
): Promise<StoreSettlement> {
  return delta.kind === 'seal_run'
    ? o.runStore.settleStep(runId, delta)
    : o.runStore.settleStep(runId, delta, def!);
}

/** The `runs` columns a second connection reads: the phase index, the generated columns, version. */
function columns(c: DatabaseLike, id: string): Record<string, unknown> {
  const row = c
    .prepare(
      'SELECT run_phase, phase_version, terminal_state, sealed_by_arm, updated_at, pending_gate_id, version FROM runs WHERE id = ?',
    )
    .get(id)!;
  return {
    run_phase: row['run_phase'],
    phase_version: row['phase_version'],
    terminal_state: Number(row['terminal_state']),
    sealed_by_arm: row['sealed_by_arm'],
    updated_at: row['updated_at'],
    pending_gate_id: row['pending_gate_id'],
    version: Number(row['version']),
  };
}

/** What those columns hold for `run`, by the derivation and the record itself. */
function columnsOf(run: RunRecord): Record<string, unknown> {
  return {
    run_phase: deriveRunPhase(run),
    phase_version: runPhaseDerivationFingerprint(),
    terminal_state: run.terminal_state ? 1 : 0,
    sealed_by_arm: run.sealed_by?.arm ?? null,
    updated_at: run.updated_at,
    pending_gate_id: run.pending_gate?.gate_id ?? null,
    version: run.version,
  };
}

/** What a second connection sees of a run: its row's text, phase columns and evidence rows. */
function rows(c: DatabaseLike, id: string): unknown {
  const row = c.prepare('SELECT record, run_phase, phase_version FROM runs WHERE id = ?').get(id);
  return {
    runs: [row?.['record'], row?.['run_phase'], row?.['phase_version']],
    evidence: c
      .prepare('SELECT seq, entry, entry_sha256 FROM evidence WHERE run_id = ? ORDER BY seq')
      .all(id)
      .map((r) => [Number(r['seq']), String(r['entry']), String(r['entry_sha256'])]),
    blobs: c
      .prepare('SELECT name, value FROM run_blobs WHERE run_id = ? ORDER BY name')
      .all(id)
      .map((r) => [String(r['name']), String(r['value'])]),
  };
}

/**
 * A stored terminal run stamped `complete` whose markers disagree with its stamp, with its finalizer
 * pending: `aborted_at` set and no `terminal_reason`, which the boundary reads as a guard's abort.
 * Written by another connection through `insertRunRecord` inside its own `BEGIN IMMEDIATE`, since
 * the store itself refuses such a record. (With the completed run's own `terminal_reason` kept, the
 * boundary cannot place the record, so it does not refuse: pinned from the real code.)
 */
async function incoherentSeal(o: Opened): Promise<RunRecord> {
  const { run, token } = await claimed(o, FIN, 'a');
  const done = await o.runStore.settleStep(run.id, settled('a', token), FIN);
  const { terminal_reason: _reason, ...stamped } = done.run;
  const seed: RunRecord = {
    ...stamped,
    id: randomUUID(),
    aborted_at: { step_id: 'a', abort_message: 'aborted after it completed' },
  };
  const c = await foreign(o.home);
  c.exec('BEGIN IMMEDIATE');
  insertRunRecord(c, seed);
  c.exec('COMMIT');
  return seed;
}

/** A finalizer lease for `fin`. */
const LEASE: SettlementDelta = {
  kind: 'lease_finalizer',
  finalizer: 'fin',
  leaseToken: 'lease-1',
  leaseSeconds: 60,
};

describe('#616 unit 13a — settleStep, every kind', () => {
  it('check 1: one applied settle of each of the nine kinds returns the run get() then reads, key for key, with the version moved by one and the phase and generated columns re-stamped', async () => {
    const t = testClock(T);
    const o = await open(t.clock);
    const c = await foreign(o.home);
    const GATED = agents('wf-gated', ['gated']);
    const LATER = agents('wf-later', ['gated', 'later']);
    const TWO = agents('wf-two', ['a', 'b']);
    const GUARD = agents('wf-guard', [], {
      g: { description: 'g', execution: 'guard', abort_unless: [] },
    });
    // Each case: the run before, and its settle. Run in this order: the expiry moves the clock.
    const cases: Array<[string, () => Promise<[RunRecord, StoreSettlement]>]> = [
      [
        'settle_step',
        async () => {
          const { run, token } = await claimed(o, agents('wf-a', ['a']), 'a');
          return [run, await settleOn(o, run.id, settled('a', token), agents('wf-a', ['a']))];
        },
      ],
      [
        'release_step',
        async () => {
          const { run, token } = await claimed(o, TWO, 'a');
          const delta: SettlementDelta = { kind: 'release_step', step: 'a', claimToken: token };
          return [run, await settleOn(o, run.id, delta, TWO)];
        },
      ],
      [
        'open_gate',
        async () => {
          const { run, token } = await claimed(o, GATED, 'gated');
          const delta: SettlementDelta = {
            kind: 'open_gate',
            step: 'gated',
            claimToken: token,
            pendingGate: gate('gate-open', 'gated'),
            timeoutSeconds: 600,
            evidence: [evidenceOf('gated')],
          };
          return [run, await settleOn(o, run.id, delta, GATED)];
        },
      ],
      [
        'settle_gate',
        async () => {
          const { run, token } = await claimed(o, GATED, 'gated');
          const opened = await settleOn(
            o,
            run.id,
            {
              kind: 'open_gate',
              step: 'gated',
              claimToken: token,
              pendingGate: gate('gate-answer', 'gated'),
              evidence: [],
            },
            GATED,
          );
          const delta: SettlementDelta = {
            kind: 'settle_gate',
            gateId: 'gate-answer',
            choice: 'approve',
            evidence: [evidenceOf('gated')],
          };
          return [opened.run, await settleOn(o, run.id, delta, GATED)];
        },
      ],
      [
        'settle_guard',
        async () => {
          const run = await created(o, GUARD);
          const delta: SettlementDelta = {
            kind: 'settle_guard',
            step: 'g',
            outcome: 'pass',
            evidence: evidenceOf('g'),
          };
          return [run, await settleOn(o, run.id, delta, GUARD)];
        },
      ],
      [
        'lease_finalizer',
        async () => {
          const { run, token } = await claimed(o, FIN, 'a');
          const done = await settleOn(o, run.id, settled('a', token), FIN);
          return [done.run, await settleOn(o, run.id, LEASE, FIN)];
        },
      ],
      [
        'mark_finalizer',
        async () => {
          const { run, token } = await claimed(o, FIN, 'a');
          await settleOn(o, run.id, settled('a', token), FIN);
          const leased = await settleOn(o, run.id, LEASE, FIN);
          const delta: SettlementDelta = {
            kind: 'mark_finalizer',
            finalizer: 'fin',
            leaseToken: 'lease-1',
            result: 'completed',
            evidence: evidenceOf('fin'),
          };
          return [leased.run, await settleOn(o, run.id, delta, FIN)];
        },
      ],
      [
        'seal_run',
        async () => {
          const run = await created(o, TWO);
          return [run, await settleOn(o, run.id, seal(run.version))];
        },
      ],
      [
        'expire_gate',
        async () => {
          const { run, token } = await claimed(o, LATER, 'gated');
          const opened = await settleOn(
            o,
            run.id,
            {
              kind: 'open_gate',
              step: 'gated',
              claimToken: token,
              pendingGate: gate('gate-expire', 'gated', {
                on_expiry: 'settle_default',
                default_choice: 'approve',
              }),
              timeoutSeconds: 600,
              evidence: [],
            },
            LATER,
          );
          t.set('2030-05-06T07:28:09.000Z'); // twenty minutes on: the gate is ten minutes overdue
          const delta: SettlementDelta = { kind: 'expire_gate', gateId: 'gate-expire' };
          return [opened.run, await settleOn(o, run.id, delta, LATER)];
        },
      ],
    ];
    const table: Record<string, unknown> = {};
    for (const [kind, settle] of cases) {
      const [before, result] = await settle();
      const read = (await o.runStore.get(result.run.id)).record;
      table[kind] = {
        applied: result.applied,
        phase: deriveRunPhase(result.run),
        readsBack: same(text(result.run), text(read)),
        version: result.run.version - before.version,
        columns: same(columnsOf(result.run), columns(c, result.run.id)),
      };
    }
    // (1) red when the stored core document is a patch of the stored one rather than the split of
    //     the returned run (the key order then differs from the transform's), or the phase columns
    //     are not re-stamped in the write; (2) prints, per kind, whether it applied, its derived
    //     phase, the returned and read-back texts when they differ, the version step and the columns
    //     wanted and read when they differ.
    const ok = (phase: string): unknown => ({
      applied: true,
      phase,
      readsBack: 'equal',
      version: 1,
      columns: 'equal',
    });
    expect(table).toEqual({
      settle_step: ok('completed'),
      release_step: ok('running'),
      open_gate: ok('gate_waiting'),
      settle_gate: ok('completed'),
      settle_guard: ok('completed'),
      lease_finalizer: ok('completed'),
      mark_finalizer: ok('completed'),
      seal_run: ok('abandoned'),
      expire_gate: ok('running'),
    });
  });
});

describe('#616 unit 13a — the reading', () => {
  it('check 2: a settle spends one reading on every outcome (a returned refusal, an applied write, a stale seal thrown, a seal boundary thrown) and none on a missing run', async () => {
    const t = testClock(T);
    const o = await open(t.clock);
    const TWO = agents('wf-two', ['a', 'b']);
    const { run, token } = await claimed(o, TWO, 'a');
    const incoherent = await incoherentSeal(o);
    const reads = async (call: () => Promise<StoreSettlement>): Promise<unknown> => {
      const before = t.reads();
      const result = await call().then(
        (r) => (r.applied ? 'applied' : `returned ${r.reason}`),
        describeError,
      );
      return [result, t.reads() - before];
    };
    const counts = {
      missing: await reads(() => o.runStore.settleStep('no-such-run', seal(0))),
      applied: await reads(() => settleOn(o, run.id, settled('a', token), TWO)),
      refused: await reads(() => settleOn(o, run.id, settled('a', token), TWO)),
      moved: await reads(() => settleOn(o, run.id, seal(0))),
      sealBoundary: await reads(() => settleOn(o, incoherent.id, LEASE, FIN)),
    };
    // (1) red when the reading is taken before the run is found (the missing run then spends one),
    //     or a second reading is taken on any outcome; (2) prints, per outcome, what the settle did
    //     and the readings it spent.
    expect(counts).toEqual({
      missing: ['STATE_RUN_NOT_FOUND', 0],
      applied: ['applied', 1],
      refused: ['returned already_settled', 1],
      moved: ['STATE_SNAPSHOT_MISMATCH', 1],
      sealBoundary: ['STATE_SEAL_INCOHERENT', 1],
    });
  });

  it('check 2: a settle whose delta carries an event instant ahead of the reading is stamped at that instant, and a returned refusal returns its reading', async () => {
    const o = await open(testClock(T).clock);
    const TWO = agents('wf-two', ['a', 'b']);
    const { run, token } = await claimed(o, TWO, 'a');
    const ahead = '2030-05-06T08:08:09.000Z'; // an hour after the reading
    const applied = await settleOn(
      o,
      run.id,
      settled('a', token, evidenceOf('a', { completed_at: ahead })),
      TWO,
    );
    const refused = await settleOn(o, run.id, settled('a', token), TWO);
    // (1) red when the settle stamps the raw reading without folding the delta's instants in, or a
    //     returned refusal carries no reading; (2) prints each result's `at` and the stamp written.
    expect({
      applied: [applied.at.toISOString(), applied.run.updated_at],
      refused: [refused.applied, refused.at.toISOString()],
    }).toEqual({
      applied: [ahead, ahead],
      // The run is now stamped an hour ahead, so the refusal's reading is floored by that stamp,
      // capped at the reading plus five seconds.
      refused: [false, '2030-05-06T07:08:14.000Z'],
    });
  });
});

describe('#616 unit 13a — refusals', () => {
  it('check 3: a settle core’s transform refuses is returned with the run as read and the reading, and writes nothing', async () => {
    const o = await open(testClock(T).clock);
    const c = await foreign(o.home);
    const TWO = agents('wf-two', ['a', 'b']);
    const { run, token } = await claimed(o, TWO, 'a');
    await settleOn(o, run.id, settled('a', token), TWO);
    const before = rows(c, run.id);
    const read = (await o.runStore.get(run.id)).record;
    const result = await settleOn(o, run.id, settled('a', token), TWO);
    // (1) red when a refusal is thrown instead of returned, or written (the version then moves and
    //     the row changes); (2) prints the result's shape, whether its run is the run as read, its
    //     reading, and whether the rows changed.
    expect({
      applied: result.applied,
      reason: result.applied ? undefined : result.reason,
      run: same(text(read), text(result.run)),
      at: result.at.toISOString(),
      rows: same(before, rows(c, run.id)),
    }).toEqual({
      applied: false,
      reason: 'already_settled',
      run: 'equal',
      at: T,
      rows: 'equal',
    });
  });

  it('check 3: a seal at a version the run has moved past is thrown as core’s version conflict, and writes nothing', async () => {
    const o = await open(testClock(T).clock);
    const c = await foreign(o.home);
    const TWO = agents('wf-two', ['a', 'b']);
    const { run } = await claimed(o, TWO, 'a');
    const before = rows(c, run.id);
    const thrown = await settleOn(o, run.id, seal(0)).then(
      () => 'settled',
      (err: WorkflowError) => ({ code: err.code, message: err.message, details: err.details }),
    );
    // (1) red when the `moved` refusal is returned instead of thrown, or written; (2) prints the
    //     refusal (code, sentence, details) and whether the rows changed.
    expect({ thrown, rows: same(before, rows(c, run.id)) }).toEqual({
      thrown: {
        code: 'STATE_SNAPSHOT_MISMATCH',
        message: 'Version conflict — run was modified by another process',
        details: { runId: run.id, expected: 0, actual: 1 },
      },
      rows: 'equal',
    });
  });
});

describe('#616 unit 13a — guards in the same write', () => {
  it('check 4: a settle that makes a guard eligible settles it in the same write, and the guard that one makes eligible too: one version step, the guards’ evidence in the same rows', async () => {
    const o = await open(testClock(T).clock);
    const c = await foreign(o.home);
    // a → g1 → g2 → b: settling `a` makes g1 eligible; g1 passing makes g2 eligible.
    const CHAIN = agents('wf-chain', ['a'], {
      g1: {
        description: 'g1',
        execution: 'guard',
        abort_unless: ['a.ok == true'],
        depends_on: ['a'],
      },
      g2: {
        description: 'g2',
        execution: 'guard',
        abort_unless: ['a.ok == true'],
        depends_on: ['g1'],
      },
      b: { description: 'b', execution: 'agent', depends_on: ['g2'] },
    });
    const { run, token } = await claimed(o, CHAIN, 'a');
    const result = await settleOn(
      o,
      run.id,
      settled('a', token, evidenceOf('a', { output_summary: { ok: true } })),
      CHAIN,
    );
    const evidenceSteps = c
      .prepare('SELECT entry FROM evidence WHERE run_id = ? ORDER BY seq')
      .all(run.id)
      .map((r) => (JSON.parse(String(r['entry'])) as EvidenceSnapshot).step_id);
    // (1) red when the store settles without `cascadeGuards` (the guards are then left for later:
    //     none listed, none completed, no guard evidence); (2) prints the guards listed, the steps
    //     completed, the version step and the steps of the stored evidence rows.
    expect({
      guards: result.applied ? result.guards?.map((g) => `${g.step}:${g.outcome}`) : result.reason,
      completed: result.run.completed_steps,
      version: result.run.version - run.version,
      evidenceSteps,
    }).toEqual({
      guards: ['g1:pass', 'g2:pass'],
      completed: ['a', 'g1', 'g2'],
      version: 1,
      evidenceSteps: ['a', 'g1', 'g2'],
    });
  });
});

describe('#616 unit 13a — evidence and the write-once value', () => {
  /** A run with `count` earlier entries and a write-once value, its step `a` claimed. */
  async function withHistory(
    o: Opened,
    count: number,
  ): Promise<{ run: RunRecord; token: string; def: WorkflowDefinition }> {
    const def = agents('wf-history', ['a', 'b']);
    const run = await created(o, def);
    const earlier = Array.from({ length: count }, (_, i) =>
      evidenceOf('x', { input_summary: { i } }),
    );
    await o.runStore.update({
      ...run,
      evidence: earlier,
      workflow_context_snapshots: contextFiles('the guide'),
    });
    const { record } = await o.runStore.claimStep(run.id, 'a', def);
    return { run: record, token: tokenOf(record, 'a'), def };
  }

  it('check 5 (a): on a run with 200 earlier entries a settle reads none of them back to compare: its statements are the read of the run, the UPDATE and the INSERT of its one new entry', async () => {
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
    const o = await open(testClock(T).clock, { openFile: (path) => recording(openDatabase(path)) });
    const { run, token, def } = await withHistory(o, 200);
    sent.length = 0;
    const result = await settleOn(o, run.id, settled('a', token), def);
    // (1) red when the settle takes the content path (a SELECT of the stored hashes and of the
    //     stored write-once values is then sent), or writes other rows; (2) prints every statement
    //     the settle sent.
    expect({ applied: result.applied, sent }).toEqual({
      applied: true,
      sent: [
        // The primitive's own statements (unit 8): the read-only check, and the schema's version.
        'PRAGMA query_only',
        'BEGIN IMMEDIATE',
        'PRAGMA user_version',
        'SELECT record FROM runs WHERE id = ?',
        'SELECT seq, entry FROM evidence WHERE run_id = ? ORDER BY seq',
        'SELECT name, value FROM run_blobs WHERE run_id = ?',
        'SAVEPOINT realm_update_run',
        'UPDATE runs SET record = ?, run_phase = ?, phase_version = ? WHERE id = ?',
        'INSERT INTO evidence (run_id, seq, entry, entry_sha256) VALUES (?, ?, ?, ?)',
        'RELEASE realm_update_run',
        'COMMIT',
      ],
    });
  });

  it('check 5 (c): the new entry a settle appends is stored as its text with that text’s hash, so the next update of the returned run compares equal and is written', async () => {
    const o = await open(testClock(T).clock);
    const c = await foreign(o.home);
    const { run, token, def } = await withHistory(o, 3);
    const result = await settleOn(o, run.id, settled('a', token), def);
    const stored = c
      .prepare('SELECT seq, entry, entry_sha256 FROM evidence WHERE run_id = ? AND seq >= 3')
      .all(run.id)
      .map((r) => [Number(r['seq']), String(r['entry']), String(r['entry_sha256'])]);
    const written = JSON.stringify(result.run.evidence[3]) ?? 'null';
    // (1) red when the appended entry's hash is made of anything but its stored text by the
    //     package's one hash (the update then finds a stored hash that differs and refuses it);
    //     (2) prints the stored rows wanted and read, and the update's outcome.
    expect({
      stored,
      update: await outcome(o.runStore.update(result.run)),
    }).toEqual({
      stored: [[3, written, evidenceEntrySha256(written)]],
      update: 'ok',
    });
  });

  /**
   * A run with two earlier entries and a write-once value, `a` claimed; `fresh` as the store reads
   * it; `updated` as core's transform settles `a` and the store stamps it; and a writer that writes a
   * settle's pieces on another connection in its own `BEGIN IMMEDIATE`.
   */
  async function decision(): Promise<{
    fresh: RunRecord;
    updated: RunRecord;
    write(updated: RunRecord): string;
    stored(): unknown;
  }> {
    const o = await open(testClock(T).clock);
    const c = await foreign(o.home);
    const { run, token, def } = await withHistory(o, 2);
    const fresh = (await o.runStore.get(run.id)).record;
    const result = applySettlement(fresh, settled('a', token), def, {
      at: new Date(T),
      cascadeGuards: true,
      storeKeepsClaims: true,
    });
    if (!result.applied) throw new Error(`the transform refused: ${result.reason}`);
    const updated = {
      ...result.run,
      run_phase: deriveRunPhase(result.run),
      version: fresh.version + 1,
    };
    return {
      fresh,
      updated,
      write: (next) => {
        const { core, evidence } = prepareSettlementWrite(fresh, next);
        c.exec('BEGIN IMMEDIATE');
        try {
          writeRunUpdate(c, run.id, core, evidence);
          c.exec('COMMIT');
          return 'ok';
        } catch (err) {
          c.exec('ROLLBACK');
          return describeError(err);
        }
      },
      stored: () => rows(c, run.id),
    };
  }

  /** Which evidence write the decision picks for `updated`. */
  const path = (fresh: RunRecord, updated: RunRecord): string =>
    Object.keys(prepareSettlementWrite(fresh, updated).evidence)[0]!;

  it('check 5 (b): when every stored entry and the write-once value are the very objects read, the decision appends only the new entry', () =>
    decision().then(({ fresh, updated }) => {
      const write = prepareSettlementWrite(fresh, updated);
      // (1) red when the decision takes the content path although nothing was rebuilt; (2) prints
      //     the evidence write it picked.
      expect(write.evidence).toEqual({
        appended: {
          from: 2,
          entries: [
            {
              text: JSON.stringify(updated.evidence[2]),
              sha256: evidenceEntrySha256(JSON.stringify(updated.evidence[2])),
            },
          ],
        },
      });
    }));

  it('check 5 (b): one earlier entry rebuilt with equal content takes the content path and leaves the stored entries as they were', async () => {
    const d = await decision();
    const rebuilt = {
      ...d.updated,
      evidence: d.updated.evidence.map((e, i) => (i === 0 ? structuredClone(e) : e)),
    };
    const before = (d.stored() as { evidence: unknown[] }).evidence;
    const written = d.write(rebuilt);
    const after = (d.stored() as { evidence: unknown[] }).evidence;
    // (1) red when the decision ignores condition (i) (a rebuilt entry is then appended past
    //     without its content checked); (2) prints the path, the write's outcome and the stored
    //     entries before and after.
    expect({
      path: path(d.fresh, rebuilt),
      written,
      prefix: same(before, after.slice(0, 2)),
      count: after.length,
    }).toEqual({
      path: 'prepared',
      written: 'ok',
      prefix: 'equal',
      count: 3,
    });
  });

  it('check 5 (b): one earlier entry rebuilt with other content takes the content path and is refused as rewritten evidence, writing nothing', async () => {
    const d = await decision();
    const changed = {
      ...d.updated,
      evidence: d.updated.evidence.map((e, i) =>
        i === 0 ? { ...e, output_summary: { answer: 'another answer' } } : e,
      ),
    };
    const before = d.stored();
    // (1) red when the decision ignores condition (i) (the changed entry is then not compared and
    //     the write lands); (2) prints the path, the write's outcome and whether the rows changed.
    expect({
      path: path(d.fresh, changed),
      written: d.write(changed),
      rows: same(before, d.stored()),
    }).toEqual({ path: 'prepared', written: 'STATE_EVIDENCE_REWRITTEN', rows: 'equal' });
  });

  it('check 5 (b): fewer entries than stored takes the content path and is refused as rewritten evidence, writing nothing', async () => {
    const d = await decision();
    // The transform drops the second stored entry and its own, and keeps the first by reference.
    const dropped = { ...d.updated, evidence: d.updated.evidence.slice(0, 1) };
    const before = d.stored();
    // (1) red when the decision ignores condition (ii) (the shorter evidence then looks appended to,
    //     with nothing new, and the run's placeholder no longer matches its rows); (2) prints the
    //     path, the write's outcome and whether the rows changed.
    expect({
      path: path(d.fresh, dropped),
      written: d.write(dropped),
      rows: same(before, d.stored()),
    }).toEqual({ path: 'prepared', written: 'STATE_EVIDENCE_REWRITTEN', rows: 'equal' });
  });

  it('check 5 (b): only the write-once value rebuilt with equal content takes the content path and is accepted', async () => {
    const d = await decision();
    const rebuilt = {
      ...d.updated,
      workflow_context_snapshots: structuredClone(d.updated.workflow_context_snapshots!),
    };
    // (1) red when the decision ignores condition (iii) (a rebuilt value is then never compared);
    //     (2) prints the path and the write's outcome.
    expect({ path: path(d.fresh, rebuilt), written: d.write(rebuilt) }).toEqual({
      path: 'prepared',
      written: 'ok',
    });
  });

  it('check 5 (b): a changed write-once value takes the content path and is refused as a rewritten write-once field, writing nothing', async () => {
    const d = await decision();
    const changed = {
      ...d.updated,
      workflow_context_snapshots: contextFiles('another guide'),
    };
    const before = d.stored();
    // (1) red when the decision ignores condition (iii) (the changed value is then never compared
    //     and the write lands with the stored value kept); (2) prints the path, the write's outcome
    //     and whether the rows changed.
    expect({
      path: path(d.fresh, changed),
      written: d.write(changed),
      rows: same(before, d.stored()),
    }).toEqual({ path: 'prepared', written: 'STATE_WRITE_ONCE_REWRITTEN', rows: 'equal' });
  });
});

describe('#616 unit 13a — the limits', () => {
  it('check 6: a delta nested past the store’s depth limit is refused with STATE_STORE_LIMIT_EXCEEDED before any statement reaches the file, and spends no reading', async () => {
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
    const t = testClock(T);
    const o = await open(t.clock, { openFile: (path) => recording(openDatabase(path)) });
    const TWO = agents('wf-two', ['a', 'b']);
    const { run, token } = await claimed(o, TWO, 'a');
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) deep = { level: deep };
    sent.length = 0;
    const reads = t.reads();
    const result = await settleOn(
      o,
      run.id,
      settled('a', token, evidenceOf('a', { output_summary: deep })),
      TWO,
    ).then(
      () => 'settled',
      (err: WorkflowError) => [err.code, err.details?.['limit']],
    );
    // (1) red when the delta is measured inside the write (a BEGIN IMMEDIATE and its ROLLBACK are
    //     then sent, and the reading spent), or not at all; (2) prints the refusal, every statement
    //     sent and the readings spent.
    expect({ result, sent: [...sent], reads: t.reads() - reads }).toEqual({
      result: ['STATE_STORE_LIMIT_EXCEEDED', 'nesting depth'],
      sent: [],
      reads: 0,
    });
  });

  it('check 6: the store’s byte limit measures a delta: one longer than the limit is refused with STATE_STORE_LIMIT_EXCEEDED', () => {
    const delta = settled(
      'a',
      'token',
      evidenceOf('a', { output_summary: { text: 'x'.repeat(500) } }),
    );
    const result = (() => {
      try {
        assertRunRecordWithinLimits(delta, 400);
        return 'within';
      } catch (err) {
        return [(err as WorkflowError).code, (err as WorkflowError).details?.['limit']];
      }
    })();
    // (1) red when the limit does not measure a delta's bytes; (2) prints the outcome.
    expect(result).toEqual(['STATE_STORE_LIMIT_EXCEEDED', 'size in bytes']);
  });
});

describe('#616 unit 13a — the seal boundary', () => {
  it('check 7: a settle of a stored run whose seal markers disagree with its stamp is refused by the seal boundary after its one reading, and writes nothing', async () => {
    const t = testClock(T);
    const o = await open(t.clock);
    const c = await foreign(o.home);
    const incoherent = await incoherentSeal(o);
    const before = rows(c, incoherent.id);
    const reads = t.reads();
    const result = await settleOn(o, incoherent.id, LEASE, FIN).then(
      (r) => (r.applied ? 'applied' : `returned ${r.reason}`),
      describeError,
    );
    // (1) red when the settle skips `assertSealIntegrity` (the lease is then written); (2) prints
    //     the outcome, the readings spent and whether the rows changed.
    expect({
      result,
      reads: t.reads() - reads,
      rows: same(before, rows(c, incoherent.id)),
    }).toEqual({ result: 'STATE_SEAL_INCOHERENT', reads: 1, rows: 'equal' });
  });
});

describe('#616 unit 13a — the COMMIT outcome of a settle', () => {
  /**
   * A home whose store connection can fail its next COMMIT, the statements it sends from then on,
   * and a run (sealed before the fault is armed when `sealed`).
   */
  async function armed(
    first: 'run' | 'rollback',
    { alsoBump = false, sealed = false }: { alsoBump?: boolean; sealed?: boolean } = {},
  ): Promise<{ o: Opened; run: RunRecord; sent: string[]; fired(): number }> {
    const files = faultyFiles(openDatabase);
    const sent: string[] = [];
    const o = await open(testClock(T).clock, {
      openFile: (path) => {
        const real = files.openFile(path);
        return {
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
        };
      },
    });
    const fresh = await created(o, agents('wf-two', ['a', 'b']));
    const run = sealed ? (await settleOn(o, fresh.id, seal(fresh.version))).run : fresh;
    const other = await foreign(o.home);
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
    sent.length = 0;
    return { o, run, sent, fired: () => connection.hits() };
  }

  it('check 8: a COMMIT that reports an error after the settle’s rows reached the file answers landed: the settle resolves and reads back', async () => {
    const { o, run, fired } = await armed('run');
    const result = await settleOn(o, run.id, seal(run.version));
    // (1) red when the settle's check does not find the text it wrote (the protocol then answers
    //     not_landed and the settle rejects); (2) prints whether it read back equal and the fault's
    //     firings.
    expect([text((await o.runStore.get(run.id)).record) === text(result.run), fired()]).toEqual([
      true,
      1,
    ]);
  });

  it('check 8: a COMMIT that reports an error after SQLite rolled the settle back answers not_landed: the settle rejects and the run is as it was', async () => {
    const { o, run, fired } = await armed('rollback');
    const result = await settleOn(o, run.id, seal(run.version)).then(
      () => 'settled',
      (err: WithCommitOutcome) => [err.message, err.commitOutcome],
    );
    // (1) red when the settle's check answers that the write is there without finding it (the
    //     protocol then answers landed and the settle resolves); (2) prints the outcome, the stored
    //     version and the fault's firings.
    expect([result, (await o.runStore.get(run.id)).record.version, fired()]).toEqual([
      ['disk I/O error (SQLite error 10)', { outcome: 'not_landed', errcode: 10 }],
      0,
      1,
    ]);
  });

  it('check 8: a COMMIT that reports an error after the settle’s rows reached the file, when another writer has moved the run on, answers unknown: the settle rejects and writes are fenced', async () => {
    const { o, run, fired } = await armed('run', { alsoBump: true });
    const result = await settleOn(o, run.id, seal(run.version)).then(
      () => 'settled',
      (err: WithCommitOutcome) => [describeError(err), err.commitOutcome],
    );
    // (1) red when the settle's check answers by the version alone (a newer version is then read as
    //     "not there", not_landed) or says landed; (2) prints the outcome, the stored version (ours
    //     plus the other writer's) and the fault's firings.
    expect([result, (await o.runStore.get(run.id)).record.version, fired()]).toEqual([
      ['STATE_STORE_WRITES_FENCED', { outcome: 'unknown', errcode: 10 }],
      2,
      1,
    ]);
  });

  it('check 8: a COMMIT that reports an error after a settle that wrote nothing answers landed without reading the run back: the refusal is returned', async () => {
    // A seal of a run already sealed: core's transform returns it, and nothing is written.
    const { o, run, sent, fired } = await armed('run', { sealed: true });
    const refused = await settleOn(o, run.id, seal(run.version)).then(
      (r) => (r.applied ? 'applied' : `returned ${r.reason}`),
      describeError,
    );
    const afterCommit = sent.slice(sent.indexOf('COMMIT') + 1);
    // (1) red when the settle's check reads the run back although it wrote nothing (a SELECT is
    //     then sent after the COMMIT), or answers false (the refusal then rejects); (2) prints what
    //     the settle did, the statements after its COMMIT and the fault's firings.
    expect({ refused, afterCommit, fired: fired() }).toEqual({
      refused: 'returned already_terminal',
      // The protocol's own read transaction that resolves the outcome (unit 9): the settle's check
      // runs inside it and reads nothing.
      afterCommit: ['BEGIN', 'PRAGMA query_only = ON', 'PRAGMA query_only = OFF', 'COMMIT'],
      fired: 1,
    });
  });
});

describe('#616 unit 13a — racers in separate processes', () => {
  const INDEX = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'index.js')).href;
  /** One racer: opens the home, waits for the start instant, settles once, and prints what it did. */
  const RACER =
    `import { openRealmHome } from ${JSON.stringify(INDEX)};` +
    'const p = JSON.parse(process.env.U13A_RACE);' +
    'const home = await openRealmHome({ home: p.home });' +
    'while (Date.now() < p.start) {}' +
    'try {' +
    ' const r = await home.runStore.settleStep(p.runId, p.delta, p.definition);' +
    ' console.log(r.applied ? "applied" : "returned " + r.reason);' +
    '} catch (e) {' +
    ' console.log("threw " + String(e.code ?? e.message));' +
    '} finally { home.close(); }';
  const RACERS = 5;

  it('check 9: five processes settle one step with the same delta at once: exactly one is applied, the other four get the returned refusal, none throws', async () => {
    const o = await open();
    const TWO = agents('wf-two', ['a', 'b']);
    const { run, token } = await claimed(o, TWO, 'a');
    const env = JSON.stringify({
      home: o.home,
      runId: run.id,
      delta: settled('a', token),
      definition: TWO,
      start: Date.now() + 4_000,
    });
    const one = (): Promise<{ status: number | null; out: string }> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', RACER], {
          env: { ...process.env, U13A_RACE: env },
          timeout: 60_000,
        });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.on('close', (status) => resolve({ status, out: out.trim() }));
      });
    const results = await Promise.all(Array.from({ length: RACERS }, one));
    const counts: Record<string, number> = {};
    for (const r of results) counts[r.out] = (counts[r.out] ?? 0) + 1;
    const after = (await o.runStore.get(run.id)).record;
    // (1) red when the settle reads the run outside its write transaction (the losers are then
    //     refused by the file's version guard: a thrown STATE_SNAPSHOT_MISMATCH), or two apply;
    //     (2) prints how many racers printed each outcome, any racer that did not exit cleanly, and
    //     the run's state after.
    expect({
      counts,
      failed: results.filter((r) => r.status !== 0),
      after: [after.completed_steps, after.version],
    }).toEqual({
      counts: { applied: 1, 'returned already_settled': 4 },
      failed: [],
      after: [['a'], 2],
    });
  }, 120_000); // it starts 5 Node processes
});

describe('#616 unit 13a — the engine admits the store', () => {
  it('check 10: the engine’s full admission accepts the store: abandoning a run that does not exist reaches the store and is refused as not found', async () => {
    const o = await open(testClock(T).clock);
    // (1) red when the store has no settleStep (the admission then refuses it first:
    //     VALIDATION_OPTION_INVALID, `store_settle_step`); (2) prints the refusal.
    expect(await outcome(abandonRun(o.runStore, 'no-such-run'))).toBe('STATE_RUN_NOT_FOUND');
  });
});
