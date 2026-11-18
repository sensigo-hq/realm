// reclaim-922-p1b.test.ts — #922 P1b (prompt fix-922-p1-reclaim-way.md items 8, 9, 12; checks 9, 10, 11,
// 12): `realm run reclaim <run> --step <s> [--claimed-at <stamp>] --force`, from the built `realm`, on
// runs held as a store writes them. Before admission it prints nothing; a refusal prints its fact and
// the command to run (a stamped claim inside its window or of unknown age needs `--claimed-at`); once
// admitted it prints each condition it discharged, then "Reclaimed …". The old form keeps working on
// a claim past its deadline and on a claim that records no stamp. The definition is read where it can
// be; where it cannot, the reclaim is judged without it and never exits on it.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: exit
// codes and lines, the run id and instants as placeholders.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type RunRecord,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '../../dist/index.js');

const plus = (ms: number): string => new Date(Date.now() + ms).toISOString();
const SINCE = new Date(Date.now() - 3_600_000).toISOString();
const AHEAD = plus(90_000);

/** `a` declared idempotent, `b` not, `-x` a step whose name starts with `-`; all agent steps. */
const DEF: WorkflowDefinition = {
  id: 'reclaim-922-p1b',
  name: 'reclaim-922-p1b',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    a: { description: 'a', execution: 'agent', depends_on: [], idempotent: true },
    b: { description: 'b', execution: 'agent', depends_on: [] },
    '-x': { description: 'x', execution: 'agent', depends_on: [] },
  },
} as WorkflowDefinition;

const IDEMPOTENT_NOT = 'It is not declared idempotent, so running it again may repeat its effects.';
const AHEAD_WORDS = `Its deadline is ahead (${AHEAD}); if its program is still running, the step runs twice.`;

let h: TempHome & { readonly root: string };
let runStore: RunStore;
let elsewhere: string;

beforeEach(async () => {
  h = await makeTempHome();
  runStore = h.home.runStore;
  await h.home.workflowStore.register(DEF);
  elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'realm-922-p1b-elsewhere-')));
});
afterEach(async () => {
  await h.cleanup();
  rmSync(elsewhere, { recursive: true, force: true });
});

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

/** A run of `workflowId` with `held` in progress, each with its claim (`undefined`: none recorded). */
async function held(
  claims: Record<string, unknown>,
  workflowId = DEF.id,
): Promise<{ id: string; inProgress: () => Promise<string[]> }> {
  const { record } = await runStore.create({ workflowId, workflowVersion: 1, params: {} });
  const written: Record<string, unknown> = {};
  for (const [step, claim] of Object.entries(claims))
    if (claim !== undefined) written[step] = claim;
  await runStore.update({
    ...record,
    in_progress_steps: Object.keys(claims),
    claims: written as NonNullable<RunRecord['claims']>,
  });
  return {
    id: record.id,
    inProgress: async () => (await runStore.get(record.id)).record.in_progress_steps,
  };
}

/** The command a refusal printed, as arguments (its first word is `realm`). */
const printedArgs = (err: string[]): string[] =>
  (/To reclaim this claim, run: (.+)$/.exec(err.join(' '))?.[1] ?? '').split(' ').slice(1);

// each cell starts the built CLI up to three times: 30 s a cold start, the budget on the block
describe('#922 P1b — check 9: the old form, and the fence', { timeout: 120_000 }, () => {
  it('a claim past its deadline: the old form frees it, says its condition, then that it is done', async () => {
    const run = await held({ b: { deadline: plus(-90_000), token: 't', since: SINCE } });
    const r = realm(['run', 'reclaim', run.id, '--step', 'b', '--force']);
    // (a) red when the old form stops working on a dead claim, or prints before admission;
    //     (b) prints the exit, the lines and what is left in progress.
    expect({ ...r, left: await run.inProgress() }).toEqual({
      code: 0,
      out: [IDEMPOTENT_NOT, `Reclaimed step 'b' of run ${run.id}: it can run again.`],
      err: [],
      left: [],
    });
  });

  it('a stamped claim inside its window: refused with the conditions and the command, nothing freed; the command, run as printed, frees it (check 10: the words first)', async () => {
    const run = await held({ b: { deadline: AHEAD, token: 't', since: SINCE } });
    const refused = realm(['run', 'reclaim', run.id, '--step', 'b', '--force']);
    const leftAfterRefusal = await run.inProgress();
    const admitted = realm(printedArgs(refused.err));
    // (a) red when the fence is skipped (the old form frees a live claim), the words come after the
    //     command, or the printed command does not free it; (b) prints both runs' exits and lines.
    expect({ refused, leftAfterRefusal, admitted, left: await run.inProgress() }).toEqual({
      refused: {
        code: 1,
        out: [],
        err: [
          `Step 'b' is claimed since ${SINCE}. ${AHEAD_WORDS} ${IDEMPOTENT_NOT} To reclaim this claim, run: realm run reclaim ${run.id} --step b --claimed-at ${SINCE} --force`,
        ],
      },
      leftAfterRefusal: ['b'],
      admitted: {
        code: 0,
        out: [
          AHEAD_WORDS,
          IDEMPOTENT_NOT,
          `Reclaimed step 'b' of run ${run.id}: it can run again.`,
        ],
        err: [],
      },
      left: [],
    });
  });

  it('a claim that records no stamp (no claim record; a claim without `since`): the old form frees it, its conditions printed', async () => {
    const none = await held({ a: undefined });
    const unstamped = await held({ a: { deadline: AHEAD, token: 't' } });
    const noRecord = realm(['run', 'reclaim', none.id, '--step', 'a', '--force']);
    const noSince = realm(['run', 'reclaim', unstamped.id, '--step', 'a', '--force']);
    // (a) red when the fence is applied to a claim whose offered way carries no stamp (A32 item 1);
    //     (b) prints both runs.
    expect({ noRecord, noSince }).toEqual({
      noRecord: {
        code: 0,
        out: [
          'It is held with no claim record, so whether its program still runs is not known; if it does, the step runs twice.',
          `Reclaimed step 'a' of run ${none.id}: it can run again.`,
        ],
        err: [],
      },
      noSince: {
        code: 0,
        out: [AHEAD_WORDS, `Reclaimed step 'a' of run ${unstamped.id}: it can run again.`],
        err: [],
      },
    });
  });

  it('a stamp that is not the claim’s: refused, nothing removed, exit 1, and where to read the run', async () => {
    const run = await held({ b: { deadline: AHEAD, token: 't', since: SINCE } });
    const wrong = '1999-01-01T00:00:00.000Z';
    const r = realm(['run', 'reclaim', run.id, '--step', 'b', '--claimed-at', wrong, '--force']);
    // (a) red when a stale stamp frees a newer claim, or the exit is 0; (b) prints the run.
    expect({ ...r, left: await run.inProgress() }).toEqual({
      code: 1,
      out: [],
      err: [
        `Step 'b' is claimed since ${SINCE}, not since ${wrong} as the command says; nothing was removed. See: realm run inspect ${run.id}`,
      ],
      left: ['b'],
    });
  });
});

// each cell starts the built CLI up to three times: 30 s a cold start, the budget on the block
describe('#922 P1b — the refusals and the words, exit codes included', { timeout: 120_000 }, () => {
  it('not_a_step exits 1; not_held exits 0 and says so; a step a newer definition renamed is freed and says so', async () => {
    const notAStep = await held({ a: { deadline: AHEAD, token: 't', since: SINCE } });
    const notHeld = await held({});
    const renamed = await held({ gone: { deadline: plus(-90_000), token: 't', since: SINCE } });
    const typo = realm(['run', 'reclaim', notAStep.id, '--step', 'zz', '--force']);
    const idle = realm(['run', 'reclaim', notHeld.id, '--step', 'a', '--force']);
    const old = realm(['run', 'reclaim', renamed.id, '--step', 'gone', '--force']);
    // (a) red when a name the workflow lacks exits 0, a step not held is refused or reworded or
    //     given no way on, a command repeats, or the renamed step's words are lost; (b) prints the
    //     three runs.
    // correction 1: the run's ways on follow both refusals' words, one line per command (its agent
    // steps b and -x, or a, b and -x, render the same `realm agent` command)
    const onAgent = (id: string): string =>
      `To go on: realm agent --run-id ${id} --provider <provider> --model <model>`;
    expect({ typo, idle, old }).toEqual({
      typo: {
        code: 1,
        out: [],
        err: [
          `Step 'zz' is not a step of workflow 'reclaim-922-p1b'; nothing was reclaimed. ${onAgent(notAStep.id)}`,
        ],
      },
      idle: {
        code: 0,
        out: [`Step 'a' is not held; nothing to reclaim. ${onAgent(notHeld.id)}`],
        err: [],
      },
      old: {
        code: 0,
        out: [
          IDEMPOTENT_NOT,
          `Reclaimed step 'gone' of run ${renamed.id}. The workflow definition read here has no step named 'gone'.`,
        ],
        err: [],
      },
    });
  });

  it('`--claimed-at` without `--step`, or with `--all`: refused, exit 1; `--claimed-at --force`: refused by the option guard', async () => {
    const run = await held({ b: { deadline: AHEAD, token: 't', since: SINCE } });
    const noStep = realm(['run', 'reclaim', run.id, '--claimed-at', SINCE, '--force']);
    const all = realm(['run', 'reclaim', '--all', '--claimed-at', SINCE]);
    const swallowed = realm(['run', 'reclaim', run.id, '--step', 'b', '--claimed-at', '--force']);
    // (a) red when the flag is taken without `--step`, combined with `--all`, or swallows `--force`;
    //     (b) prints the exits and the first error line.
    expect({
      noStep: [noStep.code, noStep.err[0]],
      all: [all.code, all.err[0]],
      swallowed: [
        swallowed.code,
        /argument is ambiguous: '--force' looks like a flag/.test(swallowed.err.join(' ')),
      ],
      left: await run.inProgress(),
    }).toEqual({
      noStep: [1, '--claimed-at requires --step <name>.'],
      all: [1, '--claimed-at is a per-step flag; it cannot be combined with --all.'],
      swallowed: [1, true],
      left: ['b'],
    });
  });
});

// each cell starts the built CLI up to three times: 30 s a cold start, the budget on the block
describe('#922 P1b — check 11: a step named `-x`', { timeout: 120_000 }, () => {
  it('the printed command names it `--step=-x`, and run as printed from another folder frees it', async () => {
    const run = await held({ '-x': { deadline: AHEAD, token: 't', since: SINCE } });
    const refused = realm(['run', 'reclaim', run.id, '--step=-x', '--force']);
    const args = printedArgs(refused.err);
    const admitted = realm(args);
    // (a) red when the step flag is `--step -x` (the option guard then refuses the printed command);
    //     (b) prints the printed arguments and the second run.
    expect({ args, code: admitted.code, left: await run.inProgress() }).toEqual({
      args: ['run', 'reclaim', run.id, '--step=-x', '--claimed-at', SINCE, '--force'],
      code: 0,
      left: [],
    });
  });
});

// each cell starts the built CLI up to three times: 30 s a cold start, the budget on the block
describe(
  '#922 P1b — check 12 (the CLI): a definition the CLI cannot read',
  { timeout: 120_000 },
  () => {
    it('a run of a workflow this home does not hold: judged without its definition, its rerun not known, never an exit on it', async () => {
      const run = await held(
        { a: { deadline: plus(-90_000), token: 't', since: SINCE } },
        'not-registered-922',
      );
      const r = realm(['run', 'reclaim', run.id, '--step', 'a', '--force']);
      // (a) red when reclaim exits on the definition's absence, or frees the step without saying its
      //     rerun is not known; (b) prints the run.
      expect({ ...r, left: await run.inProgress() }).toEqual({
        code: 0,
        out: [
          'Its workflow definition is not available here, so whether running it again is safe is not known.',
          `Reclaimed step 'a' of run ${run.id}: it can run again.`,
        ],
        err: [],
        left: [],
      });
    });
  },
);
