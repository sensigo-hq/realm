// holder-lines-cw4b.test.ts — #729 CW-4b (prompt feat-729-cw4b-holder-lines.md): the lines that name who
// holds a step say what its claim's lease check found, for a claim that names a lease, once per read;
// a claim that names none keeps today's words byte for byte.
//
// The claims are taken through `claimStepForDrive` (beta), as a drive takes them, on a real SQLite home:
// the hold kept open for a held lease, closed for one no program holds (the claim still names its file),
// the file deleted for an absent one; one unknown reason (`cannot_open`) on `InMemoryStore` with the lease
// double. Each line is rendered from the store's own read, as its command renders it; `realm run
// advance`, `realm run inspect` and `realm run reclaim --all` run as the built `realm`, in another
// process, on the cell's home.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  claimStepForDrive,
  classifyInProgressClaims,
  composeWaysAt,
  createDefaultRegistry,
  describeClaimHolder,
  leaseFactOf,
  loadWorkflowFromFile,
  reclaimStep,
  takeBackStep,
  type ClaimRecord,
  type LeaseHold,
  type RunStore,
  type Snapshot,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, createLeaseDouble } from '@sensigo/realm-testing';
import { makeTempHome, runIds, type TempHome } from '../test-support/temp-home.js';
import type { CliHome } from '../lib/home.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';
import {
  answerNotRecordedLine,
  inFlightLine,
  outcomeNotRecordedLine,
  takenLine,
  waitingLine,
} from '../lib/holder-render.js';
import { heldEntriesOf } from './ways-renderer.js';
import { inFlightItems } from './run-advance.js';
import { answerNotRunLine, runCommand, setInFlightWatchForTests, stepClosedLine } from './run.js';
import { reclaimDryRunLines } from './reclaim.js';
import { resumeRun } from './resume.js';
import { isPurgeEligible } from './purge.js';
import { writerTestSeams } from '../output/writer.js';

// `realm workflow run`'s prompts, answered by each cell (check 2 (g)).
const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '../../dist/index.js');
const shown = (t: string): string => writerTestSeams.visible(t);

/** `a` an agent step not declared idempotent; `i` one declared idempotent; `x` a bare `auto` step. */
const DEF: WorkflowDefinition = {
  id: 'holder-lines-cw4b',
  name: 'holder-lines-cw4b',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    a: { description: 'a', execution: 'agent', depends_on: [] },
    i: { description: 'i', execution: 'agent', depends_on: [], idempotent: true },
    x: { description: 'x', execution: 'auto', depends_on: [] },
  },
} as WorkflowDefinition;
const DRIVE = { by: 'other-drive', by_source: 'stated' as const, channel: 'agent' as const };
const A = 'taken by other-drive (as stated, via agent)';

/** What the lease check found, per state, as the lines say it (core's `leaseClause`). */
const L = {
  held: "its program held the claim's lease when it was checked",
  not_held: "no program held the claim's lease when it was checked",
  absent:
    'this home has no lease file the claim names, so whether its program still holds it is not known',
  unknown:
    "whether its program still holds the claim's lease could not be checked: its lease file could not be opened",
} as const;
type State = keyof typeof L;
const STATES = Object.keys(L) as State[];

let h: TempHome & { readonly root: string };
let elsewhere: string;
const holds: LeaseHold[] = [];

beforeEach(async () => {
  h = await makeTempHome();
  await h.home.workflowStore.register(DEF);
  elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'realm-cw4b-elsewhere-')));
});
afterEach(async () => {
  for (const hold of holds.splice(0)) hold.close();
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

/**
 * A run of DEF whose `step` another drive took under a lease in `state`, its claim's `since`, and the
 * store's read of it. `patch` changes the record after the claim (a run that has ended, for one).
 */
async function leased(
  state: State,
  step = 'a',
  patch?: (record: Snapshot['record']) => Snapshot['record'],
): Promise<{ store: RunStore; runId: string; since: string; read: Snapshot }> {
  const double = state === 'unknown' ? createLeaseDouble() : undefined;
  const store: RunStore =
    double !== undefined ? new InMemoryStore({ leases: double }) : h.home.runStore;
  const { record } = await store.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
  const answer = await claimStepForDrive(store, record.id, step, {
    definition: DEF,
    registry: createDefaultRegistry(),
    driver: DRIVE,
  });
  if (answer.kind !== 'claimed') throw new Error(`fixture: not claimed: ${JSON.stringify(answer)}`);
  holds.push(answer.hold);
  if (state === 'not_held') answer.hold.close((await store.get(record.id)).record);
  if (state === 'absent') {
    // A hold this process keeps open reads held whatever its file (the port's own registry), so the
    // hold is closed first (the claim names it, so its file is kept), then the file is deleted.
    answer.hold.close((await store.get(record.id)).record);
    rmSync(join(h.path, 'claim-leases', `${answer.hold.id}.lease`));
  }
  if (double !== undefined) {
    double.set(answer.hold.id, {
      forced: { state: 'unknown', basis: 'kernel_lock', reason: 'cannot_open' },
    });
  }
  if (patch !== undefined) {
    const { record: now } = await store.get(record.id);
    await store.update(patch(now));
  }
  const read = await store.get(record.id);
  return { store, runId: record.id, since: read.record.claims![step]!.since!, read };
}

/** `step`'s claim described as the lines describe it, from `read` (its lease fact included). */
const described = (read: Snapshot, step = 'a') =>
  describeClaimHolder(
    read.record.claims?.[step],
    true,
    leaseFactOf(read, read.record.claims?.[step]),
  );

/** A run that has ended (another step failed) while the leased claim stays. */
const ended = (record: Snapshot['record']): Snapshot['record'] => ({
  ...record,
  run_phase: 'failed',
  failed_steps: ['x'],
  terminal_state: true,
  sealed_by: { arm: 'step_failure' },
});

describe('#729 CW-4b — check 1: each line, per lease state', { timeout: 180_000 }, () => {
  it.each(STATES)('%s: the drives’ lines and the closed prompt', async (state) => {
    const { runId, since, read } = await leased(state);
    const d = described(read);
    const ways = composeWaysAt(read.record, read.at, {
      definition: DEF,
      persistsClaims: true,
      lease_facts: read.lease_facts,
    });
    const held = heldEntriesOf(ways).find((e) => e.facts.step === 'a')!;
    // (a) red when a line keeps today's words for a leased claim ("is in flight", "has been in
    //     flight", no lease), or says the lease where a later line on the read says it; (b) prints
    //     the lines.
    expect({
      inFlight: inFlightItems(read, true),
      inFlightWithLease: inFlightItems(read, true, undefined, true),
      waiting: waitingLine('a', d, 60_000),
      watchEnd: inFlightLine(held, d, 60_000).split('; the record has not changed for 60s. ')[0],
      taken: takenLine('a', d),
      // `realm workflow run`'s taken line: its waiting line from the same read says the lease.
      takenHere: takenLine('a', d, undefined, false),
      answerNotRecorded: answerNotRecordedLine(read.record, 'a', true, undefined, undefined, read),
      answerHeldElsewhere: answerNotRecordedLine(
        read.record,
        'a',
        true,
        'held_elsewhere',
        undefined,
        read,
      ),
      outcomeNotRecorded: outcomeNotRecordedLine(
        'held_elsewhere',
        read.record,
        'a',
        true,
        undefined,
        read,
      ),
      // `realm workflow run`'s not-recorded line: its waiting line from the same read says the lease.
      outcomeHere: outcomeNotRecordedLine(
        'held_elsewhere',
        read.record,
        'a',
        true,
        undefined,
        read,
        false,
      ),
      closed: stepClosedLine(read.record, 'a', true, undefined, undefined, read),
      notRun: answerNotRunLine(read.record, 'a', true, undefined, read),
    }).toEqual({
      inFlight: [`'a' was ${A} at ${since}`],
      inFlightWithLease: [`'a' was ${A} at ${since} (${L[state]})`],
      waiting: `• Step 'a' was ${A} at ${since}; ${L[state]}. Waiting up to 60s for the run's record to change.`,
      watchEnd: `• Step 'a' was ${A} at ${since}`,
      taken: `• Step 'a' was ${A} at ${since}; ${L[state]}; not run here.`,
      takenHere: `• Step 'a' was ${A} at ${since}; not run here.`,
      answerNotRecorded: `• Step 'a' was ${A} at ${since}; ${L[state]}; this drive's answer was not recorded.`,
      answerHeldElsewhere: `• Step 'a' was ${A} at ${since}; ${L[state]}; this drive's answer was not recorded.`,
      outcomeNotRecorded: `• Step 'a' was ${A} at ${since}; ${L[state]}; this program's outcome for it was not recorded.`,
      outcomeHere: `• Step 'a' was ${A} at ${since}; this program's outcome for it was not recorded.`,
      // `realm workflow run`'s closed prompt and not-run line name the holder only (check 2 (g)).
      closed: `This prompt is closed: step 'a' was ${A}; not run here.`,
      notRun: `Not run here: step 'a' was ${A}; the answer typed here was not recorded.`,
    });
    void runId;
  });

  it.each(STATES)('%s: the dry run’s header', async (state) => {
    const { since, read } = await leased(state);
    const ways = composeWaysAt(read.record, read.at, {
      definition: DEF,
      persistsClaims: true,
      lease_facts: read.lease_facts,
    });
    const header = reclaimDryRunLines(read.record, classifyInProgressClaims(read), ways)[0];
    // (a) red when a leased claim is listed by its deadline, or by another time than its claim's;
    //     (b) prints the header.
    const taken = /^ {2}• a: [a-z_]+ {2}\(taken at (.+)\)$/.exec(header ?? '');
    expect({ header, at: taken?.[1] }).toEqual({ header, at: since });
  });

  it.each(['held', 'absent', 'unknown'] as const)(
    '%s: resume’s and purge’s refusals',
    async (state) => {
      const { store, runId, since, read } = await leased(state, 'a', ended);
      const resume = await resumeRun(runId, 'x', store, h.home.workflowStore, { force: true }).then(
        () => 'resumed',
        (err: unknown) => shown(err instanceof Error ? err.message : String(err)),
      );
      const purge = isPurgeEligible(read, { explicit: true });
      // Held: the refusal follows the clause with ", so …"; absent and unknown, whose phrase may carry
      // its own "so …", in a sentence of its own (correction 1).
      const resumes =
        state === 'held'
          ? ', so resume does not release it, with or without --force.'
          : '. Resume does not release it, with or without --force.';
      const tail = state === 'held' ? '' : '. Purge does not remove it, with or without --force';
      // (a) red when a leased claim's refusal says "a live runner" or names no holder and time; or
      //     when resume releases it or purge removes it; (b) prints both.
      expect({ resume, purge: purge.eligible ? 'purged' : shown(purge.reason) }).toEqual({
        resume: `Step 'a' was ${A} at ${since}; ${L[state]}${resumes}`,
        purge: `run carries a claim on step 'a', ${A} at ${since}; ${L[state]}${tail}`,
      });
    },
  );

  it('held, past its deadline: realm run reclaim --all does not select it (correction 1: "with no lease")', async () => {
    // The drive's claim has no deadline; one in the past is written beside its lease, kept open here.
    const { runId } = await leased('held', 'i', (r) => ({
      ...r,
      claims: { ...r.claims, i: { ...r.claims!['i']!, deadline: '2020-01-01T00:00:00.000Z' } },
    }));
    const r = realm(['run', 'reclaim', '--all']);
    // (a) red when --all selects a claim past its deadline whose lease its program held (the footer
    //     and the flag row would then be wrong to say "with no lease"); (b) prints the lines.
    expect({ out: r.out, runId: r.out.some((l) => l.includes(runId)) }).toEqual({
      out: ['No auto-reclaimable claims found (idempotent ∧ concrete-past-deadline ∧ non-gated).'],
      runId: false,
    });
  });

  it('not held: realm run reclaim --all selects the claim and names when it was taken and what its lease showed', async () => {
    const { runId, since } = await leased('not_held', 'i');
    const r = realm(['run', 'reclaim', '--all']);
    // (a) red when the selected leased claim is listed by its deadline, or the header says only
    //     "past-deadline"; (b) prints the command's lines.
    expect(r.out.slice(0, 2)).toEqual([
      '1 claim(s) WOULD be auto-reclaimed (idempotent ∧ (past its deadline with no lease, or no program held its lease) ∧ non-gated):',
      `  • ${runId} / i  (taken at ${since}; ${L.not_held})`,
    ]);
  });
});

describe('#729 CW-4b — check 2: the lease is said once per read', { timeout: 180_000 }, () => {
  /** How many times the lines say what a held lease's check found (either case). */
  const heldCount = (lines: readonly string[]): number =>
    lines.join('\n').split(/program held the claim's lease when it was checked/i).length - 1;

  it('(a) advance, nothing owed and no question open: the held line below says it, not In flight:', async () => {
    // `x`, the bare auto step, already ran: nothing is owed to the engine.
    const { runId, since } = await leased('held', 'a', (r) => ({ ...r, completed_steps: ['x'] }));
    const r = realm(['run', 'advance', runId]);
    const all = [...r.out, ...r.err];
    // (a) red when In flight: says the lease too (twice on one read), or neither line says it;
    //     (b) prints the lines.
    expect({
      inFlight: all.find((l) => l.startsWith('In flight:')),
      count: heldCount(all),
    }).toEqual({ inFlight: `In flight: 'a' was ${A} at ${since}.`, count: 1 });
  });

  it('(b) advance with a question open on another step: In flight: says it, once', async () => {
    const gated: WorkflowDefinition = {
      ...DEF,
      id: 'holder-lines-cw4b-gated',
      steps: {
        a: { description: 'a', execution: 'agent', depends_on: [] },
        g: {
          description: 'g',
          execution: 'auto',
          depends_on: [],
          trust: 'human_confirmed',
          gate: { choices: ['approve', 'reject'] },
        },
      },
    } as WorkflowDefinition;
    await h.home.workflowStore.register(gated);
    const store = h.home.runStore;
    const { record } = await store.create({ workflowId: gated.id, workflowVersion: 1, params: {} });
    // The lease's claim is taken first; the question opens after it.
    const answer = await claimStepForDrive(store, record.id, 'a', {
      definition: gated,
      registry: createDefaultRegistry(),
      driver: DRIVE,
    });
    if (answer.kind !== 'claimed')
      throw new Error(`fixture: not claimed: ${JSON.stringify(answer)}`);
    holds.push(answer.hold);
    expect(realm(['run', 'advance', record.id]).code, 'fixture: the question opens').toBe(0);
    const since = (await store.get(record.id)).record.claims!['a']!.since!;
    const r = realm(['run', 'advance', record.id]);
    const all = [...r.out, ...r.err];
    // (a) red when In flight: says no lease while no held line follows (the question is the only
    //     reason), or it is said twice; (b) prints the lines.
    expect({
      inFlight: all.find((l) => l.startsWith('In flight:')),
      count: heldCount(all),
    }).toEqual({ inFlight: `In flight: 'a' was ${A} at ${since} (${L.held}).`, count: 1 });
  });

  it('(c) the watch’s in-flight line: once, in its tail', async () => {
    const { read } = await leased('held');
    const ways = composeWaysAt(read.record, read.at, {
      definition: DEF,
      persistsClaims: true,
      lease_facts: read.lease_facts,
    });
    const held = heldEntriesOf(ways).find((e) => e.facts.step === 'a')!;
    const line = inFlightLine(held, described(read), 60_000);
    // (a) red when the opening says the lease too, or the tail does not; (b) prints the line.
    expect(
      { count: heldCount([line]), tail: line.includes("'a' is held; wait for it.") },
      line,
    ).toEqual({
      count: 1,
      tail: true,
    });
  });

  it('(d) inspect with the lines under the step: once', async () => {
    const { runId } = await leased('held');
    const r = realm(['run', 'inspect', runId]);
    // (a) red when the holder line says the lease too; (b) prints the lines.
    expect(heldCount(r.out), r.out.join('\n')).toBe(1);
  });

  it('(e) advance with an engine step owed beside a held leased step: In flight: once, and the Stopped: held line once', async () => {
    const { runId, since } = await leased('held');
    const r = realm(['run', 'advance', runId]);
    const all = [...r.out, ...r.err];
    const inFlight = all.find((l) => l.startsWith('In flight:'))!;
    const after = all.slice(all.indexOf(inFlight) + 1);
    // (a) red when In flight: leaves the lease out with work owed (the first read never says it),
    //     or a line says it twice; (b) prints the lines.
    expect(
      { inFlight, count: heldCount([inFlight]), after: heldCount(after) },
      all.join('\n'),
    ).toEqual({
      inFlight: `In flight: 'a' was ${A} at ${since} (${L.held}).`,
      count: 1,
      after: 1,
    });
  });

  it('(f) inspect on a run that has ended while the leased claim stays: the holder line says it, once', async () => {
    const { runId } = await leased('held', 'a', ended);
    const r = realm(['run', 'inspect', runId]);
    const holder = r.out.find((l) => l.startsWith(`  a: ${A}`));
    // (a) red when the holder line leaves the lease out with no lines under it, or says it twice;
    //     (b) prints the lines.
    expect(
      { holder: holder?.endsWith(`; ${L.held}`), count: heldCount(r.out) },
      r.out.join('\n'),
    ).toEqual({
      holder: true,
      count: 1,
    });
  });
});

describe(
  '#729 CW-4b correction 1 — check 2 (g): realm workflow run says the lease once per read',
  { timeout: 180_000 },
  () => {
    type Race = (runId: string) => Promise<void>;
    /** The other program's act, which the project handler `h` performs while the command runs it. */
    const hook = globalThis as { __cw4bWorkflowRunRace?: Race | undefined };
    /** The project handler: runs the hook once, then returns. */
    const EXT = `export default {
  handlers: {
    h: {
      id: 'h',
      async execute(_inputs, ctx) {
        const race = globalThis.__cw4bWorkflowRunRace;
        globalThis.__cw4bWorkflowRunRace = undefined;
        if (race !== undefined) await race(ctx.run_id);
        return { data: { by: 'here' } };
      },
    },
  },
};
`;
    /** A workflow of one step `s` (`execution`, and `handler: h` when `handled`). */
    const yamlOf = (id: string, execution: 'agent' | 'auto', handled = false): string =>
      [
        `id: ${id}`,
        `name: ${id}`,
        'version: 1',
        ...(handled ? ['extensions: ./ext.mjs'] : []),
        'steps:',
        '  s:',
        '    description: S.',
        `    execution: ${execution}`,
        ...(handled ? ['    handler: h'] : []),
        '',
      ].join('\n');
    let wf: string;
    let savedHome: string | undefined;
    let savedTTY: boolean | undefined;
    let logSpy: ReturnType<typeof vi.spyOn>;
    let exitSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      clearProjectExtensionsCache();
      wf = realpathSync(mkdtempSync(join(tmpdir(), 'realm-cw4b-wf-')));
      savedHome = process.env['HOME'];
      process.env['HOME'] = h.root;
      // Without this the non-TTY guard refuses before the loop.
      savedTTY = process.stdin.isTTY;
      process.stdin.isTTY = true;
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
        throw new Error('process.exit');
      }) as never);
    });
    afterEach(() => {
      hook.__cw4bWorkflowRunRace = undefined;
      if (savedTTY === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
      else process.stdin.isTTY = savedTTY;
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
      rmSync(wf, { recursive: true, force: true });
      mocks.question.mockReset();
      vi.restoreAllMocks();
    });

    /** `realm workflow run <file>` in this process, its watch 1 s; the exit code (0 for a return). */
    async function workflowRun(yaml: string): Promise<number> {
      writeFileSync(join(wf, 'workflow.yaml'), yaml, 'utf8');
      writeFileSync(join(wf, 'ext.mjs'), EXT, 'utf8');
      const restore = setInFlightWatchForTests(1_000);
      try {
        await runCommand.parseAsync([join(wf, 'workflow.yaml')], { from: 'user' });
        return 0;
      } catch (err) {
        if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
        return Number(exitSpy.mock.calls[0]?.[0]);
      } finally {
        restore();
      }
    }
    /** Another drive takes `s` under a lease this process holds open (so its check finds it held). */
    async function takeUnderLease(runId: string): Promise<void> {
      const registry = createDefaultRegistry();
      registry.register('handler', 'h', { id: 'h', execute: async () => ({ data: {} }) });
      const answer = await claimStepForDrive(h.home.runStore, runId, 's', {
        definition: loadWorkflowFromFile(join(wf, 'workflow.yaml')),
        registry,
        driver: DRIVE,
      });
      if (answer.kind !== 'claimed')
        throw new Error(`fixture: not claimed: ${JSON.stringify(answer)}`);
      holds.push(answer.hold);
    }
    /** The engine's first claim of `s` is preceded by the other drive's (the race of #625 F7). */
    function raceTheClaim(): () => boolean {
      // The command opens its own handle through the door, so the spy is on the handle's prototype.
      const proto = Object.getPrototypeOf(h.home.runStore) as CliHome['runStore'];
      const real = proto.claimStep;
      let raced = false;
      vi.spyOn(proto, 'claimStep').mockImplementation(async function (
        this: CliHome['runStore'],
        ...a
      ) {
        if (!raced && a[1] === 's') {
          raced = true;
          await takeUnderLease(a[0]);
        }
        return real.apply(this, a);
      });
      return () => raced;
    }
    /** What stdout said, from the first line that starts `opening` through the waiting line. */
    async function read(opening: string): Promise<{ lines: string[]; since: string }> {
      const all = logSpy.mock.calls
        .flatMap((c: unknown[]) => String(c[0]).split('\n'))
        .filter((l: string) => l !== '');
      const from = all.findIndex((l: string) => l.startsWith(opening));
      const to = all.findIndex((l: string, i: number) => i > from && / waiting up to /i.test(l));
      const id = (await runIds(h.home.runStore))[0]!;
      const since = (await h.home.runStore.get(id)).record.claims?.['s']?.since ?? '<none>';
      return { lines: from === -1 || to === -1 ? all : all.slice(from, to + 1), since };
    }
    const waiting = (since: string): string =>
      `  • Step 's' was ${A} at ${since}; ${L.held}. Waiting up to 1s for the run's record to change.`;
    const heldCount = (lines: readonly string[]): number =>
      lines.join('\n').split(/program held the claim's lease when it was checked/i).length - 1;

    it('the closed prompt: another drive takes the step while its prompt waits', async () => {
      const yaml = yamlOf('cw4b-wf-closed', 'auto');
      mocks.question.mockImplementation((prompt: string, opts?: { signal?: AbortSignal }) => {
        if (!prompt.startsWith('  Mock output')) return Promise.resolve('');
        return new Promise<string>((_resolve, reject) => {
          opts?.signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          );
          void (async () => takeUnderLease((await runIds(h.home.runStore))[0]!))();
        });
      });
      const code = await workflowRun(yaml);
      const { lines, since } = await read('  This prompt is closed:');
      // (a) red when the closed prompt says the lease too (twice on one read), or the waiting line
      //     below does not; (b) prints the lines from the prompt's close to the waiting line.
      expect({ lines, count: heldCount(lines), code }).toEqual({
        lines: [`  This prompt is closed: step 's' was ${A}; not run here.`, waiting(since)],
        count: 1,
        code: 1,
      });
    });

    it('the taken line: another drive takes the agent step before its prompt holds it', async () => {
      const yaml = yamlOf('cw4b-wf-taken', 'agent');
      const raced = raceTheClaim();
      mocks.question.mockImplementation(async () => '');
      const code = await workflowRun(yaml);
      const { lines, since } = await read("• Step 's' was");
      // (a) red when the taken line says the lease too, or the waiting line below does not;
      //     (b) prints the lines.
      expect({ raced: raced(), lines, count: heldCount(lines), code }).toEqual({
        raced: true,
        lines: [`• Step 's' was ${A} at ${since}; not run here.`, waiting(since)],
        count: 1,
        code: 1,
      });
    });

    // #729 CW-5a correction 1 (realm-workflow.md): the command reaches a step a `realm agent` drive
    // already holds, its program still running (held) or killed (not held).
    const twoAgentSteps = (id: string): string =>
      [
        `id: ${id}`,
        `name: ${id}`,
        'version: 1',
        'steps:',
        '  a:',
        '    description: A.',
        '    execution: agent',
        '  b:',
        '    description: B.',
        '    execution: agent',
        '',
      ].join('\n');
    for (const state of ['held', 'not_held'] as const)
      it(`a step a realm agent drive holds when the command reaches it (${state}): the waiting line, then the run handed back`, async () => {
        const yaml = twoAgentSteps(`cw5a-wf-reach-${state}`);
        let taken = false;
        mocks.question.mockImplementation(async () => {
          if (!taken) {
            // While `a`'s prompt waits, a drive takes `b` under a lease (as realm agent claims).
            taken = true;
            const runId = (await runIds(h.home.runStore))[0]!;
            const answer = await claimStepForDrive(h.home.runStore, runId, 'b', {
              definition: loadWorkflowFromFile(join(wf, 'workflow.yaml')),
              registry: createDefaultRegistry(),
              driver: DRIVE,
            });
            if (answer.kind !== 'claimed')
              throw new Error(`fixture: not claimed: ${JSON.stringify(answer)}`);
            if (state === 'held') holds.push(answer.hold);
            else answer.hold.close((await h.home.runStore.get(runId)).record);
          }
          return '';
        });
        const code = await workflowRun(yaml);
        // stdout and stderr (the line at the watch's end), in that order.
        const all = [...logSpy.mock.calls, ...vi.mocked(console.error).mock.calls]
          .flatMap((c: unknown[]) => String(c[0]).split('\n'))
          .filter((l: string) => l !== '');
        const runId = (await runIds(h.home.runStore))[0]!;
        const since = (await h.home.runStore.get(runId)).record.claims?.['b']?.since;
        const end = all.find(
          (l: string) => l.startsWith("• Step 'b' was") && l.includes('the record has not changed'),
        );
        // (1) red when the command says it did not run the step (`…; not run here.`), the waiting
        //     line does not say the lease, or a killed drive's step is handed back with no command
        //     that frees it; (2) prints the lines.
        expect(
          {
            code,
            waiting: all.find((l: string) => l.startsWith("  • Step 'b' was")),
            notRunHere: all.filter((l: string) => l.includes('not run here')),
            frees: end?.includes(`To free it, run: realm run reclaim ${runId} --step b`) ?? false,
          },
          all.join('\n'),
        ).toEqual({
          code: 1,
          waiting: `  • Step 'b' was ${A} at ${since}; ${L[state]}. Waiting up to 1s for the run's record to change.`,
          notRunHere: [],
          frees: state === 'not_held',
        });
      });

    // #729 CW-5c check 2: `realm workflow run`'s two places. A killed drive's step `b` the command
    // reaches: below the cap its in-flight line ends with the `realm agent` sentence and its Go-on
    // opens with it; at the cap (`b` taken back once since, and that drive killed too) both keep
    // today's words.
    for (const cap of [false, true] as const)
      it(`a killed drive's step the command reaches, ${cap ? 'at the cap: today’s words' : 'below the cap: the in-flight line and the Go-on name realm agent'}`, async () => {
        const yaml = twoAgentSteps(`cw5c-wf-${cap ? 'cap' : 'below'}`);
        let taken = false;
        mocks.question.mockImplementation(async () => {
          if (!taken) {
            taken = true;
            const runId = (await runIds(h.home.runStore))[0]!;
            const definition = loadWorkflowFromFile(join(wf, 'workflow.yaml'));
            const killed = async (): Promise<void> => {
              const answer = await claimStepForDrive(h.home.runStore, runId, 'b', {
                definition,
                registry: createDefaultRegistry(),
                driver: DRIVE,
              });
              if (answer.kind !== 'claimed')
                throw new Error(`fixture: not claimed: ${JSON.stringify(answer)}`);
              answer.hold.close((await h.home.runStore.get(runId)).record);
            };
            await killed();
            if (cap) {
              const token = (await h.home.runStore.get(runId)).record.claims?.['b']?.token;
              const back = await takeBackStep(h.home.runStore, runId, 'b', {
                expectToken: token!,
                drivenBy: DRIVE,
              });
              if (back.kind !== 'taken_back') throw new Error(`fixture: ${back.kind}`);
              await killed();
            }
          }
          return '';
        });
        const code = await workflowRun(yaml);
        const all = [...logSpy.mock.calls, ...vi.mocked(console.error).mock.calls]
          .flatMap((c: unknown[]) => String(c[0]).split('\n'))
          .filter((l: string) => l !== '');
        const runId = (await runIds(h.home.runStore))[0]!;
        const takeBack = `Or let realm agent --run-id ${runId} --provider <provider> --model <model> take it back and run it (this step's one automatic take-back until a person reclaims it).`;
        const end = all.find(
          (l: string) => l.startsWith("• Step 'b' was") && l.includes('the record has not changed'),
        );
        // (1) red when `realm workflow run` passes no steps to its in-flight line or to its Go-on, or
        //     names `realm agent` at the cap; (2) prints the lines.
        expect(
          {
            code,
            inFlight: cap ? end?.endsWith('--force') : end?.endsWith(`--force ${takeBack}`),
            goOn: all.find((l: string) => l.startsWith('  Go on:')),
          },
          all.join('\n'),
        ).toEqual({
          code: 1,
          inFlight: true,
          goOn: `  Go on:     ${cap ? '' : `let realm agent --run-id ${runId} --provider <provider> --model <model> take 'b' back, or `}once 'b' is freed (realm run reclaim ${runId} prints its command), realm run advance ${runId}`,
        });
      });

    it('the not-run line: another drive takes the step before the engine claims it for the typed answer', async () => {
      const yaml = yamlOf('cw4b-wf-not-run', 'auto');
      const raced = raceTheClaim();
      mocks.question.mockImplementation(async () => '');
      const code = await workflowRun(yaml);
      const { lines, since } = await read('  Not run here:');
      // (a) red when the not-run line says the lease too, or the waiting line below does not;
      //     (b) prints the lines.
      expect({ raced: raced(), lines, count: heldCount(lines), code }).toEqual({
        raced: true,
        lines: [
          `  Not run here: step 's' was ${A}; the answer typed here was not recorded.`,
          waiting(since),
        ],
        count: 1,
        code: 1,
      });
    });

    it('the not-recorded line: another drive takes the step over while the engine runs it', async () => {
      const yaml = yamlOf('cw4b-wf-takeover', 'auto', true);
      let raced = false;
      hook.__cw4bWorkflowRunRace = async (id: string) => {
        raced = true;
        // As race-workflow-run-625's row 3: the claim is freed, then taken, here under a lease.
        await reclaimStep(h.home.runStore, id, 's');
        await takeUnderLease(id);
      };
      mocks.question.mockImplementation(async () => '');
      const code = await workflowRun(yaml);
      const { lines, since } = await read("  • Step 's' was");
      // (a) red when the not-recorded line says the lease too, or the waiting line below does not;
      //     (b) prints the lines.
      expect({ raced, lines, count: heldCount(lines), code }).toEqual({
        raced: true,
        lines: [
          `  • Step 's' was ${A} at ${since}; this program's outcome for it was not recorded.`,
          waiting(since),
        ],
        count: 1,
        code: 1,
      });
    });
  },
);

describe('#729 CW-4b — check 3: a claim that names no lease keeps today’s words', () => {
  const SINCE = '2026-01-01T00:00:00.000Z';
  const PAST = '2026-01-01T00:05:00.000Z';
  const CLAIMS: Record<string, ClaimRecord> = {
    'past its deadline': { deadline: PAST, token: 't', since: SINCE, holder: DRIVE },
    ahead: { deadline: '2099-01-01T00:00:00.000Z', token: 't', since: SINCE, holder: DRIVE },
    'no deadline': { deadline: null, token: 't', since: SINCE, holder: DRIVE },
  };
  it.each(Object.keys(CLAIMS))('%s', async (name) => {
    const store = new InMemoryStore();
    const { record } = await store.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
    await store.update({ ...record, in_progress_steps: ['a'], claims: { a: CLAIMS[name]! } });
    const read = await store.get(record.id);
    const d = described(read);
    // (a) red when a line for a claim that names no lease changes at all; (b) prints the lines.
    expect({
      inFlight: inFlightItems(read, true, undefined, true),
      waiting: waitingLine('a', d, 60_000),
      taken: takenLine('a', d),
      answerNotRecorded: answerNotRecordedLine(read.record, 'a', true, undefined, undefined, read),
      outcomeNotRecorded: outcomeNotRecordedLine(
        'held_elsewhere',
        read.record,
        'a',
        true,
        undefined,
        read,
      ),
      closed: stepClosedLine(read.record, 'a', true, undefined, undefined, read),
      notRun: answerNotRunLine(read.record, 'a', true, undefined, read),
    }).toEqual({
      inFlight: [`'a' is in flight, ${A} since ${SINCE}`],
      waiting: `• Step 'a' is in flight, ${A} since ${SINCE}: waiting up to 60s for the run's record to change.`,
      taken: `• Step 'a' was ${A} at ${SINCE}; not run here.`,
      answerNotRecorded: `• Step 'a' was ${A} at ${SINCE}; this drive's answer was not recorded.`,
      outcomeNotRecorded: `• Step 'a' was ${A} at ${SINCE}; this program's outcome for it was not recorded.`,
      closed: `This prompt is closed: step 'a' was ${A}; not run here.`,
      notRun: `Not run here: step 'a' was ${A}; the answer typed here was not recorded.`,
    });
  });
});

describe(
  '#729 CW-4b — check 4: the dry run’s footer and --all’s header',
  { timeout: 180_000 },
  () => {
    const footer = (lines: readonly string[]): string => lines[lines.length - 1]!.trim();
    it('the footer: today’s words with no leased claim listed, the lease form with one', async () => {
      const store = new InMemoryStore();
      const { record } = await store.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
      await store.update({
        ...record,
        in_progress_steps: ['a'],
        claims: { a: { deadline: null, token: 't', since: '2026-01-01T00:00:00.000Z' } },
      });
      const plain = await store.get(record.id);
      const plainWays = composeWaysAt(plain.record, plain.at, {
        definition: DEF,
        persistsClaims: true,
        lease_facts: plain.lease_facts,
      });
      const { read } = await leased('held');
      const leasedWays = composeWaysAt(read.record, read.at, {
        definition: DEF,
        persistsClaims: true,
        lease_facts: read.lease_facts,
      });
      // (a) red when the footer has one form for both; (b) prints both footers.
      expect({
        plain: footer(reclaimDryRunLines(plain.record, classifyInProgressClaims(plain), plainWays)),
        leased: footer(reclaimDryRunLines(read.record, classifyInProgressClaims(read), leasedWays)),
      }).toEqual({
        plain:
          "Reclaim re-drives a step (at-least-once — side effects may repeat). Run a step's command above to free it. realm run reclaim --all lists, across every run, the claims past their deadline whose steps are idempotent; with --force it frees them.",
        leased:
          "Reclaim re-drives a step (at-least-once — side effects may repeat). Run a step's command above to free it. realm run reclaim --all lists, across every run, the claims past their deadline with no lease, or whose lease no program held when it was checked, whose steps are idempotent; with --force it frees them.",
      });
    });

    it('--all’s header: today’s words when no selected claim names a lease', async () => {
      const store = h.home.runStore;
      const { record } = await store.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
      await store.update({
        ...record,
        in_progress_steps: ['i'],
        claims: {
          i: {
            deadline: '2020-01-01T00:00:00.000Z',
            token: 't',
            since: '2019-12-31T00:00:00.000Z',
          },
        },
      });
      const r = realm(['run', 'reclaim', '--all']);
      // (a) red when the header gives the lease form with no leased claim selected; (b) prints it.
      expect(r.out[0]).toBe(
        '1 claim(s) WOULD be auto-reclaimed (idempotent ∧ past-deadline ∧ non-gated):',
      );
    });
  },
);
