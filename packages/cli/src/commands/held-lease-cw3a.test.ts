// held-lease-cw3a.test.ts — #729 CW-3a (prompt feat-729-cw3a-held-state-lease.md; checks 1, 2, 4, 5, 6,
// 7, the CLI): a step another drive took under a real kernel lease on a SQLite home
// (`claimStepForDrive`, beta; the hold open: held, closed: not held) is named by its lease on every CLI
// door, from the built `realm` run in another process. Held: wait, with `lease_held`'s words first and
// "To free it anyway"; freed only with its stamp, the record naming `lease_held`. Not held: freed as a
// past claim, `realm run advance` exits 1 on it alone. A held lease whose deadline is stamped past
// still waits (FR-01). A no-stamp reclaim that meets a claim re-taken under a held lease is refused,
// never `taken_over`. resume and purge (on the lease double, where a real lease cannot be absent or
// unknown) refuse a lease that cannot be checked, `--force` included.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  WorkflowError,
  claimStepForDrive,
  createDefaultRegistry,
  reclaimStep,
  type LeaseHold,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, createLeaseDouble } from '@sensigo/realm-testing';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';
import { reclaimCommand } from './reclaim.js';
import { resumeRun } from './resume.js';
import { isPurgeEligible } from './purge.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '../../dist/index.js');

/** `a` an agent step not declared idempotent: a drive's claim of it has no deadline. */
const DEF: WorkflowDefinition = {
  id: 'held-lease-cw3a',
  name: 'held-lease-cw3a',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
} as WorkflowDefinition;
const NOT_DECLARED = 'It is not declared idempotent, so running it again may repeat its effects.';
const LEASE_HELD =
  "Its program held the claim's lease when it was checked; if that program is still running, the step runs twice.";
const NOT_HELD =
  "No program held the claim's lease when it was checked; no result is recorded for it.";
const DRIVE = { by: 'other-drive', by_source: 'stated' as const, channel: 'agent' as const };

let h: TempHome & { readonly root: string };
let runStore: RunStore;
let elsewhere: string;
const holds: LeaseHold[] = [];

beforeEach(async () => {
  h = await makeTempHome();
  runStore = h.home.runStore;
  await h.home.workflowStore.register(DEF);
  elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'realm-cw3a-elsewhere-')));
});
afterEach(async () => {
  for (const hold of holds.splice(0)) hold.close();
  vi.restoreAllMocks();
  await h.cleanup();
  rmSync(elsewhere, { recursive: true, force: true });
});

/** The built `realm`, in another process, on the cell's home. */
function realm(args: string[]): { code: number | null; out: string[]; err: string[] } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: elsewhere,
    env: { PATH: process.env['PATH'] ?? '', HOME: h.root, NO_COLOR: '1', REALM_NO_NUDGE: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const lines = (t: string): string[] => t.split('\n').filter((l) => l !== '');
  return { code: r.status, out: lines(r.stdout), err: lines(r.stderr) };
}

/** A run whose step `a` another drive took under a lease it holds (`claimStepForDrive`). */
async function takenByDrive(): Promise<{ runId: string; hold: LeaseHold; since: string }> {
  const { record } = await runStore.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
  const hold = await driveTakes(record.id);
  const since = (await runStore.get(record.id)).record.claims!['a']!.since!;
  return { runId: record.id, hold, since };
}

async function driveTakes(runId: string): Promise<LeaseHold> {
  const answer = await claimStepForDrive(runStore, runId, 'a', {
    definition: DEF,
    registry: createDefaultRegistry(),
    driver: DRIVE,
  });
  if (answer.kind !== 'claimed') throw new Error(`fixture: not claimed: ${JSON.stringify(answer)}`);
  holds.push(answer.hold);
  return answer.hold;
}

const command = (runId: string, since: string): string =>
  `realm run reclaim ${runId} --step a --claimed-at ${since} --force`;

// each cell starts the built CLI up to three times: 30 s a cold start, the budget on the block
describe(
  '#729 CW-3a — checks 1, 2 and 7: realm run advance and the dry run',
  { timeout: 180_000 },
  () => {
    it('check 1, held: advance prints the lease_held line (its condition first, "To free it anyway") and exits 0', async () => {
      const { runId, since } = await takenByDrive();
      const r = realm(['run', 'advance', runId]);
      // (a) red when the claim is classed by its deadline (none: the unknown-age words, "To free
      //     it"); (b) prints the exit and the last line.
      expect({ code: r.code, last: r.out.at(-1) }).toEqual({
        code: 0,
        last: `Nothing is owed to the engine: 'a' is held; wait for it. ${LEASE_HELD} ${NOT_DECLARED} To free it anyway, run: ${command(runId, since)}`,
      });
    });

    it('check 2, not held: advance prints the not-held line and exits 1 on it alone; the dry run’s header is claim_stale, led by the not-held line', async () => {
      const { runId, hold, since } = await takenByDrive();
      hold.close();
      const advanced = realm(['run', 'advance', runId]);
      const dry = realm(['run', 'reclaim', runId]);
      // (a) red when the claim is waited on (exit 0, "wait"), or left on `past` alone (the claim has
      //     no deadline: unknown age); (b) prints both screens.
      expect({
        code: advanced.code,
        last: advanced.out.at(-1),
        dry: dry.out.slice(1, 5),
      }).toEqual({
        code: 1,
        last: `Nothing is owed to the engine: 'a' was claimed, and no program held the claim's lease when it was checked; no result is recorded for it. ${NOT_DECLARED} To free it, run: ${command(runId, since)}`,
        dry: [
          // #729 CW-4b: a leased claim is listed by when it was taken, not its deadline.
          `  • a: claim_stale  (taken at ${since})`,
          `      ${NOT_HELD}`,
          `      ${NOT_DECLARED}`,
          `      To free it, run: ${command(runId, since)}`,
        ],
      });
    });

    it('check 7 (FR-01): a held lease whose claim’s deadline is stamped past waits — advance exits 0', async () => {
      const { runId } = await takenByDrive();
      // Crafted: the hold open, the claim's deadline stamped past (only a library drive of an auto
      // step makes a leased claim with a deadline).
      const { record } = await runStore.get(runId);
      await runStore.update({
        ...record,
        claims: {
          a: { ...record.claims!['a']!, deadline: new Date(Date.now() - 60_000).toISOString() },
        },
      });
      const r = realm(['run', 'advance', runId]);
      // (a) red when the exit rule reads the deadline (a past step alone: exit 1); (b) prints it.
      expect({ code: r.code, waits: r.out.at(-1)?.includes("'a' is held; wait for it.") }).toEqual({
        code: 0,
        waits: true,
      });
    });
  },
);

describe('#729 CW-3a — check 4: the judge, through realm run reclaim', { timeout: 180_000 }, () => {
  it('lease_held: refused without the stamp (fence_required), freed with it, the record naming lease_held; lease_not_held: freed with the old form', async () => {
    const held = await takenByDrive();
    const refused = realm(['run', 'reclaim', held.runId, '--step', 'a', '--force']);
    const freed = realm([
      'run',
      'reclaim',
      held.runId,
      '--step',
      'a',
      '--claimed-at',
      held.since,
      '--force',
    ]);
    const entry = (await runStore.get(held.runId)).record.evidence.at(-1)?.output_summary;
    const notHeld = await takenByDrive();
    notHeld.hold.close();
    const old = realm(['run', 'reclaim', notHeld.runId, '--step', 'a', '--force']);
    // (a) red when a held lease is freed without its stamp, `lease_held` is missing from the record,
    //     or a lease no program held needs the stamp; (b) prints the three answers and the record.
    expect({
      refused: { code: refused.code, err: refused.err },
      freed: { code: freed.code, out: freed.out },
      discharged: (entry?.['conditions_discharged'] as Array<{ code: string }>).map((c) => c.code),
      old: { code: old.code, out: old.out },
    }).toEqual({
      refused: {
        code: 1,
        err: [
          `Step 'a' is claimed since ${held.since}. ${LEASE_HELD} ${NOT_DECLARED} To reclaim this claim, run: ${command(held.runId, held.since)}`,
        ],
      },
      freed: {
        code: 0,
        out: [
          LEASE_HELD,
          NOT_DECLARED,
          `Reclaimed step 'a' of run ${held.runId}: it can run again.`,
        ],
      },
      discharged: ['lease_held', 'rerun_not_idempotent'],
      old: {
        code: 0,
        out: [NOT_DECLARED, `Reclaimed step 'a' of run ${notHeld.runId}: it can run again.`],
      },
    });
  });
});

describe('#729 CW-3a — check 6: never taken_over for a leased claim', { timeout: 120_000 }, () => {
  /**
   * A run whose not-held claim on `a` (the old form frees it) is re-taken by another drive under a
   * held lease between the reclaim's read and its write: the store's `update` takes the claim away and
   * another drive claims `a` before the reclaim's write lands.
   */
  async function raced(): Promise<{ runId: string; since: () => Promise<string> }> {
    const { runId, hold } = await takenByDrive();
    hold.close();
    const update = runStore.update.bind(runStore);
    let first = true;
    vi.spyOn(runStore, 'update').mockImplementation(async (record) => {
      if (first) {
        first = false;
        const { record: now } = await runStore.get(runId);
        await update({ ...now, in_progress_steps: [], claims: {} });
        await driveTakes(runId);
      }
      return update(record);
    });
    return {
      runId,
      since: async () => (await runStore.get(runId)).record.claims!['a']!.since!,
    };
  }

  it('through the library: the refusal is fence_required, carrying the reclaim way; the new claim stays', async () => {
    const { runId, since } = await raced();
    const outcome = await reclaimStep(runStore, runId, 'a', { force: true, definition: DEF }).then(
      (r) => r.outcome,
      (err: unknown) =>
        err instanceof WorkflowError
          ? { code: err.refusal?.code, way: err.refusal?.remedy[0]?.verb }
          : String(err),
    );
    const left = (await runStore.get(runId)).record;
    // (a) red when the old branch answers `taken_over`; (b) prints the outcome and what is left.
    expect({
      outcome,
      left: left.in_progress_steps,
      leased: left.claims?.['a']?.lease !== undefined,
      stamp: left.claims?.['a']?.since === (await since()),
    }).toEqual({
      outcome: { code: 'fence_required', way: 'reclaim' },
      left: ['a'],
      leased: true,
      stamp: true,
    });
  });

  it('through the CLI: the old form prints the refusal with its command (realm run reclaim, in this process on the cell’s home)', async () => {
    const saved = process.env['HOME'];
    process.env['HOME'] = h.root;
    const { runId, since } = await raced();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
    try {
      await reclaimCommand.parseAsync([runId, '--step', 'a', '--force'], { from: 'user' });
    } catch (e) {
      if (!(e instanceof Error) || e.message !== 'process.exit') throw e;
    } finally {
      if (saved === undefined) delete process.env['HOME'];
      else process.env['HOME'] = saved;
    }
    const stamp = await since();
    // The mocked process.exit throws, and the action's own catch prints that message after the
    // refusal: only the first line is the command's.
    // (a) red when the old branch answers `taken_over` (its `•` line, no command); (b) prints stderr.
    expect(err.mock.calls.map((c) => String(c[0]))[0]).toBe(
      `Step 'a' is claimed since ${stamp}. ${LEASE_HELD} ${NOT_DECLARED} To reclaim this claim, run: ${command(runId, stamp)}`,
    );
  });
});

describe('#729 CW-3a — check 5: resume and purge refuse a lease that cannot be checked, --force included', () => {
  /** A failed run whose other step `b` is claimed under the lease `L` in `state` (the lease double). */
  async function leasedFailed(
    state:
      'removed' | { forced: { state: 'unknown'; basis: 'kernel_lock'; reason: 'cannot_open' } },
  ) {
    const double = createLeaseDouble();
    double.set('L', state);
    const store = new InMemoryStore({ leases: double });
    const { record } = await store.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
    await store.update({
      ...record,
      run_phase: 'failed',
      failed_steps: ['a'],
      terminal_state: true,
      sealed_by: { arm: 'step_failure' },
      in_progress_steps: ['b'],
      claims: {
        b: {
          deadline: null,
          token: 'other',
          since: '2030-01-01T00:00:00.000Z',
          lease: { id: 'L' },
        },
      },
    });
    return { store, runId: record.id };
  }

  it('resume and purge, absent and unknown: their refusals, with no --force offered', async () => {
    const out: Record<string, unknown> = {};
    for (const [name, state] of [
      ['absent', 'removed'],
      ['unknown', { forced: { state: 'unknown', basis: 'kernel_lock', reason: 'cannot_open' } }],
    ] as const) {
      const { store, runId } = await leasedFailed(state);
      out[`resume/${name}`] = await resumeRun(runId, 'a', store, h.home.workflowStore, {
        force: true,
      }).then(
        () => 'resumed',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      const purge = isPurgeEligible(await store.get(runId), { explicit: true });
      out[`purge/${name}`] = purge.eligible ? 'purged' : purge.reason;
    }
    // #729 CW-4b: who took the step and when, then what the lease check found (CW-4a's phrase).
    const taken = 'taken by a program whose name was not recorded at 2030-01-01T00:00:00.000Z';
    const absent =
      'this home has no lease file the claim names, so whether its program still holds it is not known';
    const unknown =
      "whether its program still holds the claim's lease could not be checked: its lease file could not be opened";
    const resume = (p: string): string =>
      `Step 'b' was ${taken}; ${p}. Resume does not release it, with or without --force.`;
    const purge = (p: string): string =>
      `run carries a claim on step 'b', ${taken}; ${p}. Purge does not remove it, with or without --force`;
    // (a) red when either releases or removes the claim (the old rule: --force overrides an unknown
    //     age), or offers --force; (b) prints each answer.
    expect(out).toEqual({
      'resume/absent': resume(absent),
      'purge/absent': purge(absent),
      'resume/unknown': resume(unknown),
      'purge/unknown': purge(unknown),
    });
  });
});
