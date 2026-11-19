// lease-words-cw4a.test.ts — #729 CW-4a (prompt feat-729-cw4a-lease-words.md; check 2, the CLI): on a
// real SQLite home, an auto step another drive took under a kernel lease (`claimStepForDrive`, beta), its
// claim with a deadline, and its lease file then deleted (the lease reads absent). Each CLI door that
// says whether to wait for the step and how to free it says what the lease check found, never that the
// claim has no deadline: `realm run advance`'s held line, the dry run's and inspect's lines under the
// step, and `realm run reclaim --step … --force`'s refusal (no stamp) and success (the stamp). The built
// `realm` runs in another process.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  claimStepForDrive,
  createDefaultRegistry,
  type LeaseHold,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '../../dist/index.js');

/** `x` an auto step not declared idempotent: a claim of it has a deadline. */
const DEF: WorkflowDefinition = {
  id: 'lease-words-cw4a',
  name: 'lease-words-cw4a',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { x: { description: 'x', execution: 'auto', depends_on: [] } },
} as WorkflowDefinition;
const NOT_DECLARED = 'It is not declared idempotent, so running it again may repeat its effects.';
/** The absent result's condition form C. */
const ABSENT_C =
  "This home has no lease file the claim names, so whether its program still holds it is not known; if the claim's program still holds it, the step runs twice.";
const ABSENT_P =
  'this home has no lease file the claim names, so whether its program still holds it is not known';

let h: TempHome & { readonly root: string };
let runStore: RunStore;
let elsewhere: string;
const holds: LeaseHold[] = [];

beforeEach(async () => {
  h = await makeTempHome();
  runStore = h.home.runStore;
  await h.home.workflowStore.register(DEF);
  elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'realm-cw4a-elsewhere-')));
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

/** A run whose step `x` another drive took under a lease, the lease file then deleted. */
async function absentLease(): Promise<{ runId: string; since: string; deadline: string }> {
  const { record } = await runStore.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
  const answer = await claimStepForDrive(runStore, record.id, 'x', {
    definition: DEF,
    registry: createDefaultRegistry(),
    driver: { by: 'other-drive', by_source: 'stated', channel: 'agent' },
  });
  if (answer.kind !== 'claimed') throw new Error(`fixture: not claimed: ${JSON.stringify(answer)}`);
  holds.push(answer.hold);
  const file = join(h.path, 'claim-leases', `${answer.hold.id}.lease`);
  if (!existsSync(file)) throw new Error(`fixture: no lease file at ${file}`);
  rmSync(file);
  const claim = (await runStore.get(record.id)).record.claims!['x']!;
  if (typeof claim.deadline !== 'string')
    throw new Error('fixture: the auto step’s claim has no deadline');
  return { runId: record.id, since: claim.since!, deadline: claim.deadline };
}

/** The lines `out` prints for step `x`, from its heading on, as a CLI door lists a held step. */
const under = (out: string[], heading: RegExp): string[] => {
  const from = out.findIndex((l) => heading.test(l));
  return from < 0 ? [] : out.slice(from, from + 4);
};

// each cell starts the built CLI up to three times: 30 s a cold start, the budget on the block
describe(
  '#729 CW-4a — check 2: each CLI door, on an absent lease of a claim with a deadline',
  { timeout: 180_000 },
  () => {
    it('realm run advance: the held line says what the check found once, through its condition, and exits 0', async () => {
      const { runId, since } = await absentLease();
      const r = realm(['run', 'advance', runId]);
      const all = [...r.out, ...r.err].join('\n');
      const line = [...r.out, ...r.err].find((l) => l.includes("'x' is held"));
      // (a) red when the held line gives the unknown-age words ("no deadline"), says the check's phrase
      //     twice, or exits 1; (b) prints the command's lines.
      expect(
        {
          code: r.code,
          line,
          phrases: all.split(ABSENT_P).length - 1 + (all.split(ABSENT_C).length - 1),
          noDeadline: /no deadline/.test(all),
        },
        all,
      ).toEqual({
        code: 0,
        line: expect.stringContaining(
          `'x' is held since ${since}; wait for it, or free it if its program has stopped. ${ABSENT_C} ${NOT_DECLARED} To free it, run: realm run reclaim ${runId} --step x --claimed-at ${since} --force`,
        ),
        phrases: 1,
        noDeadline: false,
      });
    });

    it('the dry run and inspect: the lines under the step carry the condition', async () => {
      const { runId, since } = await absentLease();
      const dry = realm(['run', 'reclaim', runId]);
      const inspect = realm(['run', 'inspect', runId]);
      const freeLine = `To free it, run: realm run reclaim ${runId} --step x --claimed-at ${since} --force`;
      // (a) red when either screen's lines under the step give the unknown-age words; (b) prints both.
      expect(
        {
          dry: under(dry.out, /^ {2}• x: /)
            .slice(1)
            .map((l) => l.trim()),
          inspect: under(inspect.out, /^ {2}x: /)
            .slice(1)
            .map((l) => l.trim()),
          noDeadline: [...dry.out, ...inspect.out].some(
            (l) => /no deadline/.test(l) && !l.includes('(deadline:'),
          ),
        },
        [...dry.out, '---', ...inspect.out].join('\n'),
      ).toEqual({
        dry: [ABSENT_C, NOT_DECLARED, freeLine],
        inspect: [ABSENT_C, NOT_DECLARED, freeLine],
        noDeadline: false,
      });
    });

    it('realm run reclaim --step x --force: the refusal without the stamp, and the success with it, carry the condition', async () => {
      const { runId, since } = await absentLease();
      const refused = realm(['run', 'reclaim', runId, '--step', 'x', '--force']);
      const freed = realm([
        'run',
        'reclaim',
        runId,
        '--step',
        'x',
        '--claimed-at',
        since,
        '--force',
      ]);
      // (a) red when the refusal's or the success's condition gives the unknown-age words; (b) prints
      //     both commands' lines.
      expect({ refused, freed }).toEqual({
        refused: {
          code: 1,
          out: [],
          err: [
            `Step 'x' is claimed since ${since}. ${ABSENT_C} ${NOT_DECLARED} To reclaim this claim, run: realm run reclaim ${runId} --step x --claimed-at ${since} --force`,
          ],
        },
        freed: {
          code: 0,
          out: [ABSENT_C, NOT_DECLARED, `Reclaimed step 'x' of run ${runId}: it can run again.`],
          err: [],
        },
      });
    });
  },
);
